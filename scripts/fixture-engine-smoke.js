// Smoke du Fixture Engine — zéro API.
//
// Usage :
//   NO_API=1 node scripts/fixture-engine-smoke.js
//
// Le garde réseau est chargé en premier : toute sortie réseau et tout
// appel anthropic.messages.create lève une erreur.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import { request as httpsRequest } from "node:https";
import { isDeepStrictEqual } from "node:util";

import Anthropic from "@anthropic-ai/sdk";

import {
  createMessage,
  extractText
} from "../src/services/anthropic.js";

import {
  configureCallGuard,
  resetCallGuard
} from "../src/services/call-guard.js";

import {
  FIXTURE_IDS,
  detectFixtureId,
  buildFixtureResult,
  getAnthropicFixture,
  getFixtureCallLog
} from "../src/fixtures/anthropic.js";

import {
  SCENARIOS,
  CANONICAL_TITLE,
  CANONICAL_PROMPT
} from "../src/fixtures/anthropic-dataset.js";

import { runResearchAgent } from "../src/agents/research.js";
import { runScriptAgent } from "../src/agents/script.js";
import { runVisualDirector } from "../src/agents/visual-director.js";

import {
  validateVoiceoverClaimCoverage
} from "../src/utils/validate-script-claim-coverage.js";


import {
  validateVisualFactualGrounding
} from "../src/utils/validate-visual-factual-grounding.js";

import {
  repairVisualFactualGrounding
} from "../src/utils/repair-visual-factual-grounding.js";

if (process.env.NO_API !== "1") {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1."
  );
  process.exit(1);
}

// Aucune clé n'est nécessaire : elle est retirée du processus sans être lue.
delete process.env.ANTHROPIC_API_KEY;

const PROMPT_FILES = {
  "research": "src/agents/research.js",
  "script": "src/agents/script.js",
  "visual-director": "src/agents/visual-director.js",
  "validate-script-claim-coverage":
    "src/utils/validate-script-claim-coverage.js",
  "validate-visual-factual-grounding":
    "src/utils/validate-visual-factual-grounding.js",
  "repair-visual-factual-grounding":
    "src/utils/repair-visual-factual-grounding.js",
  "judge-title":
    "src/utils/title-validation.js",
  "judge-evidence":
    "src/utils/fact-evidence.js",
  "judge-contradictions":
    "src/utils/fact-contradictions.js"
};

const META_KEYS = [
  "duration_ms",
  "input_tokens",
  "model",
  "output_tokens",
  "stop_reason"
];

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`       ${error?.message ?? error}`);
  }
}

async function expectReject(fn, pattern) {
  let error = null;

  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "une erreur était attendue, aucune n'a été levée");

  assert(
    pattern.test(error.message),
    `erreur inattendue : ${error.message}`
  );

  return error;
}

async function withEnv(overrides, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function fixtures(scenario, fn) {
  return withEnv(
    {
      ANTHROPIC_FIXTURES: "1",
      NO_API: "1",
      ANTHROPIC_FIXTURE_SCENARIO: scenario
    },
    fn
  );
}

function readSystemPrompt(file, id) {
  const source = fs.readFileSync(
    new URL(`../${file}`, import.meta.url),
    "utf8"
  );

  const constant = "SYSTEM_PROMPT";
  const match = source.match(
    new RegExp("const " + constant + " = `([\\s\\S]*?)`\\.trim\\(\\);")
  );

  assert(match, `SYSTEM_PROMPT introuvable dans ${file}`);

  return match[1].trim();
}

function logSince(start) {
  const counts = {};

  for (const entry of getFixtureCallLog().slice(start)) {
    counts[entry.fixture_id] =
      (counts[entry.fixture_id] ?? 0) + 1;
  }

  return counts;
}

function assertFixtureUsage(usage, fixtureId, label) {
  assert(usage, `${label} : usage absent`);

  assert(
    isDeepStrictEqual(Object.keys(usage).sort(), META_KEYS),
    `${label} : clés meta inattendues ${Object.keys(usage)}`
  );

  assert(
    usage.model === `fixture:${fixtureId}`,
    `${label} : model=${usage.model}`
  );

  assert(
    Number.isInteger(usage.input_tokens) &&
    Number.isInteger(usage.output_tokens) &&
    usage.stop_reason === "end_turn" &&
    usage.duration_ms === 0,
    `${label} : meta synthétique inattendue`
  );
}

const USER = text => [{ role: "user", content: text }];

const SYSTEM_PROMPTS = Object.fromEntries(
  Object.entries(PROMPT_FILES).map(
    ([id, file]) => [id, readSystemPrompt(file, id)]
  )
);

console.log("========================================");
console.log(" FIXTURE ENGINE — SMOKE (ZERO API)");
console.log("========================================");

// ------------------------------------------------------------------
console.log("");
console.log("--- 1. Garde réseau ---");

let guardBaseline = 0;

await test("garde réseau : chaque sortie réseau est bloquée et comptée", async () => {
  const probes = [
    ["fetch", () => fetch("http://127.0.0.1:9/")],
    ["net.Socket.connect", () => net.connect({ host: "127.0.0.1", port: 9 })],
    ["http.get", () => http.get("http://127.0.0.1:9/")],
    ["https.request", () => httpsRequest("https://127.0.0.1:9/")],
    ["dns.lookup", () => dns.lookup("localhost", () => {})],
    ["dns.promises.lookup", () => dns.promises.lookup("localhost")],
    [
      "anthropic.messages.create",
      () =>
        new Anthropic({ apiKey: "x".repeat(60) })
          .messages.create({})
    ]
  ];

  const before = networkGuard.attempts().length;

  for (const [kind, probe] of probes) {
    await expectReject(
      async () => probe(),
      /fixture-network-guard/
    );

    assert(
      networkGuard.attempts().at(-1) === kind,
      `${kind} : tentative non comptée par le garde`
    );
  }

  assert(
    networkGuard.attempts().length === before + probes.length,
    "compteur du garde incohérent"
  );

  guardBaseline = networkGuard.attempts().length;
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 2. Détection des 8 SYSTEM_PROMPT ---");

await test("les 8 fixture_id attendus sont déclarés", () => {
  assert(
    isDeepStrictEqual(
      [...FIXTURE_IDS].sort(),
      Object.keys(PROMPT_FILES).sort()
    ),
    `fixture_id déclarés : ${FIXTURE_IDS}`
  );
});

for (const [id, prompt] of Object.entries(SYSTEM_PROMPTS)) {
  await test(`SYSTEM_PROMPT réel "${id}" → fixture_id "${id}"`, () => {
    const detected = detectFixtureId(prompt);

    assert(detected === id, `détecté : ${detected}`);
  });
}

await test("Coverage Judge : le prompt exige un plan complet et minimal", async () => {
  const prompt = SYSTEM_PROMPTS["validate-script-claim-coverage"].replace(/\s+/g, " ");
  for (const required of [
    "inspecte l'intégralité",
    "évalue chaque phrase indépendamment",
    "Ne t'arrête jamais après la première",
    "ensemble minimal et complet",
    "dernière vérification interne",
    "aucune phrase non couverte"
  ]) {
    assert(prompt.includes(required), `instruction manquante : ${required}`);
  }
});

await test("prompt inconnu → FAIL", async () => {
  await expectReject(
    () => detectFixtureId("Tu es un assistant générique."),
    /aucun fixture_id reconnu/
  );
});

await test("anciens fragments (visual/asset_query/shots) → FAIL", async () => {
  await expectReject(
    () => detectFixtureId(
      "visual asset_query shots script research_fact_refs voiceover repair claim coverage grounding unsupported"
    ),
    /aucun fixture_id reconnu/
  );
});

await test("prompt ambigu (deux signatures) → FAIL", async () => {
  await expectReject(
    () => detectFixtureId(
      `${SYSTEM_PROMPTS.script}\n\n${SYSTEM_PROMPTS["visual-director"]}`
    ),
    /SYSTEM_PROMPT ambigu/
  );
});

await test("signature qui n'ouvre pas le prompt → FAIL", async () => {
  await expectReject(
    () => detectFixtureId(
      `Préambule inattendu.\n\n${SYSTEM_PROMPTS.research}`
    ),
    /SYSTEM_PROMPT ambigu/
  );
});

await test("SYSTEM_PROMPT absent → FAIL", async () => {
  await expectReject(
    () => detectFixtureId(undefined),
    /SYSTEM_PROMPT absent ou invalide/
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 3. Ordre de priorité de createMessage ---");

for (const [id, prompt] of Object.entries(SYSTEM_PROMPTS)) {
  await test(`CAS B — fixtures désactivées + NO_API=1 bloque "${id}"`, async () => {
    await withEnv(
      { ANTHROPIC_FIXTURES: undefined, NO_API: "1" },
      () => expectReject(
        () => createMessage({
          system: prompt,
          messages: USER("test")
        }),
        /^NO_API=1 — appel Anthropic interdit/
      )
    );
  });
}

await test("moteur désactivé → null (aucune interception hors mode fixture)", async () => {
  await withEnv({ ANTHROPIC_FIXTURES: undefined }, () => {
    assert(
      getAnthropicFixture({
        system: SYSTEM_PROMPTS.research,
        messages: USER("test")
      }) === null,
      "le moteur désactivé doit retourner null"
    );
  });

  await withEnv({ ANTHROPIC_FIXTURES: "true" }, () => {
    assert(
      getAnthropicFixture({
        system: SYSTEM_PROMPTS.research,
        messages: USER("test")
      }) === null,
      "seule la valeur \"1\" active le moteur"
    );
  });
});

await test("CAS A — prompt inconnu rejeté sans fallback API", async () => {
  await fixtures(undefined, () => expectReject(
    () => createMessage({
      system: "Tu es un assistant générique.",
      messages: USER("test")
    }),
    /^ANTHROPIC_FIXTURES=1 — aucun fixture_id reconnu/
  ));
});

await test("CAS A sans NO_API — prompt inconnu rejeté, SDK jamais atteint", async () => {
  await withEnv(
    {
      ANTHROPIC_FIXTURES: "1",
      NO_API: undefined,
      ANTHROPIC_FIXTURE_SCENARIO: undefined
    },
    () => expectReject(
      () => createMessage({
        system: "Tu es un assistant générique.",
        messages: USER("test")
      }),
      /^ANTHROPIC_FIXTURES=1 — aucun fixture_id reconnu/
    )
  );
});

await test("CAS A sans NO_API — entrée non canonique rejetée, SDK jamais atteint", async () => {
  await withEnv(
    {
      ANTHROPIC_FIXTURES: "1",
      NO_API: undefined,
      ANTHROPIC_FIXTURE_SCENARIO: undefined
    },
    () => expectReject(
      () => createMessage({
        system: SYSTEM_PROMPTS["validate-script-claim-coverage"],
        messages: USER("entrée non canonique")
      }),
      /^ANTHROPIC_FIXTURES=1 — fixture "validate-script-claim-coverage"/
    )
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 4. Les 7 consommateurs réels — scénario happy ---");

let research = null;
let script = null;

await test("chaîne Research → Script → Visual Director (happy)", async () => {
  await fixtures(undefined, async () => {
    const start = getFixtureCallLog().length;

    const researchResult = await runResearchAgent({
      title: CANONICAL_TITLE,
      prompt: CANONICAL_PROMPT,
      testMode: true
    });

    assert(researchResult.validation.valid, "Research Gate");
    assertFixtureUsage(researchResult.usage, "research", "research");

    const scriptResult = await runScriptAgent({
      research: researchResult.data,
      title: CANONICAL_TITLE,
      testMode: true
    });

    assertFixtureUsage(scriptResult.usage, "script", "script");

    assert(
      scriptResult.claim_coverage_validation.valid &&
      scriptResult.claim_coverage_validation.segments.length === 2 &&
      scriptResult.claim_coverage_validation.segments.every(
        segment => segment.covered && !segment.repaired
      ),
      "Claim Coverage : aucun repair attendu en happy path"
    );

    for (const segment of scriptResult.claim_coverage_validation.segments) {
      assertFixtureUsage(
        segment.usage,
        "validate-script-claim-coverage",
        segment.label
      );
    }

    const visualResult = await runVisualDirector({
      script: scriptResult.data,
      testMode: true
    });

    assertFixtureUsage(
      visualResult.usage,
      "visual-director",
      "visual-director"
    );

    assert(
      visualResult.validation.valid &&
      visualResult.script_mapping_validation.valid &&
      visualResult.factual_grounding_validation.valid,
      "gates Visual Director"
    );

    const shots = visualResult.factual_grounding_validation.shots;

    assert(
      shots.length === 5 &&
      shots.every(shot => shot.grounded && !shot.repaired),
      "Visual Grounding : 5 shots grounded sans repair attendus"
    );

    for (const shot of shots) {
      assertFixtureUsage(
        shot.usage,
        "validate-visual-factual-grounding",
        shot.label
      );
    }

    const counts = logSince(start);

    assert(
      isDeepStrictEqual(counts, {
        "research": 1,
        "script": 1,
        "validate-script-claim-coverage": 1,
        "visual-director": 1,
        "validate-visual-factual-grounding": 5
      }),
      `journal d'appels inattendu : ${JSON.stringify(counts)}`
    );

    research = researchResult.data;
    script = scriptResult.data;
  });
});

await test("Research fixture : needs_verification, sources [], zéro URL", () => {
  assert(research, "dossier Research indisponible");

  assert(
    research.key_facts.length === 2 &&
    research.key_facts.every(
      fact =>
        fact.verification_status === "needs_verification" &&
        Array.isArray(fact.sources) &&
        fact.sources.length === 0
    ),
    "key_facts inattendus"
  );

  assert(
    !/https?:\/\//i.test(JSON.stringify(research)),
    "le dossier Research fixture contient une URL"
  );
});

await test("réponse déterministe et forme { response, meta } stable", async () => {
  await fixtures(undefined, async () => {
    const call = () => createMessage({
      system: SYSTEM_PROMPTS.research,
      messages: USER(
        "TEST TECHNIQUE UNIQUEMENT.\n\n" +
        `Sujet : ${CANONICAL_TITLE}\n\n` +
        `Consigne : ${CANONICAL_PROMPT}\n\n` +
        "Retourne une version MINIMALE du JSON demandé :\n- test"
      )
    });

    const first = await call();
    const second = await call();

    assert(
      isDeepStrictEqual(first, second),
      "deux appels identiques donnent des réponses différentes"
    );

    assert(
      isDeepStrictEqual(Object.keys(first).sort(), ["meta", "response"]),
      "forme { response, meta } inattendue"
    );

    assertFixtureUsage(first.meta, "research", "meta");

    assert(
      extractText(first.response).length > 0 &&
      isDeepStrictEqual(
        JSON.parse(extractText(first.response)),
        research
      ),
      "extractText(response) ne restitue pas le dossier fixture"
    );
  });
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 5. Scénarios de branches ---");

await test("script-coverage-repair : FAIL → repair → revalidation PASS", async () => {
  await fixtures("script-coverage-repair", async () => {
    const start = getFixtureCallLog().length;

    const result = await runScriptAgent({
      research,
      title: CANONICAL_TITLE,
      testMode: true
    });

    const [first, second] =
      result.claim_coverage_validation.segments;

    assert(
      first.repaired === true &&
      first.covered === true &&
      first.initial_undeclared_claims.length === 1 &&
      first.initial_undeclared_claims[0].text === "L'eau y est rare." &&
      first.undeclared_claims.length === 0,
      "segment 0 : détection + repair + revalidation attendus"
    );

    assert(
      first.repair_usage === null,
      "la réparation déterministe ne doit pas appeler le fournisseur"
    );

    assert(
      second.repaired === false && second.covered === true,
      "segment 1 : aucun repair attendu"
    );

    assert(
      isDeepStrictEqual(result.data, script),
      "le script réparé doit être identique au script happy"
    );

    assert(
      isDeepStrictEqual(logSince(start), {
        "script": 1,
        "validate-script-claim-coverage": 2
      }),
      `journal d'appels inattendu : ${JSON.stringify(logSince(start))}`
    );
  });
});

await test("script-coverage-unrepairable : HARD_FAILURE structuré sans recheck ni retry", async () => {
  await fixtures("script-coverage-unrepairable", async () => {
    const start = getFixtureCallLog().length;
    const result = await runScriptAgent({ research, title: CANONICAL_TITLE, testMode: true });

    assert(result.protocol_outcome?.status === "HARD_FAILURE", JSON.stringify(result.protocol_outcome));
    assert(result.protocol_outcome.repair_status === "HARD_FAILURE", JSON.stringify(result.protocol_outcome));
    assert(result.protocol_outcome.coverage_status === null, JSON.stringify(result.protocol_outcome));
    assert(result.protocol_outcome.reason?.includes("phrase introuvable ou ambiguë"), JSON.stringify(result.protocol_outcome));
    assert(!("data" in result), "un résultat HARD_FAILURE ne doit pas exposer de script publiable");

    assert(
      isDeepStrictEqual(logSince(start), {
        "script": 1,
        "validate-script-claim-coverage": 1
      }),
      `journal d'appels inattendu : ${JSON.stringify(logSince(start))}`
    );
  });
});

await test("script-coverage-empty : l'exécuteur reçoit IRREPARABLE_EMPTY sans recheck ni retry", async () => {
  await fixtures("script-coverage-empty", async () => {
    const start = getFixtureCallLog().length;
    const result = await runScriptAgent({ research, title: CANONICAL_TITLE, testMode: true });

    assert(result.protocol_outcome?.status === "IRREPARABLE_EMPTY", JSON.stringify(result.protocol_outcome));
    assert(result.protocol_outcome.segment_id === "s1-g1", JSON.stringify(result.protocol_outcome));
    assert(!("data" in result), "un résultat irréparable ne doit pas exposer de script publiable");
    assert(
      isDeepStrictEqual(logSince(start), {
        "script": 1,
        "validate-script-claim-coverage": 1
      }),
      `journal d'appels inattendu : ${JSON.stringify(logSince(start))}`
    );
  });
});

await test("visual-grounding-repair : FAIL → repair → re-grounding PASS (sémantique R4D)", async () => {
  await fixtures("visual-grounding-repair", async () => {
    const start = getFixtureCallLog().length;

    const result = await runVisualDirector({
      script,
      testMode: true
    });

    const shots = result.factual_grounding_validation.shots;
    const first = shots[0];

    assert(
      first.repaired === true &&
      first.grounded === true &&
      first.unsupported_visual_claims.length === 0,
      "shot 0 : détection + repair + re-grounding attendus"
    );

    assert(
      isDeepStrictEqual(
        first.initial_unsupported_visual_claims.map(
          item => `${item.field}:${item.text}`
        ),
        [
          "visual_description:tons rouges et ocres",
          "visual_description:caractéristiques de l'Outback",
          "asset_query:Outback red ochre desert"
        ]
      ),
      "rejets R4D attendus"
    );

    assertFixtureUsage(
      first.repair_usage,
      "repair-visual-factual-grounding",
      "repair_usage"
    );

    assert(
      shots.slice(1).every(shot => shot.grounded && !shot.repaired),
      "seul le shot 0 doit être réparé"
    );

    const repairedShot =
      result.data.sections[0].segments[0].shots[0];

    assert(
      repairedShot.visual_description ===
        "Vue aérienne d'une région aride australienne." &&
      repairedShot.asset_query === "Australian arid region aerial" &&
      repairedShot.order === 1 &&
      repairedShot.duration_seconds === 8 &&
      repairedShot.asset_type === "stock_video" &&
      isDeepStrictEqual(repairedShot.research_fact_refs, [0]),
      "shot réparé inattendu"
    );

    assert(
      isDeepStrictEqual(logSince(start), {
        "visual-director": 1,
        "validate-visual-factual-grounding": 6,
        "repair-visual-factual-grounding": 1
      }),
      `journal d'appels inattendu : ${JSON.stringify(logSince(start))}`
    );
  });
});

await test("visual-grounding-unrepairable : le gate bloque après repair", async () => {
  await fixtures("visual-grounding-unrepairable", async () => {
    await expectReject(
      () => runVisualDirector({
        script,
        testMode: true
      }),
      /Visual Factual Grounding Gate.*non couvertes après réparation — \[visual_description\] végétation clairsemée/
    );
  });
});

await test("malformed-json : réponse cassée rejetée par le consommateur, sans API", async () => {
  await fixtures("malformed-json", async () => {
    await expectReject(
      () => runResearchAgent({
        title: CANONICAL_TITLE,
        prompt: CANONICAL_PROMPT,
        testMode: true
      }),
      /^Research Agent : aucun objet JSON détecté/
    );
  });
});

await test("scénarios déclarés = scénarios testés", () => {
  assert(
    isDeepStrictEqual([...SCENARIOS].sort(), [
      "happy",
      "malformed-json",
      "script-coverage-empty",
      "script-coverage-repair",
      "script-coverage-unrepairable",
      "visual-grounding-repair",
      "visual-grounding-unrepairable"
    ]),
    `scénarios déclarés : ${SCENARIOS}`
  );
});

for (const scenario of ["inconnu", "", "HAPPY"]) {
  await test(`scénario inconnu ${JSON.stringify(scenario)} → FAIL`, async () => {
    await fixtures(scenario, () => expectReject(
      () => runResearchAgent({
        title: CANONICAL_TITLE,
        prompt: CANONICAL_PROMPT,
        testMode: true
      }),
      /^ANTHROPIC_FIXTURES=1 — ANTHROPIC_FIXTURE_SCENARIO=.* inconnu/
    ));
  });
}

// ------------------------------------------------------------------
console.log("");
console.log("--- 6. Table fermée ---");

const CLAIM_ARID =
  "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.";

const closedTableCases = [
  [
    "Research : titre non canonique",
    () => runResearchAgent({
      title: "Un autre sujet",
      prompt: CANONICAL_PROMPT,
      testMode: true
    }),
    /fixture "research" : sujet ou consigne hors du jeu de données canonique/
  ],
  [
    "Research : consigne non canonique",
    () => runResearchAgent({
      title: CANONICAL_TITLE,
      prompt: "Une autre consigne.",
      testMode: true
    }),
    /fixture "research" : sujet ou consigne hors du jeu de données canonique/
  ],
  [
    "Research : mode full (outil web_search) non simulé",
    () => runResearchAgent({
      title: CANONICAL_TITLE,
      prompt: CANONICAL_PROMPT,
      testMode: false
    }),
    /fixture "research" : aucun outil n'est simulé/
  ],
  [
    "Script : dossier Research non canonique",
    () => runScriptAgent({
      research: {
        ...research,
        topic: "Un autre sujet"
      },
      title: CANONICAL_TITLE,
      testMode: true
    }),
    /fixture "script" : titre ou dossier Research hors du jeu de données canonique/
  ],
  [
    "Script : mode full non simulé",
    () => runScriptAgent({
      research,
      title: CANONICAL_TITLE,
      testMode: false
    }),
    /fixture "script" : message utilisateur non conforme/
  ],
  [
    "Visual Director : script non canonique",
    () => runVisualDirector({
      script: {
        ...script,
        hook: "Un autre hook."
      },
      testMode: true
    }),
    /fixture "visual-director" : script source hors du jeu de données canonique/
  ],
  [
    "Claim Coverage : voiceover inconnu",
    () => validateVoiceoverClaimCoverage({
      voiceover: "Une phrase absente du jeu de données.",
      claims: [{ text: CLAIM_ARID }]
    }),
    /fixture "validate-script-claim-coverage" : voiceover\/claims hors du jeu de données canonique/
  ],
  [
    "Claim Coverage : claims inconnus pour un voiceover connu",
    () => validateVoiceoverClaimCoverage({
      voiceover: CLAIM_ARID,
      claims: [{ text: "Un autre claim." }]
    }),
    /fixture "validate-script-claim-coverage" : voiceover\/claims hors du jeu de données canonique/
  ],
  [
    "Visual Grounding : shot inconnu",
    () => validateVisualFactualGrounding({
      visualDescription: "Un plan absent du jeu de données.",
      assetQuery: "unknown shot",
      claims: [CLAIM_ARID]
    }),
    /fixture "validate-visual-factual-grounding" : shot\/claims hors du jeu de données canonique/
  ],
  [
    "Visual Grounding : shot connu, claims différents",
    () => validateVisualFactualGrounding({
      visualDescription:
        "Vue aérienne d'une région aride australienne.",
      assetQuery: "Australian arid region aerial",
      claims: []
    }),
    /fixture "validate-visual-factual-grounding" : shot\/claims hors du jeu de données canonique/
  ],
  [
    "Visual Grounding Repair : shot inconnu",
    () => repairVisualFactualGrounding({
      shot: {
        visual_description: "Un plan absent du jeu de données.",
        asset_query: "unknown shot"
      },
      claims: [CLAIM_ARID],
      unsupportedVisualClaims: []
    }),
    /fixture "repair-visual-factual-grounding" : shot\/claims hors du jeu de données canonique/
  ],
  [
    "Visual Grounding Repair : shot déjà grounded",
    () => repairVisualFactualGrounding({
      shot: {
        visual_description:
          "Vue aérienne d'une région aride australienne.",
        asset_query: "Australian arid region aerial"
      },
      claims: [CLAIM_ARID],
      unsupportedVisualClaims: []
    }),
    /fixture "repair-visual-factual-grounding" : demande de réparation hors du jeu de données canonique/
  ],
  [
    "messages vide",
    () => createMessage({
      system: SYSTEM_PROMPTS.research,
      messages: []
    }),
    /fixture "research" : messages doit contenir exactement un message utilisateur texte/
  ],
  [
    "plusieurs messages",
    () => createMessage({
      system: SYSTEM_PROMPTS.research,
      messages: [...USER("a"), ...USER("b")]
    }),
    /fixture "research" : messages doit contenir exactement un message utilisateur texte/
  ]
];

for (const [name, run, pattern] of closedTableCases) {
  await test(`entrée non canonique → FAIL — ${name}`, async () => {
    await fixtures(undefined, async () => {
      const error = await expectReject(run, pattern);

      assert(
        error.message.startsWith("ANTHROPIC_FIXTURES=1 — "),
        `l'erreur ne vient pas du moteur fixture : ${error.message}`
      );
    });
  });
}

// ------------------------------------------------------------------
console.log("");
console.log("--- 7. Fixture cassée : valide OU exception ---");

const brokenFixtures = [
  ["fixture undefined", undefined],
  ["fixture null", null],
  ["texte absent", { json: true }],
  ["texte vide", { text: "   ", json: true }],
  ["texte non string", { text: { a: 1 }, json: true }],
  ["drapeau json absent", { text: "{}" }],
  ["JSON invalide", { text: '{"a": ', json: true }],
  ["JSON non objet", { text: "[1, 2]", json: true }]
];

for (const [name, fixture] of brokenFixtures) {
  await test(`fixture cassée → FAIL — ${name}`, async () => {
    await expectReject(
      () => buildFixtureResult("research", fixture),
      /^ANTHROPIC_FIXTURES=1 — fixture "research" mal formée/
    );
  });
}

await test("fixture_id inconnu → FAIL", async () => {
  await expectReject(
    () => buildFixtureResult("inconnu", { text: "{}", json: true }),
    /^ANTHROPIC_FIXTURES=1 — fixture_id inconnu/
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 8. Non-régression production (SDK mocké en mémoire) ---");

await test("CAS C sans clé — le chemin historique exige toujours ANTHROPIC_API_KEY", async () => {
  await withEnv(
    {
      ANTHROPIC_FIXTURES: undefined,
      NO_API: undefined,
      ANTHROPIC_API_KEY: undefined
    },
    () => expectReject(
      () => createMessage({
        system: SYSTEM_PROMPTS.research,
        messages: USER("test")
      }),
      /^ANTHROPIC_API_KEY absente ou invalide/
    )
  );
});

await test("CAS C — le chemin historique atteint anthropic.messages.create", async () => {
  const requests = [];

  const mockedResponse = {
    model: "mock-model",
    content: [{ type: "text", text: " réponse mock " }],
    usage: { input_tokens: 3, output_tokens: 2 },
    stop_reason: "end_turn"
  };

  Anthropic.Messages.prototype.create = async function (request) {
    requests.push(request);
    return mockedResponse;
  };

  // R13 : un appel réel exige désormais une autorisation en mémoire.
  const guardDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fixture-engine-call-guard-")
  );

  try {
    await withEnv(
      {
        ANTHROPIC_FIXTURES: undefined,
        NO_API: undefined,
        PIPELINE_REAL_CALLS_ACK: "1",
        // Clé entièrement factice, en mémoire uniquement.
        ANTHROPIC_API_KEY: "x".repeat(60)
      },
      async () => {
        configureCallGuard({ productionDir: guardDir, cap: 1 });

        const messages = USER("test");
        const tools = [{ type: "mock_tool", name: "mock" }];

        const { response, meta } = await createMessage({
          system: SYSTEM_PROMPTS.research,
          messages,
          maxTokens: 10,
          temperature: 0,
          tools
        });

        assert(
          requests.length === 1 &&
          isDeepStrictEqual(requests[0], {
            model: "claude-sonnet-4-5",
            max_tokens: 10,
            temperature: 0,
            messages,
            system: SYSTEM_PROMPTS.research,
            tools
          }),
          `requête inattendue : ${JSON.stringify(requests)}`
        );

        assert(
          response === mockedResponse &&
          extractText(response) === "réponse mock",
          "réponse SDK non restituée"
        );

        assert(
          isDeepStrictEqual(Object.keys(meta).sort(), META_KEYS) &&
          meta.model === "mock-model" &&
          meta.input_tokens === 3 &&
          meta.output_tokens === 2 &&
          meta.stop_reason === "end_turn" &&
          Number.isInteger(meta.duration_ms),
          `meta inattendue : ${JSON.stringify(meta)}`
        );
      }
    );
  } finally {
    resetCallGuard();
    fs.rmSync(guardDir, { recursive: true, force: true });
    Anthropic.Messages.prototype.create =
      networkGuard.sdkMessagesCreate;
  }
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 9. Garantie zéro API ---");

await test("aucune sortie réseau ni appel SDK réel pendant les tests", () => {
  const attempts = networkGuard.attempts().slice(guardBaseline);

  assert(
    attempts.length === 0,
    `tentatives bloquées inattendues : ${attempts.join(", ")}`
  );
});

await test("environnement restauré : NO_API=1, aucune clé dans le processus", () => {
  assert(process.env.NO_API === "1", "NO_API n'est plus à 1");

  assert(
    !("ANTHROPIC_API_KEY" in process.env),
    "une clé est présente dans le processus"
  );
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API Anthropic réelle utilisée : NON");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — Fixture Engine"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — Fixture Engine : 7 mappings, scénarios, fail-closed, zéro API"
);

process.exit(0);
