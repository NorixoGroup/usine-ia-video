// Suite Analytics (R20.6) : synchronisation à la demande du bloc complet, en lecture seule.
//
// Ordre : chaîne (lot 4A), répartitions sur 28 jours, vidéos (lot 4B, index compris).
// Chaque étape garde ses fichiers, son bail et ses règles d'échec ; un échec n'empêche
// pas les étapes suivantes, sauf cause commune à toutes (configuration, connexion,
// scope, jeton), auquel cas aucune autre requête n'est envoyée.
// Même interface que le lecteur du lot 4A (summary/sync) : l'agent et le bouton local
// l'utilisent sans changement de contrat. Jamais lancée au démarrage.

import { createYoutubeAnalytics, analyticsSummary } from "./analytics.js";
import { createYoutubeVideoAnalytics, videoAnalyticsSummary } from "./video-analytics.js";
import { syncBreakdowns, readBreakdowns } from "./breakdowns.js";

// Causes communes : inutile d'interroger les étapes suivantes.
const SHARED_FAILURES = new Set(["not_configured", "not_connected", "scope_missing", "token_revoked", "token_refused", "token_unreadable"]);

export function analyticsSuiteSummary(root) {
  return { ...analyticsSummary(root), videos: videoAnalyticsSummary(root), breakdowns: readBreakdowns(root) ?? { status: "not_loaded" } };
}

export function createYoutubeAnalyticsSuite({ root, env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const channel = createYoutubeAnalytics({ root, env, fetchImpl, now });
  const videos = createYoutubeVideoAnalytics({ root, env, fetchImpl, now });
  let running = null;

  async function run() {
    const steps = { channel: await channel.sync() };

    if (steps.channel.status !== "ok" && SHARED_FAILURES.has(steps.channel.reason)) {
      const skipped = { status: "skipped", reason: steps.channel.reason };

      return { status: "error", at: steps.channel.at, reason: steps.channel.reason, summary: null, steps: { ...steps, breakdowns: skipped, videos: skipped } };
    }

    steps.breakdowns = await syncBreakdowns({ root, env, fetchImpl, now });
    steps.videos = await videos.sync();

    const failed = Object.values(steps).filter(step => step.status !== "ok");
    const status = failed.length === 0 ? "ok" : failed.length === 3 ? "error" : "partial";

    return {
      status,
      ...(status === "ok" ? { synced_at: steps.channel.synced_at } : { at: now().toISOString(), reason: failed[0].reason }),
      summary: steps.channel.summary ?? null,
      steps
    };
  }

  return {
    summary: () => analyticsSuiteSummary(root),

    // Une seule synchronisation du bloc à la fois dans ce processus.
    sync() {
      running ??= run().finally(() => { running = null; });

      return running;
    }
  };
}
