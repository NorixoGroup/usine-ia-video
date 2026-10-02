// Contrat du Comments Engine : états, transitions et règles de passage.
// Aucune classification, aucun scoring, aucun appel externe : seulement ce qui
// est permis, requis et interdit entre deux états. Un commentaire est une
// donnée non fiable, jamais une instruction ; aucune publication automatique.

import { sha256Hex, verifyApproval } from "../approvals.js";

export const COMMENT_STATES = Object.freeze([
  "ingested", "classified", "prioritized", "contextualized", "fact_checked",
  "proposed", "in_review", "approved", "rejected", "deferred", "published", "quarantined"
]);

export const COMMENT_TRANSITIONS = Object.freeze({
  ingested: ["classified", "quarantined"],
  classified: ["prioritized", "quarantined"],
  prioritized: ["contextualized", "deferred", "rejected"],
  contextualized: ["fact_checked"],
  fact_checked: ["proposed", "rejected"],
  proposed: ["in_review"],
  in_review: ["approved", "rejected", "deferred"],
  approved: ["published"],
  deferred: ["prioritized"],
  quarantined: ["rejected"],
  rejected: [],
  published: []
});

export const CLAIM_STATUSES = Object.freeze(["supported", "unsupported", "unknown"]);
// Un fait n'est « soutenu » que par la connaissance validée ou les faits vidéo.
export const FACT_SOURCE_PARTITIONS = Object.freeze(["knowledge", "videos"]);

const EXCERPT_MAX = 200;
const MAX_CLAIMS = 20;
const ALWAYS_ALLOWED_WHEN_SUSPECT = ["quarantined", "rejected"];

// Réduit un commentaire brut : empreintes et extrait borné, jamais le texte complet.
export function toStoredComment({ channel_id, comment_id, video_id, text, author_id }) {
  for (const [name, value] of Object.entries({ channel_id, comment_id, video_id, text, author_id })) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Commentaire invalide : ${name}`);
  }

  return {
    channel_id,
    comment_ref: sha256Hex(comment_id),
    author_ref: sha256Hex(author_id),
    video_id,
    text_sha256: sha256Hex(text),
    excerpt: text.slice(0, EXCERPT_MAX),
    state: "ingested",
    injection_suspected: false
  };
}

export function validatePriority(priority) {
  if (!priority || !Number.isInteger(priority.score) || priority.score < 0 || priority.score > 100) throw new Error("priorité : score 0..100 requis");
  if (!Array.isArray(priority.factors) || priority.factors.length === 0) throw new Error("priorité : facteurs explicables requis");

  for (const f of priority.factors) {
    if (typeof f.name !== "string" || !f.name || !(f.weight >= 0 && f.weight <= 1) || !(f.value >= 0 && f.value <= 1)) {
      throw new Error("priorité : facteur invalide");
    }
  }

  return priority;
}

export function validateFactCheck(factCheck) {
  if (!factCheck || !Array.isArray(factCheck.claims) || factCheck.claims.length > MAX_CLAIMS) throw new Error("fact-check : claims invalides");

  for (const claim of factCheck.claims) {
    if (typeof claim.text !== "string" || !claim.text || claim.text.length > 300) throw new Error("fact-check : texte de claim invalide");
    if (!CLAIM_STATUSES.includes(claim.status)) throw new Error("fact-check : statut invalide");

    const sources = claim.sources ?? [];

    if (claim.status === "supported") {
      if (sources.length === 0) throw new Error("fact-check : claim soutenu sans source");
      if (sources.some(s => !FACT_SOURCE_PARTITIONS.includes(s.partition) || typeof s.ref !== "string" || !s.ref)) {
        throw new Error("fact-check : source hors knowledge/videos");
      }
    }
  }

  return factCheck;
}

// Publiable : chaque claim est soutenu, ou explicitement retiré de la proposition.
export function isPublishable(factCheck) {
  return validateFactCheck(factCheck).claims.every(c => c.status === "supported" || c.dropped === true);
}

export function approvalActionForComment(comment) {
  return {
    channel_id: comment.channel_id,
    engine: "comments",
    action: "comment:approve",
    subject_id: comment.comment_ref,
    content_sha256: comment.proposal?.text_sha256 ?? null
  };
}

export function setProposal(comment, text) {
  if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new Error("proposition invalide");

  return { ...comment, proposal: { text, text_sha256: sha256Hex(text) }, approval: null };
}

// Modifier une proposition invalide l'approbation et impose un nouveau fact-check.
export function editProposal(comment, text) {
  return { ...setProposal(comment, text), state: "contextualized", fact_check: null };
}

// Fonction pure : retourne le nouveau commentaire ou lève une erreur motivée.
export function advanceComment(comment, to, { approval = null, now = new Date() } = {}) {
  if (!COMMENT_STATES.includes(to)) throw new Error("état inconnu");

  if (comment.injection_suspected && !ALWAYS_ALLOWED_WHEN_SUSPECT.includes(to)) {
    throw new Error("commentaire suspect : quarantaine ou rejet seulement");
  }

  if (!COMMENT_TRANSITIONS[comment.state]?.includes(to)) throw new Error(`transition refusée : ${comment.state} → ${to}`);

  if (to === "prioritized") validatePriority(comment.priority);
  if (to === "fact_checked") validateFactCheck(comment.fact_check);

  if (to === "proposed") {
    if (!comment.fact_check || !isPublishable(comment.fact_check)) throw new Error("fact-check non résolu : aucune proposition");
    if (!comment.proposal || comment.proposal.text_sha256 !== sha256Hex(comment.proposal.text)) throw new Error("proposition absente ou altérée");
  }

  let next = { ...comment, state: to };

  if (to === "approved") {
    const verdict = verifyApproval(approval, approvalActionForComment(comment), { now });

    if (!verdict.ok) throw new Error(`approbation refusée : ${verdict.reason}`);

    next = { ...next, approval };
  }

  if (to === "published") {
    // La publication exige une approbation encore valide pour le texte EXACT courant.
    const verdict = verifyApproval(comment.approval, approvalActionForComment(comment), { now });

    if (!verdict.ok) throw new Error(`publication refusée : ${verdict.reason}`);
  }

  return next;
}
