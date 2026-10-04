// Commande `npm run youtube-analytics-sync` : synchronisation à la demande des
// analytiques de la chaîne (R20.5, lot 4A). Lecture seule (API YouTube Analytics) ;
// le miroir YouTube n'est pas touché ; aucune valeur secrète n'est affichée.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createYouTubeAgent } from "./agent.js";
import { createYoutubeAnalytics } from "./connectors/youtube/analytics.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function runAnalyticsSync({ root = ROOT, env, fetchImpl, now } = {}) {
  const youtubeAnalytics = createYoutubeAnalytics({ root, env, fetchImpl, now });
  const agent = createYouTubeAgent({ root, youtubeAnalytics });

  return agent.youtubeAnalyticsSync();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAnalyticsSync();

  if (result.status === "ok") {
    const s = result.summary;

    console.log(`Synchronisation des analytiques réussie (${result.synced_at})`);
    console.log(`Période : ${s.start_date} → ${s.end_date} (fuseau du Pacifique) · jours reçus : ${s.days_received}`);
    console.log(`Appels : ${s.calls} · requêtes Analytics : ${s.analytics_requests}`);
  } else {
    console.error(`Synchronisation des analytiques impossible : ${result.reason}. Les données précédentes sont conservées.`);
    process.exit(1);
  }
}
