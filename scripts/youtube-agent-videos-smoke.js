// Smoke R20.2 — vidéos de la chaîne (Google simulé) : playlistItems.list sur la playlist
// « uploads », chaîne vide nominale, confidentialité conservée, erreurs, aucune fuite.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-videos-smoke.js

import fs from "node:fs";
import path from "node:path";

import { createYoutubeChannel } from "../src/youtube-agent/connectors/youtube/channel.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createBridgeHandler } from "../src/youtube-agent/agent-api.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 7);
const SECRET = "test-client-secret-videos";
const REFRESH = "test-refresh-token-videos";
const ACCESS = "test-access-token-videos";
const BRIDGE = "bridge-token-0123456789abcdef0123456789abcdef";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const CHANNELS = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS = "https://www.googleapis.com/youtube/v3/playlistItems";
const UPLOADS = "UUabcdefghijklmnopqrstuv";
const NOW = new Date("2026-10-03T10:00:00Z");

const CHANNEL = {
  id: "UCabcdefghijklmnopqrstuv",
  snippet: { title: "Les Découvertes du Nomade", thumbnails: {} },
  statistics: { viewCount: "0", subscriberCount: "0", videoCount: "0" },
  contentDetails: { relatedPlaylists: { uploads: UPLOADS } }
};
const item = (id, privacy, extra = {}) => ({
  snippet: { title: `Vidéo ${id}`, description: `Desc ${id}`, publishedAt: "2026-09-01T10:00:00Z", resourceId: { kind: "youtube#video", videoId: id }, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
  contentDetails: { videoId: id, videoPublishedAt: "2026-09-02T10:00:00Z" },
  status: { privacyStatus: privacy },
  ...extra
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const all = [];

function setup({ videos = () => json(200, { items: [] }), channels = () => json(200, { items: [CHANNEL] }) } = {}) {
  const root = tmpRoot("videos");
  const calls = [];

  saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE], now: NOW });

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    all.push(url);

    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
    if (url.startsWith(`${CHANNELS}?`)) return channels(init);
    if (url.startsWith(`${PLAYLIST_ITEMS}?`)) return videos(init);

    throw new Error(`endpoint inattendu : ${url}`);
  };

  return { root, calls, yt: createYoutubeChannel({ root, env: ENV, fetchImpl, now: () => NOW }) };
}

const files = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };

await asyncCheck("état initial : vidéos non lues", async () => {
  const ctx = setup();
  if (ctx.yt.videos().status !== "not_loaded") throw new Error("état initial");
  cleanup(ctx.root);
});

await asyncCheck("chaîne vide : 0 vidéo, aucune erreur (liste vide ou playlist introuvable)", async () => {
  for (const videos of [() => json(200, { kind: "youtube#playlistItemListResponse", items: [], pageInfo: { totalResults: 0 } }), () => json(404, { error: { code: 404, errors: [{ reason: "playlistNotFound" }] } })]) {
    const ctx = setup({ videos });
    await ctx.yt.refresh();
    const v = ctx.yt.videos();
    if (v.status !== "ok" || v.items.length !== 0 || v.has_more !== false || "reason" in v) throw new Error(JSON.stringify(v));
    if (ctx.yt.current().status !== "ok") throw new Error("chaîne");
    cleanup(ctx.root);
  }
});

await asyncCheck("lecture : playlistItems.list sur uploads, même access token, champs attendus, confidentialité conservée", async () => {
  const ctx = setup({ videos: () => json(200, { items: [item("aaaaaaaaaaa", "public"), item("bbbbbbbbbbb", "private"), item("ccccccccccc", "unlisted")] }) });
  await ctx.yt.refresh();
  const v = ctx.yt.videos();
  if (v.status !== "ok" || v.items.length !== 3 || v.has_more) throw new Error(JSON.stringify(v));
  const a = v.items[0];
  if (a.video_id !== "aaaaaaaaaaa" || a.title !== "Vidéo aaaaaaaaaaa" || a.description !== "Desc aaaaaaaaaaa" || a.published_at !== "2026-09-02T10:00:00Z" || a.thumbnail_url !== "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg" || a.privacy_status !== "public") throw new Error(JSON.stringify(a));
  if (v.items.map(i => i.privacy_status).join() !== "public,private,unlisted") throw new Error("confidentialité");
  if (Object.keys(a).sort().join() !== "description,privacy_status,published_at,thumbnail_url,title,video_id") throw new Error(`champs : ${Object.keys(a)}`);
  const call = ctx.calls.find(c => c.url.startsWith(`${PLAYLIST_ITEMS}?`));
  const u = new URL(call.url);
  if (call.init.method !== "GET" || call.init.headers.authorization !== `Bearer ${ACCESS}` || u.searchParams.get("part") !== "snippet,status,contentDetails" || u.searchParams.get("playlistId") !== UPLOADS || u.searchParams.get("maxResults") !== "50" || [...u.searchParams.keys()].length !== 3) throw new Error(call.url);
  if (ctx.calls.filter(c => c.url === GOOGLE_TOKEN_ENDPOINT).length !== 1 || ctx.calls.length !== 3) throw new Error(`${ctx.calls.length} appels`);
  cleanup(ctx.root);
});

await asyncCheck("une seule page de 50 : has_more signale une suite, aucune page suivante demandée", async () => {
  const ctx = setup({ videos: () => json(200, { items: [item("aaaaaaaaaaa", "public")], nextPageToken: "CAEQAA" }) });
  await ctx.yt.refresh();
  if (ctx.yt.videos().has_more !== true || ctx.calls.filter(c => c.url.startsWith(`${PLAYLIST_ITEMS}?`)).length !== 1) throw new Error("pagination");
  cleanup(ctx.root);
});

await asyncCheck("erreurs vidéos propagées proprement ; la chaîne reste lue", async () => {
  const cases = [
    ["unauthorized", () => json(401, { error: { code: 401, errors: [{ reason: "authError" }] } })],
    ["forbidden", () => json(403, { error: { code: 403, errors: [{ reason: "playlistItemsNotAccessible" }] } })],
    ["quota_exceeded", () => json(403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } })],
    ["upstream", () => json(503, { error: { code: 503 } })],
    ["rejected", () => json(404, { error: { code: 404, errors: [{ reason: "notFound" }] } })],
    ["network", () => { throw new TypeError("fetch failed"); }],
    ["bad_response", () => new Response("<html>", { status: 200 })],
    ["incomplete", () => json(200, { kind: "youtube#playlistItemListResponse" })],
    ["incomplete", () => json(200, { items: [{ snippet: { title: "Sans identifiant" } }] })]
  ];
  for (const [reason, videos] of cases) {
    const ctx = setup({ videos });
    await ctx.yt.refresh();
    const v = ctx.yt.videos();
    if (v.status !== "error" || v.reason !== reason) throw new Error(`${reason} attendu : ${JSON.stringify(v)}`);
    if (ctx.yt.current().status !== "ok") throw new Error("chaîne perdue");
    if ([ACCESS, REFRESH, SECRET].some(s => JSON.stringify(v).includes(s))) throw new Error("fuite");
    cleanup(ctx.root);
  }
});

await asyncCheck("erreur sur la chaîne (aucune chaîne, token invalide) : les vidéos portent la même erreur, aucun appel playlistItems", async () => {
  for (const [reason, channels] of [["no_channel", () => json(200, { items: [] })], ["unauthorized", () => json(401, { error: { code: 401 } })]]) {
    const ctx = setup({ channels });
    await ctx.yt.refresh();
    if (ctx.yt.videos().status !== "error" || ctx.yt.videos().reason !== reason || ctx.calls.some(c => c.url.startsWith(`${PLAYLIST_ITEMS}?`))) throw new Error(reason);
    cleanup(ctx.root);
  }
  const noUploads = setup({ channels: () => json(200, { items: [{ ...CHANNEL, contentDetails: {} }] }) });
  await noUploads.yt.refresh();
  if (noUploads.yt.videos().reason !== "incomplete") throw new Error("playlist uploads absente");
  cleanup(noUploads.root);
});

await asyncCheck("aucune écriture disque ; pont inchangé : settings expose youtube_videos sans secret", async () => {
  const ctx = setup({ videos: () => json(200, { items: [item("aaaaaaaaaaa", "public")] }) });
  await ctx.yt.refresh();
  const list = files(path.join(ctx.root, "data"));
  if (list.length !== 1 || !list[0].endsWith(path.join("oauth", "youtube.json")) || fs.readFileSync(list[0], "utf8").includes("aaaaaaaaaaa")) throw new Error(`fichiers : ${list}`);
  const agent = createYouTubeAgent({ root: ctx.root, youtubeChannel: ctx.yt });
  const out = createBridgeHandler({ agent, port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/settings", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  const body = JSON.parse(out.body);
  if (out.status !== 200 || body.data.youtube_videos.status !== "ok" || body.data.youtube_videos.items[0].video_id !== "aaaaaaaaaaa") throw new Error(out.body.slice(0, 200));
  if ([ACCESS, REFRESH, SECRET].some(s => out.body.includes(s))) throw new Error("fuite");
  if (createYouTubeAgent({ root: ctx.root }).settings({ channelId: "nomade" }).youtube_videos.status !== "not_loaded") throw new Error("sans lecteur");
  cleanup(ctx.root);
});

await asyncCheck("endpoints : uniquement l'échange OAuth, channels.list et playlistItems.list", async () => {
  if (all.length === 0 || all.some(u => u !== GOOGLE_TOKEN_ENDPOINT && !u.startsWith(`${CHANNELS}?`) && !u.startsWith(`${PLAYLIST_ITEMS}?`))) throw new Error(`endpoints : ${[...new Set(all)]}`);
  if (all.some(u => /\/search|\/videos\?|commentThreads|youtubeanalytics/.test(u))) throw new Error("endpoint interdit");
});

done("youtube-agent-videos-smoke");
