// R29.4 — contrat du verrou de couverture (baseline v1.0.3, section 8). Module
// feuille et PUR : il n'importe que node:crypto, jamais un composant du verrou
// ni un service (c'est ce qui rend l'absence de cycle démontrable : le juge, la
// réparation, la frontière, l'applicateur, le coordinateur et la persistance
// l'importent). Aucune écriture, aucun réseau, aucune horloge, aucun hasard.
//
// Il est l'UNIQUE définition de :
//   - la baseline et la version de la frontière composée ;
//   - la liste ordonnée des 11 éléments du verrou et celle des 7 éléments que
//     la frontière consomme (dérivée de la première) ;
//   - l'empreinte du verrou (lock_sha256) ;
//   - l'identifiant de protocole de la frontière (I10), calculé depuis le
//     verrou OU depuis les versions réelles, par un seul algorithme ;
//   - le détecteur de forme (élément absent, vide ou superflu) et la
//     comparaison élément par élément ;
//   - la liaison entre l'élément « coordinateur » et la version de la politique.
//
// Il ne décide jamais d'un refus : il décrit, chaque module garde son propre
// vocabulaire de refus et l'ordre de ses contrôles. La CONSTRUCTION du verrou
// courant (qui rassemble les versions de huit composants) est dans
// coverage-lock-builder.js, au-dessus des composants.

import crypto from "node:crypto";

export const ARCHITECTURE_BASELINE_VERSION = "architecture-baseline-v1.0.3";

// Version de la frontière composée (R28.5), une seule constante.
export const COMPOSITE_COVERAGE_BOUNDARY_VERSION = "composite-coverage-boundary.v1";

// Verrou complet (section 8, éléments 1 à 12, dans leur ordre) : frontière
// (1 à 6), juge (7 et 8 : prompt, format et bornes), réparation (9),
// politique du coordinateur (10), langue (11), baseline (12). lock_sha256 est
// calculé sur ces seuls éléments.
export const COVERAGE_LOCK_KEYS = Object.freeze([
  "splitter",
  "normalization",
  "protection",
  "entities_rule_version",
  "entities_fingerprint",
  "classification",
  "judge",
  "repair",
  "coordinator",
  "language",
  "baseline"
]);

// Éléments du verrou consommés par la frontière (section 8, éléments 1 à 6 et
// 11), dérivés de la liste complète : impossible de les désynchroniser.
const NOT_CONSUMED_BY_BOUNDARY = Object.freeze(["judge", "repair", "coordinator", "baseline"]);

export const BOUNDARY_LOCK_KEYS = Object.freeze(
  COVERAGE_LOCK_KEYS.filter(key => !NOT_CONSUMED_BY_BOUNDARY.includes(key))
);

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

// Empreinte du verrou complet (COVERAGE_LOCK_KEYS uniquement ; un élément
// absent compte pour null, un élément superflu est ignoré).
export function lockSha256(lock) {
  return sha256(stableJson(Object.fromEntries(COVERAGE_LOCK_KEYS.map(key => [key, lock?.[key] ?? null]))));
}

// I10 : identifiant de protocole de la frontière = SHA-256 du JSON stable de
// ses versions et de l'empreinte des entités. Unique algorithme, deux entrées :
// les versions RÉELLES des composants (frontière) ou celles du VERROU (juge,
// réparation, porte). Les deux doivent donner la même valeur.
export function protocolIdFromVersions({ versions, entitiesFingerprint }) {
  return sha256(stableJson({ versions, entities_fingerprint: entitiesFingerprint }));
}

export function boundaryProtocolIdFromLock(lock) {
  return protocolIdFromVersions({
    versions: {
      composite: COMPOSITE_COVERAGE_BOUNDARY_VERSION,
      splitter: lock?.splitter ?? null,
      normalization: lock?.normalization ?? null,
      protection: lock?.protection ?? null,
      classification: lock?.classification ?? null,
      entities_rule_version: lock?.entities_rule_version ?? null,
      language: lock?.language ?? null
    },
    entitiesFingerprint: lock?.entities_fingerprint ?? null
  });
}

// ---------------------------------------------------------------------------
// Forme. Descriptions seulement : aucun code de refus ici.

// Objet « enregistrement » : non nul, objet, hors tableau.
export function isLockRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Éléments dont la valeur n'est pas une chaîne non vide, dans l'ordre du
// verrou. Suppose un objet (un tableau n'a aucun des éléments).
export function invalidLockElements(lock) {
  return COVERAGE_LOCK_KEYS.filter(key => typeof lock[key] !== "string" || lock[key] === "");
}

// Éléments présents mais inconnus du verrou, dans l'ordre des clés de l'objet.
export function unexpectedLockElements(lock) {
  return Object.keys(lock).filter(key => !COVERAGE_LOCK_KEYS.includes(key));
}

// Premier élément (ordre du verrou) dont la valeur diffère entre deux verrous,
// ou undefined.
export function firstDifferingLockElement(stored, current) {
  return COVERAGE_LOCK_KEYS.find(key => stored[key] !== current[key]);
}

// Liaison entre l'élément « coordinateur » et la politique (élément 10).
export function lockMatchesPolicy(lock, policy) {
  return isLockRecord(lock) && lock.coordinator === policy.version;
}
