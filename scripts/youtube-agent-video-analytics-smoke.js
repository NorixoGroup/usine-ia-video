// Smoke R20.5 lot 4B — analytiques par vidéo (Google simulé).
// Liste `dimensions=video` puis une série `dimensions=day` + `filters=video==ID` par vidéo
// (jamais les deux dimensions ensemble), complément par le miroir, fichiers mensuels,
// relecture des 7 derniers jours, historique, échecs sans perte, bail, plafond par
// synchronisation, miroir et fichiers du lot 4A intacts, commande et journal.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-video-analytics-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import { createYoutubeVideoAnalytics, readVideoDaily, readVideoAnalyticsState, readVideoFetchLog, videoAnalyticsSummary, MAX_VIDEOS_PER_SYNC, VIDEO_LIST_MAX_RESULTS } from "../src/youtube-agent/connectors/youtube/video-analytics.js";
import { ANALYTICS_METRICS } from "../src/youtube-agent/connectors/youtube/analytics.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { runVideoAnalyticsSync, formatVideoAnalyticsSync } from "../src/youtube-agent/youtube-analytics-videos-sync.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 3);
const SECRET = "test-client-secret-video-analytics";
const REFRESH = "test-refresh-token-video-analytics";
const ACCESS = "test-access-token-video-analytics";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
const API_METRICS = ANALYTICS_METRICS.map(([api]) => api);
const NOW = new Date("2026-10-04T10:00:00Z");
const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const P = "ppppppppppp";
const R = "rrrrrrrrrrr";
const U = "uuuuuuuuuuu";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const analyticsDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "analytics");
const mirrorDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");
const days = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const snapshot = (dir, filter = () => true) => fs.existsSync(dir) ? JSON.stringify(fs.readdirSync(dir).filter(filter).sort().map(f => [f, fs.readFileSync(path.join(dir, f), "utf8")])) : "[]";
const reportCalls = ctx => ctx.calls.filter(c => c.url.startsWith(`${REPORTS}?`)).map(c => Object.fromEntries(new URL(c.url).searchParams));
let combined = 0;

// Google simulé : `active` = vidéos ayant des données (liste) ; `views` réglable (révisions).
function setup({ connected = true, scopes = [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE], mirror = null, now = () => NOW } = {}) {
  const root = tmpRoot("video-analytics");
  const calls = [];
  const sim = { active: [], views: 10, refuseVideo: new Set(), quotaAfterReports: null, failList: null, badSeries: false };

  if (connected) saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes, now: new Date("2026-10-03T10:00:00Z") });
  if (mirror) {
    fs.mkdirSync(mirrorDir(root), { recursive: true });
    fs.writeFileSync(path.join(mirrorDir(root), "videos.json"), JSON.stringify({ schema: "youtube-agent.mirror.v1", videos: mirror }));
  }

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });

    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
    if (!url.startsWith(`${REPORTS}?`)) throw new Error(`appel inattendu ${url}`);

    const q = new URL(url).searchParams;
    const dims = q.get("dimensions");

    if (dims.includes(",")) {
      combined += 1;
      return json(400, { error: { code: 400, message: "The query is not supported.", errors: [{ reason: "badRequest" }] } });
    }
    if (sim.quotaAfterReports !== null && reportCalls({ calls }).length > sim.quotaAfterReports) return json(403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } });

    const metricHeaders = q.get("metrics").split(",").map(name => ({ name, columnType: "METRIC", dataType: "INTEGER" }));

    if (dims === "video") {
      if (sim.failList === "network") throw new TypeError("fetch failed");
      if (sim.failList === "headers") return json(200, { columnHeaders: [{ name: "video" }], rows: [] });
      const rows = sim.active.slice(0, Number(q.get("maxResults"))).map(id => [id, sim.views, 30, 120, 45.5, 2, 1, 3, 1, 0]);
      return json(200, { kind: "youtubeAnalytics#resultTable", columnHeaders: [{ name: "video", columnType: "DIMENSION", dataType: "STRING" }, ...metricHeaders], rows });
    }

    if (dims === "day") {
      const id = (q.get("filters") ?? "").replace(/^video==/, "");
      if (sim.refuseVideo.has(id)) return json(403, { error: { code: 403, errors: [{ reason: "forbidden" }] } });
      const headers = [{ name: "day", columnType: "DIMENSION", dataType: "STRING" }, ...metricHeaders];
      if (sim.badSeries) return json(200, { columnHeaders: headers.slice(0, 3), rows: [] });
      const rows = sim.active.includes(id) ? days(q.get("startDate"), q.get("endDate")).map(day => [day, sim.views, 30, 120, 45.5, 2, 1, 3, 1, 0]) : [];
      return json(200, { kind: "youtubeAnalytics#resultTable", columnHeaders: headers, rows });
    }

    throw new Error(`dimensions inattendues ${dims}`);
  };

  return { root, calls, sim, fetchImpl, analytics: createYoutubeVideoAnalytics({ root, env: ENV, fetchImpl, now }) };
}

const MIRROR = [
  { video_id: A, title: "Vidéo A", privacy_status: "public", mirror_status: "present" },
  { video_id: P, title: "Vidéo privée", privacy_status: "private", mirror_status: "present" },
  { video_id: R, title: "Vidéo retirée", privacy_status: "public", mirror_status: "removed" }
];

await asyncCheck("chaîne vide : 1 jeton + 1 liste (rows vide), aucune série, état ok, aucun fichier quotidien", async () => {
  const ctx = setup();
  const r = await ctx.analytics.sync();
  if (r.status !== "ok" || r.summary.calls !== 2 || r.summary.analytics_requests !== 1 || r.summary.selected !== 0 || r.summary.listed !== 0) throw new Error(JSON.stringify(r));
  const [list] = reportCalls(ctx);
  if (list.dimensions !== "video" || list.sort !== "-views" || list.maxResults !== "200" || list.metrics !== API_METRICS.join(",") || list.startDate !== "2026-07-06" || list.endDate !== "2026-10-03" || list.ids !== "channel==MINE") throw new Error(JSON.stringify(list));
  const files = fs.readdirSync(analyticsDir(ctx.root)).sort();
  if (files.join() !== "video-fetch.jsonl,video-index.json,video-state.json") throw new Error(files.join());
  const s = ctx.analytics.summary();
  if (s.status !== "ok" || s.videos_tracked !== 0) throw new Error(JSON.stringify(s));
  cleanup(ctx.root);
});

await asyncCheck("liste puis une série par vidéo (dimensions=day, filters=video==ID), complétée par le miroir, sans les vidéos retirées", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A, B];
  const r = await ctx.analytics.sync();
  const s = r.summary;
  if (r.status !== "ok" || s.listed !== 2 || s.from_mirror !== 1 || s.selected !== 3 || s.synced !== 3 || s.calls !== 5 || s.analytics_requests !== 4 || s.days_received !== 180) throw new Error(JSON.stringify(s));
  const series = reportCalls(ctx).slice(1);
  if (series.map(x => x.filters).join() !== `video==${A},video==${B},video==${P}`) throw new Error(series.map(x => x.filters).join());
  if (series.some(x => x.dimensions !== "day" || x.sort !== "day" || x.metrics !== API_METRICS.join(",") || x.startDate !== "2026-07-06" || x.endDate !== "2026-10-03")) throw new Error(JSON.stringify(series[0]));
  if (reportCalls(ctx).some(x => x.filters === `video==${R}`)) throw new Error("vidéo retirée interrogée");
  if (ctx.calls.filter(c => c.url.startsWith(REPORTS)).some(c => c.init.method !== "GET")) throw new Error("méthode");
  cleanup(ctx.root);
});

await asyncCheck("stockage : fichiers mensuels par vidéo et par jour, 9 métriques, permissions, aucun temporaire", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A, B];
  await ctx.analytics.sync();
  const files = fs.readdirSync(analyticsDir(ctx.root)).sort();
  if (files.join() !== "video-daily-2026-07.json,video-daily-2026-08.json,video-daily-2026-09.json,video-daily-2026-10.json,video-fetch.jsonl,video-index.json,video-state.json") throw new Error(files.join());
  const july = JSON.parse(fs.readFileSync(path.join(analyticsDir(ctx.root), "video-daily-2026-07.json"), "utf8"));
  if (july.schema !== "youtube-agent.video-analytics.v1" || july.month !== "2026-07" || Object.keys(july.videos).join() !== `${A},${B}` || Object.keys(july.videos[A]).length !== 26) throw new Error(JSON.stringify(Object.keys(july.videos)));
  const d = july.videos[A]["2026-07-06"];
  if (Object.keys(d).sort().join() !== "average_view_duration_seconds,average_view_percentage,comments,fetched_at,likes,shares,subscribers_gained,subscribers_lost,views,watch_time_minutes" || d.views !== 10 || d.average_view_percentage !== 45.5) throw new Error(JSON.stringify(d));
  if (process.platform !== "win32" && (fs.statSync(path.join(analyticsDir(ctx.root), "video-state.json")).mode & 0o077) !== 0) throw new Error("permissions");
  if (readVideoDaily(ctx.root, A).length !== 90 || readVideoDaily(ctx.root, P).length !== 0) throw new Error("lecture");
  const state = readVideoAnalyticsState(ctx.root);
  if (Object.keys(state.videos).sort().join() !== [A, B, P].sort().join() || state.videos[P].last_end_date !== "2026-10-03" || state.videos[P].days_last_sync !== 0) throw new Error(JSON.stringify(state.videos));
  cleanup(ctx.root);
});

await asyncCheck("incrémental : relecture des 7 derniers jours par vidéo, révisions remplacées, historique conservé, nouvelle vidéo sur 90 jours", async () => {
  let now = NOW;
  const ctx = setup({ now: () => now });
  ctx.sim.active = [A];
  await ctx.analytics.sync();
  ctx.sim.active = [A, U];
  ctx.sim.views = 99;
  now = new Date("2026-10-06T10:00:00Z");
  ctx.calls.length = 0;
  const r = await ctx.analytics.sync();
  const [, sA, sU] = reportCalls(ctx);
  if (r.status !== "ok" || sA.filters !== `video==${A}` || sA.startDate !== "2026-09-27" || sA.endDate !== "2026-10-05" || sU.startDate !== "2026-07-08" || sU.endDate !== "2026-10-05") throw new Error(JSON.stringify([sA, sU]));
  const a = Object.fromEntries(readVideoDaily(ctx.root, A).map(x => [x.day, x]));
  if (Object.keys(a).length !== 92 || a["2026-09-26"].views !== 10 || a["2026-09-27"].views !== 99 || a["2026-10-05"].views !== 99 || a["2026-09-26"].fetched_at !== NOW.toISOString()) throw new Error("historique");
  if (readVideoDaily(ctx.root, U).length !== 90 || readVideoFetchLog(ctx.root).length !== 2 || readVideoAnalyticsState(ctx.root).sync_count !== 2) throw new Error("nouvelle vidéo");
  cleanup(ctx.root);
});

await asyncCheck("résumé local (aucun appel) : 28 jours, titre et confidentialité du miroir, vidéo inconnue du miroir, tri par vues", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A, B];
  await ctx.analytics.sync();
  const before = ctx.calls.length;
  const s = videoAnalyticsSummary(ctx.root);
  if (ctx.calls.length !== before || s.status !== "ok" || s.videos_tracked !== 3) throw new Error(JSON.stringify(s));
  const byId = Object.fromEntries(s.videos.map(v => [v.video_id, v]));
  if (byId[A].title !== "Vidéo A" || byId[A].privacy_status !== "public" || byId[A].mirror_status !== "present" || byId[A].totals.views !== 280 || byId[A].totals.average_view_percentage !== 45.5 || byId[A].days_stored !== 90) throw new Error(JSON.stringify(byId[A]));
  if (byId[B].mirror_status !== "unknown" || byId[B].title !== null || byId[P].privacy_status !== "private" || byId[P].totals.views !== 0 || byId[P].totals.average_view_percentage !== null) throw new Error(JSON.stringify([byId[B], byId[P]]));
  if (s.videos[2].video_id !== P) throw new Error("tri");
  cleanup(ctx.root);
});

await asyncCheck("refus propre à une vidéo (403 forbidden) : noté sur la vidéo, les autres continuent, synchronisation ok", async () => {
  const ctx = setup();
  ctx.sim.active = [A, B];
  ctx.sim.refuseVideo.add(A);
  const r = await ctx.analytics.sync();
  if (r.status !== "ok" || r.summary.synced !== 1 || r.summary.failed !== 1) throw new Error(JSON.stringify(r.summary));
  const state = readVideoAnalyticsState(ctx.root);
  if (state.videos[A].last_error.reason !== "forbidden" || state.videos[A].last_end_date !== null || state.videos[B].last_error !== null || readVideoDaily(ctx.root, B).length !== 90) throw new Error(JSON.stringify(state.videos));
  const s = videoAnalyticsSummary(ctx.root);
  if (s.videos.find(v => v.video_id === A).last_error.reason !== "forbidden") throw new Error("résumé");
  cleanup(ctx.root);
});

await asyncCheck("quota atteint en cours de route : arrêt, vidéos déjà traitées conservées, les autres intactes", async () => {
  let now = NOW;
  const ctx = setup({ now: () => now });
  ctx.sim.active = [A, B];
  await ctx.analytics.sync();
  const bBefore = JSON.stringify(readVideoDaily(ctx.root, B));
  ctx.sim.views = 50;
  ctx.calls.length = 0;
  ctx.sim.quotaAfterReports = 2;
  now = new Date("2026-10-05T10:00:00Z");
  const r = await ctx.analytics.sync();
  if (r.status !== "error" || r.reason !== "quota_exceeded" || r.summary.synced !== 1 || r.summary.stopped !== "quota_exceeded") throw new Error(JSON.stringify(r));
  if (readVideoDaily(ctx.root, A).at(-1).views !== 50 || JSON.stringify(readVideoDaily(ctx.root, B)) !== bBefore) throw new Error("données");
  const state = readVideoAnalyticsState(ctx.root);
  if (state.last_error.reason !== "quota_exceeded" || state.last_success_at !== NOW.toISOString() || state.sync_count !== 1 || state.videos[A].last_end_date !== "2026-10-04" || state.videos[B].last_end_date !== "2026-10-03") throw new Error(JSON.stringify(state));
  if (readVideoFetchLog(ctx.root).at(-1).status !== "partial") throw new Error("journal des synchronisations");
  if (fs.readdirSync(analyticsDir(ctx.root)).some(f => f.includes(".tmp") || f.endsWith(".lock") || f.endsWith(".lease"))) throw new Error("résidu");
  cleanup(ctx.root);
});

await asyncCheck("échec de la liste (réseau, en-têtes inattendus) et séries inattendues : données précédentes intactes", async () => {
  for (const failure of ["network", "headers", "series"]) {
    const ctx = setup();
    ctx.sim.active = [A];
    await ctx.analytics.sync();
    const before = snapshot(analyticsDir(ctx.root), f => f.startsWith("video-daily-"));
    if (failure === "series") ctx.sim.badSeries = true;
    else ctx.sim.failList = failure;
    const r = await ctx.analytics.sync();
    const expected = failure === "network" ? "network" : "incomplete";
    if (failure === "series") {
      if (r.status !== "ok" || r.summary.failed !== 1 || readVideoAnalyticsState(ctx.root).videos[A].last_error.reason !== "incomplete") throw new Error(JSON.stringify(r));
    } else if (r.status !== "error" || r.reason !== expected || readVideoAnalyticsState(ctx.root).last_error.reason !== expected) {
      throw new Error(`${failure} : ${JSON.stringify(r)}`);
    }
    if (snapshot(analyticsDir(ctx.root), f => f.startsWith("video-daily-")) !== before) throw new Error(`${failure} : données modifiées`);
    if (videoAnalyticsSummary(ctx.root).videos[0].days_stored !== 90) throw new Error("résumé");
    cleanup(ctx.root);
  }
});

await asyncCheck("sans configuration, sans connexion ou sans scope Analytics : aucun appel", async () => {
  for (const [opts, env, reason] of [[{}, {}, "not_configured"], [{ connected: false }, ENV, "not_connected"], [{ scopes: [YOUTUBE_READONLY_SCOPE] }, ENV, "scope_missing"]]) {
    const ctx = setup(opts);
    const r = await createYoutubeVideoAnalytics({ root: ctx.root, env, fetchImpl: ctx.fetchImpl, now: () => NOW }).sync();
    if (r.status !== "error" || r.reason !== reason || ctx.calls.length !== 0) throw new Error(`${reason} : ${JSON.stringify(r)}`);
    if (videoAnalyticsSummary(ctx.root).status !== "error") throw new Error("état d'erreur");
    cleanup(ctx.root);
  }
});

await asyncCheck("bail exclusif (sync_in_progress, aucun appel) et une seule synchronisation à la fois dans le processus", async () => {
  const ctx = setup();
  fs.mkdirSync(analyticsDir(ctx.root), { recursive: true });
  fs.writeFileSync(path.join(analyticsDir(ctx.root), "video-sync.lease"), "1");
  const r = await ctx.analytics.sync();
  if (r.status !== "error" || r.reason !== "sync_in_progress" || ctx.calls.length !== 0) throw new Error(JSON.stringify(r));
  fs.rmSync(path.join(analyticsDir(ctx.root), "video-sync.lease"));
  ctx.sim.active = [A];
  const [x, y] = await Promise.all([ctx.analytics.sync(), ctx.analytics.sync()]);
  if (x !== y || x.status !== "ok" || reportCalls(ctx).length !== 2) throw new Error("synchronisations concurrentes");
  if (fs.existsSync(path.join(analyticsDir(ctx.root), "video-sync.lease"))) throw new Error("bail résiduel");
  cleanup(ctx.root);
});

await asyncCheck("page de liste pleine (200) signalée ; plafond de 450 vidéos par synchronisation, reliquat compté", async () => {
  const listed = Array.from({ length: VIDEO_LIST_MAX_RESULTS }, (_, i) => `L${String(i).padStart(10, "0")}`);
  const fromMirror = Array.from({ length: 260 }, (_, i) => ({ video_id: `M${String(i).padStart(10, "0")}`, privacy_status: "public", mirror_status: "present" }));
  const ctx = setup({ mirror: fromMirror });
  ctx.sim.active = listed;
  const r = await ctx.analytics.sync();
  const s = r.summary;
  if (r.status !== "ok" || !s.list_truncated || s.listed !== 200 || s.from_mirror !== 260 || s.selected !== MAX_VIDEOS_PER_SYNC || s.skipped !== 10 || s.calls !== 452) throw new Error(JSON.stringify(s));
  cleanup(ctx.root);
});

await asyncCheck("miroir et fichiers du lot 4A intacts", async () => {
  const ctx = setup({ mirror: MIRROR });
  fs.mkdirSync(analyticsDir(ctx.root), { recursive: true });
  for (const f of ["channel-daily-2026-10.json", "state.json"]) fs.writeFileSync(path.join(analyticsDir(ctx.root), f), JSON.stringify({ marker: f }));
  fs.writeFileSync(path.join(analyticsDir(ctx.root), "fetch.jsonl"), "{\"marker\":1}\n");
  const mirrorBefore = snapshot(mirrorDir(ctx.root));
  const lot4aBefore = snapshot(analyticsDir(ctx.root));
  ctx.sim.active = [A];
  await ctx.analytics.sync();
  ctx.sim.failList = "network";
  await ctx.analytics.sync();
  if (snapshot(mirrorDir(ctx.root)) !== mirrorBefore) throw new Error("miroir modifié");
  if (snapshot(analyticsDir(ctx.root), f => !f.startsWith("video-")) !== lot4aBefore) throw new Error("fichiers du lot 4A modifiés");
  cleanup(ctx.root);
});

await asyncCheck("commande npm run youtube-analytics-videos-sync : synchronise, journalise, affiche sans secret ; échec propre", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A];
  const r = await runVideoAnalyticsSync({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => NOW });
  const entry = readJournal({ root: ctx.root, channelId: "nomade" }).at(-1);
  if (r.status !== "ok" || entry.type !== "youtube_video_analytics_sync" || entry.outcome !== "ok" || !/2 vidéo\(s\) synchronisée\(s\)/.test(entry.detail)) throw new Error(JSON.stringify(entry));
  const text = formatVideoAnalyticsSync(r);
  if (!text.includes("réussie") || !text.includes("2 synchronisée(s)") || !text.includes("fuseau du Pacifique")) throw new Error(text);
  const off = setup({ connected: false });
  const e = await runVideoAnalyticsSync({ root: off.root, env: ENV, fetchImpl: off.fetchImpl, now: () => NOW });
  if (e.status !== "error" || e.reason !== "not_connected" || off.calls.length !== 0 || readJournal({ root: off.root, channelId: "nomade" }).at(-1).outcome !== "not_connected") throw new Error(JSON.stringify(e));
  if (!formatVideoAnalyticsSync(e).includes("impossible : not_connected")) throw new Error("affichage de l'échec");
  const all = [text, formatVideoAnalyticsSync(e), JSON.stringify(readJournal({ root: ctx.root, channelId: "nomade" })), snapshot(analyticsDir(ctx.root))].join("\n");
  if ([ACCESS, REFRESH, SECRET].some(x => all.includes(x))) throw new Error("fuite");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (pkg.scripts["youtube-analytics-videos-sync"] !== "node --env-file=.env.local src/youtube-agent/youtube-analytics-videos-sync.js") throw new Error("script npm");
  cleanup(ctx.root);
  cleanup(off.root);
});

check("à la demande seulement : aucun lecteur par vidéo dans le serveur, l'agent ou le pont (la suite R20.6 passe par la commande ou le bouton)", () => {
  for (const rel of ["server.js", "agent.js", "agent-api.js", "studio-models.js", "views.js"]) {
    const code = fs.readFileSync(new URL(`../src/youtube-agent/${rel}`, import.meta.url), "utf8");
    if (/video-analytics\.js|createYoutubeVideoAnalytics/.test(code)) throw new Error(`${rel} utilise le lecteur par vidéo`);
  }
  const server = fs.readFileSync(new URL("../src/youtube-agent/server.js", import.meta.url), "utf8");
  if (/\.sync\(/.test(server.slice(server.indexOf("export function startServer")))) throw new Error("synchronisation au démarrage");
});

check("aucune requête n'a combiné les dimensions jour et vidéo", () => {
  if (combined !== 0) throw new Error(`${combined} requête(s)`);
});

if (networkGuard.attempts().length !== 0) check("aucune tentative réseau réelle", () => { throw new Error(`${networkGuard.attempts().length} tentatives`); });

done("youtube-agent-video-analytics-smoke");
