// Smoke de la façade YouTube Agent : orchestration seulement.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-agent-smoke.js

import fs from "node:fs";
import path from "node:path";

import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { approvalActionFor } from "../src/youtube-agent/workflow/manager.js";
import { createApproval } from "../src/youtube-agent/approvals.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { tmpRoot, cleanup, check, throwsWith, done, makeProduction, PROD_A } from "./youtube-agent-test-helpers.js";

const root = tmpRoot("agent");
const now = new Date("2026-06-01T10:00:00Z");
makeProduction(root, PROD_A, { agents: [{ id: "research", status: "completed" }, { id: "script", status: "failed" }] });
const agent = createYouTubeAgent({ root, now: () => now });

check("describe : 16 moteurs, 11 partitions, états des quatre machines", () => {
  const d = agent.describe();
  if (d.engines.length !== 16 || Object.keys(d.partitions).length !== 11) throw new Error("describe");
  if (!d.episode_states.includes("ready_to_publish") || !d.comment_states.includes("quarantined")) throw new Error("états");
});

check("status : productions + registre + états d'épisode", () => {
  const s = agent.status({ channelId: "nomade" });
  if (s.productions.total !== 1 || s.episodes[PROD_A] !== "idea" || s.registry.channel_id !== "nomade") throw new Error("status");
});

check("plan : recommandation sans effet (script échoué → relecture avant reprise)", () => {
  const p = agent.plan({ channelId: "nomade", productionId: PROD_A });
  if (!p.ok || p.plan.next !== "script" || p.plan.action !== "review_failure_then_resume" || !p.plan.requires_approval || p.plan.executable_now) throw new Error(JSON.stringify(p));
  if (agent.plan({ channelId: "nomade", productionId: "prod-2026-01-09T10-00-00-000Z-ffffff" }).reason !== "production_not_found") throw new Error("introuvable");
  if (fs.existsSync(path.join(root, "data"))) throw new Error("plan a écrit sur disque");
});

check("advance : délègue au Workflow Manager (approbation requise)", () => {
  if (agent.advance({ channelId: "nomade", productionId: PROD_A, to: "in_production" }).ok) throw new Error("accepté sans approbation");
  const approval = createApproval({ action: approvalActionFor({ channelId: "nomade", productionId: PROD_A, from: "idea", to: "in_production" }), now });
  if (!agent.advance({ channelId: "nomade", productionId: PROD_A, to: "in_production", approval }).ok) throw new Error("refusé");
  if (agent.status({ channelId: "nomade" }).episodes[PROD_A] !== "in_production") throw new Error("état");
});

check("execute : aucun moteur ne s'exécute en R18.2, refus journalisé", () => {
  for (const [id, reason] of [["research", "not_executable_in_r18_2"], ["comments", "engine_not_implemented"], ["storytelling", "engine_not_implemented"], ["nimporte", "unknown_engine"]]) {
    const r = agent.execute({ channelId: "nomade", engineId: id });
    if (r.ok || r.reason !== reason) throw new Error(`${id} → ${JSON.stringify(r)}`);
  }
  if (readJournal({ root, channelId: "nomade" }).filter(e => e.type === "execute_refused").length !== 4) throw new Error("journal");
});

check("aucune écriture dans projects/ ; production.json inchangé", () => {
  const before = fs.readFileSync(path.join(root, "projects", PROD_A, "production.json"), "utf8");
  agent.status({ channelId: "nomade" });
  agent.plan({ channelId: "nomade", productionId: PROD_A });
  if (fs.readFileSync(path.join(root, "projects", PROD_A, "production.json"), "utf8") !== before) throw new Error("production modifiée");
  if (fs.readdirSync(path.join(root, "projects", PROD_A)).join() !== "production.json") throw new Error("fichier ajouté dans la production");
});

check("identifiant interne : traversée de chemin refusée", () => {
  throwsWith(() => agent.status({ channelId: "../x" }), "channel_id");
  throwsWith(() => agent.execute({ channelId: "BAD", engineId: "research" }), "channel_id");
});

cleanup(root);
done("youtube-agent-agent-smoke");
