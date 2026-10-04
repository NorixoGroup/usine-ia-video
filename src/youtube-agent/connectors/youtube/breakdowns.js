// Répartitions de la chaîne sur 28 jours (R20.6), en lecture seule.
//
// Une requête par dimension, jamais combinée avec une autre : sources de trafic,
// appareils, pays. Métriques : vues et durée de visionnage. Une dimension refusée par
// l'API est notée (raison et message de Google) sans arrêter les autres ; ses données
// précédentes sont conservées. Synchronisation uniquement via la suite Analytics.
//
// Stockage (partition `analytics`) : breakdowns.json (dernière lecture par dimension),
// breakdowns.jsonl (historique, ajout seul), breakdowns.lease (bail exclusif).

import { DEFAULT_CHANNEL_ID } from "../../config.js";
import { readJson, writeJsonAtomic, withFileLock, appendJsonl, acquireLease } from "../../atomic-json.js";
import { partitionFile } from "../../paths.js";
import { readConnectionMeta } from "./auth/token-store.js";
import { YT_ANALYTICS_READONLY_SCOPE } from "./auth/config.js";
import { connectYoutube, callGoogle, googleErrorReason, YoutubeConnectorError } from "./channel.js";

export const BREAKDOWNS_SCHEMA = "youtube-agent.breakdowns.v1";
const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

// Nom stocké → dimension de l'API.
export const BREAKDOWN_DIMENSIONS = Object.freeze([
  ["traffic_source", "insightTrafficSourceType"],
  ["device_type", "deviceType"],
  ["country", "country"]
]);
const METRICS = "views,estimatedMinutesWatched";
export const BREAKDOWN_DAYS = 28;
export const MAX_BREAKDOWN_ROWS = 50;
const LEASE_STALE_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
// Échecs qui interrompent les dimensions restantes ; les autres refus ne concernent qu'une dimension.
const STOPPING = new Set(["unauthorized", "quota_exceeded", "upstream", "network", "bad_response", "sync_limit"]);

const file = (root, name) => partitionFile(root, DEFAULT_CHANNEL_ID, "analytics", name);
const isoDay = date => date.toISOString().slice(0, 10);

export function breakdownWindow(now) {
  const endDate = isoDay(new Date(now.getTime() - DAY_MS));
  const startDate = isoDay(new Date(Date.parse(`${endDate}T00:00:00Z`) - (BREAKDOWN_DAYS - 1) * DAY_MS));

  return { startDate, endDate };
}

export function parseBreakdown(json, dimension) {
  const headers = Array.isArray(json?.columnHeaders) ? json.columnHeaders.map(h => h?.name) : null;

  if (!headers || headers.join() !== [dimension, "views", "estimatedMinutesWatched"].join()) throw new YoutubeConnectorError("incomplete");

  const rows = json.rows === undefined ? [] : json.rows;

  if (!Array.isArray(rows)) throw new YoutubeConnectorError("incomplete");

  return rows.map(row => {
    if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== "string" || !KEY.test(row[0])) throw new YoutubeConnectorError("incomplete");
    if (![row[1], row[2]].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) throw new YoutubeConnectorError("incomplete");

    return { key: row[0], views: row[1], watch_time_minutes: row[2] };
  }).sort((a, b) => b.views - a.views || a.key.localeCompare(b.key)).slice(0, MAX_BREAKDOWN_ROWS);
}

export function readBreakdowns(root) {
  return readJson(file(root, "breakdowns.json"), null);
}

async function fetchDimension({ fetchImpl, accessToken, budget, dimension, startDate, endDate }) {
  const url = new URL(REPORTS_ENDPOINT);

  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("metrics", METRICS);
  url.searchParams.set("dimensions", dimension);
  url.searchParams.set("sort", "-views");

  const r = await callGoogle(fetchImpl, url.toString(), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, budget);

  if (!r.ok) {
    const error = new YoutubeConnectorError(googleErrorReason(r.status, r.json));
    const message = r.json?.error?.message;

    error.googleMessage = typeof message === "string" ? message.slice(0, 200) : null;
    throw error;
  }

  return parseBreakdown(r.json, dimension);
}

// Synchronisation des répartitions : ne lève jamais ; renvoie le résultat et l'enregistre.
export async function syncBreakdowns({ root, env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const release = acquireLease(file(root, "breakdowns.lease"), LEASE_STALE_MS);
  const at = now();
  const fetchedAt = at.toISOString();

  if (!release) return { status: "error", at: fetchedAt, reason: "sync_in_progress" };

  try {
    const meta = readConnectionMeta({ root });

    if (meta.status === "connected" && !meta.scopes.includes(YT_ANALYTICS_READONLY_SCOPE)) throw new YoutubeConnectorError("scope_missing");

    const budget = { calls: 0 };
    const accessToken = await connectYoutube({ root, env, fetchImpl, budget });
    const { startDate, endDate } = breakdownWindow(at);
    const previous = readBreakdowns(root);
    const dimensions = {};
    let stopped = null;

    for (const [name, dimension] of BREAKDOWN_DIMENSIONS) {
      if (stopped) {
        dimensions[name] = { ...(previous?.dimensions?.[name] ?? { status: "not_loaded" }), last_error: { reason: "not_attempted", at: fetchedAt } };
        continue;
      }

      try {
        dimensions[name] = { status: "ok", dimension, fetched_at: fetchedAt, period: { from: startDate, to: endDate }, rows: await fetchDimension({ fetchImpl, accessToken, budget, dimension, startDate, endDate }), last_error: null };
      } catch (error) {
        const reason = error instanceof YoutubeConnectorError ? error.reason : "internal_error";
        const last = { reason, at: fetchedAt, ...(error?.googleMessage ? { message: error.googleMessage } : {}) };
        const kept = previous?.dimensions?.[name]?.status === "ok" ? previous.dimensions[name] : { status: "error", dimension };

        dimensions[name] = { ...kept, last_error: last };
        if (STOPPING.has(reason) || reason === "internal_error") stopped = reason;
      }
    }

    const ok = Object.values(dimensions).filter(d => d.last_error === null).length;
    const summary = { period: { from: startDate, to: endDate }, dimensions_ok: ok, dimensions_failed: BREAKDOWN_DIMENSIONS.length - ok, calls: budget.calls, analytics_requests: budget.calls - 1, stopped };
    const content = { schema: BREAKDOWNS_SCHEMA, last_attempt_at: fetchedAt, dimensions, last_summary: summary };

    withFileLock(file(root, "breakdowns.json"), () => writeJsonAtomic(file(root, "breakdowns.json"), content));
    appendJsonl(file(root, "breakdowns.jsonl"), { schema: BREAKDOWNS_SCHEMA, at: fetchedAt, ...summary, rows: Object.fromEntries(Object.entries(dimensions).filter(([, d]) => d.last_error === null).map(([n, d]) => [n, d.rows])) });

    return stopped ? { status: "error", at: fetchedAt, reason: stopped, summary } : { status: "ok", synced_at: fetchedAt, summary };
  } catch (error) {
    return { status: "error", at: fetchedAt, reason: error instanceof YoutubeConnectorError ? error.reason : "internal_error" };
  } finally {
    release();
  }
}
