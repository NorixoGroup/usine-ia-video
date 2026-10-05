// Smoke R25.7D — borne de sortie des lots de couverture et cache, zéro API.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/claim-coverage-output-bound-smoke.js
//
// 1. Le planificateur borne la sortie du juge (pire cas : chaque phrase
//    signalée), de façon déterministe, avant tout appel.
// 2. Une réponse tronquée (max_tokens) ou rejetée est écartée du cache : la
//    reprise refait l'appel au lieu de rejouer l'échec.
// SDK mocké en mémoire, garde, journal et cache réels, clé factice.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import {
  OUTPUT_TOKEN_BUDGET,
  MAX_OUTPUT_TOKENS,
  countSentences,
  planClaimValidationBatches,
  estimateClaimValidationCalls,
  validateScriptClaimCoverage
} from "../src/utils/validate-script-claim-coverage.js";
import { CACHE_DIR, configureCallGuard, resetCallGuard } from "../src/services/call-guard.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

delete process.env.ANTHROPIC_API_KEY;

let passed = 0;
let failed = 0;
const tempDirs = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

async function expectReject(fn, pattern) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, "une erreur était attendue");
  assert(pattern.test(error.message), `erreur inattendue : ${error.message}`);
}

const sentence = n => `Phrase documentaire numéro ${n} qui décrit un fait déclaré dans ce segment.`;
const segment = (n, sentences) => ({
  voiceover: Array.from({ length: sentences }, (_, k) => sentence(`${n}.${k + 1}`)).join(" "),
  claims: [{ text: sentence(`${n}.1`) }]
});
const scriptOf = segments => ({ sections: [{ segments }] });

console.log("--- 1. Borne de sortie du planificateur ---");

await test("découpage en phrases fixe (fin . ! ? …, reste final compté)", () => {
  assert(countSentences("Un. Deux ! Trois ? Quatre… Cinq") === 5, String(countSentences("Un. Deux ! Trois ? Quatre… Cinq")));
  assert(countSentences("Sans ponctuation") === 1 && countSentences("Une seule.") === 1, "phrase unique");
});

await test("chaque lot reste sous la borne de sortie ; ordre et contenu identiques d'une exécution à l'autre", () => {
  const script = scriptOf(Array.from({ length: 30 }, (_, n) => segment(n + 1, 6)));
  const plan = planClaimValidationBatches(script);
  assert(plan.batches.length > 1, `${plan.batches.length} lot(s)`);
  assert(plan.batches.every(batch => batch.estimated_output_tokens <= OUTPUT_TOKEN_BUDGET), JSON.stringify(plan.batches.map(b => b.estimated_output_tokens)));
  assert(plan.batches.flatMap(batch => batch.items.map(item => item.id)).join() === plan.items.map(item => item.id).join(), "ordre ou perte");
  assert(JSON.stringify(planClaimValidationBatches(structuredClone(script))) === JSON.stringify(plan), "non déterministe");
  const estimate = estimateClaimValidationCalls({ script });
  assert(estimate.batch_count === plan.batches.length && estimate.output_token_budget === OUTPUT_TOKEN_BUDGET, JSON.stringify(estimate));
});

await test("la borne de sortie ferme un lot que les deux autres plafonds laisseraient passer", () => {
  const plan = planClaimValidationBatches(scriptOf([segment(1, 9), segment(2, 9)]));
  assert(plan.batches.length === 2, `${plan.batches.length} lot(s)`);
  assert(plan.batches.every(batch => batch.claim_count <= 24 && batch.estimated_chars <= 9000), "autre plafond atteint");
});

await test("segment dont le pire cas dépasse la borne seul : refus avant tout appel", async () => {
  await expectReject(async () => planClaimValidationBatches(scriptOf([segment(1, 40)])), /tokens de sortie estimés \(pire cas\) dépasse OUTPUT_TOKEN_BUDGET/);
});

await test("la limite de sortie envoyée reste 2 000 tokens, supérieure à la borne planifiée", () => {
  assert(MAX_OUTPUT_TOKENS === 2000 && OUTPUT_TOKEN_BUDGET < MAX_OUTPUT_TOKENS, `${MAX_OUTPUT_TOKENS} / ${OUTPUT_TOKEN_BUDGET}`);
});

console.log("--- 2. Réponse tronquée ou rejetée : écartée du cache ---");

async function withGuard(directory, handler, fn) {
  const previous = { ...process.env };
  delete process.env.NO_API;
  delete process.env.ANTHROPIC_FIXTURES;
  process.env.PIPELINE_REAL_CALLS_ACK = "1";
  process.env.ANTHROPIC_API_KEY = "x".repeat(60);
  const calls = [];
  Anthropic.Messages.prototype.create = async function (request) { calls.push(request); return handler(request, calls.length); };

  try {
    configureCallGuard({ productionDir: directory, cap: 20 });
    return await fn(calls);
  } finally {
    resetCallGuard();
    Anthropic.Messages.prototype.create = networkGuard.sdkMessagesCreate;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

const reply = (text, stopReason = "end_turn") => ({ id: "msg", model: "mock", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 }, stop_reason: stopReason });
const covered = request => {
  const items = JSON.parse(request.messages[0].content.replace(/^ELEMENTS A CONTROLER :\n\n/, "")).items;
  return JSON.stringify({ results: items.map(item => ({ id: item.id, covered: true, unsupported: [] })) });
};
const rejectedCount = directory => {
  const root = path.join(directory, CACHE_DIR, "rejected");
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter(f => String(f).endsWith(".json")).length : 0;
};

for (const [name, bad, pattern] of [
  ["tronquée (max_tokens)", () => reply("{\"results\": [", "max_tokens"), /réponse batch tronquée/],
  ["en JSON invalide", () => reply("pas du JSON"), /JSON batch invalide/],
  ["incomplète (résultat manquant)", () => reply(JSON.stringify({ results: [] })), /incomplète/]
]) {
  await test(`réponse ${name} : erreur, retirée du cache ; la reprise refait l'appel et réussit`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-output-bound-"));
    tempDirs.push(directory);
    const script = scriptOf([segment(1, 2), segment(2, 2)]);
    await withGuard(directory, () => bad(), () => expectReject(() => validateScriptClaimCoverage(script), pattern));
    assert(rejectedCount(directory) === 1, "réponse rejetée encore en cache");
    const resume = await withGuard(directory, request => reply(covered(request)), async calls => ({ calls, result: await validateScriptClaimCoverage(script) }));
    assert(resume.calls.length === 1 && resume.result.valid, `${resume.calls.length} appel(s) à la reprise`);
  });
}

await test("réponse valide : conservée en cache ; la reprise ne refait aucun appel", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-output-bound-"));
  tempDirs.push(directory);
  const script = scriptOf([segment(1, 2)]);
  await withGuard(directory, request => reply(covered(request)), () => validateScriptClaimCoverage(script));
  const resume = await withGuard(directory, () => { throw new Error("aucun appel attendu"); }, async calls => ({ calls, result: await validateScriptClaimCoverage(script) }));
  assert(resume.calls.length === 0 && resume.result.valid && rejectedCount(directory) === 0, "cache non réutilisé");
});

for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });

const attempts = networkGuard.attempts().length;

console.log(`claim-coverage-output-bound-smoke — ${passed} OK, ${failed} échec(s), tentatives réseau bloquées : ${attempts}`);
process.exit(failed === 0 && attempts === 0 ? 0 : 1);
