// Smoke long-form de la couverture (garde d'appels, cache, reprise) — fixtures locales, zéro réseau.
import { networkGuard } from "./fixture-network-guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  configureCallGuard,
  getCallGuardStatus,
  resetCallGuard
} from "../src/services/call-guard.js";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicFixture } from "../src/fixtures/anthropic.js";
import { CANONICAL_PROMPT, CANONICAL_TITLE } from "../src/fixtures/anthropic-dataset.js";
import { runResearchAgent } from "../src/agents/research.js";
import { runScriptAgent } from "../src/agents/script.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("LONG-FORM CLAIM BATCH — SMOKE (ZERO API)");
// R20.4 D1 — chaque appel (génération, jugement, relance) est borné par le
// garde et les réponses acceptées sont reprises depuis le cache. Le SDK est
// simulé en mémoire (réponses des fixtures) pour que chaque appel traverse le
// vrai garde et le vrai cache, sans réseau.
async function withRealGuard(scenario, productionDir, cap, fn) {
  const previous = { ...process.env };
  const sdkCalls = [];
  try {
    delete process.env.NO_API;
    delete process.env.ANTHROPIC_FIXTURES;
    process.env.PIPELINE_REAL_CALLS_ACK = "1";
    process.env.ANTHROPIC_FIXTURE_SCENARIO = scenario;
    process.env.ANTHROPIC_API_KEY ??= `sk-ant-test-${"x".repeat(60)}`;
    Anthropic.Messages.prototype.create = async function (request) {
      process.env.ANTHROPIC_FIXTURES = "1";
      try {
        sdkCalls.push(request.system.slice(0, 40));
        return getAnthropicFixture({ system: request.system, messages: request.messages, tools: request.tools }).response;
      } finally {
        delete process.env.ANTHROPIC_FIXTURES;
      }
    };
    configureCallGuard({ productionDir, cap });
    return await fn(sdkCalls);
  } finally {
    Anthropic.Messages.prototype.create = networkGuard.sdkMessagesCreate;
    resetCallGuard();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

const journal = dir => JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8")).entries;
const countStatus = (dir, status) => journal(dir).filter(entry => entry.status === status).length;

process.env.ANTHROPIC_FIXTURES = "1";
const fixtureResearch = (await runResearchAgent({ title: CANONICAL_TITLE, prompt: CANONICAL_PROMPT, testMode: true })).data;
delete process.env.ANTHROPIC_FIXTURES;

// R28.10 : la couverture passe par le coordinateur, un appel au juge par
// segment et par ronde (2 segments dans le script de test).
await test("D1 : plafond égal aux appels nécessaires (génération + 1 juge par segment) → PASS sans réparation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r20-d1-happy-"));
  try {
    await withRealGuard("happy", dir, 3, async sdkCalls => {
      const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
      assert(result.claim_coverage_validation.valid, JSON.stringify(result.claim_coverage_validation));
      assert(result.claim_coverage_validation.segments.every(segment => segment.rounds === 1 && segment.repair_count === 0), JSON.stringify(result.claim_coverage_validation.segments));
      assert(getCallGuardStatus().used === 3 && sdkCalls.length === 3, `appels : ${getCallGuardStatus().used}`);
      assert(countStatus(dir, "succeeded") === 3 && countStatus(dir, "cache_hit") === 0, JSON.stringify(journal(dir)));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("D1 : réparation déterministe → 4 appels (génération + 2 rondes sur le segment réparé + 1 juge)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r20-d1-stop-"));
  try {
    await withRealGuard("script-coverage-repair", dir, 4, async sdkCalls => {
      const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
      assert(result.claim_coverage_validation.valid, JSON.stringify(result.claim_coverage_validation));
      assert(getCallGuardStatus().used === 4 && sdkCalls.length === 4, `appels : ${getCallGuardStatus().used} / SDK ${sdkCalls.length}`);
      assert(countStatus(dir, "succeeded") === 4 && countStatus(dir, "started") === 0, JSON.stringify(journal(dir)));
    });

    await test("D1 : reprise → génération et jugements acceptés servis par cache", async () => {
      await withRealGuard("script-coverage-repair", dir, 1, async sdkCalls => {
        const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
        assert(result.claim_coverage_validation.valid, JSON.stringify(result.claim_coverage_validation));
        assert(result.claim_coverage_validation.segments[0].repair_count === 1, "réparation attendue");
        assert(getCallGuardStatus().used === 0 && getCallGuardStatus().cache_hits === 4, JSON.stringify(getCallGuardStatus()));
        assert(sdkCalls.length === 0, `SDK appelé ${sdkCalls.length} fois`);
        assert(countStatus(dir, "cache_hit") === 4 && countStatus(dir, "succeeded") === 4, JSON.stringify(journal(dir)));
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
