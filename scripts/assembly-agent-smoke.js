// Smoke de l'Assembly Agent — plan de montage déterministe, zéro API.
//
// Usage :
//   NO_API=1 node scripts/assembly-agent-smoke.js
//
// L'Assembly Agent ne rend rien : ni FFmpeg, ni fichier média. Le garde
// réseau est chargé en premier pour prouver qu'aucune sortie réseau
// n'est tentée.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { runAssetAgent } from "../src/agents/asset.js";
import { runVoiceAgent } from "../src/agents/voice.js";
import { runAssemblyAgent } from "../src/agents/assembly.js";

import {
  summarizeAssets
} from "../src/utils/validate-asset-manifest.js";

import {
  summarizeNarration
} from "../src/utils/validate-voice-manifest.js";

import {
  validateAssemblyPlan,
  validateAssemblySourceMapping
} from "../src/utils/validate-assembly-plan.js";

import {
  CANONICAL_TITLE,
  buildScript,
  buildTarget,
  buildVisual
} from "./canonical-artifacts.js";

delete process.env.ANTHROPIC_FIXTURES;
delete process.env.ANTHROPIC_API_KEY;

const ENVELOPE_KEYS = [
  "agent",
  "mode",
  "data",
  "validation",
  "source_mapping_validation",
  "usage"
];

const PLAN_KEYS = [
  "title",
  "output",
  "video_track",
  "audio_track",
  "summary",
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

// Manifestes sources produits par les vrais agents 4 et 5.
async function buildSources(visual = buildVisual(), script = buildScript()) {
  const assets = await runAssetAgent({ visual, testMode: true });
  const voice = await runVoiceAgent({ script, testMode: true });

  return {
    assets: assets.data,
    voice: voice.data,
    target: buildTarget().video
  };
}

console.log("========================================");
console.log(" ASSEMBLY AGENT — SMOKE (ZERO API)");
console.log("========================================");

// ------------------------------------------------------------------
console.log("");
console.log("--- 1. Happy path ---");

const sources = await buildSources();
let result = null;

await test("manifestes canoniques → enveloppe validée", async () => {
  result = await runAssemblyAgent({
    ...structuredClone(sources),
    testMode: true
  });

  assert(
    isDeepStrictEqual(Object.keys(result), ENVELOPE_KEYS),
    `clés d'enveloppe : ${Object.keys(result)}`
  );

  assert(
    result.agent === "assembly" &&
    result.mode === "test" &&
    result.usage === null,
    "agent / mode / usage inattendus"
  );

  assert(
    result.validation.valid === true &&
    result.validation.errors.length === 0,
    "Assembly Gate : PASS attendu"
  );

  assert(
    result.source_mapping_validation.valid === true &&
    result.source_mapping_validation.errors.length === 0,
    "Source Mapping Gate : PASS attendu"
  );
});

await test("piste vidéo : chaque asset une fois, dans l'ordre, sans trou ni chevauchement", () => {
  assert(
    isDeepStrictEqual(result.data.video_track, [
      {
        asset_id: "s01-g01-sh01",
        unit_id: "s01-g01",
        start_seconds: 0,
        end_seconds: 8,
        duration_seconds: 8
      },
      {
        asset_id: "s01-g01-sh02",
        unit_id: "s01-g01",
        start_seconds: 8,
        end_seconds: 15,
        duration_seconds: 7
      },
      {
        asset_id: "s01-g01-sh03",
        unit_id: "s01-g01",
        start_seconds: 15,
        end_seconds: 20,
        duration_seconds: 5
      },
      {
        asset_id: "s02-g01-sh01",
        unit_id: "s02-g01",
        start_seconds: 20,
        end_seconds: 32,
        duration_seconds: 12
      },
      {
        asset_id: "s02-g01-sh02",
        unit_id: "s02-g01",
        start_seconds: 32,
        end_seconds: 40,
        duration_seconds: 8
      }
    ]),
    `video_track : ${JSON.stringify(result.data.video_track)}`
  );
});

await test("piste audio : chaque unité une fois, alignée sur ses images", () => {
  assert(
    isDeepStrictEqual(result.data.audio_track, [
      {
        unit_id: "s01-g01",
        start_seconds: 0,
        end_seconds: 20,
        duration_seconds: 20
      },
      {
        unit_id: "s02-g01",
        start_seconds: 20,
        end_seconds: 40,
        duration_seconds: 20
      }
    ]),
    `audio_track : ${JSON.stringify(result.data.audio_track)}`
  );
});

await test("sortie, summary, status et contrat fermé", () => {
  assert(
    isDeepStrictEqual(Object.keys(result.data), PLAN_KEYS),
    `clés du plan : ${Object.keys(result.data)}`
  );

  assert(
    result.data.title === CANONICAL_TITLE,
    "title inattendu"
  );

  assert(
    isDeepStrictEqual(result.data.output, {
      width: 3840,
      height: 2160,
      fps: 30,
      aspect_ratio: "16:9"
    }),
    `output : ${JSON.stringify(result.data.output)}`
  );

  assert(
    isDeepStrictEqual(result.data.summary, {
      total_clips: 5,
      total_units: 2,
      total_duration_seconds: 40
    }),
    `summary : ${JSON.stringify(result.data.summary)}`
  );

  assert(
    result.data.status === "unrendered",
    `status=${result.data.status}`
  );
});

await test("aucun rendu : ni fichier, ni codec, ni sous-titre, ni transition", () => {
  assert(
    !/\.mp4|\.mov|\.mp3|\.wav|codec|ffmpeg|subtitle|caption|transition|overlay|output_file|https?:\/\//i.test(
      JSON.stringify(result)
    ),
    "le plan contient une référence de rendu"
  );
});

await test("déterminisme : deux exécutions identiques → même résultat", async () => {
  const first = await runAssemblyAgent({
    ...(await buildSources()),
    testMode: true
  });

  const second = await runAssemblyAgent({
    ...(await buildSources()),
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

await test("les manifestes sources ne sont pas modifiés", async () => {
  const input = structuredClone(sources);

  await runAssemblyAgent({
    ...input,
    testMode: true
  });

  assert(
    isDeepStrictEqual(input, sources),
    "un manifeste source a été modifié"
  );
});

await test("mode full, segments multiples et durées décimales", async () => {
  const visual = buildVisual();
  const script = buildScript();

  visual.sections[0].segments.push({
    script_segment_index: 1,
    estimated_seconds: 0.3,
    shots: [
      {
        ...structuredClone(visual.sections[0].segments[0].shots[0]),
        order: 1,
        duration_seconds: 0.1
      },
      {
        ...structuredClone(visual.sections[0].segments[0].shots[0]),
        order: 2,
        duration_seconds: 0.2
      }
    ]
  });

  script.sections[0].segments.push({
    ...structuredClone(script.sections[0].segments[0]),
    estimated_seconds: 0.3
  });

  const output = await runAssemblyAgent(
    await buildSources(visual, script)
  );

  assert(output.mode === "full", `mode=${output.mode}`);

  assert(
    isDeepStrictEqual(
      output.data.video_track.map(clip => [
        clip.asset_id,
        clip.start_seconds,
        clip.end_seconds
      ]),
      [
        ["s01-g01-sh01", 0, 8],
        ["s01-g01-sh02", 8, 15],
        ["s01-g01-sh03", 15, 20],
        ["s01-g02-sh01", 20, 20.1],
        ["s01-g02-sh02", 20.1, 20.3],
        ["s02-g01-sh01", 20.3, 32.3],
        ["s02-g01-sh02", 32.3, 40.3]
      ]
    ),
    `video_track : ${JSON.stringify(output.data.video_track)}`
  );

  assert(
    isDeepStrictEqual(
      output.data.audio_track.map(unit => [
        unit.unit_id,
        unit.start_seconds,
        unit.end_seconds
      ]),
      [
        ["s01-g01", 0, 20],
        ["s01-g02", 20, 20.3],
        ["s02-g01", 20.3, 40.3]
      ]
    ) &&
    output.data.summary.total_duration_seconds === 40.3,
    `audio_track : ${JSON.stringify(output.data.audio_track)}`
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 2. Fail closed — entrées de l'agent ---");

function mutated(mutate) {
  const input = structuredClone(sources);

  mutate(input);

  return input;
}

const invalidInputs = [
  [
    "manifeste d'assets absent",
    () => mutated(input => {
      delete input.assets;
    }),
    /^Assembly Agent : manifeste d'assets source invalide\. Asset manifest absent ou invalide/
  ],
  [
    "manifeste voice absent",
    () => mutated(input => {
      delete input.voice;
    }),
    /^Assembly Agent : manifeste voice source invalide\. Voice manifest absent ou invalide/
  ],
  [
    "enveloppe assets passée à la place de data",
    () => mutated(input => {
      input.assets = {
        agent: "asset",
        mode: "test",
        data: input.assets
      };
    }),
    /manifeste d'assets source invalide\./
  ],
  [
    "manifeste d'assets invalide (status resolved)",
    () => mutated(input => {
      input.assets.assets[0].status = "resolved";
    }),
    /manifeste d'assets source invalide\..*status doit être "unresolved"/
  ],
  [
    "manifeste d'assets avec champ inconnu",
    () => mutated(input => {
      input.assets.assets[0].file = "asset.mp4";
    }),
    /manifeste d'assets source invalide\..*champ file non autorisé/
  ],
  [
    "manifeste voice invalide (texte vide)",
    () => mutated(input => {
      input.voice.narration_units[0].text = "";
    }),
    /manifeste voice source invalide\..*text manquant/
  ],
  [
    "manifeste voice avec champ inconnu",
    () => mutated(input => {
      input.voice.narration_units[0].audio_file = "a.mp3";
    }),
    /manifeste voice source invalide\..*champ audio_file non autorisé/
  ],
  [
    "cible de sortie absente",
    () => mutated(input => {
      delete input.target;
    }),
    /^Assembly Agent : spécification de sortie invalide\. cible de production absent ou invalide/
  ],
  [
    "cible de sortie sans fps",
    () => mutated(input => {
      delete input.target.fps;
    }),
    /spécification de sortie invalide\..*champ fps manquant/
  ],
  [
    "cible de sortie avec codec",
    () => mutated(input => {
      input.target.codec = "h264";
    }),
    /spécification de sortie invalide\..*champ codec non autorisé/
  ],
  [
    "cible de sortie : ratio incohérent",
    () => mutated(input => {
      input.target.aspect_ratio = "4:3";
    }),
    /spécification de sortie invalide\..*aspect_ratio incohérent avec width\/height/
  ],
  [
    "cible de sortie : largeur invalide",
    () => mutated(input => {
      input.target.width = 0;
    }),
    /spécification de sortie invalide\..*width invalide/
  ],
  [
    "narration plus longue d'une seconde que les images",
    () => mutated(input => {
      input.voice.narration_units[0].estimated_seconds = 21;
      input.voice.summary = summarizeNarration(
        input.voice.narration_units
      );
    }),
    /^Assembly Agent : plan rejeté par le Assembly Gate\..*fenêtre vidéo 0s–20s différente de la fenêtre narration 0s–21s/
  ],
  [
    "narration plus courte d'une seconde que les images",
    () => mutated(input => {
      input.voice.narration_units[1].estimated_seconds = 19;
      input.voice.summary = summarizeNarration(
        input.voice.narration_units
      );
    }),
    /plan rejeté par le Assembly Gate\..*fenêtre vidéo 20s–40s différente de la fenêtre narration 20s–39s/
  ],
  [
    "images plus longues d'une seconde que la narration",
    () => mutated(input => {
      input.assets.assets[0].duration_seconds = 9;
      input.assets.summary = summarizeAssets(input.assets.assets);
    }),
    /plan rejeté par le Assembly Gate\..*fenêtre vidéo 0s–21s différente de la fenêtre narration 0s–20s/
  ],
  [
    "unité de narration sans aucune image",
    () => mutated(input => {
      input.assets.assets = input.assets.assets.slice(0, 3);
      input.assets.summary = summarizeAssets(input.assets.assets);
    }),
    /plan rejeté par le Assembly Gate\..*aucune image pour l'unité s02-g01/
  ],
  [
    "images sans unité de narration",
    () => mutated(input => {
      input.voice.narration_units.pop();
      input.voice.summary = summarizeNarration(
        input.voice.narration_units
      );
    }),
    /plan rejeté par le Assembly Gate\..*unit_id s02-g01 absent de audio_track/
  ],
  [
    "titres différents entre assets et voice",
    () => mutated(input => {
      input.voice.title = "Un autre titre";
    }),
    /^Assembly Agent : plan rejeté par le Source Mapping Gate\..*title différent du manifeste voice source/
  ]
];

for (const [name, build, pattern] of invalidInputs) {
  await test(`entrée invalide → FAIL — ${name}`, async () => {
    await expectReject(
      () => runAssemblyAgent({
        ...build(),
        testMode: true
      }),
      pattern
    );
  });
}

// ------------------------------------------------------------------
console.log("");
console.log("--- 3. Fail closed — Assembly Gate et Source Mapping Gate ---");

// Décale un élément de piste sans casser end = start + duration.
function shift(item, seconds) {
  item.start_seconds += seconds;
  item.end_seconds += seconds;
}

// Chaque cas altère une copie du plan valide.
// gate / mapping : motif d'erreur attendu, ou null si le gate doit passer.
const tamperCases = [
  {
    name: "plan absent",
    build: () => undefined,
    gate: /Assembly plan absent ou invalide/,
    mapping: /Assembly plan absent ou invalide/
  },
  {
    name: "video_track vide",
    mutate: plan => {
      plan.video_track = [];
    },
    gate: /video_track doit être un tableau non vide/,
    mapping: /clip manquant : 0 clips pour 5 attendus/
  },
  {
    name: "audio_track vide",
    mutate: plan => {
      plan.audio_track = [];
    },
    gate: /audio_track doit être un tableau non vide/,
    mapping: /unité manquante : 0 unités pour 2 attendus/
  },
  {
    name: "title altéré",
    mutate: plan => {
      plan.title = "Un autre titre";
    },
    gate: null,
    mapping: /title différent du manifeste d'assets source/
  },
  {
    name: "title absent",
    mutate: plan => {
      delete plan.title;
    },
    gate: /plan: champ title manquant/,
    mapping: /title différent du manifeste d'assets source/
  },
  {
    name: "dernier clip manquant",
    mutate: plan => {
      plan.video_track.pop();
    },
    gate: /fenêtre vidéo 20s–32s différente de la fenêtre narration 20s–40s/,
    mapping: /clip manquant : 4 clips pour 5 attendus/
  },
  {
    name: "clip manquant au milieu (trou)",
    mutate: plan => {
      plan.video_track.splice(1, 1);
    },
    gate: /video_track\[1\]: trou entre 8s et 15s/,
    mapping: /clip manquant : 4 clips pour 5 attendus/
  },
  {
    name: "clip supplémentaire",
    mutate: plan => {
      plan.video_track.push({
        asset_id: "s02-g01-sh03",
        unit_id: "s02-g01",
        start_seconds: 40,
        end_seconds: 44,
        duration_seconds: 4
      });
    },
    gate: /fenêtre vidéo 20s–44s différente de la fenêtre narration 20s–40s/,
    mapping: /clip supplémentaire : 6 clips pour 5 attendus/
  },
  {
    name: "asset_id dupliqué",
    mutate: plan => {
      plan.video_track[1].asset_id = "s01-g01-sh01";
    },
    gate: /video_track\[1\]: asset_id dupliqué s01-g01-sh01/,
    mapping: /video_track\[1\]: asset_id différent de l'asset source/
  },
  {
    name: "asset inconnu",
    mutate: plan => {
      plan.video_track[0].asset_id = "s09-g01-sh01";
    },
    gate: null,
    mapping: /video_track\[0\]: asset_id différent de l'asset source/
  },
  {
    name: "ordre des clips inversé",
    mutate: plan => {
      const [first, second] = plan.video_track;

      [first.asset_id, second.asset_id] =
        [second.asset_id, first.asset_id];
    },
    gate: null,
    mapping: /video_track\[0\]: asset_id différent de l'asset source/
  },
  {
    name: "trou dans la piste vidéo",
    mutate: plan => {
      shift(plan.video_track[1], 1);
    },
    gate: /video_track\[1\]: trou entre 8s et 9s/,
    mapping: null
  },
  {
    name: "chevauchement dans la piste vidéo",
    mutate: plan => {
      shift(plan.video_track[1], -1);
    },
    gate: /video_track\[1\]: chevauchement entre 7s et 8s/,
    mapping: null
  },
  {
    name: "piste vidéo ne commençant pas à 0",
    mutate: plan => {
      for (const clip of plan.video_track) {
        shift(clip, 2);
      }
    },
    gate: /video_track\[0\]: la piste doit commencer à 0/,
    mapping: null
  },
  {
    name: "durée de clip altérée",
    mutate: plan => {
      plan.video_track[0].duration_seconds = 9;
      plan.video_track[0].end_seconds = 9;
    },
    gate: /video_track\[1\]: chevauchement entre 8s et 9s/,
    mapping: /video_track\[0\]: duration_seconds différent de l'asset source/
  },
  {
    name: "end_seconds incohérent",
    mutate: plan => {
      plan.video_track[0].end_seconds = 7;
    },
    gate: /video_track\[0\]: end_seconds différent de start_seconds \+ duration_seconds/,
    mapping: null
  },
  {
    name: "durée de clip nulle",
    mutate: plan => {
      plan.video_track[0].duration_seconds = 0;
    },
    gate: /video_track\[0\]: duration_seconds invalide/,
    mapping: /video_track\[0\]: duration_seconds différent de l'asset source/
  },
  {
    name: "clip rattaché à une autre unité",
    mutate: plan => {
      plan.video_track[2].unit_id = "s02-g01";
    },
    gate: /fenêtre vidéo 0s–15s différente de la fenêtre narration 0s–20s/,
    mapping: /video_track\[2\]: unit_id différent du segment de l'asset source/
  },
  {
    name: "clip rattaché à une unité inconnue",
    mutate: plan => {
      plan.video_track[0].unit_id = "s09-g01";
    },
    gate: /video_track\[0\]: unit_id s09-g01 absent de audio_track/,
    mapping: /video_track\[0\]: unit_id différent du segment de l'asset source/
  },
  {
    name: "unité de narration manquante",
    mutate: plan => {
      plan.audio_track.pop();
    },
    gate: /unit_id s02-g01 absent de audio_track/,
    mapping: /unité manquante : 1 unités pour 2 attendus/
  },
  {
    name: "unité de narration supplémentaire",
    mutate: plan => {
      plan.audio_track.push({
        unit_id: "s03-g01",
        start_seconds: 40,
        end_seconds: 45,
        duration_seconds: 5
      });
    },
    gate: /audio_track\[2\]: aucune image pour l'unité s03-g01/,
    mapping: /unité supplémentaire : 3 unités pour 2 attendus/
  },
  {
    name: "unit_id dupliqué dans la piste audio",
    mutate: plan => {
      plan.audio_track[1].unit_id = "s01-g01";
    },
    gate: /audio_track\[1\]: unit_id dupliqué s01-g01/,
    mapping: /audio_track\[1\]: unit_id différent de l'unité source/
  },
  {
    name: "unités de narration inversées",
    mutate: plan => {
      const [first, second] = plan.audio_track;

      [first.unit_id, second.unit_id] =
        [second.unit_id, first.unit_id];
    },
    gate: /ordre ou couverture des unités différent entre video_track et audio_track/,
    mapping: /audio_track\[0\]: unit_id différent de l'unité source/
  },
  {
    name: "durée de narration altérée",
    mutate: plan => {
      plan.audio_track[0].duration_seconds = 21;
      plan.audio_track[0].end_seconds = 21;
    },
    gate: /audio_track\[1\]: chevauchement entre 20s et 21s/,
    mapping: /audio_track\[0\]: duration_seconds différent de l'unité source/
  },
  {
    name: "trou dans la piste audio",
    mutate: plan => {
      shift(plan.audio_track[1], 1);
    },
    gate: /audio_track\[1\]: trou entre 20s et 21s/,
    mapping: null
  },
  {
    name: "output altéré (1080p)",
    mutate: plan => {
      plan.output.width = 1920;
      plan.output.height = 1080;
    },
    gate: null,
    mapping: /output\.width différent de la cible de production/
  },
  {
    name: "output : fps altéré",
    mutate: plan => {
      plan.output.fps = 25;
    },
    gate: null,
    mapping: /output\.fps différent de la cible de production/
  },
  {
    name: "output : ratio incohérent",
    mutate: plan => {
      plan.output.aspect_ratio = "4:3";
    },
    gate: /output: aspect_ratio incohérent avec width\/height/,
    mapping: /output\.aspect_ratio différent de la cible de production/
  },
  {
    name: "output : champ manquant",
    mutate: plan => {
      delete plan.output.fps;
    },
    gate: /output: champ fps manquant/,
    mapping: /output\.fps différent de la cible de production/
  },
  {
    name: "output : codec injecté",
    mutate: plan => {
      plan.output.codec = "h264";
    },
    gate: /output: champ codec non autorisé/,
    mapping: null
  },
  {
    name: "output absent",
    mutate: plan => {
      delete plan.output;
    },
    gate: /output absent ou invalide/,
    mapping: /output\.width différent de la cible de production/
  },
  {
    name: "champ racine inconnu : output_file",
    mutate: plan => {
      plan.output_file = "output/master.mp4";
    },
    gate: /plan: champ output_file non autorisé/,
    mapping: null
  },
  {
    name: "champ racine inconnu : subtitles",
    mutate: plan => {
      plan.subtitles = [];
    },
    gate: /plan: champ subtitles non autorisé/,
    mapping: null
  },
  {
    name: "champ clip inconnu : transition",
    mutate: plan => {
      plan.video_track[0].transition = "fade";
    },
    gate: /video_track\[0\]: champ transition non autorisé/,
    mapping: null
  },
  {
    name: "champ clip inconnu : file",
    mutate: plan => {
      plan.video_track[0].file = "assets/s01.mp4";
    },
    gate: /video_track\[0\]: champ file non autorisé/,
    mapping: null
  },
  {
    name: "champ audio inconnu : audio_file",
    mutate: plan => {
      plan.audio_track[0].audio_file = "voice/s01.mp3";
    },
    gate: /audio_track\[0\]: champ audio_file non autorisé/,
    mapping: null
  },
  {
    name: "mauvais status",
    mutate: plan => {
      plan.status = "rendered";
    },
    gate: /status doit être "unrendered"/,
    mapping: null
  },
  {
    name: "summary absente",
    mutate: plan => {
      delete plan.summary;
    },
    gate: /plan: champ summary manquant/,
    mapping: null
  },
  {
    name: "summary fausse : total_clips",
    mutate: plan => {
      plan.summary.total_clips = 4;
    },
    gate: /summary: total_clips incorrect/,
    mapping: null
  },
  {
    name: "summary fausse : total_units",
    mutate: plan => {
      plan.summary.total_units = 3;
    },
    gate: /summary: total_units incorrect/,
    mapping: null
  },
  {
    name: "summary fausse : total_duration_seconds",
    mutate: plan => {
      plan.summary.total_duration_seconds = 41;
    },
    gate: /summary: total_duration_seconds incorrect/,
    mapping: null
  },
  {
    name: "champ summary inconnu",
    mutate: plan => {
      plan.summary.rendered_seconds = 0;
    },
    gate: /summary: champ rendered_seconds non autorisé/,
    mapping: null
  },
  {
    name: "clip non objet",
    mutate: plan => {
      plan.video_track[0] = "s01-g01-sh01";
    },
    gate: /video_track\[0\]: élément absent ou invalide/,
    mapping: /video_track\[0\]: clip ou asset source invalide/
  }
];

for (const testCase of tamperCases) {
  await test(`plan altéré → FAIL — ${testCase.name}`, () => {
    assert(result, "plan valide indisponible");

    assert(
      testCase.gate !== null || testCase.mapping !== null,
      "cas sans échec attendu"
    );

    let plan;

    if (testCase.build) {
      plan = testCase.build();
    } else {
      plan = structuredClone(result.data);
      testCase.mutate(plan);
    }

    checkGate(
      "Assembly Gate",
      validateAssemblyPlan(plan),
      testCase.gate
    );

    checkGate(
      "Source Mapping Gate",
      validateAssemblySourceMapping(
        plan,
        sources.assets,
        sources.voice,
        sources.target
      ),
      testCase.mapping
    );
  });
}

const missingSources = [
  [
    "manifeste d'assets source absent",
    [undefined, sources.voice, sources.target],
    /Asset manifest source absent ou invalide/
  ],
  [
    "manifeste voice source absent",
    [sources.assets, undefined, sources.target],
    /Voice manifest source absent ou invalide/
  ],
  [
    "cible de sortie absente",
    [sources.assets, sources.voice, undefined],
    /Spécification de sortie cible absente ou invalide/
  ]
];

for (const [name, args, pattern] of missingSources) {
  await test(`Source Mapping Gate : ${name} → FAIL`, () => {
    checkGate(
      "Source Mapping Gate",
      validateAssemblySourceMapping(
        structuredClone(result.data),
        ...args
      ),
      pattern
    );
  });
}

await test("Source Mapping Gate : asset source ajouté après coup → FAIL", () => {
  const assets = structuredClone(sources.assets);

  assets.assets.push({
    ...assets.assets[4],
    asset_id: "s02-g01-sh03",
    shot_order: 3
  });

  checkGate(
    "Source Mapping Gate",
    validateAssemblySourceMapping(
      structuredClone(result.data),
      assets,
      sources.voice,
      sources.target
    ),
    /clip manquant : 5 clips pour 6 attendus/
  );
});

await test("le plan valide n'a pas été altéré par les cas", () => {
  checkGate(
    "Assembly Gate",
    validateAssemblyPlan(result.data),
    null
  );

  checkGate(
    "Source Mapping Gate",
    validateAssemblySourceMapping(
      result.data,
      sources.assets,
      sources.voice,
      sources.target
    ),
    null
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 4. Zéro API, zéro réseau, zéro rendu ---");

await test("Assembly Agent et validateur : aucun import de service, de réseau ou de processus", () => {
  const allowed = [
    "node:util",
    "./validate-voice-manifest.js",
    "../utils/validate-asset-manifest.js",
    "../utils/validate-voice-manifest.js",
    "../utils/validate-assembly-plan.js"
  ];

  for (const file of [
    "src/agents/assembly.js",
    "src/utils/validate-assembly-plan.js"
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
      !/\bfetch\s*\(|process\.env|createMessage|import\s*\(|node:fs|child_process|spawn|exec/.test(
        source
      ),
      `${file} : accès réseau, disque, processus ou modèle détecté`
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
    "RESULTAT GLOBAL : FAIL — Assembly Agent"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — Assembly Agent : timeline déterministe, gates fail-closed, zéro API"
);

process.exit(0);
