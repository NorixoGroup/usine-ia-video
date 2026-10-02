// Smoke du manifeste des moteurs et des partitions — cohérence avec le pipeline réel.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-manifest-smoke.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINES, getEngine, engineForPipelineAgent } from "../src/youtube-agent/engines.js";
import { CAPABILITIES, isCapability, requiresApproval, isExecutableInR182 } from "../src/youtube-agent/capabilities.js";
import { PARTITIONS } from "../src/youtube-agent/memory/partitions.js";
import { PARTITION_NAMES } from "../src/youtube-agent/paths.js";
import { PIPELINE_ENGINE_ORDER } from "../src/youtube-agent/planner.js";
import { AGENT_ORDER } from "../src/orchestrator/resume.js";
import { check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

check("identifiants uniques, nature valide, manifeste figé", () => {
  const ids = ENGINES.map(e => e.id);
  if (new Set(ids).size !== ids.length) throw new Error("doublon");
  if (ENGINES.some(e => !["existing", "planned", "undecided"].includes(e.kind))) throw new Error("kind");
  if (!Object.isFrozen(ENGINES) || ENGINES.some(e => !Object.isFrozen(e) || !Object.isFrozen(e.capabilities))) throw new Error("non figé");
  if (ids.length !== 16) throw new Error(`16 moteurs attendus, ${ids.length}`);
});

check("toutes les capacités déclarées existent ; les classes externes exigent une approbation", () => {
  for (const e of ENGINES) for (const c of e.capabilities) if (!isCapability(c)) throw new Error(`${e.id}: ${c}`);
  for (const c of ["external_read", "external_paid", "external_write"]) if (!requiresApproval(c)) throw new Error(c);
  throwsWith(() => requiresApproval("nope"), "inconnue");
  if (!Object.isFrozen(CAPABILITIES)) throw new Error("CAPABILITIES");
});

check("rien n'est exécutable en R18.2 (aucun moteur n'est local_read seul)", () => {
  for (const e of ENGINES) if (isExecutableInR182(e.capabilities)) throw new Error(`${e.id} exécutable`);
  if (!isExecutableInR182(["local_read"])) throw new Error("local_read devrait l'être");
});

check("chaque agent du pipeline (AGENT_ORDER) ↔ exactement un moteur existant, dans l'ordre", () => {
  const mapped = AGENT_ORDER.map(a => engineForPipelineAgent(a)?.id);
  if (mapped.some(x => !x)) throw new Error("agent sans moteur");
  if (mapped.join() !== PIPELINE_ENGINE_ORDER.join()) throw new Error("ordre divergent");
  for (const a of AGENT_ORDER) if (ENGINES.filter(e => e.pipeline_agent === a).length !== 1) throw new Error(`${a} non unique`);
  for (const e of ENGINES.filter(x => x.pipeline_agent)) if (e.kind !== "existing") throw new Error(`${e.id} kind`);
});

check("config/agents.json (lecture seule) : chaque agent déclaré a son moteur", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "agents.json"), "utf8"));
  for (const a of cfg.agents) if (!engineForPipelineAgent(a.id)) throw new Error(`agent ${a.id} sans moteur`);
});

check("Storytelling : non décidé, sans capacité ; Publishing : external_write", () => {
  const s = getEngine("storytelling");
  if (s.kind !== "undecided" || s.capabilities.length !== 0) throw new Error("storytelling");
  if (!getEngine("publishing").capabilities.includes("external_write")) throw new Error("publishing");
  if (!getEngine("comments").capabilities.includes("external_write")) throw new Error("comments");
});

check("partitions : mêmes clés que les chemins, un propriétaire déclaré, commentaires non fiables", () => {
  if (Object.keys(PARTITIONS).sort().join() !== [...PARTITION_NAMES].sort().join()) throw new Error("clés divergentes");
  for (const [name, spec] of Object.entries(PARTITIONS)) if (!spec.owners.length) throw new Error(`${name} sans propriétaire`);
  if (!PARTITIONS.comments.untrusted || !PARTITIONS.comments.selectable_fields.length) throw new Error("comments");
  for (const e of ENGINES) for (const owned of e.owns) if (!PARTITIONS[owned]?.owners.includes(e.id)) throw new Error(`${e.id} ne possède pas ${owned}`);
});

done("youtube-agent-manifest-smoke");
