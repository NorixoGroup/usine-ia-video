// Table déclarative des transitions d'un épisode. Données seulement.
// approval : { engine, capability } quand la transition engage une action
// externe (production payante, publication) : approbation humaine requise.

export const EPISODE_STATES = Object.freeze([
  "idea", "in_production", "paused", "failed", "quality_passed",
  "ready_to_publish", "published", "tracking", "archived"
]);

export const INITIAL_EPISODE_STATE = "idea";

const paid = Object.freeze({ engine: "production", capability: "external_paid" });
const publish = Object.freeze({ engine: "publishing", capability: "external_write" });

const t = (from, to, approval = null) => Object.freeze({ from, to, approval });

export const EPISODE_TRANSITIONS = Object.freeze([
  t("idea", "in_production", paid),
  t("idea", "archived"),
  t("in_production", "paused"),
  t("in_production", "failed"),
  t("in_production", "quality_passed"),
  t("paused", "in_production", paid),
  t("paused", "archived"),
  t("failed", "in_production", paid),
  t("failed", "archived"),
  t("quality_passed", "ready_to_publish"),
  t("quality_passed", "in_production", paid),
  t("ready_to_publish", "published", publish),
  t("ready_to_publish", "in_production", paid),
  t("published", "tracking"),
  t("tracking", "archived")
]);

export function findTransition(from, to) {
  return EPISODE_TRANSITIONS.find(rule => rule.from === from && rule.to === to) ?? null;
}
