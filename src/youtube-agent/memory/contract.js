// Contrat de la mémoire : écriture réservée au propriétaire de la partition,
// lecture uniquement par sélection filtrée et plafonnée. Il n'existe volontairement
// aucune fonction « tout lire » : un moteur reçoit des extraits, jamais un fichier.

import crypto from "node:crypto";

import { appendJsonl, readJsonl } from "../atomic-json.js";
import { partitionFile } from "../paths.js";
import { assertChannelId } from "../channels.js";
import {
  PARTITIONS,
  MEMORY_RECORD_MAX_BYTES,
  SELECT_MAX_ENTRIES,
  SELECT_MAX_BYTES,
  SELECT_SCAN_LINES
} from "./partitions.js";

const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,39}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,31}$/;

function jsonlPartition(partition) {
  const spec = PARTITIONS[partition];

  if (!spec) throw new Error("Partition inconnue");
  if (spec.format !== "jsonl") throw new Error("Partition non historique : accès par son module dédié");

  return spec;
}

export function appendMemory({ root, channelId, partition, engine, record, now = new Date() }) {
  assertChannelId(channelId);

  const spec = jsonlPartition(partition);

  if (!spec.owners.includes(engine)) throw new Error(`Écriture refusée : ${engine} n'est pas propriétaire de ${partition}`);
  if (!record || typeof record !== "object" || !TYPE_PATTERN.test(record.type ?? "")) throw new Error("Enregistrement invalide : type");

  const tags = record.tags ?? [];

  if (!Array.isArray(tags) || tags.length > 10 || tags.some(t => !TAG_PATTERN.test(t))) throw new Error("Enregistrement invalide : tags");
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) throw new Error("Enregistrement invalide : data");

  const stored = { id: crypto.randomUUID(), ts: now.toISOString(), type: record.type, tags, data: record.data };

  if (Buffer.byteLength(JSON.stringify(stored)) > MEMORY_RECORD_MAX_BYTES) throw new Error("Enregistrement trop volumineux");

  appendJsonl(partitionFile(root, channelId, partition, `${partition}.jsonl`), stored);

  return stored;
}

function validateBudget(budget) {
  const { max_entries, max_bytes } = budget ?? {};

  if (!Number.isInteger(max_entries) || max_entries < 1 || max_entries > SELECT_MAX_ENTRIES) throw new Error(`budget.max_entries requis (1..${SELECT_MAX_ENTRIES})`);
  if (!Number.isInteger(max_bytes) || max_bytes < 256 || max_bytes > SELECT_MAX_BYTES) throw new Error(`budget.max_bytes requis (256..${SELECT_MAX_BYTES})`);

  return { max_entries, max_bytes };
}

function project(spec, entry) {
  if (!spec.untrusted) return entry;

  const data = {};

  for (const key of spec.selectable_fields) if (entry.data?.[key] !== undefined) data[key] = entry.data[key];

  return { id: entry.id, ts: entry.ts, type: entry.type, tags: entry.tags, data };
}

// Sélection déterministe : filtre type/étiquettes, plus récent d'abord (ts puis id),
// plafonnée en nombre d'entrées et en octets, avec provenance.
export function selectContext({ root, channelId, partition, engine, purpose, budget, filter = {} }) {
  assertChannelId(channelId);

  const spec = jsonlPartition(partition);
  const { max_entries, max_bytes } = validateBudget(budget);

  if (typeof engine !== "string" || !engine) throw new Error("engine requis");
  if (typeof purpose !== "string" || purpose.length === 0 || purpose.length > 80) throw new Error("purpose requis (≤ 80 caractères)");

  const types = filter.types ? new Set(filter.types) : null;
  const tags = filter.tags ?? [];

  const matched = readJsonl(partitionFile(root, channelId, partition, `${partition}.jsonl`), { maxLines: SELECT_SCAN_LINES })
    .filter(entry => (!types || types.has(entry.type)) && tags.every(tag => entry.tags?.includes(tag)))
    .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : -1) : a.ts < b.ts ? 1 : -1));

  const entries = [];
  let bytes = 0;

  for (const entry of matched) {
    if (entries.length >= max_entries) break;

    const shaped = project(spec, entry);
    const size = Buffer.byteLength(JSON.stringify(shaped));

    if (bytes + size > max_bytes) break;

    entries.push(shaped);
    bytes += size;
  }

  return {
    entries,
    provenance: { channel_id: channelId, partition, engine, purpose, matched: matched.length, returned: entries.length, bytes, truncated: entries.length < matched.length }
  };
}

const REVIEW_READERS = ["agent", "comments"];
const REVIEW_EXCERPT_MAX = 200;
const REVIEW_PROPOSAL_MAX = 2000;

// Lecture réservée à la revue humaine des commentaires : extrait et proposition
// visibles pour affichage (échappé côté UI). `untrusted` rappelle que ce texte ne
// doit jamais être injecté dans un prompt ni exécuté comme instruction.
export function selectForReview({ root, channelId, engine, purpose, budget }) {
  assertChannelId(channelId);

  const spec = PARTITIONS.comments;
  const { max_entries, max_bytes } = validateBudget(budget);

  if (!REVIEW_READERS.includes(engine)) throw new Error("Lecture de revue refusée pour ce lecteur");
  if (typeof purpose !== "string" || purpose.length === 0 || purpose.length > 80) throw new Error("purpose requis (≤ 80 caractères)");

  const matched = readJsonl(partitionFile(root, channelId, "comments", "comments.jsonl"), { maxLines: SELECT_SCAN_LINES })
    .filter(entry => spec.review_states.includes(entry.data?.state))
    .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : -1) : a.ts < b.ts ? 1 : -1));

  const entries = [];
  let bytes = 0;

  for (const entry of matched) {
    if (entries.length >= max_entries) break;

    const data = {};

    for (const key of spec.review_fields) if (entry.data?.[key] !== undefined) data[key] = entry.data[key];

    if (typeof data.excerpt === "string") data.excerpt = data.excerpt.slice(0, REVIEW_EXCERPT_MAX);
    if (typeof data.proposal_text === "string") data.proposal_text = data.proposal_text.slice(0, REVIEW_PROPOSAL_MAX);

    const shaped = { id: entry.id, ts: entry.ts, type: entry.type, data };
    const size = Buffer.byteLength(JSON.stringify(shaped));

    if (bytes + size > max_bytes) break;

    entries.push(shaped);
    bytes += size;
  }

  return {
    entries,
    untrusted: true,
    provenance: { channel_id: channelId, partition: "comments", engine, purpose, matched: matched.length, returned: entries.length, bytes, truncated: entries.length < matched.length }
  };
}
