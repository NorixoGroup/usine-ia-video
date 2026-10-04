// Synchronisation à la demande de la chaîne et de ses vidéos (R20.1, R20.2, R20.5 lot 2) :
// seule frontière réseau YouTube, en lecture seule. Appels Google, uniquement lors
// d'une synchronisation demandée (bouton local ou commande `npm run youtube-sync`) :
// l'échange du refresh token contre un access token, channels.list (mine=true),
// playlistItems.list sur la playlist « uploads » (toutes les pages), puis videos.list
// par lots de 50 sur toutes les vidéos connues. L'access token reste en mémoire le temps
// de la synchronisation ; il n'est jamais écrit, journalisé ni renvoyé. Rien n'est écrit
// sur YouTube. Le résultat est enregistré dans le miroir local (mirror.js) ; la façade
// et le pont ne lisent que ce miroir : aucun appel au démarrage ni à l'affichage.

import crypto from "node:crypto";

import { readOAuthConfig } from "./auth/config.js";
import { GOOGLE_TOKEN_ENDPOINT } from "./auth/google-oauth.js";
import { loadRefreshToken, readConnectionMeta } from "./auth/token-store.js";
import { readMirror, mergeVideos, writeMirror, writeSyncFailure, acquireSyncLease, channelState, videosState } from "./mirror.js";

const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlistItems";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";
// Maximum autorisé par l'API pour playlistItems.list et videos.list (identifiants par appel).
const PAGE_SIZE = 50;
// Plafond par réponse : une page de 50 vidéos aux descriptions longues (5 000 caractères
// chacune au plus) dépasse largement l'ancien plafond de 256 Ko.
const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
// Plafond global d'une synchronisation : au plus 10 000 vidéos et 500 appels YouTube.
const MAX_VIDEOS_TOTAL = 10_000;
const MAX_SYNC_CALLS = 500;
const TIMEOUT_MS = 10_000;

class ChannelError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function call(fetchImpl, url, init, budget = null) {
  if (budget) {
    budget.calls += 1;

    if (budget.calls > MAX_SYNC_CALLS) throw new ChannelError("sync_limit");
  }

  let response;

  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ChannelError("network");
  }

  let json;

  try {
    const text = await response.text();

    if (text.length > MAX_RESPONSE_CHARS) throw new Error("trop long");

    json = JSON.parse(text);
  } catch {
    throw new ChannelError("bad_response");
  }

  return { status: response.status, ok: response.ok, json };
}

async function accessTokenFor({ config, refreshToken, fetchImpl, budget }) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const r = await call(fetchImpl, GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString()
  }, budget);

  if (!r.ok) throw new ChannelError(r.json?.error === "invalid_grant" ? "token_revoked" : r.status >= 500 ? "upstream" : "token_refused");
  if (typeof r.json?.access_token !== "string" || !r.json.access_token) throw new ChannelError("bad_response");

  return r.json.access_token;
}

function errorReason(status, json) {
  const reason = json?.error?.errors?.[0]?.reason;

  if (status === 401) return "unauthorized";
  if (status === 403) return reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded" ? "quota_exceeded" : "forbidden";
  if (status >= 500) return "upstream";

  return "rejected";
}

const count = value => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);

function toChannel(item) {
  const snippet = item?.snippet;
  const statistics = item?.statistics;

  if (typeof item?.id !== "string" || !item.id || typeof snippet?.title !== "string" || !statistics || count(statistics.videoCount) === null || count(statistics.viewCount) === null) {
    throw new ChannelError("incomplete");
  }

  const thumbnail = thumbnailOf(snippet.thumbnails);

  return {
    channel_id: item.id,
    title: snippet.title,
    description: typeof snippet.description === "string" ? snippet.description : "",
    thumbnail_url: thumbnail,
    country: typeof snippet.country === "string" ? snippet.country : null,
    subscriber_count: statistics.hiddenSubscriberCount ? null : count(statistics.subscriberCount),
    video_count: count(statistics.videoCount),
    view_count: count(statistics.viewCount),
    related_playlists: { ...(item.contentDetails?.relatedPlaylists ?? {}) }
  };
}

const thumbnailOf = thumbs => [thumbs?.high, thumbs?.medium, thumbs?.default].map(t => t?.url).find(u => typeof u === "string" && u.startsWith("https://")) ?? null;

function toVideo(item) {
  const snippet = item?.snippet;
  const videoId = item?.contentDetails?.videoId ?? snippet?.resourceId?.videoId;

  if (typeof videoId !== "string" || !videoId || typeof snippet?.title !== "string") throw new ChannelError("incomplete");

  return {
    video_id: videoId,
    title: snippet.title,
    description: typeof snippet.description === "string" ? snippet.description : "",
    published_at: item.contentDetails?.videoPublishedAt ?? snippet.publishedAt ?? null,
    thumbnail_url: thumbnailOf(snippet.thumbnails),
    privacy_status: typeof item.status?.privacyStatus === "string" ? item.status.privacyStatus : null
  };
}

const text = value => (typeof value === "string" ? value : null);

// Détail d'une vidéo lu par videos.list (snippet, status, contentDetails, statistics).
function toVideoDetail(item) {
  const snippet = item?.snippet;

  if (typeof item?.id !== "string" || !item.id || typeof snippet?.title !== "string") throw new ChannelError("incomplete");

  return {
    video_id: item.id,
    title: snippet.title,
    description: typeof snippet.description === "string" ? snippet.description : "",
    published_at: text(snippet.publishedAt),
    thumbnail_url: thumbnailOf(snippet.thumbnails),
    privacy_status: text(item.status?.privacyStatus),
    upload_status: text(item.status?.uploadStatus),
    publish_at: text(item.status?.publishAt),
    made_for_kids: typeof item.status?.madeForKids === "boolean" ? item.status.madeForKids : null,
    duration: text(item.contentDetails?.duration),
    category_id: text(snippet.categoryId),
    default_language: text(snippet.defaultLanguage),
    tags: Array.isArray(snippet.tags) ? snippet.tags.filter(tag => typeof tag === "string") : [],
    live_broadcast_content: text(snippet.liveBroadcastContent),
    view_count: count(item.statistics?.viewCount),
    like_count: count(item.statistics?.likeCount),
    comment_count: count(item.statistics?.commentCount)
  };
}

const authorized = accessToken => ({ method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });

// Toutes les pages de la playlist « uploads » : identifiants et date de publication
// de repli (une vidéo encore listée mais déjà retirée n'a plus de détail).
async function fetchUploads({ accessToken, uploads, fetchImpl, budget }) {
  if (typeof uploads !== "string" || !uploads) throw new ChannelError("incomplete");

  const ids = [];
  let pageToken = null;

  do {
    const url = new URL(PLAYLIST_ITEMS_ENDPOINT);

    url.searchParams.set("part", "snippet,status,contentDetails");
    url.searchParams.set("playlistId", uploads);
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const r = await call(fetchImpl, url.toString(), authorized(accessToken), budget);

    // Chaîne sans aucune vidéo : Google peut répondre « playlist introuvable » au lieu d'une liste vide.
    if (r.status === 404 && !pageToken && r.json?.error?.errors?.[0]?.reason === "playlistNotFound") return [];
    if (!r.ok) throw new ChannelError(errorReason(r.status, r.json));
    if (!Array.isArray(r.json?.items)) throw new ChannelError("incomplete");

    for (const item of r.json.items) ids.push(toVideo(item).video_id);

    if (ids.length > MAX_VIDEOS_TOTAL) throw new ChannelError("sync_limit");

    pageToken = typeof r.json.nextPageToken === "string" && r.json.nextPageToken ? r.json.nextPageToken : null;
  } while (pageToken);

  return [...new Set(ids)];
}

// Détail de toutes les vidéos, par lots de 50 identifiants (1 unité de quota par lot).
// Un identifiant absent de la réponse : vidéo supprimée ou devenue indisponible.
async function fetchDetails({ accessToken, ids, fetchImpl, budget }) {
  const details = new Map();

  for (let start = 0; start < ids.length; start += PAGE_SIZE) {
    const url = new URL(VIDEOS_ENDPOINT);

    url.searchParams.set("part", "snippet,status,contentDetails,statistics");
    url.searchParams.set("id", ids.slice(start, start + PAGE_SIZE).join(","));
    url.searchParams.set("maxResults", String(PAGE_SIZE));

    const r = await call(fetchImpl, url.toString(), authorized(accessToken), budget);

    if (!r.ok) throw new ChannelError(errorReason(r.status, r.json));
    if (!Array.isArray(r.json?.items)) throw new ChannelError("incomplete");

    for (const item of r.json.items) {
      const detail = toVideoDetail(item);
      details.set(detail.video_id, detail);
    }
  }

  return details;
}

async function connect({ root, env, fetchImpl, budget }) {
  const conf = readOAuthConfig(env);

  if (!conf.ok) throw new ChannelError("not_configured");
  if (readConnectionMeta({ root }).status !== "connected") throw new ChannelError("not_connected");

  let refreshToken;

  try {
    refreshToken = loadRefreshToken({ root, key: conf.config.tokenKey });
  } catch {
    throw new ChannelError("token_unreadable");
  }

  return accessTokenFor({ config: conf.config, refreshToken, fetchImpl, budget });
}

async function fetchChannel({ accessToken, fetchImpl, budget }) {
  const url = new URL(CHANNELS_ENDPOINT);

  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("mine", "true");

  const r = await call(fetchImpl, url.toString(), authorized(accessToken), budget);

  if (!r.ok) throw new ChannelError(errorReason(r.status, r.json));
  if (!Array.isArray(r.json?.items) || r.json.items.length === 0) throw new ChannelError("no_channel");

  return toChannel(r.json.items[0]);
}

// Synchronisation complète et contrôlée : tout réussit, ou rien n'est remplacé.
async function synchronize({ root, env, fetchImpl, now }) {
  const budget = { calls: 0 };
  const accessToken = await connect({ root, env, fetchImpl, budget });
  const channel = await fetchChannel({ accessToken, fetchImpl, budget });
  const listed = await fetchUploads({ accessToken, uploads: channel.related_playlists.uploads, fetchImpl, budget });
  const previous = readMirror(root).videos?.videos ?? [];
  // Toutes les vidéos connues sont contrôlées, y compris les pierres tombales (restauration).
  const ids = [...new Set([...listed, ...previous.map(video => video.video_id)])];
  const details = await fetchDetails({ accessToken, ids, fetchImpl, budget });
  const syncedAt = now().toISOString();
  const { videos, changes } = mergeVideos({ previous, details, now: new Date(syncedAt) });
  // Quota YouTube : 1 unité par appel, l'échange du jeton (premier appel) n'en consomme pas.
  const summary = { ...changes, present: videos.filter(video => video.mirror_status === "present").length, total_known: videos.length, calls: budget.calls, quota_units: budget.calls - 1 };

  writeMirror(root, { channel, videos, syncId: crypto.randomUUID(), syncedAt, summary });

  return { status: "ok", synced_at: syncedAt, summary };
}

// Lecteur du miroir et synchronisation à la demande. current() et videos() ne font
// jamais d'appel réseau ; sync() est l'unique point d'entrée vers Google.
export function createYoutubeChannel({ root, env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let running = null;

  async function sync() {
    const release = acquireSyncLease(root);

    if (!release) return { status: "error", at: now().toISOString(), reason: "sync_in_progress" };

    try {
      return await synchronize({ root, env, fetchImpl, now });
    } catch (error) {
      const at = now().toISOString();
      const reason = error instanceof ChannelError ? error.reason : "internal_error";

      try {
        writeSyncFailure(root, { at, reason });
      } catch {
        // disque indisponible : l'erreur est tout de même renvoyée
      }

      return { status: "error", at, reason };
    } finally {
      release();
    }
  }

  return {
    current: () => channelState(root),
    videos: () => videosState(root),

    // Une seule synchronisation à la fois dans ce processus : un second appel attend la première.
    sync() {
      running ??= sync().finally(() => { running = null; });

      return running;
    }
  };
}
