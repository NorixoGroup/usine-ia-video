// Commande `npm run youtube-analytics-probe` : sonde de diagnostic YouTube Analytics
// par vidéo (R20.5, sous-lot 4B.0). Lecture seule ; n'écrit rien (ni fichier, ni journal) ;
// affiche seulement les requêtes, les réponses analysées, les erreurs, le coût et le temps.
// Aucune valeur secrète n'est affichée (le jeton d'accès n'apparaît jamais).

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runAnalyticsProbe, PROBE_METRICS } from "./connectors/youtube/analytics-probe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function formatProbe(report) {
  const lines = [];
  const add = (...parts) => lines.push(parts.join(""));

  add("Sonde YouTube Analytics par vidéo (lecture seule, aucune écriture)");
  add(`Exécutée le ${report.at} · fenêtre ${report.window.startDate} → ${report.window.endDate} (${report.window.days} jours, dates du fuseau du Pacifique côté API)`);

  if (report.status !== "ok") {
    add("");
    add(`Sonde impossible : ${report.reason}. Aucune requête Analytics n'a été envoyée.`);
  }

  for (const r of report.requests) {
    add("");
    add(`— ${r.label}`);
    add(`  Paramètres : ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" · ")}`);

    if (r.failure) {
      add(`  Échec avant réponse : ${r.failure} · ${r.ms} ms`);
      continue;
    }

    add(`  HTTP ${r.status} · ${r.ok ? "acceptée" : "refusée"} · ${r.ms} ms`);

    if (!r.ok) {
      add(`  Erreur : code ${r.error.code ?? "?"} · raisons ${r.error.reasons.join(", ") || "aucune"} · ${r.error.message ?? "sans message"}`);
      continue;
    }

    const a = r.analysis;

    add(`  Champs de la réponse : ${a.top_level_keys.join(", ")} · kind ${a.kind ?? "absent"} · rows ${a.rows_field}`);
    add(`  Colonnes : ${a.headers.map(h => `${h.name} (${h.columnType}, ${h.dataType})`).join(" · ") || "aucune"}`);
    add(`  Dimensions acceptées : ${a.dimensions_returned.join(", ") || "aucune"} · métriques renvoyées : ${a.metrics_returned.length}/${PROBE_METRICS.length}`);
    add(`  Lignes : ${a.row_count} · vidéos distinctes : ${a.video_ids.length} · jours distincts : ${a.days.length}`);
    for (const row of a.sample_rows) add(`  Exemple : ${row.map(String).join(" | ")}`);
  }

  const c = report.conclusions;

  if (c) {
    add("");
    add("Réponses aux questions");
    add(`  Q1 dimension video sur un seul jour : ${c.q1_video_single_day}`);
    add("  Q3 métriques (dimension video / filtre video==ID) :");
    for (const m of c.q3_metrics) add(`     ${m.metric} : ${m.with_video} / ${m.with_video_filter}`);
    add(`  Q4 jours sans données : ${c.q4_days ? `${c.q4_days.subject} · ${c.q4_days.returned} jour(s) renvoyé(s) sur ${c.q4_days.expected}, ${c.q4_days.missing} absent(s) · rows ${c.q4_days.rows_field}` : "non déterminé (R3 refusée)"}`);
    add(`  Q5 vidéos privées : ${c.q5_private.returned} renvoyée(s) · ${c.q5_private.in_mirror} dans le miroir · ${c.q5_private.in_mirror_not_returned} du miroir absente(s) des réponses`);
    add(`  Q6 vidéos non répertoriées : ${c.q6_unlisted.returned} renvoyée(s) · ${c.q6_unlisted.in_mirror} dans le miroir · ${c.q6_unlisted.in_mirror_not_returned} du miroir absente(s) des réponses`);
    add(`  Vidéos publiques : ${c.public.returned} renvoyée(s) · ${c.public.in_mirror} dans le miroir · vidéos absentes du miroir : ${c.absent_from_mirror}`);
    add(`  Q7 aucune vidéo : ${c.q7_no_video ? `R1 renvoie ${c.q7_no_video.row_count_r1 ?? "?"} ligne(s), champ rows ${c.q7_no_video.rows_field_r1 ?? "?"}` : "sans objet (des vidéos ont été renvoyées)"}`);
  }

  add("");
  add(`Q8 appels Google : ${report.calls} (dont ${report.analytics_requests} requête(s) Analytics${report.calls > report.analytics_requests ? " et 1 échange de jeton" : ""})`);
  add(`Q9 temps : ${report.total_ms} ms au total${report.token_ms !== undefined ? ` · jeton ${report.token_ms} ms` : ""}${report.requests.length ? ` · requêtes ${report.requests.map(r => `${r.ms} ms`).join(", ")}` : ""}`);
  add("Q10 coût : 0 $ · 0 unité de quota YouTube Data · aucun appel Anthropic");
  add("Aucune donnée n'a été écrite.");

  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAnalyticsProbe({ root: ROOT });

  console.log(formatProbe(report));
  if (report.status !== "ok") process.exit(1);
}
