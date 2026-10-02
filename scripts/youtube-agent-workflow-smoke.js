// Smoke du Workflow Manager : transitions, approbations, idempotence, aucune exécution.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-workflow-smoke.js

import fs from "node:fs";
import path from "node:path";

import { transitionEpisode, getEpisode, approvalActionFor } from "../src/youtube-agent/workflow/manager.js";
import { EPISODE_STATES, EPISODE_TRANSITIONS, findTransition } from "../src/youtube-agent/workflow/transitions.js";
import { createApproval } from "../src/youtube-agent/approvals.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { tmpRoot, cleanup, check, throwsWith, done, PROD_A, PROD_B } from "./youtube-agent-test-helpers.js";

const root = tmpRoot("workflow");
const ch = "nomade";
const now = new Date("2026-06-01T10:00:00Z");
const go = (to, extra = {}, productionId = PROD_A, channelId = ch) => transitionEpisode({ root, channelId, productionId, to, now, ...extra });
const approve = (from, to, productionId = PROD_A, channelId = ch, over = {}) =>
  createApproval({ action: approvalActionFor({ channelId, productionId, from, to }), now, ...over });

check("table : états connus, aucune transition orpheline", () => {
  for (const r of EPISODE_TRANSITIONS) if (!EPISODE_STATES.includes(r.from) || !EPISODE_STATES.includes(r.to)) throw new Error("état inconnu");
  if (findTransition("idea", "published")) throw new Error("idea→published ne doit pas exister");
});

check("épisode inconnu → idea, rien d'écrit", () => {
  if (getEpisode({ root, channelId: ch, productionId: PROD_A }).state !== "idea") throw new Error("état initial");
});

check("production payante : sans approbation refusé, journalisé", () => {
  const r = go("in_production");
  if (r.ok || r.reason !== "approval_missing") throw new Error(JSON.stringify(r));
  if (getEpisode({ root, channelId: ch, productionId: PROD_A }).state !== "idea") throw new Error("état modifié");
  if (!readJournal({ root, channelId: ch }).some(e => e.type === "workflow_refused" && e.outcome === "approval_missing")) throw new Error("journal");
});

check("approbation d'une autre production / autre transition / expirée / non humaine refusée", () => {
  if (go("in_production", { approval: approve("idea", "in_production", PROD_B) }).reason !== "action_mismatch") throw new Error("autre production");
  if (go("in_production", { approval: approve("failed", "in_production") }).reason !== "action_mismatch") throw new Error("autre transition");
  if (go("in_production", { approval: approve("idea", "in_production", PROD_A, ch, { ttl_ms: 1000 }) , now: new Date(now.getTime() + 5000) }).reason !== "approval_expired") throw new Error("expirée");
  if (go("in_production", { approval: approve("idea", "in_production", PROD_A, ch, { approver: "agent" }) }).reason !== "approver_not_human") throw new Error("non humain");
  if (go("in_production", { approval: approve("idea", "in_production", PROD_A, "autre") }).reason !== "action_mismatch") throw new Error("autre chaîne");
});

check("approbation valide → transition appliquée, idempotente au rejeu", () => {
  const a = approve("idea", "in_production");
  const r = go("in_production", { approval: a });
  if (!r.ok || !r.changed || r.state !== "in_production") throw new Error(JSON.stringify(r));
  const again = go("in_production", { approval: a });
  if (!again.ok || again.changed) throw new Error("rejeu non idempotent");
  if (getEpisode({ root, channelId: ch, productionId: PROD_A }).history.length !== 1) throw new Error("historique dupliqué");
});

check("transition interdite et état inconnu refusés", () => {
  if (go("published").reason !== "transition_not_allowed") throw new Error("in_production→published");
  if (go("nimporte").reason !== "unknown_state") throw new Error("unknown_state");
});

check("transitions sans approbation : qualité puis prêt à publier", () => {
  if (!go("quality_passed").ok || !go("ready_to_publish").ok) throw new Error("transitions simples");
});

check("publication : approbation external_write obligatoire", () => {
  if (go("published").reason !== "approval_missing") throw new Error("sans approbation");
  const r = go("published", { approval: approve("ready_to_publish", "published") });
  if (!r.ok || r.state !== "published") throw new Error(JSON.stringify(r));
  if (!go("tracking").ok || !go("archived").ok) throw new Error("fin de cycle");
});

check("historique persisté avec empreinte d'approbation, journal en ajout seul", () => {
  const ep = getEpisode({ root, channelId: ch, productionId: PROD_A });
  if (ep.history.length !== 6 || !ep.history[0].approval_hash || ep.history[1].approval_hash !== null) throw new Error("historique");
  const j = readJournal({ root, channelId: ch });
  if (j.filter(e => e.type === "workflow_transition").length !== 6) throw new Error("journal");
});

check("isolation entre chaînes et entre épisodes", () => {
  if (getEpisode({ root, channelId: "autre", productionId: PROD_A }).state !== "idea") throw new Error("fuite entre chaînes");
  if (getEpisode({ root, channelId: ch, productionId: PROD_B }).state !== "idea") throw new Error("fuite entre épisodes");
});

check("le Workflow Manager n'exécute rien et ne touche pas projects/", () => {
  if (fs.existsSync(path.join(root, "projects"))) throw new Error("projects/ créé");
  throwsWith(() => getEpisode({ root, channelId: ch, productionId: "../x" }), "production_id");
});

cleanup(root);
done("youtube-agent-workflow-smoke");
