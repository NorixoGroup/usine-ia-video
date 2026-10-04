// Smoke R20.2 — vidéos de la chaîne (Google simulé) : playlistItems.list sur la playlist
// « uploads », chaîne vide nominale, confidentialité conservée, erreurs, aucune fuite.
// R20.5 lot 2 : toutes les pages de la playlist, puis videos.list par lots de 50 ; le
// résultat est enregistré dans le miroir ; le pont expose les 50 plus récentes et les totaux.
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
const VIDEOS = "https://www.googleapis.com/youtube/v3/videos";
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

// Détail videos.list d'une vidéo (titre, statut, durée, statistiques).
const detail = (id, privacy = "public", extra = {}) => ({
  id,
  snippet: { title: `Vidéo ${id}`, description: `Desc ${id}`, publishedAt: "2026-09-02T10:00:00Z", thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } }, categoryId: "19", tags: ["voyage"] },
  status: { privacyStatus: privacy, uploadStatus: "processed" },
  contentDetails: { duration: "PT12M3S" },
  statistics: { viewCount: "120", likeCount: "8", commentCount: "2" },
  ...extra
});

function setup({ videos = () => json(200, { items: [] }), channels = () => json(200, { items: [CHANNEL] }), details = null } = {}) {
  const root = tmpRoot("videos");
  const calls = [];

  saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE], now: NOW });

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    all.push(url);

    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
    if (url.startsWith(`${CHANNELS}?`)) return channels(init);
    if (url.startsWith(`${PLAYLIST_ITEMS}?`)) return videos(init, new URL(url));
    if (url.startsWith(`${VIDEOS}?`)) {
      const ids = new URL(url).searchParams.get("id").split(",");
      return details ? details(ids, init) : json(200, { items: ids.map(id => detail(id)) });
    }

    throw new Error(`endpoint inattendu : ${url}`);
  };

  return { root, calls, yt: createYoutubeChannel({ root, env: ENV, fetchImpl, now: () => NOW }) };
}

const files = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const listCalls = ctx => ctx.calls.filter(c => c.url.startsWith(`${PLAYLIST_ITEMS}?`));
const detailCalls = ctx => ctx.calls.filter(c => c.url.startsWith(`${VIDEOS}?`));
const mirrorDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");

await asyncCheck("état initial : vidéos non lues, aucun appel", async () => {
  const ctx = setup();
  if (ctx.yt.videos().status !== "not_loaded" || ctx.calls.length !== 0) throw new Error("état initial");
  cleanup(ctx.root);
});

await asyncCheck("chaîne vide : 0 vidéo, aucune erreur (liste vide ou playlist introuvable), aucun appel videos.list", async () => {
  for (const videos of [() => json(200, { kind: "youtube#playlistItemListResponse", items: [], pageInfo: { totalResults: 0 } }), () => json(404, { error: { code: 404, errors: [{ reason: "playlistNotFound" }] } })]) {
    const ctx = setup({ videos });
    await ctx.yt.sync();
    const v = ctx.yt.videos();
    if (v.status !== "ok" || v.items.length !== 0 || v.has_more !== false || v.total !== 0 || "reason" in v) throw new Error(JSON.stringify(v));
    if (ctx.yt.current().status !== "ok" || detailCalls(ctx).length !== 0) throw new Error("chaîne");
    cleanup(ctx.root);
  }
});

await asyncCheck("lecture : playlistItems puis videos.list, même access token, champs du contrat, confidentialité conservée", async () => {
  const privacy = { aaaaaaaaaaa: "public", bbbbbbbbbbb: "private", ccccccccccc: "unlisted" };
  const ctx = setup({
    videos: () => json(200, { items: Object.entries(privacy).map(([id, p]) => item(id, p)) }),
    details: ids => json(200, { items: ids.map((id, index) => detail(id, privacy[id], { snippet: { ...detail(id).snippet, publishedAt: `2026-09-0${3 - index}T10:00:00Z` } })) })
  });
  const r = await ctx.yt.sync();
  const v = ctx.yt.videos();
  if (r.status !== "ok" || v.status !== "ok" || v.items.length !== 3 || v.has_more || v.total !== 3) throw new Error(JSON.stringify(v));
  const a = v.items[0];
  if (a.video_id !== "aaaaaaaaaaa" || a.title !== "Vidéo aaaaaaaaaaa" || a.description !== "Desc aaaaaaaaaaa" || a.published_at !== "2026-09-03T10:00:00Z" || a.thumbnail_url !== "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg" || a.privacy_status !== "public") throw new Error(JSON.stringify(a));
  if (v.items.map(i => i.privacy_status).join() !== "public,private,unlisted") throw new Error("confidentialité");
  // Contrat du pont inchangé : exactement les six champs de R20.2.
  if (Object.keys(a).sort().join() !== "description,privacy_status,published_at,thumbnail_url,title,video_id") throw new Error(`champs : ${Object.keys(a)}`);
  const list = listCalls(ctx)[0];
  const u = new URL(list.url);
  if (list.init.method !== "GET" || list.init.headers.authorization !== `Bearer ${ACCESS}` || u.searchParams.get("part") !== "snippet,status,contentDetails" || u.searchParams.get("playlistId") !== UPLOADS || u.searchParams.get("maxResults") !== "50" || [...u.searchParams.keys()].length !== 3) throw new Error(list.url);
  const det = detailCalls(ctx);
  const d = new URL(det[0].url);
  if (det.length !== 1 || det[0].init.method !== "GET" || det[0].init.headers.authorization !== `Bearer ${ACCESS}` || d.searchParams.get("part") !== "snippet,status,contentDetails,statistics" || d.searchParams.get("id") !== "aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc") throw new Error(det[0]?.url);
  if (ctx.calls.filter(c => c.url === GOOGLE_TOKEN_ENDPOINT).length !== 1 || ctx.calls.length !== 4) throw new Error(`${ctx.calls.length} appels`);
  // Le miroir conserve les champs utiles (durée, statistiques, description complète).
  const stored = JSON.parse(fs.readFileSync(path.join(mirrorDir(ctx.root), "videos.json"), "utf8")).videos.find(x => x.video_id === "aaaaaaaaaaa");
  if (stored.duration !== "PT12M3S" || stored.view_count !== 120 || stored.like_count !== 8 || stored.comment_count !== 2 || stored.mirror_status !== "present" || stored.tags.join() !== "voyage") throw new Error(JSON.stringify(stored));
  cleanup(ctx.root);
});

await asyncCheck("pagination complète : 120 vidéos → 3 pages, 3 lots videos.list ; le pont expose les 50 plus récentes et les totaux", async () => {
  const ids = Array.from({ length: 120 }, (_, n) => `v${String(n).padStart(10, "0")}`);
  const ctx = setup({
    videos: (init, url) => {
      const page = Number(url.searchParams.get("pageToken") ?? 0);
      const slice = ids.slice(page * 50, page * 50 + 50);
      return json(200, { items: slice.map(id => item(id, "public")), ...(page * 50 + 50 < ids.length ? { nextPageToken: String(page + 1) } : {}) });
    },
    details: batch => json(200, { items: batch.map((id, n) => detail(id, "public", { snippet: { ...detail(id).snippet, publishedAt: new Date(Date.UTC(2026, 0, 1) + ids.indexOf(id) * 60_000).toISOString() } })) })
  });
  const r = await ctx.yt.sync();
  const v = ctx.yt.videos();
  if (r.status !== "ok" || listCalls(ctx).length !== 3 || detailCalls(ctx).length !== 3) throw new Error(`${listCalls(ctx).length} pages, ${detailCalls(ctx).length} lots`);
  if (new URL(listCalls(ctx)[1].url).searchParams.get("pageToken") !== "1") throw new Error("pageToken");
  if (detailCalls(ctx).map(c => new URL(c.url).searchParams.get("id").split(",").length).join() !== "50,50,20") throw new Error("lots");
  if (v.items.length !== 50 || v.has_more !== true || v.total !== 120 || v.removed !== 0) throw new Error(JSON.stringify({ n: v.items.length, has_more: v.has_more, total: v.total }));
  // Les 50 plus récentes, de la plus récente à la plus ancienne.
  if (v.items[0].video_id !== ids[119] || v.items[49].video_id !== ids[70]) throw new Error(`ordre : ${v.items[0].video_id} … ${v.items[49].video_id}`);
  if (r.summary.calls !== 1 + 1 + 3 + 3 || r.summary.quota_units !== 7 || r.summary.added !== 120) throw new Error(JSON.stringify(r.summary));
  cleanup(ctx.root);
});

await asyncCheck("erreurs sur la playlist ou videos.list : synchronisation refusée, rien d'enregistré, erreur exposée", async () => {
  const failures = [
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
  for (const where of ["playlist", "details"]) {
    for (const [reason, fail] of failures) {
      const ctx = where === "playlist"
        ? setup({ videos: fail })
        : setup({ videos: () => json(200, { items: [item("aaaaaaaaaaa", "public")] }), details: () => fail() });
      const r = await ctx.yt.sync();
      const v = ctx.yt.videos();
      if (r.status !== "error" || r.reason !== reason || v.status !== "error" || v.reason !== reason || ctx.yt.current().status !== "error") throw new Error(`${where} ${reason} attendu : ${JSON.stringify(v)}`);
      if (fs.existsSync(path.join(mirrorDir(ctx.root), "videos.json")) || fs.existsSync(path.join(mirrorDir(ctx.root), "channel.json"))) throw new Error("miroir écrit malgré l'échec");
      if ([ACCESS, REFRESH, SECRET].some(x => JSON.stringify(v).includes(x))) throw new Error("fuite");
      cleanup(ctx.root);
    }
  }
});

await asyncCheck("erreur sur la chaîne (aucune chaîne, token invalide) : aucune lecture de la playlist ni des vidéos", async () => {
  for (const [reason, channels] of [["no_channel", () => json(200, { items: [] })], ["unauthorized", () => json(401, { error: { code: 401 } })]]) {
    const ctx = setup({ channels });
    await ctx.yt.sync();
    if (ctx.yt.videos().status !== "error" || ctx.yt.videos().reason !== reason || listCalls(ctx).length !== 0 || detailCalls(ctx).length !== 0) throw new Error(reason);
    cleanup(ctx.root);
  }
  const noUploads = setup({ channels: () => json(200, { items: [{ ...CHANNEL, contentDetails: {} }] }) });
  await noUploads.yt.sync();
  if (noUploads.yt.videos().reason !== "incomplete") throw new Error("playlist uploads absente");
  cleanup(noUploads.root);
});

await asyncCheck("pont inchangé : settings expose youtube_videos depuis le miroir, sans secret, sans appel", async () => {
  const ctx = setup({ videos: () => json(200, { items: [item("aaaaaaaaaaa", "public")] }) });
  await ctx.yt.sync();
  const before = ctx.calls.length;
  const agent = createYouTubeAgent({ root: ctx.root, youtubeChannel: ctx.yt });
  const out = createBridgeHandler({ agent, port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/settings", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  const body = JSON.parse(out.body);
  if (out.status !== 200 || body.data.youtube_videos.status !== "ok" || body.data.youtube_videos.items[0].video_id !== "aaaaaaaaaaa" || body.data.youtube_videos.total !== 1) throw new Error(out.body.slice(0, 200));
  if ([ACCESS, REFRESH, SECRET].some(x => out.body.includes(x))) throw new Error("fuite");
  if (ctx.calls.length !== before) throw new Error("le pont a appelé Google");
  if (createYouTubeAgent({ root: ctx.root }).settings({ channelId: "nomade" }).youtube_videos.status !== "not_loaded") throw new Error("sans lecteur");
  for (const f of files(path.join(ctx.root, "data"))) if ([ACCESS, REFRESH, SECRET].some(x => fs.readFileSync(f, "utf8").includes(x))) throw new Error(`fuite disque : ${f}`);
  cleanup(ctx.root);
});

await asyncCheck("endpoints : uniquement l'échange OAuth, channels.list, playlistItems.list et videos.list (lecture)", async () => {
  if (all.length === 0 || all.some(u => u !== GOOGLE_TOKEN_ENDPOINT && !u.startsWith(`${CHANNELS}?`) && !u.startsWith(`${PLAYLIST_ITEMS}?`) && !u.startsWith(`${VIDEOS}?`))) throw new Error(`endpoints : ${[...new Set(all)]}`);
  if (all.some(u => /\/search|commentThreads|youtubeanalytics/.test(u))) throw new Error("endpoint interdit");
});

done("youtube-agent-videos-smoke");
