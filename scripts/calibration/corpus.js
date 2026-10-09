// R29.6 — outil de calibration du juge : constructeur de corpus (jetable, hors
// pipeline de production). Module pur : aucune lecture de fichier, aucun réseau,
// aucune horloge, aucun hasard. Le même enchaînement d'entrées donne toujours le
// même corpus, octet pour octet (empreinte corpus_sha256).
//
// Trois sortes d'entrées :
//   A  segment réel existant, désigné explicitement (copie : voiceover, claims,
//      key_facts du dossier Research) ;
//   B  témoin « affirmation non soutenue » : un segment A auquel on ajoute une
//      phrase absente des claims (causalité, attribution, quantité, date) ;
//   C  témoin « reformulation » : les claims d'un segment A, dans l'ordre
//      inverse, séparés par des phrases d'accroche non factuelles.
// Des témoins C plus riches peuvent être fournis à la main (manualEntries).

import crypto from "node:crypto";

import { buildCoverageLock, researchEntitiesOf } from "../../src/utils/coverage-lock-builder.js";
import { composeCoverageBoundary } from "../../src/utils/composite-coverage-boundary.js";

export const CALIBRATION_CORPUS_VERSION = "judge-calibration-corpus.v1";

export const ENTRY_KINDS = Object.freeze(["A", "B", "C"]);

// Phrases non soutenues, dans l'ordre d'utilisation (indice B modulo 6). Les
// trois premières n'ont ni chiffre ni entité (unités « analysées », donc
// réparables par DELETE) ; les trois suivantes portent une quantité, une date
// ou une attribution (unités « protégées »).
export const UNSUPPORTED_SENTENCES = Object.freeze([
  Object.freeze({ id: "causalite", text: " Cette décision a provoqué l'effondrement de l'économie locale." }),
  Object.freeze({ id: "consequence", text: " Cette situation a eu pour conséquence directe la disparition de plusieurs villages." }),
  Object.freeze({ id: "propriete", text: " Les habitants considèrent depuis toujours ce lieu comme sacré." }),
  Object.freeze({ id: "quantite", text: " Ce phénomène aurait fait 4 200 victimes en 1987." }),
  Object.freeze({ id: "date", text: " Cette découverte date de 1912 et a bouleversé la région." }),
  Object.freeze({ id: "attribution", text: " Selon un ingénieur de Lyon, le projet a coûté trois milliards d'euros." })
]);

export const PARAPHRASE_CONNECTORS = Object.freeze([
  "Voici ce qu'il faut retenir.",
  "Reprenons calmement.",
  "Gardons ceci en tête."
]);

// Plan d'étapes validé (R29.6) : pilote 3 A + 3 B + 2 C ; le reste à l'étape 2 ;
// stabilité (étape 3) sur 4 A + 3 B + 3 C pris parmi les étapes 1 et 2.
export const DEFAULT_STAGE_PLAN = Object.freeze({
  pilot: Object.freeze({ A: 3, B: 3, C: 2 }),
  stability: Object.freeze({ A: 4, B: 3, C: 3 })
});

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const pad = number => String(number).padStart(3, "0");

function fail(message) {
  throw new Error(`Corpus de calibration : ${message}`);
}

// R29.6b : un claim garde, quand ils existent, sa référence au dossier Research
// (research_fact_ref), son indicateur is_unverified et le texte du key_fact
// référencé (résolu à la construction, key_fact). Seul `text` est envoyé au
// juge : les champs ajoutés ne servent qu'au rapport. Un claim sans ces champs
// reste { text }, exactement comme avant.
const cleanClaims = (claims, where, keyFacts = null) => {
  if (!Array.isArray(claims) || claims.length === 0) fail(`${where} : claims absents ou vides`);
  return claims.map((claim, index) => {
    if (typeof claim?.text !== "string" || claim.text.trim() === "") fail(`${where} : claim ${index + 1} sans texte`);
    const cleaned = { text: claim.text.trim() };
    if (Number.isSafeInteger(claim.research_fact_ref) && claim.research_fact_ref >= 0) cleaned.research_fact_ref = claim.research_fact_ref;
    if (typeof claim.is_unverified === "boolean") cleaned.is_unverified = claim.is_unverified;
    const keyFact = typeof claim.key_fact === "string" ? claim.key_fact : keyFacts?.[cleaned.research_fact_ref]?.claim;
    if (typeof keyFact === "string") cleaned.key_fact = keyFact;
    return cleaned;
  });
};

const cleanResearch = research => ({
  key_facts: (Array.isArray(research?.key_facts) ? research.key_facts : [])
    .map(fact => fact?.claim)
    .filter(claim => typeof claim === "string")
    .map(claim => ({ claim }))
});

// Segments d'un script, dans l'ordre, avec leur identifiant de couverture
// (s{section}-g{segment}), identique à celui de la porte de couverture.
function segmentsById(script) {
  const byId = new Map();
  const sections = Array.isArray(script?.sections) ? script.sections : [];
  sections.forEach((section, sectionIndex) => {
    (Array.isArray(section?.segments) ? section.segments : []).forEach((segment, segmentIndex) => {
      byId.set(`s${sectionIndex + 1}-g${segmentIndex + 1}`, segment);
    });
  });
  return byId;
}

// Entrées A : segments réels désignés explicitement par leur identifiant.
export function naturalEntries({ script, research, productionId, segmentIds }) {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0) fail("aucun segment désigné");
  if (new Set(segmentIds).size !== segmentIds.length) fail("segment désigné en double");
  if (typeof productionId !== "string" || productionId === "") fail("identifiant de production absent");

  const byId = segmentsById(script);
  const cleanedResearch = cleanResearch(research);

  return segmentIds.map((segmentId, index) => {
    const segment = byId.get(segmentId);
    if (!segment) fail(`segment ${segmentId} introuvable dans le script`);
    if (typeof segment.voiceover !== "string" || segment.voiceover.trim() === "") fail(`segment ${segmentId} : voiceover absent`);
    return {
      id: `A-${pad(index + 1)}`,
      kind: "A",
      origin: { production_id: productionId, segment_id: segmentId },
      research: cleanedResearch,
      segment: { voiceover: segment.voiceover, claims: cleanClaims(segment.claims, `segment ${segmentId}`, Array.isArray(research?.key_facts) ? research.key_facts : null) },
      expect: null
    };
  });
}

// Vérifie, avec la vraie frontière composée, qu'un voiceover donne au moins
// une unité désignée (non exclue) à partir de `fromOffset`. Renvoie les unités
// désignées concernées.
function designatedUnitsFrom(entry, fromOffset) {
  const entities = researchEntitiesOf(entry.research);
  const lock = buildCoverageLock({ entities });
  const boundary = composeCoverageBoundary({ voiceover: entry.segment.voiceover, lock, entities });
  if (boundary.status === "FAILED") fail(`${entry.id} : frontière en échec (${boundary.reason ?? "raison inconnue"})`);
  const designated = new Set(boundary.analysed_unit_ids);
  return boundary.units.map(item => item.unit).filter(unit => unit.start >= fromOffset && designated.has(unit.id));
}

const endsWithPunctuation = text => /[.!?…]$/.test(text.trimEnd());

// Témoin B : la phrase non soutenue est ajoutée à la fin du segment A.
export function unsupportedWitness(base, index) {
  if (base?.kind !== "A") fail("un témoin B se construit sur une entrée A");
  const sentence = UNSUPPORTED_SENTENCES[index % UNSUPPORTED_SENTENCES.length];
  const original = base.segment.voiceover.trimEnd();
  if (!endsWithPunctuation(original)) fail(`${base.id} : le voiceover ne se termine pas par une ponctuation`);
  const entry = {
    id: `B-${pad(index + 1)}`,
    kind: "B",
    origin: { ...base.origin, base_id: base.id },
    research: base.research,
    segment: { voiceover: original + sentence.text, claims: base.segment.claims },
    expect: { injected_start: original.length + 1, sentence_id: sentence.id }
  };
  if (designatedUnitsFrom(entry, entry.expect.injected_start).length === 0) {
    fail(`${entry.id} : la phrase « ${sentence.id} » ne donne aucune unité désignée`);
  }
  return entry;
}

// Témoin C : claims du segment A repris à l'identique, dans l'ordre inverse,
// précédés d'une phrase d'accroche non factuelle.
export function paraphraseWitness(base, index) {
  if (base?.kind !== "A") fail("un témoin C se construit sur une entrée A");
  const connector = PARAPHRASE_CONNECTORS[index % PARAPHRASE_CONNECTORS.length];
  const sentences = [...base.segment.claims].reverse().map(claim => {
    const text = claim.text.trim();
    return endsWithPunctuation(text) ? text : `${text}.`;
  });
  const entry = {
    id: `C-${pad(index + 1)}`,
    kind: "C",
    origin: { ...base.origin, base_id: base.id },
    research: base.research,
    segment: { voiceover: `${connector} ${sentences.join(" ")}`, claims: base.segment.claims },
    expect: { all_covered: true, connector_id: index % PARAPHRASE_CONNECTORS.length }
  };
  if (designatedUnitsFrom(entry, 0).length === 0) fail(`${entry.id} : aucune unité désignée`);
  return entry;
}

// Témoin fourni à la main (typiquement un C avec une vraie paraphrase) : même
// forme qu'une entrée, validée avant d'entrer dans le corpus.
function manualEntry(raw, index) {
  if (!isObject(raw) || !["B", "C"].includes(raw.kind)) fail(`témoin manuel ${index + 1} : kind B ou C attendu`);
  if (typeof raw.segment?.voiceover !== "string" || raw.segment.voiceover.trim() === "") fail(`témoin manuel ${index + 1} : voiceover absent`);
  const entry = {
    id: `${raw.kind}-M${pad(index + 1)}`,
    kind: raw.kind,
    origin: { manual: true },
    research: cleanResearch(raw.research),
    segment: { voiceover: raw.segment.voiceover, claims: cleanClaims(raw.segment.claims, `témoin manuel ${index + 1}`, Array.isArray(raw.research?.key_facts) ? raw.research.key_facts : null) },
    expect: raw.kind === "B"
      ? { injected_start: raw.expect?.injected_start, sentence_id: "manuel" }
      : { all_covered: true }
  };
  if (entry.kind === "B" && !Number.isSafeInteger(entry.expect.injected_start)) {
    fail(`témoin manuel ${index + 1} : injected_start (entier) obligatoire pour un B`);
  }
  if (designatedUnitsFrom(entry, entry.kind === "B" ? entry.expect.injected_start : 0).length === 0) {
    fail(`${entry.id} : aucune unité désignée`);
  }
  return entry;
}

// Affecte l'étape (1 ou 2) et l'indicateur de stabilité à chaque entrée, selon
// le plan : pour chaque sorte, les `pilot[kind]` premières entrées vont à
// l'étape 1, les suivantes à l'étape 2 ; les `stability[kind]` premières
// entrées de la sorte sont rejouées à l'étape 3.
export function assignStages(entries, plan = DEFAULT_STAGE_PLAN) {
  return entries.map(entry => {
    const position = entries.filter(other => other.kind === entry.kind).indexOf(entry);
    return {
      ...entry,
      stage: position < (plan.pilot[entry.kind] ?? 0) ? 1 : 2,
      stability: position < (plan.stability[entry.kind] ?? 0)
    };
  });
}

// Corpus complet : A tels quels, puis B et C construits sur les A (en
// tournant), plus d'éventuels témoins manuels.
export function buildCorpus({ naturals, countB = 0, countC = 0, manualEntries = [], plan = DEFAULT_STAGE_PLAN }) {
  if (!Array.isArray(naturals) || naturals.length === 0 || naturals.some(entry => entry?.kind !== "A")) {
    fail("au moins une entrée A est nécessaire");
  }
  if (!Number.isSafeInteger(countB) || countB < 0 || !Number.isSafeInteger(countC) || countC < 0) fail("effectifs B et C invalides");

  const witnessesB = Array.from({ length: countB }, (_, index) => unsupportedWitness(naturals[index % naturals.length], index));
  const witnessesC = Array.from({ length: countC }, (_, index) => paraphraseWitness(naturals[index % naturals.length], index));
  const manual = manualEntries.map(manualEntry);
  const entries = assignStages([...naturals, ...witnessesB, ...witnessesC, ...manual], plan);

  return finalizeCorpus(entries);
}

function countsOf(entries) {
  return Object.fromEntries(ENTRY_KINDS.map(kind => [kind, entries.filter(entry => entry.kind === kind).length]));
}

function finalizeCorpus(entries) {
  const body = { version: CALIBRATION_CORPUS_VERSION, counts: countsOf(entries), entries };
  return { ...body, corpus_sha256: sha256(stableJson(body)) };
}

// Contrôle complet d'un corpus lu depuis un fichier. Renvoie la liste des
// anomalies (vide si le corpus est valide).
export function corpusIssues(corpus) {
  const issues = [];
  if (!isObject(corpus)) return ["corpus illisible"];
  if (corpus.version !== CALIBRATION_CORPUS_VERSION) issues.push(`version inconnue : ${corpus.version}`);
  if (!Array.isArray(corpus.entries) || corpus.entries.length === 0) return [...issues, "entrées absentes"];

  const ids = new Set();
  for (const entry of corpus.entries) {
    const where = `entrée ${entry?.id ?? "?"}`;
    if (!isObject(entry) || typeof entry.id !== "string") { issues.push(`${where} : forme invalide`); continue; }
    if (ids.has(entry.id)) issues.push(`${where} : identifiant en double`);
    ids.add(entry.id);
    if (!ENTRY_KINDS.includes(entry.kind)) issues.push(`${where} : sorte inconnue`);
    if (![1, 2].includes(entry.stage)) issues.push(`${where} : étape invalide`);
    if (typeof entry.stability !== "boolean") issues.push(`${where} : indicateur de stabilité absent`);
    if (typeof entry.segment?.voiceover !== "string" || entry.segment.voiceover === "") issues.push(`${where} : voiceover absent`);
    if (!Array.isArray(entry.segment?.claims) || entry.segment.claims.length === 0 ||
      entry.segment.claims.some(claim => typeof claim?.text !== "string" || claim.text.trim() === "")) issues.push(`${where} : claims invalides`);
    if (!Array.isArray(entry.research?.key_facts)) issues.push(`${where} : research absent`);
    if (entry.kind === "B" && !Number.isSafeInteger(entry.expect?.injected_start)) issues.push(`${where} : injected_start absent`);
  }

  const { corpus_sha256: declared, ...body } = corpus;
  if (declared !== sha256(stableJson(body))) issues.push("corpus_sha256 ne correspond pas au contenu");
  if (stableJson(corpus.counts) !== stableJson(countsOf(corpus.entries))) issues.push("effectifs incohérents");
  return issues;
}

export function assertValidCorpus(corpus) {
  const issues = corpusIssues(corpus);
  if (issues.length > 0) fail(`invalide — ${issues.slice(0, 5).join(" ; ")}`);
  return corpus;
}

// Entrées d'une étape : 1 et 2 par leur indicateur, 3 = entrées de stabilité.
export function entriesForStage(corpus, stage) {
  assertValidCorpus(corpus);
  if (![1, 2, 3].includes(stage)) fail(`étape inconnue : ${stage}`);
  return corpus.entries.filter(entry => (stage === 3 ? entry.stability : entry.stage === stage));
}
