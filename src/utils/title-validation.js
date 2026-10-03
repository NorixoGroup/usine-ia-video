import crypto from "node:crypto";
import fs from "node:fs";

import { createMessage, extractText } from "../services/anthropic.js";
import { SOURCE_POLICY } from "./source-policy.js";

// Validation du titre (R20.4, phase A) — rubrique du Truth Report.
//
// 1. Décomposition déterministe du titre en affirmations typées, selon les
//    marqueurs de config/research.json → title_validation.
// 2. Contrôle déterministe des chiffres : un chiffre doit figurer dans un
//    fait validé (vérifié, meilleur rang effectif ≤ seuil de la phase B).
// 3. Juge modèle (un appel, nouvelles productions seulement) pour le sens
//    des affirmations non chiffrées et les titres alternatifs.
// 4. Réconciliation : le code décide seul des chiffres et ne peut que
//    durcir le verdict du modèle, jamais l'adoucir.
// 5. Verdict accompagné de justifications rédigées par le code.

export const TITLE_VERDICTS = [
  "demonstrated",
  "partially_demonstrated",
  "not_demonstrated",
  "review_required"
];

export const ASSERTION_KINDS = [
  "main_claim",
  "exact_figure",
  "approximation",
  "journalistic",
  "hypothesis",
  "causality",
  "generalization"
];

const MARKER_KINDS = ["approximation", "journalistic", "hypothesis", "causality", "generalization"];
const STATUSES = ["supported", "partially_supported", "not_supported"];
const SEVERITY = { supported: 0, partially_supported: 1, not_supported: 2 };
const CONFIG_KEYS = new Set([
  "alternative_titles_count",
  "approximate_figure_tolerance",
  "approximation_window_words",
  "markers"
]);

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

export function validateTitleValidationConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["title_validation absente ou invalide"];
  }

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`clé inconnue : ${key}`);
  }

  if (!Number.isInteger(config.alternative_titles_count) || config.alternative_titles_count < 1 || config.alternative_titles_count > 5) {
    errors.push("alternative_titles_count doit être un entier de 1 à 5");
  }

  if (typeof config.approximate_figure_tolerance !== "number" || !(config.approximate_figure_tolerance >= 0 && config.approximate_figure_tolerance <= 0.5)) {
    errors.push("approximate_figure_tolerance doit être un nombre de 0 à 0,5");
  }

  if (!Number.isInteger(config.approximation_window_words) || config.approximation_window_words < 1 || config.approximation_window_words > 5) {
    errors.push("approximation_window_words doit être un entier de 1 à 5");
  }

  const markers = config.markers;

  if (!markers || typeof markers !== "object" || Array.isArray(markers)) {
    errors.push("markers doit être un objet");
    return errors;
  }

  for (const key of Object.keys(markers)) {
    if (!MARKER_KINDS.includes(key)) errors.push(`markers : type inconnu ${key}`);
  }

  for (const kind of MARKER_KINDS) {
    const list = markers[kind];

    if (!Array.isArray(list) || list.length === 0 || !list.every(isNonEmptyString)) {
      errors.push(`markers.${kind} doit être une liste non vide`);
    } else if (new Set(list.map(normalize)).size !== list.length) {
      errors.push(`markers.${kind} contient un doublon`);
    } else if (list.some(marker => marker !== marker.toLowerCase().trim())) {
      errors.push(`markers.${kind} : marqueurs en minuscules attendus`);
    }
  }

  return errors;
}

export function loadTitleValidationConfig(config) {
  const errors = validateTitleValidationConfig(config?.title_validation);

  if (errors.length > 0) {
    throw new Error(`config/research.json → title_validation invalide : ${errors.join(" ; ")}`);
  }

  return Object.freeze(structuredClone(config.title_validation));
}

export const TITLE_VALIDATION = loadTitleValidationConfig(
  JSON.parse(fs.readFileSync(new URL("../../config/research.json", import.meta.url), "utf8"))
);

// ---------------------------------------------------------------------
// Chiffres
// ---------------------------------------------------------------------

function normalize(text) {
  return ` ${String(text).toLowerCase().replace(/[’']/g, " ").replace(/[^\p{L}\p{N}%,.\s-]/gu, " ").replace(/\s+/g, " ").trim()} `;
}

const NUMBER = String.raw`\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)?`;
const toNumber = text => Number(text.replace(/[  ]/g, "").replace(",", "."));
const isPercent = suffix => /^\s*(%|pour\s?cent)/i.test(suffix ?? "");

// Chiffres d'un texte : valeurs simples et fourchettes (« 85 à 90 % »,
// « entre 6 et 8 »). Chaque élément garde son texte d'origine.
export function extractFigures(text) {
  const source = String(text ?? "");
  const figures = [];
  const taken = [];
  const range = new RegExp(String.raw`(?:entre\s+)?(${NUMBER})\s*(%|pour\s?cent)?\s*(?:à|et|-|–)\s*(${NUMBER})\s*(%|pour\s?cent)?`, "gi");

  for (const match of source.matchAll(range)) {
    const percent = isPercent(match[2]) || isPercent(match[4]);
    const low = toNumber(match[1]);
    const high = toNumber(match[3]);

    if (!(low < high)) continue;

    figures.push({ text: match[0].trim(), low, high, percent, position: match.index });
    taken.push([match.index, match.index + match[0].length]);
  }

  const single = new RegExp(String.raw`(${NUMBER})(\s*(?:%|pour\s?cent))?`, "gi");

  for (const match of source.matchAll(single)) {
    if (taken.some(([start, end]) => match.index >= start && match.index < end)) continue;

    const value = toNumber(match[1]);

    figures.push({ text: match[0].trim(), low: value, high: value, percent: isPercent(match[2]), position: match.index });
  }

  return figures.sort((a, b) => a.position - b.position);
}

function formatFigure(figure) {
  return figure.text;
}

// ---------------------------------------------------------------------
// 1. Décomposition du titre
// ---------------------------------------------------------------------

export function decomposeTitle(title, config = TITLE_VALIDATION) {
  const text = String(title ?? "").trim();
  const normalized = normalize(text);
  const assertions = [{ id: "a1", kind: "main_claim", text }];
  const add = (kind, value, extra = {}) => assertions.push({ id: `a${assertions.length + 1}`, kind, text: value, ...extra });

  for (const figure of extractFigures(text)) {
    const before = normalize(text.slice(0, figure.position)).trim().split(" ").filter(Boolean);
    const window = ` ${before.slice(-config.approximation_window_words).join(" ")} `;
    const approximate = config.markers.approximation.some(marker => window.includes(` ${marker} `));

    add(approximate ? "approximation" : "exact_figure", figure.text, {
      figure: { low: figure.low, high: figure.high, percent: figure.percent, approximate }
    });
  }

  for (const kind of MARKER_KINDS) {
    for (const marker of config.markers[kind]) {
      if (normalized.includes(` ${marker} `)) add(kind, marker);
    }
  }

  return assertions;
}

// ---------------------------------------------------------------------
// 2. Faits validés et contrôle des chiffres
// ---------------------------------------------------------------------

// Phase E (Q-E5) : quand les preuves ont été lues, un fait n'est confirmé
// que si son statut éditorial est « supported ». Pour une production
// historique (preuves non lues), la définition des phases A et B demeure.
export function evidenceConfirmed(factEvidence, index) {
  if (!factEvidence?.checked) return true;

  return factEvidence.facts[index]?.editorial_status === "supported";
}

// Définition unique d'un « fait validé » dans tout le pipeline : vérifié,
// meilleur rang effectif (phase B) au plus le seuil de la hiérarchie, et
// preuve confirmée (phase E) quand les preuves ont été lues.
export function validatedFacts(research, hierarchy, policy = SOURCE_POLICY, factEvidence = null) {
  const minimum = policy.source_tiers.minimum_rank_for_high_facts;
  const facts = Array.isArray(research?.key_facts) ? research.key_facts : [];

  return facts.map((fact, index) => {
    const bestRank = hierarchy.facts[index]?.best_rank ?? null;
    const verified = fact?.verification_status === "verified";

    return {
      index,
      claim: fact?.claim ?? "",
      importance: fact?.importance ?? null,
      verification_status: fact?.verification_status ?? null,
      best_rank: bestRank,
      evidence_status: factEvidence?.checked ? factEvidence.facts[index]?.editorial_status ?? null : null,
      validated: verified && bestRank !== null && bestRank <= minimum && evidenceConfirmed(factEvidence, index)
    };
  });
}

function figureMatches(figure, candidate, tolerance) {
  if (figure.percent !== candidate.percent) return false;

  if (!figure.approximate) {
    return figure.low >= candidate.low && figure.high <= candidate.high;
  }

  const margin = Math.max(Math.abs(candidate.low), Math.abs(candidate.high)) * tolerance;

  return figure.low >= candidate.low - margin && figure.high <= candidate.high + margin;
}

const factLabel = index => `fait ${index + 1}`;

export function checkFigure(assertion, facts, config = TITLE_VALIDATION, minimum = SOURCE_POLICY.source_tiers.minimum_rank_for_high_facts) {
  const tolerance = config.approximate_figure_tolerance;
  const supporting = [];
  const unvalidated = [];

  for (const fact of facts) {
    if (extractFigures(fact.claim).some(candidate => figureMatches(assertion.figure, candidate, tolerance))) {
      (fact.validated ? supporting : unvalidated).push(fact);
    }
  }

  if (supporting.length > 0) {
    return {
      status: "supported",
      facts: supporting.map(fact => fact.index),
      reasons: [`Chiffre « ${assertion.text} » présent dans ${supporting.map(fact => factLabel(fact.index)).join(", ")} (fait vérifié, source de rang ≤ ${minimum}).`]
    };
  }

  const reasons = [`Chiffre « ${assertion.text} » absent des faits validés (faits vérifiés, sources de rang ≤ ${minimum}).`];

  if (unvalidated.length > 0) {
    reasons.push(`Il figure seulement dans des faits non validés : ${unvalidated.map(fact => `${factLabel(fact.index)} (${fact.verification_status}, meilleur rang ${fact.best_rank ?? "aucun"}${fact.evidence_status ? `, preuve ${fact.evidence_status}` : ""})`).join(", ")}.`);
  }

  const near = facts
    .filter(fact => fact.validated)
    .flatMap(fact => extractFigures(fact.claim)
      .filter(candidate => candidate.percent === assertion.figure.percent)
      .map(candidate => ({ fact, candidate, distance: Math.min(Math.abs(candidate.low - assertion.figure.low), Math.abs(candidate.high - assertion.figure.high)) })))
    .sort((a, b) => a.distance - b.distance || a.fact.index - b.fact.index)
    .slice(0, 3);

  if (near.length > 0) {
    reasons.push(`Chiffres proches dans les faits validés : ${near.map(item => `${formatFigure(item.candidate)} (${factLabel(item.fact.index)})`).join(", ")}.`);
  }

  return { status: "not_supported", facts: [], reasons };
}

// ---------------------------------------------------------------------
// 3. Juge modèle
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = `
Tu es le juge du titre de la chaîne YouTube "Les Découvertes du Nomade".

Tu reçois un titre de vidéo, ses affirmations déjà découpées, et les faits
du dossier de recherche. Chaque fait indique s'il est validé (vérifié et
appuyé par une source fiable). Seuls les faits validés peuvent soutenir
une affirmation.

Pour CHAQUE affirmation, indique :
- status : "supported", "partially_supported" ou "not_supported" ;
- facts : les indices des faits validés qui la soutiennent directement ;
- explanation : une phrase précise qui justifie ton statut.

Règles :
- Une causalité n'est soutenue que si des faits validés expliquent la cause.
- Une généralisation n'est soutenue que si des faits validés la démontrent
  sans exception.
- Une formulation journalistique ou une approximation est au mieux
  "partially_supported" si les faits ne la justifient qu'en partie.
- N'invente aucun fait et ne cite jamais un fait non validé.

Propose ensuite des titres alternatifs fidèles à l'intention du titre et
entièrement soutenus par des faits validés. Chaque titre alternatif cite
les faits validés qui le soutiennent. Aucun chiffre ne doit y figurer s'il
n'apparaît pas dans un des faits cités.

Réponds uniquement en JSON valide, sans markdown ni texte autour :

{
  "assertions": [
    { "id": "", "status": "", "facts": [], "explanation": "" }
  ],
  "alternative_titles": [
    { "title": "", "facts": [], "explanation": "" }
  ]
}
`.trim();

const DATA_MARKER = "DONNÉES :\n";

export function buildJudgePayload({ title, assertions, facts, research, config = TITLE_VALIDATION }) {
  return {
    title,
    alternative_titles_count: config.alternative_titles_count,
    assertions: assertions.map(({ id, kind, text }) => ({ id, kind, text })),
    facts: facts.map(({ index, claim, importance, validated }) => ({ index, claim, importance, validated })),
    uncertainties: Array.isArray(research?.uncertainties) ? research.uncertainties : [],
    claims_requiring_sources: Array.isArray(research?.claims_requiring_sources) ? research.claims_requiring_sources : []
  };
}

export function validateJudgeResponse(response, { assertions, facts }) {
  const errors = [];

  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return ["réponse JSON objet attendue"];
  }

  const ids = assertions.map(assertion => assertion.id);
  const answered = Array.isArray(response.assertions) ? response.assertions : null;
  const validIndex = index => Number.isInteger(index) && index >= 0 && index < facts.length;

  if (!answered) {
    errors.push("assertions doit être un tableau");
  } else {
    const seen = answered.map(item => item?.id);

    if (seen.length !== ids.length || ids.some(id => !seen.includes(id)) || new Set(seen).size !== seen.length) {
      errors.push(`assertions doit répondre exactement une fois à ${ids.join(", ")}`);
    }

    answered.forEach((item, position) => {
      if (!STATUSES.includes(item?.status)) errors.push(`assertions[${position}] : status invalide`);
      if (!Array.isArray(item?.facts) || !item.facts.every(validIndex)) errors.push(`assertions[${position}] : facts invalide`);
      if (!isNonEmptyString(item?.explanation)) errors.push(`assertions[${position}] : explanation manquante`);
    });
  }

  if (!Array.isArray(response.alternative_titles)) {
    errors.push("alternative_titles doit être un tableau");
  } else {
    response.alternative_titles.forEach((item, position) => {
      if (!isNonEmptyString(item?.title)) errors.push(`alternative_titles[${position}] : title manquant`);
      if (!Array.isArray(item?.facts) || !item.facts.every(validIndex)) errors.push(`alternative_titles[${position}] : facts invalide`);
      if (!isNonEmptyString(item?.explanation)) errors.push(`alternative_titles[${position}] : explanation manquante`);
    });
  }

  return errors;
}

function parseJudgeText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text ?? "").match(/\{[\s\S]*\}/);

    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// Empreinte des entrées du juge (prompt système + données). À la reprise,
// une réponse déjà validée pour la même empreinte est réutilisée sans appel.
export function titleJudgeInputSha256({ title, assertions, facts, research, config = TITLE_VALIDATION }) {
  return crypto
    .createHash("sha256")
    .update(`${SYSTEM_PROMPT}\n${JSON.stringify(buildJudgePayload({ title, assertions, facts, research, config }))}`)
    .digest("hex");
}

// Un appel, plus au plus une réparation si la réponse est invalide. Passe
// par createMessage : garde des appels, plafond, journal et cache.
export async function runTitleJudge({ title, assertions, facts, research, config = TITLE_VALIDATION }) {
  const payload = JSON.stringify(buildJudgePayload({ title, assertions, facts, research, config }));
  const usage = [];
  let previous = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const content = previous
      ? `RÉPARATION — ta réponse précédente était invalide : ${previous.errors.join(" ; ")}\n\nRéponse précédente :\n${previous.text}\n\nÉvalue de nouveau le titre suivant.\n\n${DATA_MARKER}${payload}`
      : `Évalue le titre suivant.\n\n${DATA_MARKER}${payload}`;

    const { response, meta } = await createMessage({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      maxTokens: 2000,
      temperature: 0
    });

    usage.push(meta);

    const text = extractText(response);
    const parsed = meta.stop_reason === "max_tokens" ? null : parseJudgeText(text);
    const errors = parsed ? validateJudgeResponse(parsed, { assertions, facts }) : [meta.stop_reason === "max_tokens" ? "réponse tronquée (max_tokens)" : "JSON invalide"];

    if (errors.length === 0) {
      return { response: parsed, attempts: attempt, usage };
    }

    previous = { errors, text: text.slice(0, 4000) };
  }

  throw new Error(`Juge du titre : réponse invalide après réparation — ${previous.errors.join(" ; ")}`);
}

// ---------------------------------------------------------------------
// 4–5. Réconciliation, verdict et titres alternatifs
// ---------------------------------------------------------------------

const KIND_LABELS = {
  main_claim: "Message du titre",
  exact_figure: "Chiffre exact",
  approximation: "Approximation",
  journalistic: "Formulation journalistique",
  hypothesis: "Hypothèse",
  causality: "Causalité",
  generalization: "Généralisation"
};

export const kindLabel = kind => KIND_LABELS[kind] ?? kind;

const isFigure = assertion => Boolean(assertion.figure);
const severest = (a, b) => (SEVERITY[a] >= SEVERITY[b] ? a : b);

// Le code durcit, ne s'adoucit jamais : un fait cité doit être validé ;
// sinon le statut est abaissé, avec la raison.
function reconcileJudged(assertion, judged, facts, minimum) {
  const label = `${kindLabel(assertion.kind)} « ${assertion.text} »`;
  const reasons = [];
  const cited = [...new Set(judged.facts)];
  const valid = cited.filter(index => facts[index]?.validated);
  const invalid = cited.filter(index => !facts[index]?.validated);
  let status = judged.status;

  reasons.push(`${label} : ${judged.explanation.trim()}`);

  if (invalid.length > 0) {
    reasons.push(`${label} : ${invalid.map(index => `${factLabel(index)} (${facts[index].verification_status}, meilleur rang ${facts[index].best_rank ?? "aucun"})`).join(", ")} écarté(s) : seul un fait vérifié appuyé par une source de rang ≤ ${minimum} est une preuve.`);
  }

  if (status !== "not_supported" && valid.length === 0) {
    status = "not_supported";
    reasons.push(cited.length > 0
      ? `${label} soutenue uniquement par des faits non validés (sources de rang > ${minimum} ou faits non vérifiés).`
      : `${label} : aucun fait validé n'est cité.`);
  }

  return { status, facts: status === "not_supported" ? [] : valid, reasons };
}

function checkAlternative(item, facts, config, minimum) {
  const reasons = [];
  const cited = [...new Set(item.facts)];
  const title = item.title.trim();

  if (cited.length === 0) reasons.push("aucun fait cité");

  for (const index of cited) {
    if (!facts[index]?.validated) reasons.push(`${factLabel(index)} non validé (rang > ${minimum} ou non vérifié)`);
  }

  const citedFacts = cited.filter(index => facts[index]?.validated).map(index => facts[index]);

  for (const assertion of decomposeTitle(title, config).filter(isFigure)) {
    if (checkFigure(assertion, citedFacts, config, minimum).status !== "supported") {
      reasons.push(`chiffre « ${assertion.text} » absent des faits validés cités`);
    }
  }

  return reasons.length === 0
    ? { accepted: true, value: { title, facts: cited, explanation: item.explanation.trim() } }
    : { accepted: false, value: { title, facts: cited, reasons } };
}

// judge : réponse validée du juge, ou null (production historique ou
// hiérarchie à résoudre d'abord) ; skipReason explique alors l'absence.
export function evaluateTitle({ title, research, hierarchy, factEvidence = null, judge = null, skipReason = null, config = TITLE_VALIDATION, policy = SOURCE_POLICY }) {
  const minimum = policy.source_tiers.minimum_rank_for_high_facts;
  const facts = validatedFacts(research, hierarchy, policy, factEvidence);
  const assertions = decomposeTitle(title, config);

  const evaluated = assertions.map(assertion => {
    const judged = judge?.assertions.find(item => item.id === assertion.id) ?? null;
    let result;

    if (isFigure(assertion)) {
      // Chiffres : le code décide ; le juge peut seulement durcir.
      result = checkFigure(assertion, facts, config, minimum);

      if (judged) {
        const fromJudge = reconcileJudged(assertion, judged, facts, minimum);
        const status = severest(result.status, fromJudge.status);

        result = {
          status,
          facts: status === "not_supported" ? [] : result.facts,
          reasons: [...result.reasons, ...(SEVERITY[fromJudge.status] > SEVERITY[result.status] ? fromJudge.reasons : [])]
        };
      }
    } else if (judged) {
      result = reconcileJudged(assertion, judged, facts, minimum);
    } else {
      result = {
        status: "not_judged",
        facts: [],
        reasons: [`${kindLabel(assertion.kind)} « ${assertion.text} » : sens non jugé — ${skipReason ?? "juge non appelé"}.`]
      };
    }

    return { ...assertion, ...result };
  });

  const statuses = evaluated.map(item => item.status);
  const verdict = statuses.includes("not_supported")
    ? "not_demonstrated"
    : statuses.includes("not_judged")
      ? "review_required"
      : statuses.includes("partially_supported")
        ? "partially_demonstrated"
        : "demonstrated";

  const reasons = verdict === "demonstrated"
    ? evaluated.flatMap(item => item.reasons)
    : evaluated.filter(item => item.status !== "supported").flatMap(item => item.reasons);

  const alternatives = { accepted: [], rejected: [] };

  if (judge && verdict === "not_demonstrated") {
    for (const item of judge.alternative_titles) {
      const checked = checkAlternative(item, facts, config, minimum);
      const list = checked.accepted ? alternatives.accepted : alternatives.rejected;

      if (!checked.accepted || alternatives.accepted.length < config.alternative_titles_count) list.push(checked.value);
    }
  }

  return {
    text: title ?? null,
    verdict,
    judged: Boolean(judge),
    judge_skipped_reason: judge ? null : skipReason,
    assertions: evaluated,
    reasons,
    alternatives
  };
}
