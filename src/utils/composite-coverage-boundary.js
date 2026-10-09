// R28.5 — frontière factuelle composée (baseline v1.0.1 : sections 1, 3, 7
// et 8 ; invariants I6, I9, I10, I13, I15, I21). Elle compose les quatre
// composants déterministes, sans logique métier :
//
//   voiceover → Découpeur → pour chaque unité : Normalisation → Protection
//             → Classification
//
// Elle ne recalcule rien, ne modifie aucun résultat et ne connaît ni le juge,
// ni la réparation, ni le coordinateur, ni le pipeline. Chaque composant reste
// propriétaire de sa décision ; les sorties sont transmises intactes.
//
// Rôle propre de la composition :
//   - transmettre à chaque composant la version du verrou qui le concerne
//     (chaque composant refuse lui-même une version divergente) ;
//   - ne transmettre à Protection que la liste d'entités conforme au verrou
//     (règle et empreinte) ; sinon aucune liste, et Protection se dégrade ;
//   - vérifier la cohérence des sorties entre elles (identifiants, versions,
//     empreintes, partition) et consigner chaque divergence ou erreur ;
//   - dériver l'état de frontière de chaque unité (section 3) :
//       excluded  : Classification EXCLUDED, toute la chaîne OK ;
//       protected : Protection l'a protégée ;
//       analysed  : tous les autres cas.
//     Échec fermé (I15, section 7) : découpeur non OK, composant absent ou en
//     erreur, sortie incohérente → l'unité est analysée, jamais exclue.
//
// La composition ne crée aucun type d'erreur : son statut reprend ceux des
// composants (OK, DEGRADED, FAILED) et chaque erreur est conservée en texte.

import crypto from "node:crypto";

import { COVERAGE_NORMALIZATION_VERSION, normalizeCoverageText } from "./coverage-normalization.js";
import { coverageUnitSplitterVersion, splitCoverageUnits } from "./coverage-unit-splitter.js";
import { coverageProtectionVersion, protectCoverageUnit } from "./coverage-protection.js";
import { coverageClassificationVersion, classifyCoverageUnit } from "./coverage-classification.js";
import { BOUNDARY_LOCK_KEYS, COMPOSITE_COVERAGE_BOUNDARY_VERSION, protocolIdFromVersions } from "./coverage-lock.js";

export const BOUNDARY_STATUS = Object.freeze({
  OK: "OK",
  DEGRADED: "DEGRADED",
  FAILED: "FAILED"
});

export const BOUNDARY_UNIT_STATES = Object.freeze(["protected", "excluded", "analysed"]);

export const DEFAULT_COVERAGE_COMPONENTS = Object.freeze({
  normalization: Object.freeze({ version: () => COVERAGE_NORMALIZATION_VERSION, normalize: normalizeCoverageText }),
  splitter: Object.freeze({ version: coverageUnitSplitterVersion, split: splitCoverageUnits }),
  protection: Object.freeze({ version: coverageProtectionVersion, protect: protectCoverageUnit }),
  classification: Object.freeze({ version: coverageClassificationVersion, classify: classifyCoverageUnit })
});

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const message = error => String(error?.message ?? error);

function present(components, name, functionName) {
  return typeof components?.[name]?.[functionName] === "function" &&
    typeof components?.[name]?.version === "function";
}

function availableVersion(components, name) {
  try {
    return present(components, name, "version") ? components[name].version() : null;
  } catch {
    return null;
  }
}

function freezeDeep(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Cohérence de la sortie du découpeur avec le voiceover (I14, I21).
function splitterIssues(voiceover, split) {
  const issues = [];
  if (!split || typeof split !== "object" || !Array.isArray(split.units)) return ["sortie du découpeur illisible"];
  if (split.voiceover_sha256 !== sha256(voiceover)) issues.push("empreinte du voiceover différente");
  if (split.status !== "FAILED") {
    let position = 0;
    split.units.forEach((unit, index) => {
      if (
        unit?.id !== `u${index + 1}` || unit.rank !== index + 1 ||
        unit.start !== position || unit.text !== voiceover.slice(unit.start, unit.end)
      ) issues.push(`unité ${index + 1} incohérente`);
      position = unit?.end;
    });
    if (position !== voiceover.length) issues.push("partition incomplète");
  }
  return issues;
}

// Cohérence des sorties d'une unité entre elles.
function chainIssues(unit, normalization, protection, classification, versions) {
  const issues = [];
  if (normalization && normalization.version !== versions.normalization) issues.push("version de normalisation différente du verrou");
  if (protection) {
    if (protection.unit_id !== unit.id) issues.push("Protection : identifiant d'unité différent");
    if (protection.version !== versions.protection) issues.push("Protection : version différente du verrou");
  }
  if (classification) {
    if (classification.unit_id !== unit.id) issues.push("Classification : identifiant d'unité différent");
    if (classification.version !== versions.classification) issues.push("Classification : version différente du verrou");
    if (protection && classification.upstream?.protection_version !== protection.version) {
      issues.push("Classification : version de Protection amont différente");
    }
    if (protection && classification.upstream?.entities_fingerprint !== protection.entities_fingerprint) {
      issues.push("Classification : empreinte d'entités amont différente");
    }
  }
  return issues;
}

function unitState({ splitOk, errors, issues, protection, classification }) {
  if (!splitOk || errors.length > 0 || issues.length > 0 || !protection || !classification) return "analysed";
  if (protection.protected === true) return "protected";
  if (classification.status === "OK" && classification.decision === "EXCLUDED") return "excluded";
  return "analysed";
}

// Compose la frontière pour un voiceover. `lock` : éléments du verrou
// (BOUNDARY_LOCK_KEYS) ; `entities` : liste d'entités Research (sortie de
// extractResearchEntities) ; `components` : composants (par défaut, les
// modules R28.1 à R28.4).
export function composeCoverageBoundary({ voiceover, lock, entities, components = DEFAULT_COVERAGE_COMPONENTS }) {
  const lockValue = key => (lock !== null && typeof lock === "object" ? lock[key] : undefined);
  const available = {
    splitter: availableVersion(components, "splitter"),
    normalization: availableVersion(components, "normalization"),
    protection: availableVersion(components, "protection"),
    classification: availableVersion(components, "classification")
  };

  const entitiesRule = entities?.rule_version ?? null;
  const entitiesFingerprint = entities?.fingerprint ?? null;
  const actual = {
    ...available,
    entities_rule_version: entitiesRule,
    entities_fingerprint: entitiesFingerprint
  };

  // Divergences dans l'ordre du verrou. La langue est vérifiée par le
  // découpeur, qui en est propriétaire.
  const divergences = BOUNDARY_LOCK_KEYS
    .filter(key => key !== "language" && lockValue(key) !== actual[key])
    .map(key => ({ element: key, expected: lockValue(key) ?? null, actual: actual[key] }));
  const entitiesForProtection = divergences.some(item => item.element.startsWith("entities_")) ? null : entities;

  const missing = ["splitter", "normalization", "protection", "classification"]
    .filter(name => !present(components, name, { splitter: "split", normalization: "normalize", protection: "protect", classification: "classify" }[name]));

  const errors = [];
  let split = null;

  if (missing.includes("splitter")) {
    errors.push("composant absent : splitter");
  } else {
    try {
      split = components.splitter.split({ voiceover, version: lockValue("splitter"), language: lockValue("language") });
    } catch (error) {
      errors.push(`splitter : ${message(error)}`);
    }
  }

  const splitIssues = split && typeof voiceover === "string" ? splitterIssues(voiceover, split) : [];
  const splitOk = split?.status === "OK" && splitIssues.length === 0;

  const units = (split && Array.isArray(split.units) ? split.units : []).map(unit => {
    const unitErrors = [];
    let normalization = null;
    let protection = null;
    let classification = null;

    if (missing.includes("normalization")) unitErrors.push("composant absent : normalization");
    else {
      try {
        normalization = components.normalization.normalize(unit.text, lockValue("normalization"));
      } catch (error) {
        unitErrors.push(`normalization : ${message(error)}`);
      }
    }

    if (missing.includes("protection")) unitErrors.push("composant absent : protection");
    else {
      try {
        protection = components.protection.protect({ unit, version: lockValue("protection"), entities: entitiesForProtection });
      } catch (error) {
        unitErrors.push(`protection : ${message(error)}`);
      }
    }

    if (missing.includes("classification")) unitErrors.push("composant absent : classification");
    else {
      try {
        classification = components.classification.classify({ unit, normalization, protection, version: lockValue("classification") });
      } catch (error) {
        unitErrors.push(`classification : ${message(error)}`);
      }
    }

    const issues = chainIssues(unit, normalization, protection, classification, {
      normalization: lockValue("normalization"),
      protection: lockValue("protection"),
      classification: lockValue("classification")
    });
    const degraded = [protection?.status, classification?.status].some(status => status && status !== "OK");

    return {
      unit_id: unit?.id ?? null,
      unit,
      normalization,
      protection,
      classification,
      state: unitState({ splitOk, errors: unitErrors, issues, protection, classification }),
      errors: unitErrors,
      issues,
      degraded: degraded || unitErrors.length > 0 || issues.length > 0
    };
  });

  let status = BOUNDARY_STATUS.OK;
  let reason = null;
  if (!split || split.status === "FAILED" || (split && typeof voiceover !== "string")) {
    status = BOUNDARY_STATUS.FAILED;
    reason = errors[0] ?? split?.reason ?? "découpage impossible";
  } else if (
    split.status !== "OK" || splitIssues.length > 0 || divergences.length > 0 || missing.length > 0 ||
    units.some(item => item.degraded)
  ) {
    status = BOUNDARY_STATUS.DEGRADED;
    reason = split.status !== "OK" ? split.reason : null;
  }

  const versions = {
    composite: COMPOSITE_COVERAGE_BOUNDARY_VERSION,
    splitter: available.splitter,
    normalization: available.normalization,
    protection: available.protection,
    classification: available.classification,
    entities_rule_version: entitiesRule,
    language: lockValue("language") ?? null
  };
  const fingerprints = {
    voiceover_sha256: split?.voiceover_sha256 ?? null,
    entities_fingerprint: entitiesFingerprint,
    registry_sha256: units.find(item => item.classification?.registry_sha256)?.classification.registry_sha256 ?? null
  };

  return freezeDeep({
    version: COMPOSITE_COVERAGE_BOUNDARY_VERSION,
    status,
    reason,
    voiceover_sha256: fingerprints.voiceover_sha256,
    // I10 : identifiant de protocole combinant toutes les versions et empreintes.
    protocol_id: protocolIdFromVersions({ versions, entitiesFingerprint }),
    versions,
    fingerprints,
    lock: BOUNDARY_LOCK_KEYS.reduce((record, key) => ({ ...record, [key]: lockValue(key) ?? null }), {}),
    lock_divergences: divergences,
    missing_components: missing,
    errors,
    splitter: split,
    splitter_issues: splitIssues,
    units,
    analysed_unit_ids: units.filter(item => item.state !== "excluded").map(item => item.unit_id),
    excluded_unit_ids: units.filter(item => item.state === "excluded").map(item => item.unit_id)
  });
}
