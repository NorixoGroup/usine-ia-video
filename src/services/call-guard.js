// Garde des appels payants réels (R13).
//
// Aucun appel payant ne peut partir implicitement : sans autorisation
// posée EN MÉMOIRE par l'orchestrateur, sans plafond entier fourni
// explicitement et sans accusé d'environnement, tout appel réel est
// refusé. NO_API=1 prime sur tout, y compris sur une autorisation
// valide et sur le cache.
//
// Ce module ne fait jamais d'appel réseau. Il ne lit jamais .env.local
// et n'écrit jamais aucun secret : ni dans le journal, ni dans le cache,
// ni dans les erreurs.
//
// Fichiers écrits dans le dossier de la production :
//   calls.json            journal des appels (écrit AVANT l'envoi)
//   call-cache/<sha>.json réponse d'une requête réussie, par empreinte

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Plafond dur de sécurité, inscrit dans le code. Ce n'est PAS un plafond
// par défaut : chaque invocation réelle doit fournir son propre plafond.
export const HARD_CEILING = 500;

export const REAL_CALLS_ACK_ENV = "PIPELINE_REAL_CALLS_ACK";

export const JOURNAL_FILE = "calls.json";
export const CACHE_DIR = "call-cache";

export const CALL_ID_PATTERN = /^c\d{4,}-[0-9a-f]{12}$/;

const JOURNAL_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "cache_hit",
  "unresolved_accepted"
];

const CACHE_META_KEYS = [
  "duration_ms",
  "input_tokens",
  "model",
  "output_tokens",
  "stop_reason"
];

const SECRET_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "PEXELS_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY"
];

// Autorisation courante, en mémoire uniquement. Null = aucun appel réel.
let state = null;

export function redactSecrets(text) {
  let result = String(text ?? "");

  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];

    if (typeof value === "string" && value.length >= 8) {
      result = result.split(value).join("[REDACTED]");
    }
  }

  return result.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
}

export function parseRealCallsCap(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    throw new Error(
      "Appels réels : --real-calls-cap=<N> est obligatoire, sans valeur par défaut."
    );
  }

  const text = String(raw).trim();

  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(
      `Appels réels : --real-calls-cap invalide "${text}" — entier de 1 à ${HARD_CEILING} attendu.`
    );
  }

  const cap = Number(text);

  if (!Number.isSafeInteger(cap) || cap > HARD_CEILING) {
    throw new Error(
      `Appels réels : --real-calls-cap ${text} dépasse le plafond dur de ${HARD_CEILING}.`
    );
  }

  return cap;
}

function assertNoApiNotSet() {
  if (process.env.NO_API === "1") {
    throw new Error(
      "NO_API=1 — appels réels interdits par le coupe-circuit local."
    );
  }
}

function assertAckSet() {
  if (process.env[REAL_CALLS_ACK_ENV] !== "1") {
    throw new Error(
      `Appels réels : ${REAL_CALLS_ACK_ENV}=1 est obligatoire (accusé explicite).`
    );
  }
}

// Vérifie les trois conditions d'une invocation réelle, dans cet ordre :
// NO_API absent, accusé d'environnement, plafond explicite valide.
export function assertRealCallAuthorization({ cap }) {
  assertNoApiNotSet();
  assertAckSet();

  return parseRealCallsCap(cap);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item ?? null)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function requestSha256(request) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(request))
    .digest("hex");
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;

  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, file);
}

function journalPath() {
  return path.join(state.productionDir, JOURNAL_FILE);
}

function writeJournal() {
  atomicWrite(
    journalPath(),
    JSON.stringify(state.journal, null, 2) + "\n"
  );
}

function validateJournal(journal) {
  if (
    !journal ||
    typeof journal !== "object" ||
    journal.schema !== 1 ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error(
      "Journal des appels : format invalide (schema 1 attendu)."
    );
  }

  const seen = new Set();

  for (const entry of journal.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !CALL_ID_PATTERN.test(entry.call_id ?? "") ||
      !JOURNAL_STATUSES.includes(entry.status) ||
      !/^[0-9a-f]{64}$/.test(entry.request_sha256 ?? "") ||
      !Number.isInteger(entry.seq) ||
      entry.seq < 1 ||
      seen.has(entry.call_id)
    ) {
      throw new Error(
        "Journal des appels : entrée invalide ou dupliquée."
      );
    }

    seen.add(entry.call_id);
  }
}

function loadJournal(productionDir) {
  const file = path.join(productionDir, JOURNAL_FILE);

  if (!fs.existsSync(file)) {
    return { schema: 1, entries: [] };
  }

  let journal;

  try {
    journal = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Journal des appels illisible (${JOURNAL_FILE}) : ${redactSecrets(error.message)}`
    );
  }

  validateJournal(journal);

  return journal;
}

// Pose l'autorisation en mémoire pour cette invocation. Refuse si un
// appel `started` sans issue reste dans le journal, sauf déblocage
// nominatif de cet appel précis.
export function configureCallGuard({
  productionDir,
  cap,
  acceptUnresolved = []
}) {
  const authorizedCap = assertRealCallAuthorization({ cap });

  if (
    typeof productionDir !== "string" ||
    productionDir === "" ||
    !fs.existsSync(productionDir) ||
    !fs.statSync(productionDir).isDirectory()
  ) {
    throw new Error(
      "Appels réels : dossier de production introuvable pour le journal."
    );
  }

  if (!Array.isArray(acceptUnresolved)) {
    throw new Error(
      "Appels réels : acceptUnresolved doit être une liste de call_id."
    );
  }

  const journal = loadJournal(productionDir);
  const unresolved = journal.entries.filter(
    entry => entry.status === "started"
  );

  const accepted = new Set();

  for (const callId of acceptUnresolved) {
    if (!CALL_ID_PATTERN.test(callId ?? "")) {
      throw new Error(
        `Appels réels : --accept-unresolved-calls "${callId}" n'est pas un call_id valide (aucun wildcard).`
      );
    }

    if (accepted.has(callId)) {
      throw new Error(
        `Appels réels : call_id ${callId} fourni plusieurs fois.`
      );
    }

    if (!unresolved.some(entry => entry.call_id === callId)) {
      throw new Error(
        `Appels réels : ${callId} n'est pas un appel sans issue de ce journal.`
      );
    }

    accepted.add(callId);
  }

  const blocking = unresolved.filter(
    entry => !accepted.has(entry.call_id)
  );

  if (blocking.length > 0) {
    throw new Error(
      "Appels réels : appel(s) sans issue connue dans le journal — " +
      `${blocking.map(entry => entry.call_id).join(", ")}. ` +
      "Reprise refusée (fail-closed). Déblocage nominatif : " +
      "--accept-unresolved-calls=<call_id>."
    );
  }

  state = {
    productionDir,
    cap: authorizedCap,
    used: 0,
    cacheHits: 0,
    journal
  };

  for (const entry of journal.entries) {
    if (accepted.has(entry.call_id)) {
      entry.status = "unresolved_accepted";
      entry.resolution = {
        accepted_at: new Date().toISOString(),
        via: "--accept-unresolved-calls",
        outcome: "unknown"
      };
    }
  }

  if (accepted.size > 0) {
    writeJournal();
  }

  return {
    cap: authorizedCap,
    accepted: [...accepted]
  };
}

export function resetCallGuard() {
  state = null;
}

export function getCallGuardStatus() {
  return state
    ? {
        configured: true,
        cap: state.cap,
        used: state.used,
        cache_hits: state.cacheHits
      }
    : { configured: false, cap: null, used: 0, cache_hits: 0 };
}

function cacheFile(hash) {
  return path.join(state.productionDir, CACHE_DIR, `${hash}.json`);
}

function integrityOf(hash, result) {
  return crypto
    .createHash("sha256")
    .update(stableStringify({ request_sha256: hash, result }))
    .digest("hex");
}

function readCache(hash) {
  const file = cacheFile(hash);

  if (!fs.existsSync(file)) {
    return null;
  }

  const fail = detail => {
    throw new Error(
      `Cache des appels invalide (${hash.slice(0, 12)}) : ${detail}. ` +
      "Aucun nouvel appel de remplacement (fail-closed)."
    );
  };

  let record;

  try {
    record = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`illisible — ${redactSecrets(error.message)}`);
  }

  if (
    !record ||
    typeof record !== "object" ||
    record.schema !== 1 ||
    record.request_sha256 !== hash ||
    !record.result ||
    typeof record.result.response !== "object" ||
    record.result.response === null ||
    !record.result.meta ||
    typeof record.result.meta !== "object" ||
    JSON.stringify(Object.keys(record.result.meta).sort()) !==
      JSON.stringify(CACHE_META_KEYS) ||
    record.integrity !== integrityOf(hash, record.result)
  ) {
    return fail("structure ou intégrité incohérente");
  }

  return record.result;
}

// Appelée juste avant l'envoi au SDK. Retourne soit { cached }, soit
// une réservation à clore par endRealCall / failRealCall.
export function beginRealCall(request) {
  if (!state) {
    throw new Error(
      "Appel Anthropic réel non autorisé : aucune autorisation configurée " +
      "(exige --mode=full, --real-calls-cap=<N> et " +
      `${REAL_CALLS_ACK_ENV}=1).`
    );
  }

  // NO_API prime sur tout, y compris après configuration.
  assertNoApiNotSet();
  assertAckSet();

  const hash = requestSha256(request);
  const cached = readCache(hash);

  if (cached) {
    const seq = state.journal.entries.length + 1;

    state.journal.entries.push({
      call_id: `c${String(seq).padStart(4, "0")}-${hash.slice(0, 12)}`,
      seq,
      status: "cache_hit",
      request_sha256: hash,
      at: new Date().toISOString()
    });

    writeJournal();
    state.cacheHits += 1;

    return {
      cached: {
        response: cached.response,
        meta: { ...cached.meta, duration_ms: 0 }
      }
    };
  }

  if (
    state.journal.entries.some(
      entry =>
        entry.status === "started" && entry.request_sha256 === hash
    )
  ) {
    throw new Error(
      "Double appel refusé : une requête identique est déjà en cours."
    );
  }

  if (state.used >= state.cap) {
    throw new Error(
      `Plafond d'appels réels atteint (${state.cap}) : appel refusé.`
    );
  }

  const seq = state.journal.entries.length + 1;

  const entry = {
    call_id: `c${String(seq).padStart(4, "0")}-${hash.slice(0, 12)}`,
    seq,
    status: "started",
    request_sha256: hash,
    model: request.model ?? null,
    max_tokens: request.max_tokens ?? null,
    message_count: Array.isArray(request.messages)
      ? request.messages.length
      : 0,
    has_tools: Array.isArray(request.tools) && request.tools.length > 0,
    started_at: new Date().toISOString(),
    ended_at: null
  };

  state.used += 1;
  state.journal.entries.push(entry);

  try {
    writeJournal();
  } catch (error) {
    state.used -= 1;
    state.journal.entries.pop();
    throw error;
  }

  return { callId: entry.call_id, hash, entry };
}

export function endRealCall(reservation, result) {
  if (
    !result ||
    typeof result.response !== "object" ||
    result.response === null ||
    !result.meta
  ) {
    throw new Error(
      `Appel ${reservation.callId} : résultat inexploitable, journal laissé à "started".`
    );
  }

  const record = {
    schema: 1,
    request_sha256: reservation.hash,
    call_id: reservation.callId,
    created_at: new Date().toISOString(),
    result: {
      response: result.response,
      meta: {
        duration_ms: result.meta.duration_ms ?? null,
        input_tokens: result.meta.input_tokens ?? null,
        model: result.meta.model ?? null,
        output_tokens: result.meta.output_tokens ?? null,
        stop_reason: result.meta.stop_reason ?? null
      }
    }
  };

  record.integrity = integrityOf(reservation.hash, record.result);

  fs.mkdirSync(path.join(state.productionDir, CACHE_DIR), {
    recursive: true
  });

  atomicWrite(
    cacheFile(reservation.hash),
    JSON.stringify(record, null, 2) + "\n"
  );

  reservation.entry.status = "succeeded";
  reservation.entry.ended_at = new Date().toISOString();
  reservation.entry.input_tokens = record.result.meta.input_tokens;
  reservation.entry.output_tokens = record.result.meta.output_tokens;
  reservation.entry.stop_reason = record.result.meta.stop_reason;

  writeJournal();
}

export function failRealCall(reservation, error) {
  reservation.entry.status = "failed";
  reservation.entry.ended_at = new Date().toISOString();
  reservation.entry.error = redactSecrets(
    error instanceof Error ? error.message : String(error)
  ).slice(0, 500);

  try {
    writeJournal();
  } catch {
    // Le journal reste à "started" : l'appel sera traité comme sans issue.
  }
}
