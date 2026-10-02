// Contrat du Learning Engine :
//   Observation → Evidence → Validated → Learning → Prompt Update
// Seule la validation humaine fait passer une observation en apprentissage.
// Aucun prompt n'est modifié ici : une mise à jour est une proposition versionnée ;
// pour un moteur existant (code protégé) elle reste une proposition exportable.

import crypto from "node:crypto";

import { sha256Hex, verifyApproval } from "../approvals.js";
import { getEngine } from "../engines.js";
import { MIN_SAMPLE_SIZE } from "../analytics/stages.js";

export const LEARNING_STATES = Object.freeze(["observation", "evidence", "validated", "learning", "prompt_update", "revoked"]);

export const LEARNING_TRANSITIONS = Object.freeze({
  observation: ["evidence", "revoked"],
  evidence: ["validated", "revoked"],
  validated: ["learning", "revoked"],
  learning: ["prompt_update", "revoked"],
  prompt_update: ["revoked"],
  revoked: []
});

export const DEFAULT_LEARNING_TTL_DAYS = 90;
export const MAX_LEARNING_TTL_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

function guardTransition(record, to) {
  if (!LEARNING_TRANSITIONS[record.state]?.includes(to)) throw new Error(`transition refusée : ${record.state} → ${to}`);
}

export function createObservation({ text, source_engine, source_ref = null, now = new Date() }) {
  if (typeof text !== "string" || !text.trim() || text.length > 300) throw new Error("observation : texte invalide");
  if (source_engine !== "human" && !getEngine(source_engine)) throw new Error("observation : source inconnue");

  return { id: crypto.randomUUID(), state: "observation", text, source_engine, source_ref, created_at: now.toISOString() };
}

// Preuves : références {partition, ref} + effectif minimal. Une observation issue
// de commentaires exige au moins une preuve hors commentaires.
export function attachEvidence(record, { evidence_refs, sample_size }) {
  guardTransition(record, "evidence");

  if (!Array.isArray(evidence_refs) || evidence_refs.length === 0 || evidence_refs.some(r => typeof r?.partition !== "string" || typeof r?.ref !== "string" || !r.ref)) {
    throw new Error("evidence : références requises");
  }
  if (!Number.isInteger(sample_size) || sample_size < MIN_SAMPLE_SIZE) throw new Error(`evidence : sample_size ≥ ${MIN_SAMPLE_SIZE} requis`);
  if (record.source_engine === "comments" && evidence_refs.every(r => r.partition === "comments")) {
    throw new Error("evidence : une observation issue de commentaires exige une preuve hors commentaires");
  }

  return { ...record, state: "evidence", evidence: { refs: evidence_refs, sample_size } };
}

export function validationActionFor(record, channelId) {
  return { channel_id: channelId, engine: "learning", action: "learning:validate", subject_id: record.id, content_sha256: sha256Hex(record.text) };
}

// Jamais automatique : approbation humaine liée au texte exact.
export function validateLearning(record, { channelId, approval, now = new Date() }) {
  guardTransition(record, "validated");

  const verdict = verifyApproval(approval, validationActionFor(record, channelId), { now });

  if (!verdict.ok) throw new Error(`validation refusée : ${verdict.reason}`);

  return { ...record, state: "validated", validated_at: now.toISOString() };
}

export function formalizeLearning(record, { rule, confidence, ttl_days = DEFAULT_LEARNING_TTL_DAYS, now = new Date() }) {
  guardTransition(record, "learning");

  if (!rule || typeof rule.statement !== "string" || !rule.statement || rule.statement.length > 300) throw new Error("learning : règle invalide");
  if (typeof rule.scope !== "string" || !rule.scope) throw new Error("learning : portée requise");
  if (rule.target_engine !== "any" && !getEngine(rule.target_engine)) throw new Error("learning : moteur cible inconnu");
  if (!["low", "medium", "high"].includes(confidence)) throw new Error("learning : confiance invalide");
  if (!Number.isInteger(ttl_days) || ttl_days < 1 || ttl_days > MAX_LEARNING_TTL_DAYS) throw new Error("learning : expiration invalide");

  return { ...record, state: "learning", rule, confidence, expires_at: new Date(now.getTime() + ttl_days * DAY_MS).toISOString() };
}

export function isActiveLearning(record, now = new Date()) {
  return record.state === "learning" && Date.parse(record.expires_at) > now.getTime();
}

// Proposition versionnée. Un moteur existant (code protégé) : export seulement.
export function proposePromptUpdate(record, { target_engine, prompt_id, diff_sha256, now = new Date() }) {
  guardTransition(record, "prompt_update");

  if (!isActiveLearning(record, now)) throw new Error("apprentissage expiré");

  const engine = getEngine(target_engine);

  if (!engine) throw new Error("moteur cible inconnu");
  if (typeof prompt_id !== "string" || !prompt_id || !/^[0-9a-f]{64}$/.test(diff_sha256 ?? "")) throw new Error("proposition invalide");

  return {
    ...record,
    state: "prompt_update",
    prompt_update: {
      target_engine, prompt_id, diff_sha256,
      mode: engine.kind === "existing" ? "export_only" : "proposal",
      applied: false,
      proposed_at: now.toISOString()
    }
  };
}

export function promptUpdateActionFor(record, channelId) {
  return { channel_id: channelId, engine: "learning", action: "prompt:apply", subject_id: record.id, content_sha256: record.prompt_update.diff_sha256 };
}

export function applyPromptUpdate(record, { channelId, approval, now = new Date() }) {
  if (record.state !== "prompt_update") throw new Error("aucune mise à jour proposée");
  if (record.prompt_update.mode === "export_only") throw new Error("moteur existant protégé : proposition exportable seulement");

  const verdict = verifyApproval(approval, promptUpdateActionFor(record, channelId), { now });

  if (!verdict.ok) throw new Error(`application refusée : ${verdict.reason}`);

  return { ...record, prompt_update: { ...record.prompt_update, applied: true, applied_at: now.toISOString() } };
}

export function revokeLearning(record, { reason, now = new Date() }) {
  guardTransition(record, "revoked");

  if (typeof reason !== "string" || !reason.trim() || reason.length > 200) throw new Error("révocation : motif requis");

  return { ...record, state: "revoked", revoked_at: now.toISOString(), revoked_reason: reason };
}
