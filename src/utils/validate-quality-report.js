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
    fullOptionalMetadata: ["script_generation"],
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
    fullOptionalMetadata: ["storyboard_generation"],
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
  "media",
  "warnings"
];

// Périmètre réellement contrôlé par l'audit. Le rapport l'indique
// toujours : un PASS ne doit jamais laisser croire qu'une vidéo finale
// a été produite ou inspectée.
export const QUALITY_SCOPE_CONTRACTS = "contracts_only";
export const QUALITY_SCOPE_LOCAL_MEDIA = "local_media";
export const QUALITY_FINAL_VIDEO = "not_rendered";

// Périmètre d'un audit portant aussi sur un MP4 réellement rendu et
// recontrôlé sur disque par la couche de rendu.
export const QUALITY_SCOPE_RENDERED = "rendered_video";
export const QUALITY_FINAL_VIDEO_RENDERED = "rendered";

// FFprobe est la vérité du fichier. 0,25 s couvre les arrondis de frame
// (30 fps) et de muxage AAC sans masquer un écart éditorial significatif.
export const ACTUAL_RENDERED_DURATION_TOLERANCE_SECONDS = 0.25;

export function validateActualRenderedDuration({
  actualDurationSeconds,
  declaredDurationSeconds,
  targetDurationMinutes
}) {
  const errors = [];

  if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) {
    return ["durée réellement rendue absente ou non mesurable"];
  }

  if (
    !Number.isFinite(declaredDurationSeconds) ||
    Math.abs(declaredDurationSeconds - actualDurationSeconds) >
      ACTUAL_RENDERED_DURATION_TOLERANCE_SECONDS
  ) {
    errors.push(
      `durée déclarée ${declaredDurationSeconds}s différente de la durée réellement rendue ${actualDurationSeconds}s`
    );
  }

  const range = targetDurationMinutes;
  if (
    !isPlainObject(range) ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    range.min > range.max
  ) {
    errors.push("durée cible de production absente ou invalide");
    return errors;
  }

  const min = range.min * 60;
  const max = range.max * 60;
  if (
    actualDurationSeconds < min - ACTUAL_RENDERED_DURATION_TOLERANCE_SECONDS ||
    actualDurationSeconds > max + ACTUAL_RENDERED_DURATION_TOLERANCE_SECONDS
  ) {
    errors.push(
      `durée réellement rendue ${actualDurationSeconds}s hors de la cible ${min}s–${max}s (tolérance ${ACTUAL_RENDERED_DURATION_TOLERANCE_SECONDS}s)`
    );
  }

  return errors;
}

// Contrôles ajoutés lorsque des médias locaux sont rattachés.
export const QUALITY_MEDIA_CHECK_IDS = [
  "media_files"
];

// Contrôle ajouté lorsqu'une vidéo a été rendue.
export const QUALITY_RENDER_CHECK_IDS = [
  "final_video"
];

// Écart maximal admis, en secondes, sur la durée de la vidéo rendue.
const RENDER_DURATION_TOLERANCE = 0.2;

const RENDER_ENVELOPE_KEYS = [
  "stage",
  "mode",
  "data",
  "validation",
  "usage"
];

const RENDER_PROFILES = ["target", "preview"];

const MEDIA_KEYS_BY_SCOPE = {
  [QUALITY_SCOPE_RENDERED]: [
    "scope",
    "final_video",
    "assets_inspected",
    "narration_units_inspected",
    "estimated_narration_seconds",
    "measured_narration_seconds",
    "rendered_duration_seconds",
    "render_profile"
  ],
  [QUALITY_SCOPE_CONTRACTS]: [
    "scope",
    "final_video"
  ],
  [QUALITY_SCOPE_LOCAL_MEDIA]: [
    "scope",
    "final_video",
    "assets_inspected",
    "narration_units_inspected",
    "estimated_narration_seconds",
    "measured_narration_seconds"
  ]
};

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

function checkExactKeys(
  value,
  requiredKeys,
  label,
  errors,
  optionalKeys = []
) {
  const keys = Object.keys(value);
  const allowedKeys = [...requiredKeys, ...optionalKeys];

  for (const key of requiredKeys) {
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

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function auditFullOptionalMetadata({ envelope, name, errors }) {
  const field =
    name === "script"
      ? "script_generation"
      : name === "visual"
        ? "storyboard_generation"
        : null;

  if (!field || envelope[field] === undefined) {
    return;
  }

  const metadata = envelope[field];
  const label = `${name}.json: ${field}`;

  if (!isPlainObject(metadata)) {
    errors.push(`${label} absent ou invalide`);
    return;
  }

  const isScript = field === "script_generation";
  const requiredKeys = isScript
    ? [
      "mode",
      "total_segments",
      "generated_segments",
      "reused_segments",
      "checkpoint_directory",
      "plan_sha256"
    ]
    : [
      "mode",
      "batch_size",
      "total_batches",
      "generated_batches",
      "reused_batches",
      "checkpoint_directory",
      "plan_sha256"
    ];

  checkExactKeys(metadata, requiredKeys, label, errors);

  if (metadata.mode !== (isScript ? "segmented" : "batched")) {
    errors.push(`${label}: mode invalide`);
  }

  const totalKey = isScript ? "total_segments" : "total_batches";
  const generatedKey = isScript ? "generated_segments" : "generated_batches";
  const reusedKey = isScript ? "reused_segments" : "reused_batches";

  if (!isPositiveInteger(metadata[totalKey])) {
    errors.push(`${label}: ${totalKey} invalide`);
  }

  if (!isNonNegativeInteger(metadata[generatedKey])) {
    errors.push(`${label}: ${generatedKey} invalide`);
  }

  if (!isNonNegativeInteger(metadata[reusedKey])) {
    errors.push(`${label}: ${reusedKey} invalide`);
  }

  if (
    isPositiveInteger(metadata[totalKey]) &&
    isNonNegativeInteger(metadata[generatedKey]) &&
    isNonNegativeInteger(metadata[reusedKey]) &&
    metadata[generatedKey] + metadata[reusedKey] !== metadata[totalKey]
  ) {
    errors.push(`${label}: total de génération incohérent`);
  }

  if (!isScript && !isPositiveInteger(metadata.batch_size)) {
    errors.push(`${label}: batch_size invalide`);
  }

  if (!isNonEmptyString(metadata.checkpoint_directory)) {
    errors.push(`${label}: checkpoint_directory invalide`);
  }

  if (!isSha256(metadata.plan_sha256)) {
    errors.push(`${label}: plan_sha256 invalide`);
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

function auditEnvelopes({ artifacts, mode, renderVerification }) {
  const errors = [];

  if (!QUALITY_MODES.includes(mode)) {
    errors.push(`mode d'audit invalide : ${mode}`);
  }

  // Un render.json ne peut être audité qu'avec le recontrôle disque de
  // la vidéo qu'il décrit.
  if (
    artifacts.render !== undefined &&
    renderVerification === undefined
  ) {
    errors.push(
      "render.json: artefact fourni sans contrôle de la vidéo rendue"
    );
  }

  for (const [name, spec] of Object.entries(ENVELOPES)) {
    const envelope = artifacts[name];
    const label = `${name}.json`;

    if (!isPlainObject(envelope)) {
      errors.push(`${label}: artefact absent ou invalide`);
      continue;
    }

    checkExactKeys(
      envelope,
      spec.keys,
      label,
      errors,
      mode === "full" ? spec.fullOptionalMetadata : []
    );

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

    if (mode === "full") {
      auditFullOptionalMetadata({ envelope, name, errors });
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

function auditStructure({ artifacts, scriptDurationRange }) {
  const verdicts = {
    research: validateResearchDossier(artifacts.research.data),
    // Plage de durée déclarée du script : celle du profil de la
    // production si elle est fournie, sinon 25-30 (comportement
    // historique). Elle est indépendante de la durée cible mesurée.
    script: validateScriptDossier(artifacts.script.data, {
      durationRange: scriptDurationRange
    }),
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

function auditAssemblySourceMapping({
  artifacts,
  target,
  mediaVerification
}) {
  return validateAssemblySourceMapping(
    artifacts.assembly.data,
    artifacts.assets.data,
    artifacts.voice.data,
    target?.video,
    mediaVerification
  ).errors;
}

function formatSeconds(seconds) {
  return `${roundTime(seconds)}s`;
}

// Écarts non bloquants entre les médias locaux et la cible : signalés,
// jamais corrigés. Le recalage temporel appartient au rendu.
function collectMediaWarnings(artifacts, target, warnings) {
  const video = target?.video;
  const medias = artifacts.assets.data.assets.map(
    asset => asset.media
  );

  if (isPlainObject(video)) {
    const belowResolution = medias.filter(
      media =>
        media.width < video.width ||
        media.height < video.height
    ).length;

    if (belowResolution > 0) {
      warnings.push(
        `${belowResolution} média(s) sous la résolution cible ${video.width}x${video.height}`
      );
    }

    const ratio = String(video.aspect_ratio).match(/^(\d+):(\d+)$/);

    const otherRatio = ratio
      ? medias.filter(
          media =>
            media.width * Number(ratio[2]) !==
            media.height * Number(ratio[1])
        ).length
      : 0;

    if (otherRatio > 0) {
      warnings.push(
        `${otherRatio} média(s) au ratio différent de ${video.aspect_ratio}`
      );
    }

    const otherFps = medias.filter(
      media => media.kind === "video" && media.fps !== video.fps
    ).length;

    if (otherFps > 0) {
      warnings.push(
        `${otherFps} vidéo(s) à une cadence différente de ${video.fps} images/s`
      );
    }
  }

  for (const unit of artifacts.voice.data.narration_units) {
    const drift = roundTime(
      unit.audio.duration_seconds - unit.estimated_seconds
    );

    if (drift !== 0) {
      warnings.push(
        `${unit.unit_id}: durée audio mesurée ` +
        `${formatSeconds(unit.audio.duration_seconds)}, estimée ` +
        `${formatSeconds(unit.estimated_seconds)} ` +
        `(écart ${drift > 0 ? "+" : ""}${drift}s)`
      );
    }
  }
}

// Médias locaux : tout asset et toute unité doivent être rattachés à un
// fichier, et la couche média doit les avoir tous recontrôlés sur
// disque juste avant l'audit.
function auditMediaFiles(
  { artifacts, target, mediaVerification },
  warnings
) {
  const errors = [];

  const assets = artifacts.assets.data.assets;
  const units = artifacts.voice.data.narration_units;

  const unresolved = assets.filter(
    asset => !isPlainObject(asset?.media)
  ).length;

  if (unresolved > 0) {
    errors.push(
      `assets.json: ${unresolved} asset(s) sans média local`
    );
  }

  const unsynthesized = units.filter(
    unit => !isPlainObject(unit?.audio)
  ).length;

  if (unsynthesized > 0) {
    errors.push(
      `voice.json: ${unsynthesized} unité(s) sans audio local`
    );
  }

  if (
    !isPlainObject(mediaVerification) ||
    mediaVerification.scope !== QUALITY_SCOPE_LOCAL_MEDIA ||
    !Array.isArray(mediaVerification.errors) ||
    !Array.isArray(mediaVerification.files)
  ) {
    errors.push("rapport de vérification média absent ou invalide");

    return errors;
  }

  if (
    mediaVerification.valid !== true ||
    mediaVerification.errors.length > 0
  ) {
    errors.push(
      ...(
        mediaVerification.errors.length > 0
          ? mediaVerification.errors
          : ["rapport de vérification média en échec"]
      )
    );
  }

  const expected = assets.length + units.length;

  if (mediaVerification.files.length !== expected) {
    errors.push(
      `${mediaVerification.files.length} fichier(s) vérifié(s) sur disque pour ${expected} attendu(s)`
    );
  }

  if (errors.length === 0) {
    collectMediaWarnings(artifacts, target, warnings);
  }

  return errors;
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

// Vidéo finale : render.json doit décrire un MP4 réellement rendu, que
// la couche de rendu vient de recontrôler sur disque (présence, taille,
// empreinte, relevé du fichier), et ce rendu doit suivre le plan de
// montage et les médias audités. Quality ne lit lui-même aucun fichier.
function auditFinalVideo(
  { artifacts, target, mode, renderVerification },
  warnings
) {
  const errors = [];
  const render = artifacts.render;

  if (!isPlainObject(render)) {
    return ["render.json: artefact absent ou invalide"];
  }

  checkExactKeys(render, RENDER_ENVELOPE_KEYS, "render.json", errors);

  if (render.stage !== "render") {
    errors.push(`render.json: stage "${render.stage}" au lieu de "render"`);
  }

  if (render.mode !== mode) {
    errors.push(
      `render.json: mode "${render.mode}" différent du mode d'audit "${mode}"`
    );
  }

  if (render.usage !== null) {
    errors.push("render.json: usage doit être null");
  }

  if (
    !isPlainObject(render.validation) ||
    render.validation.valid !== true ||
    !Array.isArray(render.validation.errors) ||
    render.validation.errors.length !== 0
  ) {
    errors.push("render.json: validation n'est pas un PASS persisté");
  }

  const data = render.data;

  if (
    !isPlainObject(data) ||
    !isPlainObject(data.output) ||
    !isPlainObject(data.summary) ||
    !Array.isArray(data.video_track) ||
    !Array.isArray(data.audio_track)
  ) {
    errors.push("render.json: data absent ou invalide");

    return errors;
  }

  if (data.status !== "rendered") {
    errors.push('render.json: status doit être "rendered"');
  }

  if (!RENDER_PROFILES.includes(data.profile)) {
    errors.push("render.json: profile invalide");
  }

  // Recontrôle disque du MP4 par la couche de rendu.
  if (
    !isPlainObject(renderVerification) ||
    renderVerification.scope !== QUALITY_SCOPE_RENDERED ||
    !Array.isArray(renderVerification.errors)
  ) {
    errors.push("rapport de contrôle de la vidéo rendue absent ou invalide");
  } else if (
    renderVerification.valid !== true ||
    renderVerification.errors.length > 0
  ) {
    errors.push(
      ...(
        renderVerification.errors.length > 0
          ? renderVerification.errors
          : ["rapport de contrôle de la vidéo rendue en échec"]
      )
    );
  } else if (
    !isDeepStrictEqual(renderVerification.output, data.output)
  ) {
    errors.push(
      "vidéo contrôlée sur disque différente de celle décrite par render.json"
    );
  }

  // La durée du MP4 re-sondé prévaut sur la timeline et sur render.json.
  // Ce contrôle reste un échec même si les deux JSON sont cohérents entre eux.
  const actualDurationErrors = validateActualRenderedDuration({
    actualDurationSeconds: renderVerification?.output?.duration_seconds,
    declaredDurationSeconds: data.output?.duration_seconds,
    targetDurationMinutes: target?.duration_minutes
  });

  // Les fixtures de rendu restent volontairement courtes en mode test.
  // Une contradiction fichier/artefact demeure toujours bloquante ; seule
  // la plage éditoriale devient un avertissement, comme auditDurations().
  for (const error of actualDurationErrors) {
    if (mode === "test" && error.includes("hors de la cible")) {
      warnings.push(`${error} — non bloquant en mode test`);
    } else {
      errors.push(error);
    }
  }

  // Cohérence avec les artefacts audités.
  if (data.title !== artifacts.script.data.title) {
    errors.push("render.json: title différent de script.json");
  }

  const plan = artifacts.assembly.data;

  if (
    !isDeepStrictEqual(
      data.video_track.map(clip => [
        clip?.asset_id,
        clip?.unit_id,
        clip?.source?.path
      ]),
      plan.video_track.map(clip => [
        clip.asset_id,
        clip.unit_id,
        clip.media?.path
      ])
    )
  ) {
    errors.push(
      "render.json: clips rendus différents du plan de montage"
    );
  }

  if (
    !isDeepStrictEqual(
      data.audio_track.map(unit => [
        unit?.unit_id,
        unit?.source?.path
      ]),
      plan.audio_track.map(unit => [
        unit.unit_id,
        unit.audio?.path
      ])
    )
  ) {
    errors.push(
      "render.json: unités rendues différentes du plan de montage"
    );
  }

  // La narration mesurée fait foi : la vidéo ne peut être ni plus
  // courte qu'elle, ni plus longue de plus d'une image par unité.
  const measured = sum(
    artifacts.voice.data.narration_units.map(
      unit => unit.audio.duration_seconds
    )
  );

  const rendered = data.summary.rendered_duration_seconds;
  const fps = data.output.fps;

  if (
    !Number.isFinite(rendered) ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    rendered < measured - 0.002 ||
    rendered >
      measured +
      artifacts.voice.data.narration_units.length / fps +
      0.002
  ) {
    errors.push(
      `render.json: durée rendue ${rendered}s incohérente avec la narration mesurée ${measured}s`
    );
  }

  if (
    !Number.isFinite(data.output.duration_seconds) ||
    Math.abs(data.output.duration_seconds - rendered) >
      RENDER_DURATION_TOLERANCE
  ) {
    errors.push(
      `render.json: durée du fichier ${data.output.duration_seconds}s ` +
      `à plus de ${RENDER_DURATION_TOLERANCE}s de la timeline ${rendered}s`
    );
  }

  if (fps !== target?.video?.fps) {
    errors.push(
      `render.json: cadence ${fps} différente de la cible ${target?.video?.fps} images/s`
    );
  }

  // Profil : la cible de production, ou un aperçu réduit toléré
  // uniquement en mode test.
  const video = target?.video;

  if (data.profile === "target") {
    if (
      data.output.width !== video?.width ||
      data.output.height !== video?.height
    ) {
      errors.push(
        `render.json: dimensions ${data.output.width}x${data.output.height} ` +
        `différentes de la cible ${video?.width}x${video?.height}`
      );
    }
  } else if (data.profile === "preview") {
    const message =
      `vidéo rendue au profil preview ${data.output.width}x${data.output.height}, ` +
      `inférieur à la cible ${video?.width}x${video?.height}`;

    if (mode === "test") {
      warnings.push(`${message} — non bloquant en mode test`);
    } else {
      errors.push(`${message} — refusé en mode complet`);
    }
  }

  return errors;
}

const AUDITS = {
  final_video: auditFinalVideo,
  envelopes: auditEnvelopes,
  persisted_verdicts: auditPersistedVerdicts,
  structure: auditStructure,
  research_script_mapping: auditResearchScriptMapping,
  script_visual_mapping: auditScriptVisualMapping,
  visual_asset_mapping: auditVisualAssetMapping,
  script_voice_mapping: auditScriptVoiceMapping,
  assembly_source_mapping: auditAssemblySourceMapping,
  titles: auditTitles,
  durations: auditDurations,
  media_files: auditMediaFiles
};

// Contrôles attendus selon le périmètre audité.
export function expectedQualityCheckIds(scope) {
  if (scope === QUALITY_SCOPE_RENDERED) {
    return [
      ...QUALITY_CHECK_IDS,
      ...QUALITY_MEDIA_CHECK_IDS,
      ...QUALITY_RENDER_CHECK_IDS
    ];
  }

  return scope === QUALITY_SCOPE_LOCAL_MEDIA
    ? [...QUALITY_CHECK_IDS, ...QUALITY_MEDIA_CHECK_IDS]
    : QUALITY_CHECK_IDS;
}

// Audite les six artefacts persistés. Ne répare rien, ne rejoue aucun
// modèle. Un contrôle qui ne peut pas s'exécuter sur des données
// corrompues est un contrôle en échec.
//
// mediaVerification est le rapport de recontrôle disque remis par la
// couche média. Absent : l'audit porte sur les contrats seuls, et tout
// média référencé dans les artefacts est alors une incohérence.
//
// renderVerification est le rapport de recontrôle disque du MP4 remis
// par la couche de rendu. Présent : l'audit porte aussi sur la vidéo
// rendue, décrite par l'artefact render.json.
export function auditPipelineArtifacts({
  artifacts,
  target,
  mode,
  mediaVerification,
  renderVerification,
  scriptDurationRange
}) {
  const warnings = [];

  const context = {
    artifacts: isPlainObject(artifacts) ? artifacts : {},
    target,
    mode,
    mediaVerification,
    renderVerification,
    scriptDurationRange
  };

  let scope = QUALITY_SCOPE_CONTRACTS;

  if (renderVerification !== undefined) {
    scope = QUALITY_SCOPE_RENDERED;
  } else if (mediaVerification !== undefined) {
    scope = QUALITY_SCOPE_LOCAL_MEDIA;
  }

  const checks = expectedQualityCheckIds(scope).map(id => {
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
    scope,
    checks,
    warnings
  };
}

// Bloc "media" du rapport : ce que l'audit a réellement contrôlé.
// final_video vaut "not_rendered" tant qu'aucun MP4 n'a été rendu puis
// recontrôlé sur disque ; seul le périmètre "rendered_video" porte
// "rendered".
export function describeMediaScope(artifacts, scope) {
  if (
    scope !== QUALITY_SCOPE_LOCAL_MEDIA &&
    scope !== QUALITY_SCOPE_RENDERED
  ) {
    return {
      scope: QUALITY_SCOPE_CONTRACTS,
      final_video: QUALITY_FINAL_VIDEO
    };
  }

  const units = artifacts.voice.data.narration_units;

  const media = {
    scope: QUALITY_SCOPE_LOCAL_MEDIA,
    final_video: QUALITY_FINAL_VIDEO,
    assets_inspected: artifacts.assets.data.assets.length,
    narration_units_inspected: units.length,
    estimated_narration_seconds: sum(
      units.map(unit => unit.estimated_seconds)
    ),
    measured_narration_seconds: sum(
      units.map(unit => unit.audio.duration_seconds)
    )
  };

  if (scope !== QUALITY_SCOPE_RENDERED) {
    return media;
  }

  return {
    ...media,
    scope: QUALITY_SCOPE_RENDERED,
    final_video: QUALITY_FINAL_VIDEO_RENDERED,
    rendered_duration_seconds:
      artifacts.render.data.summary.rendered_duration_seconds,
    render_profile: artifacts.render.data.profile
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

  const scope = data.media?.scope;

  if (
    !isPlainObject(data.media) ||
    !Object.hasOwn(MEDIA_KEYS_BY_SCOPE, scope ?? "")
  ) {
    errors.push(
      `media: périmètre absent ou invalide — scope doit être ` +
      `"${QUALITY_SCOPE_CONTRACTS}" ou "${QUALITY_SCOPE_LOCAL_MEDIA}"` +
      ` ou "${QUALITY_SCOPE_RENDERED}"`
    );
  } else {
    checkExactKeys(
      data.media,
      MEDIA_KEYS_BY_SCOPE[scope],
      "media",
      errors
    );

    // Seul le périmètre "rendered_video" peut annoncer une vidéo rendue.
    const expectedFinalVideo =
      scope === QUALITY_SCOPE_RENDERED
        ? QUALITY_FINAL_VIDEO_RENDERED
        : QUALITY_FINAL_VIDEO;

    if (data.media.final_video !== expectedFinalVideo) {
      errors.push(
        `media: final_video doit être "${expectedFinalVideo}"`
      );
    }

    for (const key of MEDIA_KEYS_BY_SCOPE[scope].slice(2)) {
      if (key === "render_profile") {
        if (!RENDER_PROFILES.includes(data.media[key])) {
          errors.push(`media: ${key} invalide`);
        }

        continue;
      }

      if (
        !Number.isFinite(data.media[key]) ||
        data.media[key] <= 0
      ) {
        errors.push(`media: ${key} invalide`);
      }
    }
  }

  if (!Array.isArray(data.checks)) {
    errors.push("checks doit être un tableau");
  } else {
    if (
      !isDeepStrictEqual(
        data.checks.map(check => check?.id),
        expectedQualityCheckIds(scope)
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
