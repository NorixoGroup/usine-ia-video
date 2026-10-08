// R28.7 — exécuteur du juge de couverture (baseline v1.0.2, contrat 4.8 pour
// la partie transport). R28.10 : retrait des réponses rejetées du cache.
//
// Il reçoit la requête préparée par le juge et un transport injecté,
// applique les bornes, exécute EXACTEMENT un appel et renvoie la réponse
// brute, intacte. Il ne décide rien, ne recalcule rien (ni protocol_id, ni
// lock_sha256, ni voiceover_sha256), ne lit pas le JSON métier, ne répare
// rien, ne classe rien et n'écrit jamais dans le cache. Seul propriétaire du
// cache pour la couverture (4.8), il en RETIRE les réponses signalées comme
// rejetées (discardRejectedJudgeResponses), avec la fonction de retrait
// injectée par le pipeline (garde d'appels existant). Il n'importe aucun
// composant de couverture ni le pipeline.
//
// Sortie : OK (réponse brute transmise telle quelle) ou NOT_JUDGED avec une
// erreur qualifiée. Échec fermé : aucune exception ne s'échappe, jamais de
// faux PASS.
//
//   transport absent           → TRANSPORT_MISSING
//   requête hors format        → INVALID_REQUEST     (aucun appel)
//   requête hors bornes        → REQUEST_OUT_OF_BOUNDS (aucun appel)
//   exception du transport     → TRANSPORT_ERROR
//   délai dépassé              → TIMEOUT
//   réponse vide               → EMPTY_RESPONSE
//   réponse sans texte         → NON_TEXT_RESPONSE
//   réponse hors bornes        → RESPONSE_OUT_OF_BOUNDS
//
// La requête transmise au transport est une copie figée : l'original de
// l'appelant ne peut pas être modifié, et le transport ne peut pas modifier
// ce qu'il reçoit.

export const COVERAGE_JUDGE_EXECUTOR_VERSION = "coverage-judge-executor.v1";

export const EXECUTOR_STATUS = Object.freeze({
  OK: "OK",
  NOT_JUDGED: "NOT_JUDGED"
});

export const EXECUTOR_FAILURE = Object.freeze({
  TRANSPORT_MISSING: "TRANSPORT_MISSING",
  INVALID_REQUEST: "INVALID_REQUEST",
  REQUEST_OUT_OF_BOUNDS: "REQUEST_OUT_OF_BOUNDS",
  TRANSPORT_ERROR: "TRANSPORT_ERROR",
  TIMEOUT: "TIMEOUT",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  NON_TEXT_RESPONSE: "NON_TEXT_RESPONSE",
  RESPONSE_OUT_OF_BOUNDS: "RESPONSE_OUT_OF_BOUNDS"
});

// Bornes de l'exécuteur, indépendantes et plus larges que celles du juge.
export const EXECUTOR_LIMITS = Object.freeze({
  max_request_chars: 16000,
  max_tokens: 4000,
  max_response_chars: 16000,
  timeout_ms: 120000
});

const ROLES = new Set(["user", "assistant"]);

function deepFreezeCopy(value) {
  if (value === null || typeof value !== "object") return value;
  const copy = Array.isArray(value) ? value.map(deepFreezeCopy) : Object.fromEntries(
    Object.keys(value).map(key => [key, deepFreezeCopy(value[key])])
  );
  return Object.freeze(copy);
}

function requestIssue(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return "requête absente";
  if (typeof request.system !== "string" || request.system.length === 0) return "system absent";
  if (!Array.isArray(request.messages) || request.messages.length === 0) return "messages absents";
  for (const [index, message] of request.messages.entries()) {
    if (!message || !ROLES.has(message.role) || typeof message.content !== "string" || message.content.length === 0) {
      return `message ${index + 1} invalide`;
    }
  }
  if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1) return "maxTokens invalide";
  if (typeof request.temperature !== "number" || !Number.isFinite(request.temperature)) return "temperature invalide";
  return null;
}

function requestBoundsIssue(request, limits) {
  const chars = request.system.length + request.messages.reduce((total, message) => total + message.content.length, 0);
  if (chars > limits.max_request_chars) return `requête : ${chars} caractères > ${limits.max_request_chars}`;
  if (request.maxTokens > limits.max_tokens) return `maxTokens : ${request.maxTokens} > ${limits.max_tokens}`;
  return null;
}

function responseIssue(reply, request, limits) {
  if (reply === null || reply === undefined || typeof reply !== "object") {
    return [EXECUTOR_FAILURE.EMPTY_RESPONSE, "réponse absente"];
  }
  const content = reply.response?.content;
  if (!Array.isArray(content) || content.length === 0) return [EXECUTOR_FAILURE.EMPTY_RESPONSE, "contenu absent"];
  const texts = content.filter(block => block?.type === "text" && typeof block.text === "string");
  if (texts.length === 0) return [EXECUTOR_FAILURE.NON_TEXT_RESPONSE, "aucun bloc texte"];
  const chars = texts.reduce((total, block) => total + block.text.length, 0);
  if (texts.every(block => block.text.length === 0)) return [EXECUTOR_FAILURE.EMPTY_RESPONSE, "texte vide"];
  if (chars > limits.max_response_chars) {
    return [EXECUTOR_FAILURE.RESPONSE_OUT_OF_BOUNDS, `réponse : ${chars} caractères > ${limits.max_response_chars}`];
  }
  const outputTokens = reply.meta?.output_tokens;
  if (Number.isFinite(outputTokens) && outputTokens > request.maxTokens) {
    return [EXECUTOR_FAILURE.RESPONSE_OUT_OF_BOUNDS, `réponse : ${outputTokens} tokens > maxTokens ${request.maxTokens}`];
  }
  return null;
}

function outcome({ status, category = null, reason = null, reply = null, calls }) {
  return Object.freeze({
    version: COVERAGE_JUDGE_EXECUTOR_VERSION,
    status,
    failure: category ? Object.freeze({ category, reason }) : null,
    calls,
    request_sha256: typeof reply?.request_sha256 === "string" ? reply.request_sha256 : null,
    reply: status === EXECUTOR_STATUS.OK ? reply : null
  });
}

const notJudged = (category, reason, calls, reply = null) =>
  outcome({ status: EXECUTOR_STATUS.NOT_JUDGED, category, reason, calls, reply });

// Exécute une requête du juge avec le transport injecté. Ne lève jamais.
export async function executeJudgeRequest({ request, transport, limits = EXECUTOR_LIMITS } = {}) {
  try {
    if (typeof transport !== "function") return notJudged(EXECUTOR_FAILURE.TRANSPORT_MISSING, "transport absent", 0);
    const issue = requestIssue(request);
    if (issue) return notJudged(EXECUTOR_FAILURE.INVALID_REQUEST, issue, 0);
    const bounds = requestBoundsIssue(request, limits);
    if (bounds) return notJudged(EXECUTOR_FAILURE.REQUEST_OUT_OF_BOUNDS, bounds, 0);

    const frozenRequest = deepFreezeCopy(request);
    let timer = null;
    let reply;
    try {
      reply = await Promise.race([
        Promise.resolve().then(() => transport(frozenRequest)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("délai dépassé"), { timeout: true })), limits.timeout_ms);
        })
      ]);
    } catch (error) {
      if (error?.timeout === true) return notJudged(EXECUTOR_FAILURE.TIMEOUT, `délai dépassé (${limits.timeout_ms} ms)`, 1);
      return notJudged(EXECUTOR_FAILURE.TRANSPORT_ERROR, String(error?.message ?? error), 1);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const problem = responseIssue(reply, request, limits);
    if (problem) return notJudged(problem[0], problem[1], 1, reply);
    return outcome({ status: EXECUTOR_STATUS.OK, reply, calls: 1 });
  } catch (error) {
    return notJudged(EXECUTOR_FAILURE.TRANSPORT_ERROR, `erreur inattendue — ${String(error?.message ?? error)}`, 1);
  }
}

// R28.10 (contrat 4.8) — retire du cache les réponses signalées comme rejetées,
// identifiées par leur empreinte de requête, avec la fonction de retrait
// injectée (discardCachedResponse du garde d'appels). Ne lève jamais : une
// empreinte invalide ou une fonction absente est ignorée et signalée.
export function discardRejectedJudgeResponses({ requestSha256s, discard } = {}) {
  const valid = Array.isArray(requestSha256s)
    ? [...new Set(requestSha256s.filter(hash => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)))].sort()
    : [];
  if (typeof discard !== "function") {
    return Object.freeze({ discarded: Object.freeze([]), skipped: Object.freeze(valid) });
  }
  const discarded = [];
  const skipped = [];
  for (const hash of valid) {
    try {
      discard(hash);
      discarded.push(hash);
    } catch {
      skipped.push(hash);
    }
  }
  return Object.freeze({ discarded: Object.freeze(discarded), skipped: Object.freeze(skipped) });
}
