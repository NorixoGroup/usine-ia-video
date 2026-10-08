// R28.10 — porte de couverture du pipeline Script (baseline v1.0.3, contrats
// 4.7 et 4.8 ; invariants I20, I24). Pur câblage : elle prépare les entrées du
// coordinateur, l'appelle une fois par segment, agrège le statut du Script et
// relaie au propriétaire du cache (l'exécuteur) les réponses rejetées.
//
// Elle ne découpe, ne normalise, ne protège, ne classe, ne juge et ne répare
// rien elle-même : seul le coordinateur (R28.9) le fait, à travers les modules
// R28.1 à R28.8A. Elle n'écrit aucun checkpoint de chapitre (I24).
//
// Entrées fournies au coordinateur, par segment : segment_id, voiceover,
// claims, entités Research, verrou, transport, politique.
//
// Verrou : reconstruit à chaque exécution à partir des versions courantes des
// composants (son enregistrement et son contrôle à la reprise relèvent de
// R28.11).
//
// Script PASS si et seulement si chaque segment est PASS. Au premier segment
// NOT_PASS, la porte s'arrête (échec fermé, baseline v1.0.3 §4.7) : aucun
// segment suivant n'est évalué, aucun NOT_PASS n'est jamais converti en PASS.
//
// Cache (R28.10B) : toute réponse du transport qui n'est pas acceptée par un
// jugement JUDGED est rejetée ; son empreinte de requête est transmise à
// l'exécuteur dès la fin du segment, qui la retire du cache existant. Un
// retrait impossible est un NOT_PASS qualifié (CACHE_DISCARD_FAILED), jamais
// un succès silencieux.
//
// Transport (R28.10B) : une requête identique encore en cours (relance après
// TIMEOUT) réutilise l'appel en cours au lieu d'en lancer un second, refusé
// par le garde d'appels. Un refus du garde (plafond, NO_API, autorisation)
// est qualifié JUDGE_CALL_REFUSED ; un budget épuisé par des TIMEOUT est
// qualifié JUDGE_TIMEOUT.
//
// Ne lève jamais : toute erreur inattendue est un NOT_PASS UNEXPECTED, avec
// son message expurgé.

import { createMessage } from "../services/anthropic.js";
import { discardCachedResponse, redactSecrets } from "../services/call-guard.js";
import { COVERAGE_NORMALIZATION_VERSION } from "./coverage-normalization.js";
import { coverageUnitSplitterVersion } from "./coverage-unit-splitter.js";
import { coverageProtectionVersion, extractResearchEntities, RESEARCH_ENTITY_RULE_VERSION } from "./coverage-protection.js";
import { coverageClassificationVersion } from "./coverage-classification.js";
import { ARCHITECTURE_BASELINE_VERSION, boundaryProtocolIdFromLock, coverageJudgeV2Version, judgeLockSha256 } from "./coverage-judge-v2.js";
import { discardRejectedJudgeResponses } from "./coverage-judge-executor.js";
import { COVERAGE_REPAIR_VERSION } from "./coverage-repair.js";
import { coordinateCoverage } from "./coverage-coordinator.js";

export const SCRIPT_COVERAGE_GATE_VERSION = "script-coverage-gate.v1";

// Politique versionnée du coordinateur (élément 10 du verrou).
export const SCRIPT_COVERAGE_POLICY = Object.freeze({
  version: "coverage-coordinator-policy.v1",
  max_rounds: 10,
  max_total_judge_calls: 12
});

export const SCRIPT_COVERAGE_STATUS = Object.freeze({ PASS: "PASS", NOT_PASS: "NOT_PASS" });

// Raisons propres à la porte, en plus des raisons du coordinateur.
export const SCRIPT_COVERAGE_GATE_REASON = Object.freeze({
  NO_SEGMENT: "NO_SEGMENT",
  UNEXPECTED: "UNEXPECTED",
  CACHE_DISCARD_FAILED: "CACHE_DISCARD_FAILED",
  JUDGE_TIMEOUT: "JUDGE_TIMEOUT",
  JUDGE_CALL_REFUSED: "JUDGE_CALL_REFUSED"
});

const LANGUAGE = "fr";
const BUDGET_EXHAUSTED = "JUDGE_BUDGET_EXHAUSTED";

function freezeAll(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeAll(value[key]);
    Object.freeze(value);
  }
  return value;
}

const errorDetail = error => redactSecrets(String(error?.message ?? error)).slice(0, 500);

// Liste d'entités Research : sortie de la règle d'extraction de Protection,
// appliquée aux key_facts du dossier.
export function researchEntitiesOf(research) {
  const keyFacts = Array.isArray(research?.key_facts)
    ? research.key_facts.map(fact => fact?.claim).filter(claim => typeof claim === "string")
    : [];
  return extractResearchEntities({ keyFacts, ruleVersion: RESEARCH_ENTITY_RULE_VERSION });
}

// Verrou complet (section 8), reconstruit à partir des versions courantes.
export function buildCoverageLock({ entities, policy = SCRIPT_COVERAGE_POLICY }) {
  return freezeAll({
    splitter: coverageUnitSplitterVersion(),
    normalization: COVERAGE_NORMALIZATION_VERSION,
    protection: coverageProtectionVersion(),
    entities_rule_version: entities?.rule_version ?? null,
    entities_fingerprint: entities?.fingerprint ?? null,
    classification: coverageClassificationVersion(),
    judge: coverageJudgeV2Version(),
    repair: COVERAGE_REPAIR_VERSION,
    coordinator: policy?.version ?? null,
    language: LANGUAGE,
    baseline: ARCHITECTURE_BASELINE_VERSION
  });
}

// Segments du script, dans l'ordre, avec leur identifiant de couverture.
function segmentsOf(script) {
  const segments = [];
  const sections = Array.isArray(script?.sections) ? script.sections : [];
  sections.forEach((section, sectionIndex) => {
    (Array.isArray(section?.segments) ? section.segments : []).forEach((segment, segmentIndex) => {
      segments.push({
        segment_id: `s${sectionIndex + 1}-g${segmentIndex + 1}`,
        label: `sections[${sectionIndex}].segments[${segmentIndex}]`,
        section_index: sectionIndex,
        segment_index: segmentIndex,
        segment
      });
    });
  });
  return segments;
}

// Forme minimale d'un résultat du coordinateur exploitable par la porte.
function wellFormed(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.history)) return false;
  const status = result.segment_status?.status;
  if (status !== SCRIPT_COVERAGE_STATUS.PASS && status !== SCRIPT_COVERAGE_STATUS.NOT_PASS) return false;
  if (status === SCRIPT_COVERAGE_STATUS.PASS && typeof result.final_voiceover !== "string") return false;
  return true;
}

// Métadonnées déterministes d'un segment, telles que stockées dans script.json
// (R28.10A D8 : covered et undeclared_claims, exigés par le validateur de
// qualité, et les métadonnées de couverture autorisées).
function segmentRecord(result, { lockSha256, protocolId }) {
  return {
    status: result.segment_status.status,
    covered: result.segment_status.status === SCRIPT_COVERAGE_STATUS.PASS,
    undeclared_claims: [],
    protocol_id: result.protocol_id ?? protocolId,
    lock_sha256: result.lock_sha256 ?? lockSha256,
    voiceover_sha256: result.final_voiceover_sha256 ?? null,
    rounds: result.rounds,
    repair_count: result.history.reduce((total, round) => total + (round?.delete?.deleted_unit_ids?.length ?? 0), 0)
  };
}

// Raison d'un NOT_PASS de segment. Requalifie un budget épuisé selon sa vraie
// cause : TIMEOUT répétés, ou refus du garde d'appels.
function failureOf(entry, result, refusals) {
  const status = result.segment_status;
  let reason = status.reason ?? null;
  let category = status.category ?? null;
  let detail = null;
  if (reason === BUDGET_EXHAUSTED && category === "TIMEOUT") {
    reason = SCRIPT_COVERAGE_GATE_REASON.JUDGE_TIMEOUT;
  } else if (reason === BUDGET_EXHAUSTED && refusals.length > 0) {
    reason = SCRIPT_COVERAGE_GATE_REASON.JUDGE_CALL_REFUSED;
    category = "CALL_REFUSED";
    detail = refusals[0];
  }
  return { segment_id: entry.segment_id, label: entry.label, reason, category, unit_ids: [...(status.unit_ids ?? [])], detail };
}

// Évalue la couverture de chaque segment du script. Ne modifie pas le script :
// les voiceovers finaux sont renvoyés, et appliqués par l'appelant sur PASS.
// Ne lève jamais.
export async function runScriptCoverageGate({
  script,
  research,
  transport = createMessage,
  policy = SCRIPT_COVERAGE_POLICY,
  coordinate = coordinateCoverage,
  discard = discardCachedResponse
} = {}) {
  const segments = [];
  const finalVoiceovers = [];
  const discarded = [];
  const discardFailed = [];
  let failure = null;
  let lock = null;
  let lockSha256 = null;
  let protocolId = null;

  // Réponses reçues et refus du garde, pour le segment en cours ; appels en
  // cours, par requête.
  let seenRequests = [];
  let refusals = [];
  const inFlight = new Map();

  // Transport enregistré : chaque réponse reçue est rattachée à son empreinte
  // de requête ; une requête identique encore en cours réutilise l'appel en
  // cours (relance après TIMEOUT) ; un refus du garde d'appels est noté.
  const recordingTransport = request => {
    const key = JSON.stringify(request);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const seen = seenRequests;
    const refused = refusals;
    const call = Promise.resolve()
      .then(() => transport(request))
      .then(reply => {
        if (typeof reply?.request_sha256 === "string") seen.push(reply.request_sha256);
        return reply;
      }, error => {
        if (error?.call_refused === true) refused.push(errorDetail(error));
        throw error;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, call);
    return call;
  };

  // Retire du cache les réponses du segment qui n'ont pas été acceptées.
  const releaseRejected = result => {
    const accepted = new Set();
    for (const round of Array.isArray(result?.history) ? result.history : []) {
      if (round?.judgment?.status === "JUDGED" && typeof round.judgment.request_sha256 === "string") {
        accepted.add(round.judgment.request_sha256);
      }
    }
    const removal = discardRejectedJudgeResponses({ requestSha256s: seenRequests.filter(hash => !accepted.has(hash)), discard });
    discarded.push(...removal.discarded);
    discardFailed.push(...removal.skipped);
    seenRequests = [];
    refusals = [];
    return removal.skipped.length === 0;
  };

  try {
    const entities = researchEntitiesOf(research);
    lock = buildCoverageLock({ entities, policy });
    lockSha256 = judgeLockSha256(lock);
    protocolId = boundaryProtocolIdFromLock(lock);
    const all = segmentsOf(script);

    if (all.length === 0) {
      failure = { segment_id: null, label: null, reason: SCRIPT_COVERAGE_GATE_REASON.NO_SEGMENT, category: null, unit_ids: [], detail: null };
    }

    for (const entry of all) {
      let result = null;
      let detail = null;
      try {
        result = await coordinate({
          segment: { segment_id: entry.segment_id, voiceover: entry.segment?.voiceover, entities },
          claims: entry.segment?.claims,
          lock,
          transport: recordingTransport,
          policy
        });
      } catch (error) {
        detail = errorDetail(error);
      }

      const segmentRefusals = refusals;
      const released = releaseRejected(result);

      if (!wellFormed(result)) {
        failure = { segment_id: entry.segment_id, label: entry.label, reason: SCRIPT_COVERAGE_GATE_REASON.UNEXPECTED, category: null, unit_ids: [], detail: detail ?? "résultat du coordinateur incohérent" };
      } else {
        segments.push(segmentRecord(result, { lockSha256, protocolId }));

        const passed = result.script_status === SCRIPT_COVERAGE_STATUS.PASS && result.segment_status.status === SCRIPT_COVERAGE_STATUS.PASS;
        if (!passed) failure = failureOf(entry, result, segmentRefusals);
      }

      // Un retrait impossible prime : il doit être visible même sur un
      // autre échec, et ne laisse jamais passer un PASS.
      if (!released) {
        failure = {
          segment_id: entry.segment_id,
          label: entry.label,
          reason: SCRIPT_COVERAGE_GATE_REASON.CACHE_DISCARD_FAILED,
          category: failure?.reason ?? null,
          unit_ids: [...(failure?.unit_ids ?? [])],
          detail: `retrait du cache impossible : ${discardFailed.join(", ")}`
        };
      }
      if (failure) break;

      finalVoiceovers.push({ section_index: entry.section_index, segment_index: entry.segment_index, voiceover: result.final_voiceover });
    }
  } catch (error) {
    releaseRejected(null);
    failure = { segment_id: null, label: null, reason: SCRIPT_COVERAGE_GATE_REASON.UNEXPECTED, category: null, unit_ids: [], detail: errorDetail(error) };
  }

  return freezeAll({
    version: SCRIPT_COVERAGE_GATE_VERSION,
    status: failure ? SCRIPT_COVERAGE_STATUS.NOT_PASS : SCRIPT_COVERAGE_STATUS.PASS,
    baseline: lock?.baseline ?? null,
    policy_version: policy?.version ?? null,
    lock_sha256: lockSha256,
    protocol_id: protocolId,
    segments,
    failure,
    final_voiceovers: failure ? [] : finalVoiceovers,
    discarded_request_sha256s: [...discarded],
    discard_failed_request_sha256s: [...discardFailed]
  });
}
