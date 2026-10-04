// Sonde de diagnostic YouTube Analytics par vidéo (R20.5, sous-lot 4B.0).
//
// Outil d'exploration, en lecture seule : 1 échange de jeton puis 3 rapports (4 au plus)
// sur l'API YouTube Analytics v2. La combinaison des dimensions jour et vidéo dans une même
// requête, refusée par l'API lors du test réel (HTTP 400), n'est plus interrogée. Rien n'est écrit : ni fichier, ni journal, ni état.
// Le miroir est seulement lu (confidentialité des vidéos) et n'est jamais modifié.
// Lancement uniquement à la demande : `npm run youtube-analytics-probe`.

import { readConnectionMeta } from "./auth/token-store.js";
import { YT_ANALYTICS_READONLY_SCOPE } from "./auth/config.js";
import { readMirror } from "./mirror.js";
import { connectYoutube, callGoogle, YoutubeConnectorError } from "./channel.js";

const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

// Les 9 métriques candidates du lot 4B (aucune métrique d'impressions, de CTR ni de revenus).
export const PROBE_METRICS = Object.freeze([
  "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage",
  "likes", "comments", "shares", "subscribersGained", "subscribersLost"
]);
export const PROBE_DAYS = 28;
export const MAX_PROBE_REQUESTS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_ROWS = 3;
const isoDay = date => date.toISOString().slice(0, 10);

export function probeWindow(now) {
  const endDate = isoDay(new Date(now.getTime() - DAY_MS));
  const startDate = isoDay(new Date(Date.parse(`${endDate}T00:00:00Z`) - (PROBE_DAYS - 1) * DAY_MS));

  return { startDate, endDate };
}

function daysBetween(startDate, endDate) {
  const days = [];

  for (let t = Date.parse(`${startDate}T00:00:00Z`); t <= Date.parse(`${endDate}T00:00:00Z`); t += DAY_MS) days.push(isoDay(new Date(t)));

  return days;
}

// Lecture seule du miroir : confidentialité connue de chaque vidéo (aucun appel).
function mirrorPrivacy(root) {
  const videos = readMirror(root).videos?.videos;
  const map = new Map();

  for (const v of Array.isArray(videos) ? videos : []) {
    if (typeof v?.video_id === "string") map.set(v.video_id, { privacy: v.privacy_status ?? "inconnue", present: v.mirror_status !== "removed" });
  }

  return map;
}

function describeError(json) {
  const e = json?.error;

  return {
    code: typeof e?.code === "number" ? e.code : null,
    message: typeof e?.message === "string" ? e.message.slice(0, 300) : null,
    reasons: Array.isArray(e?.errors) ? e.errors.map(x => String(x?.reason ?? "")).filter(Boolean).slice(0, 5) : []
  };
}

function analyse(json) {
  const headers = Array.isArray(json?.columnHeaders)
    ? json.columnHeaders.map(h => ({ name: String(h?.name), columnType: String(h?.columnType), dataType: String(h?.dataType) }))
    : [];
  const rows = Array.isArray(json?.rows) ? json.rows : [];
  const names = headers.map(h => h.name);
  const videoIndex = names.indexOf("video");
  const dayIndex = names.indexOf("day");

  return {
    top_level_keys: json && typeof json === "object" ? Object.keys(json) : [],
    kind: typeof json?.kind === "string" ? json.kind : null,
    rows_field: json?.rows === undefined ? "absent" : Array.isArray(json.rows) ? "tableau" : "autre",
    headers,
    row_count: rows.length,
    sample_rows: rows.slice(0, SAMPLE_ROWS),
    metrics_returned: headers.filter(h => h.columnType === "METRIC").map(h => h.name),
    dimensions_returned: headers.filter(h => h.columnType === "DIMENSION").map(h => h.name),
    video_ids: videoIndex >= 0 ? [...new Set(rows.map(r => r?.[videoIndex]).filter(v => typeof v === "string"))] : [],
    days: dayIndex >= 0 ? [...new Set(rows.map(r => r?.[dayIndex]).filter(v => typeof v === "string"))].sort() : []
  };
}

// Exécute la sonde. Ne lève jamais : renvoie un compte rendu en mémoire, sans rien écrire.
export async function runAnalyticsProbe({ root, env, fetchImpl = globalThis.fetch, now = () => new Date(), clock = () => performance.now() }) {
  const at = now();
  const { startDate, endDate } = probeWindow(at);
  const budget = { calls: 0 };
  const requests = [];
  const report = { at: at.toISOString(), window: { startDate, endDate, days: PROBE_DAYS }, status: "ok", reason: null, requests };
  const started = clock();
  const finish = () => ({ ...report, calls: budget.calls, analytics_requests: requests.filter(r => r.status !== null).length, total_ms: Math.round(clock() - started) });

  const meta = readConnectionMeta({ root });

  // Scope Analytics non accordé : aucun appel.
  if (meta.status === "connected" && !meta.scopes.includes(YT_ANALYTICS_READONLY_SCOPE)) {
    Object.assign(report, { status: "error", reason: "scope_missing" });

    return finish();
  }

  let accessToken;
  const tokenStart = clock();

  try {
    accessToken = await connectYoutube({ root, env, fetchImpl, budget });
  } catch (error) {
    Object.assign(report, { status: "error", reason: error instanceof YoutubeConnectorError ? error.reason : "internal_error" });

    return finish();
  }

  report.token_ms = Math.round(clock() - tokenStart);

  async function probe(label, params) {
    if (requests.length >= MAX_PROBE_REQUESTS) return null;

    const url = new URL(REPORTS_ENDPOINT);

    url.searchParams.set("ids", "channel==MINE");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const entry = { label, params: Object.fromEntries(url.searchParams), status: null, ok: false, ms: null, error: null, analysis: null, failure: null };
    const t0 = clock();

    requests.push(entry);

    try {
      const r = await callGoogle(fetchImpl, url.toString(), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } }, budget);

      Object.assign(entry, { status: r.status, ok: r.ok }, r.ok ? { analysis: analyse(r.json) } : { error: describeError(r.json) });
    } catch (error) {
      entry.failure = error instanceof YoutubeConnectorError ? error.reason : "internal_error";
    }

    entry.ms = Math.round(clock() - t0);

    return entry;
  }

  const metrics = PROBE_METRICS.join(",");
  const r1 = await probe("R1 dimension video, 28 jours, 9 métriques", { startDate, endDate, metrics, dimensions: "video", sort: "-views", maxResults: "200" });

  const r2 = await probe("R2 dimension video, un seul jour (la veille)", { startDate: endDate, endDate, metrics, dimensions: "video", sort: "-views", maxResults: "200" });

  // R3 : série quotidienne d'une vidéo (première vidéo vue par R1, sinon du miroir) ;
  // à défaut de vidéo connue, série quotidienne de la chaîne (jours sans données).
  const privacy = mirrorPrivacy(root);
  const videoId = r1?.analysis?.video_ids?.[0] ?? [...privacy.keys()][0] ?? null;

  const r3 = videoId
    ? await probe(`R3 dimension day filtrée sur une vidéo (${videoId}), 28 jours`, { startDate, endDate, metrics, dimensions: "day", filters: `video==${videoId}`, sort: "day" })
    : await probe("R3 dimension day sans filtre (aucune vidéo connue), 28 jours", { startDate, endDate, metrics, dimensions: "day", sort: "day" });

  // R4 seulement si R1 est refusée : isoler dimension et métriques (views seule).
  const r4 = r1?.ok ? null : await probe("R4 dimension video, views seule (R1 refusée)", { startDate, endDate, metrics: "views", dimensions: "video", sort: "-views", maxResults: "200" });

  report.conclusions = conclude({ r1, r2, r3, r4, privacy, expectedDays: daysBetween(startDate, endDate), videoId });

  return finish();
}

function conclude({ r1, r2, r3, r4, privacy, expectedDays, videoId }) {
  const seen = new Set([r1, r2, r4].flatMap(r => r?.analysis?.video_ids ?? []));
  const byPrivacy = {};

  for (const id of seen) {
    const p = privacy.get(id)?.privacy ?? "absente du miroir";
    byPrivacy[p] = (byPrivacy[p] ?? 0) + 1;
  }

  const mirrorCount = privacy_ => [...privacy.values()].filter(v => v.privacy === privacy_ && v.present).length;
  const notSeen = privacy_ => [...privacy.entries()].filter(([id, v]) => v.privacy === privacy_ && v.present && !seen.has(id)).length;
  const r3Days = r3?.analysis?.days ?? [];

  return {
    q1_video_single_day: !r2 ? "non testé" : r2.failure ? `non déterminé (${r2.failure})` : r2.ok ? "accepté" : "refusé",
    q3_metrics: PROBE_METRICS.map(m => ({ metric: m, with_video: r1?.ok ? (r1.analysis.metrics_returned.includes(m) ? "disponible" : "absente de la réponse") : r4?.ok && m === "views" ? "disponible (R4)" : "non confirmée", with_video_filter: r3?.ok && videoId ? (r3.analysis.metrics_returned.includes(m) ? "disponible" : "absente de la réponse") : "non confirmée" })),
    q4_days: r3?.ok ? { subject: videoId ? `vidéo ${videoId}` : "chaîne", expected: expectedDays.length, returned: r3Days.length, missing: expectedDays.filter(d => !r3Days.includes(d)).length, rows_field: r3.analysis.rows_field } : null,
    q5_private: { returned: byPrivacy.private ?? 0, in_mirror: mirrorCount("private"), in_mirror_not_returned: notSeen("private") },
    q6_unlisted: { returned: byPrivacy.unlisted ?? 0, in_mirror: mirrorCount("unlisted"), in_mirror_not_returned: notSeen("unlisted") },
    public: { returned: byPrivacy.public ?? 0, in_mirror: mirrorCount("public") },
    absent_from_mirror: byPrivacy["absente du miroir"] ?? 0,
    q7_no_video: seen.size === 0 ? { rows_field_r1: r1?.analysis?.rows_field ?? null, row_count_r1: r1?.analysis?.row_count ?? null } : null
  };
}
