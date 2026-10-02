// Contrat de l'Analytics Engine : étapes et règles de validité. Aucun calcul,
// aucun appel externe. Un insight est descriptif ; une recommandation cite ses
// preuves et son effectif ; une idée n'est jamais produite automatiquement.

export const ANALYTICS_STAGES = Object.freeze(["collect", "snapshot", "insights", "recommendations", "next_ideas"]);

// Effectif minimal avant toute recommandation (paramétrable par le propriétaire).
export const MIN_SAMPLE_SIZE = 5;

export const CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC = /^[a-z][a-z0-9_]{0,39}$/;

function text(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} invalide`);
}

function refs(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some(r => typeof r !== "string" || !r)) throw new Error(`${name} : preuves requises`);
}

export function validateSnapshot(s) {
  if (typeof s?.video_id !== "string" || !s.video_id) throw new Error("snapshot : video_id");
  if (Number.isNaN(Date.parse(s.captured_at))) throw new Error("snapshot : captured_at");
  if (!s.metrics || typeof s.metrics !== "object") throw new Error("snapshot : metrics");

  for (const [name, value] of Object.entries(s.metrics)) {
    if (!METRIC.test(name) || !Number.isFinite(value) || value < 0) throw new Error("snapshot : métrique invalide");
  }

  return s;
}

export function validateInsight(i) {
  text(i?.text, "insight : texte", 300);

  if (i.kind !== "descriptive") throw new Error("insight : descriptif seulement");
  if (i.causal !== false) throw new Error("insight : aucune causalité affirmée");
  if (!Number.isInteger(i.sample_size) || i.sample_size < 1) throw new Error("insight : sample_size requis");
  if (!DATE.test(i.period?.from ?? "") || !DATE.test(i.period?.to ?? "") || i.period.from > i.period.to) throw new Error("insight : période invalide");

  refs(i.evidence_refs, "insight");

  return i;
}

export function validateRecommendation(r) {
  text(r?.text, "recommandation : texte", 300);

  if (r.status !== "suggestion") throw new Error("recommandation : statut suggestion seulement");
  if (!CONFIDENCE_LEVELS.includes(r.confidence)) throw new Error("recommandation : confiance invalide");
  if (!Number.isInteger(r.sample_size) || r.sample_size < MIN_SAMPLE_SIZE) throw new Error(`recommandation : sample_size ≥ ${MIN_SAMPLE_SIZE} requis`);

  refs(r.evidence_refs, "recommandation");
  refs(r.insight_ids, "recommandation (insights)");

  return r;
}

export function validateNextIdea(idea) {
  text(idea?.title, "idée : titre", 120);
  text(idea.rationale, "idée : justification", 300);
  refs(idea.recommendation_ids, "idée");

  if (!["candidate", "selected", "dismissed"].includes(idea.status)) throw new Error("idée : statut invalide");
  if (idea.status === "selected" && idea.selected_by !== "human") throw new Error("idée : sélection humaine requise");
  if (idea.triggers_production !== false) throw new Error("idée : ne déclenche jamais une production");

  return idea;
}

export function selectNextIdea(idea, { selected_by }) {
  if (selected_by !== "human") throw new Error("idée : sélection humaine requise");

  return validateNextIdea({ ...idea, status: "selected", selected_by: "human", triggers_production: false });
}
