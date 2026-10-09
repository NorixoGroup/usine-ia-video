// Smoke R28.10 — intégration de la couverture au pipeline Script (baseline
// v1.0.2, contrats 4.7 et 4.8 ; I20, I24), zéro API. La porte de couverture
// appelle le vrai coordinateur (R28.9) et les vrais modules R28.1 à R28.8A ;
// seul le transport du juge est simulé. Vérifie PASS et NOT_PASS par segment
// et pour le Script, l'appel unique du coordinateur par segment, la
// propagation du verrou, du protocole, du transport et des réparations, la
// politique de relance, l'échec fermé, le retrait du cache des réponses
// rejetées, le checkpoint déterministe dans script.json, le branchement dans
// script.js, et des mutations avec témoin (copies hors dépôt).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/script-coverage-integration-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import {
  SCRIPT_COVERAGE_GATE_VERSION,
  SCRIPT_COVERAGE_STATUS,
  runScriptCoverageGate
} from "../src/utils/script-coverage-gate.js";
import { SCRIPT_COVERAGE_POLICY, buildCoverageLock, researchEntitiesOf } from "../src/utils/coverage-lock-builder.js";
import { coordinateCoverage } from "../src/utils/coverage-coordinator.js";
import { discardRejectedJudgeResponses } from "../src/utils/coverage-judge-executor.js";
import { coverageJudgeV2Version } from "../src/utils/coverage-judge-v2.js";
import { ARCHITECTURE_BASELINE_VERSION, boundaryProtocolIdFromLock, coordinatorLockElement, executorLockElement, lockSha256 } from "../src/utils/coverage-lock.js";
import { coverageUnitSplitterVersion, splitCoverageUnits } from "../src/utils/coverage-unit-splitter.js";
import { coverageProtectionVersion, extractResearchEntities } from "../src/utils/coverage-protection.js";
import { coverageClassificationVersion } from "../src/utils/coverage-classification.js";
import { COVERAGE_REPAIR_VERSION } from "../src/utils/coverage-repair.js";
import { runScriptAgent } from "../src/agents/script.js";
import { runResearchAgent } from "../src/agents/research.js";
import { CANONICAL_PROMPT, CANONICAL_TITLE } from "../src/fixtures/anthropic-dataset.js";
import { getFixtureCallLog } from "../src/fixtures/anthropic.js";

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

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
const HEADER = "SEGMENT A AUDITER :\n\n";
const HEX64 = /^[0-9a-f]{64}$/;

const RESEARCH = Object.freeze({
  key_facts: [
    { claim: "Le désert avance vite dans le centre." },
    { claim: "La ville de Sydney grandit." }
  ]
});

// Script de test : chaque segment est une suite de phrases analysées.
const segmentOf = sentences => ({ voiceover: sentences.join(" "), claims: [{ text: "Le désert avance vite dans le centre." }] });
const scriptOf = sections => ({ sections: sections.map(segments => ({ segments: segments.map(segmentOf) })) });

const S = {
  a: ["Le désert avance vite.", "La côte reste humide."],
  b: ["Le centre est vide.", "Sans lui, l’intérieur serait inhabitable."],
  c: ["Les pluies sont rares.", "Le vent souffle fort."],
  d: ["La terre est rouge.", "Les rivières disparaissent l’été."]
};
const SCRIPT = scriptOf([[S.a, S.b], [S.c]]);

// Transport simulé : décide pour chaque unité désignée à partir de son texte.
// `fail(n)` simule des défaillances du transport à l'appel n.
function transport({ verdict = () => null, fail = () => null, alter = data => data } = {}) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    const failure = fail(calls.length);
    if (failure === "throw") throw new Error("panne réseau");
    const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
    const units = splitCoverageUnits({ voiceover: payload.voiceover, version: coverageUnitSplitterVersion(), language: "fr" }).units;
    const textOf = id => units.find(unit => unit.id === id)?.text.trim() ?? "";
    const data = {
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results: payload.designated_unit_ids.map(unit_id => {
        const operation = verdict(textOf(unit_id), payload);
        return operation ? { unit_id, verdict: "UNCOVERED", operations: [operation] } : { unit_id, verdict: "COVERED", operations: [] };
      })
    };
    const content = failure === "empty" ? [] : [{ type: "text", text: JSON.stringify(alter(data)) }];
    return {
      request_sha256: sha256(request.messages[0].content),
      meta: { stop_reason: "end_turn", output_tokens: 10 },
      response: { content }
    };
  };
  return { fn, calls };
}

const DELETE = { action: "DELETE" };
const MODELS = {
  allCovered: () => null,
  inhabitable: text => (text.includes("inhabitable") ? DELETE : null),
  rare: text => (text.includes("rares") ? DELETE : null),
  everything: () => DELETE,
  declare: text => (text.includes("inhabitable") ? { action: "DECLARE", claim_id: "s1-g2-c1" } : null)
};

// Porte avec coordinateur espion : compte les appels par segment.
function gate({ script = SCRIPT, model = MODELS.allCovered, transportOptions = {}, coordinate = coordinateCoverage, policy, discard } = {}) {
  const t = transport({ verdict: model, ...transportOptions });
  const coordinatorCalls = [];
  const discarded = [];
  const spy = async input => {
    coordinatorCalls.push(input);
    return coordinate(input);
  };
  return runScriptCoverageGate({
    script,
    research: RESEARCH,
    transport: t.fn,
    coordinate: spy,
    discard: discard ?? (hash => discarded.push(hash)),
    ...(policy ? { policy } : {})
  }).then(result => ({ result, calls: t.calls, coordinatorCalls, discarded }));
}

const ENTITIES = researchEntitiesOf(RESEARCH);
const LOCK = buildCoverageLock({ entities: ENTITIES });

// ---------------------------------------------------------------------------

await test("constantes publiques : version de la porte, politique versionnée, statuts", () => {
  deepStrictEqual(SCRIPT_COVERAGE_GATE_VERSION, "script-coverage-gate.v1");
  deepStrictEqual({ ...SCRIPT_COVERAGE_POLICY }, { version: "coverage-coordinator-policy.v1", max_rounds: 10, max_total_judge_calls: 12 });
  deepStrictEqual(Object.values(SCRIPT_COVERAGE_STATUS), ["PASS", "NOT_PASS"]);
  if (!Object.isFrozen(SCRIPT_COVERAGE_POLICY)) throw new Error("politique modifiable");
});

await test("verrou reconstruit : 13 champs, versions courantes des composants", () => {
  deepStrictEqual(clone(LOCK), {
    splitter: coverageUnitSplitterVersion(),
    normalization: "coverage-normalization.v1",
    protection: coverageProtectionVersion(),
    entities_rule_version: "research-entities.v1",
    entities_fingerprint: ENTITIES.fingerprint,
    classification: coverageClassificationVersion(),
    judge: coverageJudgeV2Version(),
    repair: COVERAGE_REPAIR_VERSION,
    applier: "coverage-delete-applier.v1",
    coordinator: coordinatorLockElement({ policy: { version: "coverage-coordinator-policy.v1", max_rounds: 10, max_total_judge_calls: 12 }, coordinatorVersion: "coverage-coordinator.v1" }),
    executor: executorLockElement({ executorVersion: "coverage-judge-executor.v1", limits: { max_request_chars: 16000, max_tokens: 4000, max_response_chars: 16000, timeout_ms: 120000 } }),
    language: "fr",
    baseline: ARCHITECTURE_BASELINE_VERSION
  });
});

await test("verrou reconstruit : déterministe et figé", () => {
  deepStrictEqual(JSON.stringify(buildCoverageLock({ entities: ENTITIES })), JSON.stringify(LOCK));
  if (!Object.isFrozen(LOCK)) throw new Error("verrou modifiable");
});

await test("verrou reconstruit : la politique fixe l'élément 10 (version et bornes)", () => {
  deepStrictEqual(buildCoverageLock({ entities: ENTITIES, policy: { version: "autre" } }).coordinator, coordinatorLockElement({ policy: { version: "autre" }, coordinatorVersion: "coverage-coordinator.v1" }));
  if (buildCoverageLock({ entities: ENTITIES, policy: { version: "coverage-coordinator-policy.v1", max_rounds: 11, max_total_judge_calls: 12 } }).coordinator === LOCK.coordinator) throw new Error("bornes non verrouillées");
});

await test("entités Research : règle de Protection appliquée aux key_facts", () => {
  deepStrictEqual(clone(ENTITIES), clone(extractResearchEntities({ keyFacts: RESEARCH.key_facts.map(fact => fact.claim), ruleVersion: "research-entities.v1" })));
  deepStrictEqual([...ENTITIES.entities], ["sydney"]);
});

await test("entités Research : dossier absent ou sans key_facts → liste vide valide", () => {
  for (const research of [undefined, {}, { key_facts: null }]) deepStrictEqual([...researchEntitiesOf(research).entities], []);
});

const NOMINAL = await gate();

await test("Script PASS : tous les segments PASS", () => {
  deepStrictEqual([NOMINAL.result.status, NOMINAL.result.failure, NOMINAL.result.segments.length], ["PASS", null, 3]);
});

await test("segment PASS : une ronde, aucune réparation", () => {
  for (const segment of NOMINAL.result.segments) deepStrictEqual([segment.status, segment.covered, segment.rounds, segment.repair_count], ["PASS", true, 1, 0]);
});

await test("coordinateur appelé exactement une fois par segment, dans l'ordre", () => {
  deepStrictEqual(NOMINAL.coordinatorCalls.map(call => call.segment.segment_id), ["s1-g1", "s1-g2", "s2-g1"]);
});

await test("entrées du coordinateur : segment_id, voiceover, claims, entités, verrou, transport, politique, rien d'autre", () => {
  for (const call of NOMINAL.coordinatorCalls) {
    deepStrictEqual(Object.keys(call), ["segment", "claims", "lock", "transport", "policy"]);
    deepStrictEqual(Object.keys(call.segment), ["segment_id", "voiceover", "entities"]);
    if (typeof call.transport !== "function") throw new Error("transport absent");
  }
});

await test("voiceover et claims transmis tels quels", () => {
  deepStrictEqual(NOMINAL.coordinatorCalls.map(call => call.segment.voiceover), [S.a.join(" "), S.b.join(" "), S.c.join(" ")]);
  deepStrictEqual(clone(NOMINAL.coordinatorCalls[0].claims), clone(SCRIPT.sections[0].segments[0].claims));
});

await test("verrou propagé : le même verrou complet à chaque segment", () => {
  for (const call of NOMINAL.coordinatorCalls) deepStrictEqual(clone(call.lock), clone(LOCK));
});

await test("verrou propagé : lock_sha256 des segments et du Script = empreinte du verrou complet", () => {
  for (const segment of NOMINAL.result.segments) deepStrictEqual(segment.lock_sha256, lockSha256(LOCK));
  deepStrictEqual(NOMINAL.result.lock_sha256, lockSha256(LOCK));
});

await test("protocole propagé : protocol_id des segments et du Script", () => {
  for (const segment of NOMINAL.result.segments) deepStrictEqual(segment.protocol_id, boundaryProtocolIdFromLock(LOCK));
  deepStrictEqual(NOMINAL.result.protocol_id, boundaryProtocolIdFromLock(LOCK));
});

await test("politique propagée : la politique versionnée à chaque segment", () => {
  for (const call of NOMINAL.coordinatorCalls) deepStrictEqual({ ...call.policy }, { ...SCRIPT_COVERAGE_POLICY });
  deepStrictEqual(NOMINAL.result.policy_version, SCRIPT_COVERAGE_POLICY.version);
});

await test("transport propagé : le transport injecté reçoit les requêtes du juge", () => {
  deepStrictEqual(NOMINAL.calls.length, 3);
  for (const request of NOMINAL.calls) {
    if (!request.messages[0].content.startsWith(HEADER)) throw new Error("requête hors protocole v2");
    deepStrictEqual([request.maxTokens, request.temperature], [2000, 0]);
  }
});

await test("aucun appel au juge en double : un appel par segment et par ronde", () => {
  deepStrictEqual(NOMINAL.calls.map(request => JSON.parse(request.messages[0].content.slice(HEADER.length)).segment_id), ["s1-g1", "s1-g2", "s2-g1"]);
});

await test("checkpoint : empreinte du voiceover final de chaque segment", () => {
  deepStrictEqual(NOMINAL.result.segments.map(segment => segment.voiceover_sha256), [sha256(S.a.join(" ")), sha256(S.b.join(" ")), sha256(S.c.join(" "))]);
});

await test("checkpoint : champs exacts, sans texte libre ni réponse brute", () => {
  for (const segment of NOMINAL.result.segments) {
    deepStrictEqual(Object.keys(segment), ["status", "covered", "undeclared_claims", "protocol_id", "lock_sha256", "voiceover_sha256", "rounds", "repair_count"]);
    deepStrictEqual(segment.undeclared_claims.length, 0);
  }
  const serialized = JSON.stringify(NOMINAL.result.segments);
  for (const forbidden of [S.a[0], "response", "content", "verdict", "operations", "repaired_voiceover"]) {
    if (serialized.includes(forbidden)) throw new Error(`checkpoint contient : ${forbidden}`);
  }
});

await test("sortie de la porte : structure figée et immuable", () => {
  deepStrictEqual(Object.keys(NOMINAL.result), ["version", "status", "baseline", "policy_version", "lock_sha256", "protocol_id", "segments", "failure", "final_voiceovers", "discarded_request_sha256s", "discard_failed_request_sha256s", "budget_preflight"]);
  if (!Object.isFrozen(NOMINAL.result) || !Object.isFrozen(NOMINAL.result.segments) || !NOMINAL.result.segments.every(Object.isFrozen)) throw new Error("sortie modifiable");
});

await test("checkpoint déterministe : octets identiques, indépendamment de l'historique", async () => {
  const first = JSON.stringify((await gate()).result);
  await gate({ model: MODELS.declare });
  for (let round = 0; round < 3; round += 1) deepStrictEqual(JSON.stringify((await gate()).result), first);
});

await test("entrées non modifiées : script et dossier Research intacts", async () => {
  const script = clone(SCRIPT);
  const research = clone(RESEARCH);
  const snapshot = JSON.stringify([script, research]);
  await runScriptCoverageGate({ script, research, transport: transport({ verdict: MODELS.inhabitable }).fn, discard: () => {} });
  deepStrictEqual(JSON.stringify([script, research]), snapshot);
});

const REPAIRED = await gate({ model: MODELS.inhabitable });

await test("réparation propagée : segment réparé PASS en deux rondes, une unité supprimée", () => {
  const segment = REPAIRED.result.segments[1];
  deepStrictEqual([REPAIRED.result.status, segment.status, segment.rounds, segment.repair_count], ["PASS", "PASS", 2, 1]);
});

await test("réparation propagée : voiceover final renvoyé à l'appelant, sans texte ajouté", () => {
  const item = REPAIRED.result.final_voiceovers[1];
  deepStrictEqual([item.section_index, item.segment_index, item.voiceover], [0, 1, S.b[0]]);
  deepStrictEqual(REPAIRED.result.segments[1].voiceover_sha256, sha256(S.b[0]));
});

await test("réparation propagée : segments non réparés inchangés", () => {
  deepStrictEqual([REPAIRED.result.final_voiceovers[0].voiceover, REPAIRED.result.final_voiceovers[2].voiceover], [S.a.join(" "), S.c.join(" ")]);
});

await test("réparation propagée : un appel par ronde (4 appels pour 3 segments)", () => {
  deepStrictEqual([REPAIRED.calls.length, REPAIRED.coordinatorCalls.length], [4, 3]);
});

const DECLARED = await gate({ model: MODELS.declare });

await test("segment NOT_PASS : Script NOT_PASS, raison et catégorie fermées", () => {
  deepStrictEqual(clone(DECLARED.result.failure), { segment_id: "s1-g2", label: "sections[0].segments[1]", reason: "REPAIR_REFUSED", category: "DECLARE_NOT_SUPPORTED", unit_ids: ["u2"], detail: null });
  deepStrictEqual(DECLARED.result.status, "NOT_PASS");
});

await test("échec fermé : arrêt au premier NOT_PASS, segments suivants jamais évalués", () => {
  deepStrictEqual([DECLARED.coordinatorCalls.length, DECLARED.result.segments.length, DECLARED.result.segments.at(-1).status], [2, 2, "NOT_PASS"]);
});

await test("échec fermé : aucun voiceover final renvoyé sur NOT_PASS", () => {
  deepStrictEqual(DECLARED.result.final_voiceovers.length, 0);
});

await test("échec fermé : NOT_REPAIRABLE → Script NOT_PASS", async () => {
  const { result } = await gate({ model: MODELS.everything });
  deepStrictEqual([result.status, result.failure.reason, result.failure.segment_id], ["NOT_PASS", "NOT_REPAIRABLE", "s1-g1"]);
});

for (const position of [0, 1, 2, 3, 4]) {
  await test(`Script NOT_PASS si le segment ${position + 1} sur 5 échoue ; évaluation arrêtée là`, async () => {
    const sections = [[S.a, S.a, S.a, S.a, S.a]];
    sections[0][position] = S.b;
    const { result, coordinatorCalls } = await gate({ script: scriptOf(sections), model: MODELS.declare });
    deepStrictEqual([result.status, result.failure.segment_id, coordinatorCalls.length], ["NOT_PASS", `s1-g${position + 1}`, position + 1]);
  });
}

for (const count of [1, 2, 4, 6]) {
  await test(`Script PASS avec ${count} segment(s) tous PASS`, async () => {
    const { result, coordinatorCalls } = await gate({ script: scriptOf([Array.from({ length: count }, () => S.c)]) });
    deepStrictEqual([result.status, result.segments.length, coordinatorCalls.length], ["PASS", count, count]);
  });
}

await test("plusieurs sections : identifiants s<section>-g<segment>", async () => {
  const { result, coordinatorCalls } = await gate({ script: scriptOf([[S.a], [S.c, S.d], [S.a]]) });
  deepStrictEqual([result.segments.length, coordinatorCalls.map(call => call.segment.segment_id)], [4, ["s1-g1", "s2-g1", "s2-g2", "s3-g1"]]);
});

await test("script sans segment → NOT_PASS (NO_SEGMENT), jamais un PASS vide", async () => {
  for (const script of [{ sections: [] }, {}, null]) {
    const { result, coordinatorCalls } = await gate({ script });
    deepStrictEqual([result.status, result.failure.reason, coordinatorCalls.length], ["NOT_PASS", "NO_SEGMENT", 0]);
  }
});

for (const [name, segment] of [
  ["voiceover vide", { voiceover: "", claims: [{ text: "Le désert avance vite dans le centre." }] }],
  ["voiceover absent", { claims: [{ text: "Le désert avance vite dans le centre." }] }],
  ["segment nul", null]
]) {
  await test(`segment vide (${name}) → NOT_PASS dès ce segment, aucun appel au juge, segments suivants non évalués`, async () => {
    const script = { sections: [{ segments: [segment, segmentOf(S.a)] }] };
    const { result, calls, coordinatorCalls } = await gate({ script });
    deepStrictEqual([result.status, result.failure.segment_id, calls.length, coordinatorCalls.length, result.final_voiceovers.length], ["NOT_PASS", "s1-g1", 0, 1, 0]);
    deepStrictEqual([result.lock_sha256, result.protocol_id], [lockSha256(LOCK), boundaryProtocolIdFromLock(LOCK)]);
  });
}

await test("politique de relance : un échec du transport puis succès → PASS", async () => {
  const { result, calls } = await gate({ transportOptions: { fail: n => (n === 1 ? "throw" : null) } });
  deepStrictEqual([result.status, calls.length], ["PASS", 4]);
});

await test("politique de relance : budget épuisé → NOT_PASS, nombre d'appels borné par la politique", async () => {
  const { result, calls } = await gate({ transportOptions: { fail: () => "throw" } });
  deepStrictEqual([result.status, result.failure.reason, calls.length], ["NOT_PASS", "JUDGE_BUDGET_EXHAUSTED", SCRIPT_COVERAGE_POLICY.max_total_judge_calls]);
});

await test("politique de relance : réponse vide jamais relancée", async () => {
  const { result, calls } = await gate({ transportOptions: { fail: () => "empty" } });
  deepStrictEqual([result.status, result.failure.reason, result.failure.category, calls.length], ["NOT_PASS", "JUDGE_NOT_JUDGED", "EMPTY_RESPONSE", 1]);
});

await test("politique de relance : réponse hors protocole jamais relancée", async () => {
  const { result, calls } = await gate({ transportOptions: { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) } });
  deepStrictEqual([result.status, result.failure.reason, calls.length], ["NOT_PASS", "JUDGE_NOT_JUDGED", 1]);
});

await test("politique de relance : politique d'une seule ronde → réparation non rejugée refusée", async () => {
  const { result } = await gate({ model: MODELS.inhabitable, policy: { ...SCRIPT_COVERAGE_POLICY, max_rounds: 1 } });
  deepStrictEqual([result.status, result.failure.reason], ["NOT_PASS", "MAX_ROUNDS_REACHED"]);
});

await test("politique invalide → NOT_PASS, aucun appel", async () => {
  const { result, calls } = await gate({ policy: { version: "x", max_rounds: 0, max_total_judge_calls: 1 } });
  deepStrictEqual([result.status, result.failure.reason, calls.length], ["NOT_PASS", "POLICY_INVALID", 0]);
});

// Retrait du cache des réponses rejetées (contrat 4.8).

await test("réponse rejetée par le juge : retirée du cache par l'exécuteur", async () => {
  const { result, calls, discarded } = await gate({ transportOptions: { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) } });
  deepStrictEqual(discarded, [sha256(calls[0].messages[0].content)]);
  deepStrictEqual([...result.discarded_request_sha256s], discarded);
});

await test("réponse rejetée par l'exécuteur (vide) : retirée du cache", async () => {
  const { calls, discarded } = await gate({ transportOptions: { fail: () => "empty" } });
  deepStrictEqual(discarded, [sha256(calls[0].messages[0].content)]);
});

await test("réponses acceptées jamais retirées du cache", () => {
  deepStrictEqual([NOMINAL.discarded.length, REPAIRED.discarded.length, NOMINAL.result.discarded_request_sha256s.length], [0, 0, 0]);
});

await test("réponse acceptée puis réparation refusée (DECLARE) : la réponse reste en cache (I25)", () => {
  deepStrictEqual(DECLARED.discarded.length, 0);
});

await test("rejeu d'une réponse rejetée impossible : la requête rejouée repart vers le transport", async () => {
  const cache = new Map();
  const real = transport({ alter: data => ({ ...data, protocol_id: "0".repeat(64) }) });
  let transportHits = 0;
  const cached = async request => {
    const key = sha256(request.messages[0].content);
    if (cache.has(key)) return cache.get(key);
    transportHits += 1;
    const reply = await real.fn(request);
    cache.set(key, reply);
    return reply;
  };
  const discard = hash => cache.delete(hash);
  const once = () => runScriptCoverageGate({ script: SCRIPT, research: RESEARCH, transport: cached, discard });
  const first = await once();
  const second = await once();
  deepStrictEqual([first.status, second.status, transportHits, cache.size], ["NOT_PASS", "NOT_PASS", 2, 0]);
});

await test("rejeu d'une réponse acceptée : servie par le cache, aucun nouvel appel (I25)", async () => {
  const cache = new Map();
  const real = transport();
  let transportHits = 0;
  const cached = async request => {
    const key = sha256(request.messages[0].content);
    if (cache.has(key)) return cache.get(key);
    transportHits += 1;
    const reply = await real.fn(request);
    cache.set(key, reply);
    return reply;
  };
  const once = () => runScriptCoverageGate({ script: SCRIPT, research: RESEARCH, transport: cached, discard: hash => cache.delete(hash) });
  const first = await once();
  const second = await once();
  deepStrictEqual([first.status, second.status, transportHits, JSON.stringify(first) === JSON.stringify(second)], ["PASS", "PASS", 3, true]);
});

await test("exécuteur : retrait dédoublonné, trié, empreintes invalides ignorées", () => {
  const removed = [];
  const result = discardRejectedJudgeResponses({ requestSha256s: ["b".repeat(64), "a".repeat(64), "b".repeat(64), "xyz", null], discard: hash => removed.push(hash) });
  deepStrictEqual([removed, [...result.discarded], [...result.skipped]], [["a".repeat(64), "b".repeat(64)], ["a".repeat(64), "b".repeat(64)], []]);
});

await test("exécuteur : sans fonction de retrait, rien n'est retiré et tout est signalé", () => {
  const result = discardRejectedJudgeResponses({ requestSha256s: ["a".repeat(64)] });
  deepStrictEqual([[...result.discarded], [...result.skipped]], [[], ["a".repeat(64)]]);
});

await test("exécuteur : une erreur de retrait est signalée, jamais propagée", () => {
  const result = discardRejectedJudgeResponses({ requestSha256s: ["a".repeat(64)], discard: () => { throw new Error("disque"); } });
  deepStrictEqual([[...result.discarded], [...result.skipped]], [[], ["a".repeat(64)]]);
});

await test("exécuteur : entrée absente → aucun retrait", () => {
  deepStrictEqual([...discardRejectedJudgeResponses().discarded], []);
});

await test("échec fermé : coordinateur qui lève → NOT_PASS UNEXPECTED, jamais d'exception", async () => {
  const { result } = await gate({ coordinate: async () => { throw new Error("panne"); } });
  deepStrictEqual([result.status, result.failure.reason, result.failure.segment_id], ["NOT_PASS", "UNEXPECTED", "s1-g1"]);
});

for (const [name, output] of [
  ["sortie nulle", null],
  ["sortie sans statut de segment", { script_status: "PASS", history: [] }],
  ["statut de Script PASS mais segment NOT_PASS", { script_status: "PASS", segment_status: { status: "NOT_PASS" }, history: [], final_voiceover: "x" }],
  ["statut de segment inconnu", { script_status: "DONE", segment_status: { status: "DONE" }, history: [], final_voiceover: "x" }]
]) {
  await test(`échec fermé : coordinateur incohérent (${name}) → jamais PASS`, async () => {
    const { result } = await gate({ coordinate: async () => output });
    deepStrictEqual(result.status, "NOT_PASS");
  });
}

await test("verrou : un changement du dossier Research change l'empreinte des entités, le verrou et le protocole", async () => {
  const other = { key_facts: [{ claim: "La ville de Perth grandit." }] };
  const { result } = await gate();
  const t = transport();
  const changed = await runScriptCoverageGate({ script: SCRIPT, research: other, transport: t.fn, discard: () => {} });
  if (changed.lock_sha256 === result.lock_sha256 || changed.protocol_id === result.protocol_id) throw new Error("verrou insensible aux entités");
});

await test("segment PASS : segment_id du juge = segment_id de la porte", () => {
  deepStrictEqual(NOMINAL.calls.map(request => JSON.parse(request.messages[0].content.slice(HEADER.length)).segment_id), NOMINAL.coordinatorCalls.map(call => call.segment.segment_id));
});

await test("segment PASS : verrou et protocole envoyés au juge = ceux du checkpoint", () => {
  for (const request of NOMINAL.calls) {
    const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
    deepStrictEqual([payload.lock_sha256, payload.protocol_id], [NOMINAL.result.lock_sha256, NOMINAL.result.protocol_id]);
  }
});

await test("réparation : le voiceover rejugé est le voiceover réparé (aucun rejeu de la requête initiale)", () => {
  const payloads = REPAIRED.calls.map(request => JSON.parse(request.messages[0].content.slice(HEADER.length)));
  const rounds = payloads.filter(payload => payload.segment_id === "s1-g2");
  deepStrictEqual(rounds.map(payload => payload.voiceover), [S.b.join(" "), S.b[0]]);
  deepStrictEqual(new Set(REPAIRED.calls.map(request => request.messages[0].content)).size, REPAIRED.calls.length);
});

await test("relance : la requête relancée est identique (même empreinte), la réponse acceptée n'est pas retirée", async () => {
  const { calls, discarded } = await gate({ transportOptions: { fail: n => (n === 1 ? "throw" : null) } });
  deepStrictEqual([calls[0].messages[0].content === calls[1].messages[0].content, discarded.length], [true, 0]);
});

await test("NOT_PASS : checkpoint du segment en échec complet (statut, verrou, protocole, empreinte)", () => {
  const segment = DECLARED.result.segments.at(-1);
  deepStrictEqual([segment.status, segment.covered, HEX64.test(segment.lock_sha256), HEX64.test(segment.protocol_id), HEX64.test(segment.voiceover_sha256)], ["NOT_PASS", false, true, true, true]);
});

await test("NOT_PASS : verrou et protocole du Script conservés", () => {
  deepStrictEqual([DECLARED.result.lock_sha256, DECLARED.result.protocol_id], [lockSha256(LOCK), boundaryProtocolIdFromLock(LOCK)]);
});

// Branchement dans le pipeline Script (script.js).

const SCRIPT_SOURCE = fs.readFileSync(new URL("../src/agents/script.js", import.meta.url), "utf8");
const validateGenerated = SCRIPT_SOURCE.slice(SCRIPT_SOURCE.indexOf("async function validateGeneratedScript"), SCRIPT_SOURCE.indexOf("async function runSegmentedScriptAgent"));

await test("script.js : la couverture passe uniquement par la porte (aucun appel direct à l'ancien juge ni au coordinateur)", () => {
  if (!validateGenerated.includes("runScriptCoverageGate(")) throw new Error("porte absente");
  for (const forbidden of ["validateScriptClaimCoverage(", "convergeCoverageRepair(", "coordinateCoverage(", "judgeSegmentCoverageV2(", "planCoverageRepair(", "applyCoverageDeletePlan(", "composeCoverageBoundary("]) {
    if (validateGenerated.includes(forbidden)) throw new Error(`appel direct : ${forbidden}`);
  }
});

await test("script.js : la couverture ne met plus aucun chapitre en quarantaine (D1, I24)", () => {
  const line = SCRIPT_SOURCE.split("\n").find(text => text.startsWith("const ATTRIBUTABLE_GATES"));
  if (!line || line.includes("Coverage")) throw new Error(`quarantaine de couverture présente : ${line}`);
});

await test("script.js : NOT_PASS renvoyé en résultat structuré, jamais converti en PASS", () => {
  if (!validateGenerated.includes('coverage.status !== "PASS"') || !validateGenerated.includes("protocol_outcome")) throw new Error("NOT_PASS non propagé");
});

// Pipeline complet en mode fixtures (moteur de fixtures, sans réseau).
process.env.ANTHROPIC_FIXTURES = "1";
const fixtureResearch = (await runResearchAgent({ title: CANONICAL_TITLE, prompt: CANONICAL_PROMPT, testMode: true })).data;
const runFixture = async scenario => {
  process.env.ANTHROPIC_FIXTURE_SCENARIO = scenario;
  const start = getFixtureCallLog().length;
  const result = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
  const coverageCalls = getFixtureCallLog().slice(start).filter(entry => entry.fixture_id === "validate-script-claim-coverage").length;
  return { result, coverageCalls };
};

const HAPPY = await runFixture("happy");
const FIX_REPAIR = await runFixture("script-coverage-repair");
const FIX_DECLARE = await runFixture("script-coverage-unrepairable");
const FIX_EMPTY = await runFixture("script-coverage-empty");
delete process.env.ANTHROPIC_FIXTURE_SCENARIO;
delete process.env.ANTHROPIC_FIXTURES;

await test("pipeline (fixtures) : Script PASS, couverture dans claim_coverage_validation", () => {
  const coverage = HAPPY.result.claim_coverage_validation;
  deepStrictEqual([coverage.valid, coverage.status, coverage.segments.length, HAPPY.coverageCalls], [true, "PASS", 2, 2]);
});

await test("pipeline (fixtures) : checkpoint script.json compatible avec le rapport qualité (covered, undeclared_claims)", () => {
  for (const segment of HAPPY.result.claim_coverage_validation.segments) deepStrictEqual([segment.covered, segment.undeclared_claims.length], [true, 0]);
  deepStrictEqual(HAPPY.result.claim_coverage_validation.errors.length, 0);
});

await test("pipeline (fixtures) : verrou et protocole dans le checkpoint, seules métadonnées autorisées (D8)", () => {
  const coverage = HAPPY.result.claim_coverage_validation;
  if (!HEX64.test(coverage.lock_sha256) || !HEX64.test(coverage.protocol_id)) throw new Error("empreintes absentes");
  deepStrictEqual(Object.keys(coverage), ["valid", "errors", "status", "protocol_id", "lock_sha256", "lock", "segments"]);
  for (const segment of coverage.segments) {
    deepStrictEqual(Object.keys(segment), ["status", "covered", "undeclared_claims", "protocol_id", "lock_sha256", "voiceover_sha256", "rounds", "repair_count"]);
  }
});

await test("pipeline (fixtures) : checkpoint sans réponse brute ni texte de réparation", () => {
  const serialized = JSON.stringify(HAPPY.result.claim_coverage_validation);
  for (const forbidden of ["response", "\"content\"", "results", "operations", "L'eau y est rare"]) {
    if (serialized.includes(forbidden)) throw new Error(`checkpoint contient : ${forbidden}`);
  }
});

await test("pipeline (fixtures) : réparation appliquée au script, segment rejugé", () => {
  const segment = FIX_REPAIR.result.claim_coverage_validation.segments[0];
  deepStrictEqual([segment.repair_count, segment.rounds, FIX_REPAIR.coverageCalls], [1, 2, 3]);
  if (FIX_REPAIR.result.data.sections[0].segments[0].voiceover.includes("L'eau y est rare.")) throw new Error("unité non supprimée");
  deepStrictEqual(sha256(FIX_REPAIR.result.data.sections[0].segments[0].voiceover), segment.voiceover_sha256);
});

await test("pipeline (fixtures) : NOT_PASS (DECLARE) → protocol_outcome, aucun script publiable", () => {
  deepStrictEqual([FIX_DECLARE.result.protocol_outcome.status, FIX_DECLARE.result.protocol_outcome.reason, "data" in FIX_DECLARE.result], ["NOT_PASS", "REPAIR_REFUSED", false]);
});

await test("pipeline (fixtures) : NOT_PASS (NOT_REPAIRABLE) → arrêt dès le premier segment", () => {
  deepStrictEqual([FIX_EMPTY.result.protocol_outcome.reason, FIX_EMPTY.result.protocol_outcome.segment_id, FIX_EMPTY.result.claim_coverage_validation.segments.length, FIX_EMPTY.coverageCalls], ["NOT_REPAIRABLE", "s1-g1", 1, 1]);
});

await test("pipeline (fixtures) : NOT_PASS → claim_coverage_validation.valid = false", () => {
  for (const run of [FIX_DECLARE, FIX_EMPTY]) deepStrictEqual([run.result.claim_coverage_validation.valid, run.result.claim_coverage_validation.status], [false, "NOT_PASS"]);
});

await test("pipeline (fixtures) : déterministe sur deux exécutions", async () => {
  process.env.ANTHROPIC_FIXTURES = "1";
  process.env.ANTHROPIC_FIXTURE_SCENARIO = "happy";
  try {
    const again = await runScriptAgent({ research: fixtureResearch, title: CANONICAL_TITLE, testMode: true });
    deepStrictEqual(JSON.stringify(again.claim_coverage_validation), JSON.stringify(HAPPY.result.claim_coverage_validation));
  } finally {
    delete process.env.ANTHROPIC_FIXTURE_SCENARIO;
    delete process.env.ANTHROPIC_FIXTURES;
  }
});

await test("imports de la porte : composants de couverture (versions, coordinateur, retrait), cache et transport existants", () => {
  const source = fs.readFileSync(new URL("../src/utils/script-coverage-gate.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")).map(line => line.replace(/^import .* from /, "")), [
    '"../services/anthropic.js";',
    '"../services/call-guard.js";',
    '"./coverage-budget-preflight.js";',
    '"./coverage-lock.js";',
    '"./coverage-lock-builder.js";',
    '"./coverage-judge-executor.js";',
    '"./coverage-coordinator.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["splitCoverageUnits(", "normalizeCoverageText(", "protectCoverageUnit(", "classifyCoverageUnit(", "judgeSegmentCoverageV2(", "planCoverageRepair(", "applyCoverageDeletePlan(", "composeCoverageBoundary(", "writeFile", "fetch("]) {
    if (code.includes(forbidden)) throw new Error(`logique directe interdite : ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Mutations : copies hors dépôt de la porte, modules réels importés par chemin.

async function isolatedGate(prefix, replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let source = fs.readFileSync(new URL("../src/utils/script-coverage-gate.js", import.meta.url), "utf8");
  for (const relative of ["../services/anthropic.js", "../services/call-guard.js", "./coverage-budget-preflight.js", "./coverage-lock.js", "./coverage-lock-builder.js", "./coverage-judge-executor.js", "./coverage-coordinator.js"]) {
    source = source.replace(`"${relative}"`, JSON.stringify(pathToFileURL(new URL(relative.startsWith("../") ? `../src/${relative.slice(3)}` : `../src/utils/${relative.slice(2)}`, import.meta.url).pathname).href));
  }
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from.slice(0, 60)}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(root, "script-coverage-gate.js"), source);
  const module = await import(pathToFileURL(path.join(root, "script-coverage-gate.js")).href);
  return { root, module };
}

async function behaviourFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  const run = async (model, options = {}) => {
    const t = transport({ verdict: model, ...(options.transportOptions ?? {}) });
    const coordinatorCalls = [];
    const discarded = [];
    const guard = new Promise(resolve => setTimeout(() => resolve({ status: "BLOQUÉ", segments: [] }), 4000));
    try {
      const result = await Promise.race([module.runScriptCoverageGate({
        script: options.script ?? SCRIPT,
        research: RESEARCH,
        transport: t.fn,
        coordinate: async input => { coordinatorCalls.push(input); return coordinateCoverage(input); },
        discard: hash => discarded.push(hash)
      }), guard]);
      return { result, calls: t.calls.length, coordinatorCalls: coordinatorCalls.length, discarded: discarded.length };
    } catch (error) {
      return { result: { status: "EXCEPTION", error: error.message, segments: [] }, calls: t.calls.length, coordinatorCalls: coordinatorCalls.length, discarded: discarded.length };
    }
  };
  const nominal = await run(MODELS.allCovered);
  check("Script PASS", nominal.result.status, "PASS");
  check("un coordinateur par segment", nominal.coordinatorCalls, 3);
  check("checkpoint complet", nominal.result.segments?.map(segment => [segment.status, HEX64.test(segment.lock_sha256 ?? ""), HEX64.test(segment.protocol_id ?? ""), segment.rounds]), [["PASS", true, true, 1], ["PASS", true, true, 1], ["PASS", true, true, 1]]);
  check("protocole conservé", nominal.result.protocol_id, boundaryProtocolIdFromLock(LOCK));
  check("verrou conservé", nominal.result.lock_sha256, lockSha256(LOCK));
  const declared = await run(MODELS.declare);
  check("NOT_PASS conservé", [declared.result.status, declared.coordinatorCalls], ["NOT_PASS", 2]);
  const retried = await run(MODELS.allCovered, { transportOptions: { fail: n => (n === 1 ? "throw" : null) } });
  check("relance", [retried.result.status, retried.calls], ["PASS", 4]);
  const exhausted = await run(MODELS.allCovered, { transportOptions: { fail: () => "throw" } });
  check("relances bornées", [exhausted.result.status, exhausted.calls], ["NOT_PASS", 12]);
  const rejected = await run(MODELS.allCovered, { transportOptions: { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) } });
  check("réponse rejetée retirée", rejected.discarded, 1);
  return failures;
}

const MUTATIONS = [
  ["couverture contournée", [{ from: "      result = await coordinate({", to: "      result = { script_status: \"PASS\", segment_status: { status: \"PASS\" }, history: [], final_voiceover: entry.segment?.voiceover, rounds: 0 }; void ({" }]],
  ["coordinateur sauté (premier segment)", [{ from: "    for (const entry of failure ? [] : all) {", to: "    for (const entry of failure ? [] : all.slice(1)) {" }]],
  ["PASS forcé", [{ from: "    status: failure ? SCRIPT_COVERAGE_STATUS.NOT_PASS : SCRIPT_COVERAGE_STATUS.PASS,", to: "    status: SCRIPT_COVERAGE_STATUS.PASS," }]],
  ["NOT_PASS ignoré", [{ from: "      if (!passed) failure = failureOf(entry, result, segmentRefusals);", to: "      void passed;" }]],
  ["checkpoint incomplet", [{ from: "    lock_sha256: result.lock_sha256 ?? lockSha256,\n", to: "" }]],
  ["protocole perdu", [{ from: "    protocol_id: protocolId,\n    segments,", to: "    protocol_id: null,\n    segments," }]],
  ["verrou perdu", [{ from: "    lock_sha256: lockSha256,\n    protocol_id: protocolId,", to: "    lock_sha256: null,\n    protocol_id: protocolId," }]],
  ["relance ignorée", [{ from: "          transport: recordingTransport,\n          policy\n", to: "          transport: recordingTransport,\n          policy: { ...policy, max_total_judge_calls: 1 }\n" }]],
  ["relances infinies", [{ from: "          transport: recordingTransport,\n          policy\n", to: "          transport: recordingTransport,\n          policy: { ...policy, max_total_judge_calls: 100000 }\n" }]],
  ["coordinateur appelé deux fois", [{ from: "        result = await coordinate({", to: "        await coordinate({ segment: { segment_id: entry.segment_id, voiceover: entry.segment?.voiceover, entities }, claims: entry.segment?.claims, lock, transport: recordingTransport, policy });\n        result = await coordinate({" }]],
  ["réponses rejetées rejouables", [{ from: "requestSha256s: seenRequests.filter(hash => !accepted.has(hash)),", to: "requestSha256s: []," }]]
];

await test("mutations : témoin (copie hors dépôt non mutée) sans aucun écart", async () => {
  const control = await isolatedGate("r28-10-control-");
  try {
    deepStrictEqual(await behaviourFailures(control.module), []);
  } finally {
    fs.rmSync(control.root, { recursive: true, force: true });
  }
});

for (const [name, replacements] of MUTATIONS) {
  await test(`mutation détectée : ${name}`, async () => {
    const mutant = await isolatedGate("r28-10-mutant-", replacements);
    try {
      const failures = await behaviourFailures(mutant.module);
      if (failures.length === 0) throw new Error("mutant non détecté");
      console.log(`       témoin : ${failures.join(", ")}`);
    } finally {
      fs.rmSync(mutant.root, { recursive: true, force: true });
    }
  });
}

await test("aucune tentative réseau réelle", () => deepStrictEqual(networkGuard.attempts().length, 0));

const networkAttempts = networkGuard.attempts().length;

console.log(`\nscript-coverage-integration-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
