// R29.6 — outil de calibration du juge : rapport Markdown et JSON complet
// (jetable, hors pipeline de production). Module PUR : il met en forme des
// métriques déjà calculées (metrics.js) ; aucun calcul d'agrégat, aucun
// import, aucun fichier, aucune horloge.

export const CALIBRATION_RESULTS_VERSION = "judge-calibration-results.v1";

const dash = "—";

const pct = value => (typeof value === "number" ? `${(value * 100).toFixed(1).replace(".", ",")} %` : dash);
const num = (value, digits = 1) => (typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(".", ",")) : dash);
const usd = value => (typeof value === "number" ? `${value.toFixed(4).replace(".", ",")} $` : dash);
const cell = value => String(value ?? dash).replace(/\|/g, "\\|").replace(/\n/g, " ");

const table = (headers, rows) => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map(row => `| ${row.map(cell).join(" | ")} |`)
].join("\n");

const histogramRows = histogram => {
  const rows = Object.entries(histogram ?? {});
  return rows.length === 0 ? [[dash, 0]] : rows;
};

function criterionValue(item) {
  const { value } = item;
  if (value === null || value === undefined) return dash;
  if (item.id === "C3") return `${value.tool_calls} appel(s) pour un plafond de ${value.cap} ; isolation ${value.isolation_ok ? "respectée" : "NON respectée"}`;
  if (item.id === "C7") return `${num(value.mean_calls, 2)} appel(s) en moyenne ; ${value.max_rounds} ronde(s) au maximum`;
  if (item.id === "C8") return usd(value);
  if (item.id === "C2") return String(value);
  return pct(value);
}

const STATUS_LABEL = { PASS: "PASS", FAIL: "FAIL", NOT_EVALUABLE: "non évaluable" };

const distributionRow = (label, stats) => [label, stats.count, num(stats.mean), num(stats.p50), num(stats.p90), num(stats.max)];

// Rapport complet. `data` : { title, identity, corpus, stages, halted, metrics,
// criteria, decision }.
export function renderReport(data) {
  const { identity, corpus, metrics, criteria } = data;
  const lines = [];
  const add = (...items) => lines.push(...items);

  add(`# ${data.title}`, "");
  if (identity.mode !== "real") {
    add(`> **Résultats de SIMULATION** : aucun appel réel n'a été fait. Ces chiffres valident l'outil, pas le juge.`, "");
  }

  add("## 1. Identité de l'essai", "",
    table(["Champ", "Valeur"], [
      ["Mode", identity.mode],
      ["Étapes", (identity.stages ?? []).join(", ") || dash],
      ["HEAD", identity.head ?? dash],
      ["Verrou (lock_sha256)", identity.lock_sha256 ?? dash],
      ["protocol_id", identity.protocol_id ?? dash],
      ["Modèle(s) renvoyé(s)", (metrics.calls.models ?? []).join(", ") || dash],
      ["Plafond d'appels (outil)", identity.cap ?? dash],
      ["Appels passés par l'outil", identity.tool_calls ?? dash],
      ["Corpus", `${corpus.corpus_sha256}`],
      ["Effectifs du corpus (A / B / C)", `${corpus.counts.A} / ${corpus.counts.B} / ${corpus.counts.C}`],
      ["Grille de prix (entrée / sortie, $ par million de tokens)", metrics.usage.prices ? `${metrics.usage.prices.input_per_mtok} / ${metrics.usage.prices.output_per_mtok}` : "non fournie"]
    ]), "");

  if (data.halted) {
    add(`**Arrêt anticipé** : ${data.halted.reason} sur ${data.halted.entry_id}${data.halted.detail ? ` — ${data.halted.detail}` : ""}`, "");
  }

  add("## 2. Verdict sur les critères", "",
    table(["#", "Critère", "Seuil", "Valeur", "Résultat"],
      criteria.map(item => [item.id, item.label, item.threshold,
        criterionValue(item),
        STATUS_LABEL[item.status]])), "");

  add("## 3. Segments", "",
    table(["Indicateur", "Valeur"], [
      ["Entrées dans les résultats principaux", metrics.segments.total],
      ["Segments exécutés / non exécutés", `${metrics.segments.run} / ${metrics.segments.not_run}`],
      ["PASS", `${metrics.segments.pass} (${pct(metrics.segments.pass_rate)})`],
      ["PASS dès la première ronde", `${metrics.segments.pass_round1} (${pct(metrics.segments.pass_round1_rate)})`],
      ["NOT_PASS", metrics.segments.not_pass]
    ]), "",
    table(["Sorte", "Exécutés", "PASS", "Taux"],
      Object.entries(metrics.segments.by_kind).map(([kind, stats]) => [kind, stats.run, stats.pass, pct(stats.pass_rate)])), "",
    "Raisons de NOT_PASS :", "",
    table(["Raison", "Nombre"], histogramRows(metrics.segments.not_pass_reasons)), "",
    table(["Distribution", "N", "Moyenne", "P50", "P90", "Max"], [
      distributionRow("Rondes par segment", metrics.segments.rounds),
      distributionRow("Appels du juge par segment", metrics.segments.calls_per_segment)
    ]), "");

  add("## 4. Appels, tokens, coût", "",
    table(["Indicateur", "Valeur"], [
      ["Jugements enregistrés", metrics.calls.judgments],
      ["Appels comptés par le coordinateur", metrics.calls.coordinator_judge_calls],
      ["Réponses reçues / acceptées / rejetées", `${metrics.calls.replied} / ${metrics.calls.accepted} / ${metrics.calls.rejected}`],
      ["Taux d'acceptation", pct(metrics.calls.accepted_rate)],
      ["Réponses rejouées depuis le cache", metrics.calls.cache_hits],
      ["Arrêts max_tokens / hors bornes / TIMEOUT", `${metrics.calls.max_tokens_stops} / ${metrics.calls.out_of_bounds} / ${metrics.calls.timeouts}`],
      ["Tokens d'entrée / de sortie (appels facturés)", `${metrics.usage.input_tokens} / ${metrics.usage.output_tokens}`],
      ["Coût estimé", usd(metrics.usage.cost_usd)]
    ]), "",
    table(["Distribution (appels facturés)", "N", "Moyenne", "P50", "P90", "Max"], [
      distributionRow("Tokens d'entrée", metrics.calls.input_tokens),
      distributionRow("Tokens de sortie", metrics.calls.output_tokens),
      distributionRow("Durée (ms)", metrics.calls.duration_ms)
    ]), "",
    "Motifs de rejet de la validation :", "",
    table(["Motif", "Nombre"], histogramRows(metrics.calls.rejection_reasons)), "",
    "Raisons d'arrêt des réponses :", "",
    table(["stop_reason", "Nombre"], histogramRows(metrics.calls.stop_reasons)), "");

  add("## 5. Verdicts et DECLARE", "",
    table(["Indicateur", "Valeur"], [
      ["Unités jugées (toutes rondes)", metrics.verdicts.units_judged],
      ["COVERED / UNCOVERED", `${metrics.verdicts.covered} / ${metrics.verdicts.uncovered}`],
      ["Opérations DELETE / DECLARE", `${metrics.verdicts.delete_operations} / ${metrics.verdicts.declare_operations}`],
      ["Part de DECLARE parmi les UNCOVERED", pct(metrics.verdicts.declare_share_of_uncovered)],
      ["Segments avec au moins un DECLARE", metrics.verdicts.segments_with_declare],
      ["Segments bloqués par DECLARE_NOT_SUPPORTED", `${metrics.verdicts.segments_blocked_by_declare} (${pct(metrics.verdicts.segments_blocked_by_declare_rate)})`]
    ]), "");

  add("## 6. Témoins", "",
    table(["Témoin", "Entrées évaluables / total", "Mesure", "Valeur"], [
      ["B — unités injectées détectées", `${metrics.witnesses.B.evaluable} / ${metrics.witnesses.B.entries}`, `${metrics.witnesses.B.detected} sur ${metrics.witnesses.B.injected_units}`, pct(metrics.witnesses.B.recall)],
      ["B — unités d'origine jugées UNCOVERED (fausses alertes)", `${metrics.witnesses.B.evaluable} / ${metrics.witnesses.B.entries}`, `${metrics.witnesses.B.original_false_uncovered} sur ${metrics.witnesses.B.original_units}`, dash],
      ["C — unités jugées COVERED", `${metrics.witnesses.C.evaluable} / ${metrics.witnesses.C.entries}`, `${metrics.witnesses.C.covered} sur ${metrics.witnesses.C.units}`, pct(metrics.witnesses.C.covered_rate)]
    ]), "",
    "Stabilité (rejeu sans cache, verdicts de la ronde 1) :", "",
    table(["Indicateur", "Valeur"], [
      ["Entrées rejouées / comparables", `${metrics.stability.pairs} / ${metrics.stability.comparable_pairs}`],
      ["Unités identiques", `${metrics.stability.agreeing_units} sur ${metrics.stability.units} (${pct(metrics.stability.agreement)})`],
      ["Entrées entièrement identiques", metrics.stability.identical_entries]
    ]), "");

  add("## 7. Unités à relire", "",
    metrics.review.length === 0
      ? "Aucune unité jugée UNCOVERED hors unités injectées."
      : table(["Entrée", "Sorte", "Unité", "Opération", "Texte"],
        metrics.review.map(item => [item.entry_id, item.kind, item.unit_id, item.action === "DECLARE" ? `DECLARE ${item.claim_id}` : item.action, item.text])), "");

  add("## 8. Aide à la décision R29.7 (DECLARE)", "");
  const share = metrics.verdicts.declare_share_of_uncovered;
  const blocked = metrics.verdicts.segments_blocked_by_declare_rate;
  if (identity.mode !== "real") {
    add("Sans objet en simulation.", "");
  } else if (share === null && blocked === null) {
    add("Aucun verdict UNCOVERED : pas de mesure sur DECLARE.", "");
  } else {
    const implement = (share ?? 0) >= 0.1 || (blocked ?? 0) >= 0.1;
    const remove = (share ?? 0) <= 0.02 && (blocked ?? 0) <= 0.02;
    add(`Part de DECLARE : ${pct(share)} ; segments bloqués : ${pct(blocked)}. Règle proposée : ≥ 10 % → implémenter DECLARE ; ≤ 2 % → le retirer du prompt ; entre les deux → décision à prendre ensemble.`,
      `**Orientation chiffrée : ${implement ? "implémenter DECLARE (A)" : remove ? "retirer DECLARE du prompt (B)" : "zone intermédiaire — décision à prendre"}.**`, "");
  }

  add("## 9. Limites", "",
    "- Échantillon petit : les taux sont indicatifs, pas des garanties.",
    "- Les témoins B n'ajoutent qu'une phrase non soutenue en fin de segment ; les témoins C reprennent les claims à l'identique (ordre inversé, phrases d'accroche) : ils mesurent les fausses alertes les plus évidentes, pas la tolérance à une vraie paraphrase.",
    "- La justesse du juge sur les segments naturels n'est pas mesurable sans étiquetage : les unités de la section 7 sont à relire.",
    "- Le coût dépend de la grille de prix fournie ; les relances internes du SDK ne sont pas visibles dans ces chiffres.",
    "- Une réponse rejouée depuis le cache est reconnue à sa durée nulle.", "");

  return `${lines.join("\n")}\n`;
}

// JSON complet des résultats : tout ce qui a servi à produire le rapport.
export function buildResultsDocument({ identity, corpus, halted, records, metrics, criteria }) {
  return {
    version: CALIBRATION_RESULTS_VERSION,
    identity,
    corpus: { version: corpus.version, corpus_sha256: corpus.corpus_sha256, counts: corpus.counts },
    halted: halted ?? null,
    metrics,
    criteria,
    records
  };
}
