// R28.8 — réparation déterministe de la couverture (baseline v1.0.2, contrat
// 4.6 ; invariants I17, I21). Aucun appelant à ce stade.
//
// Elle reçoit la sortie de la frontière composée (R28.5), la sortie du juge v2
// (R28.6) et le verrou complet, et produit un PLAN de réparation. Elle ne
// modifie aucun texte, ne redécoupe, ne renormalise, ne reprotège, ne
// reclasse et ne rejuge rien. L'application du plan (nouveau texte, nouvelle
// empreinte) relève d'un lot ultérieur.
//
// Ce lot n'implémente que DELETE. DECLARE, prévu par le contrat 4.6, n'est pas
// implémenté : tout verdict DECLARE donne INPUT_REFUSED, sans plan, sans
// conversion et sans réparation partielle.
//
// Règles :
//   - UNCOVERED + DELETE → opération DELETE ;
//   - COVERED → aucune opération ;
//   - unité exclue → jamais touchée ; une opération sur elle est refusée ;
//   - unité protégée → touchée seulement si le juge l'a jugée non couverte ;
//   - plan qui supprimerait toutes les unités → NOT_REPAIRABLE (résultat
//     vide interdit, section 7) ;
//   - toute incohérence → INPUT_REFUSED, jamais de réparation partielle.
//
// Traçabilité : chaque plan porte protocol_id, voiceover_sha256, lock_sha256,
// la version de la réparation et celle de la baseline. Aucun texte libre :
// raisons et refus sont des codes fermés.

import crypto from "node:crypto";

import {
  ARCHITECTURE_BASELINE_VERSION,
  COVERAGE_JUDGE_V2_PROTOCOL,
  JUDGE_LOCK_KEYS,
  boundaryProtocolIdFromLock,
  coverageJudgeV2Version,
  judgeLockSha256
} from "./coverage-judge-v2.js";

export const COVERAGE_REPAIR_VERSION = "coverage-repair.v1";

export const REPAIR_STATUS = Object.freeze({
  PLANNED: "PLANNED",
  NO_REPAIR: "NO_REPAIR",
  NOT_REPAIRABLE: "NOT_REPAIRABLE",
  INPUT_REFUSED: "INPUT_REFUSED"
});

export const REPAIR_ACTIONS = Object.freeze(["DELETE"]);
export const REPAIR_REASON = Object.freeze({ JUDGED_UNCOVERED: "JUDGED_UNCOVERED" });

export const REPAIR_REFUSAL = Object.freeze({
  BOUNDARY_MISSING: "BOUNDARY_MISSING",
  BOUNDARY_MALFORMED: "BOUNDARY_MALFORMED",
  JUDGE_MISSING: "JUDGE_MISSING",
  JUDGE_MALFORMED: "JUDGE_MALFORMED",
  JUDGE_NOT_JUDGED: "JUDGE_NOT_JUDGED",
  LOCK_MISSING: "LOCK_MISSING",
  LOCK_INCOMPLETE: "LOCK_INCOMPLETE",
  LOCK_MISMATCH: "LOCK_MISMATCH",
  LOCK_SHA_MISMATCH: "LOCK_SHA_MISMATCH",
  PROTOCOL_MISSING: "PROTOCOL_MISSING",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  VOICEOVER_MISMATCH: "VOICEOVER_MISMATCH",
  DESIGNATION_MISMATCH: "DESIGNATION_MISMATCH",
  UNKNOWN_UNIT: "UNKNOWN_UNIT",
  DUPLICATE_UNIT: "DUPLICATE_UNIT",
  MISSING_UNIT: "MISSING_UNIT",
  EXCLUDED_UNIT: "EXCLUDED_UNIT",
  UNKNOWN_VERDICT: "UNKNOWN_VERDICT",
  DECLARE_NOT_SUPPORTED: "DECLARE_NOT_SUPPORTED",
  UNKNOWN_ACTION: "UNKNOWN_ACTION"
});

const HEX64 = /^[0-9a-f]{64}$/;
const BOUNDARY_LOCK_ECHO = Object.freeze([
  "splitter", "normalization", "protection", "entities_rule_version", "entities_fingerprint", "classification", "language"
]);

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

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
  if (!isObject(lock)) refuse(REPAIR_REFUSAL.LOCK_MISSING);
  if (JUDGE_LOCK_KEYS.some(key => typeof lock[key] !== "string" || lock[key] === "")) refuse(REPAIR_REFUSAL.LOCK_INCOMPLETE);
  if (lock.baseline !== ARCHITECTURE_BASELINE_VERSION || lock.judge !== coverageJudgeV2Version()) refuse(REPAIR_REFUSAL.LOCK_MISMATCH);
}

function checkBoundary(boundary, lock) {
  if (boundary === undefined || boundary === null) refuse(REPAIR_REFUSAL.BOUNDARY_MISSING);
  if (!isObject(boundary) || !Array.isArray(boundary.units) || boundary.units.length === 0 ||
    !Array.isArray(boundary.analysed_unit_ids) || !Array.isArray(boundary.lock_divergences) || !isObject(boundary.lock)) {
    refuse(REPAIR_REFUSAL.BOUNDARY_MALFORMED);
  }
  if (boundary.status === "FAILED") refuse(REPAIR_REFUSAL.BOUNDARY_MALFORMED);
  if (typeof boundary.protocol_id !== "string" || boundary.protocol_id === "") refuse(REPAIR_REFUSAL.PROTOCOL_MISSING);
  if (boundary.lock_divergences.length > 0 || BOUNDARY_LOCK_ECHO.some(key => boundary.lock[key] !== lock[key])) {
    refuse(REPAIR_REFUSAL.LOCK_MISMATCH);
  }

  const ids = new Set();
  boundary.units.forEach((item, index) => {
    if (!isObject(item) || !isObject(item.unit) || typeof item.unit.text !== "string" ||
      item.unit_id !== `u${index + 1}` || item.unit.id !== item.unit_id ||
      !["protected", "excluded", "analysed"].includes(item.state)) {
      refuse(REPAIR_REFUSAL.BOUNDARY_MALFORMED);
    }
    ids.add(item.unit_id);
  });

  const voiceoverSha256 = sha256(boundary.units.map(item => item.unit.text).join(""));
  if (boundary.voiceover_sha256 !== voiceoverSha256) refuse(REPAIR_REFUSAL.VOICEOVER_MISMATCH);

  const analysed = boundary.units.filter(item => item.state !== "excluded").map(item => item.unit_id);
  if (JSON.stringify(boundary.analysed_unit_ids) !== JSON.stringify(analysed)) refuse(REPAIR_REFUSAL.DESIGNATION_MISMATCH);
}

function checkJudgment(judgment, boundary, lock) {
  if (judgment === undefined || judgment === null) refuse(REPAIR_REFUSAL.JUDGE_MISSING);
  if (!isObject(judgment) || !Array.isArray(judgment.results) || !Array.isArray(judgment.designated_unit_ids)) {
    refuse(REPAIR_REFUSAL.JUDGE_MALFORMED);
  }
  if (judgment.protocol !== COVERAGE_JUDGE_V2_PROTOCOL || judgment.version !== lock.judge) refuse(REPAIR_REFUSAL.LOCK_MISMATCH);
  if (judgment.status !== "JUDGED" && judgment.status !== "NO_DESIGNATED_UNITS") refuse(REPAIR_REFUSAL.JUDGE_NOT_JUDGED);

  if (typeof judgment.protocol_id !== "string" || !HEX64.test(judgment.protocol_id)) refuse(REPAIR_REFUSAL.PROTOCOL_MISSING);
  const expectedProtocolId = boundaryProtocolIdFromLock(lock);
  if (judgment.protocol_id !== boundary.protocol_id || boundary.protocol_id !== expectedProtocolId) {
    refuse(REPAIR_REFUSAL.PROTOCOL_MISMATCH);
  }
  if (judgment.lock_sha256 !== judgeLockSha256(lock)) refuse(REPAIR_REFUSAL.LOCK_SHA_MISMATCH);
  if (judgment.voiceover_sha256 !== boundary.voiceover_sha256) refuse(REPAIR_REFUSAL.VOICEOVER_MISMATCH);

  if (JSON.stringify(judgment.designated_unit_ids) !== JSON.stringify(boundary.analysed_unit_ids)) {
    refuse(REPAIR_REFUSAL.DESIGNATION_MISMATCH);
  }
  if (judgment.status === "NO_DESIGNATED_UNITS" && (judgment.designated_unit_ids.length > 0 || judgment.results.length > 0)) {
    refuse(REPAIR_REFUSAL.JUDGE_MALFORMED);
  }
}

// Une opération par unité jugée non couverte, dans l'ordre des unités.
function planOperations(judgment, boundary) {
  const states = new Map(boundary.units.map(item => [item.unit_id, item.state]));
  const designated = new Set(judgment.designated_unit_ids);
  const seen = new Set();
  const operations = [];

  for (const result of judgment.results) {
    if (!isObject(result) || typeof result.unit_id !== "string") refuse(REPAIR_REFUSAL.JUDGE_MALFORMED);
    const unitId = result.unit_id;
    if (!states.has(unitId)) refuse(REPAIR_REFUSAL.UNKNOWN_UNIT, unitId);
    if (states.get(unitId) === "excluded") refuse(REPAIR_REFUSAL.EXCLUDED_UNIT, unitId);
    if (!designated.has(unitId)) refuse(REPAIR_REFUSAL.UNKNOWN_UNIT, unitId);
    if (seen.has(unitId)) refuse(REPAIR_REFUSAL.DUPLICATE_UNIT, unitId);
    seen.add(unitId);

    if (result.verdict === "COVERED") {
      if (result.operation !== null) refuse(REPAIR_REFUSAL.JUDGE_MALFORMED, unitId);
      continue;
    }
    if (result.verdict !== "UNCOVERED") refuse(REPAIR_REFUSAL.UNKNOWN_VERDICT, unitId);
    const action = result.operation?.action;
    if (action === "DECLARE") refuse(REPAIR_REFUSAL.DECLARE_NOT_SUPPORTED, unitId);
    if (action !== "DELETE") refuse(REPAIR_REFUSAL.UNKNOWN_ACTION, unitId);
    operations.push({ unit_id: unitId, action: "DELETE", reason: REPAIR_REASON.JUDGED_UNCOVERED, claim_ids: [] });
  }

  const missing = judgment.designated_unit_ids.find(id => !seen.has(id));
  if (missing) refuse(REPAIR_REFUSAL.MISSING_UNIT, missing);

  const order = boundary.units.map(item => item.unit_id);
  return operations.sort((a, b) => order.indexOf(a.unit_id) - order.indexOf(b.unit_id));
}

function refused(refusal) {
  return freezeAll({
    protocol_id: null,
    voiceover_sha256: null,
    lock_sha256: null,
    repair_version: COVERAGE_REPAIR_VERSION,
    baseline: ARCHITECTURE_BASELINE_VERSION,
    repair_plan: [],
    repaired_unit_ids: [],
    untouched_unit_ids: [],
    status: REPAIR_STATUS.INPUT_REFUSED,
    refusal: { code: refusal.code, unit_id: refusal.unitId }
  });
}

// Construit le plan de réparation. Ne modifie aucune entrée. Ne lève jamais.
export function planCoverageRepair({ boundary, judgment, lock } = {}) {
  try {
    checkLock(lock);
    checkBoundary(boundary, lock);
    checkJudgment(judgment, boundary, lock);
    const plan = planOperations(judgment, boundary);
    const repaired = plan.map(operation => operation.unit_id);
    const untouched = boundary.units.map(item => item.unit_id).filter(id => !repaired.includes(id));
    const status = plan.length === 0
      ? REPAIR_STATUS.NO_REPAIR
      : untouched.length === 0 ? REPAIR_STATUS.NOT_REPAIRABLE : REPAIR_STATUS.PLANNED;

    return freezeAll({
      protocol_id: judgment.protocol_id,
      voiceover_sha256: judgment.voiceover_sha256,
      lock_sha256: judgment.lock_sha256,
      repair_version: COVERAGE_REPAIR_VERSION,
      baseline: lock.baseline,
      repair_plan: status === REPAIR_STATUS.NOT_REPAIRABLE ? [] : plan,
      repaired_unit_ids: status === REPAIR_STATUS.NOT_REPAIRABLE ? [] : repaired,
      untouched_unit_ids: status === REPAIR_STATUS.NOT_REPAIRABLE ? boundary.units.map(item => item.unit_id) : untouched,
      status,
      refusal: null
    });
  } catch (error) {
    if (error instanceof Refusal) return refused(error);
    return refused(new Refusal(REPAIR_REFUSAL.JUDGE_MALFORMED));
  }
}
