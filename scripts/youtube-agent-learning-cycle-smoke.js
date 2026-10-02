// Smoke du cycle Learning : Observation → Evidence → Validated → Learning → Prompt Update.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-learning-cycle-smoke.js

import {
  LEARNING_TRANSITIONS, createObservation, attachEvidence, validateLearning, formalizeLearning,
  proposePromptUpdate, applyPromptUpdate, revokeLearning, isActiveLearning,
  validationActionFor, promptUpdateActionFor, DEFAULT_LEARNING_TTL_DAYS
} from "../src/youtube-agent/learning/cycle.js";
import { createApproval } from "../src/youtube-agent/approvals.js";
import { MIN_SAMPLE_SIZE } from "../src/youtube-agent/analytics/stages.js";
import { check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const now = new Date("2026-06-01T10:00:00Z");
const ch = "nomade";
const refs = [{ partition: "analytics", ref: "snap-1" }];
const DIFF = "a".repeat(64);
const rule = { scope: "intros", target_engine: "any", statement: "Ouvrir sur la question du spectateur" };

function upToValidated(source = "analytics") {
  const o = createObservation({ text: "Les intros courtes retiennent mieux", source_engine: source, now });
  const e = attachEvidence(o, { evidence_refs: refs, sample_size: MIN_SAMPLE_SIZE });
  return validateLearning(e, { channelId: ch, approval: createApproval({ action: validationActionFor(e, ch), now }), now });
}

check("le cycle ne contient que les cinq états + révocation, dans le bon sens", () => {
  if (LEARNING_TRANSITIONS.observation.join() !== "evidence,revoked" || LEARNING_TRANSITIONS.revoked.length) throw new Error("table");
});

check("observation : source connue, texte borné", () => {
  throwsWith(() => createObservation({ text: "", source_engine: "analytics" }), "texte");
  throwsWith(() => createObservation({ text: "x", source_engine: "inconnu" }), "source");
});

check("evidence : références et effectif minimal obligatoires", () => {
  const o = createObservation({ text: "x", source_engine: "analytics", now });
  throwsWith(() => attachEvidence(o, { evidence_refs: [], sample_size: 9 }), "références");
  throwsWith(() => attachEvidence(o, { evidence_refs: refs, sample_size: MIN_SAMPLE_SIZE - 1 }), "sample_size");
});

check("observation issue de commentaires : preuve hors commentaires obligatoire", () => {
  const o = createObservation({ text: "Les gens demandent X", source_engine: "comments", now });
  throwsWith(() => attachEvidence(o, { evidence_refs: [{ partition: "comments", ref: "c1" }], sample_size: 50 }), "hors commentaires");
  attachEvidence(o, { evidence_refs: [{ partition: "comments", ref: "c1" }, ...refs], sample_size: 50 });
});

check("validation : humaine, liée au texte exact — jamais automatique", () => {
  const o = createObservation({ text: "Texte A", source_engine: "analytics", now });
  const e = attachEvidence(o, { evidence_refs: refs, sample_size: 5 });
  throwsWith(() => validateLearning(e, { channelId: ch, approval: null, now }), "approval_missing");
  const other = createApproval({ action: validationActionFor({ ...e, text: "Texte B" }, ch), now });
  throwsWith(() => validateLearning(e, { channelId: ch, approval: other, now }), "action_mismatch");
  throwsWith(() => validateLearning(o, { channelId: ch, approval: createApproval({ action: validationActionFor(o, ch), now }), now }), "refusée");
});

check("états non sautables (observation → learning refusé)", () => {
  const o = createObservation({ text: "x", source_engine: "analytics", now });
  throwsWith(() => formalizeLearning(o, { rule, confidence: "low", now }), "refusée");
  throwsWith(() => proposePromptUpdate(o, { target_engine: "thumbnail", prompt_id: "p", diff_sha256: DIFF, now }), "refusée");
});

check("learning : règle, portée, confiance, expiration par défaut 90 jours", () => {
  const v = upToValidated();
  throwsWith(() => formalizeLearning(v, { rule: { ...rule, target_engine: "inconnu" }, confidence: "low", now }), "moteur cible");
  throwsWith(() => formalizeLearning(v, { rule, confidence: "sure", now }), "confiance");
  throwsWith(() => formalizeLearning(v, { rule, confidence: "low", ttl_days: 999, now }), "expiration");
  const l = formalizeLearning(v, { rule, confidence: "medium", now });
  if (Date.parse(l.expires_at) - now.getTime() !== DEFAULT_LEARNING_TTL_DAYS * 86400000) throw new Error("TTL");
  if (!isActiveLearning(l, now) || isActiveLearning(l, new Date(now.getTime() + 91 * 86400000))) throw new Error("expiration");
});

check("Prompt Update — moteur existant (script) : proposition exportable, jamais appliquée", () => {
  const l = formalizeLearning(upToValidated(), { rule, confidence: "medium", now });
  const u = proposePromptUpdate(l, { target_engine: "script", prompt_id: "script-main", diff_sha256: DIFF, now });
  if (u.prompt_update.mode !== "export_only" || u.prompt_update.applied) throw new Error("mode");
  const approval = createApproval({ action: promptUpdateActionFor(u, ch), now });
  throwsWith(() => applyPromptUpdate(u, { channelId: ch, approval, now }), "protégé");
});

check("Prompt Update — nouveau moteur : application seulement avec approbation humaine", () => {
  const l = formalizeLearning(upToValidated(), { rule, confidence: "medium", now });
  const u = proposePromptUpdate(l, { target_engine: "thumbnail", prompt_id: "thumb-main", diff_sha256: DIFF, now });
  if (u.prompt_update.mode !== "proposal" || u.prompt_update.applied) throw new Error("mode");
  throwsWith(() => applyPromptUpdate(u, { channelId: ch, approval: null, now }), "approval_missing");
  const a = applyPromptUpdate(u, { channelId: ch, approval: createApproval({ action: promptUpdateActionFor(u, ch), now }), now });
  if (!a.prompt_update.applied) throw new Error("non appliqué");
  throwsWith(() => proposePromptUpdate(l, { target_engine: "thumbnail", prompt_id: "p", diff_sha256: "xyz", now }), "invalide");
});

check("apprentissage expiré : plus de proposition de prompt", () => {
  const l = formalizeLearning(upToValidated(), { rule, confidence: "low", ttl_days: 1, now });
  throwsWith(() => proposePromptUpdate(l, { target_engine: "thumbnail", prompt_id: "p", diff_sha256: DIFF, now: new Date(now.getTime() + 2 * 86400000) }), "expiré");
});

check("révocation motivée ; état terminal", () => {
  const l = formalizeLearning(upToValidated(), { rule, confidence: "low", now });
  throwsWith(() => revokeLearning(l, { reason: "" }), "motif");
  const r = revokeLearning(l, { reason: "contredit par de nouvelles données", now });
  if (r.state !== "revoked" || isActiveLearning(r, now)) throw new Error("révocation");
  throwsWith(() => revokeLearning(r, { reason: "encore" }), "refusée");
});

done("youtube-agent-learning-cycle-smoke");
