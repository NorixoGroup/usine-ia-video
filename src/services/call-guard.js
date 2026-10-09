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

// Identité non secrète d'une narration. Le fournisseur réel et les outils de
// reprise partagent exactement la même empreinte déterministe.
export function narrationRequestIdentity({
  providerKind,
  unitId,
  text,
  modelId,
  voiceId,
  outputFormat,
  parameters = {}
}) {
  return {
    kind: "narration",
    provider_kind: providerKind,
    unit_id: unitId,
    text,
    model_id: modelId,
    voice_id: voiceId,
    output_format: outputFormat,
    parameters
  };
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

// Réconciliation pré-configuration, utilisée uniquement avant que le garde
// global refuse un journal started. Les candidats doivent venir de l'inspection
// FFprobe/SHA locale; aucune entrée non-narration n'est jamais considérée.
export function reconcileNarrationJournal({ productionDir, candidates = [] }) {
  if (!Array.isArray(candidates)) {
    throw new Error("Réconciliation narration : candidats invalides.");
  }
  const journal = loadJournal(productionDir);
  let changed = 0;

  for (const candidate of candidates) {
    const { request, artifact } = candidate ?? {};
    if (!request || !artifact || request.provider_kind !== "elevenlabs") continue;
    const hash = requestSha256({
      kind: "narration", provider_kind: request.provider_kind,
      unit_id: request.unit_id, request
    });
    const entry = journal.entries.find(item =>
      item.status === "started" && item.provider_kind === "elevenlabs" &&
      item.unit_id === request.unit_id && item.request_sha256 === hash
    );
    if (!entry) continue;
    if (
      artifact.provider_kind !== "elevenlabs" || artifact.unit_id !== entry.unit_id ||
      artifact.path !== `voice/${entry.unit_id}.mp3` ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
      !Number.isInteger(artifact.size_bytes) || artifact.size_bytes <= 0 ||
      !Number.isFinite(artifact.duration_seconds) || artifact.duration_seconds <= 0
    ) {
      continue;
    }
    Object.assign(entry, {
      status: "succeeded", ended_at: new Date().toISOString(),
      path: artifact.path, sha256: artifact.sha256,
      size_bytes: artifact.size_bytes, duration_seconds: artifact.duration_seconds,
      text_characters: request.text.length, reconciled: true
    });
    changed += 1;
  }
  if (changed > 0) {
    const file = path.join(productionDir, JOURNAL_FILE);
    atomicWrite(file, JSON.stringify(journal, null, 2) + "\n");
  }
  return { reconciled: changed, journal };
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

// Régénération volontaire (--regenerate) : le temps d'un seul agent, le
// cache n'est pas lu. Chaque appel part réellement, compte dans le plafond,
// est marqué cache_bypass dans le journal ; l'ancienne entrée de cache est
// archivée dans call-cache/superseded/<horodatage>/, jamais écrasée.
export function setCacheBypass(enabled) {
  if (!state) {
    throw new Error(
      "Régénération : aucune autorisation d'appels réels configurée."
    );
  }

  state.cacheBypass = enabled === true;
  state.supersededStamp = state.cacheBypass
    ? new Date().toISOString().replace(/[:.]/g, "-")
    : null;
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

// Vérification non mutante d'un budget connu avant de commencer une
// séquence d'appels. Elle ne réserve ni ne consomme d'appel : les appels
// restent journalisés individuellement par beginRealCall(). Le pipeline
// est séquentiel, ce qui permet aux validateurs batchés de refuser avant
// leur premier appel si leur pire cas ne tient pas dans le plafond restant.
export function assertRealCallBudget({ calls, label = "opération" }) {
  if (!state) {
    throw new Error(
      "Budget d'appels réels non autorisé : aucune autorisation configurée."
    );
  }

  if (!Number.isSafeInteger(calls) || calls < 0) {
    throw new Error(
      `Budget d'appels réels invalide pour ${label} : entier positif attendu.`
    );
  }

  if (state.used + calls > state.cap) {
    throw new Error(
      `Budget d'appels réels insuffisant pour ${label} : ` +
      `${calls} appel(s) maximum requis, ${state.cap - state.used} restant(s) ` +
      `(plafond ${state.cap}, déjà utilisés ${state.used}).`
    );
  }

  return {
    label,
    required: calls,
    remaining: state.cap - state.used,
    authorized: true
  };
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

// R29.3 — sonde en LECTURE SEULE : la requête (la même que celle que recevrait
// beginRealCall) a-t-elle une réponse valide en cache ? Aucune écriture, aucun
// journal, aucun compteur (ni used ni cacheHits). Même règle que
// beginRealCall : en régénération (cacheBypass) le cache n'est pas lu, la
// réponse est donc « absente ». Une entrée illisible ou incohérente lève
// exactement l'erreur fail-closed de readCache, marquée cache_invalid : elle
// n'est jamais prise pour une absence.
export function isRequestCached(request) {
  if (!state) {
    throw new Error(
      "Sonde du cache : aucune autorisation d'appels réels configurée."
    );
  }

  if (state.cacheBypass) {
    return false;
  }

  try {
    return readCache(requestSha256(request)) !== null;
  } catch (error) {
    error.cache_invalid = true;

    throw error;
  }
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
  const cached = state.cacheBypass ? null : readCache(hash);

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
      },
      hash
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
    ended_at: null,
    ...(state.cacheBypass ? { cache_bypass: true } : {})
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

  if (reservation.entry.cache_bypass && fs.existsSync(cacheFile(reservation.hash))) {
    const archive = path.join(
      state.productionDir, CACHE_DIR, "superseded", state.supersededStamp
    );

    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(
      cacheFile(reservation.hash),
      path.join(archive, `${reservation.hash}.json`)
    );
  }

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

// R23-D : une réponse reçue mais rejetée par un contrôle (JSON, structure,
// validations, grounding) ne doit pas être rejouée par le cache lors d'une
// reprise. Elle est déplacée dans call-cache/rejected/<horodatage>/ pour
// diagnostic ; le journal n'est pas modifié. Sans garde configurée, sans
// empreinte ou sans entrée de cache : aucun effet.
export function discardCachedResponse(hash) {
  if (!state || !/^[0-9a-f]{64}$/.test(hash ?? "")) return null;

  const file = cacheFile(hash);

  if (!fs.existsSync(file)) return null;

  const directory = path.join(
    state.productionDir, CACHE_DIR, "rejected",
    new Date().toISOString().replace(/[:.]/g, "-")
  );

  fs.mkdirSync(directory, { recursive: true });
  fs.renameSync(file, path.join(directory, `${hash}.json`));

  return path.relative(state.productionDir, path.join(directory, `${hash}.json`));
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

// Réservation minimale pour un futur provider de narration. Contrairement au
// cache JSON Anthropic, aucun binaire n'est mis en cache : l'artefact local
// inspecté est la source d'idempotence. Le journal ne contient que ses
// métadonnées vérifiables.
export function beginNarrationCall({ providerKind, unitId, request }) {
  if (!state) {
    throw new Error(
      "Appel narration réel non autorisé : aucune autorisation configurée."
    );
  }

  assertNoApiNotSet();
  assertAckSet();

  if (
    typeof providerKind !== "string" || providerKind.length === 0 ||
    typeof unitId !== "string" || unitId.length === 0 ||
    !request || typeof request !== "object"
  ) {
    throw new Error("Appel narration réel : requête invalide.");
  }

  const hash = requestSha256({
    kind: "narration",
    provider_kind: providerKind,
    unit_id: unitId,
    request
  });

  if (
    state.journal.entries.some(
      entry => entry.status === "started" && entry.request_sha256 === hash
    )
  ) {
    throw new Error(
      "Double appel narration refusé : une requête identique est déjà en cours."
    );
  }

  if (state.used >= state.cap) {
    throw new Error(
      `Plafond d'appels réels atteint (${state.cap}) : appel narration refusé.`
    );
  }

  const seq = state.journal.entries.length + 1;
  const entry = {
    call_id: `c${String(seq).padStart(4, "0")}-${hash.slice(0, 12)}`,
    seq,
    status: "started",
    request_sha256: hash,
    provider_kind: providerKind,
    unit_id: unitId,
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

export function endNarrationCall(reservation, artifact) {
  if (
    !reservation?.entry ||
    !artifact ||
    typeof artifact.provider_kind !== "string" ||
    typeof artifact.unit_id !== "string" ||
    typeof artifact.path !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "") ||
    !Number.isInteger(artifact.size_bytes) || artifact.size_bytes <= 0 ||
    !Number.isFinite(artifact.duration_seconds) || artifact.duration_seconds <= 0 ||
    artifact.provider_kind !== reservation.entry.provider_kind ||
    artifact.unit_id !== reservation.entry.unit_id ||
    artifact.path !== `voice/${reservation.entry.unit_id}.wav` &&
      artifact.path !== `voice/${reservation.entry.unit_id}.mp3` &&
      artifact.path !== `voice/${reservation.entry.unit_id}.m4a`
  ) {
    throw new Error(
      `Appel narration ${reservation?.callId ?? "inconnu"} : artefact invalide.`
    );
  }

  Object.assign(reservation.entry, {
    status: "succeeded",
    ended_at: new Date().toISOString(),
    provider_kind: artifact.provider_kind,
    unit_id: artifact.unit_id,
    path: artifact.path,
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes,
    duration_seconds: artifact.duration_seconds
  });
  writeJournal();
}

export function failNarrationCall(reservation, error) {
  failRealCall(reservation, error);
}

// Adaptateur minimal vers la frontière injectable de narration. Les fakes
// locaux restent libres d'injecter leur propre garde; ce chemin est réservé
// aux appels réels autorisés.
export function createRealNarrationCallGuard() {
  return {
    preflight({ calls, label }) {
      return assertRealCallBudget({ calls, label });
    },
    begin({ providerKind, unitId, request }) {
      return beginNarrationCall({ providerKind, unitId, request });
    },
    succeed(reservation, artifact) {
      return endNarrationCall(reservation, artifact);
    },
    fail(reservation, error) {
      return failNarrationCall(reservation, error);
    }
  };
}

// Transition étroite pour la seule fenêtre F : un artifact canonique a déjà
// été validé/persisté mais le processus est tombé avant endNarrationCall.
// L'appelant doit fournir l'artifact issu de l'inspection locale existante.
export function reconcileNarrationCall({ request, artifact }) {
  if (!state || !request || !artifact) {
    throw new Error("Réconciliation narration : état ou données absents.");
  }

  const hash = requestSha256({
    kind: "narration",
    provider_kind: request.provider_kind,
    unit_id: request.unit_id,
    request
  });
  const entry = state.journal.entries.find(
    candidate =>
      candidate.status === "started" &&
      candidate.provider_kind === request.provider_kind &&
      candidate.unit_id === request.unit_id &&
      candidate.request_sha256 === hash
  );

  if (!entry) {
    throw new Error(
      "Réconciliation narration refusée : aucun appel started correspondant."
    );
  }

  endNarrationCall({ callId: entry.call_id, hash, entry }, artifact);
  return { reconciled: true, callId: entry.call_id };
}
