// Smoke long-form du batching de claims — fixtures locales, zéro réseau.
import { networkGuard } from "./fixture-network-guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_CLAIMS_PER_BATCH,
  MAX_BATCH_ESTIMATED_CHARS,
  estimateClaimValidationCalls,
  planClaimValidationBatches,
  validateClaimBatchResponse,
  validateScriptClaimCoverage
} from "../src/utils/validate-script-claim-coverage.js";
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
function rejects(fn, pattern) {
  try { fn(); } catch (error) { assert(pattern.test(error.message), error.message); return; }
  throw new Error("échec attendu");
}
function longScript(sectionCount = 6, segmentsPerSection = 8) {
  let n = 0;
  return {
    sections: Array.from({ length: sectionCount }, (_, section) => ({
      segments: Array.from({ length: segmentsPerSection }, (_, segment) => {
        n += 1;
        return {
          voiceover: `Le fait documentaire ${n} est déclaré dans ce segment.`,
          claims: [{ text: `Le fait documentaire ${n} est déclaré dans ce segment.` }]
        };
      })
    }))
  };
}

console.log("LONG-FORM CLAIM BATCH — SMOKE (ZERO API)");
const script = longScript(); // 48 segments / 48 claims, représentatif sans média.
const estimate = estimateClaimValidationCalls({ script });

await test("48 claims → 2 batches déterministes de 24", () => {
  assert(estimate.batch_count === 2 && estimate.validation_calls_max === 2, JSON.stringify(estimate));
  assert(JSON.stringify(estimate) === JSON.stringify(estimateClaimValidationCalls({ script })), "estimation non déterministe");
});

function scriptWith(items) {
  return {
    sections: [{
      segments: items.map(({ voiceover, claims }) => ({ voiceover, claims }))
    }]
  };
}

function claims(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({ text: `${prefix} claim ${index + 1}` }));
}

await test("la limite de 24 claims ferme le lot sans découper un segment", () => {
  const plan = planClaimValidationBatches(scriptWith([
    { voiceover: "A.", claims: claims(10, "A") },
    { voiceover: "B.", claims: claims(10, "B") },
    { voiceover: "C.", claims: claims(10, "C") }
  ]));
  assert(plan.batches.length === 2, JSON.stringify(plan.batches));
  assert(plan.batches.map(batch => batch.claim_count).join(",") === "20,10", JSON.stringify(plan.batches));
  assert(plan.batches[0].items.map(item => item.id).join(",") === "s1-g1,s1-g2", JSON.stringify(plan.batches));
});

await test("la limite de 9 000 caractères ferme le lot sans découper un segment", () => {
  const plan = planClaimValidationBatches(scriptWith([
    { voiceover: "A".repeat(4000), claims: [{ text: "A" }] },
    { voiceover: "B".repeat(4000), claims: [{ text: "B" }] },
    { voiceover: "C".repeat(900), claims: [{ text: "C" }] }
  ]));
  assert(plan.batches.length === 2, JSON.stringify(plan.batches));
  assert(plan.batches.map(batch => batch.items.map(item => item.id).join(",")).join("|") === "s1-g1,s1-g2|s1-g3", JSON.stringify(plan.batches));
});

await test("plan identique : ordre stable et aucun lot ne dépasse ses deux plafonds", () => {
  const first = planClaimValidationBatches(script);
  const second = planClaimValidationBatches(structuredClone(script));
  assert(JSON.stringify(first.batches.map(batch => ({ ids: batch.items.map(item => item.id), claims: batch.claim_count, chars: batch.estimated_chars }))) === JSON.stringify(second.batches.map(batch => ({ ids: batch.items.map(item => item.id), claims: batch.claim_count, chars: batch.estimated_chars }))), "plan non déterministe");
  assert(first.batches.every(batch => batch.claim_count <= MAX_CLAIMS_PER_BATCH && batch.estimated_chars <= MAX_BATCH_ESTIMATED_CHARS), JSON.stringify(first.batches));
});

await test("contrat batch : aucune perte, doublon ou réordonnancement", () => {
  const expected = [
    { id: "s1-g1", claims: [{ claim_id: "s1-g1-c1", text: "A" }] },
    { id: "s1-g2", claims: [{ claim_id: "s1-g2-c1", text: "B" }] }
  ];
  const results = validateClaimBatchResponse({ results: [
    { id: "s1-g2", covered: true, unsupported: [] },
    { id: "s1-g1", covered: true, unsupported: [] }
  ] }, expected);
  assert(results.map(item => item.id).join(",") === "s1-g2,s1-g1", "réponse valide perdue");
  rejects(() => validateClaimBatchResponse({ results: [{ id: "s1-g1", covered: true, unsupported: [] }] }, expected), /incomplète/);
  rejects(() => validateClaimBatchResponse({ results: [
    { id: "s1-g1", covered: true, unsupported: [] },
    { id: "s1-g1", covered: true, unsupported: [] }
  ] }, expected), /dupliqué/);
  rejects(() => validateClaimBatchResponse({ results: [
    { id: "s1-g1", covered: true, unsupported: [] },
    { id: "inconnu", covered: true, unsupported: [] }
  ] }, expected), /inconnu/);
});

await test("budget insuffisant → refus pré-call et 0 appel", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r15-budget-"));
  const previous = { NO_API: process.env.NO_API, PIPELINE_REAL_CALLS_ACK: process.env.PIPELINE_REAL_CALLS_ACK };
  try {
    delete process.env.NO_API;
    process.env.PIPELINE_REAL_CALLS_ACK = "1";
    configureCallGuard({ productionDir: dir, cap: 1 });
    process.env.ANTHROPIC_FIXTURES = "1";
    let error;
    try { await validateScriptClaimCoverage(script); } catch (caught) { error = caught; }
    assert(error && /Budget d'appels réels insuffisant/.test(error.message), error?.message);
    assert(getCallGuardStatus().used === 0, JSON.stringify(getCallGuardStatus()));
  } finally {
    resetCallGuard();
    process.env.NO_API = previous.NO_API;
    process.env.PIPELINE_REAL_CALLS_ACK = previous.PIPELINE_REAL_CALLS_ACK;
    delete process.env.ANTHROPIC_FIXTURES;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("budget suffisant + fixtures → PASS logique, 48 résultats stables", async () => {
  process.env.ANTHROPIC_FIXTURES = "1";
  const result = await validateScriptClaimCoverage(script);
  delete process.env.ANTHROPIC_FIXTURES;
  assert(result.valid && result.segments.length === 48, JSON.stringify(result.errors));
  assert(result.estimate.batch_count === 2 && result.estimate.total_calls_max === 50, JSON.stringify(result.estimate));
  assert(result.segments.map(item => item.label).at(-1) === "sections[5].segments[7]", "ordre source instable");
});

// R20.4 D1 — réservation progressive : seuls les lots sont réservés ; les
// réparations sont bornées appel par appel par le garde et reprises depuis
// le cache. Le SDK est simulé en mémoire (réponses des fixtures) pour que
// chaque appel traverse le vrai garde et le vrai cache, sans réseau.
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

await test("D1 : plafond égal aux appels nécessaires (génération + 1 lot) → PASS sans réparation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r20-d1-happy-"));
  try {
    await withRealGuard("happy", dir, 2, async sdkCalls => {
      const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
      const estimate = result.claim_coverage_validation.estimate;
      assert(result.claim_coverage_validation.valid, JSON.stringify(result.claim_coverage_validation.errors));
      assert(estimate.batch_count === 1 && estimate.total_calls_max > 2, `estimate conservé : ${JSON.stringify(estimate)}`);
      assert(getCallGuardStatus().used === 2 && sdkCalls.length === 2, `appels : ${getCallGuardStatus().used}`);
      assert(countStatus(dir, "succeeded") === 2 && countStatus(dir, "cache_hit") === 0, JSON.stringify(journal(dir)));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("D1 : réparation déterministe → 3 appels maximum (génération + juge + recheck)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r20-d1-stop-"));
  try {
    await withRealGuard("script-coverage-repair", dir, 3, async sdkCalls => {
      const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
      assert(result.claim_coverage_validation.valid, JSON.stringify(result.claim_coverage_validation.errors));
      assert(getCallGuardStatus().used === 3 && sdkCalls.length === 3, `appels : ${getCallGuardStatus().used} / SDK ${sdkCalls.length}`);
      assert(countStatus(dir, "succeeded") === 3 && countStatus(dir, "started") === 0, JSON.stringify(journal(dir)));
    });

    await test("D1 : reprise → génération, juge et recheck servis par cache", async () => {
      await withRealGuard("script-coverage-repair", dir, 1, async sdkCalls => {
        const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
        assert(result.claim_coverage_validation.valid, JSON.stringify(result.claim_coverage_validation.errors));
        assert(result.claim_coverage_validation.segments[0].repaired === true, "réparation attendue");
        assert(getCallGuardStatus().used === 0 && getCallGuardStatus().cache_hits === 3, JSON.stringify(getCallGuardStatus()));
        assert(sdkCalls.length === 0, `SDK appelé ${sdkCalls.length} fois`);
        assert(countStatus(dir, "cache_hit") === 3 && countStatus(dir, "succeeded") === 3, JSON.stringify(journal(dir)));
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
