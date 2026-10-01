// Adaptateur ElevenLabs minimal. Aucun SDK, aucune dépendance et aucun appel
// réseau implicite : le transport et le secret sont injectables.

import { redactSecrets } from "./call-guard.js";

export const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech/";
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

function fail(message) {
  throw new Error(`ElevenLabs narration : ${message}`);
}

function safeError(response, detail) {
  const status = response?.status;
  const classes = {
    401: "authentication", 402: "quota/billing", 403: "authorization",
    422: "invalid request", 429: "rate limit"
  };
  const category = classes[status] ?? (status >= 500 ? "provider/server" : "HTTP");
  fail(`${category}${status ? ` (${status})` : ""}${detail ? ` — ${detail}` : ""}`);
}

export function elevenLabsRequestIdentity({ unitId, text, providerConfig }) {
  return {
    provider_kind: "elevenlabs",
    unit_id: unitId,
    text,
    model_id: providerConfig.modelId,
    voice_id: providerConfig.voiceId,
    output_format: providerConfig.outputFormat,
    parameters: {}
  };
}

export function createElevenLabsNarrationProvider({
  fetchImpl = globalThis.fetch,
  getApiKey = () => process.env.ELEVENLABS_API_KEY
} = {}) {
  if (typeof fetchImpl !== "function" || typeof getApiKey !== "function") {
    fail("transport ou résolveur de secret invalide.");
  }

  return {
    kind: "elevenlabs",
    requestIdentity({ unit, providerConfig }) {
      return elevenLabsRequestIdentity({
        unitId: unit.unitId,
        text: unit.text,
        providerConfig: {
          modelId: providerConfig.modelId ?? ELEVENLABS_MODEL,
          voiceId: providerConfig.voiceId,
          outputFormat: providerConfig.outputFormat ?? ELEVENLABS_OUTPUT_FORMAT
        }
      });
    },
    async generate({ unitId, text, providerConfig }) {
      const config = providerConfig ?? {};
      const modelId = config.modelId ?? ELEVENLABS_MODEL;
      const outputFormat = config.outputFormat ?? ELEVENLABS_OUTPUT_FORMAT;
      const voiceId = config.voiceId;
      const timeoutMs = config.timeoutMs;

      if (
        typeof voiceId !== "string" || voiceId.trim() === "" ||
        typeof modelId !== "string" || modelId.trim() === "" ||
        outputFormat !== ELEVENLABS_OUTPUT_FORMAT ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      ) {
        fail("configuration non secrète invalide.");
      }

      const key = getApiKey();
      if (typeof key !== "string" || key.length === 0) {
        fail("secret API absent.");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const url = new URL(`${ELEVENLABS_ENDPOINT}${encodeURIComponent(voiceId)}`);
      url.searchParams.set("output_format", outputFormat);

      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "xi-api-key": key,
            "content-type": "application/json",
            accept: "audio/mpeg"
          },
          body: JSON.stringify({ text, model_id: modelId })
        });
      } catch (error) {
        if (error?.name === "AbortError") fail("provider timeout");
        fail(`provider transport failure — ${redactSecrets(error?.message ?? "unknown")}`);
      } finally {
        clearTimeout(timer);
      }

      if (!response?.ok) safeError(response);
      const contentType = response.headers?.get?.("content-type") ?? "";
      if (!/^audio\/(mpeg|mp3)(;|$)/i.test(contentType)) {
        fail("wrong content-type");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) fail("empty audio response");

      return { bytes, extension: ".mp3" };
    }
  };
}
