// Partitions de la mémoire. Un propriétaire d'écriture par partition ; les
// partitions « untrusted » (commentaires) n'exposent qu'une liste blanche de champs.

export const MEMORY_RECORD_MAX_BYTES = 8 * 1024;
export const SELECT_MAX_ENTRIES = 50;
export const SELECT_MAX_BYTES = 16 * 1024;
export const SELECT_SCAN_LINES = 1000;

const p = (owners, format, extra = {}) => Object.freeze({ owners: Object.freeze(owners), format, append_only: format === "jsonl", untrusted: false, ...extra });

export const PARTITIONS = Object.freeze({
  channel: p(["human"], "json"),
  knowledge: p(["human"], "json"),
  videos: p(["agent", "publishing"], "json"),
  analytics: p(["analytics"], "jsonl"),
  learning: p(["learning"], "jsonl"),
  comments: p(["comments"], "jsonl", {
    untrusted: true,
    // Jamais de texte brut dans une sélection : empreintes, classes, états seulement.
    selectable_fields: Object.freeze(["comment_ref", "text_sha256", "video_id", "state", "class", "priority_score"]),
    // Lecture dédiée à la revue humaine : affichage seulement, jamais vers un prompt.
    review_fields: Object.freeze(["comment_ref", "video_id", "state", "class", "priority_score", "author_ref", "excerpt", "proposal_text"]),
    review_states: Object.freeze(["proposed", "in_review", "approved"])
  }),
  prompts: p(["learning", "human"], "jsonl"),
  journal: p(["agent"], "jsonl"),
  // Connexion YouTube : jamais lisible par une sélection de contexte ni par le pont.
  oauth: p(["connector"], "json", { sensitive: true }),
  quota: p(["connector"], "json"),
  // Miroir en lecture seule de la chaîne et des vidéos YouTube (distinct du registre `videos`).
  youtube: p(["sync"], "json")
});
