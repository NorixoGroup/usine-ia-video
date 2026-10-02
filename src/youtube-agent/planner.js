// Planner : fonction pure et sans état. Il RECOMMANDE la prochaine étape ;
// il n'écrit rien, ne persiste rien et n'exécute aucun moteur. Les
// transitions et leur légalité relèvent du Workflow Manager.

import { getEngine, engineForPipelineAgent } from "./engines.js";
import { requiresApproval } from "./capabilities.js";

// Ordre d'un épisode : les 7 étapes du pipeline, dans l'ordre de AGENT_ORDER.
export const PIPELINE_ENGINE_ORDER = Object.freeze(
  ["research", "script", "visual", "asset", "voice", "assembly", "quality"]
);

// Les statuts de agents[] du pipeline (« completed », « failed »…) ; tout autre
// statut est traité comme « pending » (prudence : jamais « terminé » par défaut).
const STATES = ["pending", "running", "completed", "failed"];

// Traduit les agents d'une production (lue en lecture seule) en états de moteurs.
export function stageStatesFromProduction(production) {
  const states = {};

  for (const agent of production?.agents ?? []) {
    const engine = engineForPipelineAgent(agent.id);

    if (!engine) continue;

    states[engine.id] = STATES.includes(agent.status) ? agent.status : "pending";
  }

  return states;
}

function describe(engineId, action, reason) {
  const engine = getEngine(engineId);
  const capabilities = engine ? [...engine.capabilities] : [];

  return {
    next: engineId,
    action,
    reason,
    capabilities,
    requires_approval: capabilities.some(requiresApproval),
    executable_now: false
  };
}

export function planNext({ stageStates }) {
  const states = stageStates ?? {};

  for (const engineId of PIPELINE_ENGINE_ORDER) {
    const state = states[engineId] ?? "pending";

    if (state === "completed") continue;

    if (state === "running") {
      return { next: null, action: "wait", reason: `${engineId} en cours`, capabilities: [], requires_approval: false, executable_now: false };
    }

    if (state === "failed") {
      return describe(engineId, "review_failure_then_resume", `${engineId} a échoué : relecture humaine avant reprise`);
    }

    return describe(engineId, "run", `${engineId} est la première étape non terminée`);
  }

  return describe("publishing", "prepare_publication", "pipeline terminé : préparation manuelle de la publication");
}
