import { isDeepStrictEqual } from "node:util";

import { validateResearchDossier } from "./validate-research.js";
import { validateScriptDossier } from "./validate-script.js";
import { validateScriptClaims } from "./validate-script-claims.js";

import {
  validateVisualDirectorDossier
} from "./validate-visual-director.js";

import {
  validateAssetManifest,
  validateAssetManifestMapping
} from "./validate-asset-manifest.js";

import {
  validateVoiceManifest,
  validateVoiceManifestMapping
} from "./validate-voice-manifest.js";

import {
  roundTime,
  validateAssemblyPlan,
  validateAssemblySourceMapping
} from "./validate-assembly-plan.js";

export const QUALITY_VERDICT = "pass";

export const QUALITY_MODES = ["test", "full"];

// Contrôles exécutés par l'audit, dans cet ordre.
export const QUALITY_CHECK_IDS = [
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
];

// Enveloppes persistées attendues : nom de l'agent, clés exactes et
// présence d'un usage modèle (agents 1 à 3) ou non (agents 4 à 6).
const ENVELOPES = {
  research: {
    agent: "research",
    keys: ["agent", "mode", "data", "validation", "usage"],
    verdicts: ["validation"],
    modelUsage: true
  },
  script: {
    agent: "script",
    keys: [
      "agent",
      "mode",
      "data",
      "validation",
      "research_reference_validation",
      "claim_validation",
      "claim_coverage_validation",
      "usage"
    ],
    verdicts: [
      "validation",
      "research_reference_validation",
      "claim_validation",
      "claim_coverage_validation"
    ],
    modelUsage: true
  },
  visual: {
    agent: "visual_director",
    keys: [
      "agent",
      "mode",
      "data",
      "validation",
      "script_mapping_validation",
      "factual_grounding_validation",
      "usage"
    ],
    verdicts: [
      "validation",
      "script_mapping_validation",
      "factual_grounding_validation"
    ],
    modelUsage: true
  },
  assets: {
    agent: "asset",
    keys: [
      "agent",
      "mode",
      "data",
      "validation",
      "visual_mapping_validation",
      "usage"
    ],
    verdicts: ["validation", "visual_mapping_validation"],
    modelUsage: false
  },
  voice: {
    agent: "voice",
    keys: [
      "agent",
      "mode",
      "data",
      "validation",
      "script_mapping_validation",
      "usage"
    ],
    verdicts: ["validation", "script_mapping_validation"],
    modelUsage: false
  },
  assembly: {
    agent: "assembly",
    keys: [
      "agent",
      "mode",
      "data",
      "validation",
      "source_mapping_validation",
      "usage"
    ],
    verdicts: ["validation", "source_mapping_validation"],
    modelUsage: false
  }
};

export const QUALITY_ARTIFACT_NAMES = Object.keys(ENVELOPES);

const REPORT_KEYS = [
  "title",
  "verdict",
  "checks",
  "metrics",
  "warnings"
];

const CHECK_KEYS = ["id", "valid", "errors"];

const METRIC_KEYS = [
  "sections",
  "segments",
  "shots",
  "assets",
  "narration_units",
  "total_video_seconds",
  "total_narration_seconds",
  "declared_duration_minutes"
];

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function checkExactKeys(value, allowedKeys, label, errors) {
  const keys = Object.keys(value);

  for (const key of allowedKeys) {
    if (!keys.includes(key)) {
      errors.push(`${label}: champ ${key} manquant`);
    }
  }

  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${label}: champ ${key} non autorisé`);
    }
  }
}

function listSegments(script) {
  return script.sections.flatMap(section => section.segments);
}

function listShots(visual) {
  return visual.sections.flatMap(
    section => section.segments.flatMap(segment => segment.shots)
  );
}

function sum(values) {
  return roundTime(
    values.reduce((total, value) => total + value, 0)
  );
}

// ------------------------------------------------------------------
// Contrôles de l'audit
// ------------------------------------------------------------------

function auditEnvelopes({ artifacts, mode }) {
  const errors = [];

  if (!QUALITY_MODES.includes(mode)) {
    errors.push(`mode d'audit invalide : ${mode}`);
  }

  for (const [name, spec] of Object.entries(ENVELOPES)) {
    const envelope = artifacts[name];
    const label = `${name}.json`;

    if (!isPlainObject(envelope)) {
      errors.push(`${label}: artefact absent ou invalide`);
      continue;
    }

    checkExactKeys(envelope, spec.keys, label, errors);

    if (envelope.agent !== spec.agent) {
      errors.push(
        `${label}: agent "${envelope.agent}" au lieu de "${spec.agent}"`
      );
    }

    if (!QUALITY_MODES.includes(envelope.mode)) {
      errors.push(`${label}: mode invalide`);
    } else if (envelope.mode !== mode) {
      errors.push(
        `${label}: mode "${envelope.mode}" différent du mode d'audit "${mode}"`
      );
    }

    if (!isPlainObject(envelope.data)) {
      errors.push(`${label}: data absent ou invalide`);
    }

    if (spec.modelUsage && !isPlainObject(envelope.usage)) {
      errors.push(`${label}: usage modèle absent`);
    }

    if (!spec.modelUsage && envelope.usage !== null) {
      errors.push(`${label}: usage doit être null`);
    }
  }

  return errors;
}

function auditPersistedVerdicts({ artifacts }) {
  const errors = [];

  for (const [name, spec] of Object.entries(ENVELOPES)) {
    for (const key of spec.verdicts) {
      const verdict = artifacts[name][key];

      if (
        !isPlainObject(verdict) ||
        verdict.valid !== true ||
        !Array.isArray(verdict.errors) ||
        verdict.errors.length !== 0
      ) {
        errors.push(
          `${name}.json: ${key} n'est pas un PASS persisté`
        );
      }
    }
  }

  const coverage =
    artifacts.script.claim_coverage_validation?.segments;

  const segmentCount = listSegments(artifacts.script.data).length;

  if (
    !Array.isArray(coverage) ||
    coverage.length !== segmentCount
  ) {
    errors.push(
      "script.json: claim_coverage_validation ne couvre pas chaque segment"
    );
  } else {
    coverage.forEach((segment, index) => {
      if (
        segment?.covered !== true ||
        !Array.isArray(segment.undeclared_claims) ||
        segment.undeclared_claims.length !== 0
      ) {
        errors.push(
          `script.json: claim_coverage_validation.segments[${index}] non couvert`
        );
      }
    });
  }

  const grounding =
    artifacts.visual.factual_grounding_validation?.shots;

  const shotCount = listShots(artifacts.visual.data).length;

  if (
    !Array.isArray(grounding) ||
    grounding.length !== shotCount
  ) {
    errors.push(
      "visual.json: factual_grounding_validation ne couvre pas chaque shot"
    );
  } else {
    grounding.forEach((shot, index) => {
      if (
        shot?.grounded !== true ||
        !Array.isArray(shot.unsupported_visual_claims) ||
        shot.unsupported_visual_claims.length !== 0
      ) {
        errors.push(
          `visual.json: factual_grounding_validation.shots[${index}] non grounded`
        );
      }
    });
  }

  return errors;
}

function auditStructure({ artifacts }) {
  const verdicts = {
    research: validateResearchDossier(artifacts.research.data),
    script: validateScriptDossier(artifacts.script.data),
    visual: validateVisualDirectorDossier(artifacts.visual.data),
    assets: validateAssetManifest(artifacts.assets.data),
    voice: validateVoiceManifest(artifacts.voice.data),
    assembly: validateAssemblyPlan(artifacts.assembly.data)
  };

  return Object.entries(verdicts).flatMap(
    ([name, verdict]) =>
      verdict.errors.map(error => `${name}.json: ${error}`)
  );
}

// Reprend les contrôles du Script Agent (références Research) en plus
// du Claim Gate exporté.
function auditResearchScriptMapping({ artifacts }) {
  const research = artifacts.research.data;
  const script = artifacts.script.data;

  const errors = [
    ...validateScriptClaims(script, research).errors
  ];

  const maxIndex = research.key_facts.length - 1;

  script.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      const label =
        `sections[${sectionIndex}].segments[${segmentIndex}]`;

      for (const ref of segment.research_fact_refs) {
        if (ref > maxIndex) {
          errors.push(
            `${label}: research_fact_ref ${ref} hors limites`
          );
          continue;
        }

        if (
          research.key_facts[ref].verification_status !==
            "verified" &&
          segment.contains_unverified_claim !== true
        ) {
          errors.push(
            `${label}: fait ${ref} non vérifié utilisé sans signalement`
          );
        }
      }
    });
  });

  return errors;
}

// Reprend le mapping Script du Visual Director.
function auditScriptVisualMapping({ artifacts }) {
  const script = artifacts.script.data;
  const visual = artifacts.visual.data;
  const errors = [];

  if (visual.sections.length !== script.sections.length) {
    return ["nombre de sections différent du script"];
  }

  script.sections.forEach((scriptSection, sectionIndex) => {
    const visualSection = visual.sections[sectionIndex];

    if (
      visualSection.segments.length !==
      scriptSection.segments.length
    ) {
      errors.push(
        `sections[${sectionIndex}]: nombre de segments différent du script`
      );
      return;
    }

    scriptSection.segments.forEach(
      (scriptSegment, segmentIndex) => {
        const visualSegment =
          visualSection.segments[segmentIndex];

        const label =
          `sections[${sectionIndex}].segments[${segmentIndex}]`;

        if (
          visualSegment.script_segment_index !== segmentIndex
        ) {
          errors.push(
            `${label}: script_segment_index ne correspond pas au script`
          );
        }

        if (
          visualSegment.estimated_seconds !==
          scriptSegment.estimated_seconds
        ) {
          errors.push(
            `${label}: estimated_seconds différent du script`
          );
        }

        const allowedRefs = new Set(
          scriptSegment.research_fact_refs
        );

        for (const shot of visualSegment.shots) {
          for (const ref of shot.research_fact_refs) {
            if (!allowedRefs.has(ref)) {
              errors.push(
                `${label}: shot utilise research_fact_ref ${ref} absent du segment source`
              );
            }
          }
        }
      }
    );
  });

  return errors;
}

function auditVisualAssetMapping({ artifacts }) {
  return validateAssetManifestMapping(
    artifacts.assets.data,
    artifacts.visual.data
  ).errors;
}

function auditScriptVoiceMapping({ artifacts }) {
  return validateVoiceManifestMapping(
    artifacts.voice.data,
    artifacts.script.data
  ).errors;
}

function auditAssemblySourceMapping({ artifacts, target }) {
  return validateAssemblySourceMapping(
    artifacts.assembly.data,
    artifacts.assets.data,
    artifacts.voice.data,
    target?.video
  ).errors;
}

function auditTitles({ artifacts }) {
  const reference = artifacts.script.data.title;
  const errors = [];

  if (!isNonEmptyString(reference)) {
    errors.push("script.json: title manquant");
  }

  for (const name of ["visual", "assets", "voice", "assembly"]) {
    if (artifacts[name].data.title !== reference) {
      errors.push(
        `${name}.json: title différent de script.json`
      );
    }
  }

  return errors;
}

function measureDurations(artifacts) {
  return {
    script: sum(
      listSegments(artifacts.script.data).map(
        segment => segment.estimated_seconds
      )
    ),
    visual: sum(
      listShots(artifacts.visual.data).map(
        shot => shot.duration_seconds
      )
    ),
    assets: roundTime(
      artifacts.assets.data.summary.total_duration_seconds
    ),
    voice: roundTime(
      artifacts.voice.data.summary.total_estimated_seconds
    ),
    assembly: roundTime(
      artifacts.assembly.data.summary.total_duration_seconds
    )
  };
}

function auditDurations({ artifacts, target, mode }, warnings) {
  const errors = [];
  const durations = measureDurations(artifacts);

  for (const [name, seconds] of Object.entries(durations)) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      errors.push(`${name}.json: durée totale invalide`);
    } else if (seconds !== durations.script) {
      errors.push(
        `${name}.json: durée totale ${seconds}s différente de script.json ${durations.script}s`
      );
    }
  }

  const range = target?.duration_minutes;

  if (
    !isPlainObject(range) ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.min > range.max
  ) {
    errors.push("durée cible de production absente ou invalide");

    return errors;
  }

  const minutes = durations.assembly / 60;

  if (minutes < range.min || minutes > range.max) {
    const message =
      `durée totale ${durations.assembly}s hors de la cible ` +
      `${range.min}–${range.max} min`;

    if (mode === "test") {
      warnings.push(`${message} — non bloquant en mode test`);
    } else {
      errors.push(message);
    }
  }

  return errors;
}

const AUDITS = {
  envelopes: auditEnvelopes,
  persisted_verdicts: auditPersistedVerdicts,
  structure: auditStructure,
  research_script_mapping: auditResearchScriptMapping,
  script_visual_mapping: auditScriptVisualMapping,
  visual_asset_mapping: auditVisualAssetMapping,
  script_voice_mapping: auditScriptVoiceMapping,
  assembly_source_mapping: auditAssemblySourceMapping,
  titles: auditTitles,
  durations: auditDurations
};

// Audite les six artefacts persistés. Ne répare rien, ne rejoue aucun
// modèle. Un contrôle qui ne peut pas s'exécuter sur des données
// corrompues est un contrôle en échec.
export function auditPipelineArtifacts({
  artifacts,
  target,
  mode
}) {
  const warnings = [];

  const context = {
    artifacts: isPlainObject(artifacts) ? artifacts : {},
    target,
    mode
  };

  const checks = QUALITY_CHECK_IDS.map(id => {
    let errors;

    try {
      errors = AUDITS[id](context, warnings);
    } catch (error) {
      errors = [
        `contrôle impossible sur les artefacts fournis — ${error.message}`
      ];
    }

    return {
      id,
      valid: errors.length === 0,
      errors
    };
  });

  return {
    checks,
    warnings
  };
}

export function measurePipelineArtifacts(artifacts) {
  const durations = measureDurations(artifacts);

  return {
    sections: artifacts.script.data.sections.length,
    segments: listSegments(artifacts.script.data).length,
    shots: listShots(artifacts.visual.data).length,
    assets: artifacts.assets.data.assets.length,
    narration_units: artifacts.voice.data.narration_units.length,
    total_video_seconds: durations.assembly,
    total_narration_seconds: durations.voice,
    declared_duration_minutes:
      artifacts.script.data.estimated_duration_minutes
  };
}

// Quality Gate : le rapport ne peut exister que sous la forme d'un PASS
// complet. Un rapport partiel ou contenant un contrôle en échec est
// rejeté.
export function validateQualityReport(data) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(data)) {
    return {
      valid: false,
      errors: ["Quality report absent ou invalide"],
      warnings
    };
  }

  checkExactKeys(data, REPORT_KEYS, "report", errors);

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  if (data.verdict !== QUALITY_VERDICT) {
    errors.push(`verdict doit être "${QUALITY_VERDICT}"`);
  }

  if (!Array.isArray(data.checks)) {
    errors.push("checks doit être un tableau");
  } else {
    if (
      !isDeepStrictEqual(
        data.checks.map(check => check?.id),
        QUALITY_CHECK_IDS
      )
    ) {
      errors.push(
        "checks ne contient pas exactement les contrôles attendus, dans l'ordre"
      );
    }

    data.checks.forEach((check, index) => {
      const label = `checks[${index}]`;

      if (!isPlainObject(check)) {
        errors.push(`${label}: contrôle absent ou invalide`);
        return;
      }

      checkExactKeys(check, CHECK_KEYS, label, errors);

      if (check.valid !== true) {
        errors.push(`${label}: contrôle ${check.id} non validé`);
      }

      if (
        !Array.isArray(check.errors) ||
        check.errors.length !== 0
      ) {
        errors.push(
          `${label}: contrôle ${check.id} avec erreurs`
        );
      }
    });
  }

  if (!isPlainObject(data.metrics)) {
    errors.push("metrics absent ou invalide");
  } else {
    checkExactKeys(data.metrics, METRIC_KEYS, "metrics", errors);

    for (const key of METRIC_KEYS) {
      if (
        key in data.metrics &&
        (
          !Number.isFinite(data.metrics[key]) ||
          data.metrics[key] <= 0
        )
      ) {
        errors.push(`metrics: ${key} invalide`);
      }
    }
  }

  if (
    !Array.isArray(data.warnings) ||
    data.warnings.some(warning => !isNonEmptyString(warning))
  ) {
    errors.push("warnings doit être un tableau de textes");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
