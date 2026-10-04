// Miroir local persistant de la chaîne YouTube (R20.5, lot 2).
//
// Partition `youtube` de l'unique chaîne :
// - channel.json : identité et statistiques de la chaîne (dernière synchronisation réussie) ;
// - videos.json  : toutes les vidéos connues, y compris les vidéos supprimées
//                  (pierres tombales : jamais de suppression physique) ;
// - stats.jsonl  : historique des statistiques, une ligne par synchronisation (ajout seul) ;
// - sync.json    : état de la dernière tentative (réussite ou erreur codée).
//
// Aucun appel réseau ici : ce module lit et écrit des fichiers par les outils
// d'écriture atomique et de verrou existants. Le pont et l'agent lisent le miroir ;
// seule la synchronisation à la demande (channel.js) l'alimente.

import crypto from "node:crypto";

import { DEFAULT_CHANNEL_ID } from "../../config.js";
import { readJson, writeJsonAtomic, withFileLock, appendJsonl, readJsonl, acquireLease } from "../../atomic-json.js";
import { partitionFile } from "../../paths.js";

export const MIRROR_SCHEMA = "youtube-agent.mirror.v1";
export const STATS_SCHEMA = "youtube-agent.stats.v1";
// Contrat du pont inchangé : les 50 vidéos les plus récentes, plus des totaux.
export const BRIDGE_VIDEO_LIMIT = 50;
// Une synchronisation interrompue (processus arrêté) libère son bail après ce délai.
export const SYNC_LEASE_STALE_MS = 15 * 60 * 1000;
export const CHECKPOINT_SCHEMA_VERSION = 1;

const FILES = Object.freeze({ channel: "channel.json", videos: "videos.json", stats: "stats.jsonl", sync: "sync.json", lease: "sync.lease" });
// Champs suivis pour détecter un changement de contenu (les statistiques sont exclues).
const TRACKED = ["title", "description", "thumbnail_url", "privacy_status", "publish_at", "duration", "category_id", "default_language", "tags", "made_for_kids", "live_broadcast_content", "upload_status"];
// Champs exposés par le pont pour chaque vidéo : exactement ceux du contrat R20.2.
const BRIDGE_VIDEO_FIELDS = ["video_id", "title", "description", "published_at", "thumbnail_url", "privacy_status"];

const file = (root, name) => partitionFile(root, DEFAULT_CHANNEL_ID, "youtube", FILES[name]);

export function fingerprint(video) {
  return crypto.createHash("sha256").update(JSON.stringify(TRACKED.map(key => video[key] ?? null))).digest("hex");
}

// --- Lecture --------------------------------------------------------------------------

export function readMirror(root) {
  return {
    channel: readJson(file(root, "channel"), null),
    videos: readJson(file(root, "videos"), null),
    sync: readJson(file(root, "sync"), null)
  };
}

export function readStatsHistory(root, { maxLines = 1000 } = {}) {
  return readJsonl(file(root, "stats"), { maxLines });
}

// Métadonnées locales de synchronisation destinées à la seule interface de
// l'agent. Elles ne font pas partie du contrat Bridge/Dashboard public.
export function syncState(root) {
  const sync = readJson(file(root, "sync"), null);

  if (!sync) return { status: "not_loaded" };

  return {
    status: sync.last_success_at ? "ok" : "error",
    last_sync_at: sync.last_success_at ?? null,
    last_summary: sync.last_summary ?? null,
    last_full_sync: sync.checkpoint?.lastFullSync ?? null,
    ...(sync.last_error ? { last_error: { reason: sync.last_error.reason, at: sync.last_error.at } } : {})
  };
}

const lastError = sync => (sync?.last_error ? { reason: sync.last_error.reason, at: sync.last_error.at } : null);

// La dernière tentative a échoué (une réussite remet last_error à null) : l'erreur
// est exposée à côté des données conservées.
const pendingError = sync => lastError(sync);

// État de la chaîne pour la façade et le pont (contrat R20.1 conservé).
export function channelState(root) {
  const { channel, sync } = readMirror(root);

  if (!channel) {
    const error = lastError(sync);

    return error ? { status: "error", fetched_at: error.at, reason: error.reason } : { status: "not_loaded" };
  }

  const error = pendingError(sync);

  return { status: "ok", fetched_at: channel.synced_at, channel: channel.channel, synced_at: channel.synced_at, ...(error ? { last_error: error } : {}) };
}

const byRecency = (a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")) || a.video_id.localeCompare(b.video_id);

// État des vidéos pour la façade et le pont (contrat R20.2 conservé, totaux en plus).
export function videosState(root, { limit = BRIDGE_VIDEO_LIMIT } = {}) {
  const { videos, sync } = readMirror(root);

  if (!videos) {
    const error = lastError(sync);

    return error ? { status: "error", fetched_at: error.at, reason: error.reason } : { status: "not_loaded" };
  }

  const present = videos.videos.filter(video => video.mirror_status === "present").sort(byRecency);
  const error = pendingError(sync);

  return {
    status: "ok",
    fetched_at: videos.synced_at,
    items: present.slice(0, limit).map(video => Object.fromEntries(BRIDGE_VIDEO_FIELDS.map(key => [key, video[key] ?? null]))),
    has_more: present.length > limit,
    total: present.length,
    removed: videos.videos.length - present.length,
    synced_at: videos.synced_at,
    ...(error ? { last_error: error } : {})
  };
}

// --- Fusion (pure) --------------------------------------------------------------------

// previous : vidéos du miroir (ou []), details : Map video_id → vidéo lue sur YouTube.
// Une vidéo absente de details devient une pierre tombale ; une pierre tombale qui
// réapparaît est restaurée. Rien n'est jamais retiré du miroir.
export function mergeVideos({ previous = [], details, now }) {
  const at = now.toISOString();
  const known = new Map(previous.map(video => [video.video_id, video]));
  const changes = { added: 0, updated: 0, unchanged: 0, removed: 0, restored: 0 };
  const result = [];

  for (const [id, fresh] of details) {
    const old = known.get(id);
    const print = fingerprint(fresh);

    if (!old) changes.added += 1;
    else if (old.mirror_status === "removed") changes.restored += 1;
    else if (old.fingerprint !== print) changes.updated += 1;
    else changes.unchanged += 1;

    result.push({
      ...fresh,
      mirror_status: "present",
      first_seen_at: old?.first_seen_at ?? at,
      last_seen_at: at,
      removed_at: null,
      fingerprint: print
    });
  }

  for (const [id, old] of known) {
    if (details.has(id)) continue;

    if (old.mirror_status === "present") changes.removed += 1;

    result.push(old.mirror_status === "removed" ? old : { ...old, mirror_status: "removed", removed_at: at });
  }

  return { videos: result.sort(byRecency), changes };
}

// Une synchronisation incrémentale ne conclut jamais à une suppression : les
// vidéos qui n'ont pas été relues sont conservées exactement telles quelles.
export function mergeIncrementalVideos({ previous = [], details, now }) {
  const at = now.toISOString();
  const known = new Map(previous.map(video => [video.video_id, video]));
  const changes = { added: 0, updated: 0, unchanged: 0, removed: 0, restored: 0 };

  for (const [id, fresh] of details) {
    const old = known.get(id);
    const print = fingerprint(fresh);

    if (!old) changes.added += 1;
    else if (old.mirror_status === "removed") changes.restored += 1;
    else if (old.fingerprint !== print) changes.updated += 1;
    else changes.unchanged += 1;

    known.set(id, {
      ...fresh,
      mirror_status: "present",
      first_seen_at: old?.first_seen_at ?? at,
      last_seen_at: at,
      removed_at: null,
      fingerprint: print
    });
  }

  return { videos: [...known.values()].sort(byRecency), changes };
}

// Le hash canonique permet de refuser un checkpoint détaché du miroir qu'il
// prétend décrire. Il n'est jamais exposé au Bridge.
export function mirrorHash(videos = []) {
  const stable = [...videos]
    .map(video => ({ video_id: video.video_id, mirror_status: video.mirror_status, fingerprint: video.fingerprint ?? null, removed_at: video.removed_at ?? null }))
    .sort((a, b) => a.video_id.localeCompare(b.video_id));

  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

// --- Écriture -------------------------------------------------------------------------

const atomic = (path, data) => withFileLock(path, () => writeJsonAtomic(path, data));

// Écrit une synchronisation réussie : vidéos, chaîne, historique, puis état.
export function writeMirror(root, { channel, videos, syncId, syncedAt, summary, checkpoint = null, statsVideos = null }) {
  atomic(file(root, "videos"), { schema: MIRROR_SCHEMA, sync_id: syncId, synced_at: syncedAt, videos });
  atomic(file(root, "channel"), { schema: MIRROR_SCHEMA, sync_id: syncId, synced_at: syncedAt, channel });

  appendJsonl(file(root, "stats"), {
    schema: STATS_SCHEMA,
    sync_id: syncId,
    synced_at: syncedAt,
    channel: { subscriber_count: channel.subscriber_count, view_count: channel.view_count, video_count: channel.video_count },
    videos: (statsVideos ?? videos.filter(video => video.mirror_status === "present")).map(video => [video.video_id, video.view_count, video.like_count, video.comment_count])
  });

  const previous = readJson(file(root, "sync"), null);

  atomic(file(root, "sync"), {
    schema: MIRROR_SCHEMA,
    last_attempt_at: syncedAt,
    last_success_at: syncedAt,
    last_error: null,
    last_summary: summary,
    sync_count: (previous?.sync_count ?? 0) + 1,
    ...(checkpoint ? { checkpoint } : {})
  });
}

// Enregistre un échec : le miroir précédent reste intact.
export function writeSyncFailure(root, { at, reason }) {
  const previous = readJson(file(root, "sync"), null);

  atomic(file(root, "sync"), {
    schema: MIRROR_SCHEMA,
    last_attempt_at: at,
    last_success_at: previous?.last_success_at ?? null,
    last_error: { reason, at },
    last_summary: previous?.last_summary ?? null,
    sync_count: previous?.sync_count ?? 0,
    ...(previous?.checkpoint ? { checkpoint: previous.checkpoint } : {})
  });
}

// Bail inter-processus : une seule synchronisation à la fois (agent ou commande).
export function acquireSyncLease(root) {
  return acquireLease(file(root, "lease"), SYNC_LEASE_STALE_MS);
}
