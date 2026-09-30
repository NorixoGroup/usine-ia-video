// Smoke R14A/R14B — profil de durée et cadre narré — zéro API.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/duration-frame-smoke.js
//
// R14A : la durée cible est paramétrable (profil "standard" 25-30 min par
// défaut, profil "short" 3-5 min), sans changer le comportement historique.
// R14B : hook et conclusion sont de vrais segments du script (role hook /
// conclusion), qui traversent les mêmes gates que les autres segments.
//
// Les agents tournent sur les fixtures Anthropic locales ; les requêtes
// exactes sont capturées avec un SDK mocké en mémoire et une clé factice.
// Aucun réseau, aucun appel réel.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import {
  configureCallGuard,
  resetCallGuard
} from "../src/services/call-guard.js";

import {
  DEFAULT_DURATION_PROFILE,
  STANDARD_DURATION_RANGE,
  STANDARD_SCRIPT_SECTIONS,
  formatDurationLabel,
  formatSectionsLabel,
  listDurationProfileNames,
  resolveDurationProfile,
  usableDurationRange
} from "../src/utils/duration-profile.js";

import {
  scriptHasFrameRoles,
  syncNarratedFrameFields,
  validateScriptDossier
} from "../src/utils/validate-script.js";

import {
  validateVoiceManifestMapping
} from "../src/utils/validate-voice-manifest.js";

import { runResearchAgent } from "../src/agents/research.js";
import { runScriptAgent } from "../src/agents/script.js";
import { runVisualDirector } from "../src/agents/visual-director.js";
import { runVoiceAgent } from "../src/agents/voice.js";
import { runQualityAgent } from "../src/agents/quality.js";

import {
  CANONICAL_TITLE,
  CANONICAL_PROMPT
} from "../src/fixtures/anthropic-dataset.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

// Aucune clé réelle n'est nécessaire : elle est retirée du processus.
delete process.env.ANTHROPIC_API_KEY;

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PROJECTS = path.join(ROOT, "projects");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");

const pipelineConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, "config", "pipeline.json"), "utf8")
);

const DUMMY_KEY = "x".repeat(60);

let passed = 0;
let failed = 0;

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
}

function expectThrow(fn, pattern) {
  let error = null;

  try {
    fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "une erreur était attendue, aucune n'a été levée");
  assert(
    pattern.test(error.message),
    `erreur inattendue : ${error.message}`
  );
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

const FIXTURES_ENV = {
  ANTHROPIC_FIXTURES: "1",
  ANTHROPIC_FIXTURE_SCENARIO: undefined,
  NO_API: "1"
};

function fixtures(fn, scenario) {
  return withEnv(
    { ...FIXTURES_ENV, ANTHROPIC_FIXTURE_SCENARIO: scenario },
    fn
  );
}

const STANDARD = resolveDurationProfile(pipelineConfig.video);
const SHORT = resolveDurationProfile(pipelineConfig.video, "short");

function research() {
  return runResearchAgent({
    title: CANONICAL_TITLE,
    prompt: CANONICAL_PROMPT,
    testMode: true
  });
}

// Script issu des fixtures pour un profil et un cadre donnés.
async function buildScript({ profile, narratedFrame, scenario } = {}) {
  return fixtures(async () => {
    const dossier = await research();

    return runScriptAgent({
      research: dossier.data,
      title: CANONICAL_TITLE,
      testMode: true,
      durationProfile: profile,
      narratedFrame
    });
  }, scenario);
}

console.log("========================================");
console.log(" R14A/R14B — DUREE ET CADRE NARRE (ZERO API)");
console.log("========================================");

// ------------------------------------------------------------------
console.log("");
console.log("--- 1. Profils de durée (R14A) ---");

await test("profil standard : identique aux constantes historiques 25-30 min et à la configuration", () => {
  assert(DEFAULT_DURATION_PROFILE === "standard", "nom par défaut");
  assert(
    STANDARD.min === STANDARD_DURATION_RANGE.min &&
    STANDARD.max === STANDARD_DURATION_RANGE.max &&
    STANDARD.min === 25 &&
    STANDARD.max === 30 &&
    STANDARD.target === 27,
    JSON.stringify(STANDARD)
  );
  assert(
    STANDARD.sections.min === STANDARD_SCRIPT_SECTIONS.min &&
    STANDARD.sections.max === STANDARD_SCRIPT_SECTIONS.max &&
    STANDARD.sections.min === 6 &&
    STANDARD.sections.max === 8,
    JSON.stringify(STANDARD.sections)
  );
  assert(
    pipelineConfig.video.minimum_duration_minutes === 25 &&
    pipelineConfig.video.maximum_duration_minutes === 30 &&
    pipelineConfig.video.target_duration_minutes === 27,
    "les clés historiques de config/pipeline.json ont changé"
  );
});

await test("profil short : 3-5 min, cible 4, 3 à 4 sections", () => {
  assert(
    SHORT.name === "short" &&
    SHORT.min === 3 && SHORT.max === 5 && SHORT.target === 4 &&
    SHORT.sections.min === 3 && SHORT.sections.max === 4,
    JSON.stringify(SHORT)
  );
  assert(
    JSON.stringify(listDurationProfileNames(pipelineConfig.video)) ===
      '["standard","short"]',
    "liste des profils"
  );
});

await test("profil inconnu ou nom invalide → refus", () => {
  for (const name of ["bogus", "Short", "STANDARD", "", null, 5]) {
    expectThrow(
      () => resolveDurationProfile(pipelineConfig.video, name),
      /Profil de durée/
    );
  }
});

await test("profil hors limites ou incohérent dans la configuration → refus", () => {
  const variants = {
    "minimum > maximum": { minimum_duration_minutes: 6, maximum_duration_minutes: 5 },
    "cible > maximum": { target_duration_minutes: 9 },
    "cible < minimum": { target_duration_minutes: 2 },
    "minimum nul": { minimum_duration_minutes: 0, target_duration_minutes: 0 },
    "minimum négatif": { minimum_duration_minutes: -3 },
    "valeur texte": { maximum_duration_minutes: "5" },
    "valeur absente": { target_duration_minutes: undefined },
    "sections min > max": { script_sections: { minimum: 5, maximum: 3 } },
    "sections nulles": { script_sections: { minimum: 0, maximum: 3 } },
    "sections non entières": { script_sections: { minimum: 1.5, maximum: 3 } },
    "sections absentes": { script_sections: undefined }
  };

  for (const [label, patch] of Object.entries(variants)) {
    const video = structuredClone(pipelineConfig.video);

    video.duration_profiles.short = {
      ...video.duration_profiles.short,
      ...patch
    };

    let error = null;

    try {
      resolveDurationProfile(video, "short");
    } catch (caught) {
      error = caught;
    }

    assert(
      error && /invalide dans config\/pipeline\.json/.test(error.message),
      `${label} : refus attendu`
    );
  }
});

await test("plage utilisable et libellés des prompts", () => {
  assert(
    JSON.stringify(usableDurationRange({ min: 3, max: 5, target: 4 })) ===
      '{"min":3,"max":5}',
    "plage valide"
  );

  for (const bad of [
    undefined, null, {}, { min: 5, max: 3 }, { min: 0, max: 5 },
    { min: "3", max: 5 }, { min: NaN, max: 5 }
  ]) {
    assert(usableDurationRange(bad) === undefined, JSON.stringify(bad));
  }

  assert(formatDurationLabel() === "25 à 30 minutes", "libellé par défaut");
  assert(formatSectionsLabel() === "6 à 8", "sections par défaut");
  assert(formatDurationLabel(SHORT) === "3 à 5 minutes", "libellé short");
  assert(formatSectionsLabel(SHORT.sections) === "3 à 4", "sections short");
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 2. Gate de durée du script ---");

function scriptWith(minutes) {
  return {
    title: "T",
    hook: "H",
    thesis: "Th",
    estimated_duration_minutes: minutes,
    sections: [
      {
        title: "S",
        purpose: "P",
        segments: [
          {
            voiceover: "V",
            estimated_seconds: 10,
            research_fact_refs: [0],
            contains_unverified_claim: false,
            claims: []
          }
        ]
      }
    ],
    conclusion: "C"
  };
}

await test("sans option : 25-30 inchangé, message historique exact", () => {
  for (const ok of [25, 27, 30]) {
    assert(validateScriptDossier(scriptWith(ok)).valid, `${ok} refusé`);
  }

  for (const bad of [24.9, 30.1, 4, 60]) {
    const result = validateScriptDossier(scriptWith(bad));

    assert(
      !result.valid &&
      result.errors.includes(
        "estimated_duration_minutes doit être compris entre 25 et 30"
      ),
      `${bad} : ${result.errors}`
    );
  }
});

await test("plage 3-5 : 3, 4, 5 acceptés ; 2.9, 5.1 et 27 refusés", () => {
  const options = { durationRange: { min: 3, max: 5 } };

  for (const ok of [3, 4, 5]) {
    assert(validateScriptDossier(scriptWith(ok), options).valid, `${ok} refusé`);
  }

  for (const bad of [2.9, 5.1, 27]) {
    const result = validateScriptDossier(scriptWith(bad), options);

    assert(
      !result.valid &&
      result.errors.includes(
        "estimated_duration_minutes doit être compris entre 3 et 5"
      ),
      `${bad} : ${result.errors}`
    );
  }
});

await test("plage invalide ou absente → repli sur 25-30 (jamais de validation désactivée)", () => {
  for (const durationRange of [
    undefined, null, {}, { min: 5, max: 3 }, { min: 0, max: 0 }
  ]) {
    assert(
      validateScriptDossier(scriptWith(27), { durationRange }).valid,
      "27 doit passer avec le repli"
    );
    assert(
      !validateScriptDossier(scriptWith(4), { durationRange }).valid,
      "4 doit être refusé avec le repli"
    );
  }
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 3. Requêtes envoyées aux agents (SDK mocké) ---");

const DUMMY_RESEARCH = {
  topic: "t",
  central_question: "q",
  executive_summary: "s",
  key_facts: [{
    claim: "c",
    importance: "high",
    verification_status: "needs_verification",
    sources: []
  }],
  story_angles: [{ angle: "a", why_it_matters: "w" }],
  sections: [{ title: "s", purpose: "p", facts_needed: [] }],
  visual_opportunities: [{ subject: "s", suggested_visual: "v" }],
  claims_requiring_sources: [],
  uncertainties: [],
  research_gaps: []
};

// Capture la requête exacte envoyée au SDK, puis interrompt l'appel.
async function captureRequest(fn) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "duration-frame-smoke-")
  );

  try {
    return await withEnv(
      {
        ANTHROPIC_FIXTURES: undefined,
        ANTHROPIC_FIXTURE_SCENARIO: undefined,
        NO_API: undefined,
        PIPELINE_REAL_CALLS_ACK: "1",
        ANTHROPIC_API_KEY: DUMMY_KEY
      },
      async () => {
        const seen = [];

        Anthropic.Messages.prototype.create = async function (request) {
          seen.push(request);
          throw new Error("capture — appel interrompu");
        };

        try {
          configureCallGuard({ productionDir: directory, cap: 5 });
          await fn().catch(() => {});
        } finally {
          resetCallGuard();
          Anthropic.Messages.prototype.create =
            networkGuard.sdkMessagesCreate;
        }

        assert(seen.length === 1, `${seen.length} requête(s) capturée(s)`);

        return seen[0];
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const hash = value =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);

const CAPTURES = {
  researchTest: () => captureRequest(() => runResearchAgent({
    title: "Titre", prompt: "Consigne", testMode: true
  })),
  researchFull: () => captureRequest(() => runResearchAgent({
    title: "Titre", prompt: "Consigne", testMode: false
  })),
  scriptTest: (extra = {}) => captureRequest(() => runScriptAgent({
    research: DUMMY_RESEARCH, title: "Titre", testMode: true, ...extra
  })),
  scriptFull: (extra = {}) => captureRequest(() => runScriptAgent({
    research: DUMMY_RESEARCH, title: "Titre", testMode: false, ...extra
  }))
};

// Empreintes (système, messages, outils, max_tokens) relevées sur les
// requêtes de la baseline d4104ff : le comportement par défaut est
// strictement identique.
const HISTORICAL = {
  researchTest: ["27ca6465f588d100", "5d20b1278f0559b2", "74234e98afe7498f", 1800],
  researchFull: ["27ca6465f588d100", "d8684eb3fa85d66d", "0867f3fb456273a7", 8000],
  scriptTest: ["d5c2999f4df5a49d", "12668a943ba69967", "74234e98afe7498f", 2200],
  scriptFull: ["d5c2999f4df5a49d", "01dc54b4b10e76db", "74234e98afe7498f", 12000]
};

function fingerprint(request) {
  return [
    hash(request.system),
    hash(request.messages),
    hash(request.tools ?? null),
    request.max_tokens
  ];
}

for (const name of Object.keys(HISTORICAL)) {
  await test(`requête par défaut "${name}" : octet pour octet celle de la baseline`, async () => {
    const request = await CAPTURES[name]();

    assert(
      JSON.stringify(fingerprint(request)) ===
        JSON.stringify(HISTORICAL[name]),
      `empreinte ${JSON.stringify(fingerprint(request))}`
    );
  });
}

await test("profil standard explicite : requêtes identiques aux requêtes par défaut", async () => {
  const explicit = await CAPTURES.scriptFull({ durationProfile: STANDARD });

  assert(
    JSON.stringify(fingerprint(explicit)) ===
      JSON.stringify(HISTORICAL.scriptFull),
    "script full"
  );
});

await test("profil short : 3 à 5 minutes partout, plus aucune trace de 25 à 30", async () => {
  const requests = {
    researchFull: await captureRequest(() => runResearchAgent({
      title: "Titre", prompt: "Consigne", testMode: false,
      durationProfile: SHORT
    })),
    scriptFull: await CAPTURES.scriptFull({ durationProfile: SHORT }),
    scriptTest: await CAPTURES.scriptTest({ durationProfile: SHORT })
  };

  for (const [name, request] of Object.entries(requests)) {
    const text = `${request.system}\n${request.messages[0].content}`;

    assert(!/25 à 30|25 et 30|6 à 8|6 et 8|\b27\b/.test(text), `${name} : trace du profil standard`);
    assert(/3 à 5 minutes|3 et 5/.test(text), `${name} : durée short absente`);
  }

  assert(
    /Produis entre 3 et 4 sections\./.test(requests.researchFull.system),
    "sections Research"
  );
  assert(
    /- 3 à 4 sections\./.test(requests.scriptFull.system) &&
    /"estimated_duration_minutes": 4,/.test(requests.scriptFull.system),
    "sections et cible du Script"
  );
  assert(
    /estimated_duration_minutes doit rester entre 3 et 5 ;/.test(
      requests.scriptTest.messages[0].content
    ),
    "prompt de test"
  );
});

await test("cadre narré : règles ajoutées APRÈS le prompt historique, rappel dans le prompt utilisateur", async () => {
  const base = await CAPTURES.scriptFull();
  const framed = await CAPTURES.scriptFull({ narratedFrame: true });

  assert(
    framed.system.startsWith(base.system) &&
    framed.system.length > base.system.length &&
    /CADRE NARRÉ \(obligatoire pour ce script\)/.test(framed.system) &&
    /"role": "hook"/.test(framed.system) &&
    /"role": "conclusion"/.test(framed.system),
    "règles du cadre"
  );
  assert(
    /\nCADRE NARRÉ : /.test(framed.messages[0].content) &&
    !/CADRE NARRÉ/.test(base.messages[0].content) &&
    !/CADRE NARRÉ/.test(base.system),
    "rappel utilisateur ou fuite vers le prompt par défaut"
  );

  const framedTest = await CAPTURES.scriptTest({ narratedFrame: true });

  assert(
    /1 segment par section, hors hook et conclusion ;/.test(
      framedTest.messages[0].content
    ),
    "consigne de test"
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 4. Script Agent (fixtures) ---");

const legacy = await buildScript();
const short = await buildScript({ profile: SHORT });
const framed = await buildScript({ narratedFrame: true });
const shortFramed = await buildScript({
  profile: SHORT,
  narratedFrame: true
});

function flatten(script) {
  return script.sections.flatMap(section => section.segments);
}

await test("défaut : script historique 27 min, aucun role, hook distinct des segments", () => {
  const data = legacy.data;

  assert(data.estimated_duration_minutes === 27, `durée ${data.estimated_duration_minutes}`);
  assert(!scriptHasFrameRoles(data), "role inattendu");
  assert(flatten(data).length === 2, `${flatten(data).length} segments`);
  assert(
    flatten(data).every(segment => segment.voiceover !== data.hook) &&
    flatten(data).every(segment => segment.voiceover !== data.conclusion),
    "hook ou conclusion déjà dans les segments"
  );
  assert(legacy.validation.valid, "validation");
});

await test("profil short : script déclaré 4 min accepté (plage 3-5), refusé sous la plage standard", () => {
  assert(short.data.estimated_duration_minutes === 4, `durée ${short.data.estimated_duration_minutes}`);
  assert(short.validation.valid, "validation");
  assert(
    !validateScriptDossier(short.data).valid,
    "le script short ne doit pas passer la plage 25-30"
  );
});

await test("profil hors limites : plage absente du jeu de données → échec fail-closed, aucun script", async () => {
  await expectReject(
    () => buildScript({
      profile: {
        name: "hors", target: 11, min: 10, max: 12,
        sections: { min: 3, max: 4 }
      }
    }),
    /plage de durée hors du jeu de données canonique/
  );
});

await test("cadre narré : hook = premier segment, conclusion = dernier, champs identiques, claims présents", () => {
  const data = framed.data;
  const segments = flatten(data);
  const first = segments[0];
  const last = segments[segments.length - 1];

  assert(segments.length === 4, `${segments.length} segments`);
  assert(first.role === "hook" && last.role === "conclusion", "roles");
  assert(
    data.sections[0].segments[0] === first &&
    data.sections[data.sections.length - 1].segments.at(-1) === last,
    "positions"
  );
  assert(data.hook === first.voiceover, "hook ≠ premier segment");
  assert(data.conclusion === last.voiceover, "conclusion ≠ dernier segment");
  assert(
    segments.filter(segment => segment.role !== undefined).length === 2,
    "roles en trop"
  );

  for (const segment of [first, last]) {
    assert(
      Array.isArray(segment.claims) && segment.claims.length >= 1 &&
      segment.research_fact_refs.length >= 1 &&
      segment.estimated_seconds > 0 &&
      typeof segment.contains_unverified_claim === "boolean",
      "structure factuelle du segment"
    );
  }

  assert(framed.validation.valid, "validation");
});

await test("cadre narré : les mêmes gates factuels que les autres segments (claims et couverture)", () => {
  assert(framed.claim_validation.valid, "Claim Gate");
  assert(framed.claim_coverage_validation.valid, "Coverage Gate");

  const labels = framed.claim_coverage_validation.segments.map(s => s.label);

  assert(
    JSON.stringify(labels) === JSON.stringify([
      "sections[0].segments[0]",
      "sections[0].segments[1]",
      "sections[1].segments[0]",
      "sections[1].segments[1]"
    ]),
    `segments jugés : ${labels}`
  );
  assert(
    framed.claim_coverage_validation.segments.every(s => s.covered === true),
    "segment non couvert"
  );
  assert(framed.usage.model === "fixture:script", framed.usage.model);
});

await test("profil short + cadre narré : durée 4 min et roles", () => {
  assert(shortFramed.data.estimated_duration_minutes === 4, "durée");
  assert(flatten(shortFramed.data).length === 4, "segments");
  assert(shortFramed.validation.valid, "validation");
});

await test("cadre narré + réparation de couverture : segment réparé, hook et conclusion cohérents", async () => {
  const repaired = await buildScript({
    narratedFrame: true,
    scenario: "script-coverage-repair"
  });

  const segments = repaired.claim_coverage_validation.segments;

  assert(segments[1].repaired === true, "le segment aride devait être réparé");
  assert(
    segments.filter(s => s.repaired).length === 1,
    "seul ce segment doit être réparé"
  );
  assert(repaired.data.hook === flatten(repaired.data)[0].voiceover, "hook");
  assert(repaired.validation.valid, "validation finale");
});

await test("cadre narré + réparation impossible → rejet par le Coverage Gate", async () => {
  await expectReject(
    () => buildScript({
      narratedFrame: true,
      scenario: "script-coverage-unrepairable"
    }),
    /Voiceover Claim Coverage Gate/
  );
});

function framedClone() {
  return structuredClone(framed.data);
}

const FRAME_NEGATIVES = {
  "hook pas en premier segment": data => {
    const [hook, arid] = data.sections[0].segments;
    data.sections[0].segments = [arid, hook];
  },
  "conclusion pas en dernier segment": data => {
    const [population, conclusion] = data.sections[1].segments;
    data.sections[1].segments = [conclusion, population];
  },
  "deux segments hook": data => {
    data.sections[0].segments[1].role = "hook";
  },
  "hook absent": data => {
    delete data.sections[0].segments[0].role;
  },
  "conclusion absente": data => {
    delete data.sections[1].segments[1].role;
  },
  "role inconnu": data => {
    data.sections[0].segments[1].role = "body";
  },
  "hook sans claim": data => {
    data.sections[0].segments[0].claims = [];
  },
  "conclusion sans claim": data => {
    delete data.sections[1].segments[1].claims;
  },
  "champ hook différent du segment": data => {
    data.hook = "Un autre hook.";
  },
  "champ conclusion différent du segment": data => {
    data.conclusion = "Une autre conclusion.";
  },
  "champ hook vide": data => {
    data.hook = "";
  }
};

await test("cadre narré incohérent → refusé (11 cas)", () => {
  assert(validateScriptDossier(framedClone()).valid, "base valide");

  for (const [label, alter] of Object.entries(FRAME_NEGATIVES)) {
    const data = framedClone();

    alter(data);

    const result = validateScriptDossier(data);

    assert(!result.valid, `${label} : refus attendu`);
  }
});

await test("cadre narré exigé : un script historique est refusé ; sans exigence il reste valide", () => {
  const data = structuredClone(legacy.data);

  assert(validateScriptDossier(data).valid, "historique valide par défaut");

  const required = validateScriptDossier(data, {
    requireNarratedFrame: true
  });

  assert(
    !required.valid &&
    required.errors.some(error => /cadre narré/.test(error)),
    `erreurs : ${required.errors}`
  );

  const single = {
    ...scriptWith(27),
    sections: [{
      ...scriptWith(27).sections[0],
      segments: [scriptWith(27).sections[0].segments[0]]
    }]
  };

  assert(
    validateScriptDossier(single, { requireNarratedFrame: true })
      .errors.some(error => /au moins deux segments/.test(error)),
    "un seul segment ne peut être hook et conclusion"
  );
});

await test("un seul role (hook sans conclusion) dans un script non exigé → refusé", () => {
  const data = structuredClone(legacy.data);

  data.sections[0].segments[0].role = "hook";
  data.hook = data.sections[0].segments[0].voiceover;

  assert(scriptHasFrameRoles(data), "role non détecté");
  assert(!validateScriptDossier(data).valid, "cadre partiel accepté");
});

await test("hook et conclusion dérivés de leurs segments après réparation", () => {
  const data = framedClone();

  data.sections[0].segments[0].voiceover = "Hook réparé.";
  data.sections[1].segments[1].voiceover = "Conclusion réparée.";

  assert(!validateScriptDossier(data).valid, "divergence non détectée");

  syncNarratedFrameFields(data);

  assert(
    data.hook === "Hook réparé." && data.conclusion === "Conclusion réparée.",
    "synchronisation"
  );
  assert(validateScriptDossier(data).valid, "validation après synchronisation");
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 5. Visual Director et Voice (fixtures) ---");

const visualFramed = await fixtures(() => runVisualDirector({
  script: framed.data,
  testMode: true
}));

const visualLegacy = await fixtures(() => runVisualDirector({
  script: legacy.data,
  testMode: true
}));

await test("Visual : le hook et la conclusion ont leur plan, jugé par le grounding", () => {
  const plan = visualFramed.data.sections;

  assert(
    JSON.stringify(plan.map(s => s.segments.map(g => g.script_segment_index))) ===
      "[[0,1],[0,1]]",
    "indices de segments"
  );
  assert(plan[0].segments[0].shots.length === 2, "shots du hook");
  assert(plan[1].segments[1].shots.length === 2, "shots de la conclusion");
  assert(
    plan[0].segments[0].estimated_seconds === 20 &&
    plan[0].segments[0].shots.reduce((t, shot) => t + shot.duration_seconds, 0) === 20,
    "durée du hook"
  );
  assert(visualFramed.factual_grounding_validation.valid, "grounding");

  const judged = visualFramed.factual_grounding_validation.shots.length;

  assert(judged === 9, `${judged} shots jugés (9 attendus)`);
  assert(
    visualLegacy.factual_grounding_validation.shots.length === 5,
    "plan historique : 5 shots"
  );
});

await test("Visual et Voice reçoivent la plage de durée du profil (short accepté, refusé sans profil)", async () => {
  await fixtures(async () => {
    const visual = await runVisualDirector({
      script: short.data,
      testMode: true,
      durationProfile: SHORT
    });

    assert(visual.validation.valid, "visual short");
  });

  await fixtures(() => expectReject(
    () => runVisualDirector({ script: short.data, testMode: true }),
    /entre 25 et 30/
  ));

  const voice = await runVoiceAgent({
    script: short.data,
    testMode: true,
    durationProfile: SHORT
  });

  assert(voice.validation.valid, "voice short");

  await expectReject(
    () => runVoiceAgent({ script: short.data, testMode: true }),
    /entre 25 et 30/
  );
});

const voiceFramed = await runVoiceAgent({
  script: framed.data,
  testMode: true
});

const voiceLegacy = await runVoiceAgent({
  script: legacy.data,
  testMode: true
});

await test("Voice : le hook et la conclusion sont narrés (4 unités), pas dans un script historique (2)", () => {
  const units = voiceFramed.data.narration_units;

  assert(
    JSON.stringify(units.map(u => u.unit_id)) ===
      '["s01-g01","s01-g02","s02-g01","s02-g02"]',
    "unit_id"
  );
  assert(units[0].text === framed.data.hook, "unité 1 ≠ hook");
  assert(units[3].text === framed.data.conclusion, "unité 4 ≠ conclusion");
  assert(voiceFramed.data.summary.total_units === 4, "total");
  assert(voiceLegacy.data.narration_units.length === 2, "historique");
  assert(
    !voiceLegacy.data.narration_units.some(
      u => u.text === legacy.data.hook || u.text === legacy.data.conclusion
    ),
    "hook ou conclusion historique narré"
  );
});

await test("contrôle de Quality : une unité de hook manquante est détectée par le mapping voice/script", () => {
  const voice = structuredClone(voiceFramed.data);

  assert(
    validateVoiceManifestMapping(voice, framed.data).valid,
    "mapping nominal"
  );

  voice.narration_units.shift();

  assert(
    !validateVoiceManifestMapping(voice, framed.data).valid,
    "hook non narré non détecté"
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 6. Pipeline complet (processus enfants, fixtures) ---");

function listProductions() {
  return fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).sort() : [];
}

const blockedByRun = [];

function run(args, env = {}) {
  const before = listProductions();

  const child = spawnSync(
    process.execPath,
    ["--import", GUARD, "src/orchestrator/mvp.js", ...args],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, NO_API: "1", ...env },
      encoding: "utf8"
    }
  );

  const guardLine = child.stderr.match(
    /\[fixture-network-guard\] actif — tentatives bloquées : (\d+)/
  );

  blockedByRun.push(guardLine ? Number(guardLine[1]) : null);

  const productionId =
    child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null;

  const read = name => {
    const file = path.join(PROJECTS, productionId ?? "", `${name}.json`);

    return productionId && fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
  };

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created: listProductions().filter(name => !before.includes(name)),
    productionId,
    read
  };
}

const FX = { ANTHROPIC_FIXTURES: "1" };
const FINAL_STATUS =
  "research_script_visual_asset_voice_assembly_quality_pass";

const RUNS = {
  standard: run(["--research-script"], FX),
  short: run(["--research-script", "--duration-profile=short"], FX),
  framed: run(["--research-script", "--narrated-frame"], FX),
  shortFramed: run(
    ["--research-script", "--duration-profile=short", "--narrated-frame"],
    FX
  )
};

await test("défaut : profil standard, 25-30, script historique, bannière inchangée", () => {
  const result = RUNS.standard;
  const production = result.read("production");

  assert(result.status === 0, `exit ${result.status}\n${result.stderr}`);
  assert(production.status === FINAL_STATUS, production.status);
  assert(
    production.duration_profile === "standard" &&
    production.narrated_frame === false,
    "profil ou cadre"
  );
  assert(
    JSON.stringify(production.target.duration_minutes) ===
      '{"target":27,"min":25,"max":30}',
    JSON.stringify(production.target.duration_minutes)
  );
  assert(/^Durée      : 25-30 min$/m.test(result.stdout), "bannière durée");
  assert(!/Profil durée|Cadre narré/.test(result.stdout), "bannière modifiée");
  assert(!scriptHasFrameRoles(result.read("script").data), "role");
  assert(result.read("voice").data.narration_units.length === 2, "unités");
});

await test("profil short : cible 3-5 min propagée (production, script, Quality), PASS", () => {
  const result = RUNS.short;
  const production = result.read("production");

  assert(result.status === 0, `exit ${result.status}\n${result.stderr}`);
  assert(production.status === FINAL_STATUS, production.status);
  assert(production.duration_profile === "short", "profil");
  assert(
    JSON.stringify(production.target.duration_minutes) ===
      '{"target":4,"min":3,"max":5}',
    JSON.stringify(production.target.duration_minutes)
  );
  assert(/^Durée      : 3-5 min$/m.test(result.stdout), "bannière durée");
  assert(/^Profil durée : short$/m.test(result.stdout), "bannière profil");
  assert(result.read("script").data.estimated_duration_minutes === 4, "script");

  const quality = result.read("quality");

  assert(quality.data.metrics.declared_duration_minutes === 4, "métrique");
  assert(
    quality.data.warnings.some(
      w => /hors de la cible 3–5 min — non bloquant en mode test/.test(w)
    ),
    `avertissements : ${JSON.stringify(quality.data.warnings)}`
  );
});

await test("cadre narré : le hook et la conclusion traversent Visual, Asset, Voice, Assembly et Quality", () => {
  const result = RUNS.framed;
  const production = result.read("production");

  assert(result.status === 0, `exit ${result.status}\n${result.stderr}`);
  assert(production.status === FINAL_STATUS, production.status);
  assert(production.narrated_frame === true, "narrated_frame");
  assert(/^Cadre narré : /m.test(result.stdout), "bannière");

  const script = result.read("script").data;
  const visual = result.read("visual").data;
  const assets = result.read("assets").data;
  const voice = result.read("voice").data;
  const assembly = result.read("assembly").data;
  const quality = result.read("quality").data;

  assert(script.sections[0].segments[0].role === "hook", "hook");
  assert(script.sections[1].segments.at(-1).role === "conclusion", "conclusion");
  assert(visual.sections[0].segments[0].shots.length >= 1, "Visual : hook");
  assert(visual.sections[1].segments.at(-1).shots.length >= 1, "Visual : conclusion");
  assert(
    assets.assets.some(a => a.asset_id.startsWith("s01-g01-")) &&
    assets.assets.some(a => a.asset_id.startsWith("s02-g02-")),
    "Asset : hook ou conclusion sans asset"
  );
  assert(
    voice.narration_units[0].text === script.hook &&
    voice.narration_units.at(-1).text === script.conclusion &&
    voice.narration_units.length === 4,
    "Voice"
  );
  assert(
    assembly.summary.total_units === 4 && assembly.summary.total_clips === 9,
    JSON.stringify(assembly.summary)
  );
  assert(
    quality.metrics.segments === 4 && quality.metrics.narration_units === 4,
    JSON.stringify(quality.metrics)
  );
  assert(
    JSON.stringify(Object.keys(result.read("production").artifact_sha256).sort()) ===
      '["research.json","script.json","visual.json"]',
    "scellés"
  );
});

await test("profil short + cadre narré : PASS", () => {
  const result = RUNS.shortFramed;

  assert(result.status === 0, `exit ${result.status}\n${result.stderr}`);

  const production = result.read("production");

  assert(production.status === FINAL_STATUS, production.status);
  assert(
    production.duration_profile === "short" &&
    production.narrated_frame === true,
    "profil ou cadre"
  );
  assert(result.read("quality").data.metrics.segments === 4, "segments");
});

await test("Quality : la plage de durée déclarée du profil est appliquée ; sans elle, 25-30 historique", async () => {
  const result = RUNS.short;
  const production = result.read("production");

  const artifacts = Object.fromEntries(
    ["research", "script", "visual", "assets", "voice", "assembly"].map(
      name => [name, result.read(name)]
    )
  );

  const report = await runQualityAgent({
    artifacts,
    target: production.target,
    testMode: true,
    scriptDurationRange: { min: SHORT.min, max: SHORT.max }
  });

  assert(report.data.verdict === "pass", report.data.verdict);

  await expectReject(
    () => runQualityAgent({
      artifacts,
      target: production.target,
      testMode: true
    }),
    /\[structure\] script\.json: estimated_duration_minutes doit être compris entre 25 et 30/
  );
});

await test("options invalides → refus avant toute production", () => {
  const cases = [
    [["--research-script", "--duration-profile=bogus"], /Profil de durée inconnu "bogus"/],
    [["--research-script", "--duration-profile=SHORT"], /Profil de durée inconnu/],
    [["--research-script", "--duration-profile="], /--duration-profile exige un nom/],
    [["--dry-run", "--duration-profile=short"], /exigent --research-script/],
    [["--dry-run", "--narrated-frame"], /exigent --research-script/],
    [["--duration-profile=short"], /exigent --research-script/]
  ];

  for (const [args, pattern] of cases) {
    const result = run(args, FX);

    assert(result.status !== 0 && result.status !== null, `${args} : exit ${result.status}`);
    assert(pattern.test(result.stderr), `${args} : ${result.stderr.slice(0, 300)}`);
    assert(result.created.length === 0, `${args} : production créée`);
  }
});

await test("NO_API=1 reste fail-closed pour tous les profils : aucun appel, échec au Research", () => {
  for (const args of [
    ["--research-script"],
    ["--research-script", "--duration-profile=short", "--narrated-frame"]
  ]) {
    const result = run(args);

    assert(result.status === 1, `exit ${result.status}`);
    assert(
      /NO_API=1 — appel Anthropic interdit par le coupe-circuit local/.test(result.stderr),
      result.stderr.slice(0, 300)
    );
    assert(
      result.read("production").agents.find(a => a.id === "research").status === "failed",
      "research"
    );
  }
});

await test("mode complet : cadre narré implicite, profil transmis, échec fail-closed sans appel", () => {
  const result = run(
    [
      "--research-script", "--mode=full", "--real-calls-cap=3",
      "--duration-profile=short"
    ],
    { ...FX, NO_API: undefined, PIPELINE_REAL_CALLS_ACK: "1" }
  );

  assert(result.status === 1, `exit ${result.status}`);

  const production = result.read("production");

  assert(
    production.mode === "full" &&
    production.narrated_frame === true &&
    production.duration_profile === "short",
    JSON.stringify([production.mode, production.narrated_frame, production.duration_profile])
  );
  assert(/^Cadre narré : /m.test(result.stdout), "bannière");
  assert(production.status === "failed", production.status);
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 7. Reprise : profil et cadre immuables ---");

const pausedFramed = run(
  [
    "--research-script", "--duration-profile=short", "--narrated-frame",
    "--stop-after=script"
  ],
  FX
);

const pausedLegacy = run(["--research-script", "--stop-after=script"], FX);

await test("pause après le script : profil et cadre enregistrés dans production.json", () => {
  assert(pausedFramed.status === 0 && pausedLegacy.status === 0, "exit");

  const framedProduction = pausedFramed.read("production");

  assert(
    framedProduction.status === "paused" &&
    framedProduction.duration_profile === "short" &&
    framedProduction.narrated_frame === true,
    "production cadrée"
  );
  assert(pausedLegacy.read("production").narrated_frame === false, "production historique");
});

await test("reprise : option contradictoire refusée (profil, cadre) sans rien modifier", () => {
  const snapshot = id => fs.readFileSync(
    path.join(PROJECTS, id, "production.json"), "utf8"
  );

  const before = snapshot(pausedFramed.productionId);

  const badProfile = run(
    ["--research-script", `--resume=${pausedFramed.productionId}`, "--duration-profile=standard"],
    FX
  );

  assert(badProfile.status !== 0, "profil contradictoire accepté");
  assert(/différent du profil de la production \("short"\)/.test(badProfile.stderr), badProfile.stderr.slice(0, 300));

  const legacyBefore = snapshot(pausedLegacy.productionId);

  const badFrame = run(
    ["--research-script", `--resume=${pausedLegacy.productionId}`, "--narrated-frame"],
    FX
  );

  assert(badFrame.status !== 0, "cadre ajouté à une production historique");
  assert(/n'a pas de cadre narré/.test(badFrame.stderr), badFrame.stderr.slice(0, 300));

  assert(
    snapshot(pausedFramed.productionId) === before &&
    snapshot(pausedLegacy.productionId) === legacyBefore,
    "production modifiée par un refus"
  );
});

await test("reprise sans option : le profil et le cadre de la production sont conservés, script réutilisé", () => {
  const scriptBefore = fs.readFileSync(
    path.join(PROJECTS, pausedFramed.productionId, "script.json"), "utf8"
  );

  // Le Visual Director reste à faire : il tourne sur les fixtures.
  const resumed = run(
    ["--research-script", `--resume=${pausedFramed.productionId}`],
    FX
  );

  assert(resumed.status === 0, `exit ${resumed.status}\n${resumed.stderr}`);

  const production = resumed.read("production");

  assert(production.status === FINAL_STATUS, production.status);
  assert(
    production.duration_profile === "short" &&
    production.narrated_frame === true &&
    production.target.duration_minutes.max === 5,
    "profil ou cadre perdus"
  );
  assert(/Script RÉUTILISÉ/.test(resumed.stdout), "script non réutilisé");
  assert(
    fs.readFileSync(
      path.join(PROJECTS, pausedFramed.productionId, "script.json"), "utf8"
    ) === scriptBefore,
    "script modifié"
  );
  assert(resumed.read("voice").data.narration_units.length === 4, "unités");
});

await test("production marquée à cadre narré dont le script réutilisé n'en a pas → refus", () => {
  const file = path.join(PROJECTS, pausedLegacy.productionId, "production.json");
  const original = fs.readFileSync(file, "utf8");

  try {
    const production = JSON.parse(original);

    production.narrated_frame = true;
    fs.writeFileSync(file, JSON.stringify(production, null, 2) + "\n");

    const result = run(
      ["--research-script", `--resume=${pausedLegacy.productionId}`],
      { NO_API: "1" }
    );

    assert(result.status === 1, `exit ${result.status}`);
    assert(/script\.json sans cadre narré valide/.test(result.stderr), result.stderr.slice(0, 400));
    assert(!fs.existsSync(path.join(PROJECTS, pausedLegacy.productionId, "visual.json")), "visual.json écrit");
  } finally {
    fs.writeFileSync(file, original);
  }
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 8. Garanties ---");

await test("aucune tentative réseau, aucun SDK réel, environnement restauré", () => {
  assert(blockedByRun.length >= 15, `${blockedByRun.length} processus`);
  assert(
    blockedByRun.every(count => count === 0),
    `tentatives par processus : ${blockedByRun}`
  );
  assert(networkGuard.attempts().length === 0, "tentatives en processus");
  assert(
    Anthropic.Messages.prototype.create === networkGuard.sdkMessagesCreate,
    "SDK non restauré"
  );
  assert(process.env.NO_API === "1", "NO_API");
  assert(!process.env.ANTHROPIC_API_KEY, "clé dans le processus");
});

await test("rien n'a été écrit hors de projects/ (tmp/ et output/ inchangés)", () => {
  const strangers = (fs.existsSync(path.join(ROOT, "tmp"))
    ? fs.readdirSync(path.join(ROOT, "tmp"))
    : []
  ).filter(name => !name.startsWith("r9-media-"));

  assert(strangers.length === 0, `tmp/ : ${strangers}`);
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API Anthropic réelle utilisée : NON");
console.log(
  failed === 0
    ? "RESULTAT GLOBAL : PASS — profil de durée et cadre narré : défaut inchangé, short accepté, hook et conclusion en vrais segments, zéro API"
    : "RESULTAT GLOBAL : FAIL"
);

process.exit(failed === 0 ? 0 : 1);
