// Smoke R28.7 — exécuteur du juge de couverture, zéro API. Le transport est
// toujours simulé. Vérifie le transport nominal, l'échec fermé (transport
// absent, exception, délai, réponses vides, non textuelles ou hors bornes),
// l'unicité de l'appel, l'intégrité de la requête et de la réponse, le
// déterminisme, l'idempotence, l'absence de réseau, et des mutations avec
// témoin (copies hors dépôt, reproductibles depuis ce smoke).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-judge-executor-smoke.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual, strictEqual } from "node:assert/strict";

import {
  COVERAGE_JUDGE_EXECUTOR_VERSION,
  EXECUTOR_FAILURE,
  EXECUTOR_LIMITS,
  EXECUTOR_STATUS,
  executeJudgeRequest
} from "../src/utils/coverage-judge-executor.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`       ${error?.message ?? error}`);
  }
}

// Requête au format produit par le juge v2 (contenu métier opaque ici).
const REQUEST = Object.freeze({
  system: "Tu es un auditeur de couverture factuelle.",
  messages: Object.freeze([Object.freeze({ role: "user", content: "SEGMENT A AUDITER :\n\n{\"segment_id\":\"s2-g4\"}" })]),
  maxTokens: 2000,
  temperature: 0
});
const REQUEST_SNAPSHOT = JSON.stringify(REQUEST);
const BODY = "{\"protocol_id\":\"abc\",\"results\":[]}";

// Transport simulé : compte ses appels et renvoie une réponse configurable.
function transport({ reply = undefined, text = BODY, throws = null, never = false, mutate = false } = {}) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    if (mutate) request.messages[0].content = "modifié";
    if (never) return new Promise(() => {});
    if (throws) throw new Error(throws);
    if (reply !== undefined) return reply;
    return {
      request_sha256: "a".repeat(64),
      meta: { stop_reason: "end_turn", input_tokens: 10, output_tokens: 20 },
      response: { content: [{ type: "text", text }] }
    };
  };
  return { fn, calls };
}

const run = (overrides = {}, options = {}) => {
  const t = transport(options);
  return executeJudgeRequest({ request: REQUEST, transport: t.fn, ...overrides }).then(result => ({ result, calls: t.calls }));
};

async function expectNotJudged(options, category, reasonPrefix, expectedCalls = 1, overrides = {}) {
  const { result, calls } = await run(overrides, options);
  deepStrictEqual([result.status, result.failure?.category, result.reply, result.calls, calls.length], ["NOT_JUDGED", category, null, expectedCalls, expectedCalls]);
  if (!result.failure.reason.startsWith(reasonPrefix)) throw new Error(`raison : ${result.failure.reason}`);
  deepStrictEqual(JSON.stringify(REQUEST), REQUEST_SNAPSHOT);
  return result;
}

await test("constantes publiques : version, statuts, catégories, bornes", () => {
  deepStrictEqual(COVERAGE_JUDGE_EXECUTOR_VERSION, "coverage-judge-executor.v1");
  deepStrictEqual(Object.values(EXECUTOR_STATUS), ["OK", "NOT_JUDGED"]);
  deepStrictEqual(Object.values(EXECUTOR_FAILURE), [
    "TRANSPORT_MISSING", "INVALID_REQUEST", "REQUEST_OUT_OF_BOUNDS", "TRANSPORT_ERROR",
    "TIMEOUT", "EMPTY_RESPONSE", "NON_TEXT_RESPONSE", "RESPONSE_OUT_OF_BOUNDS"
  ]);
  deepStrictEqual({ ...EXECUTOR_LIMITS }, { max_request_chars: 16000, max_tokens: 4000, max_response_chars: 16000, timeout_ms: 120000 });
});

await test("transport nominal : OK, un seul appel, réponse brute transmise telle quelle", async () => {
  const reply = { request_sha256: "b".repeat(64), meta: { stop_reason: "end_turn", output_tokens: 5 }, response: { content: [{ type: "text", text: BODY }] } };
  const { result, calls } = await run({}, { reply });
  deepStrictEqual([result.status, result.failure, result.calls, calls.length, result.request_sha256], ["OK", null, 1, 1, "b".repeat(64)]);
  strictEqual(result.reply, reply);
  deepStrictEqual(reply.response.content[0].text, BODY);
});

await test("aucune modification de la requête : copie équivalente transmise, original intact, copie figée", async () => {
  const { calls } = await run();
  deepStrictEqual(JSON.stringify(calls[0]), REQUEST_SNAPSHOT);
  if (!Object.isFrozen(calls[0]) || !Object.isFrozen(calls[0].messages[0])) throw new Error("copie transmise modifiable");
  const mutable = JSON.parse(REQUEST_SNAPSHOT);
  const t = transport();
  await executeJudgeRequest({ request: mutable, transport: t.fn });
  deepStrictEqual(JSON.stringify(mutable), REQUEST_SNAPSHOT);
  if (t.calls[0] === mutable) throw new Error("requête transmise par référence");
});

await test("un transport qui tente de modifier la requête échoue fermé, l'original reste intact", async () => {
  const mutable = JSON.parse(REQUEST_SNAPSHOT);
  const t = transport({ mutate: true });
  const result = await executeJudgeRequest({ request: mutable, transport: t.fn });
  deepStrictEqual([result.status, result.failure.category], ["NOT_JUDGED", "TRANSPORT_ERROR"]);
  deepStrictEqual(JSON.stringify(mutable), REQUEST_SNAPSHOT);
});

await test("transport absent → NOT_JUDGED, aucun appel", async () => {
  for (const missing of [undefined, null, "createMessage", {}]) {
    const result = await executeJudgeRequest({ request: REQUEST, transport: missing });
    deepStrictEqual([result.status, result.failure.category, result.calls], ["NOT_JUDGED", "TRANSPORT_MISSING", 0]);
  }
  const empty = await executeJudgeRequest();
  deepStrictEqual([empty.status, empty.failure.category], ["NOT_JUDGED", "TRANSPORT_MISSING"]);
});

await test("exception du transport → NOT_JUDGED qualifié, aucune exception propagée", async () => {
  await expectNotJudged({ throws: "panne réseau" }, "TRANSPORT_ERROR", "panne réseau");
  const t = { fn: () => { throw new Error("synchrone"); }, calls: [] };
  const result = await executeJudgeRequest({ request: REQUEST, transport: t.fn });
  deepStrictEqual([result.status, result.failure.category, result.failure.reason], ["NOT_JUDGED", "TRANSPORT_ERROR", "synchrone"]);
});

await test("délai simulé dépassé → NOT_JUDGED (TIMEOUT)", async () => {
  await expectNotJudged({ never: true }, "TIMEOUT", "délai dépassé (25 ms)", 1, { limits: { ...EXECUTOR_LIMITS, timeout_ms: 25 } });
});

await test("réponse vide → NOT_JUDGED (EMPTY_RESPONSE)", async () => {
  for (const reply of [null, {}, { response: {} }, { response: { content: [] } }]) {
    await expectNotJudged({ reply }, "EMPTY_RESPONSE", "");
  }
  await expectNotJudged({ text: "" }, "EMPTY_RESPONSE", "texte vide");
});

await test("réponse non textuelle → NOT_JUDGED (NON_TEXT_RESPONSE)", async () => {
  for (const content of [[{ type: "tool_use", input: {} }], [{ type: "image" }], [{ type: "text", text: 42 }], ["texte brut"]]) {
    await expectNotJudged({ reply: { response: { content } } }, "NON_TEXT_RESPONSE", "aucun bloc texte");
  }
});

await test("réponse trop longue ou au-delà de maxTokens → NOT_JUDGED (RESPONSE_OUT_OF_BOUNDS), signal conservé", async () => {
  const result = await expectNotJudged({ text: "x".repeat(16001) }, "RESPONSE_OUT_OF_BOUNDS", "réponse : 16001 caractères");
  deepStrictEqual(result.request_sha256, "a".repeat(64));
  await expectNotJudged({ reply: { meta: { output_tokens: 2001 }, response: { content: [{ type: "text", text: BODY }] } } }, "RESPONSE_OUT_OF_BOUNDS", "réponse : 2001 tokens");
  const atLimit = await run({}, { text: "x".repeat(16000) });
  deepStrictEqual(atLimit.result.status, "OK");
});

await test("requête invalide ou hors bornes → NOT_JUDGED sans appel", async () => {
  for (const [request, category] of [
    [null, "INVALID_REQUEST"],
    [{ ...REQUEST, system: "" }, "INVALID_REQUEST"],
    [{ ...REQUEST, messages: [] }, "INVALID_REQUEST"],
    [{ ...REQUEST, messages: [{ role: "system", content: "x" }] }, "INVALID_REQUEST"],
    [{ ...REQUEST, maxTokens: 0 }, "INVALID_REQUEST"],
    [{ ...REQUEST, temperature: "0" }, "INVALID_REQUEST"],
    [{ ...REQUEST, maxTokens: 4001 }, "REQUEST_OUT_OF_BOUNDS"],
    [{ ...REQUEST, messages: [{ role: "user", content: "x".repeat(16000) }] }, "REQUEST_OUT_OF_BOUNDS"]
  ]) {
    const t = transport();
    const result = await executeJudgeRequest({ request, transport: t.fn });
    deepStrictEqual([result.status, result.failure.category, result.calls, t.calls.length], ["NOT_JUDGED", category, 0, 0]);
  }
});

await test("contenu jamais lu ni transformé : un JSON métier invalide est transmis tel quel", async () => {
  const { result } = await run({}, { text: "pas du JSON { ]" });
  deepStrictEqual([result.status, result.reply.response.content[0].text], ["OK", "pas du JSON { ]"]);
});

await test("déterminisme et idempotence : mêmes entrées → même sortie, un appel par exécution", async () => {
  const first = await run();
  await run({}, { throws: "autre" });
  const second = await run();
  deepStrictEqual(JSON.stringify(first.result), JSON.stringify(second.result));
  deepStrictEqual([first.calls.length, second.calls.length], [1, 1]);
});

await test("aucun import d'un composant de couverture, du pipeline ou du réseau ; aucun cache", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-judge-executor.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")), []);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["import(", "require(", "fetch(", "http", "createMessage", "call-guard", "discardCachedResponse", "JSON.parse", "protocol_id", "lock_sha256", "voiceover_sha256", "sha256(", "crypto"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
});

await test("sortie immuable", async () => {
  const { result } = await run({}, { throws: "x" });
  if (!Object.isFrozen(result) || !Object.isFrozen(result.failure)) throw new Error("sortie modifiable");
});

// Copie isolée hors dépôt de l'exécuteur, avec une mutation textuelle facultative.
async function isolatedExecutor(prefix, mutation = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let source = fs.readFileSync(new URL("../src/utils/coverage-judge-executor.js", import.meta.url), "utf8");
  if (mutation) {
    if (source.split(mutation.from).length !== 2) throw new Error(`mutation non applicable : ${mutation.from}`);
    source = source.replace(mutation.from, mutation.to);
  }
  fs.writeFileSync(path.join(root, "coverage-judge-executor.js"), source);
  const module = await import(pathToFileURL(path.join(root, "coverage-judge-executor.js")).href);
  return { root, module };
}

async function behaviourFailures(module) {
  const failures = [];
  const exec = async (options = {}, overrides = {}) => {
    const t = transport(options);
    try {
      const result = await module.executeJudgeRequest({ request: JSON.parse(REQUEST_SNAPSHOT), transport: t.fn, ...overrides });
      return [result.status, result.failure?.category ?? null, t.calls.length];
    } catch (error) {
      return ["EXCEPTION", error.message, t.calls.length];
    }
  };
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  check("nominal", await exec(), ["OK", null, 1]);
  check("transport absent", await exec({}, { transport: undefined }), ["NOT_JUDGED", "TRANSPORT_MISSING", 0]);
  check("exception", await exec({ throws: "x" }), ["NOT_JUDGED", "TRANSPORT_ERROR", 1]);
  // Garde du smoke : un mutant sans délai ne doit pas bloquer l'exécution.
  let guardTimer;
  const hang = new Promise(resolve => { guardTimer = setTimeout(() => resolve(["BLOQUÉ", null, 1]), 500); });
  check("délai", await Promise.race([exec({ never: true }, { limits: { ...EXECUTOR_LIMITS, timeout_ms: 20 } }), hang]), ["NOT_JUDGED", "TIMEOUT", 1]);
  clearTimeout(guardTimer);
  check("vide", await exec({ text: "" }), ["NOT_JUDGED", "EMPTY_RESPONSE", 1]);
  check("non textuelle", await exec({ reply: { response: { content: [{ type: "image" }] } } }), ["NOT_JUDGED", "NON_TEXT_RESPONSE", 1]);
  check("trop longue", await exec({ text: "x".repeat(16001) }), ["NOT_JUDGED", "RESPONSE_OUT_OF_BOUNDS", 1]);
  check("requête hors bornes", await exec({}, { request: { ...REQUEST, maxTokens: 4001 } }), ["NOT_JUDGED", "REQUEST_OUT_OF_BOUNDS", 0]);
  check("requête protégée", await exec({ mutate: true }), ["NOT_JUDGED", "TRANSPORT_ERROR", 1]);
  return failures;
}

const MUTATIONS = [
  ["transport absent non vérifié", { from: 'if (typeof transport !== "function") return notJudged(EXECUTOR_FAILURE.TRANSPORT_MISSING, "transport absent", 0);', to: "" }],
  ["texte vide accepté", { from: 'if (texts.every(block => block.text.length === 0)) return [EXECUTOR_FAILURE.EMPTY_RESPONSE, "texte vide"];', to: "" }],
  ["réponse non textuelle acceptée", { from: 'if (texts.length === 0) return [EXECUTOR_FAILURE.NON_TEXT_RESPONSE, "aucun bloc texte"];', to: "" }],
  ["longueur de réponse non bornée", { from: "if (chars > limits.max_response_chars) {", to: "if (false) {" }],
  ["bornes de requête ignorées", { from: "if (bounds) return", to: "if (false) return" }],
  ["délai supprimé", { from: "timer = setTimeout(", to: "timer = 0 && setTimeout(" }],
  ["requête transmise par référence", { from: "transport(frozenRequest)", to: "transport(request)" }],
  ["double appel", { from: "Promise.resolve().then(() => transport(frozenRequest))", to: "Promise.resolve().then(() => transport(frozenRequest)).then(() => transport(frozenRequest))" }],
  ["exception transformée en OK", { from: 'return notJudged(EXECUTOR_FAILURE.TRANSPORT_ERROR, String(error?.message ?? error), 1);', to: "return outcome({ status: EXECUTOR_STATUS.OK, calls: 1 });" }]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt)", async () => {
  const control = await isolatedExecutor("r28-7-control-");
  try {
    deepStrictEqual(await behaviourFailures(control.module), [], "témoin");
  } finally {
    fs.rmSync(control.root, { recursive: true, force: true });
  }
  for (const [name, mutation] of MUTATIONS) {
    const mutant = await isolatedExecutor("r28-7-mutant-", mutation);
    try {
      if ((await behaviourFailures(mutant.module)).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      fs.rmSync(mutant.root, { recursive: true, force: true });
    }
  }
});

await test("aucune tentative réseau réelle", () => {
  deepStrictEqual(networkGuard.attempts().length, 0);
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-judge-executor-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
