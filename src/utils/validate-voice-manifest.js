export const VOICE_STATUS = "unsynthesized";

// Unité rattachée à un fichier audio local inspecté par la couche média.
export const VOICE_STATUS_SYNTHESIZED_LOCAL = "synthesized_local";

const AUDIO_KEYS = [
  "path",
  "container",
  "duration_seconds",
  "audio_codec",
  "sample_rate",
  "channels",
  "size_bytes",
  "sha256"
];

const AUDIO_DIRECTORY = "voice";

const AUDIO_EXTENSIONS = [".wav", ".mp3", ".m4a"];

const MANIFEST_KEYS = [
  "title",
  "narration_units",
  "summary"
];

const UNIT_KEYS = [
  "unit_id",
  "section_index",
  "segment_index",
  "text",
  "estimated_seconds",
  "status"
];

const SUMMARY_KEYS = [
  "total_units",
  "total_estimated_seconds"
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

function isFinitePositiveNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

function isIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function buildUnitId(sectionIndex, segmentIndex) {
  return `s${pad(sectionIndex + 1)}-g${pad(segmentIndex + 1)}`;
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

// Référence locale relative à la racine média : ni URL, ni file://, ni
// chemin absolu, ni remontée de dossier.
function audioPathError(reference, unitId) {
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

  const extension = AUDIO_EXTENSIONS.find(
    candidate => reference.toLowerCase().endsWith(candidate)
  );

  if (!extension) {
    return "path : extension audio non autorisée";
  }

  if (
    reference.slice(0, -extension.length) !==
    `${AUDIO_DIRECTORY}/${unitId}`
  ) {
    return `path doit être ${AUDIO_DIRECTORY}/<unit_id>.<extension>`;
  }

  return null;
}

function validateAudio(unit, label, errors) {
  const audio = unit.audio;

  if (!isPlainObject(audio)) {
    errors.push(
      `${label}: status "${VOICE_STATUS_SYNTHESIZED_LOCAL}" sans audio local inspecté`
    );
    return;
  }

  const audioLabel = `${label}.audio`;

  checkExactKeys(audio, AUDIO_KEYS, audioLabel, errors);

  const pathError = audioPathError(audio.path, unit.unit_id);

  if (pathError) {
    errors.push(`${audioLabel}: ${pathError}`);
  }

  if (!isNonEmptyString(audio.container)) {
    errors.push(`${audioLabel}: container manquant`);
  }

  // Durée MESURÉE du fichier ; estimated_seconds reste l'estimation.
  if (!isFinitePositiveNumber(audio.duration_seconds)) {
    errors.push(`${audioLabel}: duration_seconds invalide`);
  }

  if (!isNonEmptyString(audio.audio_codec)) {
    errors.push(`${audioLabel}: audio_codec manquant`);
  }

  if (
    !Number.isInteger(audio.sample_rate) ||
    audio.sample_rate <= 0
  ) {
    errors.push(`${audioLabel}: sample_rate invalide`);
  }

  if (!Number.isInteger(audio.channels) || audio.channels <= 0) {
    errors.push(`${audioLabel}: channels invalide`);
  }

  if (
    !Number.isInteger(audio.size_bytes) ||
    audio.size_bytes <= 0
  ) {
    errors.push(`${audioLabel}: size_bytes invalide`);
  }

  if (
    typeof audio.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(audio.sha256)
  ) {
    errors.push(`${audioLabel}: sha256 invalide`);
  }
}

function validateUnit(unit, label, errors) {
  if (!isPlainObject(unit)) {
    errors.push(`${label}: unité absente ou invalide`);
    return;
  }

  // Le bloc audio n'existe que dans l'état synthesized_local.
  const synthesized =
    unit.status === VOICE_STATUS_SYNTHESIZED_LOCAL;

  checkExactKeys(
    unit,
    synthesized ? [...UNIT_KEYS, "audio"] : UNIT_KEYS,
    label,
    errors
  );

  if (!isIndex(unit.section_index)) {
    errors.push(`${label}: section_index invalide`);
  }

  if (!isIndex(unit.segment_index)) {
    errors.push(`${label}: segment_index invalide`);
  }

  if (!isNonEmptyString(unit.unit_id)) {
    errors.push(`${label}: unit_id manquant`);
  } else if (
    !isIndex(unit.section_index) ||
    !isIndex(unit.segment_index) ||
    unit.unit_id !== buildUnitId(
      unit.section_index,
      unit.segment_index
    )
  ) {
    errors.push(
      `${label}: unit_id incohérent avec section_index/segment_index`
    );
  }

  if (!isNonEmptyString(unit.text)) {
    errors.push(`${label}: text manquant`);
  }

  if (!isFinitePositiveNumber(unit.estimated_seconds)) {
    errors.push(`${label}: estimated_seconds invalide`);
  }

  if (synthesized) {
    validateAudio(unit, label, errors);
  } else if (unit.status !== VOICE_STATUS) {
    errors.push(
      `${label}: status doit être "${VOICE_STATUS}" ou "${VOICE_STATUS_SYNTHESIZED_LOCAL}"`
    );
  }
}

function comparePosition(left, right) {
  return (
    left.section_index - right.section_index ||
    left.segment_index - right.segment_index
  );
}

export function summarizeNarration(units) {
  let totalEstimatedSeconds = 0;

  for (const unit of units) {
    totalEstimatedSeconds += unit.estimated_seconds;
  }

  return {
    total_units: units.length,
    total_estimated_seconds: totalEstimatedSeconds
  };
}

export function validateVoiceManifest(data) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(data)) {
    return {
      valid: false,
      errors: ["Voice manifest absent ou invalide"],
      warnings
    };
  }

  checkExactKeys(data, MANIFEST_KEYS, "manifest", errors);

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  if (
    !Array.isArray(data.narration_units) ||
    data.narration_units.length === 0
  ) {
    errors.push(
      "narration_units doit être un tableau non vide"
    );

    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.narration_units.forEach((unit, index) => {
    validateUnit(unit, `narration_units[${index}]`, errors);
  });

  // Tout ou rien : un manifeste est entièrement à synthétiser ou
  // entièrement rattaché à des fichiers audio locaux.
  const synthesizedCount = data.narration_units.filter(
    unit => unit?.status === VOICE_STATUS_SYNTHESIZED_LOCAL
  ).length;

  if (
    synthesizedCount > 0 &&
    synthesizedCount < data.narration_units.length
  ) {
    errors.push(
      `synthèse partielle interdite : ${synthesizedCount} unité(s) sur ${data.narration_units.length}`
    );
  }

  const seenIds = new Set();

  data.narration_units.forEach((unit, index) => {
    if (!isNonEmptyString(unit?.unit_id)) {
      return;
    }

    if (seenIds.has(unit.unit_id)) {
      errors.push(
        `narration_units[${index}]: unit_id dupliqué ${unit.unit_id}`
      );
    }

    seenIds.add(unit.unit_id);
  });

  // Le résumé et l'ordre ne sont vérifiables que sur des unités valides.
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings
    };
  }

  for (
    let index = 1;
    index < data.narration_units.length;
    index += 1
  ) {
    if (
      comparePosition(
        data.narration_units[index - 1],
        data.narration_units[index]
      ) >= 0
    ) {
      errors.push(
        `narration_units[${index}]: ordre section/segment non strictement croissant`
      );
    }
  }

  if (!isPlainObject(data.summary)) {
    errors.push("summary absent ou invalide");

    return {
      valid: false,
      errors,
      warnings
    };
  }

  checkExactKeys(data.summary, SUMMARY_KEYS, "summary", errors);

  const expected = summarizeNarration(data.narration_units);

  if (data.summary.total_units !== expected.total_units) {
    errors.push("summary: total_units incorrect");
  }

  if (
    data.summary.total_estimated_seconds !==
    expected.total_estimated_seconds
  ) {
    errors.push("summary: total_estimated_seconds incorrect");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function listSourceSegments(script) {
  const segments = [];

  script.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      segments.push({
        sectionIndex,
        segmentIndex,
        segment
      });
    });
  });

  return segments;
}

// Script Mapping Gate : le manifeste doit refléter le script source
// segment pour segment, dans le même ordre, sans aucune reformulation.
export function validateVoiceManifestMapping(manifest, script) {
  const errors = [];

  if (
    !isPlainObject(manifest) ||
    !Array.isArray(manifest.narration_units)
  ) {
    return {
      valid: false,
      errors: ["Voice manifest absent ou invalide"]
    };
  }

  if (
    !isPlainObject(script) ||
    !Array.isArray(script.sections)
  ) {
    return {
      valid: false,
      errors: ["Script source absent ou invalide"]
    };
  }

  if (manifest.title !== script.title) {
    errors.push("title différent du script source");
  }

  const sourceSegments = listSourceSegments(script);
  const units = manifest.narration_units;

  if (units.length < sourceSegments.length) {
    errors.push(
      `unité manquante : ${units.length} unités pour ${sourceSegments.length} segments`
    );
  }

  if (units.length > sourceSegments.length) {
    errors.push(
      `unité supplémentaire : ${units.length} unités pour ${sourceSegments.length} segments`
    );
  }

  const comparable = Math.min(
    units.length,
    sourceSegments.length
  );

  for (let index = 0; index < comparable; index += 1) {
    const unit = units[index];
    const source = sourceSegments[index];
    const label = `narration_units[${index}]`;

    if (!isPlainObject(unit)) {
      errors.push(`${label}: unité absente ou invalide`);
      continue;
    }

    if (
      unit.section_index !== source.sectionIndex ||
      unit.segment_index !== source.segmentIndex
    ) {
      errors.push(
        `${label}: position différente du segment source ` +
        `sections[${source.sectionIndex}].segments[${source.segmentIndex}]`
      );
    }

    if (unit.text !== source.segment.voiceover) {
      errors.push(
        `${label}: text différent du voiceover source`
      );
    }

    if (
      unit.estimated_seconds !==
      source.segment.estimated_seconds
    ) {
      errors.push(
        `${label}: estimated_seconds différent du segment source`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
