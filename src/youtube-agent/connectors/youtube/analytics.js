// Analytiques YouTube de la chaîne (R20.5, lot 4A), en lecture seule.
//
// Un seul rapport par synchronisation : API YouTube Analytics v2, `reports`, métriques
// quotidiennes de la chaîne (dimension `day`). Synchronisation uniquement à la demande
// (commande `npm run youtube-analytics-sync` ou bouton local) : jamais au démarrage.
// L'échange du jeton et l'enveloppe HTTP sont ceux du connecteur de chaîne (channel.js).
//
// Stockage : partition `analytics` de l'unique chaîne, indépendante du miroir YouTube :
// - channel-daily-AAAA-MM.json : un fichier par mois, un enregistrement par jour,
//   remplacé à chaque relecture (YouTube révise les jours récents) ; l'historique est conservé ;
// - state.json : dernière tentative, dernière réussite, dernière erreur, plage lue ;
// - fetch.jsonl : journal des rapports reçus (ajout seul) ;
// - sync.lease : bail exclusif (une synchronisation à la fois).
// Les dates sont celles de l'API, conservées telles quelles (fuseau du Pacifique).

import { DEFAULT_CHANNEL_ID } from "../../config.js";
import { readJson, writeJsonAtomic, withFileLock, appendJsonl, readJsonl, acquireLease } from "../../atomic-json.js";
import { partitionFile } from "../../paths.js";
import { readConnectionMeta } from "./auth/token-store.js";
import { YT_ANALYTICS_READONLY_SCOPE } from "./auth/config.js";
import { connectYoutube, callGoogle, googleErrorReason, YoutubeConnectorError } from "./channel.js";

export const ANALYTICS_SCHEMA = "youtube-agent.analytics.v1";
const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

// Métriques du lot 4A (aucune métrique d'impressions, de CTR ni de revenus) :
// nom dans l'API → nom stocké.
export const ANALYTICS_METRICS = Object.freeze([
  ["views", "views"],
  ["estimatedMinutesWatched", "watch_time_minutes"],
  ["averageViewDuration", "average_view_duration_seconds"],
  ["averageViewPercentage", "average_view_percentage"],
  ["subscribersGained", "subscribers_gained"],
  ["subscribersLost", "subscribers_lost"],
  ["likes", "likes"],
  ["comments", "comments"],
  ["shares", "shares"]
]);

// Première lecture : 90 jours ; ensuite, relecture des 7 derniers jours déjà lus.
export const INITIAL_DAYS = 90;
export const REREAD_DAYS = 7;
export const ANALYTICS_LEASE_STALE_MS = 15 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const file = (root, name) => partitionFile(root, DEFAULT_CHANNEL_ID, "analytics", name);
const monthFile = (root, month) => file(root, `channel-daily-${month}.json`);
const isoDay = date => date.toISOString().slice(0, 10);
const shift = (day, days) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

// --- Plage de lecture -----------------------------------------------------------------

// Dernier jour demandé : la veille (le jour en cours est toujours incomplet).
export function analyticsWindow({ now, state }) {
  const endDate = isoDay(new Date(now.getTime() - DAY_MS));
  const lastEnd = DAY.test(state?.last_end_date ?? "") ? state.last_end_date : null;
  const startDate = lastEnd ? shift(lastEnd < endDate ? lastEnd : endDate, -(REREAD_DAYS - 1)) : shift(endDate, -(INITIAL_DAYS - 1));

  return { startDate, endDate };
}

// --- Rapport ----------------------------------------------------------------------------

export function parseReport(json) {
  const headers = Array.isArray(json?.columnHeaders) ? json.columnHeaders.map(h => h?.name) : null;
  const expected = ["day", ...ANALYTICS_METRICS.map(([api]) => api)];

  if (!headers || headers.join() !== expected.join()) throw new YoutubeConnectorError("incomplete");

  const rows = json.rows === undefined ? [] : json.rows;

  if (!Array.isArray(rows)) throw new YoutubeConnectorError("incomplete");

  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== expected.length || !DAY.test(row[0])) throw new YoutubeConnectorError("incomplete");

    const metrics = {};

    ANALYTICS_METRICS.forEach(([, stored], index) => {
      const value = row[index + 1];

      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new YoutubeConnectorError("incomplete");
      metrics[stored] = value;
    });

    return { day: row[0], metrics };
  });
}

async function fetchReport({ root, env, fetchImpl, startDate, endDate, budget }) {
  const meta = readConnectionMeta({ root });

  // Le scope Analytics doit avoir été accordé : sinon, aucun appel.
  if (meta.status === "connected" && !meta.scopes.includes(YT_ANALYTICS_READONLY_SCOPE)) throw new YoutubeConnectorError("scope_missing");

  const accessToken = await connectYoutube({ root, env, fetchImpl, budget });
  const url = new URL(REPORTS_ENDPOINT);

  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", ANALYTICS_METRICS.map(([api]) => api).join(","));
  url.searchParams.set("dimensions", "day");
  url.searchParams.set("sort", "day");

  const r = await callGoogle(fetchImpl, url.toString(), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, budget);

  if (!r.ok) throw new YoutubeConnectorError(googleErrorReason(r.status, r.json));

  return parseReport(r.json);
}

// --- Stockage ---------------------------------------------------------------------------

const atomic = (path, data) => withFileLock(path, () => writeJsonAtomic(path, data));

export function readAnalyticsState(root) {
  return readJson(file(root, "state.json"), null);
}

// Jours enregistrés, du plus ancien au plus récent (bornes incluses, facultatives).
export function readDailyMetrics(root, { from = null, to = null } = {}) {
  const state = readAnalyticsState(root);
  const days = [];

  for (const month of state?.months ?? []) {
    const content = readJson(monthFile(root, month), null);

    for (const [day, record] of Object.entries(content?.days ?? {})) {
      if ((!from || day >= from) && (!to || day <= to)) days.push({ day, ...record });
    }
  }

  return days.sort((a, b) => a.day.localeCompare(b.day));
}

function writeDays({ root, rows, fetchedAt }) {
  const byMonth = new Map();

  for (const row of rows) {
    const month = row.day.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }

  for (const [month, list] of byMonth) {
    const path = monthFile(root, month);

    withFileLock(path, () => {
      const current = readJson(path, null) ?? { schema: ANALYTICS_SCHEMA, month, days: {} };

      for (const row of list) current.days[row.day] = { ...row.metrics, fetched_at: fetchedAt };

      current.days = Object.fromEntries(Object.entries(current.days).sort(([a], [b]) => a.localeCompare(b)));
      writeJsonAtomic(path, current);
    });
  }

  return [...byMonth.keys()];
}

// --- Synchronisation --------------------------------------------------------------------

async function synchronize({ root, env, fetchImpl, now }) {
  const at = now();
  const previous = readAnalyticsState(root);
  const { startDate, endDate } = analyticsWindow({ now: at, state: previous });
  const budget = { calls: 0 };
  const rows = await fetchReport({ root, env, fetchImpl, startDate, endDate, budget });
  const fetchedAt = at.toISOString();
  const months = writeDays({ root, rows, fetchedAt });
  const summary = { start_date: startDate, end_date: endDate, days_received: rows.length, calls: budget.calls, analytics_requests: budget.calls - 1 };

  appendJsonl(file(root, "fetch.jsonl"), { schema: ANALYTICS_SCHEMA, at: fetchedAt, ...summary });
  atomic(file(root, "state.json"), {
    schema: ANALYTICS_SCHEMA,
    last_attempt_at: fetchedAt,
    last_success_at: fetchedAt,
    last_error: null,
    last_end_date: endDate,
    months: [...new Set([...(previous?.months ?? []), ...months])].sort(),
    last_summary: summary,
    sync_count: (previous?.sync_count ?? 0) + 1
  });

  return { status: "ok", synced_at: fetchedAt, summary };
}

function recordFailure(root, { at, reason }) {
  const previous = readAnalyticsState(root);

  atomic(file(root, "state.json"), {
    schema: ANALYTICS_SCHEMA,
    last_attempt_at: at,
    last_success_at: previous?.last_success_at ?? null,
    last_error: { reason, at },
    last_end_date: previous?.last_end_date ?? null,
    months: previous?.months ?? [],
    last_summary: previous?.last_summary ?? null,
    sync_count: previous?.sync_count ?? 0
  });
}

// Résumé lisible par l'agent et l'interface locale (aucun appel réseau).
export function analyticsSummary(root, { days = 28 } = {}) {
  const state = readAnalyticsState(root);

  if (!state?.last_success_at) {
    return state?.last_error ? { status: "error", reason: state.last_error.reason, at: state.last_error.at } : { status: "not_loaded" };
  }

  const to = state.last_end_date;
  const from = shift(to, -(days - 1));
  const window = readDailyMetrics(root, { from, to });
  const sum = key => window.reduce((total, record) => total + (record[key] ?? 0), 0);
  const views = sum("views");

  return {
    status: "ok",
    synced_at: state.last_success_at,
    data_until: to,
    period: { from, to, days_with_data: window.length },
    days_stored: readDailyMetrics(root).length,
    totals: {
      views,
      watch_time_minutes: sum("watch_time_minutes"),
      subscribers_net: sum("subscribers_gained") - sum("subscribers_lost"),
      likes: sum("likes"),
      comments: sum("comments"),
      shares: sum("shares"),
      // Pondérée par les vues ; null s'il n'y a aucune vue sur la période.
      average_view_percentage: views > 0 ? window.reduce((total, r) => total + (r.average_view_percentage ?? 0) * (r.views ?? 0), 0) / views : null
    },
    ...(state.last_error ? { last_error: state.last_error } : {})
  };
}

export function readFetchLog(root, { maxLines = 100 } = {}) {
  return readJsonl(file(root, "fetch.jsonl"), { maxLines });
}

// Lecteur et synchronisation à la demande. summary() ne fait jamais d'appel réseau.
export function createYoutubeAnalytics({ root, env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let running = null;

  async function sync() {
    const release = acquireLease(file(root, "sync.lease"), ANALYTICS_LEASE_STALE_MS);

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
    summary: () => analyticsSummary(root),

    // Une seule synchronisation à la fois dans ce processus.
    sync() {
      running ??= sync().finally(() => { running = null; });

      return running;
    }
  };
}
