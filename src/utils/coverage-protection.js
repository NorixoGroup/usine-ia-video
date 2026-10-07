// R28.3 — Protection de la frontière factuelle (baseline v1.0.1, contrat 4.3).
// Pour UNE unité produite par le découpeur, elle détecte les signaux de
// contenu qui interdisent son exclusion. Elle ne classe rien, n'exclut rien et
// ne prend aucune décision narrative : une unité est protégée si et seulement
// si au moins un signal est présent.
//
// Ne lit jamais : le registre narratif, les unités voisines, les claims, les
// verdicts, les prompts (I2).
//
// Signaux v1, tous globaux (présents n'importe où dans l'unité) :
//   digit                    chiffre, y compris exposants, indices et fractions
//   quantity_word            quantité en lettres (lexique)
//   vague_quantifier         quantificateur vague (lexique)
//   comparative              comparatif ou superlatif (lexique)
//   structural_punctuation   deux-points, point-virgule, parenthèse
//   direct_quotation         guillemets d'une citation directe
//   typographic_proper_noun  mot à majuscule initiale hors première position
//                            (donc aussi après une élision : « l'Australie »)
//   research_entity          entité de la liste Research
//   attribution_marker       marqueur d'attribution (lexique)
//   temporal_expression      expression temporelle de la liste fermée (lexique)
//
// Les lexiques sont comparés aux mots normalisés (coverage-normalization.v1),
// en séquences contiguës. Déterminisme (I18) : classes de caractères en
// listes fermées ; aucun recours à ICU, Intl, normalize(), toLowerCase() ni
// localeCompare().
//
// Échec fermé (section 7) : lexiques, entités ou version manquants ou
// invalides, normalisation indisponible → dégradé sûr, unité protégée.
//
// Versions (section 8) : Protection = règles v1 + empreinte du contenu des
// lexiques ; entités = règle d'extraction v1 + empreinte de la liste.

import crypto from "node:crypto";
import fs from "node:fs";

import { normalizeCoverageText } from "./coverage-normalization.js";

export const COVERAGE_PROTECTION_RULES_VERSION = "coverage-protection.v1";
export const RESEARCH_ENTITY_RULE_VERSION = "research-entities.v1";
export const COVERAGE_PROTECTION_LANGUAGE = "fr";

// Version de normalisation sur laquelle les lexiques v1 sont écrits.
const NORMALIZATION_VERSION = "coverage-normalization.v1";

export const PROTECTION_SIGNALS = Object.freeze([
  "digit",
  "quantity_word",
  "vague_quantifier",
  "comparative",
  "structural_punctuation",
  "direct_quotation",
  "typographic_proper_noun",
  "research_entity",
  "attribution_marker",
  "temporal_expression"
]);

export const PROTECTION_STATUS = Object.freeze({
  OK: "OK",
  DEGRADED: "DEGRADED"
});

const LEXICON_SIGNALS = Object.freeze({
  quantity_words: "quantity_word",
  vague_quantifiers: "vague_quantifier",
  comparatives: "comparative",
  attribution_markers: "attribution_marker",
  temporal_expressions: "temporal_expression"
});

const LEXICONS_FILE = new URL("../../config/coverage/protection-lexicons.fr.json", import.meta.url);

const DIGITS = new Set([
  ..."0123456789",
  ..."⁰¹²³⁴⁵⁶⁷⁸⁹",
  ..."₀₁₂₃₄₅₆₇₈₉",
  ..."¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞"
]);
const STRUCTURAL_PUNCTUATION = new Set([":", ";", "(", ")"]);
const QUOTATION_MARKS = new Set(["«", "»", "“", "”", "„", "\"", "‹", "›"]);
const UPPERCASE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸÆŒ"
);
const ENTRY_WORD = /^[a-z0-9]+$/;

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function validEntryList(list) {
  return Array.isArray(list) &&
    list.every(entry =>
      typeof entry === "string" &&
      entry.split(" ").every(word => ENTRY_WORD.test(word))
    ) &&
    list.every((entry, index) => index === 0 || list[index - 1] < entry);
}

function loadLexicons() {
  try {
    const data = JSON.parse(fs.readFileSync(LEXICONS_FILE, "utf8"));
    const keys = Object.keys(data ?? {}).sort();
    const expected = ["language", ...Object.keys(LEXICON_SIGNALS)].sort();

    if (
      data?.language !== COVERAGE_PROTECTION_LANGUAGE ||
      JSON.stringify(keys) !== JSON.stringify(expected) ||
      !Object.keys(LEXICON_SIGNALS).every(key => validEntryList(data[key]) && data[key].length > 0)
    ) {
      return null;
    }

    const canonical = JSON.stringify({
      language: data.language,
      ...Object.fromEntries(Object.keys(LEXICON_SIGNALS).map(key => [key, data[key]]))
    });

    return {
      entries: Object.entries(LEXICON_SIGNALS).map(([key, signal]) => ({
        signal,
        sequences: data[key].map(entry => entry.split(" "))
      })),
      version: `${COVERAGE_PROTECTION_RULES_VERSION}+lexicons.${sha256(canonical)}`
    };
  } catch {
    return null;
  }
}

const LEXICONS = loadLexicons();

// Version disponible : règles v1 + empreinte du contenu des lexiques ; null si
// les lexiques sont indisponibles (toute unité est alors protégée, dégradée).
export function coverageProtectionVersion() {
  return LEXICONS?.version ?? null;
}

function entitiesFingerprint(entities) {
  return sha256(JSON.stringify({ rule_version: RESEARCH_ENTITY_RULE_VERSION, entities }));
}

// Règle d'extraction v1 : dans chaque key_fact approuvé, toute suite de mots
// à majuscule initiale hors premier mot du key_fact, séparés uniquement par
// des espaces ou des traits d'union, forme une entité (mots normalisés). Les
// entités d'au moins deux caractères sont triées et dédoublonnées.
export function extractResearchEntities({ keyFacts, ruleVersion }) {
  if (ruleVersion !== RESEARCH_ENTITY_RULE_VERSION) {
    throw new Error(
      `Coverage Protection : règle d'extraction "${String(ruleVersion)}" refusée — ` +
      `règle disponible ${RESEARCH_ENTITY_RULE_VERSION} (verrou de versions).`
    );
  }
  if (!Array.isArray(keyFacts) || !keyFacts.every(fact => typeof fact === "string")) {
    throw new Error("Coverage Protection : keyFacts invalide (tableau de chaînes attendu).");
  }

  const found = new Set();

  for (const fact of keyFacts) {
    const words = normalizeCoverageText(fact, NORMALIZATION_VERSION).words;
    let current = [];

    const flush = () => {
      const entity = current.map(word => word.normalized).join(" ");
      if (entity.length >= 2) found.add(entity);
      current = [];
    };

    words.forEach((word, index) => {
      const candidate = index > 0 && UPPERCASE.has(word.original[0]);
      if (!candidate) {
        if (current.length) flush();
        return;
      }
      if (current.length) {
        const gap = fact.slice(current.at(-1).end, word.start);
        if (![...gap].every(character => character === " " || character === "-" || character === " ")) flush();
      }
      current.push(word);
    });
    if (current.length) flush();
  }

  const entities = [...found].sort();

  return Object.freeze({
    rule_version: RESEARCH_ENTITY_RULE_VERSION,
    entities: Object.freeze(entities),
    fingerprint: entitiesFingerprint(entities)
  });
}

function validEntities(entities) {
  return entities !== null && typeof entities === "object" &&
    entities.rule_version === RESEARCH_ENTITY_RULE_VERSION &&
    validEntryList(entities.entities) &&
    entities.entities.every(entry => entry.length >= 2) &&
    entities.fingerprint === entitiesFingerprint([...entities.entities]);
}

function validUnit(unit) {
  return unit !== null && typeof unit === "object" &&
    typeof unit.id === "string" && /^u[1-9][0-9]*$/.test(unit.id) &&
    Number.isSafeInteger(unit.rank) && unit.id === `u${unit.rank}` &&
    typeof unit.type === "string" &&
    Number.isSafeInteger(unit.start) && Number.isSafeInteger(unit.end) &&
    typeof unit.text === "string" && unit.text.length > 0 &&
    unit.end - unit.start === unit.text.length;
}

function match(text, start, end) {
  return Object.freeze({ text: text.slice(start, end), start, end });
}

function characterMatches(text, set, grouped) {
  const found = [];
  for (let index = 0; index < text.length; index += 1) {
    if (!set.has(text[index])) continue;
    let end = index + 1;
    if (grouped) while (end < text.length && set.has(text[end])) end += 1;
    found.push(match(text, index, end));
    index = end - 1;
  }
  return found;
}

function sequenceMatches(text, words, sequences) {
  const found = [];
  for (let index = 0; index < words.length; index += 1) {
    for (const sequence of sequences) {
      if (index + sequence.length > words.length) continue;
      if (sequence.every((part, offset) => words[index + offset].normalized === part)) {
        found.push(match(text, words[index].start, words[index + sequence.length - 1].end));
      }
    }
  }
  return found.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Traçabilité (I9, I10) : la sortie reprend la règle et l'empreinte de la
// liste d'entités validée en entrée ; null si aucune liste n'a été validée.
function result(unit, status, reason, signals, entities = null) {
  return Object.freeze({
    version: coverageProtectionVersion(),
    entities_rule_version: entities ? entities.rule_version : null,
    entities_fingerprint: entities ? entities.fingerprint : null,
    unit_id: unit.id,
    status,
    reason,
    protected: status === PROTECTION_STATUS.DEGRADED || signals.length > 0,
    signals: Object.freeze(signals.map(item => Object.freeze({
      signal: item.signal,
      matches: Object.freeze(item.matches)
    })))
  });
}

// Protège une unité du découpeur. `version` : version de Protection attendue
// (verrou) ; `entities` : résultat d'extractResearchEntities.
export function protectCoverageUnit({ unit, version, entities }) {
  if (!validUnit(unit)) {
    throw new Error("Coverage Protection : unité invalide (unité du découpeur attendue).");
  }

  if (!LEXICONS) return result(unit, PROTECTION_STATUS.DEGRADED, "lexiques indisponibles", []);
  if (version !== LEXICONS.version) {
    return result(unit, PROTECTION_STATUS.DEGRADED, `version inconnue (${String(version)})`, []);
  }
  if (!validEntities(entities)) {
    return result(unit, PROTECTION_STATUS.DEGRADED, "entités Research absentes ou invalides", []);
  }

  let words;
  try {
    words = normalizeCoverageText(unit.text, NORMALIZATION_VERSION).words;
  } catch {
    return result(unit, PROTECTION_STATUS.DEGRADED, "normalisation indisponible", [], entities);
  }

  const text = unit.text;
  const lexical = new Map(LEXICONS.entries.map(({ signal, sequences }) => [signal, sequenceMatches(text, words, sequences)]));
  const found = {
    digit: characterMatches(text, DIGITS, true),
    quantity_word: lexical.get("quantity_word"),
    vague_quantifier: lexical.get("vague_quantifier"),
    comparative: lexical.get("comparative"),
    structural_punctuation: characterMatches(text, STRUCTURAL_PUNCTUATION, false),
    direct_quotation: characterMatches(text, QUOTATION_MARKS, false),
    typographic_proper_noun: words
      .filter((word, index) => index > 0 && UPPERCASE.has(word.original[0]))
      .map(word => match(text, word.start, word.end)),
    research_entity: sequenceMatches(text, words, entities.entities.map(entry => entry.split(" "))),
    attribution_marker: lexical.get("attribution_marker"),
    temporal_expression: lexical.get("temporal_expression")
  };

  const signals = PROTECTION_SIGNALS
    .filter(signal => found[signal].length > 0)
    .map(signal => ({ signal, matches: found[signal] }));

  return result(unit, PROTECTION_STATUS.OK, null, signals, entities);
}
