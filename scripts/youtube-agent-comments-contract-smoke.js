// Smoke du contrat Comments : Priority, Fact Check, Human Review, quarantaine.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-comments-contract-smoke.js

import {
  COMMENT_STATES, COMMENT_TRANSITIONS, toStoredComment, advanceComment, editProposal, setProposal,
  approvalActionForComment, isPublishable, validateFactCheck, validatePriority
} from "../src/youtube-agent/comments/states.js";
import { createApproval } from "../src/youtube-agent/approvals.js";
import { check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const now = new Date("2026-06-01T10:00:00Z");
const LONG = "Question sur le canal. ".repeat(40);
const stored = toStoredComment({ channel_id: "nomade", comment_id: "c1", video_id: "dQw4w9WgXcQ", text: LONG, author_id: "u1" });
const priority = { score: 70, factors: [{ name: "question_directe", weight: 0.6, value: 1 }] };
const supported = { claims: [{ text: "Le vol dure 3 h", status: "supported", sources: [{ partition: "videos", ref: "ep1" }] }] };

function toFactChecked(c = stored) {
  let x = advanceComment(c, "classified");
  x = advanceComment({ ...x, priority }, "prioritized");
  x = advanceComment(x, "contextualized");
  return advanceComment({ ...x, fact_check: supported }, "fact_checked");
}

check("transitions : tous les états ont une entrée ; terminaux sans sortie", () => {
  for (const s of COMMENT_STATES) if (!(s in COMMENT_TRANSITIONS)) throw new Error(s);
  if (COMMENT_TRANSITIONS.published.length || COMMENT_TRANSITIONS.rejected.length) throw new Error("terminal");
});

check("commentaire stocké : empreintes + extrait borné, jamais le texte complet", () => {
  if (stored.excerpt.length !== 200 || JSON.stringify(stored).includes(LONG)) throw new Error("texte complet conservé");
  if (stored.comment_ref.length !== 64 || stored.text_sha256.length !== 64 || stored.state !== "ingested") throw new Error("empreintes");
  throwsWith(() => toStoredComment({ channel_id: "nomade", comment_id: "c", video_id: "v", text: "", author_id: "u" }), "text");
});

check("Priority : score explicable obligatoire", () => {
  throwsWith(() => advanceComment(advanceComment(stored, "classified"), "prioritized"), "priorité");
  throwsWith(() => validatePriority({ score: 101, factors: priority.factors }), "score");
  throwsWith(() => validatePriority({ score: 5, factors: [] }), "facteurs");
  throwsWith(() => validatePriority({ score: 5, factors: [{ name: "x", weight: 2, value: 0 }] }), "facteur");
});

check("Fact Check : claim soutenu = source knowledge/videos ; sinon refus", () => {
  throwsWith(() => validateFactCheck({ claims: [{ text: "a", status: "supported", sources: [] }] }), "sans source");
  throwsWith(() => validateFactCheck({ claims: [{ text: "a", status: "supported", sources: [{ partition: "comments", ref: "x" }] }] }), "hors knowledge/videos");
  throwsWith(() => validateFactCheck({ claims: [{ text: "a", status: "peut-être" }] }), "statut");
  if (!isPublishable(supported)) throw new Error("soutenu devrait être publiable");
});

check("parcours nominal : proposition → revue → approbation → publication (contrat)", () => {
  let c = toFactChecked();
  c = advanceComment(setProposal(c, "Merci ! Le vol dure 3 h."), "proposed");
  c = advanceComment(c, "in_review");
  const approval = createApproval({ action: approvalActionForComment(c), now });
  c = advanceComment(c, "approved", { approval, now });
  c = advanceComment(c, "published", { now });
  if (c.state !== "published") throw new Error("état final");
});

check("claim inconnu : pas de proposition ; retiré (dropped) : autorisée", () => {
  const unknown = { claims: [{ text: "Prix exact 120 €", status: "unknown" }, ...supported.claims] };
  let c = advanceComment(stored, "classified");
  c = advanceComment({ ...c, priority }, "prioritized");
  c = advanceComment(c, "contextualized");
  c = advanceComment({ ...c, fact_check: unknown }, "fact_checked");
  throwsWith(() => advanceComment(setProposal(c, "Prix 120 €"), "proposed"), "fact-check non résolu");
  const dropped = { claims: [{ ...unknown.claims[0], dropped: true }, supported.claims[0]] };
  advanceComment(setProposal({ ...c, fact_check: dropped }, "Merci !"), "proposed");
});

check("approbation obligatoire, liée au texte exact ; texte modifié → nouvelle approbation", () => {
  let c = advanceComment(setProposal(toFactChecked(), "Réponse A"), "proposed");
  c = advanceComment(c, "in_review");
  throwsWith(() => advanceComment(c, "approved", { now }), "approbation refusée");
  const forA = createApproval({ action: approvalActionForComment(c), now });
  const approved = advanceComment(c, "approved", { approval: forA, now });
  // texte modifié après approbation : l'approbation ne vaut plus pour le nouveau texte
  const tampered = { ...approved, proposal: { ...approved.proposal, text: "Réponse B", text_sha256: setProposal(c, "Réponse B").proposal.text_sha256 } };
  throwsWith(() => advanceComment(tampered, "published", { now }), "publication refusée");
  // édition légitime : retour à contextualized, approbation effacée, fact-check à refaire
  const edited = editProposal(approved, "Réponse C");
  if (edited.state !== "contextualized" || edited.approval !== null || edited.fact_check !== null) throw new Error("édition");
  throwsWith(() => advanceComment(edited, "proposed"), "refusée");
});

check("approbation expirée → publication refusée", () => {
  let c = advanceComment(setProposal(toFactChecked(), "Réponse"), "proposed");
  c = advanceComment(c, "in_review");
  const a = createApproval({ action: approvalActionForComment(c), now, ttl_ms: 60_000 });
  const approved = advanceComment(c, "approved", { approval: a, now });
  throwsWith(() => advanceComment(approved, "published", { now: new Date(now.getTime() + 120_000) }), "approval_expired");
});

check("commentaire suspect d'injection : quarantaine ou rejet seulement", () => {
  const suspect = { ...stored, injection_suspected: true };
  throwsWith(() => advanceComment(suspect, "classified"), "suspect");
  const q = advanceComment(suspect, "quarantined");
  throwsWith(() => advanceComment(q, "classified"), "suspect");
  if (advanceComment(q, "rejected").state !== "rejected") throw new Error("rejet");
});

check("aucune transition hors table (ex. ingested → published, rejected → proposed)", () => {
  throwsWith(() => advanceComment(stored, "published"), "refusée");
  throwsWith(() => advanceComment({ ...stored, state: "rejected" }, "proposed"), "refusée");
  throwsWith(() => advanceComment(stored, "nimporte"), "inconnu");
});

done("youtube-agent-comments-contract-smoke");
