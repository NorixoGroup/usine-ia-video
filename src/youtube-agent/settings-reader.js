// Lecture seule de config/pipeline.json, par liste blanche de champs.
// Rien d'autre n'est exposé ; le fichier n'est jamais modifié.

import fs from "node:fs";
import path from "node:path";

function pick(source, keys) {
  const out = {};

  for (const key of keys) if (source && typeof source[key] !== "object" && source[key] !== undefined) out[key] = source[key];

  return out;
}

export function readPipelineSettings(root) {
  let config;

  try {
    config = JSON.parse(fs.readFileSync(path.resolve(root, "config", "pipeline.json"), "utf8"));
  } catch {
    return { available: false };
  }

  return {
    available: true,
    project: pick(config.project, ["name", "language", "platform", "content_type"]),
    target_duration_minutes: config.video?.target_duration_minutes ?? null,
    voice: pick(config.providers?.voice, ["kind", "model_id", "output_format", "voice_id"]),
    reasoning_provider: typeof config.providers?.reasoning === "string" ? config.providers.reasoning : null
  };
}
