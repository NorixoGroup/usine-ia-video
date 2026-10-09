// R28.9 — coordinateur de convergence de la couverture (baseline v1.0.2,
// contrat 4.7 ; invariants I20, I24). Aucun appelant à ce stade.
//
// Pour un segment, il enchaîne des rondes bornées :
//
//   frontière (R28.5) → juge v2 (R28.6, via l'exécuteur R28.7 et le transport
//   injecté) → réparation (R28.8) → application du DELETE (R28.8A) →
//   frontière recalculée sur le nouveau voiceover → …
//
// jusqu'à la convergence ou la limite de la politique. Il ne découpe, ne
// normalise, ne protège, ne classe, ne juge, ne répare et ne réécrit rien ; il
// ne calcule aucune empreinte : il propage celles des modules, et vérifie
// lock_sha256 avec la fonction du verrou (lockSha256, coverage-lock.js), sans autre algorithme. Il n'écrit
// aucun checkpoint et ne déclenche aucune régénération (I24).
//
// Classement :
//   PASS     : une ronde se termine par une réparation NO_REPAIR, donc toutes
//              les unités analysées du texte courant sont couvertes, sans
//              échec qualifié (I20) ;
//   NOT_PASS : tout le reste, avec une raison fermée, la catégorie d'échec et
//              les unités concernées.
//
// Relances : seuls les échecs du transport (TRANSPORT_ERROR, TIMEOUT) sont
// relancés, dans la limite de max_total_judge_calls. Toute autre défaillance
// arrête immédiatement en NOT_PASS.
//
// Portée : un segment par appel. Le statut du Script (script_status) est
// celui de ce seul segment ; un Script de plusieurs segments n'est PASS que si
// chacun de ses segments l'est (section 11), agrégation hors de ce module.

import { composeCoverageBoundary } from "./composite-coverage-boundary.js";
import { judgeSegmentCoverageV2 } from "./coverage-judge-v2.js";
import { lockMatchesPolicy, lockSha256 } from "./coverage-lock.js";
import { executeJudgeRequest } from "./coverage-judge-executor.js";
import { planCoverageRepair } from "./coverage-repair.js";
import { applyCoverageDeletePlan } from "./coverage-delete-applier.js";

export const COVERAGE_COORDINATOR_VERSION = "coverage-coordinator.v1";

export const COVERAGE_STATUS = Object.freeze({ PASS: "PASS", NOT_PASS: "NOT_PASS" });

export const NOT_PASS_REASON = Object.freeze({
  INPUT_INVALID: "INPUT_INVALID",
  POLICY_INVALID: "POLICY_INVALID",
  LOCK_INVALID: "LOCK_INVALID",
  BOUNDARY_FAILED: "BOUNDARY_FAILED",
  PROTOCOL_DRIFT: "PROTOCOL_DRIFT",
  JUDGE_REFUSED: "JUDGE_REFUSED",
  JUDGE_OUT_OF_BOUNDS: "JUDGE_OUT_OF_BOUNDS",
  JUDGE_NOT_JUDGED: "JUDGE_NOT_JUDGED",
  JUDGE_BUDGET_EXHAUSTED: "JUDGE_BUDGET_EXHAUSTED",
  REPAIR_REFUSED: "REPAIR_REFUSED",
  NOT_REPAIRABLE: "NOT_REPAIRABLE",
  DELETE_REFUSED: "DELETE_REFUSED",
  MAX_ROUNDS_REACHED: "MAX_ROUNDS_REACHED",
  UNEXPECTED: "UNEXPECTED"
});

const RETRYABLE_TRANSPORT_FAILURES = Object.freeze(["TRANSPORT_ERROR", "TIMEOUT"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function freezeAll(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeAll(value[key]);
    Object.freeze(value);
  }
  return value;
}

function validPolicy(policy) {
  return isObject(policy) &&
    typeof policy.version === "string" && policy.version !== "" &&
    Number.isSafeInteger(policy.max_rounds) && policy.max_rounds >= 1 &&
    Number.isSafeInteger(policy.max_total_judge_calls) && policy.max_total_judge_calls >= 1;
}

function result(state, { status, reason = null, category = null, unitIds = [] }) {
  return freezeAll({
    script_status: status,
    segment_status: {
      segment_id: state.segmentId,
      status,
      reason,
      category,
      unit_ids: [...unitIds]
    },
    rounds: state.history.length,
    final_voiceover: state.voiceover,
    final_voiceover_sha256: state.voiceoverSha256,
    final_boundary: state.finalBoundary,
    history: state.history.map(entry => ({ ...entry })),
    protocol_id: state.protocolId,
    lock_sha256: state.lockSha256,
    baseline: state.baseline,
    judge_calls: state.calls,
    policy_version: state.policyVersion
  });
}

const uncoveredOf = judgment => (judgment?.results ?? [])
  .filter(item => item.verdict === "UNCOVERED")
  .map(item => item.unit_id);

// Coordonne la convergence d'un segment. Ne modifie aucune entrée. Ne lève
// jamais.
export async function coordinateCoverage({ segment, claims, lock, transport, policy } = {}) {
  const state = {
    segmentId: isObject(segment) && typeof segment.segment_id === "string" ? segment.segment_id : null,
    voiceover: isObject(segment) && typeof segment.voiceover === "string" ? segment.voiceover : null,
    voiceoverSha256: null,
    finalBoundary: null,
    history: [],
    protocolId: null,
    lockSha256: null,
    baseline: isObject(lock) && typeof lock.baseline === "string" ? lock.baseline : null,
    calls: 0,
    policyVersion: isObject(policy) && typeof policy.version === "string" ? policy.version : null
  };
  const notPass = (reason, category = null, unitIds = []) => result(state, { status: COVERAGE_STATUS.NOT_PASS, reason, category, unitIds });

  try {
    if (!isObject(segment) || state.segmentId === null || state.voiceover === null || !isObject(segment.entities)) {
      return notPass(NOT_PASS_REASON.INPUT_INVALID);
    }
    if (!validPolicy(policy)) return notPass(NOT_PASS_REASON.POLICY_INVALID);
    // Élément 10 du verrou : la politique du coordinateur.
    if (!lockMatchesPolicy(lock, policy)) return notPass(NOT_PASS_REASON.LOCK_INVALID);

    for (let round = 1; round <= policy.max_rounds; round += 1) {
      const entry = { round, voiceover_sha256: null, protocol_id: null, boundary: null, judgment: null, repair: null, delete: null };
      state.history.push(entry);

      const boundary = composeCoverageBoundary({ voiceover: state.voiceover, lock, entities: segment.entities });
      entry.boundary = boundary;
      entry.voiceover_sha256 = boundary.voiceover_sha256;
      entry.protocol_id = boundary.protocol_id;
      state.voiceoverSha256 = boundary.voiceover_sha256;
      state.finalBoundary = boundary;

      if (boundary.status === "FAILED") return notPass(NOT_PASS_REASON.BOUNDARY_FAILED, boundary.reason ?? null);
      if (boundary.lock_divergences.length > 0) return notPass(NOT_PASS_REASON.LOCK_INVALID, boundary.lock_divergences[0].element);
      if (state.protocolId === null) state.protocolId = boundary.protocol_id;
      if (boundary.protocol_id !== state.protocolId) return notPass(NOT_PASS_REASON.PROTOCOL_DRIFT);

      // Jugement, avec relance des seuls échecs du transport, dans la limite
      // du budget total d'appels.
      let judgment = null;
      for (;;) {
        let executed = null;
        let budgetExhausted = false;
        const send = async request => {
          if (state.calls >= policy.max_total_judge_calls) {
            budgetExhausted = true;
            throw new Error("budget d'appels du juge épuisé");
          }
          state.calls += 1;
          executed = await executeJudgeRequest({ request, transport });
          if (executed.status !== "OK") throw new Error(`exécuteur : ${executed.failure.category}`);
          return executed.reply;
        };
        judgment = await judgeSegmentCoverageV2({ boundary, lock, claims, segmentId: state.segmentId, send });
        entry.judgment = judgment;

        if (judgment.status !== "FAILED") break;
        if (budgetExhausted) return notPass(NOT_PASS_REASON.JUDGE_BUDGET_EXHAUSTED);
        const category = judgment.failure?.category ?? null;
        if (category === "INPUT_REFUSED") return notPass(NOT_PASS_REASON.JUDGE_REFUSED, category);
        if (category === "OUT_OF_BOUNDS") return notPass(NOT_PASS_REASON.JUDGE_OUT_OF_BOUNDS, category);
        const transportFailure = executed?.status === "NOT_JUDGED" ? executed.failure.category : null;
        if (!RETRYABLE_TRANSPORT_FAILURES.includes(transportFailure)) {
          return notPass(NOT_PASS_REASON.JUDGE_NOT_JUDGED, transportFailure ?? category);
        }
        if (state.calls >= policy.max_total_judge_calls) return notPass(NOT_PASS_REASON.JUDGE_BUDGET_EXHAUSTED, transportFailure);
      }
      if (judgment.lock_sha256 !== lockSha256(lock)) return notPass(NOT_PASS_REASON.LOCK_INVALID, "lock_sha256");
      state.lockSha256 = judgment.lock_sha256;

      const repair = planCoverageRepair({ boundary, judgment, lock });
      entry.repair = repair;
      if (repair.status === "INPUT_REFUSED") {
        return notPass(NOT_PASS_REASON.REPAIR_REFUSED, repair.refusal?.code ?? null, repair.refusal?.unit_id ? [repair.refusal.unit_id] : []);
      }
      if (repair.status === "NOT_REPAIRABLE") return notPass(NOT_PASS_REASON.NOT_REPAIRABLE, null, uncoveredOf(judgment));
      if (repair.status === "NO_REPAIR") return result(state, { status: COVERAGE_STATUS.PASS });

      const applied = applyCoverageDeletePlan({ boundary, repair, lock });
      entry.delete = applied;
      if (applied.status !== "APPLIED") {
        return notPass(NOT_PASS_REASON.DELETE_REFUSED, applied.refusal?.code ?? null, applied.refusal?.unit_id ? [applied.refusal.unit_id] : []);
      }
      state.voiceover = applied.repaired_voiceover;
      state.voiceoverSha256 = applied.repaired_voiceover_sha256;
    }

    // Politique épuisée : le dernier texte réparé n'a pas été rejugé.
    const last = state.history.at(-1);
    return notPass(NOT_PASS_REASON.MAX_ROUNDS_REACHED, null, last?.repair?.repaired_unit_ids ?? []);
  } catch {
    return notPass(NOT_PASS_REASON.UNEXPECTED);
  }
}
