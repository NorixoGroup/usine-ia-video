// Smoke R20.5 lot 4A — analytiques quotidiennes de la chaîne (Google simulé).
// Première lecture de 90 jours, fichiers mensuels, relecture des 7 derniers jours,
// historique conservé, état et journal des rapports, échecs sans perte, bail exclusif,
// miroir intact, aucun appel au démarrage, bouton local, commande, pont inchangé.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-analytics-sync-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import { createYoutubeAnalytics, analyticsWindow, readDailyMetrics, readAnalyticsState, readFetchLog, ANALYTICS_METRICS } from "../src/youtube-agent/connectors/youtube/analytics.js";
import { createYoutubeChannel } from "../src/youtube-agent/connectors/youtube/channel.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createBridgeHandler } from "../src/youtube-agent/agent-api.js";
import { createHandler } from "../src/youtube-agent/server.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { runAnalyticsSync } from "../src/youtube-agent/youtube-analytics-sync.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 9);
const SECRET = "test-client-secret-analytics";
const REFRESH = "test-refresh-token-analytics";
const ACCESS = "test-access-token-analytics";
const BRIDGE = "bridge-token-0123456789abcdef0123456789abcdef";
const SESSION = "s".repeat(64);
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
const API_METRICS = ANALYTICS_METRICS.map(([api]) => api);
const HEADERS = [{ name: "day" }, ...API_METRICS.map(name => ({ name }))];
const NOW = new Date("2026-10-04T10:00:00Z");

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const analyticsDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "analytics");
const mirrorDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");
const days = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const snapshot = dir => fs.existsSync(dir) ? Object.fromEntries(fs.readdirSync(dir).sort().map(f => [f, fs.readFileSync(path.join(dir, f), "utf8")])) : {};

// Google simulé : un rapport par jour demandé ; `views` est réglable pour simuler les révisions.
function setup({ connected = true, scopes = [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE], now = () => NOW } = {}) {
  const root = tmpRoot("analytics");
  const calls = [];
  const sim = { views: 10, failWith: null, report: null };

  if (connected) saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes, now: new Date("2026-10-03T10:00:00Z") });

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });

    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
    if (url.startsWith(`${REPORTS}?`)) {
      if (sim.failWith === "network") throw new TypeError("fetch failed");
      if (sim.failWith) return json(sim.failWith.status, sim.failWith.body);
      if (sim.report) return json(200, sim.report);

      const u = new URL(url);
      const rows = days(u.searchParams.get("startDate"), u.searchParams.get("endDate")).map(day => [day, sim.views, 30, 120, 45.5, 2, 1, 3, 1, 0]);

      return json(200, { kind: "youtubeAnalytics#resultTable", columnHeaders: HEADERS, rows });
    }

    throw new Error(`appel inattendu ${url}`);
  };

  const analytics = createYoutubeAnalytics({ root, env: ENV, fetchImpl, now });

  return { root, calls, sim, fetchImpl, analytics };
}

const reportCalls = ctx => ctx.calls.filter(c => c.url.startsWith(`${REPORTS}?`));

check("fenêtre : 90 jours jusqu'à la veille, puis relecture des 7 derniers jours lus", () => {
  const first = analyticsWindow({ now: NOW, state: null });
  if (first.startDate !== "2026-07-06" || first.endDate !== "2026-10-03") throw new Error(JSON.stringify(first));
  const next = analyticsWindow({ now: new Date("2026-10-06T10:00:00Z"), state: { last_end_date: "2026-10-03" } });
  if (next.startDate !== "2026-09-27" || next.endDate !== "2026-10-05") throw new Error(JSON.stringify(next));
  const same = analyticsWindow({ now: NOW, state: { last_end_date: "2026-10-03" } });
  if (same.startDate !== "2026-09-27" || same.endDate !== "2026-10-03") throw new Error(JSON.stringify(same));
});

await asyncCheck("première synchronisation : 1 jeton + 1 rapport GET, paramètres et 9 métriques, aucun revenu ni impression", async () => {
  const ctx = setup();
  const r = await ctx.analytics.sync();
  if (r.status !== "ok" || r.summary.days_received !== 90 || r.summary.calls !== 2 || r.summary.analytics_requests !== 1) throw new Error(JSON.stringify(r));
  const reports = reportCalls(ctx);
  if (ctx.calls.length !== 2 || reports.length !== 1 || reports[0].init.method !== "GET") throw new Error("appels");
  const u = new URL(reports[0].url);
  if (u.searchParams.get("ids") !== "channel==MINE" || u.searchParams.get("dimensions") !== "day" || u.searchParams.get("sort") !== "day" || u.searchParams.get("startDate") !== "2026-07-06" || u.searchParams.get("endDate") !== "2026-10-03") throw new Error(u.search);
  if (u.searchParams.get("metrics") !== "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares") throw new Error(u.searchParams.get("metrics"));
  if (/revenue|cpm|impression|monetiz/i.test(u.search)) throw new Error("métrique hors périmètre");
  if (reports[0].init.headers.authorization !== `Bearer ${ACCESS}`) throw new Error("jeton d'accès");
  cleanup(ctx.root);
});

await asyncCheck("stockage : fichiers mensuels (juillet → octobre), un enregistrement par jour, permissions et aucun temporaire", async () => {
  const ctx = setup();
  await ctx.analytics.sync();
  const files = fs.readdirSync(analyticsDir(ctx.root)).sort();
  if (files.join() !== "channel-daily-2026-07.json,channel-daily-2026-08.json,channel-daily-2026-09.json,channel-daily-2026-10.json,fetch.jsonl,state.json") throw new Error(files.join());
  const july = JSON.parse(fs.readFileSync(path.join(analyticsDir(ctx.root), "channel-daily-2026-07.json"), "utf8"));
  if (july.schema !== "youtube-agent.analytics.v1" || july.month !== "2026-07" || Object.keys(july.days).length !== 26) throw new Error(JSON.stringify(Object.keys(july.days).length));
  const d = july.days["2026-07-06"];
  if (Object.keys(d).sort().join() !== "average_view_duration_seconds,average_view_percentage,comments,fetched_at,likes,shares,subscribers_gained,subscribers_lost,views,watch_time_minutes") throw new Error(Object.keys(d).join());
  if (d.views !== 10 || d.watch_time_minutes !== 30 || d.average_view_percentage !== 45.5 || d.subscribers_lost !== 1) throw new Error(JSON.stringify(d));
  if (process.platform !== "win32" && (fs.statSync(path.join(analyticsDir(ctx.root), "state.json")).mode & 0o077) !== 0) throw new Error("permissions");
  if (readDailyMetrics(ctx.root).length !== 90) throw new Error("lecture");
  cleanup(ctx.root);
});

await asyncCheck("relecture : seuls les 7 derniers jours sont redemandés et remplacés, l'historique antérieur est conservé", async () => {
  let now = NOW;
  const ctx = setup({ now: () => now });
  await ctx.analytics.sync();
  ctx.sim.views = 99;
  now = new Date("2026-10-06T10:00:00Z");
  const r = await ctx.analytics.sync();
  if (r.status !== "ok" || r.summary.start_date !== "2026-09-27" || r.summary.end_date !== "2026-10-05" || r.summary.days_received !== 9) throw new Error(JSON.stringify(r.summary));
  const all = readDailyMetrics(ctx.root);
  if (all.length !== 92 || all[0].day !== "2026-07-06" || all.at(-1).day !== "2026-10-05") throw new Error(`${all.length}`);
  const byDay = Object.fromEntries(all.map(x => [x.day, x]));
  if (byDay["2026-09-26"].views !== 10 || byDay["2026-09-27"].views !== 99 || byDay["2026-10-03"].views !== 99) throw new Error("révision");
  if (byDay["2026-09-26"].fetched_at !== NOW.toISOString() || byDay["2026-09-27"].fetched_at !== now.toISOString()) throw new Error("fetched_at");
  cleanup(ctx.root);
});

await asyncCheck("state.json, fetch.jsonl et résumé sur 28 jours (sans appel réseau)", async () => {
  const ctx = setup();
  await ctx.analytics.sync();
  await ctx.analytics.sync();
  const state = readAnalyticsState(ctx.root);
  if (state.sync_count !== 2 || state.last_error !== null || state.last_end_date !== "2026-10-03" || state.months.join() !== "2026-07,2026-08,2026-09,2026-10" || state.last_summary.days_received !== 7) throw new Error(JSON.stringify(state));
  const log = readFetchLog(ctx.root);
  if (log.length !== 2 || log[0].days_received !== 90 || log[1].days_received !== 7 || log[1].analytics_requests !== 1) throw new Error(JSON.stringify(log));
  const before = ctx.calls.length;
  const s = ctx.analytics.summary();
  if (ctx.calls.length !== before) throw new Error("appel au résumé");
  if (s.status !== "ok" || s.data_until !== "2026-10-03" || s.period.from !== "2026-09-06" || s.period.days_with_data !== 28 || s.days_stored !== 90) throw new Error(JSON.stringify(s));
  if (s.totals.views !== 280 || s.totals.watch_time_minutes !== 840 || s.totals.subscribers_net !== 28 || s.totals.likes !== 84 || s.totals.comments !== 28 || s.totals.shares !== 0 || s.totals.average_view_percentage !== 45.5) throw new Error(JSON.stringify(s.totals));
  cleanup(ctx.root);
});

await asyncCheck("chaîne sans données (rows absent) : succès, 0 jour, pourcentage « sans objet »", async () => {
  const ctx = setup();
  ctx.sim.report = { columnHeaders: HEADERS };
  const r = await ctx.analytics.sync();
  if (r.status !== "ok" || r.summary.days_received !== 0) throw new Error(JSON.stringify(r));
  const s = ctx.analytics.summary();
  if (s.status !== "ok" || s.days_stored !== 0 || s.totals.views !== 0 || s.totals.average_view_percentage !== null) throw new Error(JSON.stringify(s));
  cleanup(ctx.root);
});

await asyncCheck("échecs sans configuration, sans connexion ou sans scope Analytics : aucun appel", async () => {
  const noConfig = setup();
  const a = await createYoutubeAnalytics({ root: noConfig.root, env: {}, fetchImpl: noConfig.fetchImpl, now: () => NOW }).sync();
  if (a.status !== "error" || a.reason !== "not_configured" || noConfig.calls.length !== 0) throw new Error(JSON.stringify(a));
  const disconnected = setup({ connected: false });
  const b = await disconnected.analytics.sync();
  if (b.status !== "error" || b.reason !== "not_connected" || disconnected.calls.length !== 0) throw new Error(JSON.stringify(b));
  const noScope = setup({ scopes: [YOUTUBE_READONLY_SCOPE] });
  const c = await noScope.analytics.sync();
  if (c.status !== "error" || c.reason !== "scope_missing" || noScope.calls.length !== 0) throw new Error(JSON.stringify(c));
  if (noScope.analytics.summary().status !== "error" || readAnalyticsState(noScope.root).last_error.reason !== "scope_missing") throw new Error("état d'erreur");
  for (const ctx of [noConfig, disconnected, noScope]) cleanup(ctx.root);
});

await asyncCheck("échecs Google (quota, autorisation, en-têtes inattendus, valeurs invalides, réseau) : données précédentes intactes", async () => {
  const cases = [
    [{ status: 403, body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } } }, "quota_exceeded"],
    [{ status: 401, body: { error: { code: 401 } } }, "unauthorized"],
    ["headers", "incomplete"],
    ["values", "incomplete"],
    ["network", "network"]
  ];
  for (const [failure, reason] of cases) {
    const ctx = setup();
    await ctx.analytics.sync();
    const before = snapshot(analyticsDir(ctx.root));
    if (failure === "headers") ctx.sim.report = { columnHeaders: [{ name: "day" }, { name: "views" }], rows: [["2026-10-03", 1]] };
    else if (failure === "values") ctx.sim.report = { columnHeaders: HEADERS, rows: [["2026-10-03", -1, 0, 0, 0, 0, 0, 0, 0, 0]] };
    else ctx.sim.failWith = failure;
    const r = await ctx.analytics.sync();
    if (r.status !== "error" || r.reason !== reason) throw new Error(`${reason} : ${JSON.stringify(r)}`);
    const after = snapshot(analyticsDir(ctx.root));
    for (const f of Object.keys(before)) if (f !== "state.json" && before[f] !== after[f]) throw new Error(`${reason} : ${f} modifié`);
    const state = readAnalyticsState(ctx.root);
    if (state.last_error.reason !== reason || state.sync_count !== 1 || state.last_end_date !== "2026-10-03") throw new Error(JSON.stringify(state));
    const s = ctx.analytics.summary();
    if (s.status !== "ok" || s.last_error.reason !== reason || s.days_stored !== 90) throw new Error(JSON.stringify(s));
    if (Object.keys(after).some(f => f.includes(".tmp") || f.endsWith(".lock") || f === "sync.lease")) throw new Error("résidu");
    cleanup(ctx.root);
  }
});

await asyncCheck("bail exclusif (sync_in_progress, aucun appel) et une seule synchronisation à la fois dans le processus", async () => {
  const ctx = setup();
  fs.mkdirSync(analyticsDir(ctx.root), { recursive: true });
  fs.writeFileSync(path.join(analyticsDir(ctx.root), "sync.lease"), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
  const r = await ctx.analytics.sync();
  if (r.status !== "error" || r.reason !== "sync_in_progress" || ctx.calls.length !== 0) throw new Error(JSON.stringify(r));
  fs.rmSync(path.join(analyticsDir(ctx.root), "sync.lease"));
  const [a, b] = await Promise.all([ctx.analytics.sync(), ctx.analytics.sync()]);
  if (a !== b || a.status !== "ok" || reportCalls(ctx).length !== 1) throw new Error("synchronisations concurrentes");
  if (fs.existsSync(path.join(analyticsDir(ctx.root), "sync.lease"))) throw new Error("bail résiduel");
  cleanup(ctx.root);
});

await asyncCheck("miroir YouTube intact : aucun fichier du miroir créé ni modifié, miroir lu identique", async () => {
  const ctx = setup();
  fs.mkdirSync(mirrorDir(ctx.root), { recursive: true });
  fs.writeFileSync(path.join(mirrorDir(ctx.root), "channel.json"), JSON.stringify({ marker: "miroir" }));
  const before = snapshot(mirrorDir(ctx.root));
  await ctx.analytics.sync();
  ctx.sim.failWith = "network";
  await ctx.analytics.sync();
  if (JSON.stringify(snapshot(mirrorDir(ctx.root))) !== JSON.stringify(before)) throw new Error("miroir modifié");
  cleanup(ctx.root);
});

await asyncCheck("démarrage de l'agent : aucune lecture Analytics (startServer crée le lecteur sans synchroniser)", async () => {
  const source = fs.readFileSync(new URL("../src/youtube-agent/server.js", import.meta.url), "utf8");
  const startup = source.slice(source.indexOf("export function startServer"));
  if (!/createYoutubeAnalytics\(\{ root \}\)/.test(startup) || /\.sync\(|youtubeAnalyticsSync/.test(startup)) throw new Error("synchronisation au démarrage");
  if ((source.match(/youtubeAnalyticsSync\(/g) ?? []).length !== 1) throw new Error("déclencheurs inattendus");
  const ctx = setup();
  const agent = createYouTubeAgent({ root: ctx.root, youtubeAnalytics: ctx.analytics });
  if (agent.youtubeAnalytics().status !== "not_loaded" || ctx.calls.length !== 0) throw new Error("lecture au démarrage");
  if (createYouTubeAgent({ root: ctx.root }).youtubeAnalytics().status !== "not_loaded") throw new Error("sans lecteur");
  cleanup(ctx.root);
});

await asyncCheck("bouton local : « non lues » et bouton ; POST sans Origin refusé ; POST synchronise, affiche le résultat et journalise", async () => {
  const ctx = setup();
  const auth = { enabled: true, returnUrl: ENV.YOUTUBE_OAUTH_RETURN_URL, status: () => ({ enabled: true, problem: null, connection: { status: "connected", connected_at: "2026-10-03T10:00:00.000Z", scopes: [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE] } }) };
  const youtubeChannel = createYoutubeChannel({ root: ctx.root, env: ENV, fetchImpl: () => { throw new Error("aucun appel attendu au miroir"); } });
  const handle = createHandler({ root: ctx.root, port: PORT, token: SESSION, youtubeAuth: auth, youtubeChannel, youtubeAnalytics: ctx.analytics });
  const host = { host: `127.0.0.1:${PORT}` };
  const page = handle({ method: "GET", url: `/?t=${SESSION}`, headers: host });
  if (!page.body.includes("Analytiques de la chaîne") || !page.body.includes("Non lues : aucune synchronisation n'a encore été faite.") || !page.body.includes(`action="/youtube/analytics/sync?t=${SESSION}"`) || ctx.calls.length !== 0) throw new Error("page initiale");
  const refused = handle({ method: "POST", url: `/youtube/analytics/sync?t=${SESSION}`, headers: { ...host, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (refused.status !== 403 || ctx.calls.length !== 0) throw new Error("POST sans Origin accepté");
  const get = handle({ method: "GET", url: `/youtube/analytics/sync?t=${SESSION}`, headers: host });
  if (get.status === 200 || ctx.calls.length !== 0) throw new Error("GET accepté");
  const out = await handle({ method: "POST", url: `/youtube/analytics/sync?t=${SESSION}`, headers: { ...host, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (out.status !== 200 || !out.body.includes("Analytiques synchronisées : 90 jours reçus (2026-07-06 → 2026-10-03)") || !out.body.includes("Données jusqu'au 2026-10-03 (fuseau du Pacifique)") || !out.body.includes("280 vue(s)")) throw new Error(out.body.slice(-1200));
  const journal = readJournal({ root: ctx.root, channelId: "nomade" });
  if (journal.at(-1)?.type !== "youtube_analytics_sync" || journal.at(-1).outcome !== "ok" || !/90 jours/.test(journal.at(-1).detail)) throw new Error(JSON.stringify(journal.at(-1)));
  ctx.sim.failWith = { status: 403, body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } } };
  const failed = await handle({ method: "POST", url: `/youtube/analytics/sync?t=${SESSION}`, headers: { ...host, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (failed.status !== 502 || !failed.body.includes("Synchronisation des analytiques impossible (quota_exceeded)") || !failed.body.includes("données précédentes conservées")) throw new Error(failed.body.slice(-900));
  if (readJournal({ root: ctx.root, channelId: "nomade" }).at(-1).outcome !== "quota_exceeded") throw new Error("journal de l'échec");
  if ([ACCESS, REFRESH, SECRET].some(x => out.body.includes(x) || failed.body.includes(x) || JSON.stringify(readJournal({ root: ctx.root, channelId: "nomade" })).includes(x))) throw new Error("fuite");
  const noReader = createHandler({ root: ctx.root, port: PORT, token: SESSION, youtubeAuth: auth });
  const unavailable = await noReader({ method: "POST", url: `/youtube/analytics/sync?t=${SESSION}`, headers: { ...host, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (unavailable.status !== 503) throw new Error(`${unavailable.status}`);
  cleanup(ctx.root);
});

await asyncCheck("commande npm run youtube-analytics-sync (runAnalyticsSync) : synchronise, journalise, échec propre sans connexion", async () => {
  const ctx = setup();
  const r = await runAnalyticsSync({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => NOW });
  if (r.status !== "ok" || r.summary.days_received !== 90 || readJournal({ root: ctx.root, channelId: "nomade" }).at(-1).type !== "youtube_analytics_sync") throw new Error(JSON.stringify(r));
  const disconnected = setup({ connected: false });
  const e = await runAnalyticsSync({ root: disconnected.root, env: ENV, fetchImpl: disconnected.fetchImpl, now: () => NOW });
  if (e.status !== "error" || e.reason !== "not_connected" || disconnected.calls.length !== 0) throw new Error(JSON.stringify(e));
  if (readJournal({ root: disconnected.root, channelId: "nomade" }).at(-1).outcome !== "not_connected") throw new Error("journal de l'échec");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (pkg.scripts["youtube-analytics-sync"] !== "node --env-file=.env.local src/youtube-agent/youtube-analytics-sync.js") throw new Error("script npm");
  cleanup(ctx.root);
  cleanup(disconnected.root);
});

await asyncCheck("pont : route analytics inchangée (not_connected) et aucun secret, même après synchronisation", async () => {
  const ctx = setup();
  await ctx.analytics.sync();
  const before = ctx.calls.length;
  const agent = createYouTubeAgent({ root: ctx.root, youtubeAnalytics: ctx.analytics });
  const out = createBridgeHandler({ agent, port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/analytics", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  const reference = createBridgeHandler({ agent: createYouTubeAgent({ root: tmpRoot("analytics-ref") }), port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/analytics", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  if (out.status !== 200 || JSON.stringify(JSON.parse(out.body).data) !== JSON.stringify(JSON.parse(reference.body).data)) throw new Error(out.body);
  if (ctx.calls.length !== before || [ACCESS, REFRESH, SECRET].some(x => out.body.includes(x))) throw new Error("appel ou fuite");
  cleanup(ctx.root);
});

await asyncCheck("aucun secret dans la partition analytics", async () => {
  const ctx = setup();
  await ctx.analytics.sync();
  const all = Object.values(snapshot(analyticsDir(ctx.root))).join("\n");
  if ([ACCESS, REFRESH, SECRET].some(x => all.includes(x)) || /access_token|refresh_token|client_secret/.test(all)) throw new Error("fuite");
  cleanup(ctx.root);
});

if (networkGuard.attempts().length !== 0) check("aucune tentative réseau réelle", () => { throw new Error(`${networkGuard.attempts().length} tentatives`); });

done("youtube-agent-analytics-sync-smoke");
