// Vues de lecture du bloc Analytics (R20.6) : local uniquement, aucun réseau, aucune écriture.
//
// Sources : chaîne (lot 4A), index par vidéo (lot 4B), répartitions, miroir, registre
// et productions. Le titre n'est jamais une clé : seul `video_id` relie les données.
// Les vidéos `test` (registre) et retirées (miroir) sont exclues des classements.

import { analyticsSummary } from "../connectors/youtube/analytics.js";
import { videoAnalyticsSummary, readVideoDaily } from "../connectors/youtube/video-analytics.js";
import { readBreakdowns } from "../connectors/youtube/breakdowns.js";
import { readMirror } from "../connectors/youtube/mirror.js";
import { loadRegistry } from "../videos-registry.js";
import { listProductions } from "../productions-reader.js";
import { VIDEO_ID_PATTERN } from "../config.js";
import { proposeLinks, productionLineage } from "./linking.js";

export const RANKING_SIZE = 5;
export const VIDEO_DETAIL_DAYS = 90;

function mirrorVideoList(root) {
  const list = readMirror(root).videos?.videos;

  return (Array.isArray(list) ? list : [])
    .filter(v => typeof v?.video_id === "string" && VIDEO_ID_PATTERN.test(v.video_id))
    .map(v => ({ video_id: v.video_id, title: typeof v.title === "string" ? v.title : null, published_at: typeof v.published_at === "string" ? v.published_at : null, privacy_status: v.privacy_status ?? null, mirror_status: v.mirror_status === "removed" ? "removed" : "present" }));
}

const registryByVideo = registry => new Map(registry.videos.filter(v => v.video_id).map(v => [v.video_id, v]));

function rankingItem(video, link) {
  return {
    video_id: video.video_id,
    title: video.title,
    privacy_status: video.privacy_status,
    views: video.totals.views,
    watch_time_minutes: video.totals.watch_time_minutes,
    average_view_percentage: video.totals.average_view_percentage,
    production_id: link?.production_id ?? null
  };
}

// Meilleures et moins bonnes vidéos sur les 28 derniers jours lus (sans recouvrement).
export function rankVideos({ videos, registry }) {
  const links = registryByVideo(registry);
  const eligible = videos.filter(v => v.mirror_status !== "removed" && v.days_stored > 0 && links.get(v.video_id)?.type !== "test");
  const byViews = [...eligible].sort((a, b) => b.totals.views - a.totals.views || a.video_id.localeCompare(b.video_id));
  const top = byViews.slice(0, RANKING_SIZE);
  const worst = byViews.slice(top.length).reverse().slice(0, RANKING_SIZE);

  return { eligible: eligible.length, top: top.map(v => rankingItem(v, links.get(v.video_id))), worst: worst.map(v => rankingItem(v, links.get(v.video_id))) };
}

function videoSummaryWithRegistry(root, channelId) {
  return { videos: videoAnalyticsSummary(root), registry: loadRegistry({ root, channelId }) };
}

export function analyticsOverview({ root, channelId }) {
  const { videos, registry } = videoSummaryWithRegistry(root, channelId);
  const ranking = videos.status === "ok" ? rankVideos({ videos: videos.videos, registry }) : null;

  return {
    channel: analyticsSummary(root),
    breakdowns: readBreakdowns(root) ?? { status: "not_loaded" },
    videos: videos.status === "ok"
      ? { status: "ok", synced_at: videos.synced_at, tracked: videos.videos_tracked, eligible: ranking.eligible, top: ranking.top, worst: ranking.worst, ...(videos.last_error ? { last_error: videos.last_error } : {}) }
      : videos,
    links: { linked_videos: registry.videos.filter(v => v.video_id).length, proposals: analyticsLinkProposals({ root, channelId }).length }
  };
}

export function analyticsLinkProposals({ root, channelId }) {
  return proposeLinks({ productions: listProductions({ root }).shown, registry: loadRegistry({ root, channelId }), videos: mirrorVideoList(root) });
}

// Fiche d'une vidéo : analytiques, miroir, liaison et filiation de la production.
export function analyticsVideo({ root, channelId, videoId }) {
  if (typeof videoId !== "string" || !VIDEO_ID_PATTERN.test(videoId)) return { status: "invalid" };

  const { videos, registry } = videoSummaryWithRegistry(root, channelId);
  const analytics = videos.status === "ok" ? videos.videos.find(v => v.video_id === videoId) ?? null : null;
  const mirror = mirrorVideoList(root).find(v => v.video_id === videoId) ?? null;

  if (!analytics && !mirror) return { status: "not_found" };

  const link = registryByVideo(registry).get(videoId) ?? null;
  const production = link ? listProductions({ root }).shown.find(p => p.id === link.production_id) ?? null : null;
  const daily = readVideoDaily(root, videoId);

  return {
    status: "ok",
    video_id: videoId,
    title: analytics?.title ?? mirror?.title ?? null,
    privacy_status: analytics?.privacy_status ?? mirror?.privacy_status ?? null,
    published_at: analytics?.published_at ?? mirror?.published_at ?? null,
    mirror_status: analytics?.mirror_status ?? mirror?.mirror_status ?? "unknown",
    analytics: analytics ? { data_until: analytics.data_until, days_stored: analytics.days_stored, recent: analytics.totals, lifetime: analytics.lifetime, ...(analytics.last_error ? { last_error: analytics.last_error } : {}) } : { status: "not_loaded" },
    daily: daily.slice(-VIDEO_DETAIL_DAYS),
    link: link ? { production_id: link.production_id, type: link.type } : null,
    lineage: production ? productionLineage({ root, production, entry: link }) : null
  };
}

// Performance par production liée (registre) : analytiques de sa vidéo et filiation.
export function analyticsProductions({ root, channelId }) {
  const { videos, registry } = videoSummaryWithRegistry(root, channelId);
  const byVideo = new Map(videos.status === "ok" ? videos.videos.map(v => [v.video_id, v]) : []);
  const productions = new Map(listProductions({ root }).shown.map(p => [p.id, p]));

  return registry.videos.filter(entry => entry.video_id).map(entry => {
    const video = byVideo.get(entry.video_id) ?? null;
    const lineage = productionLineage({ root, production: productions.get(entry.production_id) ?? null, entry });

    return {
      production_id: entry.production_id,
      title: productions.get(entry.production_id)?.title ?? null,
      type: entry.type,
      video_id: entry.video_id,
      video_title: video?.title ?? null,
      recent: video?.totals ?? null,
      lifetime: video?.lifetime ?? null,
      artifacts: lineage ? Object.fromEntries(Object.entries(lineage.artifacts).map(([name, a]) => [name, a.present])) : null
    };
  }).sort((a, b) => (b.recent?.views ?? -1) - (a.recent?.views ?? -1) || a.production_id.localeCompare(b.production_id));
}

// Modèle préparé pour le Dashboard (cartes et listes d'AnalyticsBoard). Non exposé par le
// pont en R20.6 : la route `analytics` du pont reste inchangée (not_connected).
const DASHBOARD_CARDS = Object.freeze([
  ["ctr", "CTR"], ["watch_time", "Watch Time"], ["retention", "Retention"], ["subscribers", "Subscribers"], ["views", "Views"], ["revenue", "Revenue"]
]);
const NOT_AVAILABLE = { ctr: "reporting_api_not_integrated", revenue: "excluded" };

export function analyticsDashboard({ root, channelId }) {
  const overview = analyticsOverview({ root, channelId });
  const c = overview.channel;
  const values = c.status === "ok"
    ? { watch_time: c.totals.watch_time_minutes, retention: c.totals.average_view_percentage, subscribers: c.totals.subscribers_net, views: c.totals.views }
    : {};
  const units = { watch_time: "minutes", retention: "percent", subscribers: "count", views: "count" };
  const list = items => overview.videos.status === "ok" ? { status: "ok", items } : { status: overview.videos.status, items: [] };

  return {
    source: c.status === "ok" ? "local_analytics" : c.status,
    synced_at: c.status === "ok" ? c.synced_at : null,
    data_until: c.status === "ok" ? c.data_until : null,
    period: c.status === "ok" ? c.period : null,
    cards: DASHBOARD_CARDS.map(([key, label]) => NOT_AVAILABLE[key]
      ? { key, label, status: "not_available", reason: NOT_AVAILABLE[key], value: null }
      : c.status === "ok" && values[key] !== null
        ? { key, label, status: "ok", value: values[key], unit: units[key] }
        : { key, label, status: c.status === "ok" ? "no_data" : c.status, value: null }),
    top_videos: list(overview.videos.top ?? []),
    worst_videos: list(overview.videos.worst ?? []),
    breakdowns: overview.breakdowns.dimensions
      ? Object.fromEntries(Object.entries(overview.breakdowns.dimensions).map(([name, d]) => [name, d.status === "ok" ? { status: "ok", rows: d.rows.slice(0, 10) } : { status: d.status, rows: [] }]))
      : { status: "not_loaded" }
  };
}
