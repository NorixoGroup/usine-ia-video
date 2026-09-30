// Smoke du Quality Agent — audit final déterministe, zéro API.
//
// Usage :
//   NO_API=1 node scripts/quality-agent-smoke.js
//
// Le Quality Agent audite les six enveloppes persistées et ne répare
// rien. Il ne rejoue aucun modèle. Le garde réseau est chargé en premier
// pour prouver qu'aucune sortie réseau n'est tentée.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { runQualityAgent } from "../src/agents/quality.js";

import {
  QUALITY_ARTIFACT_NAMES,
  QUALITY_CHECK_IDS,
  validateQualityReport
} from "../src/utils/validate-quality-report.js";

import {
  CANONICAL_TITLE,
  buildArtifacts,
  buildTarget
} from "./canonical-artifacts.js";

delete process.env.ANTHROPIC_FIXTURES;
delete process.env.ANTHROPIC_API_KEY;

const ENVELOPE_KEYS = [
  "agent",
  "mode",
  "data",
  "validation",
  "usage"
];

const REPORT_KEYS = [
  "title",
  "verdict",
  "checks",
  "metrics",
  "media",
  "warnings"
];

const DURATION_WARNING =
  "durée totale 40s hors de la cible 25–30 min — non bloquant en mode test";

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

const REJECTION_PREFIX = "Quality Agent : audit rejeté. ";

// Motif : l'audit est rejeté et le contrôle `id` porte l'erreur attendue.
function rejected(id, detail) {
  return {
    test(message) {
      if (!message.startsWith(REJECTION_PREFIX)) {
        return false;
      }

      return message
        .slice(REJECTION_PREFIX.length)
        .split(" || ")
        .some(
          block =>
            block.startsWith(`[${id}] `) &&
            block.includes(detail)
        );
    }
  };
}

console.log("========================================");
console.log(" QUALITY AGENT — SMOKE (ZERO API)");
console.log("========================================");

// ------------------------------------------------------------------
console.log("");
console.log("--- 1. Happy path ---");

const artifacts = await buildArtifacts();
let result = null;

await test("six enveloppes canoniques → audit PASS", async () => {
  result = await runQualityAgent({
    artifacts: structuredClone(artifacts),
    target: buildTarget(),
    testMode: true
  });

  assert(
    isDeepStrictEqual(Object.keys(result), ENVELOPE_KEYS),
    `clés d'enveloppe : ${Object.keys(result)}`
  );

  assert(
    result.agent === "quality" &&
    result.mode === "test" &&
    result.usage === null,
    "agent / mode / usage inattendus"
  );

  assert(
    result.validation.valid === true &&
    result.validation.errors.length === 0,
    "Quality Gate : PASS attendu"
  );
});

await test("rapport : contrat fermé, verdict pass, tous les contrôles validés", () => {
  const { data } = result;

  assert(
    isDeepStrictEqual(Object.keys(data), REPORT_KEYS),
    `clés du rapport : ${Object.keys(data)}`
  );

  assert(
    data.title === CANONICAL_TITLE && data.verdict === "pass",
    "title ou verdict inattendus"
  );

  assert(
    isDeepStrictEqual(
      data.checks,
      QUALITY_CHECK_IDS.map(id => ({
        id,
        valid: true,
        errors: []
      }))
    ),
    `checks : ${JSON.stringify(data.checks)}`
  );

  assert(
    isDeepStrictEqual(QUALITY_CHECK_IDS, [
      "envelopes",
      "persisted_verdicts",
      "structure",
      "research_script_mapping",
      "script_visual_mapping",
      "visual_asset_mapping",
      "script_voice_mapping",
      "assembly_source_mapping",
      "titles",
      "durations"
    ]),
    `contrôles déclarés : ${QUALITY_CHECK_IDS}`
  );
});

await test("métriques correctes", () => {
  assert(
    isDeepStrictEqual(result.data.metrics, {
      sections: 2,
      segments: 2,
      shots: 5,
      assets: 5,
      narration_units: 2,
      total_video_seconds: 40,
      total_narration_seconds: 40,
      declared_duration_minutes: 27
    }),
    `metrics : ${JSON.stringify(result.data.metrics)}`
  );
});

await test("périmètre explicite : contrats seuls, aucune vidéo finale rendue", () => {
  assert(
    isDeepStrictEqual(result.data.media, {
      scope: "contracts_only",
      final_video: "not_rendered"
    }),
    `media : ${JSON.stringify(result.data.media)}`
  );
});

await test("mode test : durée hors cible = warning non bloquant", () => {
  assert(
    isDeepStrictEqual(result.data.warnings, [DURATION_WARNING]),
    `warnings : ${JSON.stringify(result.data.warnings)}`
  );
});

await test("déterminisme : deux exécutions identiques → même résultat", async () => {
  const first = await runQualityAgent({
    artifacts: await buildArtifacts(),
    target: buildTarget(),
    testMode: true
  });

  const second = await runQualityAgent({
    artifacts: await buildArtifacts(),
    target: buildTarget(),
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

await test("Quality n'altère ni les artefacts ni la cible (audit sans réparation)", async () => {
  const input = structuredClone(artifacts);
  const target = buildTarget();

  await runQualityAgent({
    artifacts: input,
    target,
    testMode: true
  });

  assert(
    isDeepStrictEqual(input, artifacts),
    "un artefact a été modifié par l'audit"
  );

  assert(
    isDeepStrictEqual(target, buildTarget()),
    "la cible a été modifiée par l'audit"
  );
});

await test("mode full : durée hors cible = FAIL", async () => {
  await expectReject(
    async () => runQualityAgent({
      artifacts: await buildArtifacts({ mode: "full" }),
      target: buildTarget(),
      testMode: false
    }),
    rejected(
      "durations",
      "durée totale 40s hors de la cible 25–30 min"
    )
  );
});

await test("mode full : durée dans la cible = PASS sans warning", async () => {
  const target = buildTarget();

  target.duration_minutes = {
    target: 0.7,
    min: 0.5,
    max: 1
  };

  const output = await runQualityAgent({
    artifacts: await buildArtifacts({ mode: "full" }),
    target,
    testMode: false
  });

  assert(
    output.mode === "full" &&
    output.data.verdict === "pass" &&
    output.data.warnings.length === 0,
    "PASS sans warning attendu"
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 2. Fail closed — entrées de l'agent ---");

await test("artefacts absents → FAIL", async () => {
  await expectReject(
    () => runQualityAgent({
      target: buildTarget(),
      testMode: true
    }),
    rejected("envelopes", "research.json: artefact absent ou invalide")
  );
});

for (const name of QUALITY_ARTIFACT_NAMES) {
  await test(`artefact manquant → FAIL — ${name}.json`, async () => {
    const input = structuredClone(artifacts);

    delete input[name];

    await expectReject(
      () => runQualityAgent({
        artifacts: input,
        target: buildTarget(),
        testMode: true
      }),
      rejected("envelopes", `${name}.json: artefact absent ou invalide`)
    );
  });

  await test(`data passé à la place de l'enveloppe → FAIL — ${name}.json`, async () => {
    const input = structuredClone(artifacts);

    input[name] = input[name].data;

    await expectReject(
      () => runQualityAgent({
        artifacts: input,
        target: buildTarget(),
        testMode: true
      }),
      rejected("envelopes", `${name}.json: champ agent manquant`)
    );
  });
}

await test("cible de production absente → FAIL", async () => {
  await expectReject(
    () => runQualityAgent({
      artifacts: structuredClone(artifacts),
      testMode: true
    }),
    rejected(
      "assembly_source_mapping",
      "Spécification de sortie cible absente ou invalide"
    )
  );
});

await test("durée cible absente → FAIL", async () => {
  const target = buildTarget();

  delete target.duration_minutes;

  await expectReject(
    () => runQualityAgent({
      artifacts: structuredClone(artifacts),
      target,
      testMode: true
    }),
    rejected(
      "durations",
      "durée cible de production absente ou invalide"
    )
  );
});

await test("mode d'audit différent du mode des artefacts → FAIL", async () => {
  await expectReject(
    () => runQualityAgent({
      artifacts: structuredClone(artifacts),
      target: buildTarget(),
      testMode: false
    }),
    rejected(
      "envelopes",
      'research.json: mode "test" différent du mode d\'audit "full"'
    )
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 3. Fail closed — audits ---");

// Chaque cas altère une copie des six enveloppes valides et nomme le
// contrôle qui doit le détecter.
const auditCases = [
  // --- envelopes
  {
    name: "mauvais agent (research.json)",
    mutate: a => {
      a.research.agent = "script";
    },
    check: "envelopes",
    detail: 'research.json: agent "script" au lieu de "research"'
  },
  {
    name: "mauvais agent (assets.json)",
    mutate: a => {
      a.assets.agent = "voice";
    },
    check: "envelopes",
    detail: 'assets.json: agent "voice" au lieu de "asset"'
  },
  {
    name: "mode inconnu",
    mutate: a => {
      a.voice.mode = "demo";
    },
    check: "envelopes",
    detail: "voice.json: mode invalide"
  },
  {
    name: "modes mélangés",
    mutate: a => {
      a.assembly.mode = "full";
    },
    check: "envelopes",
    detail: 'assembly.json: mode "full" différent du mode d\'audit "test"'
  },
  {
    name: "data absent",
    mutate: a => {
      delete a.visual.data;
    },
    check: "envelopes",
    detail: "visual.json: champ data manquant"
  },
  {
    name: "champ d'enveloppe inconnu",
    mutate: a => {
      a.script.repaired_by = "quality";
    },
    check: "envelopes",
    detail: "script.json: champ repaired_by non autorisé"
  },
  {
    name: "verdict persisté supprimé",
    mutate: a => {
      delete a.visual.factual_grounding_validation;
    },
    check: "envelopes",
    detail: "visual.json: champ factual_grounding_validation manquant"
  },
  {
    name: "usage modèle absent (research.json)",
    mutate: a => {
      a.research.usage = null;
    },
    check: "envelopes",
    detail: "research.json: usage modèle absent"
  },
  {
    name: "usage non null sur un agent sans modèle",
    mutate: a => {
      a.assets.usage = { model: "x" };
    },
    check: "envelopes",
    detail: "assets.json: usage doit être null"
  },

  // --- persisted_verdicts
  ...[
    ["research", "validation"],
    ["script", "validation"],
    ["script", "research_reference_validation"],
    ["script", "claim_validation"],
    ["script", "claim_coverage_validation"],
    ["visual", "validation"],
    ["visual", "script_mapping_validation"],
    ["visual", "factual_grounding_validation"],
    ["assets", "validation"],
    ["assets", "visual_mapping_validation"],
    ["voice", "validation"],
    ["voice", "script_mapping_validation"],
    ["assembly", "validation"],
    ["assembly", "source_mapping_validation"]
  ].map(([name, key]) => ({
    name: `verdict persisté en échec (${name}.json ${key})`,
    mutate: a => {
      a[name][key].valid = false;
    },
    check: "persisted_verdicts",
    detail: `${name}.json: ${key} n'est pas un PASS persisté`
  })),
  {
    name: "verdict persisté valide mais avec erreurs",
    mutate: a => {
      a.assets.validation.errors.push("erreur ignorée");
    },
    check: "persisted_verdicts",
    detail: "assets.json: validation n'est pas un PASS persisté"
  },
  {
    name: "segment non couvert dans claim_coverage_validation",
    mutate: a => {
      a.script.claim_coverage_validation.segments[0].covered = false;
    },
    check: "persisted_verdicts",
    detail: "script.json: claim_coverage_validation.segments[0] non couvert"
  },
  {
    name: "claim non déclaré résiduel",
    mutate: a => {
      a.script.claim_coverage_validation.segments[1]
        .undeclared_claims.push({
          text: "L'eau y est rare.",
          reason: "Non déclaré."
        });
    },
    check: "persisted_verdicts",
    detail: "script.json: claim_coverage_validation.segments[1] non couvert"
  },
  {
    name: "segment absent de claim_coverage_validation",
    mutate: a => {
      a.script.claim_coverage_validation.segments.pop();
    },
    check: "persisted_verdicts",
    detail: "script.json: claim_coverage_validation ne couvre pas chaque segment"
  },
  {
    name: "shot non grounded dans factual_grounding_validation",
    mutate: a => {
      a.visual.factual_grounding_validation.shots[2].grounded = false;
    },
    check: "persisted_verdicts",
    detail: "visual.json: factual_grounding_validation.shots[2] non grounded"
  },
  {
    name: "shot absent de factual_grounding_validation",
    mutate: a => {
      a.visual.factual_grounding_validation.shots.pop();
    },
    check: "persisted_verdicts",
    detail: "visual.json: factual_grounding_validation ne couvre pas chaque shot"
  },

  // --- structure
  {
    name: "research corrompu (VERIFIED sans source)",
    mutate: a => {
      a.research.data.key_facts[0].verification_status = "verified";
    },
    check: "structure",
    detail: "research.json: key_facts[0]: VERIFIED interdit sans source"
  },
  {
    name: "script corrompu (conclusion absente)",
    mutate: a => {
      delete a.script.data.conclusion;
    },
    check: "structure",
    detail: "script.json: conclusion manquante"
  },
  {
    name: "visual corrompu (asset_type hors liste)",
    mutate: a => {
      a.visual.data.sections[0].segments[0].shots[0].asset_type =
        "photo";
    },
    check: "structure",
    detail: "visual.json: sections[0].segments[0].shots[0]: asset_type invalide"
  },
  {
    name: "assets corrompu (status resolved)",
    mutate: a => {
      a.assets.data.assets[0].status = "resolved";
    },
    check: "structure",
    detail: 'assets.json: assets[0]: status doit être "unresolved"'
  },
  {
    name: "assets : URL injectée",
    mutate: a => {
      a.assets.data.assets[0].source_url =
        "https://exemple.invalid/video.mp4";
    },
    check: "structure",
    detail: "assets.json: assets[0]: champ source_url non autorisé"
  },
  {
    name: "voice corrompu (fichier audio injecté)",
    mutate: a => {
      a.voice.data.narration_units[0].audio_file = "s01.mp3";
    },
    check: "structure",
    detail: "voice.json: narration_units[0]: champ audio_file non autorisé"
  },
  {
    name: "assembly corrompu (trou dans la piste vidéo)",
    mutate: a => {
      const clip = a.assembly.data.video_track[1];

      clip.start_seconds += 1;
      clip.end_seconds += 1;
    },
    check: "structure",
    detail: "assembly.json: video_track[1]: trou entre 8s et 9s"
  },
  {
    name: "assembly corrompu (fichier de rendu injecté)",
    mutate: a => {
      a.assembly.data.output_file = "output/master.mp4";
    },
    check: "structure",
    detail: "assembly.json: plan: champ output_file non autorisé"
  },
  {
    name: "data illisible (sections supprimées du script)",
    mutate: a => {
      delete a.script.data.sections;
    },
    check: "structure",
    detail: "script.json: sections doit être un tableau non vide"
  },

  // --- research_script_mapping
  {
    name: "claim pointant hors du Research",
    mutate: a => {
      a.script.data.sections[0].segments[0].claims[0]
        .research_fact_ref = 7;
    },
    check: "research_script_mapping",
    detail: "sections[0].segments[0].claims[0]: research_fact_ref invalide ou hors limites"
  },
  {
    name: "segment pointant hors du Research",
    mutate: a => {
      a.script.data.sections[0].segments[0].research_fact_refs = [7];
    },
    check: "research_script_mapping",
    detail: "sections[0].segments[0]: research_fact_ref 7 hors limites"
  },
  {
    name: "fait non vérifié utilisé sans signalement (segment)",
    mutate: a => {
      a.script.data.sections[0].segments[0]
        .contains_unverified_claim = false;
    },
    check: "research_script_mapping",
    detail: "sections[0].segments[0]: fait 0 non vérifié utilisé sans signalement"
  },
  {
    name: "fait non vérifié utilisé sans signalement (claim)",
    mutate: a => {
      a.script.data.sections[1].segments[0].claims[0]
        .is_unverified = false;
    },
    check: "research_script_mapping",
    detail: "sections[1].segments[0].claims[0]: fait non vérifié utilisé sans is_unverified=true"
  },
  {
    name: "fait Research supprimé après coup",
    mutate: a => {
      a.research.data.key_facts.pop();
    },
    check: "research_script_mapping",
    detail: "sections[1].segments[0].claims[0]: research_fact_ref invalide ou hors limites"
  },

  // --- script_visual_mapping
  {
    name: "section visuelle manquante",
    mutate: a => {
      a.visual.data.sections.pop();
    },
    check: "script_visual_mapping",
    detail: "nombre de sections différent du script"
  },
  {
    name: "segment de script ajouté après coup",
    mutate: a => {
      a.script.data.sections[0].segments.push(
        structuredClone(a.script.data.sections[0].segments[0])
      );
    },
    check: "script_visual_mapping",
    detail: "sections[0]: nombre de segments différent du script"
  },
  {
    name: "script_segment_index divergent",
    mutate: a => {
      a.visual.data.sections[1].segments[0].script_segment_index = 1;
    },
    check: "script_visual_mapping",
    detail: "sections[1].segments[0]: script_segment_index ne correspond pas au script"
  },
  {
    name: "durée de segment divergente entre script et visual",
    mutate: a => {
      a.script.data.sections[0].segments[0].estimated_seconds = 21;
    },
    check: "script_visual_mapping",
    detail: "sections[0].segments[0]: estimated_seconds différent du script"
  },
  {
    name: "shot utilisant un fait absent du segment",
    mutate: a => {
      a.visual.data.sections[0].segments[0].shots[2]
        .research_fact_refs = [1];
    },
    check: "script_visual_mapping",
    detail: "sections[0].segments[0]: shot utilise research_fact_ref 1 absent du segment source"
  },

  // --- visual_asset_mapping
  {
    name: "asset_query divergente entre visual et assets",
    mutate: a => {
      a.assets.data.assets[0].asset_query =
        "Australian Outback red ochre desert aerial";
    },
    check: "visual_asset_mapping",
    detail: "assets[0]: asset_query différent du shot source"
  },
  {
    name: "visual_description réécrite après coup dans visual.json",
    mutate: a => {
      a.visual.data.sections[0].segments[0].shots[0]
        .visual_description =
        "Vue aérienne du désert australien avec des tons rouges et ocres caractéristiques de l'Outback.";
    },
    check: "visual_asset_mapping",
    detail: "assets[0]: visual_description différent du shot source"
  },
  {
    name: "asset manquant",
    mutate: a => {
      const removed = a.assets.data.assets.pop();

      a.assets.data.summary.total_assets -= 1;
      a.assets.data.summary.total_duration_seconds -=
        removed.duration_seconds;
      a.assets.data.summary.by_type[removed.asset_type] -= 1;
    },
    check: "visual_asset_mapping",
    detail: "asset manquant : 4 assets pour 5 shots"
  },
  {
    name: "shot manquant",
    mutate: a => {
      a.visual.data.sections[1].segments[0].shots.pop();
      a.visual.factual_grounding_validation.shots.pop();
    },
    check: "visual_asset_mapping",
    detail: "asset supplémentaire : 5 assets pour 4 shots"
  },

  // --- script_voice_mapping
  {
    name: "narration différente du script",
    mutate: a => {
      a.voice.data.narration_units[0].text += " L'eau y est rare.";
    },
    check: "script_voice_mapping",
    detail: "narration_units[0]: text différent du voiceover source"
  },
  {
    name: "voiceover modifié après coup dans script.json",
    mutate: a => {
      a.script.data.sections[1].segments[0].voiceover =
        "Un voiceover modifié après la narration.";
    },
    check: "script_voice_mapping",
    detail: "narration_units[1]: text différent du voiceover source"
  },
  {
    name: "narration manquante",
    mutate: a => {
      const removed = a.voice.data.narration_units.pop();

      a.voice.data.summary.total_units -= 1;
      a.voice.data.summary.total_estimated_seconds -=
        removed.estimated_seconds;
    },
    check: "script_voice_mapping",
    detail: "unité manquante : 1 unités pour 2 segments"
  },
  {
    name: "ordre de narration inversé",
    mutate: a => {
      const [first, second] = a.voice.data.narration_units;

      [first.text, second.text] = [second.text, first.text];
    },
    check: "script_voice_mapping",
    detail: "narration_units[0]: text différent du voiceover source"
  },

  // --- assembly_source_mapping
  {
    name: "clip pointant vers un autre asset",
    mutate: a => {
      a.assembly.data.video_track[0].asset_id = "s09-g01-sh01";
    },
    check: "assembly_source_mapping",
    detail: "video_track[0]: asset_id différent de l'asset source"
  },
  {
    name: "ordre des clips inversé",
    mutate: a => {
      const [first, second] = a.assembly.data.video_track;

      [first.asset_id, second.asset_id] =
        [second.asset_id, first.asset_id];
    },
    check: "assembly_source_mapping",
    detail: "video_track[0]: asset_id différent de l'asset source"
  },
  {
    name: "sortie différente de la cible de production",
    mutate: a => {
      a.assembly.data.output.width = 1920;
      a.assembly.data.output.height = 1080;
    },
    check: "assembly_source_mapping",
    detail: "output.width différent de la cible de production"
  },
  {
    name: "durée d'asset modifiée après le montage",
    mutate: a => {
      a.assets.data.assets[0].duration_seconds = 9;
      a.assets.data.summary.total_duration_seconds += 1;
    },
    check: "assembly_source_mapping",
    detail: "video_track[0]: duration_seconds différent de l'asset source"
  },

  // --- titles
  ...["visual", "assets", "voice", "assembly"].map(name => ({
    name: `titre divergent (${name}.json)`,
    mutate: a => {
      a[name].data.title = "Un titre divergent";
    },
    check: "titles",
    detail: `${name}.json: title différent de script.json`
  })),
  {
    name: "titre divergent (script.json)",
    mutate: a => {
      a.script.data.title = "Un titre divergent";
    },
    check: "titles",
    detail: "visual.json: title différent de script.json"
  },

  // --- durations
  {
    name: "durée totale divergente entre script et aval",
    mutate: a => {
      a.script.data.sections[0].segments[0].estimated_seconds = 21;
    },
    check: "durations",
    detail: "visual.json: durée totale 40s différente de script.json 41s"
  },
  {
    name: "durée totale vidéo divergente (shot allongé)",
    mutate: a => {
      a.visual.data.sections[0].segments[0].shots[0]
        .duration_seconds = 8.5;
    },
    check: "durations",
    detail: "visual.json: durée totale 40.5s différente de script.json 40s"
  }
];

for (const testCase of auditCases) {
  await test(`artefact altéré → FAIL [${testCase.check}] — ${testCase.name}`, async () => {
    const input = structuredClone(artifacts);

    testCase.mutate(input);

    await expectReject(
      () => runQualityAgent({
        artifacts: input,
        target: buildTarget(),
        testMode: true
      }),
      rejected(testCase.check, testCase.detail)
    );
  });
}

await test("tous les contrôles déclarés sont exercés par au moins un cas d'échec", () => {
  const exercised = new Set(
    auditCases.map(testCase => testCase.check)
  );

  assert(
    QUALITY_CHECK_IDS.every(id => exercised.has(id)),
    `contrôles non exercés : ${QUALITY_CHECK_IDS.filter(id => !exercised.has(id))}`
  );
});

await test("un échec liste tous les contrôles concernés, sans s'arrêter au premier", async () => {
  const input = structuredClone(artifacts);

  input.voice.data.title = "Un titre divergent";

  const error = await expectReject(
    () => runQualityAgent({
      artifacts: input,
      target: buildTarget(),
      testMode: true
    }),
    /^Quality Agent : audit rejeté\./
  );

  for (const id of [
    "script_voice_mapping",
    "assembly_source_mapping",
    "titles"
  ]) {
    assert(
      error.message.includes(`[${id}]`),
      `contrôle ${id} absent du message : ${error.message}`
    );
  }
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 4. Fail closed — Quality Gate (contrat du rapport) ---");

const reportCases = [
  [
    "rapport absent",
    () => undefined,
    /Quality report absent ou invalide/
  ],
  [
    "verdict fail",
    report => {
      report.verdict = "fail";
    },
    /verdict doit être "pass"/
  ],
  [
    "contrôle non validé",
    report => {
      report.checks[3].valid = false;
    },
    /checks\[3\]: contrôle research_script_mapping non validé/
  ],
  [
    "contrôle validé mais avec erreurs",
    report => {
      report.checks[0].errors.push("erreur ignorée");
    },
    /checks\[0\]: contrôle envelopes avec erreurs/
  ],
  [
    "contrôle manquant",
    report => {
      report.checks.pop();
    },
    /checks ne contient pas exactement les contrôles attendus/
  ],
  [
    "contrôle inconnu ajouté",
    report => {
      report.checks.push({
        id: "best_effort",
        valid: true,
        errors: []
      });
    },
    /checks ne contient pas exactement les contrôles attendus/
  ],
  [
    "contrôles dans le désordre",
    report => {
      report.checks.reverse();
    },
    /checks ne contient pas exactement les contrôles attendus/
  ],
  [
    "champ de contrôle inconnu",
    report => {
      report.checks[0].repaired = true;
    },
    /checks\[0\]: champ repaired non autorisé/
  ],
  [
    "champ racine inconnu",
    report => {
      report.repairs = [];
    },
    /report: champ repairs non autorisé/
  ],
  [
    "title absent",
    report => {
      delete report.title;
    },
    /report: champ title manquant/
  ],
  [
    "metrics absentes",
    report => {
      delete report.metrics;
    },
    /report: champ metrics manquant/
  ],
  [
    "métrique non numérique",
    report => {
      report.metrics.shots = "5";
    },
    /metrics: shots invalide/
  ],
  [
    "métrique manquante",
    report => {
      delete report.metrics.assets;
    },
    /metrics: champ assets manquant/
  ],
  [
    "métrique inconnue",
    report => {
      report.metrics.score = 100;
    },
    /metrics: champ score non autorisé/
  ],
  [
    "warnings non tableau",
    report => {
      report.warnings = "aucun";
    },
    /warnings doit être un tableau de textes/
  ],
  [
    "checks non tableau",
    report => {
      report.checks = {};
    },
    /checks doit être un tableau/
  ]
];

for (const [name, mutate, pattern] of reportCases) {
  await test(`rapport altéré → FAIL — ${name}`, () => {
    let report = structuredClone(result.data);

    const replaced = mutate(report);

    if (name === "rapport absent") {
      report = replaced;
    }

    const verdict = validateQualityReport(report);

    assert(verdict.valid === false, "FAIL attendu, PASS obtenu");

    assert(
      verdict.errors.some(error => pattern.test(error)),
      `erreur attendue ${pattern} — obtenu : ${verdict.errors.join(" | ")}`
    );
  });
}

await test("le rapport valide n'a pas été altéré par les cas", () => {
  const verdict = validateQualityReport(result.data);

  assert(
    verdict.valid === true && verdict.errors.length === 0,
    `PASS attendu — ${verdict.errors.join(" | ")}`
  );
});

// ------------------------------------------------------------------
console.log("");
console.log("--- 5. Zéro API, zéro réseau ---");

await test("Quality Agent et validateur : aucun import de service, de réseau, de repair ou de juge modèle", () => {
  const allowed = [
    "node:util",
    "../utils/validate-quality-report.js",
    "./validate-research.js",
    "./validate-script.js",
    "./validate-script-claims.js",
    "./validate-visual-director.js",
    "./validate-asset-manifest.js",
    "./validate-voice-manifest.js",
    "./validate-assembly-plan.js"
  ];

  for (const file of [
    "src/agents/quality.js",
    "src/utils/validate-quality-report.js"
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
      !/\bfetch\s*\(|process\.env|createMessage|import\s*\(|node:fs|child_process|repair-/.test(
        source
      ),
      `${file} : accès réseau, disque, modèle ou repair détecté`
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
    "RESULTAT GLOBAL : FAIL — Quality Agent"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — Quality Agent : audit déterministe, fail-closed, sans réparation, zéro API"
);

process.exit(0);
