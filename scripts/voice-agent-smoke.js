// Smoke du Voice Agent — manifeste de narration déterministe, zéro API.
//
// Usage :
//   NO_API=1 node scripts/voice-agent-smoke.js
//
// Le Voice Agent n'utilise ni modèle ni fournisseur et ne produit aucun
// fichier audio. Le garde réseau est chargé en premier pour prouver
// qu'aucune sortie réseau n'est tentée.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { runVoiceAgent } from "../src/agents/voice.js";

import {
  summarizeNarration,
  validateVoiceManifest,
  validateVoiceManifestMapping
} from "../src/utils/validate-voice-manifest.js";

import {
  CANONICAL_TITLE,
  VOICEOVER_ARID,
  VOICEOVER_POPULATION,
  buildScript
} from "./canonical-artifacts.js";

delete process.env.ANTHROPIC_FIXTURES;
delete process.env.ANTHROPIC_API_KEY;

const ENVELOPE_KEYS = [
  "agent",
  "mode",
  "data",
  "validation",
  "script_mapping_validation",
  "usage"
];

const UNIT_KEYS = [
  "unit_id",
  "section_index",
  "segment_index",
  "text",
  "estimated_seconds",
  "status"
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
}

function checkGate(label, verdict, pattern) {
  if (pattern === null) {
    assert(
      verdict.valid === true && verdict.errors.length === 0,
      `${label} : PASS attendu — ${verdict.errors.join(" | ")}`
    );

    return;
  }

  assert(
    verdict.valid === false,
    `${label} : FAIL attendu, PASS obtenu`
  );

  assert(
    verdict.errors.some(error => pattern.test(error)),
    `${label} : erreur attendue ${pattern} — obtenu : ${verdict.errors.join(" | ")}`
  );
}

function resummarize(manifest) {
  manifest.summary = summarizeNarration(manifest.narration_units);
}

console.log("========================================");
console.log(" VOICE AGENT — SMOKE (ZERO API)");
console.log("========================================");

// ------------------------------------------------------------------
console.log("");
console.log("--- 1. Happy path ---");

const script = buildScript();
let result = null;

await test("script canonique → enveloppe validée", async () => {
  result = await runVoiceAgent({
    script,
    testMode: true
  });

  assert(
    isDeepStrictEqual(Object.keys(result), ENVELOPE_KEYS),
    `clés d'enveloppe : ${Object.keys(result)}`
  );

  assert(
    result.agent === "voice" &&
    result.mode === "test" &&
    result.usage === null,
    "agent / mode / usage inattendus"
  );

  assert(
    result.validation.valid === true &&
    result.validation.errors.length === 0,
    "Voice Gate : PASS attendu"
  );

  assert(
    result.script_mapping_validation.valid === true &&
    result.script_mapping_validation.errors.length === 0,
    "Script Mapping Gate : PASS attendu"
  );
});

await test("une unité par segment, dans l'ordre source, IDs attendus", () => {
  const units = result.data.narration_units;

  assert(units.length === 2, `unités : ${units.length}`);

  assert(
    isDeepStrictEqual(
      units.map(unit => [
        unit.unit_id,
        unit.section_index,
        unit.segment_index
      ]),
      [["s01-g01", 0, 0], ["s02-g01", 1, 0]]
    ),
    "unit_id ou positions inattendus"
  );
});

await test("texte recopié à l'identique, contrat fermé, status unsynthesized", () => {
  const units = result.data.narration_units;

  assert(
    isDeepStrictEqual(
      Object.keys(result.data),
      ["title", "narration_units", "summary"]
    ),
    `clés du manifeste : ${Object.keys(result.data)}`
  );

  for (const unit of units) {
    assert(
      isDeepStrictEqual(Object.keys(unit), UNIT_KEYS),
      `clés d'unité : ${Object.keys(unit)}`
    );

    assert(
      unit.status === "unsynthesized",
      `status=${unit.status}`
    );
  }

  assert(
    units[0].text === VOICEOVER_ARID &&
    units[1].text === VOICEOVER_POPULATION &&
    units[0].estimated_seconds === 20 &&
    units[1].estimated_seconds === 20,
    "texte ou durée infidèles"
  );

  assert(
    result.data.title === CANONICAL_TITLE,
    "title inattendu"
  );
});

await test("summary correcte", () => {
  assert(
    isDeepStrictEqual(result.data.summary, {
      total_units: 2,
      total_estimated_seconds: 40
    }),
    `summary : ${JSON.stringify(result.data.summary)}`
  );
});

await test("hook, thesis et conclusion ne sont pas narrés", () => {
  const serialized = JSON.stringify(result.data);

  for (const field of ["hook", "thesis", "conclusion"]) {
    assert(
      !serialized.includes(script[field]),
      `${field} présent dans voice.json`
    );
  }
});

await test("aucun fournisseur, aucune voix, aucun fichier audio", () => {
  assert(
    !/elevenlabs|voice_id|provider|\.mp3|\.wav|audio_file|https?:\/\//i.test(
      JSON.stringify(result)
    ),
    "le manifeste contient une référence audio ou fournisseur"
  );
});

await test("déterminisme : deux exécutions identiques → même résultat", async () => {
  const first = await runVoiceAgent({
    script: buildScript(),
    testMode: true
  });

  const second = await runVoiceAgent({
    script: buildScript(),
    testMode: true
  });

  assert(
    isDeepStrictEqual(first, second) &&
    isDeepStrictEqual(first, result),
    "résultats différents"
  );

  assert(
    JSON.stringify(first) === JSON.stringify(second),
    "sérialisations différentes"
  );
});

await test("le script source n'est pas modifié", async () => {
  const source = buildScript();

  await runVoiceAgent({
    script: source,
    testMode: true
  });

  assert(
    isDeepStrictEqual(source, buildScript()),
    "le script source a été modifié"
  );
});

await test("mode full et segments multiples", async () => {
  const source = buildScript();

  source.sections[0].segments.push({
    ...structuredClone(source.sections[0].segments[0]),
    voiceover: "Deuxième segment de la première section.",
    estimated_seconds: 7.5
  });

  const output = await runVoiceAgent({ script: source });

  assert(output.mode === "full", `mode=${output.mode}`);

  assert(
    isDeepStrictEqual(
      output.data.narration_units.map(unit => unit.unit_id),
      ["s01-g01", "s01-g02", "s02-g01"]
    ),
    "unit_id inattendus"
  );

  assert(
    output.data.narration_units[1].text ===
      "Deuxième segment de la première section." &&
    output.data.summary.total_estimated_seconds === 47.5,
    "unité ou summary inattendues"
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 2. Fail closed — entrée de l'agent ---");

function mutatedScript(mutate) {
  const source = buildScript();

  mutate(source);

  return source;
}

const invalidInputs = [
  [
    "entrée absente",
    () => undefined,
    /^Voice Agent : script source invalide\. Script absent ou invalide/
  ],
  [
    "entrée null",
    () => null,
    /^Voice Agent : script source invalide\./
  ],
  [
    "entrée non objet",
    () => "script.json",
    /^Voice Agent : script source invalide\./
  ],
  [
    "objet vide",
    () => ({}),
    /script source invalide\..*title manquant/
  ],
  [
    "enveloppe complète passée à la place de data",
    () => ({
      agent: "script",
      mode: "test",
      data: buildScript()
    }),
    /script source invalide\..*title manquant/
  ],
  [
    "sections vides",
    () => mutatedScript(source => {
      source.sections = [];
    }),
    /script source invalide\..*sections doit être un tableau non vide/
  ],
  [
    "section sans segment",
    () => mutatedScript(source => {
      source.sections[1].segments = [];
    }),
    /script source invalide\..*segments doit être un tableau non vide/
  ],
  [
    "voiceover vide",
    () => mutatedScript(source => {
      source.sections[0].segments[0].voiceover = "";
    }),
    /script source invalide\..*voiceover manquant/
  ],
  [
    "voiceover non texte",
    () => mutatedScript(source => {
      source.sections[0].segments[0].voiceover = 42;
    }),
    /script source invalide\..*voiceover manquant/
  ],
  [
    "estimated_seconds nul",
    () => mutatedScript(source => {
      source.sections[0].segments[0].estimated_seconds = 0;
    }),
    /script source invalide\..*estimated_seconds invalide/
  ],
  [
    "estimated_seconds non numérique",
    () => mutatedScript(source => {
      source.sections[0].segments[0].estimated_seconds = "20";
    }),
    /script source invalide\..*estimated_seconds invalide/
  ],
  [
    "title absent",
    () => mutatedScript(source => {
      delete source.title;
    }),
    /script source invalide\..*title manquant/
  ]
];

for (const [name, build, pattern] of invalidInputs) {
  await test(`entrée invalide → FAIL — ${name}`, async () => {
    await expectReject(
      () => runVoiceAgent({
        script: build(),
        testMode: true
      }),
      pattern
    );
  });
}

// ------------------------------------------------------------------
console.log("");
console.log("--- 3. Fail closed — Voice Gate et Script Mapping Gate ---");

// Chaque cas altère une copie du manifeste valide.
// gate / mapping : motif d'erreur attendu, ou null si le gate doit passer.
const tamperCases = [
  {
    name: "manifeste absent",
    build: () => undefined,
    gate: /Voice manifest absent ou invalide/,
    mapping: /Voice manifest absent ou invalide/
  },
  {
    name: "narration_units vide",
    mutate: manifest => {
      manifest.narration_units = [];
    },
    gate: /narration_units doit être un tableau non vide/,
    mapping: /unité manquante : 0 unités pour 2 segments/
  },
  {
    name: "title absent",
    mutate: manifest => {
      delete manifest.title;
    },
    gate: /manifest: champ title manquant/,
    mapping: /title différent du script source/
  },
  {
    name: "title altéré",
    mutate: manifest => {
      manifest.title = "Un autre titre";
    },
    gate: null,
    mapping: /title différent du script source/
  },
  {
    name: "unité manquante (summary non recalculée)",
    mutate: manifest => {
      manifest.narration_units.pop();
    },
    gate: /summary: total_units incorrect/,
    mapping: /unité manquante : 1 unités pour 2 segments/
  },
  {
    name: "unité manquante (summary recalculée)",
    mutate: manifest => {
      manifest.narration_units.pop();
      resummarize(manifest);
    },
    gate: null,
    mapping: /unité manquante : 1 unités pour 2 segments/
  },
  {
    name: "première unité manquante",
    mutate: manifest => {
      manifest.narration_units.shift();
      resummarize(manifest);
    },
    gate: null,
    mapping: /narration_units\[0\]: position différente du segment source/
  },
  {
    name: "unité supplémentaire",
    mutate: manifest => {
      manifest.narration_units.push({
        ...manifest.narration_units[1],
        unit_id: "s03-g01",
        section_index: 2
      });
      resummarize(manifest);
    },
    gate: null,
    mapping: /unité supplémentaire : 3 unités pour 2 segments/
  },
  {
    name: "unit_id dupliqué",
    mutate: manifest => {
      manifest.narration_units.push({
        ...manifest.narration_units[1]
      });
      resummarize(manifest);
    },
    gate: /narration_units\[2\]: unit_id dupliqué s02-g01/,
    mapping: /unité supplémentaire/
  },
  {
    name: "unit_id mal formé",
    mutate: manifest => {
      manifest.narration_units[0].unit_id = "unit-1";
    },
    gate: /narration_units\[0\]: unit_id incohérent/,
    mapping: null
  },
  {
    name: "indices incohérents",
    mutate: manifest => {
      manifest.narration_units[1].section_index = 3;
      manifest.narration_units[1].unit_id = "s04-g01";
    },
    gate: null,
    mapping: /narration_units\[1\]: position différente du segment source/
  },
  {
    name: "section_index négatif",
    mutate: manifest => {
      manifest.narration_units[0].section_index = -1;
    },
    gate: /narration_units\[0\]: section_index invalide/,
    mapping: /narration_units\[0\]: position différente du segment source/
  },
  {
    name: "ordre inversé",
    mutate: manifest => {
      manifest.narration_units.reverse();
    },
    gate: /ordre section\/segment non strictement croissant/,
    mapping: /narration_units\[0\]: position différente du segment source/
  },
  {
    name: "texte altéré",
    mutate: manifest => {
      manifest.narration_units[0].text =
        `${VOICEOVER_ARID} L'eau y est rare.`;
    },
    gate: null,
    mapping: /narration_units\[0\]: text différent du voiceover source/
  },
  {
    name: "texte altéré d'une simple espace",
    mutate: manifest => {
      manifest.narration_units[0].text += " ";
    },
    gate: null,
    mapping: /narration_units\[0\]: text différent du voiceover source/
  },
  {
    name: "textes intervertis",
    mutate: manifest => {
      const [first, second] = manifest.narration_units;

      [first.text, second.text] = [second.text, first.text];
    },
    gate: null,
    mapping: /narration_units\[0\]: text différent du voiceover source/
  },
  {
    name: "texte vide",
    mutate: manifest => {
      manifest.narration_units[0].text = "  ";
    },
    gate: /narration_units\[0\]: text manquant/,
    mapping: /narration_units\[0\]: text différent du voiceover source/
  },
  {
    name: "durée altérée (summary non recalculée)",
    mutate: manifest => {
      manifest.narration_units[0].estimated_seconds = 21;
    },
    gate: /summary: total_estimated_seconds incorrect/,
    mapping: /narration_units\[0\]: estimated_seconds différent du segment source/
  },
  {
    name: "durée altérée (summary recalculée)",
    mutate: manifest => {
      manifest.narration_units[0].estimated_seconds = 21;
      resummarize(manifest);
    },
    gate: null,
    mapping: /narration_units\[0\]: estimated_seconds différent du segment source/
  },
  {
    name: "durée invalide",
    mutate: manifest => {
      manifest.narration_units[0].estimated_seconds = 0;
    },
    gate: /narration_units\[0\]: estimated_seconds invalide/,
    mapping: /narration_units\[0\]: estimated_seconds différent du segment source/
  },
  {
    name: "mauvais status",
    mutate: manifest => {
      manifest.narration_units[0].status = "synthesized";
    },
    gate: /narration_units\[0\]: status doit être "unsynthesized"/,
    mapping: null
  },
  {
    name: "status absent",
    mutate: manifest => {
      delete manifest.narration_units[0].status;
    },
    gate: /narration_units\[0\]: champ status manquant/,
    mapping: null
  },
  {
    name: "summary absente",
    mutate: manifest => {
      delete manifest.summary;
    },
    gate: /manifest: champ summary manquant/,
    mapping: null
  },
  {
    name: "summary fausse : total_units",
    mutate: manifest => {
      manifest.summary.total_units = 3;
    },
    gate: /summary: total_units incorrect/,
    mapping: null
  },
  {
    name: "summary fausse : total_estimated_seconds",
    mutate: manifest => {
      manifest.summary.total_estimated_seconds = 41;
    },
    gate: /summary: total_estimated_seconds incorrect/,
    mapping: null
  },
  {
    name: "champ inconnu : audio_file",
    mutate: manifest => {
      manifest.narration_units[0].audio_file = "voice/s01-g01.mp3";
    },
    gate: /narration_units\[0\]: champ audio_file non autorisé/,
    mapping: null
  },
  {
    name: "champ inconnu : voice_id",
    mutate: manifest => {
      manifest.narration_units[0].voice_id = "voix-1";
    },
    gate: /narration_units\[0\]: champ voice_id non autorisé/,
    mapping: null
  },
  {
    name: "champ racine inconnu : provider",
    mutate: manifest => {
      manifest.provider = "elevenlabs";
    },
    gate: /manifest: champ provider non autorisé/,
    mapping: null
  },
  {
    name: "champ summary inconnu",
    mutate: manifest => {
      manifest.summary.synthesized_units = 0;
    },
    gate: /summary: champ synthesized_units non autorisé/,
    mapping: null
  },
  {
    name: "unité non objet",
    mutate: manifest => {
      manifest.narration_units[0] = "s01-g01";
    },
    gate: /narration_units\[0\]: unité absente ou invalide/,
    mapping: /narration_units\[0\]: unité absente ou invalide/
  }
];

for (const testCase of tamperCases) {
  await test(`manifeste altéré → FAIL — ${testCase.name}`, () => {
    assert(result, "manifeste valide indisponible");

    assert(
      testCase.gate !== null || testCase.mapping !== null,
      "cas sans échec attendu"
    );

    let manifest;

    if (testCase.build) {
      manifest = testCase.build();
    } else {
      manifest = structuredClone(result.data);
      testCase.mutate(manifest);
    }

    checkGate(
      "Voice Gate",
      validateVoiceManifest(manifest),
      testCase.gate
    );

    checkGate(
      "Script Mapping Gate",
      validateVoiceManifestMapping(manifest, buildScript()),
      testCase.mapping
    );
  });
}

await test("Script Mapping Gate : script source absent → FAIL", () => {
  checkGate(
    "Script Mapping Gate",
    validateVoiceManifestMapping(
      structuredClone(result.data),
      undefined
    ),
    /Script source absent ou invalide/
  );
});

await test("Script Mapping Gate : segment source ajouté après coup → FAIL", () => {
  const source = buildScript();

  source.sections[1].segments.push(
    structuredClone(source.sections[1].segments[0])
  );

  checkGate(
    "Script Mapping Gate",
    validateVoiceManifestMapping(
      structuredClone(result.data),
      source
    ),
    /unité manquante : 2 unités pour 3 segments/
  );
});

await test("Script Mapping Gate : voiceover source réparé après coup → FAIL", () => {
  const source = buildScript();

  source.sections[0].segments[0].voiceover =
    "Un voiceover différent de celui qui a été narré.";

  checkGate(
    "Script Mapping Gate",
    validateVoiceManifestMapping(
      structuredClone(result.data),
      source
    ),
    /narration_units\[0\]: text différent du voiceover source/
  );
});

await test("le manifeste valide n'a pas été altéré par les cas", () => {
  checkGate(
    "Voice Gate",
    validateVoiceManifest(result.data),
    null
  );

  checkGate(
    "Script Mapping Gate",
    validateVoiceManifestMapping(result.data, buildScript()),
    null
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 4. Zéro API, zéro réseau ---");

await test("Voice Agent et validateur : aucun import de service, de réseau ou de processus", () => {
  const allowed = [
    "../utils/validate-script.js",
    "../utils/validate-voice-manifest.js"
  ];

  for (const file of [
    "src/agents/voice.js",
    "src/utils/validate-voice-manifest.js"
  ]) {
    const source = fs.readFileSync(
      new URL(`../${file}`, import.meta.url),
      "utf8"
    );

    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      match => match[1]
    );

    assert(
      imports.every(specifier => allowed.includes(specifier)),
      `${file} : imports inattendus ${imports}`
    );

    assert(
      !/\bfetch\s*\(|process\.env|createMessage|import\s*\(|node:fs|child_process/.test(
        source
      ),
      `${file} : accès réseau, disque, environnement ou modèle détecté`
    );
  }
});

await test("fonctionne sans ANTHROPIC_FIXTURES ni clé API", () => {
  assert(
    !("ANTHROPIC_FIXTURES" in process.env) &&
    !("ANTHROPIC_API_KEY" in process.env),
    "ANTHROPIC_FIXTURES ou une clé est présente dans le processus"
  );
});

await test("garde réseau : 0 tentative réseau, 0 appel SDK", () => {
  const attempts = networkGuard.attempts();

  assert(
    attempts.length === 0,
    `tentatives bloquées : ${attempts.join(", ")}`
  );
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API réelle utilisée : NON");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — Voice Agent"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — Voice Agent : manifeste déterministe, gates fail-closed, zéro API"
);

process.exit(0);
