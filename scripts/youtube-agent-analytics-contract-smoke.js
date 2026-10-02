// Smoke du contrat Analytics : Insights, Recommendations, Next Ideas.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-analytics-contract-smoke.js

import {
  ANALYTICS_STAGES, MIN_SAMPLE_SIZE, validateSnapshot, validateInsight,
  validateRecommendation, validateNextIdea, selectNextIdea
} from "../src/youtube-agent/analytics/stages.js";
import { check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const insight = { text: "Les vidéos longues ont une rétention moyenne plus basse", kind: "descriptive", causal: false, sample_size: 6, period: { from: "2026-05-01", to: "2026-05-31" }, evidence_refs: ["snap-1"] };
const reco = { text: "Tester un hook plus court", status: "suggestion", confidence: "low", sample_size: MIN_SAMPLE_SIZE, evidence_refs: ["snap-1"], insight_ids: ["i1"] };
const idea = { title: "Idée candidate", rationale: "Issue de la recommandation r1", recommendation_ids: ["r1"], status: "candidate", triggers_production: false };

check("étapes dans l'ordre attendu", () => {
  if (ANALYTICS_STAGES.join() !== "collect,snapshot,insights,recommendations,next_ideas") throw new Error("étapes");
});

check("snapshot : métriques finies et positives, date valide", () => {
  validateSnapshot({ video_id: "dQw4w9WgXcQ", captured_at: "2026-06-01T00:00:00Z", metrics: { views: 10, ctr: 0.04 } });
  throwsWith(() => validateSnapshot({ video_id: "v", captured_at: "nope", metrics: {} }), "captured_at");
  throwsWith(() => validateSnapshot({ video_id: "v", captured_at: "2026-06-01", metrics: { Views: 1 } }), "métrique");
  throwsWith(() => validateSnapshot({ video_id: "v", captured_at: "2026-06-01", metrics: { views: -1 } }), "métrique");
  throwsWith(() => validateSnapshot({ video_id: "v", captured_at: "2026-06-01", metrics: { views: NaN } }), "métrique");
});

check("insight : descriptif, non causal, effectif, période et preuves obligatoires", () => {
  validateInsight(insight);
  throwsWith(() => validateInsight({ ...insight, causal: true }), "causalité");
  throwsWith(() => validateInsight({ ...insight, kind: "predictive" }), "descriptif");
  throwsWith(() => validateInsight({ ...insight, sample_size: 0 }), "sample_size");
  throwsWith(() => validateInsight({ ...insight, period: { from: "2026-06-01", to: "2026-05-01" } }), "période");
  throwsWith(() => validateInsight({ ...insight, evidence_refs: [] }), "preuves");
});

check("recommandation : effectif minimal, preuves, confiance, statut suggestion", () => {
  validateRecommendation(reco);
  throwsWith(() => validateRecommendation({ ...reco, sample_size: MIN_SAMPLE_SIZE - 1 }), "sample_size");
  throwsWith(() => validateRecommendation({ ...reco, evidence_refs: [] }), "preuves");
  throwsWith(() => validateRecommendation({ ...reco, insight_ids: [] }), "preuves");
  throwsWith(() => validateRecommendation({ ...reco, confidence: "certain" }), "confiance");
  throwsWith(() => validateRecommendation({ ...reco, status: "applied" }), "suggestion");
});

check("idée : candidate par défaut, ne déclenche jamais de production, sélection humaine seulement", () => {
  validateNextIdea(idea);
  throwsWith(() => validateNextIdea({ ...idea, triggers_production: true }), "production");
  throwsWith(() => validateNextIdea({ ...idea, status: "selected" }), "humaine");
  throwsWith(() => validateNextIdea({ ...idea, recommendation_ids: [] }), "preuves");
  throwsWith(() => selectNextIdea(idea, { selected_by: "agent" }), "humaine");
  const s = selectNextIdea(idea, { selected_by: "human" });
  if (s.status !== "selected" || s.triggers_production !== false) throw new Error("sélection");
});

done("youtube-agent-analytics-contract-smoke");
