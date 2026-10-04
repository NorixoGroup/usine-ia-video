// Smoke R20.5 sous-lot 4B.0 — sonde YouTube Analytics par vidéo (Google simulé).
// 1 jeton + 3 rapports (4 au plus), conclusions Q1–Q10, échecs sans appel,
// aucune écriture (arborescence identique octet pour octet), aucun secret affiché.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-analytics-probe-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import { runAnalyticsProbe, probeWindow, PROBE_METRICS, MAX_PROBE_REQUESTS } from "../src/youtube-agent/connectors/youtube/analytics-probe.js";
import { formatProbe } from "../src/youtube-agent/youtube-analytics-probe.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 5);
const SECRET = "test-client-secret-probe";
const REFRESH = "test-refresh-token-probe";
const ACCESS = "test-access-token-probe";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
const NOW = new Date("2026-10-04T10:00:00Z");
const PUBLIC = "aaaaaaaaaaa";
const PRIVATE = "bbbbbbbbbbb";
const UNLISTED = "ccccccccccc";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const header = (name, columnType, dataType) => ({ name, columnType, dataType });
const metricHeaders = list => list.split(",").map(m => header(m, "METRIC", m.startsWith("average") ? "FLOAT" : "INTEGER"));

// Arborescence complète (chemins et contenus) : la sonde ne doit rien y changer.
function tree(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

// Google simulé. `channel` décrit les vidéos ayant des données ; `refuse` liste les requêtes refusées.
function setup({ connected = true, scopes = [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE], channel = [], refuse = [], mirror = null, failNetworkOn = null } = {}) {
  const root = tmpRoot("probe");
  const calls = [];

  if (connected) saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes, now: new Date("2026-10-03T10:00:00Z") });
  if (mirror) {
    const dir = path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "videos.json"), JSON.stringify({ schema: "youtube-agent.mirror.v1", videos: mirror }));
  }

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });

    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
    if (!url.startsWith(`${REPORTS}?`)) throw new Error(`appel inattendu ${url}`);

    const q = new URL(url).searchParams;
    const dims = q.get("dimensions");
    const metrics = q.get("metrics");

    if (failNetworkOn === dims) throw new TypeError("fetch failed");
    if (refuse.includes(dims) || (refuse.includes("9metrics") && dims === "video" && metrics.includes(","))) {
      return json(400, { error: { code: 400, message: "The query is not supported.", errors: [{ reason: "badRequest", message: "The query is not supported." }] } });
    }

    const columnHeaders = [...dims.split(",").map(d => header(d, "DIMENSION", "STRING")), ...metricHeaders(metrics)];
    const values = metrics.split(",").map(() => 1);
    let rows;

    if (dims === "video") rows = channel.map(id => [id, ...values]);
    else rows = channel.length ? ["2026-09-20", "2026-09-21", "2026-10-03"].map(d => [d, ...values]) : [];

    return json(200, { kind: "youtubeAnalytics#resultTable", columnHeaders, ...(rows.length ? { rows } : {}) });
  };

  return { root, calls, fetchImpl, run: (env = ENV) => runAnalyticsProbe({ root, env, fetchImpl, now: () => NOW }) };
}

const MIRROR = [
  { video_id: PUBLIC, privacy_status: "public", mirror_status: "present" },
  { video_id: PRIVATE, privacy_status: "private", mirror_status: "present" },
  { video_id: UNLISTED, privacy_status: "unlisted", mirror_status: "present" }
];

check("fenêtre : 28 jours jusqu'à la veille", () => {
  const w = probeWindow(NOW);
  if (w.startDate !== "2026-09-06" || w.endDate !== "2026-10-03") throw new Error(JSON.stringify(w));
});

await asyncCheck("chaîne vide : 1 jeton + 3 rapports GET, aucun R4, Q7 « rows absent », aucune écriture", async () => {
  const ctx = setup();
  const before = tree(ctx.root);
  const r = await ctx.run();
  if (r.status !== "ok" || r.calls !== 4 || r.analytics_requests !== 3 || r.requests.length !== 3) throw new Error(JSON.stringify({ calls: r.calls, n: r.requests.length }));
  if (ctx.calls.filter(c => c.url.startsWith(REPORTS)).some(c => c.init.method !== "GET")) throw new Error("méthode");
  const [r1, r2, r3] = r.requests.map(x => x.params);
  if (r1.dimensions !== "video" || r1.sort !== "-views" || r1.maxResults !== "200" || r1.metrics !== PROBE_METRICS.join(",") || r1.ids !== "channel==MINE") throw new Error(JSON.stringify(r1));
  if (r2.dimensions !== "video" || r2.startDate !== "2026-10-03" || r2.endDate !== "2026-10-03" || r3.dimensions !== "day" || r3.filters !== undefined) throw new Error("paramètres");
  if (r.conclusions.q7_no_video?.rows_field_r1 !== "absent" || r.conclusions.q7_no_video.row_count_r1 !== 0) throw new Error(JSON.stringify(r.conclusions.q7_no_video));
  if (r.conclusions.q4_days.subject !== "chaîne" || r.conclusions.q4_days.returned !== 0 || r.conclusions.q4_days.missing !== 28) throw new Error(JSON.stringify(r.conclusions.q4_days));
  if (tree(ctx.root) !== before) throw new Error("écriture");
  cleanup(ctx.root);
});

await asyncCheck("chaîne avec vidéos : jamais jour et vidéo dans une même requête, métriques confirmées, jours manquants, privées et non répertoriées comptées", async () => {
  const ctx = setup({ channel: [PUBLIC, PRIVATE], mirror: MIRROR });
  const before = tree(ctx.root);
  const r = await ctx.run();
  const c = r.conclusions;
  if (r.calls !== 4 || c.q1_video_single_day !== "accepté" || "q1_day_and_video" in c) throw new Error(JSON.stringify(c));
  if (ctx.calls.some(x => x.url.startsWith(REPORTS) && new URL(x.url).searchParams.get("dimensions").includes(","))) throw new Error("dimensions combinées");
  if (c.q3_metrics.length !== 9 || c.q3_metrics.some(m => m.with_video !== "disponible" || m.with_video_filter !== "disponible")) throw new Error(JSON.stringify(c.q3_metrics));
  if (r.requests[2].params.filters !== `video==${PUBLIC}` || c.q4_days.returned !== 3 || c.q4_days.missing !== 25) throw new Error(JSON.stringify(c.q4_days));
  if (c.q5_private.returned !== 1 || c.q6_unlisted.returned !== 0 || c.q6_unlisted.in_mirror !== 1 || c.q6_unlisted.in_mirror_not_returned !== 1 || c.public.returned !== 1) throw new Error(JSON.stringify(c));
  const a = r.requests[0].analysis;
  if (a.kind !== "youtubeAnalytics#resultTable" || a.rows_field !== "tableau" || a.headers[0].name !== "video" || a.headers[0].columnType !== "DIMENSION" || a.sample_rows.length !== 2) throw new Error(JSON.stringify(a));
  if (tree(ctx.root) !== before) throw new Error("écriture");
  cleanup(ctx.root);
});

await asyncCheck("R1 refusée : R4 (views seule) est lancée, jamais plus de 4 requêtes", async () => {
  const ctx = setup({ channel: [PUBLIC], refuse: ["9metrics"], mirror: MIRROR });
  const r = await ctx.run();
  if (r.requests.length !== MAX_PROBE_REQUESTS || MAX_PROBE_REQUESTS !== 4 || r.calls !== 5 || r.requests[3].params.metrics !== "views" || !r.requests[3].ok) throw new Error(JSON.stringify({ n: r.requests.length, calls: r.calls }));
  if (r.requests[0].error.code !== 400 || r.requests[0].error.reasons.join() !== "badRequest" || !/not supported/.test(r.requests[0].error.message)) throw new Error(JSON.stringify(r.requests[0].error));
  if (r.conclusions.q3_metrics[0].with_video !== "disponible (R4)" || r.conclusions.q3_metrics[1].with_video !== "non confirmée") throw new Error(JSON.stringify(r.conclusions.q3_metrics.slice(0, 2)));
  if (r.requests[2].params.filters !== `video==${PUBLIC}`) throw new Error("vidéo du miroir non utilisée");
  cleanup(ctx.root);
});

await asyncCheck("échec réseau sur une requête : noté, la sonde continue", async () => {
  const ctx = setup({ failNetworkOn: "day" });
  const r = await ctx.run();
  if (r.status !== "ok" || r.requests[2].failure !== "network" || r.requests.length !== 3 || r.conclusions.q4_days !== null) throw new Error(JSON.stringify(r.requests[2]));
  cleanup(ctx.root);
});

await asyncCheck("sans configuration, sans connexion ou sans scope Analytics : aucun appel, aucune écriture", async () => {
  for (const [opts, env, reason] of [[{}, {}, "not_configured"], [{ connected: false }, ENV, "not_connected"], [{ scopes: [YOUTUBE_READONLY_SCOPE] }, ENV, "scope_missing"]]) {
    const ctx = setup(opts);
    const before = tree(ctx.root);
    const r = await ctx.run(env);
    if (r.status !== "error" || r.reason !== reason || ctx.calls.length !== 0 || r.calls !== 0 || r.requests.length !== 0) throw new Error(`${reason} : ${JSON.stringify(r)}`);
    if (!formatProbe(r).includes(`Sonde impossible : ${reason}`)) throw new Error("affichage");
    if (tree(ctx.root) !== before) throw new Error("écriture");
    cleanup(ctx.root);
  }
});

await asyncCheck("affichage : requêtes, colonnes, erreurs, Q1–Q10, coût et temps ; aucun secret ni jeton", async () => {
  const ctx = setup({ channel: [PUBLIC, PRIVATE], refuse: ["9metrics"], mirror: MIRROR });
  const r = await ctx.run();
  const text = formatProbe(r);
  for (const part of ["R1 dimension video", "HTTP 400 · refusée", "raisons badRequest", "Colonnes : video (DIMENSION, STRING)", "Q1 dimension video sur un seul jour : refusé", "Q4 jours sans données", "Q5 vidéos privées : 1 renvoyée(s)", "Q6 vidéos non répertoriées : 0 renvoyée(s)", "Q8 appels Google : 5 (dont 4 requête(s) Analytics et 1 échange de jeton)", "Q9 temps", "Q10 coût : 0 $", "Aucune donnée n'a été écrite."]) {
    if (!text.includes(part)) throw new Error(`absent : ${part}`);
  }
  if ([ACCESS, REFRESH, SECRET].some(x => text.includes(x) || JSON.stringify(r).includes(x))) throw new Error("fuite");
  cleanup(ctx.root);
});

check("commande npm run youtube-analytics-probe et absence de déclenchement automatique", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (pkg.scripts["youtube-analytics-probe"] !== "node --env-file=.env.local src/youtube-agent/youtube-analytics-probe.js") throw new Error("script npm");
  const server = fs.readFileSync(new URL("../src/youtube-agent/server.js", import.meta.url), "utf8");
  const agent = fs.readFileSync(new URL("../src/youtube-agent/agent.js", import.meta.url), "utf8");
  if (/probe/i.test(server) || /probe/i.test(agent)) throw new Error("sonde branchée sur l'agent");
});

if (networkGuard.attempts().length !== 0) check("aucune tentative réseau réelle", () => { throw new Error(`${networkGuard.attempts().length} tentatives`); });

done("youtube-agent-analytics-probe-smoke");
