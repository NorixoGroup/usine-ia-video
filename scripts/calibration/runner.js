// R29.6 — outil de calibration du juge : exécution d'un lot d'entrées et
// condensé de chaque résultat (jetable, hors pipeline de production).
//
// Aucun appel n'est lancé ici : le transport est TOUJOURS fourni par
// l'appelant (transport simulé des smokes et du mode simulation, ou, dans le
// seul mode réel du CLI, le transport de production). Ce module n'importe
// aucun service (ni Anthropic, ni garde d'appels) et ne lit ni n'écrit aucun
// fichier. Il se sert de la porte de couverture de production telle quelle,
// une entrée à la fois, et capture le résultat détaillé du coordinateur.

import { runScriptCoverageGate } from "../../src/utils/script-coverage-gate.js";
import { coordinateCoverage } from "../../src/utils/coverage-coordinator.js";
import { SCRIPT_COVERAGE_POLICY } from "../../src/utils/coverage-lock-builder.js";
import { sha256, stableJson } from "./corpus.js";

export const CALIBRATION_RECORD_VERSION = "judge-calibration-record.v1";

// Raisons de la porte qui arrêtent le lot : continuer serait inutile (budget)
// ou dangereux (cache impossible à nettoyer).
export const HALTING_REASONS = Object.freeze(["BUDGET_INSUFFICIENT", "BUDGET_PROBE_FAILED", "CACHE_DISCARD_FAILED", "JUDGE_CALL_REFUSED"]);

const plain = value => JSON.parse(JSON.stringify(value ?? null));
const HEADER = "SEGMENT A AUDITER :\n\n";

// ---------------------------------------------------------------------------
// Transport simulé (mode simulation du CLI et smokes). Répond au format du
// juge v2 à partir de la requête reçue, sans réseau. Déterministe.
//   covered : tout COVERED
//   mixed   : environ une unité sur cinq UNCOVERED (DELETE, ou DECLARE une fois sur quatre)
//   declare : la première unité désignée est toujours UNCOVERED + DECLARE
export const SIMULATION_MODES = Object.freeze(["covered", "mixed", "declare"]);

export function simulatedJudgeTransport({ mode = "covered" } = {}) {
  if (!SIMULATION_MODES.includes(mode)) throw new Error(`Simulation : mode inconnu « ${mode} ».`);

  return async request => {
    const content = request?.messages?.[0]?.content;
    if (typeof content !== "string" || !content.startsWith(HEADER)) throw new Error("Simulation : requête du juge illisible.");
    const payload = JSON.parse(content.slice(HEADER.length));
    const claimIds = payload.claims.map(claim => claim.claim_id);

    const results = payload.designated_unit_ids.map((unitId, index) => {
      const digest = sha256(`${payload.voiceover_sha256}:${unitId}`);
      const byte = Number.parseInt(digest.slice(0, 2), 16);
      const uncovered = mode === "declare" ? index === 0 : mode === "mixed" && byte % 5 === 0;
      if (!uncovered) return { unit_id: unitId, verdict: "COVERED", operations: [] };
      const declare = claimIds.length > 0 && (mode === "declare" || Number.parseInt(digest.slice(2, 4), 16) % 4 === 0);
      return {
        unit_id: unitId,
        verdict: "UNCOVERED",
        operations: [declare ? { action: "DECLARE", claim_id: claimIds[0] } : { action: "DELETE" }]
      };
    });

    const text = JSON.stringify({
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results
    });
    return {
      request_sha256: sha256(stableJson(request)),
      meta: {
        model: "simulation",
        input_tokens: Math.ceil((request.system.length + content.length) / 3),
        output_tokens: Math.ceil(text.length / 3),
        stop_reason: "end_turn",
        duration_ms: 1
      },
      response: { content: [{ type: "text", text }] }
    };
  };
}

// Plafond propre à l'outil, indépendant de celui du garde d'appels : compte
// chaque invocation du transport (cache compris, donc par excès) et refuse la
// suivante, avec la marque `call_refused` des refus du garde.
export function cappedTransport({ transport, cap }) {
  if (typeof transport !== "function") throw new Error("Calibration : transport obligatoire.");
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Calibration : plafond d'appels invalide.");
  const state = { invocations: 0 };
  const wrapped = async request => {
    if (state.invocations >= cap) {
      throw Object.assign(new Error(`Plafond de l'outil de calibration atteint (${cap}) : appel refusé.`), { call_refused: true });
    }
    state.invocations += 1;
    return transport(request);
  };
  wrapped.invocations = () => state.invocations;
  return wrapped;
}

// ---------------------------------------------------------------------------
// Condensé d'un résultat : tout ce que les métriques et le rapport utilisent,
// en JSON simple (aucun objet gelé ni cyclique).

function unitsOf(boundary) {
  const states = new Map((boundary?.units ?? []).map(item => [item.unit_id, item.state]));
  return (boundary?.units ?? []).map(item => ({
    unit_id: item.unit_id,
    type: item.unit.type,
    state: states.get(item.unit_id) ?? null,
    start: item.unit.start,
    end: item.unit.end,
    text: item.unit.text
  }));
}

function judgmentOf(judgment) {
  if (!judgment) return null;
  return {
    status: judgment.status,
    failure: judgment.failure ? { category: judgment.failure.category, reason: judgment.failure.reason } : null,
    request_sha256: judgment.request_sha256 ?? null,
    usage: judgment.usage
      ? {
        model: judgment.usage.model ?? null,
        input_tokens: judgment.usage.input_tokens ?? null,
        output_tokens: judgment.usage.output_tokens ?? null,
        stop_reason: judgment.usage.stop_reason ?? null,
        duration_ms: judgment.usage.duration_ms ?? null
      }
      : null,
    verdicts: judgment.results.map(item => ({
      unit_id: item.unit_id,
      verdict: item.verdict,
      action: item.operation?.action ?? null,
      claim_id: item.operation?.claim_id ?? null
    }))
  };
}

export function digestRun({ entry, gate, captured, wallMs = null, stabilityRun = false }) {
  const history = Array.isArray(captured?.history) ? captured.history : [];
  const first = history[0]?.boundary ?? null;
  return plain({
    version: CALIBRATION_RECORD_VERSION,
    entry_id: entry.id,
    kind: entry.kind,
    stage: entry.stage,
    stability_run: stabilityRun,
    expect: entry.expect,
    initial: {
      voiceover_chars: entry.segment.voiceover.length,
      claims: entry.segment.claims.length
    },
    // R29.6b : claims du segment (texte, key_fact, is_unverified), pour le rapport.
    claims: entry.segment.claims.map(claim => ({
      text: claim.text,
      ...(typeof claim.key_fact === "string" ? { key_fact: claim.key_fact } : {}),
      ...(typeof claim.is_unverified === "boolean" ? { is_unverified: claim.is_unverified } : {})
    })),
    gate: {
      status: gate.status,
      failure: gate.failure ? { reason: gate.failure.reason, category: gate.failure.category, detail: gate.failure.detail } : null,
      lock_sha256: gate.lock_sha256,
      protocol_id: gate.protocol_id,
      budget_preflight: gate.budget_preflight
    },
    result: captured
      ? {
        status: captured.segment_status.status,
        reason: captured.segment_status.reason,
        category: captured.segment_status.category,
        unit_ids: captured.segment_status.unit_ids,
        rounds: captured.rounds,
        judge_calls: captured.judge_calls,
        final_chars: typeof captured.final_voiceover === "string" ? captured.final_voiceover.length : null,
        final_voiceover_sha256: captured.final_voiceover_sha256
      }
      : null,
    units_round1: unitsOf(first),
    rounds: history.map(round => ({
      round: round.round,
      boundary_status: round.boundary?.status ?? null,
      designated: round.boundary?.analysed_unit_ids?.length ?? 0,
      units: unitsOf(round.boundary),
      judgment: judgmentOf(round.judgment),
      repair: round.repair
        ? { status: round.repair.status, refusal: round.repair.refusal, repaired_unit_ids: round.repair.repaired_unit_ids }
        : null,
      delete: round.delete
        ? { status: round.delete.status, refusal: round.delete.refusal, deleted_unit_ids: round.delete.deleted_unit_ids }
        : null
    })),
    wall_ms: wallMs
  });
}

// ---------------------------------------------------------------------------

// Exécute les entrées, une par une, dans l'ordre, à travers la porte de
// couverture. `gate` est injectable pour les smokes ; `budget` n'est fourni
// que par le mode réel (préflight du garde d'appels).
export async function runCalibration({
  entries,
  transport,
  cap,
  budget,
  policy = SCRIPT_COVERAGE_POLICY,
  gate = runScriptCoverageGate,
  coordinate = coordinateCoverage,
  stabilityRun = false,
  now = () => Date.now(),
  onRecord = () => {}
} = {}) {
  if (!Array.isArray(entries)) throw new Error("Calibration : entrées obligatoires.");
  const capped = cappedTransport({ transport, cap });
  const records = [];
  let halted = null;

  for (const entry of entries) {
    let captured = null;
    const started = now();
    // Seul le texte des claims part au juge : les champs ajoutés par la
    // construction du corpus (key_fact, is_unverified…) ne changent pas la requête.
    const script = { sections: [{ segments: [{ voiceover: entry.segment.voiceover, claims: entry.segment.claims.map(claim => ({ text: claim.text })) }] }] };
    const result = await gate({
      script,
      research: entry.research,
      transport: capped,
      coordinate: async input => { captured = await coordinate(input); return captured; },
      policy,
      ...(budget ? { budget } : {})
    });
    const record = digestRun({ entry, gate: result, captured, wallMs: now() - started, stabilityRun });
    records.push(record);
    onRecord(record);

    if (record.gate.failure && HALTING_REASONS.includes(record.gate.failure.reason)) {
      halted = { entry_id: entry.id, reason: record.gate.failure.reason, detail: record.gate.failure.detail };
      break;
    }
  }

  return { records, halted, tool_calls: capped.invocations() };
}
