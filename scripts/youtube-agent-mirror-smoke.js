// Smoke R20.5 lot 2 — miroir local persistant de la chaîne YouTube (Google simulé).
// Synchronisation incrémentale (nouvelles vidéos, pierres tombales, restauration,
// changements de contenu et de statistiques), historique, échec sans perte, bail
// exclusif, plafonds, aucun appel au démarrage, bouton local, commande, journal.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-mirror-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import { createYoutubeChannel } from "../src/youtube-agent/connectors/youtube/channel.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { readStatsHistory, mergeVideos, SYNC_LEASE_STALE_MS } from "../src/youtube-agent/connectors/youtube/mirror.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createBridgeHandler } from "../src/youtube-agent/agent-api.js";
import { createHandler } from "../src/youtube-agent/server.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { runSync } from "../src/youtube-agent/youtube-sync.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 7);
const SECRET = "test-client-secret-mirror";
const REFRESH = "test-refresh-token-mirror";
const ACCESS = "test-access-token-mirror";
const BRIDGE = "bridge-token-0123456789abcdef0123456789abcdef";
const SESSION = "s".repeat(64);
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

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const mirrorDir = root => path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");
const readMirrorFile = (root, name) => JSON.parse(fs.readFileSync(path.join(mirrorDir(root), name), "utf8"));

// Chaîne YouTube simulée et modifiable entre deux synchronisations.
function fakeYoutube() {
  const state = {
    subscribers: 10,
    videos: new Map(),
    failOn: null,
    hugeDescriptions: false,
    endlessPages: false
  };
  const put = (id, fields = {}) => state.videos.set(id, { title: `Vidéo ${id}`, description: `Desc ${id}`, privacy: "public", views: 100, published: "2026-09-01T10:00:00Z", thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, ...state.videos.get(id), ...fields });

  return { state, put };
}

function setup(yt = fakeYoutube(), { connected = true, now = () => new Date("2026-10-04T10:00:00Z") } = {}) {
  const root = tmpRoot("mirror");
  const calls = [];

  if (connected) saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE], now: new Date("2026-10-03T10:00:00Z") });

  const fetchImpl = async (url, init) => {
    calls.push({ url, init });

    if (yt.state.failOn && url.startsWith(yt.state.failOn)) return json(503, { error: { code: 503 } });
    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: "Bearer" });
    if (url.startsWith(`${CHANNELS}?`)) {
      return json(200, { items: [{ id: "UCabcdefghijklmnopqrstuv", snippet: { title: "Les Découvertes du Nomade", thumbnails: {} }, statistics: { viewCount: "5000", subscriberCount: String(yt.state.subscribers), videoCount: String(yt.state.videos.size) }, contentDetails: { relatedPlaylists: { uploads: UPLOADS } } }] });
    }
    if (url.startsWith(`${PLAYLIST_ITEMS}?`)) {
      const u = new URL(url);
      const page = Number(u.searchParams.get("pageToken") ?? 0);

      if (yt.state.endlessPages) return json(200, { items: [], nextPageToken: String(page + 1) });

      const ids = [...yt.state.videos.keys()];
      const slice = ids.slice(page * 50, page * 50 + 50);

      return json(200, {
        items: slice.map(id => ({ snippet: { title: yt.state.videos.get(id).title, resourceId: { videoId: id } }, contentDetails: { videoId: id }, status: { privacyStatus: yt.state.videos.get(id).privacy } })),
        ...(page * 50 + 50 < ids.length ? { nextPageToken: String(page + 1) } : {})
      });
    }
    if (url.startsWith(`${VIDEOS}?`)) {
      const ids = new URL(url).searchParams.get("id").split(",");

      return json(200, {
        items: ids.filter(id => yt.state.videos.has(id)).map(id => {
          const v = yt.state.videos.get(id);

          return {
            id,
            snippet: { title: v.title, description: yt.state.hugeDescriptions ? "é".repeat(5000) : v.description, publishedAt: v.published, thumbnails: { medium: { url: v.thumb } } },
            status: { privacyStatus: v.privacy, uploadStatus: "processed" },
            contentDetails: { duration: "PT10M" },
            statistics: { viewCount: String(v.views), likeCount: "5", commentCount: "1" }
          };
        })
      });
    }

    throw new Error(`endpoint inattendu : ${url}`);
  };

  return { root, calls, yt, channel: createYoutubeChannel({ root, env: ENV, fetchImpl, now }), fetchImpl };
}

// ---------------------------------------------------------------------------------------

await asyncCheck("première synchronisation : miroir écrit (channel.json, videos.json, sync.json, stats.jsonl), lecture sans appel", async () => {
  const ctx = setup();
  ctx.yt.put("aaaaaaaaaaa");
  ctx.yt.put("bbbbbbbbbbb", { privacy: "private" });
  const r = await ctx.channel.sync();
  if (r.status !== "ok" || r.summary.added !== 2 || r.summary.present !== 2 || r.summary.quota_units !== 3) throw new Error(JSON.stringify(r));
  const names = fs.readdirSync(mirrorDir(ctx.root)).sort().join();
  if (names !== "channel.json,stats.jsonl,sync.json,videos.json") throw new Error(names);
  const before = ctx.calls.length;
  for (let i = 0; i < 5; i += 1) { ctx.channel.current(); ctx.channel.videos(); }
  if (ctx.calls.length !== before) throw new Error("lecture du miroir avec appel");
  // Relu par un nouveau lecteur (redémarrage simulé) : les données sont toujours là, sans appel.
  const reopened = createYoutubeChannel({ root: ctx.root, env: ENV, fetchImpl: () => { throw new Error("aucun appel attendu"); } });
  if (reopened.current().status !== "ok" || reopened.videos().total !== 2 || reopened.current().channel.subscriber_count !== 10) throw new Error("miroir non relu après redémarrage");
  cleanup(ctx.root);
});

await asyncCheck("synchronisation incrémentale : nouvelle vidéo, suppression (pierre tombale), renommage, confidentialité, miniature, description, statistiques", async () => {
  const ctx = setup();
  for (const id of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]) ctx.yt.put(id);
  await ctx.channel.sync();
  ctx.yt.put("eeeeeeeeeee", { published: "2026-10-01T10:00:00Z" });
  ctx.yt.state.videos.delete("bbbbbbbbbbb");
  ctx.yt.put("ccccccccccc", { title: "Nouveau titre", privacy: "unlisted" });
  ctx.yt.put("ddddddddddd", { thumb: "https://i.ytimg.com/vi/ddddddddddd/new.jpg", description: "Nouvelle description" });
  ctx.yt.put("aaaaaaaaaaa", { views: 999 });
  ctx.yt.state.subscribers = 12;
  const r = await ctx.channel.sync();
  const s = r.summary;
  if (s.added !== 1 || s.removed !== 1 || s.updated !== 2 || s.unchanged !== 1 || s.restored !== 0 || s.present !== 4) throw new Error(JSON.stringify(s));
  const videos = readMirrorFile(ctx.root, "videos.json").videos;
  const get = id => videos.find(v => v.video_id === id);
  if (get("bbbbbbbbbbb").mirror_status !== "removed" || !get("bbbbbbbbbbb").removed_at || get("bbbbbbbbbbb").title !== "Vidéo bbbbbbbbbbb") throw new Error("pierre tombale");
  if (get("ccccccccccc").title !== "Nouveau titre" || get("ccccccccccc").privacy_status !== "unlisted") throw new Error("renommage");
  if (get("ddddddddddd").thumbnail_url !== "https://i.ytimg.com/vi/ddddddddddd/new.jpg" || get("ddddddddddd").description !== "Nouvelle description") throw new Error("miniature ou description");
  if (get("aaaaaaaaaaa").view_count !== 999 || get("aaaaaaaaaaa").first_seen_at !== "2026-10-04T10:00:00.000Z") throw new Error("statistiques ou première vue");
  const state = ctx.channel.videos();
  if (state.total !== 4 || state.removed !== 1 || state.items[0].video_id !== "eeeeeeeeeee" || state.items.some(i => i.video_id === "bbbbbbbbbbb")) throw new Error(JSON.stringify(state));
  if (ctx.channel.current().channel.subscriber_count !== 12) throw new Error("statistiques de la chaîne");
  // Restauration : la vidéo supprimée réapparaît.
  ctx.yt.put("bbbbbbbbbbb");
  const back = await ctx.channel.sync();
  if (back.summary.restored !== 1 || readMirrorFile(ctx.root, "videos.json").videos.find(v => v.video_id === "bbbbbbbbbbb").mirror_status !== "present") throw new Error("restauration");
  cleanup(ctx.root);
});

await asyncCheck("aucune suppression physique : une pierre tombale reste inchangée tant que la vidéo est absente", async () => {
  const merged = mergeVideos({ previous: [{ video_id: "x", title: "X", mirror_status: "removed", removed_at: "2026-01-01T00:00:00.000Z", fingerprint: "f" }], details: new Map(), now: new Date("2026-10-04T10:00:00Z") });
  if (merged.videos.length !== 1 || merged.videos[0].removed_at !== "2026-01-01T00:00:00.000Z" || merged.changes.removed !== 0) throw new Error(JSON.stringify(merged));
});

await asyncCheck("historique des statistiques : une ligne par synchronisation réussie, aucune en cas d'échec", async () => {
  const ctx = setup();
  ctx.yt.put("aaaaaaaaaaa");
  await ctx.channel.sync();
  ctx.yt.put("aaaaaaaaaaa", { views: 150 });
  await ctx.channel.sync();
  ctx.yt.state.failOn = VIDEOS;
  await ctx.channel.sync();
  const history = readStatsHistory(ctx.root);
  if (history.length !== 2 || history[0].videos[0].join() !== "aaaaaaaaaaa,100,5,1" || history[1].videos[0][1] !== 150 || history[1].channel.subscriber_count !== 10) throw new Error(JSON.stringify(history));
  cleanup(ctx.root);
});

await asyncCheck("échec d'une synchronisation : miroir précédent intact (octet pour octet), erreur exposée à côté des données", async () => {
  const ctx = setup();
  ctx.yt.put("aaaaaaaaaaa");
  await ctx.channel.sync();
  const before = ["channel.json", "videos.json"].map(f => fs.readFileSync(path.join(mirrorDir(ctx.root), f), "utf8"));
  ctx.yt.state.failOn = PLAYLIST_ITEMS;
  const r = await ctx.channel.sync();
  const after = ["channel.json", "videos.json"].map(f => fs.readFileSync(path.join(mirrorDir(ctx.root), f), "utf8"));
  if (r.status !== "error" || r.reason !== "upstream" || before.join() !== after.join()) throw new Error("miroir modifié");
  const channel = ctx.channel.current();
  const videos = ctx.channel.videos();
  if (channel.status !== "ok" || videos.status !== "ok" || videos.total !== 1 || channel.last_error?.reason !== "upstream" || videos.last_error?.reason !== "upstream") throw new Error(JSON.stringify({ channel, videos }));
  // Une réussite suivante efface l'erreur exposée.
  ctx.yt.state.failOn = null;
  await ctx.channel.sync();
  if ("last_error" in ctx.channel.current() || "last_error" in ctx.channel.videos()) throw new Error("erreur résiduelle");
  cleanup(ctx.root);
});

await asyncCheck("une seule synchronisation à la fois : même processus (attente commune) et autre processus (bail), bail périmé repris", async () => {
  const ctx = setup();
  ctx.yt.put("aaaaaaaaaaa");
  const [a, b] = await Promise.all([ctx.channel.sync(), ctx.channel.sync()]);
  if (a !== b || a.status !== "ok" || ctx.calls.filter(c => c.url === GOOGLE_TOKEN_ENDPOINT).length !== 1) throw new Error("synchronisations simultanées");
  const lease = path.join(mirrorDir(ctx.root), "sync.lease");
  fs.writeFileSync(lease, "12345");
  const busy = await ctx.channel.sync();
  if (busy.status !== "error" || busy.reason !== "sync_in_progress" || !fs.existsSync(lease)) throw new Error(JSON.stringify(busy));
  const old = (Date.now() - SYNC_LEASE_STALE_MS - 1000) / 1000;
  fs.utimesSync(lease, old, old);
  const resumed = await ctx.channel.sync();
  if (resumed.status !== "ok" || fs.existsSync(lease)) throw new Error("bail périmé non repris");
  cleanup(ctx.root);
});

await asyncCheck("plafonds : page de plus de 256 Ko acceptée (descriptions complètes) ; synchronisation sans fin arrêtée (sync_limit), miroir intact", async () => {
  const ctx = setup();
  for (let n = 0; n < 50; n += 1) ctx.yt.put(`v${String(n).padStart(10, "0")}`);
  ctx.yt.state.hugeDescriptions = true;
  const r = await ctx.channel.sync();
  const stored = readMirrorFile(ctx.root, "videos.json").videos[0];
  if (r.status !== "ok" || stored.description.length !== 5000) throw new Error(JSON.stringify(r));
  const before = fs.readFileSync(path.join(mirrorDir(ctx.root), "videos.json"), "utf8");
  ctx.yt.state.endlessPages = true;
  const endless = await ctx.channel.sync();
  if (endless.status !== "error" || endless.reason !== "sync_limit" || fs.readFileSync(path.join(mirrorDir(ctx.root), "videos.json"), "utf8") !== before) throw new Error(JSON.stringify(endless));
  if (ctx.calls.length > 600) throw new Error(`${ctx.calls.length} appels`);
  cleanup(ctx.root);
});

await asyncCheck("pont : contrat inchangé (6 champs par vidéo, 50 au plus) et totaux ; aucun appel Google", async () => {
  const ctx = setup();
  for (let n = 0; n < 60; n += 1) ctx.yt.put(`v${String(n).padStart(10, "0")}`, { published: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString() });
  await ctx.channel.sync();
  const before = ctx.calls.length;
  const agent = createYouTubeAgent({ root: ctx.root, youtubeChannel: ctx.channel });
  const out = createBridgeHandler({ agent, port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/settings", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  const v = JSON.parse(out.body).data.youtube_videos;
  if (v.status !== "ok" || v.items.length !== 50 || v.has_more !== true || v.total !== 60 || typeof v.fetched_at !== "string") throw new Error(JSON.stringify({ n: v.items.length, total: v.total }));
  if (v.items.some(i => Object.keys(i).sort().join() !== "description,privacy_status,published_at,thumbnail_url,title,video_id")) throw new Error("champs");
  if (v.items[0].video_id !== "v0000000059") throw new Error("ordre");
  if (ctx.calls.length !== before || [ACCESS, REFRESH, SECRET].some(x => out.body.includes(x))) throw new Error("appel ou fuite");
  cleanup(ctx.root);
});

await asyncCheck("démarrage de l'agent : aucun appel Google (startServer ne synchronise pas), état « non lue » sans miroir", async () => {
  // Le serveur réel ne peut pas écouter sous la garde réseau (résolution d'hôte) :
  // contrôle du code de démarrage, puis de l'état servi par un agent neuf.
  const source = fs.readFileSync(new URL("../src/youtube-agent/server.js", import.meta.url), "utf8");
  const startup = source.slice(source.indexOf("export function startServer"));
  if (/\.sync\(|\.refresh\(|youtubeSync/.test(startup)) throw new Error("synchronisation au démarrage");
  if ((source.match(/youtubeSync\(/g) ?? []).length !== 1 || /\.refresh\(/.test(source)) throw new Error("déclencheurs de synchronisation inattendus");
  const root = tmpRoot("mirror-start");
  saveConnection({ root, key: KEY, refreshToken: REFRESH, scopes: [YOUTUBE_READONLY_SCOPE], now: new Date("2026-10-03T10:00:00Z") });
  const youtubeChannel = createYoutubeChannel({ root, env: ENV, fetchImpl: () => { throw new Error("aucun appel attendu"); } });
  const out = createBridgeHandler({ agent: createYouTubeAgent({ root, youtubeChannel }), port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/settings", headers: { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": BRIDGE } });
  const data = JSON.parse(out.body).data;
  if (data.youtube_channel.status !== "not_loaded" || data.youtube_videos.status !== "not_loaded") throw new Error(JSON.stringify(data.youtube_channel));
  cleanup(root);
});

await asyncCheck("bouton local : la page affiche « non lue » et le bouton ; POST /youtube/sync synchronise, affiche le résultat et journalise", async () => {
  const ctx = setup();
  ctx.yt.put("aaaaaaaaaaa");
  const auth = { enabled: true, returnUrl: ENV.YOUTUBE_OAUTH_RETURN_URL, status: () => ({ enabled: true, problem: null, connection: { status: "connected", connected_at: "2026-10-03T10:00:00.000Z", scopes: [YOUTUBE_READONLY_SCOPE] } }) };
  const handle = createHandler({ root: ctx.root, port: PORT, token: SESSION, youtubeAuth: auth, youtubeChannel: ctx.channel });
  const host = { host: `127.0.0.1:${PORT}` };
  const page = handle({ method: "GET", url: `/?t=${SESSION}`, headers: host });
  if (!page.body.includes("Non lue : aucune synchronisation n'a encore été faite.") || !page.body.includes(`action="/youtube/sync?t=${SESSION}"`) || ctx.calls.length !== 0) throw new Error("page initiale");
  const refused = handle({ method: "POST", url: `/youtube/sync?t=${SESSION}`, headers: { ...host, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (refused.status !== 403 || ctx.calls.length !== 0) throw new Error("POST sans Origin accepté");
  const out = await handle({ method: "POST", url: `/youtube/sync?t=${SESSION}`, headers: { ...host, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (out.status !== 200 || !out.body.includes("Synchronisation réussie : 1 vidéos") || !out.body.includes("Chaîne « Les Découvertes du Nomade » · 1 vidéo")) throw new Error(out.body.slice(-600));
  const journal = readJournal({ root: ctx.root, channelId: "nomade" });
  if (journal.at(-1)?.type !== "youtube_sync" || journal.at(-1).outcome !== "ok") throw new Error(JSON.stringify(journal.at(-1)));
  if ([ACCESS, REFRESH, SECRET].some(x => out.body.includes(x) || JSON.stringify(journal).includes(x))) throw new Error("fuite");
  cleanup(ctx.root);
});

await asyncCheck("commande npm run youtube-sync (runSync) : synchronise, journalise, échec propre sans connexion", async () => {
  const ctx = setup();
  ctx.yt.put("aaaaaaaaaaa");
  const r = await runSync({ root: ctx.root, env: ENV, fetchImpl: ctx.fetchImpl, now: () => new Date("2026-10-04T10:00:00Z") });
  if (r.status !== "ok" || readJournal({ root: ctx.root, channelId: "nomade" }).at(-1).type !== "youtube_sync") throw new Error(JSON.stringify(r));
  const disconnected = setup(fakeYoutube(), { connected: false });
  const e = await runSync({ root: disconnected.root, env: ENV, fetchImpl: disconnected.fetchImpl });
  if (e.status !== "error" || e.reason !== "not_connected" || disconnected.calls.length !== 0) throw new Error(JSON.stringify(e));
  if (readJournal({ root: disconnected.root, channelId: "nomade" }).at(-1).outcome !== "not_connected") throw new Error("journal de l'échec");
  cleanup(ctx.root);
  cleanup(disconnected.root);
});

if (networkGuard.attempts().length !== 0) check("aucune tentative réseau réelle", () => { throw new Error(`${networkGuard.attempts().length} tentatives`); });

done("youtube-agent-mirror-smoke");
