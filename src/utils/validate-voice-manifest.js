export const VOICE_STATUS = "unsynthesized";

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

function validateUnit(unit, label, errors) {
  if (!isPlainObject(unit)) {
    errors.push(`${label}: unité absente ou invalide`);
    return;
  }

  checkExactKeys(unit, UNIT_KEYS, label, errors);

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

  if (unit.status !== VOICE_STATUS) {
    errors.push(
      `${label}: status doit être "${VOICE_STATUS}"`
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
