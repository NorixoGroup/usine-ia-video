// Journal en ajout seul, par chaîne. Schéma fermé : aucun champ libre hors
// `detail` (court), et toute valeur ressemblant à un secret est refusée.

import { appendJsonl, readJsonl } from "./atomic-json.js";
import { partitionFile } from "./paths.js";

const ALLOWED_KEYS = ["type", "engine", "action", "subject_id", "outcome", "detail", "approval_hash"];
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_DETAIL = 500;
const SECRET_LIKE = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /ya29\.[0-9A-Za-z_-]{10,}/,
  /Bearer\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*KEY-----/
];

export function validateJournalEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Entrée de journal invalide");

  for (const key of Object.keys(entry)) {
    if (!ALLOWED_KEYS.includes(key)) throw new Error(`Champ de journal refusé : ${key}`);
  }

  if (!TYPE_PATTERN.test(entry.type ?? "")) throw new Error("type de journal invalide");

  for (const key of ["engine", "action", "subject_id", "outcome", "detail", "approval_hash"]) {
    const value = entry[key];

    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > (key === "detail" ? MAX_DETAIL : 200)) {
      throw new Error(`Champ de journal invalide : ${key}`);
    }
    if (SECRET_LIKE.some(pattern => pattern.test(value))) throw new Error("Valeur de journal refusée (ressemble à un secret)");
  }

  return entry;
}

export function appendJournal({ root, channelId, entry, now = new Date() }) {
  validateJournalEntry(entry);

  const record = { ts: now.toISOString(), ...entry };

  appendJsonl(partitionFile(root, channelId, "journal", "journal.jsonl"), record);

  return record;
}

export function readJournal({ root, channelId, maxLines = 100 }) {
  return readJsonl(partitionFile(root, channelId, "journal", "journal.jsonl"), { maxLines: Math.min(maxLines, 1000) });
}
