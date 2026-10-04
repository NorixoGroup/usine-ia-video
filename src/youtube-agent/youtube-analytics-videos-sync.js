// Commande `npm run youtube-analytics-videos-sync` : synchronisation à la demande des
// analytiques par vidéo (R20.5, lot 4B). Lecture seule (API YouTube Analytics) ; le miroir
// est seulement lu ; aucune valeur secrète n'est affichée. Journalisée dans le journal de l'agent.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_CHANNEL_ID } from "./config.js";
import { appendJournal } from "./journal.js";
import { createYoutubeVideoAnalytics } from "./connectors/youtube/video-analytics.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function runVideoAnalyticsSync({ root = ROOT, env, fetchImpl, now = () => new Date() } = {}) {
  const result = await createYoutubeVideoAnalytics({ root, env, fetchImpl, now }).sync();
  const s = result.summary;

  appendJournal({
    root, channelId: DEFAULT_CHANNEL_ID, now: now(),
    entry: {
      type: "youtube_video_analytics_sync",
      action: "sync",
      outcome: result.status === "ok" ? "ok" : result.reason,
      ...(s ? { detail: `${s.synced} vidéo(s) synchronisée(s), ${s.failed} en échec, ${s.skipped} reportée(s) ; ${s.days_received} jours ; ${s.calls} appels, ${s.analytics_requests} requêtes Analytics` } : {})
    }
  });

  return result;
}

export function formatVideoAnalyticsSync(result) {
  const s = result.summary;
  const lines = [];

  if (result.status === "ok") lines.push(`Synchronisation des analytiques par vidéo réussie (${result.synced_at})`);
  else lines.push(`Synchronisation des analytiques par vidéo ${s ? "interrompue" : "impossible"} : ${result.reason}. Les données déjà enregistrées sont conservées.`);

  if (s) {
    lines.push(`Liste : ${s.list_start_date} → ${s.list_end_date} (fuseau du Pacifique) · ${s.listed} vidéo(s) actives${s.list_truncated ? " (page pleine : la liste peut être incomplète, complétée par le miroir)" : ""} · ${s.from_mirror} ajoutée(s) depuis le miroir`);
    lines.push(`Vidéos : ${s.selected} traitée(s) · ${s.synced} synchronisée(s) · ${s.failed} en échec · ${s.skipped} reportée(s) · ${s.days_received} jour(s) reçus`);
    lines.push(`Appels : ${s.calls} · requêtes Analytics : ${s.analytics_requests}`);
  }

  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runVideoAnalyticsSync();
  const text = formatVideoAnalyticsSync(result);

  if (result.status === "ok") {
    console.log(text);
  } else {
    console.error(text);
    process.exit(1);
  }
}
