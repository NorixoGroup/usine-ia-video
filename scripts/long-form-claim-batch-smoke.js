// Smoke long-form du batching de claims — fixtures locales, zéro réseau.
import { networkGuard } from "./fixture-network-guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_CLAIMS_PER_BATCH,
  estimateClaimValidationCalls,
  validateClaimBatchResponse,
  validateScriptClaimCoverage
} from "../src/utils/validate-script-claim-coverage.js";
import {
  configureCallGuard,
  getCallGuardStatus,
  resetCallGuard
} from "../src/services/call-guard.js";

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
const estimate = estimateClaimValidationCalls({ claimCount: 48 });

await test("48 claims → 2 batches déterministes de 24", () => {
  assert(estimate.batch_count === 2 && estimate.validation_calls_max === 2, JSON.stringify(estimate));
  assert(JSON.stringify(estimate) === JSON.stringify(estimateClaimValidationCalls({ claimCount: 48 })), "estimation non déterministe");
});

await test("contrat batch : aucune perte, doublon ou réordonnancement", () => {
  const expected = [
    { id: "s1-g1", claims: [{ claim_id: "s1-g1-c1", text: "A" }] },
    { id: "s1-g2", claims: [{ claim_id: "s1-g2-c1", text: "B" }] }
  ];
  const results = validateClaimBatchResponse({ results: [
    { id: "s1-g2", covered: true, undeclared_claims: [] },
    { id: "s1-g1", covered: true, undeclared_claims: [] }
  ] }, expected);
  assert(results.map(item => item.id).join(",") === "s1-g2,s1-g1", "réponse valide perdue");
  rejects(() => validateClaimBatchResponse({ results: [{ id: "s1-g1", covered: true, undeclared_claims: [] }] }, expected), /incomplète/);
  rejects(() => validateClaimBatchResponse({ results: [
    { id: "s1-g1", covered: true, undeclared_claims: [] },
    { id: "s1-g1", covered: true, undeclared_claims: [] }
  ] }, expected), /dupliqué/);
  rejects(() => validateClaimBatchResponse({ results: [
    { id: "s1-g1", covered: true, undeclared_claims: [] },
    { id: "inconnu", covered: true, undeclared_claims: [] }
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
  assert(result.estimate.batch_count === 2 && result.estimate.total_calls_max === 98, JSON.stringify(result.estimate));
  assert(result.segments.map(item => item.label).at(-1) === "sections[5].segments[7]", "ordre source instable");
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
