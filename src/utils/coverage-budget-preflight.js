// R29.3 — préflight du budget d'appels de la couverture (baseline v1.0.3,
// sections 7 et 8). Fonction pure : aucune écriture, aucun réseau, aucune
// horloge, aucun hasard. Le garde d'appels n'est jamais importé : la sonde de
// coût est injectée.
//
// Avant le premier appel du juge, le script existe : on peut donc compter ce
// que la ronde 1 de chaque segment coûtera, sans rien envoyer.
//
//   NO_CALL          aucun appel (frontière en échec, verrou ou entrée refusés,
//                    aucune unité désignée, segment hors bornes)
//   CACHED_ROUND_1   un appel est prévu mais sa réponse est déjà en cache : coût nul
//   NEEDS_CALL       au moins un appel réel
//
// min_new_calls = nombre de segments NEEDS_CALL. C'est une borne basse EXACTE
// de la ronde 1 : aucune exécution ne peut coûter moins. Les rondes suivantes
// dépendent des verdicts du juge et ne sont pas prévisibles.
// max_new_calls = max_total_judge_calls pour chaque segment qui a un appel
// (NEEDS_CALL ou CACHED_ROUND_1) : borne haute informative, jamais bloquante.
//
// La requête de chaque segment est obtenue par le vrai chemin (frontière,
// juge, exécuteur) avec un transport qui la capture puis s'arrête : aucune
// règle de construction n'est copiée ici. Le préflight ne lève jamais.

import { composeCoverageBoundary } from "./composite-coverage-boundary.js";
import { judgeSegmentCoverageV2 } from "./coverage-judge-v2.js";
import { executeJudgeRequest } from "./coverage-judge-executor.js";

export const COVERAGE_BUDGET_PREFLIGHT_VERSION = "coverage-budget-preflight.v1";

export const BUDGET_ESTIMATE_STATUS = Object.freeze({
  OK: "OK",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  PROBE_FAILED: "PROBE_FAILED"
});

export const BUDGET_SEGMENT_STATE = Object.freeze({
  NO_CALL: "NO_CALL",
  CACHED_ROUND_1: "CACHED_ROUND_1",
  NEEDS_CALL: "NEEDS_CALL"
});

export const BUDGET_VERDICT = Object.freeze({
  OK: "OK",
  INSUFFICIENT: "INSUFFICIENT"
});

export const BUDGET_PROBE_CATEGORY = Object.freeze({
  CACHE_INVALID: "CACHE_INVALID",
  REQUEST_INVALID: "REQUEST_INVALID"
});

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function freezeAll(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeAll(value[key]);
    Object.freeze(value);
  }
  return value;
}

const SENTINEL = Object.freeze({ probe: "captured" });

// Requête que la ronde 1 du segment enverrait au transport, ou null si elle
// n'en envoie aucune. N'envoie rien.
async function roundOneRequest({ segment, lock, entities, policy }) {
  if (!isObject(segment) || typeof segment.segment_id !== "string" || typeof segment.voiceover !== "string") return null;
  if (!isObject(lock) || lock.coordinator !== policy.version) return null;

  const boundary = composeCoverageBoundary({ voiceover: segment.voiceover, lock, entities });
  if (boundary.status === "FAILED" || boundary.lock_divergences.length > 0) return null;

  let captured = null;
  const capture = async request => {
    captured = request;
    throw SENTINEL;
  };
  const send = async request => {
    await executeJudgeRequest({ request, transport: capture });
    throw SENTINEL;
  };

  await judgeSegmentCoverageV2({ boundary, lock, claims: segment.claims, segmentId: segment.segment_id, send });

  return captured;
}

const probeFailure = (category, detail, segmentId) => freezeAll({
  version: COVERAGE_BUDGET_PREFLIGHT_VERSION,
  status: BUDGET_ESTIMATE_STATUS.PROBE_FAILED,
  category,
  detail: String(detail ?? "").slice(0, 300),
  segment_id: segmentId
});

// segments : [{ segment_id, voiceover, claims }] dans l'ordre du script.
// probe(request) : { applicable, cached } (voir previewMessageCost), peut lever.
export async function estimateCoverageBudget(input) {
  try {
    const { segments, entities, lock, policy, probe } = input ?? {};

    if (!Array.isArray(segments) || typeof probe !== "function" || !isObject(policy) ||
      !Number.isSafeInteger(policy.max_total_judge_calls) || policy.max_total_judge_calls < 1) {
      return probeFailure(BUDGET_PROBE_CATEGORY.REQUEST_INVALID, "entrées du préflight invalides", null);
    }

    const perSegment = [];

    for (const segment of segments) {
      const segmentId = isObject(segment) && typeof segment.segment_id === "string" ? segment.segment_id : null;
      let request;

      try {
        request = await roundOneRequest({ segment, lock, entities, policy });
      } catch (error) {
        return probeFailure(BUDGET_PROBE_CATEGORY.REQUEST_INVALID, error?.message ?? error, segmentId);
      }

      if (request === null) {
        perSegment.push({ segment_id: segmentId, state: BUDGET_SEGMENT_STATE.NO_CALL });
        continue;
      }

      let cost;

      try {
        cost = probe(request);
      } catch (error) {
        return probeFailure(
          error?.cache_invalid === true ? BUDGET_PROBE_CATEGORY.CACHE_INVALID : BUDGET_PROBE_CATEGORY.REQUEST_INVALID,
          error?.message ?? error,
          segmentId
        );
      }

      if (!isObject(cost)) {
        return probeFailure(BUDGET_PROBE_CATEGORY.REQUEST_INVALID, "sonde de coût sans réponse", segmentId);
      }

      // Aucun budget ne s'applique (fixtures, NO_API, garde absent) : le
      // préflight n'a rien à contrôler, les appels suivent leur chemin actuel.
      if (cost.applicable !== true) {
        return freezeAll({
          version: COVERAGE_BUDGET_PREFLIGHT_VERSION,
          status: BUDGET_ESTIMATE_STATUS.NOT_APPLICABLE,
          reason: typeof cost.reason === "string" ? cost.reason : null
        });
      }

      perSegment.push({
        segment_id: segmentId,
        state: cost.cached === true ? BUDGET_SEGMENT_STATE.CACHED_ROUND_1 : BUDGET_SEGMENT_STATE.NEEDS_CALL
      });
    }

    const count = state => perSegment.filter(item => item.state === state).length;
    const needing = count(BUDGET_SEGMENT_STATE.NEEDS_CALL);
    const cached = count(BUDGET_SEGMENT_STATE.CACHED_ROUND_1);

    return freezeAll({
      version: COVERAGE_BUDGET_PREFLIGHT_VERSION,
      status: BUDGET_ESTIMATE_STATUS.OK,
      segments_total: perSegment.length,
      segments_no_call: count(BUDGET_SEGMENT_STATE.NO_CALL),
      segments_cached_round_1: cached,
      segments_needing_call: needing,
      min_new_calls: needing,
      max_new_calls: (needing + cached) * policy.max_total_judge_calls,
      segments: perSegment
    });
  } catch (error) {
    return probeFailure(BUDGET_PROBE_CATEGORY.REQUEST_INVALID, error?.message ?? error, null);
  }
}

// Compare le minimum au budget restant de l'invocation. status vient de
// getCallGuardStatus() : { configured, cap, used }. Seul le minimum est
// bloquant ; le maximum n'est jamais comparé.
export function evaluateCoverageBudget({ estimate, status } = {}) {
  if (!isObject(estimate) || estimate.status !== BUDGET_ESTIMATE_STATUS.OK) {
    return freezeAll({ verdict: BUDGET_VERDICT.OK, applicable: false });
  }

  if (!isObject(status) || status.configured !== true || !Number.isSafeInteger(status.cap) || !Number.isSafeInteger(status.used)) {
    return freezeAll({ verdict: BUDGET_VERDICT.OK, applicable: false });
  }

  const remaining = status.cap - status.used;

  return freezeAll({
    verdict: estimate.min_new_calls > remaining ? BUDGET_VERDICT.INSUFFICIENT : BUDGET_VERDICT.OK,
    applicable: true,
    required: estimate.min_new_calls,
    maximum: estimate.max_new_calls,
    remaining,
    cap: status.cap,
    used: status.used,
    segments_total: estimate.segments_total,
    segments_cached_round_1: estimate.segments_cached_round_1
  });
}
