import crypto from "node:crypto";
import fs from "node:fs";

import { createMessage, extractText } from "../services/anthropic.js";
import { factElements } from "./fact-evidence.js";
import { TITLE_VALIDATION } from "./title-validation.js";

// Contradictions internes (R20.4, phase F) — rubrique du Truth Report.
//
// Périmètre (Q-F1) : les faits retenus entre eux, et chaque fait face aux
// autres champs du dossier que lit le Script (résumé, angles, sections,
// opportunités visuelles, notes de Research). Les faits rejetés par la
// phase E ne sont pas comparés (Q-F4).
//
// 1. Le code produit les paires suspectes (mots significatifs communs et
//    chiffres de même unité de valeurs différentes) et tranche seul les cas
//    certains (pourcentage supérieur à 100 %).
// 2. Le juge (un appel, nouvelles productions seulement) répond à chaque
//    paire suspecte et peut signaler d'autres contradictions (Q-F2).
// 3. Le code reste souverain : une paire n'est « compatible » que si le juge
//    nomme une dimension de la liste fermée et cite, mot pour mot, les
//    passages qui la distinguent dans les deux textes, ce que le code
//    vérifie (Q-F7). Sinon la paire reste « non résolue », traitée comme une
//    contradiction (fail-closed).

export const PAIR_VERDICTS = ["contradiction", "compatible", "unresolved"];

const CONFIG_KEYS = new Set(["note_fields", "min_shared_words", "min_word_length", "compatibility_dimensions"]);
const NOTE_FIELDS = ["executive_summary", "story_angles", "sections", "visual_opportunities", "claims_requiring_sources", "uncertainties", "research_gaps"];
const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------
// Configuration (config/research.json → contradictions)
// ---------------------------------------------------------------------

export function validateContradictionsConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["contradictions absente ou invalide"];
  }

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`clé inconnue : ${key}`);
  }

  if (!Array.isArray(config.note_fields) || !config.note_fields.every(field => NOTE_FIELDS.includes(field)) || new Set(config.note_fields).size !== config.note_fields.length) {
    errors.push(`note_fields doit être une liste distincte parmi ${NOTE_FIELDS.join(", ")}`);
  }

  if (!Number.isInteger(config.min_shared_words) || config.min_shared_words < 1 || config.min_shared_words > 10) errors.push("min_shared_words doit être un entier de 1 à 10");
  if (!Number.isInteger(config.min_word_length) || config.min_word_length < 3 || config.min_word_length > 12) errors.push("min_word_length doit être un entier de 3 à 12");

  if (!Array.isArray(config.compatibility_dimensions) || config.compatibility_dimensions.length === 0 || !config.compatibility_dimensions.every(isNonEmptyString) || new Set(config.compatibility_dimensions).size !== config.compatibility_dimensions.length) {
    errors.push("compatibility_dimensions doit être une liste non vide et distincte");
  }

  return errors;
}

export function loadContradictionsConfig(config) {
  const errors = validateContradictionsConfig(config?.contradictions);

  if (errors.length > 0) {
    throw new Error(`config/research.json → contradictions invalide : ${errors.join(" ; ")}`);
  }

  return Object.freeze(structuredClone(config.contradictions));
}

export const CONTRADICTIONS = loadContradictionsConfig(
  JSON.parse(fs.readFileSync(new URL("../../config/research.json", import.meta.url), "utf8"))
);

// ---------------------------------------------------------------------
// Textes comparés : faits retenus et notes du dossier
// ---------------------------------------------------------------------

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”«»]/g, "\"")
    .replace(/ | /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantWords(text, config) {
  return new Set(normalize(text).split(/[^\p{L}\p{N}-]+/u).filter(word => word.length >= config.min_word_length && !/^\d/.test(word)));
}

// Les champs de notes, aplatis en textes repérés par leur chemin.
export function noteTexts(research, config = CONTRADICTIONS) {
  const notes = [];
  const push = (path, text) => { if (isNonEmptyString(text)) notes.push({ id: `n${notes.length + 1}`, path, text: text.trim() }); };

  for (const field of config.note_fields) {
    const value = research?.[field];

    if (typeof value === "string") {
      push(field, value);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string") {
          push(`${field}[${index}]`, item);
        } else if (item && typeof item === "object") {
          for (const [key, inner] of Object.entries(item)) {
            if (typeof inner === "string") push(`${field}[${index}].${key}`, inner);
            if (Array.isArray(inner)) inner.forEach((text, position) => typeof text === "string" && push(`${field}[${index}].${key}[${position}]`, text));
          }
        }
      });
    }
  }

  return notes;
}

// Faits comparés (Q-F4) : tous les faits retenus, c'est-à-dire non rejetés
// par le contrôle des preuves (phase E), non vérifiables compris.
export function comparedFacts(research, factEvidence = null) {
  const facts = Array.isArray(research?.key_facts) ? research.key_facts : [];

  return facts
    .map((fact, index) => ({ id: `f${index + 1}`, index, text: String(fact?.claim ?? ""), importance: fact?.importance ?? null }))
    .filter(fact => fact.text && factEvidence?.facts?.[fact.index]?.editorial_status !== "rejected");
}

// ---------------------------------------------------------------------
// 1. Paires suspectes et cas certains (code)
// ---------------------------------------------------------------------

const quantity = element => ({ low: element.figure.low, high: element.figure.high, unit: element.unit });
const sameValue = (a, b) => Math.abs(a.low - b.low) < 1e-9 && Math.abs(a.high - b.high) < 1e-9;

function figuresWithUnit(text) {
  return factElements(text).filter(element => element.kind !== "quote" && element.unit).map(element => ({ text: element.text, ...quantity(element) }));
}

// Mots trop généraux pour rapprocher deux textes : marqueurs
// d'approximation et mots présents dans au moins la moitié des faits
// comparés (le sujet du dossier lui-même, « australienne »…).
function generalWords(facts, config) {
  const general = new Set(TITLE_VALIDATION.markers.approximation.flatMap(marker => marker.split(" ")));
  const frequency = new Map();

  for (const fact of facts) {
    for (const word of significantWords(fact.text, config)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }

  for (const [word, count] of frequency) {
    if (facts.length >= 4 && count >= facts.length / 2) general.add(word);
  }

  return general;
}

// Paire suspecte : les deux textes donnent, pour une même unité, des
// valeurs différentes, et ils parlent du même sujet (mots significatifs
// communs) ou partagent déjà un chiffre identique (même mesure, autre
// valeur associée : « 80 % à 25 km » contre « 80 % à 50 km »).
function suspicion(a, b, config, general = new Set()) {
  const wordsB = significantWords(b.text, config);
  const shared = [...significantWords(a.text, config)].filter(word => wordsB.has(word) && !general.has(word));
  const figuresA = figuresWithUnit(a.text);
  const figuresB = figuresWithUnit(b.text);
  const differing = [];
  let sharedFigure = null;

  for (const x of figuresA) {
    const sameUnit = figuresB.filter(y => y.unit === x.unit);

    if (sameUnit.some(y => sameValue(x, y))) sharedFigure ??= x.text;

    const others = sameUnit.filter(y => !figuresA.some(z => z.unit === y.unit && sameValue(z, y)));

    if (sameUnit.length > 0 && (others.length > 0 || !sameUnit.some(y => sameValue(x, y)))) {
      differing.push(`${x.text} / ${(others.length > 0 ? others : sameUnit).map(y => y.text).join(", ")}`);
    }
  }

  if (differing.length === 0 || (shared.length < config.min_shared_words && !sharedFigure)) return null;

  return { shared_words: shared.slice(0, 6), shared_figure: sharedFigure, differing_figures: [...new Set(differing)] };
}

export function findCandidates({ research, factEvidence = null, config = CONTRADICTIONS }) {
  const facts = comparedFacts(research, factEvidence);
  const notes = noteTexts(research, config);
  const candidates = [];
  const general = generalWords(facts, config);
  const add = (a, b, kind, detail) => candidates.push({ id: `c${candidates.length + 1}`, a: a.id, b: b.id, kind, ...detail });

  for (let i = 0; i < facts.length; i += 1) {
    for (let j = i + 1; j < facts.length; j += 1) {
      const detail = suspicion(facts[i], facts[j], config, general);
      if (detail) add(facts[i], facts[j], "fact_fact", detail);
    }

    for (const note of notes) {
      const detail = suspicion(facts[i], note, config, general);
      if (detail) add(facts[i], note, "fact_note", detail);
    }
  }

  return { facts, notes, candidates };
}

// Cas certain « même condition, autre valeur » : dans une même proposition,
// un texte associe une part (en %) à une condition chiffrée d'une autre
// unité (« 80 % à moins de 50 km »). Si l'autre texte associe la même
// condition (même valeur, même unité) à une part différente (« 85 % à 50 km
// »), les deux se contredisent, quoi que dise le juge.
function conditionPairs(text) {
  return String(text ?? "")
    .split(/[;,()\[\]]|\bet\b|\bvs\b|\bcontre\b/i)
    .map(part => figuresWithUnit(part))
    .filter(list => list.length >= 2)
    .flatMap(list => list
      .filter(measure => measure.unit === "%")
      .flatMap(measure => list.filter(condition => condition.unit !== "%").map(condition => ({ measure, condition }))));
}

export function sameConditionConflicts(textA, textB) {
  const pairsB = conditionPairs(textB);

  return conditionPairs(textA).flatMap(a => pairsB
    .filter(b => b.condition.unit === a.condition.unit && sameValue(b.condition, a.condition) && !sameValue(b.measure, a.measure))
    .map(b => `« ${a.measure.text} à ${a.condition.text} » contre « ${b.measure.text} à ${b.condition.text} »`));
}

// Cas certains : une part supérieure à 100 % dans un même fait.
export function certainFindings(facts) {
  const findings = [];

  for (const fact of facts) {
    for (const element of figuresWithUnit(fact.text)) {
      if (element.unit === "%" && element.high > 100) {
        findings.push({
          a: fact.id,
          b: fact.id,
          origin: "code",
          verdict: "contradiction",
          category: "chiffres",
          dimension: null,
          quotes: { a: element.text, b: element.text },
          reasons: [`Pourcentage « ${element.text} » supérieur à 100 % : incohérence certaine, établie par le code.`]
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------
// 2. Juge des contradictions
// ---------------------------------------------------------------------

const CATEGORIES = ["chiffres", "dates", "causalités", "portées", "unités", "géographie", "chronologie", "définitions"];

const SYSTEM_PROMPT = `
Tu es le juge des contradictions de la chaîne YouTube "Les Découvertes du Nomade".

Tu reçois les faits retenus d'un dossier de recherche (avec, quand ils
existent, des extraits de leurs preuves), les autres textes du dossier
(résumé, sections, notes) et des paires suspectes repérées par le code.

1. Pour CHAQUE paire suspecte, réponds :
   - verdict : "contradiction" si les deux textes affirment des choses
     incompatibles sur la même mesure, la même cause ou le même objet ;
     "compatible" s'ils ne parlent pas de la même chose ;
   - dimension (si compatible) : ce qui les distingue, parmi la liste
     fournie (date, portée, géographie, définition, unité) ;
   - quote_a et quote_b : les passages recopiés MOT POUR MOT depuis chacun
     des deux textes, qui montrent la contradiction ou la distinction ;
   - category : chiffres, dates, causalités, portées, unités, géographie,
     chronologie ou définitions ;
   - explanation : une phrase précise.
2. Signale ensuite toute AUTRE contradiction entre deux textes fournis,
   avec les mêmes champs et "candidate": "".

N'utilise aucune connaissance extérieure. Ne reformule jamais les citations.

Réponds uniquement en JSON valide, sans markdown ni texte autour :

{
  "pairs": [
    { "candidate": "", "a": "", "b": "", "verdict": "", "dimension": "", "category": "", "quote_a": "", "quote_b": "", "explanation": "" }
  ]
}
`.trim();

const DATA_MARKER = "DONNÉES :\n";

export function buildContradictionJudgeInput({ facts, notes, candidates, factEvidence = null, config = CONTRADICTIONS }) {
  return {
    dimensions: config.compatibility_dimensions,
    facts: facts.map(fact => {
      const evidence = factEvidence?.facts?.[fact.index];
      const excerpts = [
        ...(evidence?.quote?.text ? [evidence.quote.text] : []),
        ...(evidence?.elements ?? []).filter(element => element.status === "found" && element.excerpt).map(element => element.excerpt)
      ];

      return { id: fact.id, text: fact.text, importance: fact.importance, evidence_excerpts: [...new Set(excerpts)].slice(0, 3) };
    }),
    notes: notes.map(({ id, path, text }) => ({ id, path, text })),
    candidates: candidates.map(({ id, a, b, kind, differing_figures }) => ({ id, a, b, kind, differing_figures }))
  };
}

export function contradictionJudgeInputSha256(input) {
  return sha256(`${SYSTEM_PROMPT}\n${JSON.stringify(input)}`);
}

export function validateContradictionJudgeResponse(response, input) {
  const errors = [];

  if (!response || typeof response !== "object" || !Array.isArray(response.pairs)) {
    return ["objet { pairs: [] } attendu"];
  }

  const ids = new Set([...input.facts.map(fact => fact.id), ...input.notes.map(note => note.id)]);
  const answered = response.pairs.filter(pair => isNonEmptyString(pair?.candidate)).map(pair => pair.candidate);

  for (const candidate of input.candidates) {
    if (answered.filter(id => id === candidate.id).length !== 1) errors.push(`paire ${candidate.id} : réponse attendue exactement une fois`);
  }

  response.pairs.forEach((pair, position) => {
    const label = `pairs[${position}]`;
    const candidate = input.candidates.find(item => item.id === pair?.candidate);

    if (isNonEmptyString(pair?.candidate) && !candidate) errors.push(`${label} : paire inconnue ${pair.candidate}`);
    if (!ids.has(pair?.a) || !ids.has(pair?.b) || pair?.a === pair?.b) errors.push(`${label} : textes a et b invalides`);
    if (candidate && !(candidate.a === pair.a && candidate.b === pair.b) && !(candidate.a === pair.b && candidate.b === pair.a)) errors.push(`${label} : a et b ne correspondent pas à la paire ${candidate.id}`);
    if (!["contradiction", "compatible"].includes(pair?.verdict)) errors.push(`${label} : verdict invalide`);
    if (!CATEGORIES.includes(pair?.category)) errors.push(`${label} : category invalide`);
    if (typeof pair?.dimension !== "string" || typeof pair?.quote_a !== "string" || typeof pair?.quote_b !== "string") errors.push(`${label} : dimension, quote_a et quote_b doivent être des chaînes`);
    if (!isNonEmptyString(pair?.explanation)) errors.push(`${label} : explanation manquante`);
  });

  return errors;
}

function parseJson(text) {
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

// Un appel, plus au plus une réparation. Passe par createMessage : garde des
// appels, plafond, journal et cache.
export async function runContradictionJudge(input) {
  const payload = JSON.stringify(input);
  const usage = [];
  let previous = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const content = previous
      ? `RÉPARATION — ta réponse précédente était invalide : ${previous.errors.join(" ; ")}\n\nRéponse précédente :\n${previous.text}\n\nÉvalue de nouveau le dossier suivant.\n\n${DATA_MARKER}${payload}`
      : `Évalue les contradictions du dossier suivant.\n\n${DATA_MARKER}${payload}`;

    const { response, meta } = await createMessage({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      maxTokens: 4000,
      temperature: 0
    });

    usage.push(meta);

    const text = extractText(response);
    const parsed = meta.stop_reason === "max_tokens" ? null : parseJson(text);
    const errors = parsed ? validateContradictionJudgeResponse(parsed, input) : [meta.stop_reason === "max_tokens" ? "réponse tronquée (max_tokens)" : "JSON invalide"];

    if (errors.length === 0) {
      return { response: parsed, attempts: attempt, usage };
    }

    previous = { errors, text: text.slice(0, 4000) };
  }

  throw new Error(`Juge des contradictions : réponse invalide après réparation — ${previous.errors.join(" ; ")}`);
}

// ---------------------------------------------------------------------
// 3. Évaluation (pure) : le code reste souverain
// ---------------------------------------------------------------------

const YEAR = /\b(1[0-9]{3}|20[0-9]{2}|2100)\b/g;

// Une compatibilité n'est acceptée que si la dimension est dans la liste
// fermée, que les deux citations figurent mot pour mot dans leurs textes et
// qu'elles diffèrent ; pour « date », elles doivent porter deux années
// différentes.
function checkCompatibility(pair, textA, textB, config) {
  const reasons = [];

  if (!config.compatibility_dimensions.includes(pair.dimension)) reasons.push(`dimension « ${pair.dimension || "—"} » hors de la liste fermée`);
  if (!isNonEmptyString(pair.quote_a) || !normalize(textA).includes(normalize(pair.quote_a))) reasons.push("citation du premier texte introuvable");
  if (!isNonEmptyString(pair.quote_b) || !normalize(textB).includes(normalize(pair.quote_b))) reasons.push("citation du second texte introuvable");
  if (reasons.length === 0 && normalize(pair.quote_a) === normalize(pair.quote_b)) reasons.push("les deux citations sont identiques : aucune distinction établie");

  // « unité » n'est recevable que si les deux citations utilisent réellement
  // des unités différentes (aucune unité commune).
  if (reasons.length === 0 && pair.dimension === "unité") {
    const unitsA = new Set(figuresWithUnit(pair.quote_a).map(item => item.unit));
    const unitsB = new Set(figuresWithUnit(pair.quote_b).map(item => item.unit));

    if (unitsA.size === 0 || unitsB.size === 0 || [...unitsA].some(unit => unitsB.has(unit))) {
      reasons.push(`dimension « unité » refusée : les deux citations utilisent la même unité (${[...new Set([...unitsA, ...unitsB])].join(", ") || "aucune unité"})`);
    }
  }

  if (reasons.length === 0 && pair.dimension === "date") {
    const yearsA = new Set(pair.quote_a.match(YEAR) ?? []);
    const yearsB = new Set(pair.quote_b.match(YEAR) ?? []);

    if (yearsA.size === 0 || yearsB.size === 0 || [...yearsA].every(year => yearsB.has(year))) reasons.push("dimension « date » sans deux années différentes dans les citations");
  }

  return reasons;
}

// judge : réponse validée du juge, ou null (production historique,
// hiérarchie à résoudre d'abord) ; skipReason explique alors l'absence.
export function evaluateContradictions({ research, factEvidence = null, judge = null, skipReason = null, config = CONTRADICTIONS }) {
  const { facts, notes, candidates } = findCandidates({ research, factEvidence, config });
  const texts = new Map([...facts.map(fact => [fact.id, fact.text]), ...notes.map(note => [note.id, note.text])]);
  const findings = certainFindings(facts);

  for (const candidate of candidates) {
    const pair = judge?.pairs.find(item => item.candidate === candidate.id) ?? null;
    const base = { a: candidate.a, b: candidate.b, candidate: candidate.id, origin: "code", category: pair?.category ?? "chiffres", dimension: null, quotes: null };
    const suspected = `Paire suspecte repérée par le code : ${candidate.differing_figures.join(" ; ")} (${candidate.shared_figure ? `chiffre commun : ${candidate.shared_figure}` : `mots communs : ${candidate.shared_words.join(", ")}`}).`;

    const conflicts = sameConditionConflicts(texts.get(candidate.a), texts.get(candidate.b));

    // Cas certain : le code conclut à la contradiction, avec ou sans juge ;
    // le juge ne peut pas l'écarter.
    if (conflicts.length > 0 && !pair) {
      findings.push({ ...base, verdict: "contradiction", category: "chiffres", reasons: [suspected, `Contradiction certaine établie par le code (même condition, autre valeur) : ${conflicts.join(" ; ")}.`] });
      continue;
    }

    if (!pair) {
      findings.push({ ...base, verdict: "unresolved", reasons: [suspected, `Non jugée — ${skipReason ?? "juge non appelé"}.`] });
      continue;
    }

    const textA = texts.get(pair.a);
    const textB = texts.get(pair.b);

    if (conflicts.length > 0) {
      findings.push({
        ...base,
        verdict: "contradiction",
        category: "chiffres",
        quotes: { a: pair.quote_a, b: pair.quote_b },
        reasons: [
          suspected,
          `Contradiction certaine établie par le code (même condition, autre valeur) : ${conflicts.join(" ; ")}.`,
          ...(pair.verdict === "compatible" ? [`Compatibilité proposée par le juge écartée par le code (${pair.dimension || "—"}) : ${pair.explanation.trim()}`] : [`Juge : ${pair.explanation.trim()}`])
        ]
      });
      continue;
    }

    if (pair.verdict === "compatible") {
      const failures = checkCompatibility(pair, textA, textB, config);

      findings.push(failures.length === 0
        ? { ...base, verdict: "compatible", dimension: pair.dimension, quotes: { a: pair.quote_a, b: pair.quote_b }, reasons: [suspected, `Compatible (${pair.dimension}) : ${pair.explanation.trim()}`] }
        : { ...base, verdict: "unresolved", reasons: [suspected, `Compatibilité refusée par le code : ${failures.join(" ; ")}.`, `Juge : ${pair.explanation.trim()}`] });
    } else {
      findings.push({ ...base, verdict: "contradiction", quotes: { a: pair.quote_a, b: pair.quote_b }, reasons: [suspected, `Juge : ${pair.explanation.trim()}`] });
    }
  }

  // Contradictions signalées librement par le juge : retenues si leurs
  // citations sont retrouvées, sinon non résolues (fail-closed).
  for (const pair of judge?.pairs.filter(item => !isNonEmptyString(item.candidate) && item.verdict === "contradiction") ?? []) {
    const found = normalize(texts.get(pair.a)).includes(normalize(pair.quote_a)) && normalize(texts.get(pair.b)).includes(normalize(pair.quote_b)) && isNonEmptyString(pair.quote_a) && isNonEmptyString(pair.quote_b);

    findings.push({
      a: pair.a,
      b: pair.b,
      candidate: null,
      origin: "judge",
      category: pair.category,
      dimension: null,
      verdict: found ? "contradiction" : "unresolved",
      quotes: { a: pair.quote_a, b: pair.quote_b },
      reasons: found
        ? [`Contradiction signalée par le juge : ${pair.explanation.trim()}`]
        : [`Contradiction signalée par le juge, citations introuvables dans les textes : ${pair.explanation.trim()}`]
    });
  }

  const indexOf = id => facts.find(fact => fact.id === id)?.index ?? null;
  const open = findings.filter(finding => finding.verdict !== "compatible");
  const contested = [...new Set(open.flatMap(finding => [indexOf(finding.a), indexOf(finding.b)]).filter(index => index !== null))].sort((x, y) => x - y);
  const counts = Object.fromEntries(PAIR_VERDICTS.map(verdict => [verdict, findings.filter(finding => finding.verdict === verdict).length]));

  return {
    judged: Boolean(judge),
    skip_reason: judge ? null : skipReason,
    status: counts.contradiction > 0 ? "contradictions" : counts.unresolved > 0 ? "unresolved" : "none",
    counts,
    compared_facts: facts.map(fact => fact.index),
    notes: notes.map(({ id, path }) => ({ id, path })),
    candidates: candidates.length,
    findings,
    contested_facts: contested
  };
}

// Q-F3 : une contradiction (ou une paire non résolue) engageant un fait HIGH
// met une nouvelle production en pause, sans résolution automatique.
export function blockingFindings(contradictions, research) {
  const facts = Array.isArray(research?.key_facts) ? research.key_facts : [];
  const isHigh = id => /^f\d+$/.test(id) && facts[Number(id.slice(1)) - 1]?.importance === "high";

  return contradictions.findings.filter(finding => finding.verdict !== "compatible" && (isHigh(finding.a) || isHigh(finding.b)));
}

export const CONTRADICTION_REVIEW_ACTIONS = [
  "Relire, dans le Truth Report, chaque contradiction : les deux textes, les citations et la justification.",
  "Aucune résolution automatique : la décision reste humaine. Pour continuer avec un dossier corrigé, régénérer Research (--regenerate=research, appel payant) ou lancer une nouvelle production.",
  "La production en pause est conservée et reste reprenable ; une reprise sans changement réutilise la réponse du juge, sans appel."
];
