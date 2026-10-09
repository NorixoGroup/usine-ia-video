// Smoke R29.3 — estimation pure du budget d'appels de la couverture, zéro API.
// Le module n'importe jamais le garde d'appels : la sonde de coût est injectée
// ici. Les vrais modules de couverture (frontière, juge, exécuteur) sont
// utilisés. Vérifie : états par segment, minimum exact et maximum informatif,
// cache, sans objet (fixtures, NO_API, garde absent), échecs de sonde
// qualifiés, requête capturée identique à celle du coordinateur, comparaison
// au budget restant (seul le minimum bloque), déterminisme, aucune exception,
// et des mutations avec témoin (copies hors dépôt).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-budget-preflight-smoke.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import {
  BUDGET_ESTIMATE_STATUS,
  BUDGET_PROBE_CATEGORY,
  BUDGET_SEGMENT_STATE,
  BUDGET_VERDICT,
  COVERAGE_BUDGET_PREFLIGHT_VERSION,
  estimateCoverageBudget,
  evaluateCoverageBudget
} from "../src/utils/coverage-budget-preflight.js";
import { SCRIPT_COVERAGE_POLICY, buildCoverageLock, researchEntitiesOf } from "../src/utils/script-coverage-gate.js";
import { coordinateCoverage } from "../src/utils/coverage-coordinator.js";

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

const clone = value => JSON.parse(JSON.stringify(value));
const RESEARCH = { key_facts: [{ claim: "Le désert avance vite dans le centre." }, { claim: "La ville de Sydney grandit." }] };
const ENTITIES = researchEntitiesOf(RESEARCH);
const LOCK = buildCoverageLock({ entities: ENTITIES });
const POLICY = SCRIPT_COVERAGE_POLICY;
const CLAIMS = [{ text: "Le désert avance vite dans le centre." }];
const HEADER = "SEGMENT A AUDITER :\n\n";

const F1 = "Le bassin couvre 3 millions de km².";
const F2 = "Il compte 4 lacs.";
const F3 = "Il a 5 îles.";
const segment = (index, voiceover, claims = CLAIMS) => ({ segment_id: `s1-g${index}`, voiceover, claims });
const THREE = [segment(1, `${F1} ${F2}`), segment(2, `${F2} ${F3}`), segment(3, `${F3} ${F1}`)];

const MISS = () => ({ applicable: true, cached: false });
const HIT = () => ({ applicable: true, cached: true });
const estimate = (segments, probe = MISS, overrides = {}) => estimateCoverageBudget({ segments, entities: ENTITIES, lock: LOCK, policy: POLICY, probe, ...overrides });

// ---------------------------------------------------------------------------

await test("constantes publiques : version, statuts, états, verdicts, catégories", () => {
  deepStrictEqual(COVERAGE_BUDGET_PREFLIGHT_VERSION, "coverage-budget-preflight.v1");
  deepStrictEqual(Object.values(BUDGET_ESTIMATE_STATUS), ["OK", "NOT_APPLICABLE", "PROBE_FAILED"]);
  deepStrictEqual(Object.values(BUDGET_SEGMENT_STATE), ["NO_CALL", "CACHED_ROUND_1", "NEEDS_CALL"]);
  deepStrictEqual(Object.values(BUDGET_VERDICT), ["OK", "INSUFFICIENT"]);
  deepStrictEqual(Object.values(BUDGET_PROBE_CATEGORY), ["CACHE_INVALID", "REQUEST_INVALID"]);
  for (const constant of [BUDGET_ESTIMATE_STATUS, BUDGET_SEGMENT_STATE, BUDGET_VERDICT, BUDGET_PROBE_CATEGORY]) if (!Object.isFrozen(constant)) throw new Error("constante modifiable");
});

await test("3 segments à appeler, rien en cache : minimum 3, maximum 3 × 12 = 36", async () => {
  const result = await estimate(THREE);
  deepStrictEqual(
    [result.status, result.segments_total, result.segments_needing_call, result.segments_cached_round_1, result.segments_no_call, result.min_new_calls, result.max_new_calls],
    ["OK", 3, 3, 0, 0, 3, 36]
  );
  deepStrictEqual(result.segments.map(item => [item.segment_id, item.state]), [["s1-g1", "NEEDS_CALL"], ["s1-g2", "NEEDS_CALL"], ["s1-g3", "NEEDS_CALL"]]);
});

await test("tout en cache : minimum 0, maximum informatif conservé (des rondes suivantes restent possibles)", async () => {
  const result = await estimate(THREE, HIT);
  deepStrictEqual([result.status, result.min_new_calls, result.max_new_calls, result.segments_cached_round_1, result.segments_needing_call], ["OK", 0, 36, 3, 0]);
  deepStrictEqual(result.segments.map(item => item.state), ["CACHED_ROUND_1", "CACHED_ROUND_1", "CACHED_ROUND_1"]);
});

await test("reprise partielle : seul le segment absent du cache est compté", async () => {
  let call = 0;
  const result = await estimate(THREE, () => ({ applicable: true, cached: ++call !== 2 }));
  deepStrictEqual([result.min_new_calls, result.segments_cached_round_1, result.segments.map(item => item.state)], [1, 2, ["CACHED_ROUND_1", "NEEDS_CALL", "CACHED_ROUND_1"]]);
});

await test("une seule requête par segment est sondée, dans l'ordre du script", async () => {
  const seen = [];
  await estimate(THREE, request => { seen.push(JSON.parse(request.messages[0].content.slice(HEADER.length)).segment_id); return MISS(); });
  deepStrictEqual(seen, ["s1-g1", "s1-g2", "s1-g3"]);
});

await test("segment sans unité à juger (unités exclues seules) : NO_CALL, la sonde n'est pas appelée", async () => {
  let probed = 0;
  const result = await estimate([segment(1, "Imaginez la scène. Pourquoi ?")], () => { probed += 1; return MISS(); });
  deepStrictEqual([result.status, result.min_new_calls, result.max_new_calls, result.segments[0].state, probed], ["OK", 0, 0, "NO_CALL", 0]);
});

for (const [name, entry] of [
  ["voiceover vide", segment(1, "")],
  ["voiceover absent", { segment_id: "s1-g1", claims: CLAIMS }],
  ["voiceover non chaîne", segment(1, 42)],
  ["segment nul", null],
  ["segment sans identifiant", { voiceover: F1, claims: CLAIMS }],
  ["voiceover d'espaces", segment(1, "   ")]
]) {
  await test(`segment invalide (${name}) : NO_CALL, jamais compté, le coordinateur le refusera sans appel`, async () => {
    const result = await estimate([entry, segment(2, F1)]);
    deepStrictEqual([result.status, result.segments[0].state, result.min_new_calls], ["OK", "NO_CALL", 1]);
  });
}

await test("verrou dont le coordinateur diffère de la politique : aucun appel prévu (comme le coordinateur)", async () => {
  const result = await estimate(THREE, MISS, { lock: { ...LOCK, coordinator: "autre-politique" } });
  deepStrictEqual([result.status, result.min_new_calls], ["OK", 0]);
});

await test("claims invalides : le juge refuse l'entrée, aucun appel prévu ; claims vides : la requête part (comme le coordinateur)", async () => {
  for (const claims of [undefined, null, "x", [null], [{}], [{ text: 3 }]]) {
    deepStrictEqual((await estimate([{ segment_id: "s1-g1", voiceover: F1, claims }])).min_new_calls, 0);
  }
  deepStrictEqual((await estimate([segment(1, F1, [])])).min_new_calls, 1);
});

await test("script sans segment : minimum 0, maximum 0", async () => {
  const result = await estimate([]);
  deepStrictEqual([result.status, result.segments_total, result.min_new_calls, result.max_new_calls], ["OK", 0, 0, 0]);
});

await test("la requête sondée est exactement celle que le coordinateur enverrait au transport", async () => {
  const probed = [];
  await estimate(THREE, request => { probed.push(request); return MISS(); });
  for (const [index, entry] of THREE.entries()) {
    let sent = null;
    await coordinateCoverage({
      segment: { segment_id: entry.segment_id, voiceover: entry.voiceover, entities: ENTITIES },
      claims: entry.claims,
      lock: LOCK,
      policy: { ...POLICY, max_total_judge_calls: 1 },
      transport: async request => { sent = request; throw new Error("capture"); }
    });
    deepStrictEqual(JSON.parse(JSON.stringify(probed[index])), JSON.parse(JSON.stringify(sent)));
  }
});

await test("clés de la requête sondée : system, messages, maxTokens, temperature (forme attendue par createMessage)", async () => {
  let request = null;
  await estimate([segment(1, F1)], value => { request = value; return MISS(); });
  deepStrictEqual([Object.keys(request).sort(), request.temperature, request.maxTokens, request.messages[0].role, request.messages[0].content.startsWith(HEADER)], [["maxTokens", "messages", "system", "temperature"], 0, 2000, "user", true]);
});

await test("sonde « sans objet » (fixtures, NO_API, garde absent) : NOT_APPLICABLE, rien d'autre n'est sondé", async () => {
  for (const reason of ["FIXTURES", "NO_API", "GUARD_UNCONFIGURED"]) {
    let probed = 0;
    const result = await estimate(THREE, () => { probed += 1; return { applicable: false, reason }; });
    deepStrictEqual([result.status, result.reason, probed], ["NOT_APPLICABLE", reason, 1]);
  }
});

await test("sonde qui lève avec cache_invalid : PROBE_FAILED (CACHE_INVALID), segment désigné, jamais pris pour une absence", async () => {
  const result = await estimate(THREE, request => {
    if (JSON.parse(request.messages[0].content.slice(HEADER.length)).segment_id === "s1-g2") throw Object.assign(new Error("Cache des appels invalide (abc)"), { cache_invalid: true });
    return MISS();
  });
  deepStrictEqual([result.status, result.category, result.segment_id, result.detail], ["PROBE_FAILED", "CACHE_INVALID", "s1-g2", "Cache des appels invalide (abc)"]);
});

await test("sonde qui lève sans cache_invalid, ou réponse invalide : PROBE_FAILED (REQUEST_INVALID)", async () => {
  for (const probe of [() => { throw new Error("autre"); }, () => null, () => "oui", () => undefined]) {
    const result = await estimate(THREE, probe);
    deepStrictEqual([result.status, result.category], ["PROBE_FAILED", "REQUEST_INVALID"]);
  }
});

await test("entrées invalides : PROBE_FAILED, jamais d'exception", async () => {
  for (const input of [undefined, null, {}, { segments: "x" }, { segments: THREE, entities: ENTITIES, lock: LOCK, policy: POLICY }, { segments: THREE, entities: ENTITIES, lock: LOCK, policy: { ...POLICY, max_total_judge_calls: 0 }, probe: MISS }, { segments: THREE, entities: ENTITIES, lock: LOCK, policy: null, probe: MISS }]) {
    const result = await estimateCoverageBudget(input);
    deepStrictEqual(result.status, "PROBE_FAILED");
  }
});

await test("estimation déterministe : mêmes entrées, mêmes octets, sortie figée", async () => {
  const outputs = await Promise.all([estimate(THREE), estimate(THREE), estimate(THREE)]);
  deepStrictEqual(new Set(outputs.map(output => JSON.stringify(output))).size, 1);
  if (!Object.isFrozen(outputs[0]) || !Object.isFrozen(outputs[0].segments)) throw new Error("sortie modifiable");
});

await test("entrées non modifiées : segments, verrou, entités et politique intacts", async () => {
  const snapshot = JSON.stringify([THREE, LOCK, ENTITIES, POLICY]);
  await estimate(THREE);
  deepStrictEqual(JSON.stringify([THREE, LOCK, ENTITIES, POLICY]), snapshot);
});

await test("aucune tentative réseau", async () => {
  await estimate(THREE);
  deepStrictEqual(networkGuard.attempts().length, 0);
});

// ---------------------------------------------------------------------------
console.log("--- Comparaison au budget restant : seul le minimum bloque ---");

const OK_ESTIMATE = await estimate(THREE);
const status = (cap, used = 0) => ({ configured: true, cap, used });

await test("minimum égal au restant : OK", () => {
  const result = evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(3) });
  deepStrictEqual([result.verdict, result.applicable, result.required, result.remaining, result.maximum], ["OK", true, 3, 3, 36]);
});

await test("minimum supérieur de 1 au restant : INSUFFICIENT", () => {
  const result = evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(2) });
  deepStrictEqual([result.verdict, result.required, result.remaining, result.cap, result.used], ["INSUFFICIENT", 3, 2, 2, 0]);
});

await test("le budget déjà consommé réduit le restant", () => {
  deepStrictEqual(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(10, 8) }).verdict, "INSUFFICIENT");
  deepStrictEqual(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(10, 7) }).verdict, "OK");
});

await test("le maximum n'est jamais bloquant : 36 au maximum, 3 de minimum, plafond 3", () => {
  deepStrictEqual(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(3) }).verdict, "OK");
  deepStrictEqual(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(500) }).maximum, 36);
});

await test("tout en cache : un plafond de 1 suffit, même entièrement consommé", async () => {
  const cached = await estimate(THREE, HIT);
  deepStrictEqual([evaluateCoverageBudget({ estimate: cached, status: status(1) }).verdict, evaluateCoverageBudget({ estimate: cached, status: status(1, 1) }).verdict], ["OK", "OK"]);
});

await test("sans objet : garde non configuré, plafond invalide, estimation non applicable ou en échec → applicable false, OK", async () => {
  const notApplicable = await estimate(THREE, () => ({ applicable: false, reason: "FIXTURES" }));
  const failedProbe = await estimate(THREE, () => null);
  for (const input of [
    { estimate: OK_ESTIMATE, status: { configured: false, cap: null, used: 0 } },
    { estimate: OK_ESTIMATE, status: { configured: true, cap: null, used: 0 } },
    { estimate: OK_ESTIMATE, status: { configured: true, cap: 2.5, used: 0 } },
    { estimate: OK_ESTIMATE, status: undefined },
    { estimate: notApplicable, status: status(1) },
    { estimate: failedProbe, status: status(1) },
    { estimate: undefined, status: status(1) },
    undefined
  ]) {
    deepStrictEqual([evaluateCoverageBudget(input).verdict, evaluateCoverageBudget(input).applicable], ["OK", false]);
  }
});

await test("évaluation déterministe, figée, sans exception", () => {
  const first = JSON.stringify(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(2) }));
  deepStrictEqual(JSON.stringify(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(2) })), first);
  if (!Object.isFrozen(evaluateCoverageBudget({ estimate: OK_ESTIMATE, status: status(2) }))) throw new Error("sortie modifiable");
});

// ---------------------------------------------------------------------------
console.log("--- Mutations (copies hors dépôt) ---");

const tempDirs = [];

async function isolated(replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r29-3-mutant-"));
  tempDirs.push(root);
  let source = fs.readFileSync(new URL("../src/utils/coverage-budget-preflight.js", import.meta.url), "utf8");
  source = source.replace(/from "\.\/([^"]+)"/g, (_, file) => `from ${JSON.stringify(new URL(`../src/utils/${file}`, import.meta.url).href)}`);
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from.slice(0, 70)}`);
    source = source.replace(from, to);
  }
  const file = path.join(root, "coverage-budget-preflight.js");
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

// Comportements surveillés : chaque écart du module doit être détecté.
async function behaviourFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label); };
  const run = (segments, probe = MISS, overrides = {}) => module.estimateCoverageBudget({ segments, entities: ENTITIES, lock: LOCK, policy: POLICY, probe, ...overrides });
  const plain = await run(THREE);
  check("minimum", [plain.status, plain.min_new_calls, plain.max_new_calls], ["OK", 3, 36]);
  const cached = await run(THREE, HIT);
  check("cache ignoré", [cached.min_new_calls, cached.segments_cached_round_1], [0, 3]);
  check("maximum conservé en cache", cached.max_new_calls, 36);
  const none = await run([segment(1, "Imaginez la scène. Pourquoi ?"), segment(2, ""), segment(3, F1)]);
  check("segments sans appel non comptés", [none.min_new_calls, none.segments_no_call], [1, 2]);
  check("maximum limité aux segments qui ont un appel", none.max_new_calls, 12);
  const trap = { version: POLICY.version, max_rounds: 10, get max_total_judge_calls() { throw new Error("piège"); } };
  check("exception contenue", (await run(THREE, MISS, { policy: trap })).status, "PROBE_FAILED");
  const notApplicable = await run(THREE, () => ({ applicable: false, reason: "FIXTURES" }));
  check("sans objet", [notApplicable.status, notApplicable.reason], ["NOT_APPLICABLE", "FIXTURES"]);
  const invalidCache = await run(THREE, () => { throw Object.assign(new Error("x"), { cache_invalid: true }); });
  check("cache invalide qualifié", [invalidCache.status, invalidCache.category], ["PROBE_FAILED", "CACHE_INVALID"]);
  const brokenProbe = await run(THREE, () => { throw new Error("y"); });
  check("échec de sonde qualifié", [brokenProbe.status, brokenProbe.category], ["PROBE_FAILED", "REQUEST_INVALID"]);
  check("jamais d'exception", (await module.estimateCoverageBudget()).status, "PROBE_FAILED");
  const exact = module.evaluateCoverageBudget({ estimate: plain, status: status(3) });
  check("plafond égal au minimum accepté", exact.verdict, "OK");
  check("plafond inférieur au minimum refusé", module.evaluateCoverageBudget({ estimate: plain, status: status(2) }).verdict, "INSUFFICIENT");
  check("maximum jamais bloquant", module.evaluateCoverageBudget({ estimate: plain, status: status(36) }).verdict, "OK");
  check("budget consommé pris en compte", module.evaluateCoverageBudget({ estimate: plain, status: status(10, 8) }).verdict, "INSUFFICIENT");
  check("garde non configuré sans objet", module.evaluateCoverageBudget({ estimate: plain, status: { configured: false, cap: null, used: 0 } }).applicable, false);
  check("sortie figée", Object.isFrozen(plain), true);
  return failures;
}

const MUTATIONS = [
  ["cache ignoré (toujours un appel)", [{ from: "state: cost.cached === true ? BUDGET_SEGMENT_STATE.CACHED_ROUND_1 : BUDGET_SEGMENT_STATE.NEEDS_CALL", to: "state: BUDGET_SEGMENT_STATE.NEEDS_CALL" }]],
  ["maximum bloquant", [{ from: "verdict: estimate.min_new_calls > remaining", to: "verdict: estimate.max_new_calls > remaining" }]],
  ["borne inversée (>= au lieu de >)", [{ from: "verdict: estimate.min_new_calls > remaining", to: "verdict: estimate.min_new_calls >= remaining" }]],
  ["budget consommé ignoré", [{ from: "const remaining = status.cap - status.used;", to: "const remaining = status.cap;" }]],
  ["unités non désignées comptées", [{ from: "  await judgeSegmentCoverageV2({ boundary, lock, claims: segment.claims, segmentId: segment.segment_id, send });\n\n  return captured;", to: "  await judgeSegmentCoverageV2({ boundary, lock, claims: segment.claims, segmentId: segment.segment_id, send });\n\n  return captured ?? { forced: true };" }]],
  ["échec de sonde pris pour une absence", [{ from: "      try {\n        cost = probe(request);\n      } catch (error) {", to: "      try {\n        cost = probe(request);\n      } catch (error) {\n        cost = { applicable: true, cached: false };\n      }\n      try {\n        void 0;\n      } catch (error) {" }]],
  ["sans objet ignoré", [{ from: "      if (cost.applicable !== true) {", to: "      if (false) {" }]],
  ["maximum recalculé sur tous les segments", [{ from: "max_new_calls: (needing + cached) * policy.max_total_judge_calls", to: "max_new_calls: perSegment.length * policy.max_total_judge_calls" }]],
  ["exception propagée", [{ from: "  } catch (error) {\n    return probeFailure(BUDGET_PROBE_CATEGORY.REQUEST_INVALID, error?.message ?? error, null);\n  }\n}", to: "  } catch (error) {\n    throw error;\n  }\n}" }]]
];

await test("mutations : témoin (copie non mutée, hors dépôt) sans aucun écart", async () => {
  deepStrictEqual(await behaviourFailures(await isolated()), []);
});

for (const [name, replacements] of MUTATIONS) {
  await test(`mutation détectée : ${name}`, async () => {
    const module = await isolated(replacements);
    let failures;
    try {
      failures = await behaviourFailures(module);
    } catch (error) {
      failures = [`exception : ${error.message}`];
    }
    if (failures.length === 0) throw new Error("mutant non détecté");
    console.log(`       témoin : ${failures.slice(0, 4).join(", ")}${failures.length > 4 ? ", …" : ""}`);
  });
}

await test("aucune tentative réseau réelle", () => deepStrictEqual(networkGuard.attempts().length, 0));

for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-budget-preflight-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
