// Smoke de l'Asset Agent — manifeste déterministe, zéro API.
//
// Usage :
//   NO_API=1 node scripts/asset-agent-smoke.js
//
// L'Asset Agent n'utilise ni modèle ni fournisseur : ce smoke ne dépend
// pas de ANTHROPIC_FIXTURES. Le garde réseau est chargé en premier pour
// prouver qu'aucune sortie réseau n'est tentée.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { runAssetAgent } from "../src/agents/asset.js";

import {
  summarizeAssets,
  validateAssetManifest,
  validateAssetManifestMapping
} from "../src/utils/validate-asset-manifest.js";

delete process.env.ANTHROPIC_FIXTURES;
delete process.env.ANTHROPIC_API_KEY;

const TITLE =
  "Pourquoi 95 % de l'Australie est presque vide ?";

function shot(order, durationSeconds, description, query, type, refs) {
  return {
    order,
    duration_seconds: durationSeconds,
    visual_description: description,
    asset_query: query,
    asset_type: type,
    requires_exact_location: false,
    research_fact_refs: refs
  };
}

// Plan visuel canonique : même forme que visual.json produit par le
// pipeline fixtures (2 sections, 5 shots, 40 secondes).
function buildVisual() {
  return {
    title: TITLE,
    sections: [
      {
        title: "L'intérieur aride",
        segments: [
          {
            script_segment_index: 0,
            estimated_seconds: 20,
            shots: [
              shot(
                1,
                8,
                "Vue aérienne d'une région aride australienne.",
                "Australian arid region aerial",
                "stock_video",
                [0]
              ),
              shot(
                2,
                7,
                "Carte de l'Australie mettant en évidence les régions arides et semi-arides.",
                "Australia arid semi-arid regions map",
                "map",
                [0]
              ),
              shot(
                3,
                5,
                "Plan atmosphérique abstrait de transition, sans lieu identifiable.",
                "abstract atmospheric transition background",
                "generated",
                []
              )
            ]
          }
        ]
      },
      {
        title: "Une population concentrée",
        segments: [
          {
            script_segment_index: 0,
            estimated_seconds: 20,
            shots: [
              shot(
                1,
                12,
                "Carte de l'Australie montrant la concentration de la population dans les grandes zones urbaines et côtières.",
                "Australia population concentration urban coastal map",
                "map",
                [1]
              ),
              shot(
                2,
                8,
                "Vue générique d'une grande zone urbaine côtière australienne.",
                "Australian coastal urban area",
                "stock_video",
                [1]
              )
            ]
          }
        ]
      }
    ]
  };
}

const ENVELOPE_KEYS = [
  "agent",
  "mode",
  "data",
  "validation",
  "visual_mapping_validation",
  "usage"
];

const ASSET_KEYS = [
  "asset_id",
  "section_index",
  "segment_index",
  "shot_order",
  "asset_type",
  "duration_seconds",
  "visual_description",
  "asset_query",
  "requires_exact_location",
  "research_fact_refs",
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

function listShots(visual) {
  return visual.sections.flatMap(
    section => section.segments.flatMap(segment => segment.shots)
  );
}

function resummarize(manifest) {
  manifest.summary = summarizeAssets(manifest.assets);
}

console.log("========================================");
console.log(" ASSET AGENT — SMOKE (ZERO API)");
console.log("========================================");

// ------------------------------------------------------------------
console.log("");
console.log("--- 1. Happy path ---");

const visual = buildVisual();
let result = null;

await test("plan visuel canonique → enveloppe validée", async () => {
  result = await runAssetAgent({
    visual,
    testMode: true
  });

  assert(
    isDeepStrictEqual(Object.keys(result), ENVELOPE_KEYS),
    `clés d'enveloppe : ${Object.keys(result)}`
  );

  assert(
    result.agent === "asset" &&
    result.mode === "test" &&
    result.usage === null,
    "agent / mode / usage inattendus"
  );

  assert(
    result.validation.valid === true &&
    result.validation.errors.length === 0,
    "Asset Gate : PASS attendu"
  );

  assert(
    result.visual_mapping_validation.valid === true &&
    result.visual_mapping_validation.errors.length === 0,
    "Visual Mapping Gate : PASS attendu"
  );
});

await test("un asset par shot, dans l'ordre source, IDs attendus", () => {
  const { assets } = result.data;

  assert(assets.length === 5, `assets : ${assets.length}`);

  assert(
    isDeepStrictEqual(
      assets.map(asset => asset.asset_id),
      [
        "s01-g01-sh01",
        "s01-g01-sh02",
        "s01-g01-sh03",
        "s02-g01-sh01",
        "s02-g01-sh02"
      ]
    ),
    `asset_id : ${assets.map(asset => asset.asset_id)}`
  );

  assert(
    isDeepStrictEqual(
      assets.map(asset => [
        asset.section_index,
        asset.segment_index,
        asset.shot_order
      ]),
      [[0, 0, 1], [0, 0, 2], [0, 0, 3], [1, 0, 1], [1, 0, 2]]
    ),
    "positions inattendues"
  );
});

await test("champs recopiés à l'identique, status unresolved, aucun champ en plus", () => {
  const shots = listShots(visual);

  result.data.assets.forEach((asset, index) => {
    const source = shots[index];

    assert(
      isDeepStrictEqual(Object.keys(asset), ASSET_KEYS),
      `assets[${index}] : clés ${Object.keys(asset)}`
    );

    assert(
      asset.asset_type === source.asset_type &&
      asset.duration_seconds === source.duration_seconds &&
      asset.visual_description === source.visual_description &&
      asset.asset_query === source.asset_query &&
      asset.requires_exact_location ===
        source.requires_exact_location &&
      isDeepStrictEqual(
        asset.research_fact_refs,
        source.research_fact_refs
      ),
      `assets[${index}] : copie infidèle`
    );

    assert(
      asset.status === "unresolved",
      `assets[${index}] : status=${asset.status}`
    );
  });

  assert(result.data.title === TITLE, "title inattendu");

  assert(
    !/https?:\/\//i.test(JSON.stringify(result.data)),
    "le manifeste contient une URL"
  );
});

await test("summary correcte", () => {
  assert(
    isDeepStrictEqual(result.data.summary, {
      total_assets: 5,
      total_duration_seconds: 40,
      by_type: {
        stock_video: 2,
        map: 2,
        graphic: 0,
        archive: 0,
        generated: 1
      }
    }),
    `summary : ${JSON.stringify(result.data.summary)}`
  );
});

await test("déterminisme : deux exécutions identiques → même résultat", async () => {
  const first = await runAssetAgent({
    visual: buildVisual(),
    testMode: true
  });

  const second = await runAssetAgent({
    visual: buildVisual(),
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

await test("le plan visuel source n'est ni modifié ni partagé", async () => {
  const source = buildVisual();

  const output = await runAssetAgent({
    visual: source,
    testMode: true
  });

  assert(
    isDeepStrictEqual(source, buildVisual()),
    "le plan visuel source a été modifié"
  );

  output.data.assets[0].research_fact_refs.push(99);

  assert(
    isDeepStrictEqual(source, buildVisual()),
    "research_fact_refs est partagé avec la source"
  );
});

await test("mode full et segments multiples", async () => {
  const source = buildVisual();

  source.sections[0].segments.push({
    script_segment_index: 1,
    estimated_seconds: 6,
    shots: [
      shot(
        1,
        6,
        "Vue aérienne d'une région aride australienne.",
        "Australian arid region aerial",
        "archive",
        []
      )
    ]
  });

  const output = await runAssetAgent({ visual: source });

  assert(output.mode === "full", `mode=${output.mode}`);

  assert(
    isDeepStrictEqual(
      output.data.assets.map(asset => asset.asset_id),
      [
        "s01-g01-sh01",
        "s01-g01-sh02",
        "s01-g01-sh03",
        "s01-g02-sh01",
        "s02-g01-sh01",
        "s02-g01-sh02"
      ]
    ),
    `asset_id : ${output.data.assets.map(asset => asset.asset_id)}`
  );

  assert(
    output.data.summary.total_duration_seconds === 46 &&
    output.data.summary.by_type.archive === 1,
    "summary inattendue"
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 2. Fail closed — entrée de l'agent ---");

const invalidInputs = [
  [
    "entrée absente",
    () => undefined,
    /^Asset Agent : plan visuel source invalide\. Visual Director dossier absent ou invalide/
  ],
  [
    "entrée null",
    () => null,
    /^Asset Agent : plan visuel source invalide\./
  ],
  [
    "entrée non objet",
    () => "visual.json",
    /^Asset Agent : plan visuel source invalide\./
  ],
  [
    "objet vide",
    () => ({}),
    /^Asset Agent : plan visuel source invalide\. title manquant/
  ],
  [
    "sections vides",
    () => ({ title: TITLE, sections: [] }),
    /plan visuel source invalide\..*sections doit être un tableau non vide/
  ],
  [
    "shot sans asset_query",
    () => {
      const source = buildVisual();
      delete source.sections[0].segments[0].shots[0].asset_query;
      return source;
    },
    /plan visuel source invalide\..*asset_query manquant/
  ],
  [
    "asset_type hors liste dans la source",
    () => {
      const source = buildVisual();
      source.sections[0].segments[0].shots[0].asset_type = "photo";
      return source;
    },
    /plan visuel source invalide\..*asset_type invalide/
  ],
  [
    "durées des shots incohérentes avec le segment",
    () => {
      const source = buildVisual();
      source.sections[0].segments[0].shots[0].duration_seconds = 30;
      return source;
    },
    /plan visuel source invalide\..*durée totale des shots/
  ],
  [
    "research_fact_refs non tableau dans la source",
    () => {
      const source = buildVisual();
      source.sections[0].segments[0].shots[0].research_fact_refs = 0;
      return source;
    },
    /plan visuel source invalide\..*research_fact_refs doit être un tableau/
  ],
  [
    "order dupliqué dans un segment → asset_id dupliqué",
    () => {
      const source = buildVisual();
      source.sections[0].segments[0].shots[1].order = 1;
      return source;
    },
    /^Asset Agent : manifeste rejeté par le Asset Gate\..*asset_id dupliqué s01-g01-sh01/
  ],
  [
    "URL dans asset_query de la source",
    () => {
      const source = buildVisual();
      source.sections[0].segments[0].shots[0].asset_query =
        "https://exemple.invalid/video";
      return source;
    },
    /^Asset Agent : manifeste rejeté par le Asset Gate\..*asset_query contient une URL/
  ]
];

for (const [name, build, pattern] of invalidInputs) {
  await test(`entrée invalide → FAIL — ${name}`, async () => {
    await expectReject(
      () => runAssetAgent({
        visual: build(),
        testMode: true
      }),
      pattern
    );
  });
}

// ------------------------------------------------------------------
console.log("");
console.log("--- 3. Fail closed — Asset Gate et Visual Mapping Gate ---");

// Chaque cas altère une copie du manifeste valide.
// gate / mapping : motif d'erreur attendu, ou null si le gate doit passer.
const tamperCases = [
  {
    name: "manifeste absent",
    build: () => undefined,
    gate: /Asset manifest absent ou invalide/,
    mapping: /Asset manifest absent ou invalide/
  },
  {
    name: "assets vide",
    mutate: manifest => {
      manifest.assets = [];
    },
    gate: /assets doit être un tableau non vide/,
    mapping: /asset manquant : 0 assets pour 5 shots/
  },
  {
    name: "title absent",
    mutate: manifest => {
      delete manifest.title;
    },
    gate: /manifest: champ title manquant/,
    mapping: /title différent du plan visuel source/
  },
  {
    name: "title altéré",
    mutate: manifest => {
      manifest.title = "Un autre titre";
    },
    gate: null,
    mapping: /title différent du plan visuel source/
  },
  {
    name: "asset manquant (summary non recalculée)",
    mutate: manifest => {
      manifest.assets.pop();
    },
    gate: /summary: total_assets incorrect/,
    mapping: /asset manquant : 4 assets pour 5 shots/
  },
  {
    name: "asset manquant (summary recalculée)",
    mutate: manifest => {
      manifest.assets.pop();
      resummarize(manifest);
    },
    gate: null,
    mapping: /asset manquant : 4 assets pour 5 shots/
  },
  {
    name: "asset manquant au milieu",
    mutate: manifest => {
      manifest.assets.splice(1, 1);
      resummarize(manifest);
    },
    gate: null,
    mapping: /assets\[1\]: position différente du shot source/
  },
  {
    name: "asset supplémentaire",
    mutate: manifest => {
      manifest.assets.push({
        ...manifest.assets[4],
        asset_id: "s02-g01-sh03",
        shot_order: 3
      });
      resummarize(manifest);
    },
    gate: null,
    mapping: /asset supplémentaire : 6 assets pour 5 shots/
  },
  {
    name: "asset_id dupliqué",
    mutate: manifest => {
      manifest.assets.push({ ...manifest.assets[4] });
      resummarize(manifest);
    },
    gate: /assets\[5\]: asset_id dupliqué s02-g01-sh02/,
    mapping: /asset supplémentaire/
  },
  {
    name: "asset_id mal formé",
    mutate: manifest => {
      manifest.assets[0].asset_id = "asset-1";
    },
    gate: /assets\[0\]: asset_id incohérent/,
    mapping: null
  },
  {
    name: "asset_id d'une autre position",
    mutate: manifest => {
      manifest.assets[0].asset_id = "s03-g01-sh01";
    },
    gate: /assets\[0\]: asset_id incohérent/,
    mapping: null
  },
  {
    name: "indices incohérents",
    mutate: manifest => {
      manifest.assets[3].section_index = 0;
      manifest.assets[3].asset_id = "s01-g01-sh01";
    },
    gate: /asset_id dupliqué s01-g01-sh01/,
    mapping: /assets\[3\]: position différente du shot source/
  },
  {
    name: "section_index négatif",
    mutate: manifest => {
      manifest.assets[0].section_index = -1;
    },
    gate: /assets\[0\]: section_index invalide/,
    mapping: /assets\[0\]: position différente du shot source/
  },
  {
    name: "shot_order incohérent",
    mutate: manifest => {
      manifest.assets[2].shot_order = 4;
      manifest.assets[2].asset_id = "s01-g01-sh04";
    },
    gate: null,
    mapping: /assets\[2\]: position différente du shot source/
  },
  {
    name: "ordre inversé",
    mutate: manifest => {
      [manifest.assets[0], manifest.assets[1]] =
        [manifest.assets[1], manifest.assets[0]];
    },
    gate: /ordre section\/segment\/shot non strictement croissant/,
    mapping: /assets\[0\]: position différente du shot source/
  },
  {
    name: "mauvais asset_type (hors liste)",
    mutate: manifest => {
      manifest.assets[0].asset_type = "photo";
    },
    gate: /assets\[0\]: asset_type invalide/,
    mapping: /assets\[0\]: asset_type différent du shot source/
  },
  {
    name: "mauvais asset_type (autorisé mais différent de la source)",
    mutate: manifest => {
      manifest.assets[0].asset_type = "archive";
      resummarize(manifest);
    },
    gate: null,
    mapping: /assets\[0\]: asset_type différent du shot source/
  },
  {
    name: "mauvais status",
    mutate: manifest => {
      manifest.assets[0].status = "resolved";
    },
    gate: /assets\[0\]: status doit être "unresolved"/,
    mapping: null
  },
  {
    name: "status absent",
    mutate: manifest => {
      delete manifest.assets[0].status;
    },
    gate: /assets\[0\]: champ status manquant/,
    mapping: null
  },
  {
    name: "visual_description altérée",
    mutate: manifest => {
      manifest.assets[0].visual_description =
        "Vue aérienne du désert australien avec des tons rouges et ocres caractéristiques de l'Outback.";
    },
    gate: null,
    mapping: /assets\[0\]: visual_description différent du shot source/
  },
  {
    name: "visual_description vide",
    mutate: manifest => {
      manifest.assets[0].visual_description = "  ";
    },
    gate: /assets\[0\]: visual_description manquant/,
    mapping: /assets\[0\]: visual_description différent du shot source/
  },
  {
    name: "asset_query altérée",
    mutate: manifest => {
      manifest.assets[0].asset_query =
        "Australian Outback red ochre desert aerial";
    },
    gate: null,
    mapping: /assets\[0\]: asset_query différent du shot source/
  },
  {
    name: "asset_query altérée d'une simple espace",
    mutate: manifest => {
      manifest.assets[0].asset_query += " ";
    },
    gate: null,
    mapping: /assets\[0\]: asset_query différent du shot source/
  },
  {
    name: "duration altérée (summary non recalculée)",
    mutate: manifest => {
      manifest.assets[0].duration_seconds = 9;
    },
    gate: /summary: total_duration_seconds incorrect/,
    mapping: /assets\[0\]: duration_seconds différent du shot source/
  },
  {
    name: "duration altérée (summary recalculée)",
    mutate: manifest => {
      manifest.assets[0].duration_seconds = 9;
      resummarize(manifest);
    },
    gate: null,
    mapping: /assets\[0\]: duration_seconds différent du shot source/
  },
  {
    name: "duration invalide",
    mutate: manifest => {
      manifest.assets[0].duration_seconds = 0;
    },
    gate: /assets\[0\]: duration_seconds invalide/,
    mapping: /assets\[0\]: duration_seconds différent du shot source/
  },
  {
    name: "requires_exact_location altéré",
    mutate: manifest => {
      manifest.assets[0].requires_exact_location = true;
    },
    gate: null,
    mapping: /assets\[0\]: requires_exact_location différent du shot source/
  },
  {
    name: "requires_exact_location non booléen",
    mutate: manifest => {
      manifest.assets[0].requires_exact_location = "false";
    },
    gate: /assets\[0\]: requires_exact_location doit être booléen/,
    mapping: /assets\[0\]: requires_exact_location différent du shot source/
  },
  {
    name: "research_fact_refs altérés",
    mutate: manifest => {
      manifest.assets[0].research_fact_refs = [0, 1];
    },
    gate: null,
    mapping: /assets\[0\]: research_fact_refs différent du shot source/
  },
  {
    name: "research_fact_refs vidés",
    mutate: manifest => {
      manifest.assets[0].research_fact_refs = [];
    },
    gate: null,
    mapping: /assets\[0\]: research_fact_refs différent du shot source/
  },
  {
    name: "research_fact_refs non tableau",
    mutate: manifest => {
      manifest.assets[0].research_fact_refs = 0;
    },
    gate: /assets\[0\]: research_fact_refs doit être un tableau/,
    mapping: /assets\[0\]: research_fact_refs différent du shot source/
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
    name: "summary fausse : total_assets",
    mutate: manifest => {
      manifest.summary.total_assets = 4;
    },
    gate: /summary: total_assets incorrect/,
    mapping: null
  },
  {
    name: "summary fausse : total_duration_seconds",
    mutate: manifest => {
      manifest.summary.total_duration_seconds = 41;
    },
    gate: /summary: total_duration_seconds incorrect/,
    mapping: null
  },
  {
    name: "summary fausse : by_type",
    mutate: manifest => {
      manifest.summary.by_type.map = 3;
    },
    gate: /summary: by_type incorrect/,
    mapping: null
  },
  {
    name: "summary fausse : by_type incomplet",
    mutate: manifest => {
      delete manifest.summary.by_type.graphic;
    },
    gate: /summary: by_type incorrect/,
    mapping: null
  },
  {
    name: "URL injectée (champ source_url)",
    mutate: manifest => {
      manifest.assets[0].source_url =
        "https://exemple.invalid/video.mp4";
    },
    gate: /assets\[0\]: champ source_url non autorisé/,
    mapping: null
  },
  {
    name: "URL injectée dans asset_query",
    mutate: manifest => {
      manifest.assets[0].asset_query =
        "https://exemple.invalid/video.mp4";
    },
    gate: /assets\[0\]: asset_query contient une URL/,
    mapping: /assets\[0\]: asset_query différent du shot source/
  },
  {
    name: "fournisseur injecté (champ provider)",
    mutate: manifest => {
      manifest.assets[0].provider = "pexels";
    },
    gate: /assets\[0\]: champ provider non autorisé/,
    mapping: null
  },
  {
    name: "chemin fichier injecté (champ file)",
    mutate: manifest => {
      manifest.assets[0].file = "output/asset.mp4";
    },
    gate: /assets\[0\]: champ file non autorisé/,
    mapping: null
  },
  {
    name: "champ racine non autorisé",
    mutate: manifest => {
      manifest.sourcing = "manual";
    },
    gate: /manifest: champ sourcing non autorisé/,
    mapping: null
  },
  {
    name: "champ summary non autorisé",
    mutate: manifest => {
      manifest.summary.resolved_assets = 5;
    },
    gate: /summary: champ resolved_assets non autorisé/,
    mapping: null
  },
  {
    name: "asset non objet",
    mutate: manifest => {
      manifest.assets[0] = "s01-g01-sh01";
    },
    gate: /assets\[0\]: asset absent ou invalide/,
    mapping: /assets\[0\]: asset absent ou invalide/
  }
];

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
      "Asset Gate",
      validateAssetManifest(manifest),
      testCase.gate
    );

    checkGate(
      "Visual Mapping Gate",
      validateAssetManifestMapping(manifest, buildVisual()),
      testCase.mapping
    );
  });
}

await test("Visual Mapping Gate : plan visuel source absent → FAIL", () => {
  checkGate(
    "Visual Mapping Gate",
    validateAssetManifestMapping(
      structuredClone(result.data),
      undefined
    ),
    /Plan visuel source absent ou invalide/
  );
});

await test("Visual Mapping Gate : shot source ajouté après coup → FAIL", () => {
  const source = buildVisual();

  source.sections[1].segments[0].shots.push(
    shot(
      3,
      4,
      "Plan atmosphérique abstrait de transition, sans lieu identifiable.",
      "abstract atmospheric transition background",
      "generated",
      []
    )
  );

  checkGate(
    "Visual Mapping Gate",
    validateAssetManifestMapping(
      structuredClone(result.data),
      source
    ),
    /asset manquant : 5 assets pour 6 shots/
  );
});

await test("le manifeste valide n'a pas été altéré par les cas", () => {
  checkGate(
    "Asset Gate",
    validateAssetManifest(result.data),
    null
  );

  checkGate(
    "Visual Mapping Gate",
    validateAssetManifestMapping(result.data, buildVisual()),
    null
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 4. Zéro API, zéro réseau ---");

await test("Asset Agent et validateur : aucun import de service, de réseau ou de processus", () => {
  for (const file of [
    "src/agents/asset.js",
    "src/utils/validate-asset-manifest.js"
  ]) {
    const source = fs.readFileSync(
      new URL(`../${file}`, import.meta.url),
      "utf8"
    );

    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      match => match[1]
    );

    const allowed = [
      "node:util",
      "../utils/validate-visual-director.js",
      "../utils/validate-asset-manifest.js"
    ];

    assert(
      imports.every(specifier => allowed.includes(specifier)),
      `${file} : imports inattendus ${imports}`
    );

    assert(
      !/\bfetch\s*\(|process\.env|createMessage|import\s*\(/.test(
        source
      ),
      `${file} : accès réseau, environnement ou modèle détecté`
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
    "RESULTAT GLOBAL : FAIL — Asset Agent"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — Asset Agent : manifeste déterministe, gates fail-closed, zéro API"
);

process.exit(0);
