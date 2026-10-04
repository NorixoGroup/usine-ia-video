// Ledgers éditoriaux Research (R24.1, phase 1).
//
// sources.json et claims.json sont la représentation interne canonique des
// faits et de leurs sources. research.json demeure une projection strictement
// compatible pour Truth et les agents downstream.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { classifySource } from "../utils/source-policy.js";
import { validateResearchDossier } from "../utils/validate-research.js";

export const RESEARCH_LEDGER_DIRECTORY = "research";
export const SOURCES_LEDGER_FILE = "sources.json";
export const CLAIMS_LEDGER_FILE = "claims.json";
export const SOURCES_LEDGER_SCHEMA = "research-sources.v1";
export const CLAIMS_LEDGER_SCHEMA = "research-claims.v1";

const SOURCE_KEYS = [
  "source_id",
  "canonical_url",
  "retrieval_url",
  "publisher",
  "title",
  "publication_date",
  "tier",
  "type",
  "language",
  "access_status",
  "license_notes",
  "snapshot_sha256"
];

const CLAIM_KEYS = [
  "claim_id",
  "statement",
  "importance",
  "verification_status",
  "truth_status",
  "scope",
  "source_refs"
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clone(value) {
  return structuredClone(value);
}

function numberedId(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(6, "0")}`;
}

function exactKeys(value, keys) {
  return isPlainObject(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function sourceKey(source) {
  return JSON.stringify({
    canonical_url: source.url.trim(),
    retrieval_url: source.url.trim(),
    publisher: source.publisher,
    title: source.title,
    type: source.source_type
  });
}

function sourceRecord(source) {
  const url = source.url.trim();
  const classification = classifySource(url);

  return {
    canonical_url: url,
    retrieval_url: url,
    publisher: source.publisher,
    title: source.title,
    publication_date: null,
    tier: classification.tier ?? "unknown",
    type: source.source_type,
    language: null,
    access_status: "not_fetched",
    license_notes: null,
    snapshot_sha256: null
  };
}

function ledgerContext(research) {
  const { key_facts, ...context } = research;
  return clone(context);
}

function fail(message) {
  throw new Error(`Research Ledgers : ${message}`);
}

function atomicJson(file, data) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export function buildResearchLedgers(research) {
  const validation = validateResearchDossier(research);

  if (!validation.valid) {
    fail(`dossier Research invalide. ${validation.errors.join(" | ")}`);
  }

  const records = new Map();

  for (const fact of research.key_facts) {
    for (const source of fact.sources ?? []) {
      const key = sourceKey(source);
      if (!records.has(key)) records.set(key, sourceRecord(source));
    }
  }

  const sortedRecords = [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record], index) => ({
      source_id: numberedId("src", index),
      ...record
    }));

  const sourceIds = new Map(
    sortedRecords.map(record => [
      JSON.stringify({
        canonical_url: record.canonical_url,
        retrieval_url: record.retrieval_url,
        publisher: record.publisher,
        title: record.title,
        type: record.type
      }),
      record.source_id
    ])
  );

  const claims = research.key_facts.map((fact, index) => ({
    claim_id: numberedId("clm", index),
    statement: fact.claim,
    importance: fact.importance ?? null,
    verification_status: fact.verification_status,
    truth_status: "not_assessed",
    scope: {},
    source_refs: (fact.sources ?? []).map(source => ({
      source_id: sourceIds.get(sourceKey(source)),
      supports_claim: source.supports_claim
    }))
  }));

  const ledgers = {
    sources: {
      schema: SOURCES_LEDGER_SCHEMA,
      sources: sortedRecords
    },
    claims: {
      schema: CLAIMS_LEDGER_SCHEMA,
      research_context: ledgerContext(research),
      claims
    }
  };

  const errors = validateResearchLedgers(ledgers);
  if (errors.length > 0) fail(errors.join(" | "));

  return ledgers;
}

export function validateResearchLedgers({ sources, claims }) {
  const errors = [];

  if (!isPlainObject(sources) || sources.schema !== SOURCES_LEDGER_SCHEMA || !Array.isArray(sources.sources)) {
    errors.push("sources.json absent ou invalide");
  }

  if (!isPlainObject(claims) || claims.schema !== CLAIMS_LEDGER_SCHEMA || !isPlainObject(claims.research_context) || !Array.isArray(claims.claims)) {
    errors.push("claims.json absent ou invalide");
  }

  if (errors.length > 0) return errors;

  const sourceIds = new Set();

  sources.sources.forEach((source, index) => {
    const label = `sources[${index}]`;

    if (!exactKeys(source, SOURCE_KEYS)) {
      errors.push(`${label}: clés invalides`);
      return;
    }

    if (!/^src-\d{6}$/.test(source.source_id) || sourceIds.has(source.source_id)) {
      errors.push(`${label}: source_id invalide ou dupliqué`);
    }
    sourceIds.add(source.source_id);

    for (const key of ["canonical_url", "retrieval_url", "publisher", "title", "type", "access_status"]) {
      if (!isNonEmptyString(source[key])) errors.push(`${label}: ${key} invalide`);
    }

    if (!(Number.isInteger(source.tier) && source.tier >= 1 && source.tier <= 6) && source.tier !== "unknown") {
      errors.push(`${label}: tier invalide`);
    }

    for (const key of ["publication_date", "language", "license_notes", "snapshot_sha256"]) {
      if (source[key] !== null && !isNonEmptyString(source[key])) errors.push(`${label}: ${key} invalide`);
    }
  });

  const claimIds = new Set();

  claims.claims.forEach((claim, index) => {
    const label = `claims[${index}]`;

    if (!exactKeys(claim, CLAIM_KEYS)) {
      errors.push(`${label}: clés invalides`);
      return;
    }

    if (!/^clm-\d{6}$/.test(claim.claim_id) || claimIds.has(claim.claim_id)) {
      errors.push(`${label}: claim_id invalide ou dupliqué`);
    }
    claimIds.add(claim.claim_id);

    if (!isNonEmptyString(claim.statement)) errors.push(`${label}: statement invalide`);
    if (claim.importance !== null && !["high", "medium", "low"].includes(claim.importance)) errors.push(`${label}: importance invalide`);
    if (!["verified", "needs_verification", "uncertain"].includes(claim.verification_status)) errors.push(`${label}: verification_status invalide`);
    if (claim.truth_status !== "not_assessed") errors.push(`${label}: truth_status invalide`);
    if (!isPlainObject(claim.scope)) errors.push(`${label}: scope invalide`);
    if (!Array.isArray(claim.source_refs)) {
      errors.push(`${label}: source_refs invalide`);
    } else {
      claim.source_refs.forEach((reference, referenceIndex) => {
        if (!isPlainObject(reference) || !isNonEmptyString(reference.source_id) || !isNonEmptyString(reference.supports_claim)) {
          errors.push(`${label}.source_refs[${referenceIndex}]: référence invalide`);
        } else if (!sourceIds.has(reference.source_id)) {
          errors.push(`${label}.source_refs[${referenceIndex}]: source inconnue`);
        }
      });
    }
  });

  return errors;
}

export function projectResearchFromLedgers({ sources, claims }) {
  const errors = validateResearchLedgers({ sources, claims });
  if (errors.length > 0) fail(errors.join(" | "));

  const sourceById = new Map(
    sources.sources.map(source => [source.source_id, source])
  );

  const data = {
    ...clone(claims.research_context),
    key_facts: claims.claims.map(claim => ({
      claim: claim.statement,
      ...(claim.importance === null ? {} : { importance: claim.importance }),
      verification_status: claim.verification_status,
      sources: claim.source_refs.map(reference => {
        const source = sourceById.get(reference.source_id);
        return {
          title: source.title,
          url: source.retrieval_url,
          publisher: source.publisher,
          source_type: source.type,
          supports_claim: reference.supports_claim
        };
      })
    }))
  };

  const validation = validateResearchDossier(data);
  if (!validation.valid) fail(`projection research.json invalide. ${validation.errors.join(" | ")}`);

  return data;
}

export function persistResearchLedgers({ productionDir, ledgers }) {
  if (!isNonEmptyString(productionDir) || !fs.existsSync(productionDir) || !fs.statSync(productionDir).isDirectory()) {
    fail("productionDir absent ou invalide");
  }

  const errors = validateResearchLedgers(ledgers);
  if (errors.length > 0) fail(errors.join(" | "));

  const directory = path.join(productionDir, RESEARCH_LEDGER_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true });
  atomicJson(path.join(directory, SOURCES_LEDGER_FILE), ledgers.sources);
  atomicJson(path.join(directory, CLAIMS_LEDGER_FILE), ledgers.claims);

  return {
    directory,
    sources: path.join(directory, SOURCES_LEDGER_FILE),
    claims: path.join(directory, CLAIMS_LEDGER_FILE)
  };
}
