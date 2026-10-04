// Analytiques YouTube par vidéo (R20.5, lot 4B), en lecture seule.
//
// Architecture issue du test réel 4B.0 (la combinaison des dimensions jour et vidéo
// dans une même requête est refusée par l'API, HTTP 400) :
// 1. un rapport `dimensions=video` (90 derniers jours) donne la liste des vidéos actives ;
// 2. la liste est complétée par les vidéos présentes dans le miroir local (lecture seule) ;
// 3. pour chaque vidéo, un rapport `dimensions=day` avec `filters=video==ID`.
// Synchronisation uniquement à la demande (`npm run youtube-analytics-videos-sync`) :
// jamais au démarrage, jamais automatique. Échange du jeton et enveloppe HTTP de channel.js.
//
// Stockage : partition `analytics`, fichiers distincts du lot 4A (aucun fichier partagé) :
// - video-daily-AAAA-MM.json : un fichier par mois ; par vidéo, un enregistrement par jour,
//   remplacé à chaque relecture ; l'historique est conservé ;
// - video-state.json : état global et, par vidéo, dernier jour lu et dernière erreur ;
// - video-fetch.jsonl : journal des synchronisations (ajout seul) ;
// - video-index.json : index par vidéo, reconstruit à chaque synchronisation (R20.6) ;
// - video-sync.lease : bail exclusif (une synchronisation à la fois).
// Chaque vidéo est enregistrée dès que son rapport est reçu : un arrêt en cours de
// synchronisation conserve les vidéos déjà traitées. Dates de l'API conservées (Pacifique).

import { DEFAULT_CHANNEL_ID } from "../../config.js";
import { readJson, writeJsonAtomic, withFileLock, appendJsonl, readJsonl, acquireLease } from "../../atomic-json.js";
import { partitionFile } from "../../paths.js";
import { readConnectionMeta } from "./auth/token-store.js";
import { YT_ANALYTICS_READONLY_SCOPE } from "./auth/config.js";
import { readMirror } from "./mirror.js";
import { connectYoutube, callGoogle, googleErrorReason, YoutubeConnectorError } from "./channel.js";
import { ANALYTICS_METRICS, INITIAL_DAYS, analyticsWindow, parseReport } from "./analytics.js";

export const VIDEO_ANALYTICS_SCHEMA = "youtube-agent.video-analytics.v1";
const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

// Une page de liste : 200 lignes (valeur utilisée lors du test réel 4B.0).
export const VIDEO_LIST_MAX_RESULTS = 200;
// Vidéos traitées par synchronisation (budget d'appels de channel.js : 500 au total).
export const MAX_VIDEOS_PER_SYNC = 450;
export const VIDEO_ANALYTICS_LEASE_STALE_MS = 15 * 60 * 1000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// Échecs qui arrêtent la synchronisation ; les autres refus ne concernent qu'une vidéo.
const STOPPING = new Set(["unauthorized", "quota_exceeded", "upstream", "network", "bad_response", "sync_limit"]);

const METRIC_NAMES = ANALYTICS_METRICS.map(([api]) => api).join(",");
const file = (root, name) => partitionFile(root, DEFAULT_CHANNEL_ID, "analytics", name);
const monthFile = (root, month) => file(root, `video-daily-${month}.json`);
const isoDay = date => date.toISOString().slice(0, 10);
const shift = (day, days) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
const atomic = (path, data) => withFileLock(path, () => writeJsonAtomic(path, data));

// --- Rapports -----------------------------------------------------------------------------

function reportUrl(params) {
  const url = new URL(REPORTS_ENDPOINT);

  url.searchParams.set("ids", "channel==MINE");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  return url.toString();
}

async function getReport({ fetchImpl, accessToken, budget, params }) {
  const r = await callGoogle(fetchImpl, reportUrl(params), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, budget);

  if (!r.ok) throw new YoutubeConnectorError(googleErrorReason(r.status, r.json));

  return r.json;
}

// Rapport `dimensions=video` : colonnes « video » puis les 9 métriques.
export function parseVideoList(json) {
  const headers = Array.isArray(json?.columnHeaders) ? json.columnHeaders.map(h => h?.name) : null;
  const expected = ["video", ...ANALYTICS_METRICS.map(([api]) => api)];

  if (!headers || headers.join() !== expected.join()) throw new YoutubeConnectorError("incomplete");

  const rows = json.rows === undefined ? [] : json.rows;

  if (!Array.isArray(rows)) throw new YoutubeConnectorError("incomplete");

  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== expected.length || typeof row[0] !== "string" || !VIDEO_ID.test(row[0])) throw new YoutubeConnectorError("incomplete");

    return row[0];
  });
}

// --- Lecture locale ------------------------------------------------------------------------

export function readVideoAnalyticsState(root) {
  return readJson(file(root, "video-state.json"), null);
}

// Vidéos connues du miroir (lecture seule) : confidentialité et présence.
function mirrorVideos(root) {
  const list = readMirror(root).videos?.videos;
  const map = new Map();

  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v?.video_id === "string" && VIDEO_ID.test(v.video_id)) {
      map.set(v.video_id, { title: typeof v.title === "string" ? v.title : null, privacy_status: v.privacy_status ?? null, published_at: typeof v.published_at === "string" ? v.published_at : null, present: v.mirror_status !== "removed" });
    }
  }

  return map;
}

// Jours enregistrés pour une vidéo, du plus ancien au plus récent (bornes facultatives).
export function readVideoDaily(root, videoId, { from = null, to = null } = {}) {
  const state = readVideoAnalyticsState(root);
  const days = [];

  for (const month of state?.months ?? []) {
    const content = readJson(monthFile(root, month), null);

    for (const [day, record] of Object.entries(content?.videos?.[videoId] ?? {})) {
      if ((!from || day >= from) && (!to || day <= to)) days.push({ day, ...record });
    }
  }

  return days.sort((a, b) => a.day.localeCompare(b.day));
}

export function readVideoFetchLog(root, { maxLines = 100 } = {}) {
  return readJsonl(file(root, "video-fetch.jsonl"), { maxLines });
}

// --- Index par vidéo -------------------------------------------------------------------
//
// video-index.json : reconstruit à la fin de chaque synchronisation (une seule lecture des
// fichiers mensuels). Par vidéo : premier et dernier jour, jours stockés, totaux depuis le
// début et sur les 28 derniers jours lus. Les moyennes sont pondérées par les vues.

export const INDEX_RECENT_DAYS = 28;
const SUMMED = ["views", "watch_time_minutes", "likes", "comments", "shares", "subscribers_gained", "subscribers_lost"];

function totalsOf(records) {
  const totals = Object.fromEntries(SUMMED.map(key => [key, records.reduce((sum, r) => sum + (r[key] ?? 0), 0)]));
  const weighted = key => totals.views > 0 ? records.reduce((sum, r) => sum + (r[key] ?? 0) * (r.views ?? 0), 0) / totals.views : null;

  return { ...totals, average_view_percentage: weighted("average_view_percentage"), average_view_duration_seconds: weighted("average_view_duration_seconds") };
}

export function buildVideoIndex(root, { now = new Date() } = {}) {
  const state = readVideoAnalyticsState(root);
  const byVideo = new Map();

  for (const month of state?.months ?? []) {
    const content = readJson(monthFile(root, month), null);

    for (const [videoId, days] of Object.entries(content?.videos ?? {})) {
      if (!byVideo.has(videoId)) byVideo.set(videoId, []);
      for (const [day, record] of Object.entries(days)) byVideo.get(videoId).push({ day, ...record });
    }
  }

  const videos = {};

  for (const videoId of new Set([...Object.keys(state?.videos ?? {}), ...byVideo.keys()])) {
    const records = (byVideo.get(videoId) ?? []).sort((a, b) => a.day.localeCompare(b.day));
    const dataUntil = state?.videos?.[videoId]?.last_end_date ?? records.at(-1)?.day ?? null;
    const from = dataUntil ? shift(dataUntil, -(INDEX_RECENT_DAYS - 1)) : null;

    videos[videoId] = {
      first_day: records[0]?.day ?? null,
      last_day: records.at(-1)?.day ?? null,
      days_stored: records.length,
      data_until: dataUntil,
      lifetime: totalsOf(records),
      recent: { from, to: dataUntil, days: INDEX_RECENT_DAYS, totals: totalsOf(from ? records.filter(r => r.day >= from && r.day <= dataUntil) : []) },
      last_error: state?.videos?.[videoId]?.last_error ?? null
    };
  }

  return { schema: VIDEO_ANALYTICS_SCHEMA, built_at: now.toISOString(), videos };
}

// Index enregistré ; à défaut (synchronisation antérieure à l'index), calculé en mémoire.
export function readVideoIndex(root) {
  return readJson(file(root, "video-index.json"), null) ?? (readVideoAnalyticsState(root) ? buildVideoIndex(root) : null);
}

// Résumé par vidéo (aucun appel réseau) : depuis l'index, avec titre et confidentialité du miroir.
export function videoAnalyticsSummary(root) {
  const state = readVideoAnalyticsState(root);

  if (!state?.last_success_at) {
    return state?.last_error ? { status: "error", reason: state.last_error.reason, at: state.last_error.at } : { status: "not_loaded" };
  }

  const mirror = mirrorVideos(root);
  const index = readVideoIndex(root);
  const videos = Object.entries(index?.videos ?? {}).map(([videoId, v]) => {
    const m = mirror.get(videoId);

    return {
      video_id: videoId,
      title: m?.title ?? null,
      privacy_status: m?.privacy_status ?? null,
      published_at: m?.published_at ?? null,
      mirror_status: m ? (m.present ? "present" : "removed") : "unknown",
      data_until: v.data_until,
      days_stored: v.days_stored,
      totals: v.recent.totals,
      lifetime: v.lifetime,
      ...(v.last_error ? { last_error: v.last_error } : {})
    };
  });

  return {
    status: "ok",
    synced_at: state.last_success_at,
    videos_tracked: videos.length,
    videos: videos.sort((a, b) => b.totals.views - a.totals.views || a.video_id.localeCompare(b.video_id)),
    ...(state.last_error ? { last_error: state.last_error } : {})
  };
}

// --- Écriture -----------------------------------------------------------------------------

function writeVideoDays({ root, videoId, rows, fetchedAt }) {
  const byMonth = new Map();

  for (const row of rows) {
    const month = row.day.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }

  for (const [month, list] of byMonth) {
    const path = monthFile(root, month);

    withFileLock(path, () => {
      const current = readJson(path, null) ?? { schema: VIDEO_ANALYTICS_SCHEMA, month, videos: {} };
      const days = { ...(current.videos[videoId] ?? {}) };

      for (const row of list) days[row.day] = { ...row.metrics, fetched_at: fetchedAt };

      current.videos[videoId] = Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
      current.videos = Object.fromEntries(Object.entries(current.videos).sort(([a], [b]) => a.localeCompare(b)));
      writeJsonAtomic(path, current);
    });
  }

  return [...byMonth.keys()];
}

function emptyState() {
  return { schema: VIDEO_ANALYTICS_SCHEMA, last_attempt_at: null, last_success_at: null, last_error: null, months: [], videos: {}, last_summary: null, sync_count: 0 };
}

// --- Synchronisation -------------------------------------------------------------------

async function synchronize({ root, env, fetchImpl, now }) {
  const at = now();
  const fetchedAt = at.toISOString();
  const state = readVideoAnalyticsState(root) ?? emptyState();
  const budget = { calls: 0 };
  const meta = readConnectionMeta({ root });

  // Le scope Analytics doit avoir été accordé : sinon, aucun appel.
  if (meta.status === "connected" && !meta.scopes.includes(YT_ANALYTICS_READONLY_SCOPE)) throw new YoutubeConnectorError("scope_missing");

  const accessToken = await connectYoutube({ root, env, fetchImpl, budget });

  // 1. Liste des vidéos actives sur les 90 derniers jours (une page de 200 lignes).
  const listEnd = isoDay(new Date(at.getTime() - DAY_MS));
  const listStart = shift(listEnd, -(INITIAL_DAYS - 1));
  const listed = parseVideoList(await getReport({
    fetchImpl, accessToken, budget,
    params: { startDate: listStart, endDate: listEnd, metrics: METRIC_NAMES, dimensions: "video", sort: "-views", maxResults: String(VIDEO_LIST_MAX_RESULTS) }
  }));

  // 2. Complément par le miroir : vidéos présentes, dans l'ordre du miroir.
  const mirror = mirrorVideos(root);
  const candidates = [...new Set([...listed, ...[...mirror.entries()].filter(([, v]) => v.present).map(([id]) => id)])];
  const selected = candidates.slice(0, MAX_VIDEOS_PER_SYNC);
  const summary = {
    list_start_date: listStart,
    list_end_date: listEnd,
    listed: listed.length,
    list_truncated: listed.length === VIDEO_LIST_MAX_RESULTS,
    from_mirror: candidates.length - listed.length,
    selected: selected.length,
    skipped: candidates.length - selected.length,
    synced: 0,
    failed: 0,
    days_received: 0,
    calls: 0,
    analytics_requests: 0,
    stopped: null
  };
  const months = new Set(state.months);

  // 3. Série quotidienne de chaque vidéo (dimensions=day, filters=video==ID).
  for (const videoId of selected) {
    const previous = state.videos[videoId] ?? null;
    const { startDate, endDate } = analyticsWindow({ now: at, state: previous });

    try {
      const rows = parseReport(await getReport({
        fetchImpl, accessToken, budget,
        params: { startDate, endDate, metrics: METRIC_NAMES, dimensions: "day", filters: `video==${videoId}`, sort: "day" }
      }));

      for (const month of writeVideoDays({ root, videoId, rows, fetchedAt })) months.add(month);

      state.videos[videoId] = { last_end_date: endDate, last_success_at: fetchedAt, last_error: null, days_last_sync: rows.length };
      summary.synced += 1;
      summary.days_received += rows.length;
    } catch (error) {
      const reason = error instanceof YoutubeConnectorError ? error.reason : "internal_error";

      if (STOPPING.has(reason) || reason === "internal_error") {
        summary.stopped = reason;
        break;
      }

      // Refus propre à cette vidéo : noté, les autres vidéos continuent.
      state.videos[videoId] = { ...(previous ?? { last_end_date: null, last_success_at: null, days_last_sync: 0 }), last_error: { reason, at: fetchedAt } };
      summary.failed += 1;
    } finally {
      state.months = [...months].sort();
      atomic(file(root, "video-state.json"), { ...state, last_attempt_at: fetchedAt });
    }
  }

  summary.calls = budget.calls;
  summary.analytics_requests = budget.calls - 1;

  const ok = summary.stopped === null;

  appendJsonl(file(root, "video-fetch.jsonl"), { schema: VIDEO_ANALYTICS_SCHEMA, at: fetchedAt, status: ok ? "ok" : "partial", ...summary });
  atomic(file(root, "video-state.json"), {
    ...state,
    months: [...months].sort(),
    last_attempt_at: fetchedAt,
    last_success_at: ok ? fetchedAt : state.last_success_at,
    last_error: ok ? null : { reason: summary.stopped, at: fetchedAt },
    last_summary: summary,
    sync_count: state.sync_count + (ok ? 1 : 0)
  });
  atomic(file(root, "video-index.json"), buildVideoIndex(root, { now: at }));

  return ok ? { status: "ok", synced_at: fetchedAt, summary } : { status: "error", at: fetchedAt, reason: summary.stopped, summary };
}

function recordFailure(root, { at, reason }) {
  const previous = readVideoAnalyticsState(root) ?? emptyState();

  atomic(file(root, "video-state.json"), { ...previous, last_attempt_at: at, last_error: { reason, at } });
}

// Lecteur et synchronisation à la demande. summary() ne fait jamais d'appel réseau.
export function createYoutubeVideoAnalytics({ root, env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let running = null;

  async function sync() {
    const release = acquireLease(file(root, "video-sync.lease"), VIDEO_ANALYTICS_LEASE_STALE_MS);

    if (!release) return { status: "error", at: now().toISOString(), reason: "sync_in_progress" };

    try {
      return await synchronize({ root, env, fetchImpl, now });
    } catch (error) {
      const at = now().toISOString();
      const reason = error instanceof YoutubeConnectorError ? error.reason : "internal_error";

      try {
        recordFailure(root, { at, reason });
      } catch {
        // disque indisponible : l'erreur est tout de même renvoyée
      }

      return { status: "error", at, reason };
    } finally {
      release();
    }
  }

  return {
    summary: () => videoAnalyticsSummary(root),

    // Une seule synchronisation à la fois dans ce processus.
    sync() {
      running ??= sync().finally(() => { running = null; });

      return running;
    }
  };
}
