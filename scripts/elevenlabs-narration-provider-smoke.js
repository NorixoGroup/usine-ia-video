// Smoke offline de l'adaptateur ElevenLabs : transport injecté, zéro réseau.
import { networkGuard } from "./fixture-network-guard.js";
import { requestSha256 } from "../src/services/call-guard.js";
import {
  createElevenLabsNarrationProvider,
  elevenLabsRequestIdentity
} from "../src/services/elevenlabs-narration-provider.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  throw new Error("NO_API=1 et Network Guard requis.");
}

let pass = 0;
let fail = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); pass += 1; console.log(`PASS — ${name}`); }
  catch (error) { fail += 1; console.error(`FAIL — ${name}: ${error.message}`); }
}
async function reject(fn, expression) {
  let error; try { await fn(); } catch (caught) { error = caught; }
  assert(error && expression.test(error.message), `rejet attendu ${expression}, obtenu ${error?.message}`);
}
const config = { voiceId: "voice / id", modelId: "eleven_multilingual_v2", outputFormat: "mp3_44100_128", timeoutMs: 20 };
function provider(fetchImpl, key = "FAKE_KEY_A") {
  return createElevenLabsNarrationProvider({ fetchImpl, getApiKey: () => key });
}
function success() { return new Response(Buffer.from("ID3fixture"), { status: 200, headers: { "content-type": "audio/mpeg" } }); }

await test("HTTP construction, encodage, headers et body", async () => {
  let captured;
  const result = await provider(async (url, init) => { captured = { url: String(url), init }; return success(); }).generate({ unitId: "s01-g01", text: "Bonjour", providerConfig: config });
  assert(captured.url === "https://api.elevenlabs.io/v1/text-to-speech/voice%20%2F%20id?output_format=mp3_44100_128", captured.url);
  assert(captured.init.method === "POST" && captured.init.headers["xi-api-key"] === "FAKE_KEY_A", "headers");
  assert(captured.init.headers.accept === "audio/mpeg" && captured.init.headers["content-type"] === "application/json", "content headers");
  assert(captured.init.body === JSON.stringify({ text: "Bonjour", model_id: "eleven_multilingual_v2" }), "body");
  assert(Buffer.isBuffer(result.bytes) && result.extension === ".mp3", "output");
});

for (const [status, expression] of [[401,/authentication/],[403,/authorization/],[402,/quota/],[422,/invalid request/],[429,/rate limit/],[500,/provider\/server/]]) {
  await test(`HTTP ${status} fail closed, no retry`, async () => {
    let calls = 0;
    await reject(() => provider(async () => { calls += 1; return new Response("x", { status }); }).generate({ unitId:"s01-g01", text:"x", providerConfig:config }), expression);
    assert(calls === 1, `calls=${calls}`);
  });
}

await test("timeout, transport, empty and wrong content type fail closed", async () => {
  await reject(() => provider(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }).generate({ unitId:"s01-g01", text:"x", providerConfig:config }), /timeout/);
  await reject(() => provider(async () => { throw new Error("offline"); }).generate({ unitId:"s01-g01", text:"x", providerConfig:config }), /transport failure/);
  await reject(() => provider(async () => new Response(Buffer.alloc(0), { status:200, headers:{"content-type":"audio/mpeg"} })).generate({ unitId:"s01-g01", text:"x", providerConfig:config }), /empty/);
  await reject(() => provider(async () => new Response("html", { status:200, headers:{"content-type":"text/html"} })).generate({ unitId:"s01-g01", text:"x", providerConfig:config }), /wrong content-type/);
});

await test("identity excludes key and changes with content configuration", () => {
  const hash = values => requestSha256(elevenLabsRequestIdentity({ unitId:"s01-g01", text:"texte", providerConfig:{ ...config, ...values } }));
  const base = hash({});
  assert(base === hash({}), "stable");
  assert(base !== requestSha256(elevenLabsRequestIdentity({ unitId:"s01-g01", text:"autre", providerConfig:config })), "text");
  assert(base !== hash({ voiceId:"other" }), "voice");
  assert(base !== hash({ modelId:"other" }), "model");
  assert(base !== hash({ outputFormat:"other" }), "format");
  assert(!JSON.stringify(elevenLabsRequestIdentity({ unitId:"s01-g01", text:"texte", providerConfig:config })).includes("FAKE_KEY_A"), "secret identity");
});

assert(networkGuard.attempts().length === 0, JSON.stringify(networkGuard.attempts()));
console.log(`RESULT — PASS=${pass} FAIL=${fail}`);
process.exitCode = fail ? 1 : 0;
