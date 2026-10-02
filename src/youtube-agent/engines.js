// Manifeste déclaratif des moteurs. Données seulement : aucune logique métier.
//
// kind : existing  = déjà dans le pipeline (inchangé, lu en lecture seule)
//        planned   = contrat prévu, pas d'implémentation
//        undecided = concept sans décision (aucun code correspondant)

const e = (id, label, kind, pipeline_agent, capabilities, owns = []) =>
  Object.freeze({ id, label, kind, pipeline_agent, capabilities: Object.freeze(capabilities), owns: Object.freeze(owns) });

export const ENGINES = Object.freeze([
  e("production", "Production Engine", "existing", null, ["external_paid", "local_write"]),
  e("research", "Research Engine", "existing", "research", ["external_paid"]),
  e("script", "Script Engine", "existing", "script", ["external_paid"]),
  e("storytelling", "Storytelling Engine", "undecided", null, []),
  e("visual", "Visual Engine", "existing", "visual_director", ["external_paid"]),
  e("asset", "Asset Engine", "existing", "asset", ["local_write"]),
  e("voice", "Voice Engine", "existing", "voice", ["external_paid"]),
  e("assembly", "Assembly Engine", "existing", "assembly", ["local_write"]),
  e("quality", "Quality Engine", "existing", "quality", ["local_write"]),
  e("thumbnail", "Thumbnail Engine", "planned", null, ["local_write"]),
  e("seo", "SEO Engine", "planned", null, ["local_write"]),
  e("publishing", "Publishing Engine", "planned", null, ["external_write"]),
  e("comments", "Comments Engine", "planned", null, ["external_read", "local_write", "external_write"], ["comments"]),
  e("analytics", "Analytics Engine", "planned", null, ["external_read", "local_write"], ["analytics"]),
  e("learning", "Learning Engine", "planned", null, ["local_write"], ["learning"]),
  e("memory", "Memory Engine", "planned", null, ["local_write"])
]);

export function getEngine(id) {
  return ENGINES.find(engine => engine.id === id) ?? null;
}

// Moteur correspondant à un agent du pipeline (config/agents.json).
export function engineForPipelineAgent(agentId) {
  return ENGINES.find(engine => engine.pipeline_agent === agentId) ?? null;
}
