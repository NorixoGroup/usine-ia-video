// Chemins de données par chaîne et par partition. Aucune traversée possible :
// chaque segment est validé, puis le chemin résolu est re-vérifié.

import path from "node:path";

import { DATA_DIR } from "./config.js";
import { assertChannelId } from "./channels.js";

export const PARTITION_NAMES = Object.freeze([
  "channel",
  "knowledge",
  "videos",
  "analytics",
  "learning",
  "comments",
  "prompts",
  "journal"
]);

const FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function dataRoot(root) {
  return path.resolve(root, DATA_DIR);
}

export function channelDir(root, channelId) {
  assertChannelId(channelId);

  const base = path.join(dataRoot(root), "channels");
  const dir = path.resolve(base, channelId);

  if (path.dirname(dir) !== base) throw new Error("Chemin de chaîne refusé");

  return dir;
}

export function partitionDir(root, channelId, partition) {
  if (!PARTITION_NAMES.includes(partition)) {
    throw new Error("Partition inconnue");
  }

  return path.join(channelDir(root, channelId), partition);
}

export function partitionFile(root, channelId, partition, filename) {
  if (typeof filename !== "string" || !FILE_PATTERN.test(filename) || filename.includes("..")) {
    throw new Error("Nom de fichier refusé");
  }

  const dir = partitionDir(root, channelId, partition);
  const file = path.resolve(dir, filename);

  if (path.dirname(file) !== dir) throw new Error("Chemin de fichier refusé");

  return file;
}
