import { isDeepStrictEqual } from "node:util";

import { buildUnitId } from "./validate-voice-manifest.js";

export const ASSEMBLY_STATUS = "unrendered";

const PLAN_KEYS = [
  "title",
  "output",
  "video_track",
  "audio_track",
  "summary",
  "status"
];

export const OUTPUT_KEYS = [
  "width",
  "height",
  "fps",
  "aspect_ratio"
];

const CLIP_KEYS = [
  "asset_id",
  "unit_id",
  "start_seconds",
  "end_seconds",
  "duration_seconds"
];

const AUDIO_KEYS = [
  "unit_id",
  "start_seconds",
  "end_seconds",
  "duration_seconds"
];

const SUMMARY_KEYS = [
  "total_clips",
  "total_units",
  "total_duration_seconds"
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// Les positions de timeline sont exprimées en secondes, à la
// milliseconde : les cumuls ne dérivent pas avec des durées décimales.
export function roundTime(seconds) {
  return Math.round(seconds * 1000) / 1000;
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

export function validateOutputSpec(output, label = "output") {
  const errors = [];

  if (!isPlainObject(output)) {
    return [`${label} absent ou invalide`];
  }

  checkExactKeys(output, OUTPUT_KEYS, label, errors);

  if (!isPositiveInteger(output.width)) {
    errors.push(`${label}: width invalide`);
  }

  if (!isPositiveInteger(output.height)) {
    errors.push(`${label}: height invalide`);
  }

  if (!isFiniteNumber(output.fps) || output.fps <= 0) {
    errors.push(`${label}: fps invalide`);
  }

  const ratio =
    typeof output.aspect_ratio === "string"
      ? output.aspect_ratio.match(/^(\d+):(\d+)$/)
      : null;

  if (!ratio) {
    errors.push(`${label}: aspect_ratio invalide`);
  } else if (
    isPositiveInteger(output.width) &&
    isPositiveInteger(output.height) &&
    output.width * Number(ratio[2]) !==
      output.height * Number(ratio[1])
  ) {
    errors.push(
      `${label}: aspect_ratio incohérent avec width/height`
    );
  }

  return errors;
}

function validateTrackItem(item, keys, idField, label, errors) {
  if (!isPlainObject(item)) {
    errors.push(`${label}: élément absent ou invalide`);
    return;
  }

  checkExactKeys(item, keys, label, errors);

  for (const field of idField) {
    if (!isNonEmptyString(item[field])) {
      errors.push(`${label}: ${field} manquant`);
    }
  }

  if (
    !isFiniteNumber(item.start_seconds) ||
    item.start_seconds < 0
  ) {
    errors.push(`${label}: start_seconds invalide`);
  }

  if (
    !isFiniteNumber(item.duration_seconds) ||
    item.duration_seconds <= 0
  ) {
    errors.push(`${label}: duration_seconds invalide`);
  }

  if (!isFiniteNumber(item.end_seconds)) {
    errors.push(`${label}: end_seconds invalide`);
  } else if (
    isFiniteNumber(item.start_seconds) &&
    isFiniteNumber(item.duration_seconds) &&
    item.end_seconds !==
      roundTime(item.start_seconds + item.duration_seconds)
  ) {
    errors.push(
      `${label}: end_seconds différent de start_seconds + duration_seconds`
    );
  }
}

function checkContiguity(track, name, errors) {
  if (track[0].start_seconds !== 0) {
    errors.push(`${name}[0]: la piste doit commencer à 0`);
  }

  for (let index = 1; index < track.length; index += 1) {
    const previousEnd = track[index - 1].end_seconds;
    const start = track[index].start_seconds;

    if (start > previousEnd) {
      errors.push(
        `${name}[${index}]: trou entre ${previousEnd}s et ${start}s`
      );
    }

    if (start < previousEnd) {
      errors.push(
        `${name}[${index}]: chevauchement entre ${start}s et ${previousEnd}s`
      );
    }
  }
}

function checkUnique(track, field, name, errors) {
  const seen = new Set();

  track.forEach((item, index) => {
    if (seen.has(item[field])) {
      errors.push(
        `${name}[${index}]: ${field} dupliqué ${item[field]}`
      );
    }

    seen.add(item[field]);
  });
}

export function validateAssemblyPlan(data) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(data)) {
    return {
      valid: false,
      errors: ["Assembly plan absent ou invalide"],
      warnings
    };
  }

  checkExactKeys(data, PLAN_KEYS, "plan", errors);

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  errors.push(...validateOutputSpec(data.output));

  if (data.status !== ASSEMBLY_STATUS) {
    errors.push(`status doit être "${ASSEMBLY_STATUS}"`);
  }

  for (const name of ["video_track", "audio_track"]) {
    if (
      !Array.isArray(data[name]) ||
      data[name].length === 0
    ) {
      errors.push(`${name} doit être un tableau non vide`);
    }
  }

  if (
    !Array.isArray(data.video_track) ||
    data.video_track.length === 0 ||
    !Array.isArray(data.audio_track) ||
    data.audio_track.length === 0
  ) {
    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.video_track.forEach((clip, index) => {
    validateTrackItem(
      clip,
      CLIP_KEYS,
      ["asset_id", "unit_id"],
      `video_track[${index}]`,
      errors
    );
  });

  data.audio_track.forEach((unit, index) => {
    validateTrackItem(
      unit,
      AUDIO_KEYS,
      ["unit_id"],
      `audio_track[${index}]`,
      errors
    );
  });

  // Continuité, couverture et résumé ne sont vérifiables que sur des
  // éléments de piste valides.
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings
    };
  }

  checkContiguity(data.video_track, "video_track", errors);
  checkContiguity(data.audio_track, "audio_track", errors);

  checkUnique(data.video_track, "asset_id", "video_track", errors);
  checkUnique(data.audio_track, "unit_id", "audio_track", errors);

  const audioIds = data.audio_track.map(unit => unit.unit_id);

  data.video_track.forEach((clip, index) => {
    if (!audioIds.includes(clip.unit_id)) {
      errors.push(
        `video_track[${index}]: unit_id ${clip.unit_id} absent de audio_track`
      );
    }
  });

  // Suite des unités telle que la piste vidéo les parcourt.
  const videoUnitOrder = [];

  for (const clip of data.video_track) {
    if (videoUnitOrder.at(-1) !== clip.unit_id) {
      videoUnitOrder.push(clip.unit_id);
    }
  }

  if (!isDeepStrictEqual(videoUnitOrder, audioIds)) {
    errors.push(
      "ordre ou couverture des unités différent entre video_track et audio_track"
    );
  }

  data.audio_track.forEach((unit, index) => {
    const clips = data.video_track.filter(
      clip => clip.unit_id === unit.unit_id
    );

    if (clips.length === 0) {
      errors.push(
        `audio_track[${index}]: aucune image pour l'unité ${unit.unit_id}`
      );
      return;
    }

    const videoStart = clips[0].start_seconds;
    const videoEnd = clips.at(-1).end_seconds;

    if (
      videoStart !== unit.start_seconds ||
      videoEnd !== unit.end_seconds
    ) {
      errors.push(
        `audio_track[${index}]: fenêtre vidéo ${videoStart}s–${videoEnd}s ` +
        `différente de la fenêtre narration ${unit.start_seconds}s–${unit.end_seconds}s`
      );
    }
  });

  if (!isPlainObject(data.summary)) {
    errors.push("summary absent ou invalide");

    return {
      valid: false,
      errors,
      warnings
    };
  }

  checkExactKeys(data.summary, SUMMARY_KEYS, "summary", errors);

  const videoEnd = data.video_track.at(-1).end_seconds;
  const audioEnd = data.audio_track.at(-1).end_seconds;

  if (videoEnd !== audioEnd) {
    errors.push(
      `durée vidéo ${videoEnd}s différente de la durée narration ${audioEnd}s`
    );
  }

  if (data.summary.total_clips !== data.video_track.length) {
    errors.push("summary: total_clips incorrect");
  }

  if (data.summary.total_units !== data.audio_track.length) {
    errors.push("summary: total_units incorrect");
  }

  if (data.summary.total_duration_seconds !== videoEnd) {
    errors.push("summary: total_duration_seconds incorrect");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function compareCount(actual, expected, labels, errors) {
  if (actual < expected) {
    errors.push(
      `${labels.missing} : ${actual} ${labels.plural} pour ${expected} attendus`
    );
  }

  if (actual > expected) {
    errors.push(
      `${labels.extra} : ${actual} ${labels.plural} pour ${expected} attendus`
    );
  }
}

// Source Mapping Gate : le plan doit utiliser chaque asset et chaque
// unité de narration exactement une fois, dans l'ordre et avec les
// durées des manifestes sources.
export function validateAssemblySourceMapping(
  plan,
  assets,
  voice,
  target
) {
  const errors = [];

  if (
    !isPlainObject(plan) ||
    !Array.isArray(plan.video_track) ||
    !Array.isArray(plan.audio_track)
  ) {
    return {
      valid: false,
      errors: ["Assembly plan absent ou invalide"]
    };
  }

  if (
    !isPlainObject(assets) ||
    !Array.isArray(assets.assets)
  ) {
    return {
      valid: false,
      errors: ["Asset manifest source absent ou invalide"]
    };
  }

  if (
    !isPlainObject(voice) ||
    !Array.isArray(voice.narration_units)
  ) {
    return {
      valid: false,
      errors: ["Voice manifest source absent ou invalide"]
    };
  }

  if (!isPlainObject(target)) {
    return {
      valid: false,
      errors: ["Spécification de sortie cible absente ou invalide"]
    };
  }

  if (plan.title !== assets.title) {
    errors.push("title différent du manifeste d'assets source");
  }

  if (plan.title !== voice.title) {
    errors.push("title différent du manifeste voice source");
  }

  for (const key of OUTPUT_KEYS) {
    if (plan.output?.[key] !== target[key]) {
      errors.push(`output.${key} différent de la cible de production`);
    }
  }

  compareCount(
    plan.video_track.length,
    assets.assets.length,
    {
      missing: "clip manquant",
      extra: "clip supplémentaire",
      plural: "clips"
    },
    errors
  );

  const comparableClips = Math.min(
    plan.video_track.length,
    assets.assets.length
  );

  for (let index = 0; index < comparableClips; index += 1) {
    const clip = plan.video_track[index];
    const asset = assets.assets[index];
    const label = `video_track[${index}]`;

    if (!isPlainObject(clip) || !isPlainObject(asset)) {
      errors.push(`${label}: clip ou asset source invalide`);
      continue;
    }

    if (clip.asset_id !== asset.asset_id) {
      errors.push(`${label}: asset_id différent de l'asset source`);
    }

    if (clip.duration_seconds !== asset.duration_seconds) {
      errors.push(
        `${label}: duration_seconds différent de l'asset source`
      );
    }

    if (
      clip.unit_id !== buildUnitId(
        asset.section_index,
        asset.segment_index
      )
    ) {
      errors.push(
        `${label}: unit_id différent du segment de l'asset source`
      );
    }
  }

  compareCount(
    plan.audio_track.length,
    voice.narration_units.length,
    {
      missing: "unité manquante",
      extra: "unité supplémentaire",
      plural: "unités"
    },
    errors
  );

  const comparableUnits = Math.min(
    plan.audio_track.length,
    voice.narration_units.length
  );

  for (let index = 0; index < comparableUnits; index += 1) {
    const item = plan.audio_track[index];
    const unit = voice.narration_units[index];
    const label = `audio_track[${index}]`;

    if (!isPlainObject(item) || !isPlainObject(unit)) {
      errors.push(`${label}: unité ou unité source invalide`);
      continue;
    }

    if (item.unit_id !== unit.unit_id) {
      errors.push(`${label}: unit_id différent de l'unité source`);
    }

    if (item.duration_seconds !== unit.estimated_seconds) {
      errors.push(
        `${label}: duration_seconds différent de l'unité source`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
