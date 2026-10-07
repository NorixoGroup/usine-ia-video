// R28.4 — Classification narrative de la frontière factuelle (baseline
// v1.0.1, contrat 4.4). Pour une unité NON protégée, elle reconnaît une entrée
// admise du registre et l'exclut ; sinon l'unité est analysée (ELIGIBLE).
//
// Entrée : l'unité du découpeur, sa forme normalisée (sortie de la
// normalisation) et sa décision de Protection (sortie de Protection). La
// Classification ne recalcule jamais la normalisation, les unités ni les
// protections : elle vérifie seulement leur cohérence avec l'unité.
//
// Garanties :
//   - elle ne fait qu'exclure (I3) : une unité protégée est toujours ELIGIBLE,
//     sans consulter le registre (I1, I5) ;
//   - par défaut ELIGIBLE ; un registre vide n'exclut rien (I4) ;
//   - l'ordre du registre est sans effet (I7) : toutes les entrées sont
//     évaluées, l'identifiant retenu est le plus petit ;
//   - chaque emplacement déclare sa borne, 3 mots normalisés au plus (I11) ;
//   - une entrée porte sur l'unité complète (mots normalisés + ponctuation
//     finale) ; aucune lecture du contexte.
//
// Ne lit jamais : le Research, les entités, les claims, les unités voisines,
// les verdicts. Les versions amont sont recopiées telles quelles en sortie
// pour la traçabilité, sans être interprétées.
//
// Échec fermé (section 7) : registre illisible ou invalide, version inconnue,
// entrées amont incohérentes → DEGRADED, ELIGIBLE (aucune exclusion).
//
// Version (section 8) : règles v1 + empreinte SHA-256 du contenu du registre.

import crypto from "node:crypto";
import fs from "node:fs";

export const COVERAGE_CLASSIFICATION_RULES_VERSION = "coverage-classification.v1";
export const COVERAGE_CLASSIFICATION_LANGUAGE = "fr";

// Version de normalisation sur laquelle le registre v0 est écrit.
const NORMALIZATION_VERSION = "coverage-normalization.v1";

export const CLASSIFICATION_DECISION = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  EXCLUDED: "EXCLUDED"
});

export const CLASSIFICATION_STATUS = Object.freeze({
  OK: "OK",
  DEGRADED: "DEGRADED"
});

export const REGISTRY_ENTRY_STATES = Object.freeze(["observed", "candidate", "admitted", "suspended", "retired"]);
export const REGISTRY_FAMILIES = Object.freeze(["question", "engagement", "transition"]);

const MAX_SLOT_BOUND = 3;
const REGISTRY_FILE = new URL("../../config/coverage/classification-registry.v0.json", import.meta.url);

const WHITESPACE = new Set([
  " ", "\t", "\n", "\r", "\f", "\v",
  " ", " ", " ", " ", " ", " "
]);
const TERMINALS = new Set([".", "!", "?", "…"]);
const WORD = /^[a-z0-9]+$/;
const ENTRY_ID = /^[a-z]+\.[a-z0-9-]+$/;

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function validPattern(pattern, bound) {
  return Array.isArray(pattern) && pattern.length > 0 &&
    pattern.every(part => {
      const keys = Object.keys(part ?? {});
      if (keys.length !== 1) return false;
      if (keys[0] === "word") return typeof part.word === "string" && WORD.test(part.word);
      if (keys[0] !== "slot") return false;
      const slot = part.slot;
      return slot !== null && typeof slot === "object" &&
        JSON.stringify(Object.keys(slot).sort()) === JSON.stringify(["max", "min"]) &&
        Number.isSafeInteger(slot.min) && Number.isSafeInteger(slot.max) &&
        slot.min >= 0 && slot.min <= slot.max && slot.max >= 1 && slot.max <= bound;
    });
}

function validEntry(entry, bound) {
  return entry !== null && typeof entry === "object" &&
    typeof entry.id === "string" && ENTRY_ID.test(entry.id) &&
    REGISTRY_ENTRY_STATES.includes(entry.state) &&
    entry.origin === "inherited" &&
    REGISTRY_FAMILIES.includes(entry.family) &&
    validPattern(entry.pattern, bound) &&
    (entry.terminal === null ||
      Array.isArray(entry.terminal) && entry.terminal.length > 0 &&
      entry.terminal.every(character => TERMINALS.has(character))) &&
    Array.isArray(entry.positives) && entry.positives.length > 0 &&
    entry.positives.every(text => typeof text === "string" && text.length > 0) &&
    Array.isArray(entry.counter_examples) && entry.counter_examples.length >= 3 &&
    entry.counter_examples.every(text => typeof text === "string" && text.length > 0);
}

function loadRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    const entries = data?.entries;

    if (
      data?.registry !== "coverage-classification-registry" ||
      data.version !== "v0" ||
      data.language !== COVERAGE_CLASSIFICATION_LANGUAGE ||
      data.slot_max_bound !== MAX_SLOT_BOUND ||
      !Array.isArray(entries) ||
      !entries.every(entry => validEntry(entry, data.slot_max_bound)) ||
      entries.some((entry, index) => index > 0 && !(entries[index - 1].id < entry.id))
    ) {
      return null;
    }

    const registrySha256 = sha256(JSON.stringify(data));

    return {
      registry_version: data.version,
      registry_sha256: registrySha256,
      admitted: entries.filter(entry => entry.state === "admitted"),
      version: `${COVERAGE_CLASSIFICATION_RULES_VERSION}+registry.${registrySha256}`
    };
  } catch {
    return null;
  }
}

const REGISTRY = loadRegistry();

// Version disponible : règles v1 + empreinte du registre ; null si le registre
// est indisponible (toute unité est alors ELIGIBLE, dégradée).
export function coverageClassificationVersion() {
  return REGISTRY?.version ?? null;
}

function patternMatches(words, pattern, wordIndex = 0, partIndex = 0) {
  if (partIndex === pattern.length) return wordIndex === words.length;
  const part = pattern[partIndex];

  if ("word" in part) {
    return words[wordIndex] === part.word && patternMatches(words, pattern, wordIndex + 1, partIndex + 1);
  }
  for (let size = part.slot.min; size <= part.slot.max && wordIndex + size <= words.length; size += 1) {
    if (patternMatches(words, pattern, wordIndex + size, partIndex + 1)) return true;
  }
  return false;
}

// Identifiants des entrées admises qui reconnaissent l'unité complète, triés.
// Pure et indépendante de l'ordre des entrées (I7).
export function matchRegistryEntries({ words, terminal, entries }) {
  return entries
    .filter(entry => entry.state === "admitted")
    .filter(entry => entry.terminal === null || entry.terminal.includes(terminal))
    .filter(entry => patternMatches(words, entry.pattern))
    .map(entry => entry.id)
    .sort();
}

function lastNonWhitespace(text) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!WHITESPACE.has(text[index])) return text[index];
  }
  return null;
}

function validUnit(unit) {
  return unit !== null && typeof unit === "object" &&
    typeof unit.id === "string" && /^u[1-9][0-9]*$/.test(unit.id) &&
    typeof unit.text === "string" && unit.text.length > 0;
}

function coherentNormalization(unit, normalization) {
  if (
    normalization === null || typeof normalization !== "object" ||
    normalization.version !== NORMALIZATION_VERSION || !Array.isArray(normalization.words)
  ) return false;

  let previousEnd = 0;
  return normalization.words.every(word => {
    const ok = word !== null && typeof word === "object" &&
      typeof word.normalized === "string" && WORD.test(word.normalized) &&
      Number.isSafeInteger(word.start) && Number.isSafeInteger(word.end) &&
      word.start >= previousEnd && word.end > word.start && word.end <= unit.text.length &&
      word.original === unit.text.slice(word.start, word.end);
    previousEnd = word?.end ?? previousEnd;
    return ok;
  });
}

function coherentProtection(unit, protection) {
  return protection !== null && typeof protection === "object" &&
    protection.unit_id === unit.id &&
    typeof protection.protected === "boolean" &&
    Array.isArray(protection.signals) &&
    (
      protection.status === "OK" && protection.protected === protection.signals.length > 0 ||
      protection.status === "DEGRADED" && protection.protected === true && protection.signals.length === 0
    );
}

function upstreamTrace(normalization, protection) {
  return Object.freeze({
    normalization_version: typeof normalization?.version === "string" ? normalization.version : null,
    protection_version: typeof protection?.version === "string" ? protection.version : null,
    entities_rule_version: typeof protection?.entities_rule_version === "string" ? protection.entities_rule_version : null,
    entities_fingerprint: typeof protection?.entities_fingerprint === "string" ? protection.entities_fingerprint : null
  });
}

function result(unit, normalization, protection, { status, reason, decision, entryId = null }) {
  const entry = entryId ? REGISTRY.admitted.find(item => item.id === entryId) : null;
  return Object.freeze({
    version: coverageClassificationVersion(),
    registry_version: REGISTRY?.registry_version ?? null,
    registry_sha256: REGISTRY?.registry_sha256 ?? null,
    upstream: upstreamTrace(normalization, protection),
    unit_id: unit.id,
    status,
    reason,
    decision,
    entry_id: entry ? entry.id : null,
    entry_family: entry ? entry.family : null
  });
}

const degraded = (unit, normalization, protection, reason) =>
  result(unit, normalization, protection, {
    status: CLASSIFICATION_STATUS.DEGRADED,
    reason,
    decision: CLASSIFICATION_DECISION.ELIGIBLE
  });

// Classe une unité. `version` : version de Classification attendue (verrou) ;
// `normalization` : sortie de la normalisation pour unit.text ; `protection` :
// sortie de Protection pour cette unité.
export function classifyCoverageUnit({ unit, normalization, protection, version }) {
  if (!validUnit(unit)) {
    throw new Error("Coverage Classification : unité invalide (unité du découpeur attendue).");
  }

  if (!REGISTRY) return degraded(unit, normalization, protection, "registre indisponible");
  if (version !== REGISTRY.version) {
    return degraded(unit, normalization, protection, `version inconnue (${String(version)})`);
  }
  if (!coherentProtection(unit, protection)) {
    return degraded(unit, normalization, protection, "protection absente ou incohérente");
  }
  if (!coherentNormalization(unit, normalization)) {
    return degraded(unit, normalization, protection, "normalisation absente ou incohérente");
  }

  if (protection.protected) {
    return result(unit, normalization, protection, {
      status: CLASSIFICATION_STATUS.OK,
      reason: "unité protégée",
      decision: CLASSIFICATION_DECISION.ELIGIBLE
    });
  }

  const matches = matchRegistryEntries({
    words: normalization.words.map(word => word.normalized),
    terminal: lastNonWhitespace(unit.text),
    entries: REGISTRY.admitted
  });

  if (matches.length === 0) {
    return result(unit, normalization, protection, {
      status: CLASSIFICATION_STATUS.OK,
      reason: null,
      decision: CLASSIFICATION_DECISION.ELIGIBLE
    });
  }

  return result(unit, normalization, protection, {
    status: CLASSIFICATION_STATUS.OK,
    reason: null,
    decision: CLASSIFICATION_DECISION.EXCLUDED,
    entryId: matches[0]
  });
}
