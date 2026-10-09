// R28.8A — application déterministe du plan DELETE (baseline v1.0.2, contrat
// 4.6, complément de R28.8). Aucun appelant à ce stade.
//
// Elle reçoit la sortie de la frontière composée (R28.5), le plan de
// réparation (R28.8) et le verrou complet. Elle reconstitue le voiceover
// exact à partir des unités de la frontière, retire seulement les unités
// désignées par le plan et concatène les unités restantes dans leur ordre
// d'origine, octet pour octet : aucun caractère ajouté, aucune réécriture.
// Une seule exception (R29.2, défaut I4) : quand la dernière unité du
// voiceover est retirée, l'espace de jonction qui la précédait, resté en fin
// de texte, est retiré aussi. Seuls les espaces ordinaires (U+0020) de la fin
// du texte sont concernés ; retours à la ligne, espaces insécables, espaces
// internes et ponctuation restent intacts. Le résultat est le voiceover de la
// ronde suivante (nouvelle empreinte, donc nouvelles unités).
//
// Elle ne normalise, ne protège, ne classe, ne juge et ne génère rien. Elle
// ne recalcule pas protocol_id et propage lock_sha256 après l'avoir vérifié
// avec la fonction du juge (judgeLockSha256), sans autre algorithme. Seule
// l'empreinte du voiceover réparé est calculée, avec l'algorithme de la
// frontière (SHA-256 hexadécimal du texte UTF-8).
//
// Statuts : APPLIED (au moins une unité retirée), UNCHANGED (plan vide),
// INPUT_REFUSED (toute incohérence ; jamais de voiceover partiel). Un
// résultat vide est refusé (section 7 : résultat vide interdit).

import crypto from "node:crypto";

import { BOUNDARY_LOCK_KEYS, COMPOSITE_COVERAGE_BOUNDARY_VERSION } from "./composite-coverage-boundary.js";
import { COVERAGE_REPAIR_VERSION, REPAIR_STATUS } from "./coverage-repair.js";
import { JUDGE_LOCK_KEYS, judgeLockSha256 } from "./coverage-judge-v2.js";

export const COVERAGE_DELETE_APPLIER_VERSION = "coverage-delete-applier.v1";

export const APPLY_STATUS = Object.freeze({
  APPLIED: "APPLIED",
  UNCHANGED: "UNCHANGED",
  INPUT_REFUSED: "INPUT_REFUSED"
});

export const APPLY_REFUSAL = Object.freeze({
  BOUNDARY_MISSING: "BOUNDARY_MISSING",
  BOUNDARY_MALFORMED: "BOUNDARY_MALFORMED",
  REPAIR_MISSING: "REPAIR_MISSING",
  REPAIR_MALFORMED: "REPAIR_MALFORMED",
  REPAIR_NOT_APPLICABLE: "REPAIR_NOT_APPLICABLE",
  LOCK_MISSING: "LOCK_MISSING",
  LOCK_INCOMPLETE: "LOCK_INCOMPLETE",
  LOCK_MISMATCH: "LOCK_MISMATCH",
  LOCK_SHA_MISMATCH: "LOCK_SHA_MISMATCH",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  VOICEOVER_MISMATCH: "VOICEOVER_MISMATCH",
  DECLARE_NOT_SUPPORTED: "DECLARE_NOT_SUPPORTED",
  UNKNOWN_OPERATION: "UNKNOWN_OPERATION",
  DUPLICATE_DELETE: "DUPLICATE_DELETE",
  UNKNOWN_UNIT: "UNKNOWN_UNIT",
  EXCLUDED_UNIT: "EXCLUDED_UNIT",
  ABSENT_UNIT: "ABSENT_UNIT",
  EMPTY_RESULT: "EMPTY_RESULT"
});

// Verrou complet (section 8) : la définition du juge fait foi.
const LOCK_KEYS = JUDGE_LOCK_KEYS;
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v", " ", " ", " ", " ", " ", " "]);

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

class Refusal {
  constructor(code, unitId = null) {
    this.code = code;
    this.unitId = unitId;
  }
}

const refuse = (code, unitId = null) => {
  throw new Refusal(code, unitId);
};

function freezeAll(value) {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) freezeAll(value[key]);
    Object.freeze(value);
  }
  return value;
}

function checkLock(lock) {
  if (!isObject(lock)) refuse(APPLY_REFUSAL.LOCK_MISSING);
  if (LOCK_KEYS.some(key => typeof lock[key] !== "string" || lock[key] === "")) refuse(APPLY_REFUSAL.LOCK_INCOMPLETE);
}

// Voiceover source reconstitué depuis les unités, contrôlé contre l'empreinte
// de la frontière.
function checkBoundary(boundary, lock) {
  if (boundary === undefined || boundary === null) refuse(APPLY_REFUSAL.BOUNDARY_MISSING);
  if (!isObject(boundary) || boundary.version !== COMPOSITE_COVERAGE_BOUNDARY_VERSION || boundary.status === "FAILED" ||
    !Array.isArray(boundary.units) || boundary.units.length === 0 || !isObject(boundary.lock) ||
    !Array.isArray(boundary.lock_divergences) || typeof boundary.protocol_id !== "string") {
    refuse(APPLY_REFUSAL.BOUNDARY_MALFORMED);
  }
  if (boundary.lock_divergences.length > 0 || BOUNDARY_LOCK_KEYS.some(key => boundary.lock[key] !== lock[key])) {
    refuse(APPLY_REFUSAL.LOCK_MISMATCH);
  }
  boundary.units.forEach((item, index) => {
    if (!isObject(item) || !isObject(item.unit) || typeof item.unit.text !== "string" || item.unit.text.length === 0 ||
      item.unit_id !== `u${index + 1}` || item.unit.id !== item.unit_id ||
      !["protected", "excluded", "analysed"].includes(item.state)) {
      refuse(APPLY_REFUSAL.BOUNDARY_MALFORMED);
    }
  });
  const source = boundary.units.map(item => item.unit.text).join("");
  if (sha256(source) !== boundary.voiceover_sha256) refuse(APPLY_REFUSAL.VOICEOVER_MISMATCH);
  return source;
}

function checkRepair(repair, boundary, lock) {
  if (repair === undefined || repair === null) refuse(APPLY_REFUSAL.REPAIR_MISSING);
  if (!isObject(repair) || !Array.isArray(repair.repair_plan) || !Array.isArray(repair.repaired_unit_ids) ||
    !Array.isArray(repair.untouched_unit_ids) || repair.repair_version !== COVERAGE_REPAIR_VERSION) {
    refuse(APPLY_REFUSAL.REPAIR_MALFORMED);
  }
  if (repair.status !== REPAIR_STATUS.PLANNED && repair.status !== REPAIR_STATUS.NO_REPAIR) {
    refuse(APPLY_REFUSAL.REPAIR_NOT_APPLICABLE);
  }
  if (repair.baseline !== lock.baseline || lock.repair !== repair.repair_version) refuse(APPLY_REFUSAL.LOCK_MISMATCH);
  if (typeof repair.lock_sha256 !== "string" || repair.lock_sha256 === "") refuse(APPLY_REFUSAL.REPAIR_MALFORMED);
  if (repair.lock_sha256 !== judgeLockSha256(lock)) refuse(APPLY_REFUSAL.LOCK_SHA_MISMATCH);
  if (repair.protocol_id !== boundary.protocol_id) refuse(APPLY_REFUSAL.PROTOCOL_MISMATCH);
  if (repair.voiceover_sha256 !== boundary.voiceover_sha256) refuse(APPLY_REFUSAL.VOICEOVER_MISMATCH);
}

// Unités à retirer, contrôlées une à une.
function deletions(repair, boundary) {
  const states = new Map(boundary.units.map(item => [item.unit_id, item.state]));
  const deleted = [];

  for (const operation of repair.repair_plan) {
    if (!isObject(operation) || typeof operation.unit_id !== "string") refuse(APPLY_REFUSAL.REPAIR_MALFORMED);
    const unitId = operation.unit_id;
    if (operation.action === "DECLARE") refuse(APPLY_REFUSAL.DECLARE_NOT_SUPPORTED, unitId);
    if (operation.action !== "DELETE") refuse(APPLY_REFUSAL.UNKNOWN_OPERATION, unitId);
    if (!states.has(unitId)) refuse(APPLY_REFUSAL.UNKNOWN_UNIT, unitId);
    if (states.get(unitId) === "excluded") refuse(APPLY_REFUSAL.EXCLUDED_UNIT, unitId);
    if (deleted.includes(unitId)) refuse(APPLY_REFUSAL.DUPLICATE_DELETE, unitId);
    deleted.push(unitId);
  }

  // Le plan, les unités réparées et les unités intactes doivent concorder
  // exactement avec la frontière : une unité déjà absente est refusée.
  const allIds = boundary.units.map(item => item.unit_id);
  const ordered = allIds.filter(id => deleted.includes(id));
  if (!sameList(repair.repaired_unit_ids, ordered)) refuse(APPLY_REFUSAL.ABSENT_UNIT);
  if (!sameList(repair.untouched_unit_ids, allIds.filter(id => !deleted.includes(id)))) refuse(APPLY_REFUSAL.ABSENT_UNIT);
  if (repair.status === REPAIR_STATUS.NO_REPAIR && ordered.length > 0) refuse(APPLY_REFUSAL.REPAIR_MALFORMED);
  if (repair.status === REPAIR_STATUS.PLANNED && ordered.length === 0) refuse(APPLY_REFUSAL.REPAIR_MALFORMED);
  return ordered;
}

function refused(refusal) {
  return freezeAll({
    protocol_id: null,
    previous_voiceover_sha256: null,
    repaired_voiceover: null,
    repaired_voiceover_sha256: null,
    deleted_unit_ids: [],
    remaining_unit_ids: [],
    lock_sha256: null,
    repair_version: null,
    baseline: null,
    status: APPLY_STATUS.INPUT_REFUSED,
    refusal: { code: refusal.code, unit_id: refusal.unitId }
  });
}

// Applique le plan DELETE. Ne modifie aucune entrée. Ne lève jamais.
export function applyCoverageDeletePlan({ boundary, repair, lock } = {}) {
  try {
    checkLock(lock);
    checkBoundary(boundary, lock);
    checkRepair(repair, boundary, lock);
    const deleted = deletions(repair, boundary);
    const remaining = boundary.units.filter(item => !deleted.includes(item.unit_id));
    let repaired = remaining.map(item => item.unit.text).join("");
    if (repaired.length === 0 || [...repaired].every(character => WHITESPACE.has(character))) refuse(APPLY_REFUSAL.EMPTY_RESULT);

    // I4 : espace de jonction laissé en fin de texte par le retrait de la
    // dernière unité.
    if (deleted.includes(boundary.units.at(-1).unit_id)) {
      let end = repaired.length;
      while (end > 0 && repaired[end - 1] === " ") end -= 1;
      repaired = repaired.slice(0, end);
    }

    return freezeAll({
      protocol_id: repair.protocol_id,
      previous_voiceover_sha256: boundary.voiceover_sha256,
      repaired_voiceover: repaired,
      repaired_voiceover_sha256: sha256(repaired),
      deleted_unit_ids: deleted,
      remaining_unit_ids: remaining.map(item => item.unit_id),
      lock_sha256: repair.lock_sha256,
      repair_version: repair.repair_version,
      baseline: repair.baseline,
      status: deleted.length > 0 ? APPLY_STATUS.APPLIED : APPLY_STATUS.UNCHANGED,
      refusal: null
    });
  } catch (error) {
    if (error instanceof Refusal) return refused(error);
    return refused(new Refusal(APPLY_REFUSAL.REPAIR_MALFORMED));
  }
}
