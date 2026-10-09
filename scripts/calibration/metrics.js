// R29.6 — outil de calibration du juge : calcul des métriques et des critères
// de réussite (jetable, hors pipeline de production). Module PUR : aucun
// import, aucun réseau, aucun fichier, aucune horloge. Toutes les statistiques
// sont calculées à partir des condensés d'exécution (runner.js : digestRun).

export const CALIBRATION_METRICS_VERSION = "judge-calibration-metrics.v1";

// Seuils validés (R29.6, critères C1 à C8). Modifiables par l'appelant.
export const CRITERIA_THRESHOLDS = Object.freeze({
  accepted_first_try: 0.98,
  witness_b_recall: 0.9,
  witness_c_covered: 0.9,
  stability: 0.95,
  mean_calls_per_segment: 2,
  max_rounds: 4
});

// R29.6b — règle de décision sur DECLARE (R29.7, D4) : minimum de preuves avant
// toute recommandation, puis seuils sur la part de DECLARE des segments A.
export const DECISION_RULE = Object.freeze({
  min_uncovered_total: 25,
  min_uncovered_a: 10,
  declare_share_implement: 0.1,
  declare_share_remove: 0.02,
  usable_rate_implement: 0.7
});

export const REVIEW_VERSION = "judge-calibration-review.v1";

const rate = (part, total) => (total > 0 ? part / total : null);

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Rang le plus proche (méthode « nearest rank ») : p dans ]0, 100].
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const distribution = values => ({
  count: values.length,
  mean: mean(values),
  p50: percentile(values, 50),
  p90: percentile(values, 90),
  max: values.length === 0 ? null : Math.max(...values)
});

const histogram = labels => {
  const counts = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  return Object.fromEntries(Object.keys(counts).sort().map(key => [key, counts[key]]));
};

const firstJudged = record => {
  const judgment = record.rounds?.[0]?.judgment ?? null;
  return judgment?.status === "JUDGED" ? judgment : null;
};

function callsOf(record) {
  const calls = [];
  for (const round of record.rounds ?? []) {
    const judgment = round.judgment;
    if (!judgment) continue;
    const replied = judgment.usage !== null || judgment.status === "JUDGED";
    calls.push({
      entry_id: record.entry_id,
      kind: record.kind,
      stability_run: record.stability_run === true,
      round: round.round,
      status: judgment.status,
      replied,
      accepted: judgment.status === "JUDGED",
      request_sha256: judgment.request_sha256,
      usage: judgment.usage,
      failure: judgment.failure,
      // Une réponse rejouée depuis le cache est livrée avec duree 0.
      cache_hit: judgment.usage?.duration_ms === 0
    });
  }
  return calls;
}

const isTimeout = call => /TIMEOUT/.test(`${call.failure?.reason ?? ""}`);

// ---------------------------------------------------------------------------

// Relecture « utilisable » des DECLARE : liste d'éléments { review_id, usable,
// note }, ou document { items }. Renvoie les éléments normalisés et les
// anomalies (vide si tout est valide).
export function normalizeReviews(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : null;
  if (list === null) return { reviews: [], issues: ["relecture : tableau d'éléments attendu"] };
  const issues = [];
  const seen = new Set();
  const reviews = [];
  list.forEach((item, index) => {
    if (typeof item?.review_id !== "string" || item.review_id === "") {
      issues.push(`élément ${index + 1} : review_id absent`);
      return;
    }
    if (seen.has(item.review_id)) issues.push(`${item.review_id} : en double`);
    seen.add(item.review_id);
    if (![true, false, null].includes(item.usable ?? null)) issues.push(`${item.review_id} : usable doit valoir true, false ou null`);
    reviews.push({ review_id: item.review_id, usable: item.usable ?? null, note: typeof item.note === "string" ? item.note : "" });
  });
  return { reviews, issues };
}

const KINDS = ["A", "B", "C"];

// Verdicts d'une sorte de segment, toutes rondes confondues.
function verdictsOfKind(records, kind) {
  const ofKind = records.filter(record => record.kind === kind);
  const list = ofKind.flatMap(record => (record.rounds ?? []).flatMap(round => round.judgment?.status === "JUDGED" ? round.judgment.verdicts : []));
  const uncovered = list.filter(item => item.verdict === "UNCOVERED");
  const declares = uncovered.filter(item => item.action === "DECLARE");
  const ran = ofKind.filter(record => record.result !== null);
  return {
    segments: ofKind.length,
    units_judged: list.length,
    covered: list.filter(item => item.verdict === "COVERED").length,
    uncovered: uncovered.length,
    delete_operations: uncovered.filter(item => item.action === "DELETE").length,
    declare_operations: declares.length,
    declare_share_of_uncovered: rate(declares.length, uncovered.length),
    segments_with_declare: ofKind.filter(record => (record.rounds ?? []).some(round => round.judgment?.verdicts?.some(item => item.action === "DECLARE"))).length,
    segments_blocked_by_declare: ofKind.filter(record => (record.rounds ?? []).some(round => round.repair?.refusal?.code === "DECLARE_NOT_SUPPORTED")).length,
    segments_run: ran.length
  };
}

// Chaque DECLARE : texte d'origine de l'unité, claim désigné, key_fact du
// claim et alertes (claim inconnu ou non vérifié, doublon dans le segment).
function declareItemsOf(records, reviews) {
  const reviewOf = new Map(reviews.map(item => [item.review_id, item]));
  const items = [];
  for (const record of records) {
    for (const round of record.rounds ?? []) {
      if (round.judgment?.status !== "JUDGED") continue;
      const units = round.units ?? (round.round === 1 ? record.units_round1 : null) ?? null;
      for (const verdict of round.judgment.verdicts.filter(entry => entry.action === "DECLARE")) {
        const index = Number(/-c(\d+)$/.exec(verdict.claim_id ?? "")?.[1] ?? 0);
        const claim = index > 0 ? (record.claims ?? [])[index - 1] ?? null : null;
        const unit = units?.find(candidate => candidate.unit_id === verdict.unit_id) ?? null;
        const claimText = typeof claim?.text === "string" ? claim.text.trim() : null;
        const reviewId = `${record.entry_id}/r${round.round}/${verdict.unit_id}`;
        const review = reviewOf.get(reviewId) ?? null;
        items.push({
          review_id: reviewId,
          entry_id: record.entry_id,
          kind: record.kind,
          round: round.round,
          unit_id: verdict.unit_id,
          claim_id: verdict.claim_id,
          original_text: unit?.text ?? null,
          claim_text: claimText,
          key_fact_text: typeof claim?.key_fact === "string" ? claim.key_fact : null,
          flags: {
            claim_found: claim !== null,
            claim_unverified: claim?.is_unverified === true,
            duplicate_in_segment: units && claimText ? units.some(other => other.unit_id !== verdict.unit_id && other.text.includes(claimText)) : null
          },
          usable: review?.usable ?? null,
          note: review?.note ?? ""
        });
      }
    }
  }
  return items;
}

// Recommandation sur DECLARE (règle D4). Jamais avant le minimum de preuves.
function recommendationOf({ evidence, byKind, items, reviewIssues }) {
  if (!evidence.sufficient) {
    return { status: "INSUFFICIENT_EVIDENCE", share_a: null, usable_rate_a: null, pending_a: null, basis: `UNCOVERED ${evidence.uncovered_total}/${evidence.required_total}, dont A ${evidence.uncovered_a}/${evidence.required_a}` };
  }
  const share = byKind.A.declare_share_of_uncovered;
  const itemsA = items.filter(item => item.kind === "A");
  const reviewedA = itemsA.filter(item => typeof item.usable === "boolean");
  const usableRate = rate(reviewedA.filter(item => item.usable).length, reviewedA.length);
  const pending = itemsA.length - reviewedA.length;
  const result = (status, basis) => ({ status, share_a: share, usable_rate_a: usableRate, pending_a: pending, basis });
  if (reviewIssues.length > 0) return result("REVIEW_INCOMPLETE", "relecture invalide");
  if (share <= DECISION_RULE.declare_share_remove) return result("RECOMMEND_B", "DECLARE rare sur les segments A");
  if (share >= DECISION_RULE.declare_share_implement) {
    if (pending > 0) return result("REVIEW_INCOMPLETE", `${pending} DECLARE de segments A à relire`);
    return usableRate >= DECISION_RULE.usable_rate_implement
      ? result("RECOMMEND_A", "DECLARE fréquent et utilisable")
      : result("RECOMMEND_B", "DECLARE fréquent mais peu utilisable");
  }
  return result("INTERMEDIATE", "part de DECLARE entre les deux seuils");
}

export function computeMetrics(records, { prices = null, reviews = [] } = {}) {
  const all = Array.isArray(records) ? records : [];
  const main = all.filter(record => record.stability_run !== true);
  const stabilityRecords = all.filter(record => record.stability_run === true);

  const ran = main.filter(record => record.result !== null);
  const passed = ran.filter(record => record.result.status === "PASS");
  const kinds = ["A", "B", "C"];

  const reasons = histogram(main
    .filter(record => record.result?.status === "NOT_PASS" || record.result === null)
    .map(record => record.result?.reason ?? record.gate?.failure?.reason ?? "INCONNUE"));

  const segments = {
    total: main.length,
    run: ran.length,
    not_run: main.length - ran.length,
    pass: passed.length,
    not_pass: ran.length - passed.length,
    pass_rate: rate(passed.length, ran.length),
    pass_round1: passed.filter(record => record.result.rounds === 1).length,
    pass_round1_rate: rate(passed.filter(record => record.result.rounds === 1).length, ran.length),
    by_kind: Object.fromEntries(kinds.map(kind => {
      const ofKind = ran.filter(record => record.kind === kind);
      const ok = ofKind.filter(record => record.result.status === "PASS").length;
      return [kind, { run: ofKind.length, pass: ok, pass_rate: rate(ok, ofKind.length) }];
    })),
    not_pass_reasons: reasons,
    rounds: distribution(ran.map(record => record.result.rounds)),
    calls_per_segment: distribution(ran.map(record => record.result.judge_calls))
  };

  // Appels : tout ce qui a un jugement, y compris les passes de stabilité.
  const calls = all.flatMap(callsOf);
  const replied = calls.filter(call => call.replied);
  const billed = calls.filter(call => call.usage !== null && !call.cache_hit);
  const inputTokens = billed.reduce((sum, call) => sum + (call.usage.input_tokens ?? 0), 0);
  const outputTokens = billed.reduce((sum, call) => sum + (call.usage.output_tokens ?? 0), 0);

  const callStats = {
    judgments: calls.length,
    coordinator_judge_calls: all.reduce((sum, record) => sum + (record.result?.judge_calls ?? 0), 0),
    replied: replied.length,
    accepted: replied.filter(call => call.accepted).length,
    accepted_rate: rate(replied.filter(call => call.accepted).length, replied.length),
    rejected: replied.filter(call => !call.accepted).length,
    cache_hits: calls.filter(call => call.cache_hit).length,
    max_tokens_stops: calls.filter(call => call.usage?.stop_reason === "max_tokens").length,
    out_of_bounds: calls.filter(call => call.failure?.category === "OUT_OF_BOUNDS").length,
    timeouts: calls.filter(isTimeout).length,
    rejection_reasons: histogram(replied.filter(call => !call.accepted).map(call => call.failure?.reason ?? "INCONNUE")),
    stop_reasons: histogram(calls.filter(call => call.usage).map(call => call.usage.stop_reason ?? "INCONNU")),
    models: [...new Set(calls.filter(call => call.usage?.model).map(call => call.usage.model))].sort(),
    input_tokens: distribution(billed.map(call => call.usage.input_tokens ?? 0)),
    output_tokens: distribution(billed.map(call => call.usage.output_tokens ?? 0)),
    duration_ms: distribution(billed.map(call => call.usage.duration_ms ?? 0))
  };

  // Verdicts, toutes rondes confondues (segments principaux).
  const verdictLists = main.flatMap(record => (record.rounds ?? []).flatMap(round => round.judgment?.status === "JUDGED" ? round.judgment.verdicts : []));
  const uncovered = verdictLists.filter(item => item.verdict === "UNCOVERED");
  const declares = uncovered.filter(item => item.action === "DECLARE");
  const verdicts = {
    units_judged: verdictLists.length,
    covered: verdictLists.filter(item => item.verdict === "COVERED").length,
    uncovered: uncovered.length,
    delete_operations: uncovered.filter(item => item.action === "DELETE").length,
    declare_operations: declares.length,
    declare_share_of_uncovered: rate(declares.length, uncovered.length),
    segments_with_declare: main.filter(record => (record.rounds ?? []).some(round => round.judgment?.verdicts?.some(item => item.action === "DECLARE"))).length,
    segments_blocked_by_declare: main.filter(record => (record.rounds ?? []).some(round => round.repair?.refusal?.code === "DECLARE_NOT_SUPPORTED")).length
  };
  verdicts.segments_blocked_by_declare_rate = rate(verdicts.segments_blocked_by_declare, ran.length);

  // Témoins B : les unités injectées (début ≥ injected_start) doivent être
  // jugées UNCOVERED à la ronde 1 ; les autres ne devraient pas l'être.
  const witnessB = { entries: 0, evaluable: 0, injected_units: 0, detected: 0, recall: null, original_units: 0, original_false_uncovered: 0 };
  for (const record of main.filter(item => item.kind === "B")) {
    witnessB.entries += 1;
    const judged = firstJudged(record);
    if (!judged) continue;
    witnessB.evaluable += 1;
    const verdictOf = new Map(judged.verdicts.map(item => [item.unit_id, item.verdict]));
    for (const unit of record.units_round1 ?? []) {
      if (!verdictOf.has(unit.unit_id)) continue;
      if (unit.start >= record.expect.injected_start) {
        witnessB.injected_units += 1;
        if (verdictOf.get(unit.unit_id) === "UNCOVERED") witnessB.detected += 1;
      } else {
        witnessB.original_units += 1;
        if (verdictOf.get(unit.unit_id) === "UNCOVERED") witnessB.original_false_uncovered += 1;
      }
    }
  }
  witnessB.recall = rate(witnessB.detected, witnessB.injected_units);

  // Témoins C : tout doit être COVERED à la ronde 1.
  const witnessC = { entries: 0, evaluable: 0, units: 0, covered: 0, covered_rate: null, false_uncovered: 0 };
  for (const record of main.filter(item => item.kind === "C")) {
    witnessC.entries += 1;
    const judged = firstJudged(record);
    if (!judged) continue;
    witnessC.evaluable += 1;
    witnessC.units += judged.verdicts.length;
    witnessC.covered += judged.verdicts.filter(item => item.verdict === "COVERED").length;
  }
  witnessC.false_uncovered = witnessC.units - witnessC.covered;
  witnessC.covered_rate = rate(witnessC.covered, witnessC.units);

  // Stabilité : même entrée rejouée sans cache, verdicts de la ronde 1.
  const stability = { pairs: 0, comparable_pairs: 0, units: 0, agreeing_units: 0, agreement: null, identical_entries: 0 };
  for (const record of stabilityRecords) {
    const original = main.find(item => item.entry_id === record.entry_id);
    stability.pairs += 1;
    const a = original ? firstJudged(original) : null;
    const b = firstJudged(record);
    if (!a || !b) continue;
    stability.comparable_pairs += 1;
    const other = new Map(b.verdicts.map(item => [item.unit_id, item.verdict]));
    let agreeing = 0;
    for (const item of a.verdicts) if (other.get(item.unit_id) === item.verdict) agreeing += 1;
    stability.units += a.verdicts.length;
    stability.agreeing_units += agreeing;
    if (agreeing === a.verdicts.length && a.verdicts.length === b.verdicts.length) stability.identical_entries += 1;
  }
  stability.agreement = rate(stability.agreeing_units, stability.units);

  const cost = prices && Number.isFinite(prices.input_per_mtok) && Number.isFinite(prices.output_per_mtok)
    ? (inputTokens / 1e6) * prices.input_per_mtok + (outputTokens / 1e6) * prices.output_per_mtok
    : null;

  // Unités UNCOVERED des segments naturels et fausses alertes des témoins : à relire.
  const review = [];
  for (const record of main) {
    const judged = firstJudged(record);
    if (!judged) continue;
    const textOf = new Map((record.units_round1 ?? []).map(unit => [unit.unit_id, unit]));
    for (const item of judged.verdicts.filter(entry => entry.verdict === "UNCOVERED")) {
      const unit = textOf.get(item.unit_id);
      const injected = record.kind === "B" && unit && unit.start >= record.expect.injected_start;
      if (injected) continue;
      review.push({ entry_id: record.entry_id, kind: record.kind, unit_id: item.unit_id, action: item.action, claim_id: item.claim_id, text: unit?.text ?? null });
    }
  }

  // R29.6b : sortes de segments séparées, DECLARE détaillés, preuves, recommandation.
  verdicts.by_kind = Object.fromEntries(KINDS.map(kind => [kind, verdictsOfKind(main, kind)]));
  const declareItems = declareItemsOf(main, reviews);
  const knownReviewIds = new Set(declareItems.map(item => item.review_id));
  const reviewIssues = reviews.filter(item => !knownReviewIds.has(item.review_id)).map(item => `${item.review_id} : aucun DECLARE correspondant`);
  const reviewed = declareItems.filter(item => typeof item.usable === "boolean");
  const evidence = {
    uncovered_total: KINDS.reduce((sum, kind) => sum + verdicts.by_kind[kind].uncovered, 0),
    uncovered_a: verdicts.by_kind.A.uncovered,
    required_total: DECISION_RULE.min_uncovered_total,
    required_a: DECISION_RULE.min_uncovered_a
  };
  evidence.sufficient = evidence.uncovered_total >= evidence.required_total && evidence.uncovered_a >= evidence.required_a;
  evidence.missing_total = Math.max(0, evidence.required_total - evidence.uncovered_total);
  evidence.missing_a = Math.max(0, evidence.required_a - evidence.uncovered_a);

  const declareReview = {
    items: declareItems,
    summary: {
      declare_total: declareItems.length,
      reviewed: reviewed.length,
      usable: reviewed.filter(item => item.usable).length,
      not_usable: reviewed.filter(item => !item.usable).length,
      pending: declareItems.length - reviewed.length,
      usable_rate: rate(reviewed.filter(item => item.usable).length, reviewed.length)
    },
    issues: reviewIssues
  };

  return {
    version: CALIBRATION_METRICS_VERSION,
    records: { total: all.length, main: main.length, stability: stabilityRecords.length },
    segments,
    calls: callStats,
    verdicts,
    witnesses: { B: witnessB, C: witnessC },
    stability,
    declare_review: declareReview,
    evidence,
    recommendation: recommendationOf({ evidence, byKind: verdicts.by_kind, items: declareItems, reviewIssues }),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, prices: prices ?? null, cost_usd: cost },
    review
  };
}

// ---------------------------------------------------------------------------

const asPercent = value => `${Math.round(value * 1000) / 10} %`;

const verdictOf = (value, ok) => (value === null || value === undefined ? "NOT_EVALUABLE" : ok ? "PASS" : "FAIL");

export function evaluateCriteria(metrics, { cap = null, toolCalls = null, isolationOk = null, budgetUsd = null, thresholds = CRITERIA_THRESHOLDS } = {}) {
  const item = (id, label, threshold, value, status) => ({ id, label, threshold, value, status });
  const accepted = metrics.calls.accepted_rate;
  const disturbed = metrics.calls.max_tokens_stops + metrics.calls.out_of_bounds + metrics.calls.timeouts;
  const meanCalls = metrics.segments.calls_per_segment.mean;
  const maxRounds = metrics.segments.rounds.max;

  return [
    item("C1", "Réponses acceptées au premier essai", `≥ ${asPercent(thresholds.accepted_first_try)}`, accepted, verdictOf(accepted, accepted >= thresholds.accepted_first_try)),
    item("C2", "Réponses tronquées, hors bornes ou TIMEOUT", "= 0", metrics.calls.judgments === 0 ? null : disturbed, verdictOf(metrics.calls.judgments === 0 ? null : disturbed, disturbed === 0)),
    item("C3", "Plafond d'appels respecté, aucune écriture hors du dossier de sortie", "100 %",
      cap === null || toolCalls === null ? null : { tool_calls: toolCalls, cap, isolation_ok: isolationOk },
      cap === null || toolCalls === null || isolationOk === null ? "NOT_EVALUABLE" : toolCalls <= cap && isolationOk === true ? "PASS" : "FAIL"),
    item("C4", "Témoins B : unité injectée jugée UNCOVERED", `≥ ${asPercent(thresholds.witness_b_recall)}`, metrics.witnesses.B.recall, verdictOf(metrics.witnesses.B.recall, metrics.witnesses.B.recall >= thresholds.witness_b_recall)),
    item("C5", "Témoins C : unités jugées COVERED", `≥ ${asPercent(thresholds.witness_c_covered)}`, metrics.witnesses.C.covered_rate, verdictOf(metrics.witnesses.C.covered_rate, metrics.witnesses.C.covered_rate >= thresholds.witness_c_covered)),
    item("C6", "Stabilité : verdict identique à la seconde passe", `≥ ${asPercent(thresholds.stability)}`, metrics.stability.agreement, verdictOf(metrics.stability.agreement, metrics.stability.agreement >= thresholds.stability)),
    item("C7", "Appels moyens par segment et rondes maximales", `≤ ${thresholds.mean_calls_per_segment} et ≤ ${thresholds.max_rounds}`,
      meanCalls === null ? null : { mean_calls: meanCalls, max_rounds: maxRounds },
      meanCalls === null ? "NOT_EVALUABLE" : meanCalls <= thresholds.mean_calls_per_segment && maxRounds <= thresholds.max_rounds ? "PASS" : "FAIL"),
    item("C8", "Coût réel dans le budget annoncé", budgetUsd === null ? "budget non fourni" : `≤ ${budgetUsd} $`, metrics.usage.cost_usd,
      metrics.usage.cost_usd === null || budgetUsd === null ? "NOT_EVALUABLE" : metrics.usage.cost_usd <= budgetUsd ? "PASS" : "FAIL")
  ];
}
