// Smoke R20.1 — identité de la chaîne (Google simulé) : échange du refresh token,
// channels.list (mine=true), chaîne vide nominale, erreurs, aucune fuite, aucun autre endpoint.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-channel-smoke.js

import fs from "node:fs";
import path from "node:path";

import { createYoutubeChannel } from "../src/youtube-agent/connectors/youtube/channel.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createBridgeHandler } from "../src/youtube-agent/agent-api.js";
import { createHandler } from "../src/youtube-agent/server.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 7);
const SECRET = "test-client-secret-channel";
const REFRESH = "test-refresh-token-channel";
const ACCESS = "test-access-token-channel";
const BRIDGE = "bridge-token-0123456789abcdef0123456789abcdef";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const CHANNELS = "https://www.googleapis.com/youtube/v3/channels";
// R20.2 : la lecture de la chaîne enchaîne sur ses vidéos (couverte par youtube-agent-videos-smoke.js).
const PLAYLIST_ITEMS = "https://www.googleapis.com/youtube/v3/playlistItems";
const NOW = new Date("2026-10-03T10:00:00Z");

const ITEM = {
  id: "UCabcdefghijklmnopqrstuv",
  snippet: {
    title: "Les Découvertes du Nomade",
    description: "Voyages",
    country: "FR",
    thumbnails: { default: { url: "https://yt3.ggpht.com/d.jpg" }, high: { url: "https://yt3.ggpht.com/h.jpg" } }
  },
  statistics: { viewCount: "0", subscriberCount: "3", hiddenSubscriberCount: false, videoCount: "0" },
  contentDetails: { relatedPlaylists: { likes: "", uploads: "UUabcdefghijklmnopqrstuv" } }
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const all = [];

function setup({ token = () => json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" }), channels = () => json(200, { items: [ITEM] }), videos = () => json(200, { items: [] }), connected = true, env = ENV } = {}) {
  const root = tmpRoot("channel");
  const calls = [];

  if (connected) saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE], now: NOW });

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    all.push(url);

    if (url === GOOGLE_TOKEN_ENDPOINT) return token(init);
    if (url.startsWith(`${CHANNELS}?`)) return channels(init);
    if (url.startsWith(`${PLAYLIST_ITEMS}?`)) return videos(init);

    throw new Error(`endpoint inattendu : ${url}`);
  };

  return { root, calls, yt: createYoutubeChannel({ root, env, fetchImpl, now: () => NOW }) };
}

const files = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const results = [];
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };

await asyncCheck("succès : refresh token → access token → channels.list, données attendues", async () => {
  const ctx = setup();
  if (ctx.yt.current().status !== "not_loaded") throw new Error("état initial");
  const r = await ctx.yt.refresh();
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  const c = r.channel;
  if (c.channel_id !== ITEM.id || c.title !== ITEM.snippet.title || c.country !== "FR" || c.thumbnail_url !== "https://yt3.ggpht.com/h.jpg") throw new Error("identité");
  if (c.subscriber_count !== 3 || c.video_count !== 0 || c.view_count !== 0 || c.related_playlists.uploads !== "UUabcdefghijklmnopqrstuv" || c.description !== "Voyages") throw new Error("statistiques");
  if (ctx.calls.length !== 3) throw new Error(`${ctx.calls.length} appels`);
  const [t, y] = ctx.calls;
  const body = Object.fromEntries(new URLSearchParams(t.init.body));
  if (t.init.method !== "POST" || body.grant_type !== "refresh_token" || body.refresh_token !== REFRESH || body.client_id !== ENV.YOUTUBE_OAUTH_CLIENT_ID) throw new Error("échange");
  const u = new URL(y.url);
  if (y.init.method !== "GET" || y.init.headers.authorization !== `Bearer ${ACCESS}` || u.searchParams.get("part") !== "snippet,statistics,contentDetails" || u.searchParams.get("mine") !== "true" || [...u.searchParams.keys()].length !== 2) throw new Error("channels.list");
  results.push(ctx);
});

await asyncCheck("chaîne vide (videoCount = 0) : cas nominal, aucune erreur", async () => {
  const ctx = setup({ channels: () => json(200, { items: [{ ...ITEM, statistics: { viewCount: "0", subscriberCount: "0", hiddenSubscriberCount: false, videoCount: "0" } }] }) });
  const r = await ctx.yt.refresh();
  if (r.status !== "ok" || r.channel.video_count !== 0 || r.channel.subscriber_count !== 0 || "reason" in r) throw new Error(JSON.stringify(r));
  cleanup(ctx.root);
});

await asyncCheck("variantes tolérées : pays absent, abonnés masqués, miniature unique", async () => {
  const snippet = { title: "X", thumbnails: { default: { url: "https://yt3.ggpht.com/d.jpg" } } };
  const ctx = setup({ channels: () => json(200, { items: [{ id: "UCx", snippet, statistics: { viewCount: "5", hiddenSubscriberCount: true, videoCount: "0" } }] }) });
  const r = await ctx.yt.refresh();
  if (r.status !== "ok" || r.channel.country !== null || r.channel.subscriber_count !== null || r.channel.thumbnail_url !== "https://yt3.ggpht.com/d.jpg" || Object.keys(r.channel.related_playlists).length !== 0) throw new Error(JSON.stringify(r));
  cleanup(ctx.root);
});

await asyncCheck("erreurs propagées proprement, sans exception ni détail", async () => {
  const cases = [
    ["token_revoked", { token: () => json(400, { error: "invalid_grant", error_description: REFRESH }) }],
    ["token_refused", { token: () => json(401, { error: "invalid_client" }) }],
    ["upstream", { token: () => json(503, { error: "x" }) }],
    ["unauthorized", { channels: () => json(401, { error: { code: 401, errors: [{ reason: "authError" }] } }) }],
    ["forbidden", { channels: () => json(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }) }],
    ["quota_exceeded", { channels: () => json(403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }) }],
    ["upstream", { channels: () => json(500, { error: { code: 500 } }) }],
    ["network", { channels: () => { throw new TypeError("fetch failed"); } }],
    ["network", { token: () => { throw new TypeError("fetch failed"); } }],
    ["no_channel", { channels: () => json(200, { kind: "youtube#channelListResponse", items: [] }) }],
    ["no_channel", { channels: () => json(200, { pageInfo: { totalResults: 0 } }) }],
    ["incomplete", { channels: () => json(200, { items: [{ id: "UCx", snippet: { title: "X" } }] }) }],
    ["incomplete", { channels: () => json(200, { items: [{ snippet: ITEM.snippet, statistics: ITEM.statistics }] }) }],
    ["bad_response", { channels: () => new Response("<html>", { status: 200 }) }],
    ["bad_response", { token: () => json(200, { token_type: "Bearer" }) }],
    ["not_connected", { connected: false }],
    ["not_configured", { env: {} }]
  ];
  for (const [reason, opts] of cases) {
    const ctx = setup(opts);
    const r = await ctx.yt.refresh();
    const text = JSON.stringify(r);
    if (r.status !== "error" || r.reason !== reason) throw new Error(`${reason} attendu : ${text}`);
    if ([REFRESH, ACCESS, SECRET].some(s => text.includes(s))) throw new Error("fuite dans l'erreur");
    if ((reason === "not_connected" || reason === "not_configured") && ctx.calls.length !== 0) throw new Error("appel sans connexion");
    cleanup(ctx.root);
  }
});

await asyncCheck("jeton illisible (clé changée) : erreur propre, aucun appel", async () => {
  const ctx = setup({ env: { ...ENV, YOUTUBE_OAUTH_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64") } });
  const r = await ctx.yt.refresh();
  if (r.reason !== "token_unreadable" || ctx.calls.length !== 0) throw new Error(JSON.stringify(r));
  cleanup(ctx.root);
});

await asyncCheck("access token jamais écrit sur disque ni exposé ; aucune écriture hors connexion OAuth", async () => {
  const ctx = results[0];
  const list = files(path.join(ctx.root, "data"));
  if (list.length !== 1 || !list[0].endsWith(path.join("oauth", "youtube.json"))) throw new Error(`fichiers : ${list}`);
  const dump = fs.readFileSync(list[0], "utf8");
  if (dump.includes(ACCESS) || dump.includes("access_token") || dump.includes(ITEM.id)) throw new Error("écriture inattendue");
  if (JSON.stringify(ctx.yt.current()).includes(ACCESS)) throw new Error("access token exposé");
});

await asyncCheck("façade et pont inchangé : la route settings expose la chaîne, sans secret", async () => {
  const ctx = results[0];
  const agent = createYouTubeAgent({ root: ctx.root, youtubeChannel: ctx.yt });
  const out = createBridgeHandler({ agent, port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/settings", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  const body = JSON.parse(out.body);
  if (out.status !== 200 || body.data.youtube_channel.status !== "ok" || body.data.youtube_channel.channel.video_count !== 0) throw new Error(out.body.slice(0, 200));
  if ([REFRESH, ACCESS, SECRET, "ciphertext"].some(s => out.body.includes(s))) throw new Error("fuite");
  const none = createYouTubeAgent({ root: ctx.root }).settings({ channelId: "nomade" });
  if (none.youtube_channel.status !== "not_loaded") throw new Error("sans lecteur");
  cleanup(ctx.root);
});

await asyncCheck("callback OAuth : la chaîne est relue après une connexion réussie, pas après un échec", async () => {
  for (const ok of [true, false]) {
    const ctx = setup();
    const auth = { enabled: true, returnUrl: ENV.YOUTUBE_OAUTH_RETURN_URL, completeCallback: async () => (ok ? { ok: true } : { ok: false, reason: "access_denied" }), status: () => ({ enabled: true, problem: null, connection: { status: "connected" } }) };
    const handle = createHandler({ root: ctx.root, port: PORT, token: "s".repeat(64), youtubeAuth: auth, youtubeChannel: ctx.yt });
    const out = await handle({ method: "GET", url: "/oauth/youtube/callback?code=x&state=y", headers: { host: `127.0.0.1:${PORT}` } });
    if (out.status !== 303 || out.headers.location !== ENV.YOUTUBE_OAUTH_RETURN_URL) throw new Error("redirection");
    if (ctx.yt.current().status !== (ok ? "ok" : "not_loaded")) throw new Error(`relecture : ${ctx.yt.current().status}`);
    cleanup(ctx.root);
  }
});

await asyncCheck("seuls les endpoints Google autorisés sur toute la suite : échange OAuth, channels.list, playlistItems.list", async () => {
  if (all.length === 0 || all.some(u => u !== GOOGLE_TOKEN_ENDPOINT && !u.startsWith(`${CHANNELS}?`) && !u.startsWith(`${PLAYLIST_ITEMS}?`))) throw new Error(`endpoints : ${[...new Set(all)]}`);
});

done("youtube-agent-channel-smoke");
