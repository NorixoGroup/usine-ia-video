// Lecture seule des productions du pipeline. Ne parcourt jamais récursivement
// projects/ : un readdir de premier niveau, puis un seul production.json par
// production retenue (les plus récentes, selon l'horodatage de l'identifiant).

import fs from "node:fs";
import path from "node:path";

import { isValidProductionId, AGENT_ORDER, LOCK_FILE, productionMode } from "../orchestrator/resume.js";
import { MAX_PRODUCTIONS_LISTED, MAX_PRODUCTIONS_HARD_LIMIT } from "./config.js";

const MAX_PRODUCTION_JSON_BYTES = 1024 * 1024;

function summarize(production, id, locked) {
  const agents = Array.isArray(production.agents) ? production.agents : [];

  return {
    id,
    readable: true,
    status: String(production.status ?? "unknown"),
    mode: productionMode(production),
    created_at: typeof production.created_at === "string" ? production.created_at : null,
    title: String(production.input?.title ?? "").slice(0, 200),
    locked,
    agents: AGENT_ORDER.map(agentId => {
      const entry = agents.find(a => a && a.id === agentId);

      return { id: agentId, status: entry ? String(entry.status ?? "unknown") : "absent" };
    })
  };
}

export function listProductions({ root, limit = MAX_PRODUCTIONS_LISTED } = {}) {
  const projectsDir = path.resolve(root, "projects");
  const cap = Math.max(1, Math.min(Number(limit) || MAX_PRODUCTIONS_LISTED, MAX_PRODUCTIONS_HARD_LIMIT));

  let names;

  try {
    names = fs.readdirSync(projectsDir);
  } catch (error) {
    if (error.code === "ENOENT") return { total: 0, shown: [] };
    throw error;
  }

  const ids = names.filter(isValidProductionId).sort().reverse();
  const shown = [];

  for (const id of ids.slice(0, cap)) {
    const dir = path.join(projectsDir, id);
    const file = path.join(dir, "production.json");

    try {
      const dirStat = fs.lstatSync(dir);
      const fileStat = fs.lstatSync(file);

      if (!dirStat.isDirectory() || !fileStat.isFile() || fileStat.size > MAX_PRODUCTION_JSON_BYTES) {
        throw new Error("non lisible");
      }

      const production = JSON.parse(fs.readFileSync(file, "utf8"));
      const locked = fs.existsSync(path.join(dir, LOCK_FILE));

      shown.push(summarize(production, id, locked));
    } catch {
      shown.push({ id, readable: false, status: "unreadable", mode: "unknown", agents: [] });
    }
  }

  return { total: ids.length, shown };
}

export function getProduction({ root, productionId }) {
  if (!isValidProductionId(productionId)) return null;

  const { shown } = listProductions({ root, limit: MAX_PRODUCTIONS_HARD_LIMIT });

  return shown.find(p => p.id === productionId) ?? null;
}
