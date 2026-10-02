// Smoke du Planner : pur, sans effet, recommandations seulement.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-planner-smoke.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planNext, stageStatesFromProduction, PIPELINE_ENGINE_ORDER } from "../src/youtube-agent/planner.js";
import { check, done } from "./youtube-agent-test-helpers.js";

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

const completed = n => Object.fromEntries(PIPELINE_ENGINE_ORDER.slice(0, n).map(id => [id, "completed"]));

check("aucune étape terminée → research (run), approbation requise, non exécutable", () => {
  const p = planNext({ stageStates: deepFreeze({}) });
  if (p.next !== "research" || p.action !== "run" || !p.requires_approval || p.executable_now) throw new Error(JSON.stringify(p));
});

check("progression : la première étape non terminée", () => {
  for (let n = 0; n < 7; n += 1) {
    const p = planNext({ stageStates: deepFreeze(completed(n)) });
    if (p.next !== PIPELINE_ENGINE_ORDER[n]) throw new Error(`n=${n} → ${p.next}`);
  }
});

check("étape en cours → attendre", () => {
  const p = planNext({ stageStates: deepFreeze({ ...completed(2), visual: "running" }) });
  if (p.next !== null || p.action !== "wait") throw new Error("wait");
});

check("étape échouée → relecture humaine avant reprise, approbation requise", () => {
  const p = planNext({ stageStates: deepFreeze({ ...completed(4), voice: "failed" }) });
  if (p.next !== "voice" || p.action !== "review_failure_then_resume" || !p.requires_approval) throw new Error("failed");
});

check("pipeline terminé → préparation de publication (external_write, approbation)", () => {
  const p = planNext({ stageStates: deepFreeze(completed(7)) });
  if (p.next !== "publishing" || !p.capabilities.includes("external_write") || !p.requires_approval || p.executable_now) throw new Error("publishing");
});

check("pure : mêmes entrées → même sortie, entrées non modifiées", () => {
  const input = deepFreeze({ stageStates: completed(3) });
  if (JSON.stringify(planNext(input)) !== JSON.stringify(planNext(input))) throw new Error("non déterministe");
});

check("statuts inconnus du pipeline traités comme pending (jamais « terminé »)", () => {
  const s = stageStatesFromProduction({ agents: [{ id: "research", status: "completed" }, { id: "script", status: "weird" }, { id: "inconnu", status: "completed" }] });
  if (s.research !== "completed" || s.script !== "pending" || "inconnu" in s) throw new Error(JSON.stringify(s));
  if (planNext({ stageStates: s }).next !== "script") throw new Error("script");
});

check("le module planner n'importe ni fs ni journal ni mémoire", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "youtube-agent", "planner.js"), "utf8");
  if (/node:fs|atomic-json|journal|memory|paths\.js/.test(src.replace(/\/\/.*$/gm, ""))) throw new Error("import interdit");
});

done("youtube-agent-planner-smoke");
