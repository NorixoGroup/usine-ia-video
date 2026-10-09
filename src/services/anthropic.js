import Anthropic from "@anthropic-ai/sdk";
import { areFixturesEnabled, getAnthropicFixture } from "../fixtures/anthropic.js";
import {
  beginRealCall,
  endRealCall,
  failRealCall,
  getCallGuardStatus,
  isRequestCached
} from "./call-guard.js";

let client = null;

function getApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;

  if (!key || key.length < 50) {
    throw new Error(
      "ANTHROPIC_API_KEY absente ou invalide. Charge .env.local avant l'appel."
    );
  }

  return key;
}

export function getAnthropicClient() {
  if (!client) {
    client = new Anthropic({
      apiKey: getApiKey()
    });
  }

  return client;
}

// Refus avant tout envoi (NO_API, garde d'appels : autorisation, plafond,
// double appel, journal). Marqué pour l'appelant ; aucun appel n'est parti.
function refusedCall(error) {
  const refused = error instanceof Error ? error : new Error(String(error));

  refused.call_refused = true;

  return refused;
}

// Valeurs par défaut d'une requête : source unique, partagée par createMessage
// et par la sonde de coût (la même requête donne la même empreinte de cache).
const MESSAGE_DEFAULTS = Object.freeze({
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
  temperature: 0.2
});

// Requête envoyée au SDK (et dont l'empreinte indexe le cache des appels).
// Fonction pure ; createMessage l'utilise telle quelle.
export function buildMessageRequest({
  system,
  messages,
  model = MESSAGE_DEFAULTS.model,
  maxTokens = MESSAGE_DEFAULTS.maxTokens,
  temperature = MESSAGE_DEFAULTS.temperature,
  tools
}) {
  const request = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages
  };

  if (system) {
    request.system = system;
  }

  if (tools?.length) {
    request.tools = tools;
  }

  return request;
}

// R29.3 — coût prévisible d'un futur createMessage, en lecture seule et sans
// réseau. { applicable: false, reason } quand aucun budget d'appels ne
// s'applique (fixtures : coût nul ; NO_API : l'appel sera refusé ; garde non
// configuré : l'appel sera refusé). Sinon { applicable: true, cached } :
// cached vaut true quand la réponse est déjà en cache (coût nul). Une entrée de
// cache invalide lève (error.cache_invalid), jamais prise pour une absence.
export function previewMessageCost(params) {
  if (areFixturesEnabled()) {
    return { applicable: false, reason: "FIXTURES" };
  }

  if (process.env.NO_API === "1") {
    return { applicable: false, reason: "NO_API" };
  }

  if (!getCallGuardStatus().configured) {
    return { applicable: false, reason: "GUARD_UNCONFIGURED" };
  }

  return {
    applicable: true,
    cached: isRequestCached(buildMessageRequest(params))
  };
}

export async function createMessage({
  system,
  messages,
  model = MESSAGE_DEFAULTS.model,
  maxTokens = MESSAGE_DEFAULTS.maxTokens,
  temperature = MESSAGE_DEFAULTS.temperature,
  tools
}) {
  const fixture = getAnthropicFixture({
    system,
    messages,
    model,
    maxTokens,
    temperature,
    tools
  });

  if (fixture) {
    return fixture;
  }

  if (process.env.NO_API === "1") {
    throw refusedCall(new Error(
      "NO_API=1 — appel Anthropic interdit par le coupe-circuit local."
    ));
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("createMessage exige au moins un message.");
  }

  const anthropic = getAnthropicClient();

  const request = buildMessageRequest({
    system,
    messages,
    model,
    maxTokens,
    temperature,
    tools
  });

  // Garde des appels réels : autorisation, plafond, journal, cache. Un refus
  // du garde survient avant tout envoi ; il est marqué (call_refused) pour
  // ne pas être confondu avec une panne du transport (R28.10B).
  let reservation;

  try {
    reservation = beginRealCall(request);
  } catch (error) {
    throw refusedCall(error);
  }

  // R23-D : l'empreinte de la requête accompagne la réponse, pour qu'un
  // appelant puisse écarter du cache une réponse qu'il rejette.
  if (reservation.cached) {
    return { ...reservation.cached, request_sha256: reservation.hash };
  }

  const startedAt = Date.now();
  let result;

  try {
    const response = await anthropic.messages.create(request);

    result = {
      response,
      meta: {
        model: response.model,
        input_tokens: response.usage?.input_tokens ?? null,
        output_tokens: response.usage?.output_tokens ?? null,
        stop_reason: response.stop_reason ?? null,
        duration_ms: Date.now() - startedAt
      }
    };
  } catch (error) {
    failRealCall(reservation, error);

    const status = error?.status ? ` HTTP ${error.status}` : "";

    throw new Error(
      `Erreur Anthropic${status}: ${error?.message || "erreur inconnue"}`,
      { cause: error }
    );
  }

  endRealCall(reservation, result);

  return { ...result, request_sha256: reservation.hash };
}

export function extractText(response) {
  if (!response?.content) {
    return "";
  }

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
