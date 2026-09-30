import { isDeepStrictEqual } from "node:util";

// Validateur de render.json — ce qui a RÉELLEMENT été rendu.
//
// assembly.json reste le plan ("unrendered") ; render.json décrit le
// fichier produit et la timeline réellement appliquée. Validateur pur :
// il ne lit aucun fichier et ne lance aucun programme.

export const RENDER_STAGE = "render";
export const RENDER_STATUS = "rendered";
export const RENDER_PROFILES = ["target", "preview"];

// Écart maximal admis, en secondes, entre durée attendue et durée
// sondée, et entre flux vidéo et audio : arrondis d'image et d'AAC.
export const RENDER_DURATION_TOLERANCE = 0.2;

// Arrondi à la milliseconde des positions de timeline.
const TIME_EPSILON = 0.002;

const REPORT_KEYS = [
  "title",
  "profile",
  "output",
  "video_track",
  "audio_track",
  "summary",
  "status"
];

const OUTPUT_KEYS = [
  "path",
  "container",
  "width",
  "height",
  "fps",
  "video_codec",
  "audio_codec",
  "duration_seconds",
  "size_bytes",
  "sha256"
];

const CLIP_KEYS = [
  "asset_id",
  "unit_id",
  "start_seconds",
  "end_seconds",
  "duration_seconds",
  "source"
];

const AUDIO_KEYS = [
  "unit_id",
  "start_seconds",
  "end_seconds",
  "duration_seconds",
  "source"
];

const SUMMARY_KEYS = [
  "total_clips",
  "total_units",
  "planned_duration_seconds",
  "rendered_duration_seconds"
];

const PREVIEW = { width: 640, height: 360 };

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

function isPositive(value) {
  return isFiniteNumber(value) && value > 0;
}

function close(left, right) {
  return Math.abs(left - right) <= TIME_EPSILON;
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

// Nom du fichier rendu, relatif au dossier de sortie : un simple nom
// de fichier .mp4, sans dossier, sans URL, sans remontée.
export function outputNameError(name) {
  if (!isNonEmptyString(name)) {
    return "path manquant";
  }

  if (
    /^[a-z][a-z0-9+.-]*:/i.test(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".")
  ) {
    return "path doit être un simple nom de fichier, sans dossier ni URL";
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.mp4$/.test(name)) {
    return "path doit être un nom de fichier .mp4";
  }

  return null;
}

// Référence vers un média source, relative à la racine média.
function sourcePathError(reference, directory) {
  if (!isNonEmptyString(reference)) {
    return "path manquant";
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return "path ne doit pas être une URL ni une référence distante";
  }

  if (reference.startsWith("/") || reference.includes("\\")) {
    return "path ne doit pas être un chemin absolu";
  }

  const segments = reference.split("/");

  if (
    segments.some(
      segment =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    return "path ne doit contenir ni remontée ni segment vide";
  }

  if (segments.length !== 2 || segments[0] !== directory) {
    return `path doit être ${directory}/<fichier>`;
  }

  return null;
}

function validateOutput(output, profile, errors) {
  if (!isPlainObject(output)) {
    errors.push("output absent ou invalide");
    return;
  }

  checkExactKeys(output, OUTPUT_KEYS, "output", errors);

  const pathError = outputNameError(output.path);

  if (pathError) {
    errors.push(`output: ${pathError}`);
  }

  if (
    !isNonEmptyString(output.container) ||
    !output.container.split(",").includes("mp4")
  ) {
    errors.push("output: container doit être un MP4");
  }

  for (const key of ["width", "height"]) {
    if (
      !Number.isInteger(output[key]) ||
      output[key] <= 0 ||
      output[key] % 2 !== 0
    ) {
      errors.push(`output: ${key} invalide`);
    }
  }

  if (!isPositive(output.fps)) {
    errors.push("output: fps invalide");
  }

  if (output.video_codec !== "h264") {
    errors.push("output: video_codec doit être h264");
  }

  if (output.audio_codec !== "aac") {
    errors.push("output: audio_codec doit être aac");
  }

  if (!isPositive(output.duration_seconds)) {
    errors.push("output: duration_seconds invalide");
  }

  if (
    !Number.isInteger(output.size_bytes) ||
    output.size_bytes <= 0
  ) {
    errors.push("output: size_bytes invalide");
  }

  if (
    typeof output.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(output.sha256)
  ) {
    errors.push("output: sha256 invalide");
  }

  if (
    profile === "preview" &&
    (
      output.width !== PREVIEW.width ||
      output.height !== PREVIEW.height
    )
  ) {
    errors.push(
      `output: dimensions différentes du profil preview ${PREVIEW.width}x${PREVIEW.height}`
    );
  }
}

function validateTrackItem(item, keys, spec, label, errors) {
  if (!isPlainObject(item)) {
    errors.push(`${label}: élément absent ou invalide`);
    return;
  }

  checkExactKeys(item, keys, label, errors);

  for (const field of spec.ids) {
    if (!isNonEmptyString(item[field])) {
      errors.push(`${label}: ${field} manquant`);
    }
  }

  if (!isFiniteNumber(item.start_seconds) || item.start_seconds < 0) {
    errors.push(`${label}: start_seconds invalide`);
  }

  if (!isPositive(item.duration_seconds)) {
    errors.push(`${label}: duration_seconds invalide`);
  }

  if (!isFiniteNumber(item.end_seconds)) {
    errors.push(`${label}: end_seconds invalide`);
  } else if (
    isFiniteNumber(item.start_seconds) &&
    isPositive(item.duration_seconds) &&
    !close(
      item.end_seconds,
      item.start_seconds + item.duration_seconds
    )
  ) {
    errors.push(
      `${label}: end_seconds différent de start_seconds + duration_seconds`
    );
  }

  if (!isPlainObject(item.source)) {
    errors.push(`${label}: source absente ou invalide`);
    return;
  }

  checkExactKeys(
    item.source,
    spec.sourceKeys,
    `${label}.source`,
    errors
  );

  const pathError = sourcePathError(item.source.path, spec.directory);

  if (pathError) {
    errors.push(`${label}.source: ${pathError}`);
  }

  if (
    spec.sourceKeys.includes("kind") &&
    !["video", "image"].includes(item.source.kind)
  ) {
    errors.push(`${label}.source: kind invalide`);
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

export function validateRenderReport(data) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(data)) {
    return {
      valid: false,
      errors: ["Render report absent ou invalide"],
      warnings
    };
  }

  checkExactKeys(data, REPORT_KEYS, "report", errors);

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  if (!RENDER_PROFILES.includes(data.profile)) {
    errors.push("profile invalide");
  }

  if (data.status !== RENDER_STATUS) {
    errors.push(`status doit être "${RENDER_STATUS}"`);
  }

  validateOutput(data.output, data.profile, errors);

  for (const name of ["video_track", "audio_track"]) {
    if (!Array.isArray(data[name]) || data[name].length === 0) {
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
      {
        ids: ["asset_id", "unit_id"],
        sourceKeys: ["path", "kind"],
        directory: "assets"
      },
      `video_track[${index}]`,
      errors
    );
  });

  data.audio_track.forEach((unit, index) => {
    validateTrackItem(
      unit,
      AUDIO_KEYS,
      {
        ids: ["unit_id"],
        sourceKeys: ["path"],
        directory: "voice"
      },
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
      return;
    }

    if (
      clips[0].start_seconds !== unit.start_seconds ||
      clips.at(-1).end_seconds !== unit.end_seconds
    ) {
      errors.push(
        `audio_track[${index}]: fenêtre vidéo ` +
        `${clips[0].start_seconds}s–${clips.at(-1).end_seconds}s ` +
        `différente de la fenêtre audio ${unit.start_seconds}s–${unit.end_seconds}s`
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

  if (data.audio_track.at(-1).end_seconds !== videoEnd) {
    errors.push("durée vidéo différente de la durée audio");
  }

  if (data.summary.total_clips !== data.video_track.length) {
    errors.push("summary: total_clips incorrect");
  }

  if (data.summary.total_units !== data.audio_track.length) {
    errors.push("summary: total_units incorrect");
  }

  if (!isPositive(data.summary.planned_duration_seconds)) {
    errors.push("summary: planned_duration_seconds invalide");
  }

  if (data.summary.rendered_duration_seconds !== videoEnd) {
    errors.push("summary: rendered_duration_seconds incorrect");
  }

  if (
    isPlainObject(data.output) &&
    isPositive(data.output.duration_seconds) &&
    Math.abs(data.output.duration_seconds - videoEnd) >
      RENDER_DURATION_TOLERANCE
  ) {
    errors.push(
      `output: durée du fichier ${data.output.duration_seconds}s ` +
      `à plus de ${RENDER_DURATION_TOLERANCE}s de la timeline ${videoEnd}s`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// Le rendu doit suivre le plan de montage : mêmes clips, mêmes unités,
// mêmes médias, dans le même ordre. Seules les durées changent, calées
// sur l'audio mesuré — jamais plus court que lui, et au plus une image
// de plus.
export function validateRenderPlanMapping(render, assembly) {
  const errors = [];

  if (
    !isPlainObject(render) ||
    !Array.isArray(render.video_track) ||
    !Array.isArray(render.audio_track) ||
    !isPlainObject(render.output)
  ) {
    return {
      valid: false,
      errors: ["Render report absent ou invalide"]
    };
  }

  if (
    !isPlainObject(assembly) ||
    !Array.isArray(assembly.video_track) ||
    !Array.isArray(assembly.audio_track)
  ) {
    return {
      valid: false,
      errors: ["Plan de montage source absent ou invalide"]
    };
  }

  if (render.title !== assembly.title) {
    errors.push("title différent du plan de montage");
  }

  if (
    render.summary?.planned_duration_seconds !==
    assembly.summary?.total_duration_seconds
  ) {
    errors.push(
      "summary: planned_duration_seconds différent du plan de montage"
    );
  }

  if (
    render.profile === "target" &&
    (
      render.output.width !== assembly.output?.width ||
      render.output.height !== assembly.output?.height
    )
  ) {
    errors.push(
      "output: dimensions différentes de la cible du plan de montage"
    );
  }

  if (render.output.fps !== assembly.output?.fps) {
    errors.push(
      "output: cadence différente de la cible du plan de montage"
    );
  }

  if (render.video_track.length !== assembly.video_track.length) {
    errors.push(
      `${render.video_track.length} clip(s) rendu(s) pour ${assembly.video_track.length} prévu(s)`
    );
  }

  const comparableClips = Math.min(
    render.video_track.length,
    assembly.video_track.length
  );

  for (let index = 0; index < comparableClips; index += 1) {
    const clip = render.video_track[index];
    const planned = assembly.video_track[index];
    const label = `video_track[${index}]`;

    if (
      clip?.asset_id !== planned?.asset_id ||
      clip?.unit_id !== planned?.unit_id
    ) {
      errors.push(`${label}: clip différent du plan de montage`);
    }

    if (
      clip?.source?.path !== planned?.media?.path ||
      clip?.source?.kind !== planned?.media?.kind
    ) {
      errors.push(`${label}: source différente du média du plan`);
    }
  }

  if (render.audio_track.length !== assembly.audio_track.length) {
    errors.push(
      `${render.audio_track.length} unité(s) rendue(s) pour ${assembly.audio_track.length} prévue(s)`
    );
  }

  const comparableUnits = Math.min(
    render.audio_track.length,
    assembly.audio_track.length
  );

  const frame = isPositive(render.output.fps)
    ? 1 / render.output.fps
    : 0;

  for (let index = 0; index < comparableUnits; index += 1) {
    const unit = render.audio_track[index];
    const planned = assembly.audio_track[index];
    const label = `audio_track[${index}]`;

    if (unit?.unit_id !== planned?.unit_id) {
      errors.push(`${label}: unité différente du plan de montage`);
    }

    if (unit?.source?.path !== planned?.audio?.path) {
      errors.push(`${label}: source différente de l'audio du plan`);
    }

    const measured = planned?.audio?.duration_seconds;

    if (!isPositive(measured) || !isPositive(unit?.duration_seconds)) {
      errors.push(`${label}: durée audio mesurée indisponible`);
      continue;
    }

    if (unit.duration_seconds < measured - TIME_EPSILON) {
      errors.push(
        `${label}: fenêtre ${unit.duration_seconds}s plus courte que l'audio mesuré ${measured}s — narration coupée`
      );
    }

    if (unit.duration_seconds > measured + frame + TIME_EPSILON) {
      errors.push(
        `${label}: fenêtre ${unit.duration_seconds}s plus longue que l'audio mesuré ${measured}s de plus d'une image`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
