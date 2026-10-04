// Smoke R20.6 — suite Analytics (Google simulé) : chaîne, répartitions sur 28 jours,
// vidéos et index. Une dimension par requête, refus d'une dimension sans blocage,
// arrêt propre sur quota, cause commune sans appel, index par vidéo, bouton local,
// journal, commande, miroir intact, aucun appel au démarrage.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-analytics-suite-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import { createYoutubeAnalyticsSuite } from "../src/youtube-agent/connectors/youtube/analytics-suite.js";
import { syncBreakdowns, readBreakdowns, parseBreakdown, breakdownWindow, MAX_BREAKDOWN_ROWS } from "../src/youtube-agent/connectors/youtube/breakdowns.js";
import { readVideoIndex, buildVideoIndex, videoAnalyticsSummary } from "../src/youtube-agent/connectors/youtube/video-analytics.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { createHandler } from "../src/youtube-agent/server.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { runAnalytics, formatAnalytics } from "../src/youtube-agent/youtube-analytics.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 4);
const SECRET = "test-client-secret-suite";
const REFRESH = "test-refresh-token-suite";
const ACCESS = "test-access-token-suite";
const SESSION = "s".repeat(64);
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
const NOW = new Date("2026-10-04T10:00:00Z");
const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const BREAKDOWN_DIMS = ["insightTrafficSourceType", "deviceType", "country"];

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const analyticsDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "analytics");
const mirrorDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");
const days = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const snapshot = dir => fs.existsSync(dir) ? JSON.stringify(fs.readdirSync(dir).sort().map(f => [f, fs.readFileSync(path.join(dir, f), "utf8")])) : "[]";
const reports = ctx => ctx.calls.filter(c => c.url.startsWith(`${REPORTS}?`)).map(c => Object.fromEntries(new URL(c.url).searchParams));
const header = (name, columnType = "METRIC") => ({ name, columnType, dataType: columnType === "METRIC" ? "INTEGER" : "STRING" });
let combined = 0;

const BREAKDOWN_ROWS = {
  insightTrafficSourceType: [["YT_SEARCH", 40, 120], ["SUGGESTED", 60, 200], ["EXT_URL", 5, 9]],
  deviceType: [["MOBILE", 70, 210], ["DESKTOP", 35, 119]],
  country: Array.from({ length: 60 }, (_, i) => [`C${String(i).padStart(2, "0")}`, i, i * 2])
};

function setup({ connected = true, mirror = null, now = () => NOW } = {}) {
  const root = tmpRoot("suite");
  const calls = [];
  const sim = { active: [], refuse: new Set(), quotaOn: null };

  if (connected) saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE], now: new Date("2026-10-03T10:00:00Z") });
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
    const metrics = q.get("metrics").split(",");

    if (dims.includes(",")) { combined += 1; return json(400, { error: { code: 400, message: "The query is not supported." } }); }
    if (sim.quotaOn === dims) return json(403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } });
    if (sim.refuse.has(dims)) return json(400, { error: { code: 400, message: "The query is not supported.", errors: [{ reason: "badRequest" }] } });

    const headers = [header(dims, "DIMENSION"), ...metrics.map(m => header(m))];
    const filler = metrics.map(() => 1);

    if (BREAKDOWN_ROWS[dims]) return json(200, { columnHeaders: headers, rows: BREAKDOWN_ROWS[dims] });
    if (dims === "video") return json(200, { columnHeaders: headers, rows: sim.active.map(id => [id, ...filler]) });
    if (dims === "day") {
      const id = (q.get("filters") ?? "").replace(/^video==/, "");
      const active = q.get("filters") ? sim.active.includes(id) : sim.active.length > 0;
      const rows = active ? days(q.get("startDate"), q.get("endDate")).map(d => [d, ...filler]) : [];
      return json(200, { columnHeaders: headers, ...(rows.length ? { rows } : {}) });
    }

    throw new Error(`dimension inattendue ${dims}`);
  };

  return { root, calls, sim, fetchImpl, suite: createYoutubeAnalyticsSuite({ root, env: ENV, fetchImpl, now }) };
}

const MIRROR = [
  { video_id: A, title: "Vidéo A", privacy_status: "public", published_at: "2026-09-01T10:00:00Z", mirror_status: "present" },
  { video_id: B, title: "Vidéo B", privacy_status: "unlisted", published_at: "2026-09-10T10:00:00Z", mirror_status: "present" }
];

check("répartitions : fenêtre de 28 jours et contrôle strict des colonnes", () => {
  const w = breakdownWindow(NOW);
  if (w.startDate !== "2026-09-06" || w.endDate !== "2026-10-03") throw new Error(JSON.stringify(w));
  const ok = parseBreakdown({ columnHeaders: [{ name: "deviceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["TV", 1, 2], ["MOBILE", 5, 3]] }, "deviceType");
  if (ok.map(r => r.key).join() !== "MOBILE,TV" || ok[0].watch_time_minutes !== 3) throw new Error(JSON.stringify(ok));
  for (const bad of [{ columnHeaders: [{ name: "country" }] }, { columnHeaders: [{ name: "deviceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["<x>", 1, 1]] }, { columnHeaders: [{ name: "deviceType" }, { name: "views" }, { name: "estimatedMinutesWatched" }], rows: [["TV", -1, 1]] }]) {
    let refused = false;
    try { parseBreakdown(bad, "deviceType"); } catch { refused = true; }
    if (!refused) throw new Error(`accepté : ${JSON.stringify(bad)}`);
  }
});

await asyncCheck("chaîne vide : chaîne (2 appels) + répartitions (4) + vidéos (2) = 8 appels, tout réussi", async () => {
  const ctx = setup();
  const r = await ctx.suite.sync();
  if (r.status !== "ok" || ctx.calls.length !== 8 || r.steps.channel.status !== "ok" || r.steps.breakdowns.summary.dimensions_ok !== 3 || r.steps.videos.summary.selected !== 0) throw new Error(JSON.stringify({ status: r.status, calls: ctx.calls.length }));
  if (r.summary.days_received !== 0 || r.summary.start_date !== "2026-07-06") throw new Error(JSON.stringify(r.summary));
  const files = fs.readdirSync(analyticsDir(ctx.root)).sort().join();
  if (files !== "breakdowns.json,breakdowns.jsonl,fetch.jsonl,state.json,video-fetch.jsonl,video-index.json,video-state.json") throw new Error(files);
  cleanup(ctx.root);
});

await asyncCheck("répartitions : une dimension par requête (GET, sort=-views, vues et minutes), lignes triées et plafonnées à 50", async () => {
  const ctx = setup();
  const r = await syncBreakdowns({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => NOW });
  const q = reports(ctx);
  if (r.status !== "ok" || q.map(x => x.dimensions).join() !== BREAKDOWN_DIMS.join() || q.some(x => x.metrics !== "views,estimatedMinutesWatched" || x.sort !== "-views" || x.startDate !== "2026-09-06" || x.endDate !== "2026-10-03" || x.ids !== "channel==MINE")) throw new Error(JSON.stringify(q));
  if (ctx.calls.filter(c => c.url.startsWith(REPORTS)).some(c => c.init.method !== "GET")) throw new Error("méthode");
  const b = readBreakdowns(ctx.root);
  if (b.dimensions.traffic_source.rows.map(x => x.key).join() !== "SUGGESTED,YT_SEARCH,EXT_URL" || b.dimensions.country.rows.length !== MAX_BREAKDOWN_ROWS || b.dimensions.country.rows[0].key !== "C59") throw new Error(JSON.stringify(b.dimensions.traffic_source));
  if (b.dimensions.device_type.period.from !== "2026-09-06" || b.dimensions.device_type.last_error !== null) throw new Error("période");
  cleanup(ctx.root);
});

await asyncCheck("dimension refusée (400) : notée avec le message de Google, les autres lues, l'ancienne lecture conservée", async () => {
  const ctx = setup();
  await syncBreakdowns({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => NOW });
  ctx.sim.refuse.add("deviceType");
  const r = await syncBreakdowns({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => new Date("2026-10-05T10:00:00Z") });
  const b = readBreakdowns(ctx.root);
  if (r.status !== "ok" || r.summary.dimensions_ok !== 2 || r.summary.dimensions_failed !== 1) throw new Error(JSON.stringify(r));
  const d = b.dimensions.device_type;
  if (d.status !== "ok" || d.rows.length !== 2 || d.fetched_at !== NOW.toISOString() || d.last_error.reason !== "rejected" || d.last_error.message !== "The query is not supported.") throw new Error(JSON.stringify(d));
  if (b.dimensions.country.fetched_at !== "2026-10-05T10:00:00.000Z") throw new Error("autres dimensions");
  const fresh = setup();
  fresh.sim.refuse.add("country");
  await syncBreakdowns({ root: fresh.root, env: ENV, fetchImpl: fresh.fetchImpl, now: () => NOW });
  if (readBreakdowns(fresh.root).dimensions.country.status !== "error") throw new Error("première lecture refusée");
  cleanup(ctx.root);
  cleanup(fresh.root);
});

await asyncCheck("quota pendant les répartitions : dimensions restantes non tentées, suite partielle, vidéos tout de même lues", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A];
  ctx.sim.quotaOn = "deviceType";
  const r = await ctx.suite.sync();
  if (r.status !== "partial" || r.reason !== "quota_exceeded" || r.steps.breakdowns.status !== "error" || r.steps.videos.status !== "ok" || r.steps.channel.status !== "ok") throw new Error(JSON.stringify({ status: r.status, reason: r.reason }));
  const b = readBreakdowns(ctx.root);
  if (b.dimensions.traffic_source.status !== "ok" || b.dimensions.device_type.last_error.reason !== "quota_exceeded" || b.dimensions.country.last_error.reason !== "not_attempted") throw new Error(JSON.stringify(b.dimensions));
  if (reports(ctx).some(x => x.dimensions === "country")) throw new Error("dimension tentée après le quota");
  cleanup(ctx.root);
});

await asyncCheck("cause commune (non connecté, scope absent) : aucune requête, étapes suivantes non lancées", async () => {
  const off = setup({ connected: false });
  const r = await off.suite.sync();
  if (r.status !== "error" || r.reason !== "not_connected" || off.calls.length !== 0 || r.steps.breakdowns.status !== "skipped" || r.steps.videos.status !== "skipped") throw new Error(JSON.stringify(r));
  const noScope = setup({ connected: false });
  saveConnection({ root: noScope.root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE], now: NOW });
  const s = await noScope.suite.sync();
  if (s.reason !== "scope_missing" || noScope.calls.length !== 0) throw new Error(JSON.stringify(s));
  cleanup(off.root);
  cleanup(noScope.root);
});

await asyncCheck("index par vidéo : totaux 28 jours et depuis le début, recalcul en mémoire si l'index manque", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A, B];
  await ctx.suite.sync();
  const index = JSON.parse(fs.readFileSync(path.join(analyticsDir(ctx.root), "video-index.json"), "utf8"));
  const a = index.videos[A];
  if (a.days_stored !== 90 || a.first_day !== "2026-07-06" || a.last_day !== "2026-10-03" || a.lifetime.views !== 90 || a.recent.totals.views !== 28 || a.recent.from !== "2026-09-06" || a.recent.totals.average_view_percentage !== 1 || a.recent.totals.average_view_duration_seconds !== 1) throw new Error(JSON.stringify(a));
  fs.rmSync(path.join(analyticsDir(ctx.root), "video-index.json"));
  const rebuilt = readVideoIndex(ctx.root);
  if (JSON.stringify(rebuilt.videos) !== JSON.stringify(index.videos)) throw new Error("recalcul");
  const s = videoAnalyticsSummary(ctx.root);
  if (s.videos.length !== 2 || s.videos[0].lifetime.views !== 90 || s.videos[0].published_at === null) throw new Error(JSON.stringify(s.videos[0]));
  if (JSON.stringify(buildVideoIndex(ctx.root, { now: NOW }).videos) !== JSON.stringify(index.videos)) throw new Error("construction");
  cleanup(ctx.root);
});

await asyncCheck("bouton local : la suite synchronise tout, affiche le détail des étapes et journalise (partiel compris)", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A];
  const auth = { enabled: true, returnUrl: ENV.YOUTUBE_OAUTH_RETURN_URL, status: () => ({ enabled: true, problem: null, connection: { status: "connected", connected_at: "2026-10-03T10:00:00.000Z", scopes: [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE] } }) };
  const handle = createHandler({ root: ctx.root, port: PORT, token: SESSION, youtubeAuth: auth, youtubeAnalytics: ctx.suite });
  const post = () => handle({ method: "POST", url: `/youtube/analytics/sync?t=${SESSION}`, headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  const out = await post();
  if (out.status !== 200 || !out.body.includes("Analytiques synchronisées : 90 jours reçus (2026-07-06 → 2026-10-03), 1 requête Analytics. Détail : répartitions 3/3 ; vidéos 2 synchronisée(s), 0 en échec.")) throw new Error(out.body.slice(-1500));
  if (!out.body.includes("Répartitions (28 jours)") || !out.body.includes("Sources de trafic : SUGGESTED 60") || !out.body.includes("Meilleures vidéos")) throw new Error("bloc Analytics");
  let entry = readJournal({ root: ctx.root, channelId: "nomade" }).at(-1);
  if (entry.type !== "youtube_analytics_sync" || entry.outcome !== "ok" || !/répartitions 3\/3/.test(entry.detail)) throw new Error(JSON.stringify(entry));
  ctx.sim.quotaOn = "video";
  const partial = await post();
  if (partial.status !== 200 || !partial.body.includes("Analytiques synchronisées en partie (quota_exceeded)")) throw new Error(partial.body.slice(-900));
  entry = readJournal({ root: ctx.root, channelId: "nomade" }).at(-1);
  if (entry.outcome !== "partial_quota_exceeded") throw new Error(JSON.stringify(entry));
  if ([ACCESS, REFRESH, SECRET].some(x => out.body.includes(x) || partial.body.includes(x) || JSON.stringify(readJournal({ root: ctx.root, channelId: "nomade" })).includes(x))) throw new Error("fuite");
  cleanup(ctx.root);
});

await asyncCheck("commande npm run youtube-analytics : bloc complet, affichage par étape, échec propre", async () => {
  const ctx = setup({ mirror: MIRROR });
  ctx.sim.active = [A];
  const r = await runAnalytics({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => NOW });
  const text = formatAnalytics(r);
  if (r.status !== "ok" || !text.includes("réussie") || !text.includes("Chaîne : 90 jour(s) reçus") || !text.includes("Répartitions : 3 dimension(s) lue(s)") || !text.includes("Vidéos : 2 synchronisée(s)")) throw new Error(text);
  const off = setup({ connected: false });
  const e = await runAnalytics({ root: off.root, env: ENV, fetchImpl: off.fetchImpl, now: () => NOW });
  if (e.status !== "error" || !formatAnalytics(e).includes("impossible (not_connected)") || !formatAnalytics(e).includes("Répartitions : non lancées") || off.calls.length !== 0) throw new Error(formatAnalytics(e));
  if ([ACCESS, REFRESH, SECRET].some(x => text.includes(x))) throw new Error("fuite");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (pkg.scripts["youtube-analytics"] !== "node --env-file=.env.local src/youtube-agent/youtube-analytics.js" || pkg.scripts["youtube-analytics-sync"] !== "node --env-file=.env.local src/youtube-agent/youtube-analytics-sync.js" || pkg.scripts["youtube-analytics-videos-sync"] !== "node --env-file=.env.local src/youtube-agent/youtube-analytics-videos-sync.js") throw new Error("scripts npm");
  cleanup(ctx.root);
  cleanup(off.root);
});

await asyncCheck("miroir intact et aucun appel au démarrage (startServer crée la suite sans synchroniser)", async () => {
  const ctx = setup({ mirror: MIRROR });
  const before = snapshot(mirrorDir(ctx.root));
  ctx.sim.active = [A];
  await ctx.suite.sync();
  if (snapshot(mirrorDir(ctx.root)) !== before) throw new Error("miroir modifié");
  const source = fs.readFileSync(new URL("../src/youtube-agent/server.js", import.meta.url), "utf8");
  const startup = source.slice(source.indexOf("export function startServer"));
  if (!/createYoutubeAnalyticsSuite\(\{ root \}\)/.test(startup) || /\.sync\(|youtubeAnalyticsSync/.test(startup)) throw new Error("démarrage");
  cleanup(ctx.root);
});

check("aucune requête n'a combiné deux dimensions", () => {
  if (combined !== 0) throw new Error(`${combined} requête(s)`);
});

if (networkGuard.attempts().length !== 0) check("aucune tentative réseau réelle", () => { throw new Error(`${networkGuard.attempts().length} tentatives`); });

done("youtube-agent-analytics-suite-smoke");
