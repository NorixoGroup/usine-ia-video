import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createMessage, extractText } from "../services/anthropic.js";
import { TITLE_VALIDATION, evidenceConfirmed, extractFigures } from "./title-validation.js";

export { evidenceConfirmed };

// Fact ↔ Evidence (R20.4, phase E) — rubrique du Truth Report.
//
// Le code possède lui-même les preuves : chaque page citée par un fait
// vérifié est lue localement (simple requête HTTP, aucun modèle), son texte
// est enregistré une fois avec son empreinte (evidence.json et
// evidence/<sha256>.txt), puis relu sur le disque à chaque reprise, sans
// réseau.
//
// Deux statuts distincts par fait, jamais mélangés :
// - technical_status : ce qui a pu être lu (page lue, HTTP, délai, PDF,
//   JavaScript, inaccessible…) ;
// - editorial_status : ce que la preuve établit (supported,
//   partially_supported, rejected, unverifiable, not_checked).
//   not_checked n'est possible que si aucune preuve n'a été lue (fait non
//   vérifié par Research, ou production historique) : un fait vérifié dont
//   une preuve a été lue finit toujours supported, partially_supported,
//   rejected ou unverifiable (invariant vérifié à chaque évaluation).
//
// Le code est souverain : un chiffre, une date ou une citation du fait
// absent de toutes les preuves lues rend le fait « rejected », quoi que
// dise le juge. Le juge (un appel par lot de faits) ne tranche que le sens,
// sur des extraits choisis par le code, et doit citer mot pour mot un
// passage que le code retrouve dans le texte enregistré.

export const EVIDENCE_SCHEMA = "evidence.v1";
export const EVIDENCE_DIR = "evidence";
export const EVIDENCE_FIXTURE_DIR_ENV = "EVIDENCE_FIXTURE_DIR";

export const EDITORIAL_STATUSES = ["supported", "partially_supported", "rejected", "unverifiable", "not_checked"];
export const TECHNICAL_STATUSES = [
  "fetched",
  "http_error",
  "timeout",
  "pdf",
  "javascript_required",
  "unsupported_type",
  "too_large",
  "empty",
  "network_error",
  "network_disabled",
  "not_fetched"
];

const JUDGE_STATUSES = ["supported", "partially_supported", "not_supported"];
const SEVERITY = { supported: 0, partially_supported: 1, unverifiable: 2, rejected: 3 };
const CONFIG_KEYS = new Set([
  "fetch_timeout_ms",
  "max_bytes",
  "user_agent",
  "min_text_length",
  "accepted_content_types",
  "excerpt_chars",
  "max_excerpts_per_source",
  "judge_batch_size"
]);

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------
// Configuration (config/research.json → fact_evidence)
// ---------------------------------------------------------------------

export function validateFactEvidenceConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["fact_evidence absente ou invalide"];
  }

  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`clé inconnue : ${key}`);
  }

  const integer = (key, min, max) => {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) errors.push(`${key} doit être un entier de ${min} à ${max}`);
  };

  integer("fetch_timeout_ms", 1000, 60000);
  integer("max_bytes", 10000, 5000000);
  integer("min_text_length", 1, 10000);
  integer("excerpt_chars", 100, 2000);
  integer("max_excerpts_per_source", 1, 10);
  integer("judge_batch_size", 1, 20);

  if (!isNonEmptyString(config.user_agent)) errors.push("user_agent manquant");

  if (!Array.isArray(config.accepted_content_types) || config.accepted_content_types.length === 0
    || !config.accepted_content_types.every(type => typeof type === "string" && /^[a-z]+\/[a-z0-9.+-]+$/.test(type))) {
    errors.push("accepted_content_types doit être une liste de types MIME");
  }

  return errors;
}

export function loadFactEvidenceConfig(config) {
  const errors = validateFactEvidenceConfig(config?.fact_evidence);

  if (errors.length > 0) {
    throw new Error(`config/research.json → fact_evidence invalide : ${errors.join(" ; ")}`);
  }

  return Object.freeze(structuredClone(config.fact_evidence));
}

export const FACT_EVIDENCE = loadFactEvidenceConfig(
  JSON.parse(fs.readFileSync(new URL("../../config/research.json", import.meta.url), "utf8"))
);

// ---------------------------------------------------------------------
// Faits contrôlés et URL à lire
// ---------------------------------------------------------------------

// Q-E4 : tous les faits « verified » sont contrôlés.
export function controlledFacts(research) {
  const facts = Array.isArray(research?.key_facts) ? research.key_facts : [];

  return facts
    .map((fact, index) => ({ fact, index }))
    .filter(({ fact }) => fact?.verification_status === "verified");
}

export function evidenceUrls(research) {
  return [...new Set(controlledFacts(research).flatMap(({ fact }) => (fact.sources ?? []).map(source => source?.url).filter(isNonEmptyString).map(url => url.trim())))];
}

// ---------------------------------------------------------------------
// Lecture locale des pages (aucun modèle)
// ---------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", ndash: "–", mdash: "—", eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ocirc: "ô", ucirc: "û", icirc: "î", iuml: "ï", euml: "ë", deg: "°", sup2: "²" };

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z0-9]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

// Texte lisible d'une page HTML : scripts, styles et balises retirés.
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Exposants d'unité (km<sup>2</sup>, m<sup>3</sup>) conservés en « ² » et « ³ ».
      .replace(/<sup\b[^>]*>\s*2\s*<\/sup>/gi, "²")
      .replace(/<sup\b[^>]*>\s*3\s*<\/sup>/gi, "³")
      .replace(/<(br|p|div|li|h[1-6]|tr|td|th|section|article|header|footer)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function mediaType(contentType) {
  return String(contentType ?? "").split(";")[0].trim().toLowerCase();
}

// Lecture de test : sous NO_API=1, EVIDENCE_FIXTURE_DIR fournit les pages
// (fichier <sha256(url)>.json : status, content_type, body, final_url).
// Aucune autre sortie réseau n'est possible dans ce mode.
async function fixtureFetch(url, dir) {
  const file = path.join(dir, `${sha256(url)}.json`);

  if (!fs.existsSync(file)) {
    const error = new Error("page absente du jeu de test");
    error.code = "FIXTURE_MISSING";
    throw error;
  }

  const page = JSON.parse(fs.readFileSync(file, "utf8"));

  if (page.timeout === true) {
    const error = new Error("délai dépassé (simulé)");
    error.name = "TimeoutError";
    throw error;
  }

  return {
    status: page.status,
    url: page.final_url ?? url,
    headers: { get: name => (name.toLowerCase() === "content-type" ? page.content_type ?? null : null) },
    text: async () => page.body ?? ""
  };
}

// Lit une URL et renvoie l'enregistrement de preuve et son texte. Ne lève
// jamais pour un problème technique : il est consigné dans technical_status.
export async function readEvidencePage(url, { config = FACT_EVIDENCE, fetchImpl = null, now = () => new Date() } = {}) {
  const fixtureDir = process.env[EVIDENCE_FIXTURE_DIR_ENV];
  const record = {
    url,
    final_url: null,
    fetched_at: now().toISOString(),
    http_status: null,
    content_type: null,
    text_sha256: null,
    text_length: 0,
    technical_status: "network_error",
    detail: null
  };

  const doFetch = fetchImpl
    ?? (process.env.NO_API === "1"
      ? (fixtureDir ? requestUrl => fixtureFetch(requestUrl, fixtureDir) : null)
      : (requestUrl, options) => fetch(requestUrl, options));

  if (!doFetch) {
    return { record: { ...record, technical_status: "network_disabled", detail: "NO_API=1 sans jeu de pages de test : aucune lecture réseau" }, text: null };
  }

  let response;

  try {
    response = await doFetch(url, {
      redirect: "follow",
      headers: { "user-agent": config.user_agent, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
      signal: AbortSignal.timeout(config.fetch_timeout_ms)
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";

    return {
      record: { ...record, technical_status: timeout ? "timeout" : "network_error", detail: timeout ? `aucune réponse en ${config.fetch_timeout_ms} ms` : String(error?.message ?? error).slice(0, 200) },
      text: null
    };
  }

  record.final_url = response.url || url;
  record.http_status = response.status;
  record.content_type = response.headers.get("content-type");

  const type = mediaType(record.content_type);

  if (response.status < 200 || response.status >= 300) {
    return { record: { ...record, technical_status: "http_error", detail: `HTTP ${response.status}` }, text: null };
  }

  if (type === "application/pdf" || /\.pdf($|[?#])/i.test(record.final_url)) {
    return { record: { ...record, technical_status: "pdf", detail: "PDF : extraction non prise en charge dans cette phase" }, text: null };
  }

  if (!config.accepted_content_types.includes(type)) {
    return { record: { ...record, technical_status: "unsupported_type", detail: `type ${type || "inconnu"} non pris en charge` }, text: null };
  }

  const body = await response.text();

  if (Buffer.byteLength(body, "utf8") > config.max_bytes) {
    return { record: { ...record, technical_status: "too_large", detail: `page de plus de ${config.max_bytes} octets` }, text: null };
  }

  const text = type === "text/plain" ? body.trim() : htmlToText(body);

  if (text.length < config.min_text_length) {
    const scripted = /<script\b/i.test(body);

    return {
      record: { ...record, text_length: text.length, technical_status: scripted ? "javascript_required" : "empty", detail: scripted ? "contenu rendu par JavaScript : texte lisible insuffisant" : "texte lisible insuffisant" },
      text: null
    };
  }

  return {
    record: { ...record, text_sha256: sha256(text), text_length: text.length, technical_status: "fetched" },
    text
  };
}

// Lit toutes les URL (une fois) et écrit les textes dans evidence/.
// Renvoie l'artefact evidence.json (à sceller par l'appelant).
export async function collectEvidence({ research, productionDir, config = FACT_EVIDENCE, fetchImpl = null, now }) {
  const sources = [];

  for (const url of evidenceUrls(research)) {
    const { record, text } = await readEvidencePage(url, { config, fetchImpl, now });

    if (text !== null) {
      const dir = path.join(productionDir, EVIDENCE_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${record.text_sha256}.txt`), text);
    }

    sources.push(record);
  }

  return { schema: EVIDENCE_SCHEMA, sources };
}

// Relit les textes enregistrés, sans réseau. Fail-closed : un texte absent
// ou dont l'empreinte diffère fait échouer l'étape.
export function loadEvidenceTexts({ evidence, productionDir }) {
  const texts = new Map();

  for (const record of evidence.sources) {
    if (record.technical_status !== "fetched") continue;

    const file = path.join(productionDir, EVIDENCE_DIR, `${record.text_sha256}.txt`);

    if (!fs.existsSync(file)) {
      throw new Error(`Preuves : texte enregistré absent pour ${record.url} (${record.text_sha256}).`);
    }

    const text = fs.readFileSync(file, "utf8");

    if (sha256(text) !== record.text_sha256) {
      throw new Error(`Preuves : texte enregistré modifié pour ${record.url} (empreinte différente).`);
    }

    texts.set(record.url, text);
  }

  return texts;
}

export function validateEvidenceArtifact(evidence, research) {
  const errors = [];

  if (evidence?.schema !== EVIDENCE_SCHEMA || !Array.isArray(evidence?.sources)) {
    return [`schéma ${EVIDENCE_SCHEMA} attendu`];
  }

  const urls = evidence.sources.map(record => record?.url);
  const expected = evidenceUrls(research);

  if (urls.length !== expected.length || expected.some(url => !urls.includes(url))) {
    errors.push("evidence.json ne couvre pas exactement les URL des faits vérifiés");
  }

  evidence.sources.forEach((record, index) => {
    if (!TECHNICAL_STATUSES.includes(record?.technical_status)) errors.push(`sources[${index}] : technical_status invalide`);
    if (!isNonEmptyString(record?.fetched_at)) errors.push(`sources[${index}] : fetched_at manquant`);
    if (record?.technical_status === "fetched" && !/^[0-9a-f]{64}$/.test(record?.text_sha256 ?? "")) errors.push(`sources[${index}] : text_sha256 invalide`);
  });

  return errors;
}

// ---------------------------------------------------------------------
// Éléments vérifiables d'un fait et recherche dans la preuve
// ---------------------------------------------------------------------

function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”«»]/g, "\"")
    .replace(/ | /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_ALIASES = {
  "km": "km", "m": "m", "mm": "mm", "cm": "cm", "kg": "kg", "t": "t", "ha": "ha",
  "km²": "km²", "m²": "m²", "cm²": "cm²", "mm²": "mm²", "km³": "km³", "m³": "m³", "cm³": "cm³", "mm³": "mm³",
  "°c": "°C", "°": "°C", "hab": "habitants", "habitant": "habitants", "habitants": "habitants"
};

// Unités qui admettent un exposant écrit « km 2 », « km2 » ou « km^2 »
// (texte d'une page dont la balise <sup> a été retirée).
const EXPONENT_UNITS = new Set(["km", "m", "cm", "mm"]);
const EXPONENTS = { "2": "²", "3": "³", "²": "²", "³": "³" };

// Unité lue juste après un chiffre : mot, puis exposant éventuel, isolé
// (non suivi d'un autre chiffre). Renvoie l'unité normalisée et la longueur
// lue, ou null.
const UNIT_PATTERN = /^\s*([\p{L}°]+)(?:([²³])|\s*\^?\s*([23])(?!\d|[.,]\d))?/u;

function readUnit(rest) {
  const match = rest.match(UNIT_PATTERN);

  if (!match) return null;

  const word = match[1].toLowerCase();
  const exponent = match[2] ?? match[3] ?? null;

  if (exponent && EXPONENT_UNITS.has(word)) {
    return { unit: UNIT_ALIASES[`${word}${EXPONENTS[exponent]}`] ?? null, length: match[0].length };
  }

  const bare = rest.match(/^\s*([\p{L}°]+)/u);

  return { unit: UNIT_ALIASES[word] ?? null, length: bare[0].length };
}
const SCALES = { million: 1e6, millions: 1e6, milliard: 1e9, milliards: 1e9 };

// Quantité d'un chiffre dans son texte : échelle (« 1,37 million » →
// 1 370 000) et unité reconnue (« km », « habitants »…), ou null.
function quantityOf(text, figure) {
  if (figure.percent) return { low: figure.low, high: figure.high, unit: "%" };

  let rest = text.slice(figure.position + figure.text.length);
  let scale = 1;
  const scaleMatch = rest.match(/^\s*(millions?|milliards?)\b\s*(?:de\s+|d['’]\s*)?/iu);

  if (scaleMatch) {
    scale = SCALES[scaleMatch[1].toLowerCase()];
    rest = rest.slice(scaleMatch[0].length);
  }

  return { low: figure.low * scale, high: figure.high * scale, unit: readUnit(rest)?.unit ?? null };
}

// Éléments contrôlés par le code : nombres (avec leur unité quand elle est
// reconnue), années et citations entre guillemets.
export function factElements(claim) {
  const text = String(claim ?? "");
  const elements = [];
  const approximation = TITLE_VALIDATION.markers.approximation;

  for (const figure of extractFigures(text)) {
    const quantity = quantityOf(text, figure);
    const unit = quantity.unit;
    const before = normalizeText(text.slice(0, figure.position)).replace(/'/g, " ").split(" ").filter(Boolean).slice(-TITLE_VALIDATION.approximation_window_words).join(" ");
    const year = !figure.percent && figure.low === figure.high && Number.isInteger(figure.low) && figure.low >= 1000 && figure.low <= 2100 && !/\d[  ]\d/.test(figure.text);

    const end = figure.position + figure.text.length;
    const scaleLength = text.slice(end).match(/^\s*(?:millions?|milliards?)\b\s*(?:de\s+|d['’]\s*)?/iu)?.[0].length ?? 0;
    const shown = unit && unit !== "%" ? text.slice(figure.position, end + scaleLength + (readUnit(text.slice(end + scaleLength))?.length ?? 0)).trim() : figure.text;

    elements.push({
      kind: year ? "date" : "figure",
      text: shown,
      figure: { low: quantity.low, high: quantity.high, percent: figure.percent },
      unit,
      approximate: approximation.some(marker => ` ${before} `.includes(` ${marker} `))
    });
  }

  for (const match of text.matchAll(/[«"“]\s*([^«»"“”]{8,}?)\s*[»"”]/g)) {
    elements.push({ kind: "quote", text: match[1].trim() });
  }

  return elements;
}

function figureInEvidence(element, evidenceText, tolerance) {
  const candidates = extractFigures(evidenceText)
    .filter(candidate => candidate.percent === element.figure.percent)
    .map(candidate => ({ ...candidate, ...quantityOf(evidenceText, candidate) }));
  const unitOk = candidate => !element.unit || element.unit === "%" || candidate.unit === element.unit;
  const margin = value => Math.abs(value) * (element.approximate ? tolerance : 0);
  const near = (a, b) => Math.abs(a - b) <= margin(b) + 1e-9;

  // Fourchette : la même fourchette, ou les deux bornes présentes chacune,
  // à la valeur exacte et avec la même unité. Aucune tolérance sur les
  // bornes, même avec « environ ».
  if (element.figure.low !== element.figure.high) {
    const same = (a, b) => Math.abs(a - b) < 1e-9;
    const range = candidates.find(candidate => unitOk(candidate) && same(element.figure.low, candidate.low) && same(element.figure.high, candidate.high));
    if (range) return range;

    const low = candidates.find(candidate => unitOk(candidate) && candidate.low === candidate.high && same(element.figure.low, candidate.low));
    const high = candidates.find(candidate => unitOk(candidate) && candidate.low === candidate.high && same(element.figure.high, candidate.high));

    return low && high ? low : null;
  }

  return candidates.find(candidate => unitOk(candidate) && candidate.low <= element.figure.low + margin(element.figure.low) && candidate.high >= element.figure.high - margin(element.figure.high)) ?? null;
}

function sentenceAround(text, index, size) {
  const start = Math.max(0, text.lastIndexOf(".", index) + 1, index - size / 2);
  const endDot = text.indexOf(".", index);
  const end = Math.min(text.length, endDot === -1 ? index + size / 2 : endDot + 1, start + size);

  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export function findElement(element, evidenceText, config = FACT_EVIDENCE) {
  if (element.kind === "quote") {
    const haystack = normalizeText(evidenceText);
    const position = haystack.indexOf(normalizeText(element.text));

    return position === -1 ? null : { excerpt: sentenceAround(evidenceText, Math.min(position, evidenceText.length - 1), config.excerpt_chars) };
  }

  const candidate = figureInEvidence(element, evidenceText, TITLE_VALIDATION.approximate_figure_tolerance);

  return candidate ? { excerpt: sentenceAround(evidenceText, candidate.position, config.excerpt_chars), found: candidate.text } : null;
}

// Extraits remis au juge : phrases contenant les éléments trouvés, puis
// phrases partageant le plus de mots significatifs avec le fait.
export function selectExcerpts(claim, evidenceText, config = FACT_EVIDENCE) {
  const excerpts = [];
  const add = excerpt => { if (excerpt && !excerpts.includes(excerpt) && excerpts.length < config.max_excerpts_per_source) excerpts.push(excerpt); };

  for (const element of factElements(claim)) add(findElement(element, evidenceText, config)?.excerpt);

  const words = [...new Set(normalizeText(claim).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 5))];
  const sentences = evidenceText.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(sentence => sentence.length >= 30);

  sentences
    .map((sentence, position) => ({ sentence, position, score: words.filter(word => normalizeText(sentence).includes(word)).length }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .forEach(item => add(item.sentence.slice(0, config.excerpt_chars)));

  return excerpts;
}

// ---------------------------------------------------------------------
// Contrôles hors réseau (productions historiques comprises)
// ---------------------------------------------------------------------

// Provenance : les URL citées figurent-elles dans les résultats réels de
// la recherche web de Research (réponses du journal des appels) ?
export function researchSearchUrls(productionDir) {
  const journal = path.join(productionDir, "calls.json");

  if (!fs.existsSync(journal)) return null;

  const urls = new Set();
  let found = false;

  for (const entry of JSON.parse(fs.readFileSync(journal, "utf8")).entries ?? []) {
    const file = path.join(productionDir, "call-cache", `${entry.request_sha256}.json`);

    if (!fs.existsSync(file)) continue;

    const content = JSON.parse(fs.readFileSync(file, "utf8"))?.result?.response?.content ?? [];

    for (const block of content) {
      if (block?.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;

      found = true;
      for (const result of block.content) if (isNonEmptyString(result?.url)) urls.add(result.url.trim());
    }
  }

  return found ? urls : null;
}

export function offlineChecks(research, { searchUrls = null } = {}) {
  const checks = [];

  for (const { fact, index } of controlledFacts(research)) {
    const sources = fact.sources ?? [];

    if (searchUrls) {
      const missing = sources.map(source => source?.url).filter(url => isNonEmptyString(url) && !searchUrls.has(url.trim()));

      checks.push({
        fact: index,
        check: "provenance",
        status: missing.length === 0 ? "ok" : "warning",
        reason: missing.length === 0
          ? "toutes les URL citées figurent dans les résultats réels de la recherche web"
          : `URL absente(s) des résultats réels de la recherche web : ${missing.join(", ")}`
      });
    }

    const declared = sources.map(source => source?.supports_claim ?? "").join(" \n ");

    for (const element of factElements(fact.claim).filter(item => item.kind !== "quote")) {
      if (!findElement(element, declared)) {
        const near = extractFigures(declared)
          .filter(candidate => candidate.percent === element.figure.percent && (element.unit === null || quantityOf(declared, candidate).unit === element.unit))
          .map(candidate => `« ${candidate.text}${element.unit && element.unit !== "%" ? ` ${element.unit}` : ""} »`);

        checks.push({
          fact: index,
          check: "internal_consistency",
          status: "warning",
          reason: `${element.kind === "date" ? "date" : "chiffre"} « ${element.text} » du fait absent de ce que ses sources déclarent confirmer${near.length > 0 ? ` (elles déclarent ${[...new Set(near)].join(", ")})` : ""}`
        });
      }
    }
  }

  return checks;
}

// ---------------------------------------------------------------------
// Juge des preuves
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = `
Tu es le juge des preuves de la chaîne YouTube "Les Découvertes du Nomade".

Pour chaque fait, tu reçois son affirmation et des extraits exacts des
pages qu'il cite comme preuves. Les extraits ont été lus et choisis par le
code : ce sont les seules informations dont tu disposes.

Pour CHAQUE fait, indique :
- status : "supported" si un extrait établit l'affirmation entière (même
  portée, même sens, mêmes chiffres), "partially_supported" s'il n'en
  établit qu'une partie, "not_supported" sinon ;
- source : l'identifiant de l'extrait qui la soutient le mieux (ou "" si
  not_supported) ;
- quote : la phrase recopiée MOT POUR MOT depuis cet extrait (ou "") ;
- explanation : une phrase précise qui justifie ton statut.

Règles :
- Vérifie la portée (territoire ou population, pays ou région), l'unité,
  la causalité et l'absence de généralisation abusive.
- N'utilise aucune connaissance extérieure aux extraits.
- Ne reformule jamais la citation.

Réponds uniquement en JSON valide, sans markdown ni texte autour :

{
  "facts": [
    { "id": "", "status": "", "source": "", "quote": "", "explanation": "" }
  ]
}
`.trim();

const DATA_MARKER = "DONNÉES :\n";

export function buildEvidenceJudgeItems({ research, evidence, texts, config = FACT_EVIDENCE }) {
  const records = new Map(evidence.sources.map(record => [record.url, record]));

  return controlledFacts(research).map(({ fact, index }) => ({
    id: `f${index + 1}`,
    index,
    claim: fact.claim,
    excerpts: (fact.sources ?? [])
      .map((source, position) => ({ source, position }))
      .filter(({ source }) => texts.has(source?.url?.trim()) && records.get(source.url.trim())?.technical_status === "fetched")
      .flatMap(({ source, position }) => selectExcerpts(fact.claim, texts.get(source.url.trim()), config).map((text, rank) => ({
        id: `f${index + 1}-s${position + 1}-e${rank + 1}`,
        url: source.url.trim(),
        text
      })))
  }));
}

export function judgeBatches(items, config = FACT_EVIDENCE) {
  const batches = [];

  for (let start = 0; start < items.length; start += config.judge_batch_size) {
    batches.push(items.slice(start, start + config.judge_batch_size));
  }

  return batches;
}

const batchPayload = batch => batch.map(({ id, claim, excerpts }) => ({ id, claim, excerpts: excerpts.map(({ id: excerptId, text }) => ({ id: excerptId, text })) }));

export function evidenceJudgeInputSha256(batch) {
  return sha256(`${SYSTEM_PROMPT}\n${JSON.stringify(batchPayload(batch))}`);
}

export function validateEvidenceJudgeResponse(response, batch) {
  const errors = [];

  if (!response || typeof response !== "object" || !Array.isArray(response.facts)) {
    return ["objet { facts: [] } attendu"];
  }

  const ids = batch.map(item => item.id);
  const seen = response.facts.map(item => item?.id);

  if (seen.length !== ids.length || ids.some(id => !seen.includes(id)) || new Set(seen).size !== seen.length) {
    errors.push(`facts doit répondre exactement une fois à ${ids.join(", ")}`);
  }

  response.facts.forEach((item, position) => {
    const expected = batch.find(entry => entry.id === item?.id);

    if (!JUDGE_STATUSES.includes(item?.status)) errors.push(`facts[${position}] : status invalide`);
    if (!isNonEmptyString(item?.explanation)) errors.push(`facts[${position}] : explanation manquante`);
    if (typeof item?.source !== "string" || typeof item?.quote !== "string") errors.push(`facts[${position}] : source et quote doivent être des chaînes`);
    if (item?.status !== "not_supported" && expected && !expected.excerpts.some(excerpt => excerpt.id === item?.source)) errors.push(`facts[${position}] : source inconnue ${item?.source}`);
    if (item?.status !== "not_supported" && !isNonEmptyString(item?.quote)) errors.push(`facts[${position}] : quote manquante`);
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

// Un appel par lot, plus au plus une réparation. Passe par createMessage :
// garde des appels, plafond, journal et cache.
export async function runEvidenceJudgeBatch(batch) {
  const payload = JSON.stringify(batchPayload(batch));
  const usage = [];
  let previous = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const content = previous
      ? `RÉPARATION — ta réponse précédente était invalide : ${previous.errors.join(" ; ")}\n\nRéponse précédente :\n${previous.text}\n\nÉvalue de nouveau les faits suivants.\n\n${DATA_MARKER}${payload}`
      : `Évalue les faits suivants.\n\n${DATA_MARKER}${payload}`;

    const { response, meta } = await createMessage({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      maxTokens: 3000,
      temperature: 0
    });

    usage.push(meta);

    const text = extractText(response);
    const parsed = meta.stop_reason === "max_tokens" ? null : parseJson(text);
    const errors = parsed ? validateEvidenceJudgeResponse(parsed, batch) : [meta.stop_reason === "max_tokens" ? "réponse tronquée (max_tokens)" : "JSON invalide"];

    if (errors.length === 0) {
      return { response: parsed, attempts: attempt, usage };
    }

    previous = { errors, text: text.slice(0, 4000) };
  }

  throw new Error(`Juge des preuves : réponse invalide après réparation — ${previous.errors.join(" ; ")}`);
}

// ---------------------------------------------------------------------
// Évaluation (pure) : deux statuts par fait, le code est souverain
// ---------------------------------------------------------------------

function technicalSummary(statuses) {
  if (statuses.length === 0) return "no_source";
  if (statuses.every(status => status === "fetched")) return "all_read";
  if (statuses.some(status => status === "fetched")) return "partially_read";
  if (statuses.every(status => status === "not_fetched")) return "not_fetched";

  return "unreadable";
}

const TECHNICAL_LABELS = {
  fetched: "page lue",
  http_error: "erreur HTTP",
  timeout: "délai dépassé",
  pdf: "PDF non lu",
  javascript_required: "page rendue par JavaScript",
  unsupported_type: "type de contenu non pris en charge",
  too_large: "page trop grande",
  empty: "page sans texte lisible",
  network_error: "inaccessible",
  network_disabled: "lecture réseau désactivée",
  not_fetched: "non lue (production historique)"
};

export const technicalLabel = status => TECHNICAL_LABELS[status] ?? status;

// evidence : artefact evidence.json (null pour une production historique) ;
// texts : textes relus du disque ; judgements : réponses validées du juge
// ({ id → réponse }) ; skipReason : raison d'une absence de juge.
export function evaluateFactEvidence({ research, evidence = null, texts = new Map(), judgements = new Map(), skipReason = null, offline = [], config = FACT_EVIDENCE }) {
  const records = new Map((evidence?.sources ?? []).map(record => [record.url, record]));
  const controlled = new Set(controlledFacts(research).map(({ index }) => index));
  const facts = (Array.isArray(research?.key_facts) ? research.key_facts : []).map((fact, index) => {
    const sources = (fact?.sources ?? []).map(source => {
      const url = source?.url?.trim() ?? null;
      const record = url ? records.get(url) : null;

      return {
        url,
        technical_status: record?.technical_status ?? "not_fetched",
        http_status: record?.http_status ?? null,
        detail: record?.detail ?? null
      };
    });

    const base = {
      index,
      technical_status: technicalSummary(sources.map(source => source.technical_status)),
      sources,
      elements: [],
      quote: null,
      reasons: []
    };

    if (!controlled.has(index)) {
      return { ...base, editorial_status: "not_checked", reasons: ["fait non vérifié par Research : non contrôlé (seuls les faits verified le sont)"] };
    }

    if (!evidence) {
      return { ...base, editorial_status: "not_checked", reasons: [`preuves non lues — ${skipReason ?? "production historique, aucun accès réseau"}`] };
    }

    const readable = sources.filter(source => source.technical_status === "fetched" && texts.has(source.url));
    const unreadable = sources.filter(source => source.technical_status !== "fetched");
    const reasons = [];

    for (const source of unreadable) {
      reasons.push(`Preuve ${source.url} : ${technicalLabel(source.technical_status)}${source.detail ? ` (${source.detail})` : ""}.`);
    }

    if (readable.length === 0) {
      return { ...base, editorial_status: "unverifiable", reasons: [...reasons, "Aucune preuve lisible : le contenu ne peut pas être contrôlé."] };
    }

    // Code souverain : chaque chiffre, date et citation doit figurer dans une preuve lue.
    const elements = factElements(fact.claim).map(element => {
      for (const source of readable) {
        const found = findElement(element, texts.get(source.url), config);
        if (found) return { kind: element.kind, text: element.text, status: "found", source: source.url, excerpt: found.excerpt };
      }

      return { kind: element.kind, text: element.text, status: "not_found", source: null, excerpt: null };
    });

    const missing = elements.filter(element => element.status === "not_found");

    if (missing.length > 0) {
      for (const element of missing) {
        reasons.push(`${element.kind === "quote" ? "Citation" : element.kind === "date" ? "Date" : "Chiffre"} « ${element.text} » absent ${readable.length > 1 ? "des preuves lues" : `de la preuve ${readable[0].url}`}.`);
      }

      // Une preuve illisible pourrait contenir l'élément : ni faux positif ni faux négatif.
      const status = unreadable.length > 0 ? "unverifiable" : "rejected";

      if (status === "unverifiable") reasons.push("Une partie des preuves est illisible : l'élément manquant ne peut pas être exclu.");

      return { ...base, editorial_status: status, elements, reasons };
    }

    const judged = judgements.get(`f${index + 1}`) ?? null;

    // Une preuve a été lue : le fait ne peut plus finir « non contrôlé ».
    // Sans jugement, il est non vérifiable (revue humaine), avec la raison.
    if (!judged) {
      const excerpts = readable.flatMap(source => selectExcerpts(fact.claim, texts.get(source.url), config));
      const reason = excerpts.length === 0
        ? "Aucun extrait exploitable dans la preuve lue : le soutien ne peut pas être établi."
        : skipReason
          ? `Jugement suspendu — ${skipReason}.`
          : "Juge non appelé : le soutien ne peut pas être établi.";

      return { ...base, editorial_status: "unverifiable", awaiting_judge: excerpts.length > 0, elements, reasons: [...reasons, reason] };
    }

    // Le juge doit citer un passage réellement présent dans la preuve.
    const position = Number(String(judged.source ?? "").match(/^f\d+-s(\d+)-e\d+$/)?.[1] ?? 0) - 1;
    const citedSource = readable.includes(sources[position]) ? sources[position] : null;
    const quoteFound = judged.status !== "not_supported" && citedSource && normalizeText(texts.get(citedSource.url)).includes(normalizeText(judged.quote));

    reasons.push(`Juge : ${judged.explanation.trim()}`);

    let status = judged.status === "supported" ? "supported" : judged.status === "partially_supported" ? "partially_supported" : "rejected";

    if (status !== "rejected" && !quoteFound) {
      status = "unverifiable";
      reasons.push("La citation du juge est introuvable dans la preuve enregistrée : le soutien ne peut pas être confirmé.");
    }

    if (unreadable.length > 0 && status === "rejected") {
      status = "unverifiable";
      reasons.push("Une partie des preuves est illisible : le rejet ne peut pas être confirmé.");
    }

    return {
      ...base,
      editorial_status: status,
      elements,
      quote: quoteFound ? { source: citedSource.url, text: judged.quote.trim() } : null,
      reasons
    };
  });

  // Invariant (fail-closed) : un fait vérifié dont au moins une preuve a été
  // lue ne termine jamais « not_checked ».
  for (const fact of facts) {
    if (controlled.has(fact.index) && fact.editorial_status === "not_checked" && fact.sources.some(source => source.technical_status === "fetched")) {
      throw new Error(`Preuves : invariant violé — fait ${fact.index + 1} vérifié, preuve lue, statut not_checked.`);
    }
  }

  const counts = Object.fromEntries(EDITORIAL_STATUSES.map(status => [status, facts.filter(fact => fact.editorial_status === status).length]));

  return {
    checked: Boolean(evidence),
    skip_reason: evidence ? null : skipReason,
    counts,
    facts,
    offline_checks: offline
  };
}

export const EVIDENCE_REVIEW_ACTIONS = [
  "Relire, dans le Truth Report, les faits rejetés ou non vérifiables, leurs preuves enregistrées (dossier evidence/) et les justifications.",
  "Pour une preuve illisible (PDF, JavaScript, accès refusé) : vérifier la page manuellement ; une décision humaine reste nécessaire.",
  "Pour continuer avec un dossier corrigé : régénérer Research (--regenerate=research, appel payant) ou lancer une nouvelle production. La production en pause est conservée et reste reprenable."
];
