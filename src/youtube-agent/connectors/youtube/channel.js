// Identité et vidéos de la chaîne (R20.1, R20.2) : seule frontière réseau YouTube.
// Trois appels Google seulement : l'échange du refresh token contre un access token,
// channels.list (mine=true), puis playlistItems.list sur la playlist « uploads ». L'access token reste en mémoire le temps de l'appel ;
// il n'est jamais écrit, journalisé ni renvoyé. Lecture seule : rien n'est écrit sur YouTube.

import { readOAuthConfig } from "./auth/config.js";
import { GOOGLE_TOKEN_ENDPOINT } from "./auth/google-oauth.js";
import { loadRefreshToken, readConnectionMeta } from "./auth/token-store.js";

const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlistItems";
// R20.2 : une seule page, la pagination n'est pas couverte par cette phase.
const MAX_VIDEOS = 50;
const MAX_RESPONSE_CHARS = 256 * 1024;
const TIMEOUT_MS = 10_000;

class ChannelError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function call(fetchImpl, url, init) {
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

async function accessTokenFor({ config, refreshToken, fetchImpl }) {
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
  });

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

async function fetchVideos({ accessToken, uploads, fetchImpl }) {
  if (typeof uploads !== "string" || !uploads) throw new ChannelError("incomplete");

  const url = new URL(PLAYLIST_ITEMS_ENDPOINT);

  url.searchParams.set("part", "snippet,status,contentDetails");
  url.searchParams.set("playlistId", uploads);
  url.searchParams.set("maxResults", String(MAX_VIDEOS));

  const r = await call(fetchImpl, url.toString(), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });

  // Chaîne sans aucune vidéo : Google peut répondre « playlist introuvable » au lieu d'une liste vide.
  if (r.status === 404 && r.json?.error?.errors?.[0]?.reason === "playlistNotFound") return { items: [], has_more: false };
  if (!r.ok) throw new ChannelError(errorReason(r.status, r.json));
  if (!Array.isArray(r.json?.items)) throw new ChannelError("incomplete");

  return { items: r.json.items.map(toVideo), has_more: typeof r.json.nextPageToken === "string" };
}

async function fetchChannel({ root, env, fetchImpl }) {
  const conf = readOAuthConfig(env);

  if (!conf.ok) throw new ChannelError("not_configured");
  if (readConnectionMeta({ root }).status !== "connected") throw new ChannelError("not_connected");

  let refreshToken;

  try {
    refreshToken = loadRefreshToken({ root, key: conf.config.tokenKey });
  } catch {
    throw new ChannelError("token_unreadable");
  }

  const accessToken = await accessTokenFor({ config: conf.config, refreshToken, fetchImpl });
  const url = new URL(CHANNELS_ENDPOINT);

  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("mine", "true");

  const r = await call(fetchImpl, url.toString(), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });

  if (!r.ok) throw new ChannelError(errorReason(r.status, r.json));
  if (!Array.isArray(r.json?.items) || r.json.items.length === 0) throw new ChannelError("no_channel");

  const channel = toChannel(r.json.items[0]);
  let videos;

  try {
    videos = { status: "ok", ...(await fetchVideos({ accessToken, uploads: channel.related_playlists.uploads, fetchImpl })) };
  } catch (error) {
    videos = { status: "error", reason: error instanceof ChannelError ? error.reason : "internal_error" };
  }

  return { channel, videos };
}

// Derniers résultats connus, en mémoire : { status: "not_loaded" | "ok" | "error", ... }
// pour la chaîne et pour ses vidéos (une erreur sur la chaîne vaut pour les vidéos).
export function createYoutubeChannel({ root, env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let current = { status: "not_loaded" };
  let videos = { status: "not_loaded" };

  return {
    current: () => current,
    videos: () => videos,

    async refresh() {
      const fetched_at = now().toISOString();

      try {
        const result = await fetchChannel({ root, env, fetchImpl });

        current = { status: "ok", fetched_at, channel: result.channel };
        videos = { fetched_at, ...result.videos };
      } catch (error) {
        current = { status: "error", fetched_at, reason: error instanceof ChannelError ? error.reason : "internal_error" };
        videos = current;
      }

      return current;
    }
  };
}
