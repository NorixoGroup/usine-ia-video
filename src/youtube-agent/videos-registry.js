// Registre éditorial par chaîne : lien production ↔ vidéo, type, date cible,
// checklist de publication manuelle. Partition « videos ». Aucun appel externe.

import { readJson, writeJsonAtomic, withFileLock } from "./atomic-json.js";
import { partitionFile } from "./paths.js";
import { assertChannelId } from "./channels.js";
import { isValidProductionId } from "../orchestrator/resume.js";
import {
  VIDEOS_SCHEMA,
  VIDEO_TYPES,
  VIDEO_ID_PATTERN,
  MAX_NOTES_LENGTH,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_LABEL,
  MAX_VIDEOS_PER_CHANNEL
} from "./config.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REGISTRY_FILE = "registry.json";

function registryFile(root, channelId) {
  return partitionFile(root, channelId, "videos", REGISTRY_FILE);
}

function emptyRegistry(channelId) {
  return { schema: VIDEOS_SCHEMA, channel_id: channelId, updated_at: null, videos: [] };
}

export function validateVideoEntry(input) {
  if (!input || typeof input !== "object") throw new Error("Entrée invalide");

  if (!isValidProductionId(input.production_id)) throw new Error("production_id invalide");
  if (!VIDEO_TYPES.includes(input.type)) throw new Error("type invalide");

  const video_id = input.video_id === undefined || input.video_id === "" ? null : input.video_id;

  if (video_id !== null && !VIDEO_ID_PATTERN.test(video_id)) throw new Error("video_id invalide");

  const target_date = input.target_date === undefined || input.target_date === "" ? null : input.target_date;

  if (target_date !== null) {
    if (!DATE_PATTERN.test(target_date) || Number.isNaN(Date.parse(`${target_date}T00:00:00Z`))) {
      throw new Error("target_date invalide");
    }
  }

  const notes = input.notes === undefined ? "" : input.notes;

  if (typeof notes !== "string" || notes.length > MAX_NOTES_LENGTH) throw new Error("notes invalides");

  const checklist = input.publication_checklist === undefined ? [] : input.publication_checklist;

  if (!Array.isArray(checklist) || checklist.length > MAX_CHECKLIST_ITEMS) {
    throw new Error("checklist invalide");
  }

  const cleaned = checklist.map(item => {
    if (!item || typeof item.label !== "string" || item.label.length === 0 || item.label.length > MAX_CHECKLIST_LABEL) {
      throw new Error("checklist invalide");
    }

    return { label: item.label, done: item.done === true };
  });

  return {
    production_id: input.production_id,
    type: input.type,
    video_id,
    target_date,
    publication_checklist: cleaned,
    notes
  };
}

export function loadRegistry({ root, channelId }) {
  assertChannelId(channelId);

  const data = readJson(registryFile(root, channelId), null);

  if (data === null) return emptyRegistry(channelId);

  if (data.schema !== VIDEOS_SCHEMA || data.channel_id !== channelId || !Array.isArray(data.videos)) {
    throw new Error("Registre illisible ou d'un autre schéma");
  }

  return data;
}

export function upsertVideo({ root, channelId, entry, now = new Date() }) {
  const valid = validateVideoEntry(entry);
  const file = registryFile(root, channelId);

  return withFileLock(file, () => {
    const registry = loadRegistry({ root, channelId });
    const index = registry.videos.findIndex(v => v.production_id === valid.production_id);

    if (index >= 0) {
      registry.videos[index] = valid;
    } else {
      if (registry.videos.length >= MAX_VIDEOS_PER_CHANNEL) throw new Error("Registre plein");

      registry.videos.push(valid);
    }

    registry.updated_at = now.toISOString();
    writeJsonAtomic(file, registry);

    return valid;
  });
}
