import { isDeepStrictEqual } from "node:util";

export const ASSET_TYPES = [
  "stock_video",
  "map",
  "graphic",
  "archive",
  "generated"
];

export const ASSET_STATUS = "unresolved";

const MANIFEST_KEYS = [
  "title",
  "assets",
  "summary"
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

const SUMMARY_KEYS = [
  "total_assets",
  "total_duration_seconds",
  "by_type"
];

// Champs recopiés à l'identique depuis le shot source.
const COPIED_FIELDS = [
  "asset_type",
  "duration_seconds",
  "visual_description",
  "asset_query",
  "requires_exact_location",
  "research_fact_refs"
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

function containsUrl(value) {
  return /https?:\/\//i.test(value);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function buildAssetId(
  sectionIndex,
  segmentIndex,
  shotOrder
) {
  return (
    `s${pad(sectionIndex + 1)}-` +
    `g${pad(segmentIndex + 1)}-` +
    `sh${pad(shotOrder)}`
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

function validateAsset(asset, label, errors) {
  if (!isPlainObject(asset)) {
    errors.push(`${label}: asset absent ou invalide`);
    return;
  }

  checkExactKeys(asset, ASSET_KEYS, label, errors);

  if (!isIndex(asset.section_index)) {
    errors.push(`${label}: section_index invalide`);
  }

  if (!isIndex(asset.segment_index)) {
    errors.push(`${label}: segment_index invalide`);
  }

  if (
    !Number.isInteger(asset.shot_order) ||
    asset.shot_order < 1
  ) {
    errors.push(`${label}: shot_order invalide`);
  }

  if (!isNonEmptyString(asset.asset_id)) {
    errors.push(`${label}: asset_id manquant`);
  } else if (
    !isIndex(asset.section_index) ||
    !isIndex(asset.segment_index) ||
    !Number.isInteger(asset.shot_order) ||
    asset.asset_id !== buildAssetId(
      asset.section_index,
      asset.segment_index,
      asset.shot_order
    )
  ) {
    errors.push(
      `${label}: asset_id incohérent avec section_index/segment_index/shot_order`
    );
  }

  if (!ASSET_TYPES.includes(asset.asset_type)) {
    errors.push(`${label}: asset_type invalide`);
  }

  if (!isFinitePositiveNumber(asset.duration_seconds)) {
    errors.push(`${label}: duration_seconds invalide`);
  }

  if (!isNonEmptyString(asset.visual_description)) {
    errors.push(`${label}: visual_description manquant`);
  } else if (containsUrl(asset.visual_description)) {
    errors.push(`${label}: visual_description contient une URL`);
  }

  if (!isNonEmptyString(asset.asset_query)) {
    errors.push(`${label}: asset_query manquant`);
  } else if (containsUrl(asset.asset_query)) {
    errors.push(`${label}: asset_query contient une URL`);
  }

  if (typeof asset.requires_exact_location !== "boolean") {
    errors.push(
      `${label}: requires_exact_location doit être booléen`
    );
  }

  if (!Array.isArray(asset.research_fact_refs)) {
    errors.push(
      `${label}: research_fact_refs doit être un tableau`
    );
  } else if (
    asset.research_fact_refs.some(ref => !isIndex(ref))
  ) {
    errors.push(`${label}: research_fact_refs invalide`);
  }

  if (asset.status !== ASSET_STATUS) {
    errors.push(
      `${label}: status doit être "${ASSET_STATUS}"`
    );
  }
}

function comparePosition(left, right) {
  return (
    left.section_index - right.section_index ||
    left.segment_index - right.segment_index ||
    left.shot_order - right.shot_order
  );
}

export function summarizeAssets(assets) {
  const byType = Object.fromEntries(
    ASSET_TYPES.map(type => [type, 0])
  );

  let totalDurationSeconds = 0;

  for (const asset of assets) {
    totalDurationSeconds += asset.duration_seconds;
    byType[asset.asset_type] += 1;
  }

  return {
    total_assets: assets.length,
    total_duration_seconds: totalDurationSeconds,
    by_type: byType
  };
}

export function validateAssetManifest(data) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(data)) {
    return {
      valid: false,
      errors: ["Asset manifest absent ou invalide"],
      warnings
    };
  }

  checkExactKeys(data, MANIFEST_KEYS, "manifest", errors);

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  if (
    !Array.isArray(data.assets) ||
    data.assets.length === 0
  ) {
    errors.push("assets doit être un tableau non vide");

    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.assets.forEach((asset, index) => {
    validateAsset(asset, `assets[${index}]`, errors);
  });

  const seenIds = new Set();

  data.assets.forEach((asset, index) => {
    if (!isNonEmptyString(asset?.asset_id)) {
      return;
    }

    if (seenIds.has(asset.asset_id)) {
      errors.push(
        `assets[${index}]: asset_id dupliqué ${asset.asset_id}`
      );
    }

    seenIds.add(asset.asset_id);
  });

  // Le résumé et l'ordre ne sont vérifiables que sur des assets valides.
  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      warnings
    };
  }

  for (let index = 1; index < data.assets.length; index += 1) {
    if (
      comparePosition(
        data.assets[index - 1],
        data.assets[index]
      ) >= 0
    ) {
      errors.push(
        `assets[${index}]: ordre section/segment/shot non strictement croissant`
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

  const expected = summarizeAssets(data.assets);

  if (data.summary.total_assets !== expected.total_assets) {
    errors.push("summary: total_assets incorrect");
  }

  if (
    data.summary.total_duration_seconds !==
    expected.total_duration_seconds
  ) {
    errors.push("summary: total_duration_seconds incorrect");
  }

  if (
    !isPlainObject(data.summary.by_type) ||
    !isDeepStrictEqual(data.summary.by_type, expected.by_type)
  ) {
    errors.push("summary: by_type incorrect");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

function listSourceShots(visual) {
  const shots = [];

  visual.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      segment.shots.forEach(shot => {
        shots.push({
          sectionIndex,
          segmentIndex,
          shot
        });
      });
    });
  });

  return shots;
}

// Visual Mapping Gate : le manifeste doit refléter le plan visuel source
// shot pour shot, dans le même ordre, sans aucune réécriture.
export function validateAssetManifestMapping(manifest, visual) {
  const errors = [];

  if (
    !isPlainObject(manifest) ||
    !Array.isArray(manifest.assets)
  ) {
    return {
      valid: false,
      errors: ["Asset manifest absent ou invalide"]
    };
  }

  if (
    !isPlainObject(visual) ||
    !Array.isArray(visual.sections)
  ) {
    return {
      valid: false,
      errors: ["Plan visuel source absent ou invalide"]
    };
  }

  if (manifest.title !== visual.title) {
    errors.push("title différent du plan visuel source");
  }

  const sourceShots = listSourceShots(visual);

  if (manifest.assets.length < sourceShots.length) {
    errors.push(
      `asset manquant : ${manifest.assets.length} assets pour ${sourceShots.length} shots`
    );
  }

  if (manifest.assets.length > sourceShots.length) {
    errors.push(
      `asset supplémentaire : ${manifest.assets.length} assets pour ${sourceShots.length} shots`
    );
  }

  const comparable = Math.min(
    manifest.assets.length,
    sourceShots.length
  );

  for (let index = 0; index < comparable; index += 1) {
    const asset = manifest.assets[index];
    const source = sourceShots[index];
    const label = `assets[${index}]`;

    if (!isPlainObject(asset)) {
      errors.push(`${label}: asset absent ou invalide`);
      continue;
    }

    if (
      asset.section_index !== source.sectionIndex ||
      asset.segment_index !== source.segmentIndex ||
      asset.shot_order !== source.shot.order
    ) {
      errors.push(
        `${label}: position différente du shot source ` +
        `sections[${source.sectionIndex}].segments[${source.segmentIndex}] order ${source.shot.order}`
      );
    }

    for (const field of COPIED_FIELDS) {
      if (!isDeepStrictEqual(asset[field], source.shot[field])) {
        errors.push(
          `${label}: ${field} différent du shot source`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
