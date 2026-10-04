// Commande `npm run youtube-sync` : synchronisation à la demande du miroir local
// de la chaîne YouTube (R20.5, lot 2). Lecture seule sur YouTube ; aucune valeur
// secrète n'est affichée. Mêmes variables YOUTUBE_OAUTH_* que l'agent.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createYouTubeAgent } from "./agent.js";
import { createYoutubeChannel } from "./connectors/youtube/channel.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function runSync({ root = ROOT, env, fetchImpl, now } = {}) {
  const youtubeChannel = createYoutubeChannel({ root, env, fetchImpl, now });
  const agent = createYouTubeAgent({ root, youtubeChannel });

  return agent.youtubeSync();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runSync();

  if (result.status === "ok") {
    const s = result.summary;

    console.log(`Synchronisation YouTube réussie (${result.synced_at})`);
    console.log(`Vidéos présentes : ${s.present} · nouvelles : ${s.added} · modifiées : ${s.updated} · retirées : ${s.removed} · restaurées : ${s.restored}`);
    console.log(`Appels : ${s.calls} · unités de quota YouTube : ${s.quota_units}`);
  } else {
    console.error(`Synchronisation YouTube impossible : ${result.reason}. Le miroir précédent est conservé.`);
    process.exit(1);
  }
}
