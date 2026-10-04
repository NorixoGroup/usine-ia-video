// Commande `npm run youtube-analytics` : synchronisation à la demande du bloc Analytics
// complet (R20.6) : chaîne, répartitions sur 28 jours, vidéos et index. Lecture seule ;
// le miroir est seulement lu ; aucune valeur secrète n'est affichée. Journalisée par l'agent.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createYouTubeAgent, stepsDetail } from "./agent.js";
import { createYoutubeAnalyticsSuite } from "./connectors/youtube/analytics-suite.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function runAnalytics({ root = ROOT, env, fetchImpl, now } = {}) {
  const youtubeAnalytics = createYoutubeAnalyticsSuite({ root, env, fetchImpl, now });

  return createYouTubeAgent({ root, youtubeAnalytics }).youtubeAnalyticsSync();
}

export function formatAnalytics(result) {
  const { channel, breakdowns, videos } = result.steps ?? {};
  const lines = [];
  const status = { ok: "réussie", partial: "partielle", error: "impossible" }[result.status] ?? result.status;

  lines.push(`Synchronisation du bloc Analytics ${status}${result.reason ? ` (${result.reason})` : ""}. Les données déjà enregistrées sont conservées en cas d'échec.`);

  if (channel) {
    const s = channel.summary;
    lines.push(`Chaîne : ${channel.status === "ok" ? `${s.days_received} jour(s) reçus, ${s.start_date} → ${s.end_date} (fuseau du Pacifique), ${s.calls} appels` : `échec (${channel.reason})`}`);
  }
  if (breakdowns) {
    const s = breakdowns.summary;
    lines.push(`Répartitions : ${s ? `${s.dimensions_ok} dimension(s) lue(s), ${s.dimensions_failed} en échec, ${s.calls} appels` : breakdowns.status === "skipped" ? "non lancées" : `échec (${breakdowns.reason})`}`);
  }
  if (videos) {
    const s = videos.summary;
    lines.push(`Vidéos : ${s ? `${s.synced} synchronisée(s), ${s.failed} en échec, ${s.skipped} reportée(s), ${s.days_received} jour(s), ${s.calls} appels` : videos.status === "skipped" ? "non lancées" : `échec (${videos.reason})`}`);
  }
  if (result.steps) lines.push(`Résumé : ${stepsDetail(result.steps)}`);

  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAnalytics();
  const text = formatAnalytics(result);

  if (result.status === "error") {
    console.error(text);
    process.exit(1);
  }

  console.log(text);
}
