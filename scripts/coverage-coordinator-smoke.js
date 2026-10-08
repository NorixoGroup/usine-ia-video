// Smoke R28.9 — coordinateur de convergence de la couverture (baseline
// v1.0.2, contrat 4.7), zéro API. Les rondes passent par les vrais modules
// R28.5 à R28.8A ; seul le transport du juge est simulé. Vérifie PASS et
// NOT_PASS classés, les rondes, les relances, la politique, l'échec fermé, la
// traçabilité, le déterminisme, l'idempotence, l'immuabilité, et des
// mutations avec témoin (copies hors dépôt). Les branches inatteignables avec
// des modules cohérents sont exercées par des modules de remplacement
// injectés dans une copie hors dépôt.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-coordinator-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import {
  COVERAGE_COORDINATOR_VERSION,
  COVERAGE_STATUS,
  NOT_PASS_REASON,
  coordinateCoverage
} from "../src/utils/coverage-coordinator.js";
import { boundaryProtocolIdFromLock, coverageJudgeV2Version, judgeLockSha256 } from "../src/utils/coverage-judge-v2.js";
import { composeCoverageBoundary } from "../src/utils/composite-coverage-boundary.js";
import { coverageProtectionVersion, extractResearchEntities } from "../src/utils/coverage-protection.js";
import { coverageUnitSplitterVersion } from "../src/utils/coverage-unit-splitter.js";
import { coverageClassificationVersion } from "../src/utils/coverage-classification.js";

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

const ENTITIES = extractResearchEntities({ keyFacts: [], ruleVersion: "research-entities.v1" });
const POLICY = Object.freeze({ version: "coverage-coordinator-policy.v1", max_rounds: 5, max_total_judge_calls: 10 });
const LOCK = Object.freeze({
  splitter: coverageUnitSplitterVersion(),
  normalization: "coverage-normalization.v1",
  protection: coverageProtectionVersion(),
  entities_rule_version: ENTITIES.rule_version,
  entities_fingerprint: ENTITIES.fingerprint,
  classification: coverageClassificationVersion(),
  language: "fr",
  judge: coverageJudgeV2Version(),
  repair: "coverage-repair.v1",
  baseline: "architecture-baseline-v1.0.3",
  coordinator: POLICY.version
});
const CLAIMS = Object.freeze([{ text: "Le bassin couvre environ un million de kilomètres carrés." }]);

// Phrases d'un segment : chacune devient une unité analysée.
const S = Object.freeze([
  "Le désert avance vite. ",
  "La côte reste humide. ",
  "Le centre est vide. ",
  "Sans lui, l’intérieur serait inhabitable."
]);
const VOICEOVER = S.join("");
const segmentOf = (voiceover = VOICEOVER, segment_id = "s2-g4") => ({ segment_id, voiceover, entities: ENTITIES });

// Transport simulé : retrouve les phrases présentes, dans l'ordre des unités,
// et décide pour chaque unité désignée avec `verdict(phrase, phrasesPrésentes)`.
function transport({ verdict = () => null, fail = () => null, alter = data => data, sentences = S } = {}) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    const failure = fail(calls.length);
    if (failure === "throw") throw new Error("panne réseau");
    if (failure === "empty") return { request_sha256: "c".repeat(64), meta: {}, response: { content: [] } };
    if (failure === "nontext") return { request_sha256: "c".repeat(64), meta: {}, response: { content: [{ type: "image" }] } };
    const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
    const present = sentences.filter(sentence => payload.voiceover.includes(sentence.trim()));
    const textOf = id => present[payload.units.findIndex(unit => unit.unit_id === id)];
    const data = {
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results: payload.designated_unit_ids.map(unit_id => {
        const operation = verdict(textOf(unit_id), present);
        return operation
          ? { unit_id, verdict: "UNCOVERED", operations: [operation] }
          : { unit_id, verdict: "COVERED", operations: [] };
      })
    };
    return {
      request_sha256: sha256(request.messages[0].content),
      meta: { stop_reason: "end_turn", output_tokens: 10 },
      response: { content: [{ type: "text", text: JSON.stringify(alter(data)) }] }
    };
  };
  return { fn, calls };
}

const DELETE = { action: "DELETE" };
const MODELS = {
  allCovered: () => null,
  inhabitable: sentence => (sentence?.includes("inhabitable") ? DELETE : null),
  // Seule la dernière phrase présente est non couverte tant qu'il en reste plus de deux.
  lastWhileMoreThanTwo: (sentence, present) => (present.length > 2 && sentence === present.at(-1) ? DELETE : null),
  everything: () => DELETE,
  declare: sentence => (sentence?.includes("inhabitable") ? { action: "DECLARE", claim_id: "s2-g4-c1" } : null)
};

const run = (model = MODELS.allCovered, overrides = {}, transportOptions = {}) => {
  const t = transport({ verdict: model, ...transportOptions });
  return coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: t.fn, policy: POLICY, ...overrides })
    .then(result => ({ result, calls: t.calls }));
};

function expectNotPass(result, reason, category = undefined) {
  deepStrictEqual([result.script_status, result.segment_status.status, result.segment_status.reason], ["NOT_PASS", "NOT_PASS", reason]);
  if (category !== undefined) deepStrictEqual(result.segment_status.category, category);
}

// ---------------------------------------------------------------------------

await test("constantes publiques : version, statuts, raisons fermées", () => {
  deepStrictEqual(COVERAGE_COORDINATOR_VERSION, "coverage-coordinator.v1");
  deepStrictEqual(Object.values(COVERAGE_STATUS), ["PASS", "NOT_PASS"]);
  deepStrictEqual(Object.keys(NOT_PASS_REASON).length, 14);
  if (!Object.isFrozen(COVERAGE_STATUS) || !Object.isFrozen(NOT_PASS_REASON)) throw new Error("constante modifiable");
});

await test("préconditions : 4 unités analysées, aucune exclue", () => {
  const boundary = composeCoverageBoundary({ voiceover: VOICEOVER, lock: LOCK, entities: ENTITIES });
  deepStrictEqual([boundary.units.map(item => item.unit.text), [...boundary.analysed_unit_ids]], [[...S], ["u1", "u2", "u3", "u4"]]);
});

const { result: IMMEDIATE, calls: IMMEDIATE_CALLS } = await run(MODELS.allCovered);

await test("PASS immédiat : une ronde, aucune réparation", () => {
  deepStrictEqual([IMMEDIATE.script_status, IMMEDIATE.segment_status.status, IMMEDIATE.rounds, IMMEDIATE.history[0].repair.status], ["PASS", "PASS", 1, "NO_REPAIR"]);
});

await test("PASS immédiat : voiceover final identique, empreinte de la frontière", () => {
  deepStrictEqual([IMMEDIATE.final_voiceover, IMMEDIATE.final_voiceover_sha256], [VOICEOVER, sha256(VOICEOVER)]);
});

await test("PASS immédiat : un seul appel au transport", () => {
  deepStrictEqual([IMMEDIATE_CALLS.length, IMMEDIATE.judge_calls], [1, 1]);
});

await test("classement PASS : aucune raison, aucune catégorie, aucune unité", () => {
  deepStrictEqual(clone(IMMEDIATE.segment_status), { segment_id: "s2-g4", status: "PASS", reason: null, category: null, unit_ids: [] });
});

await test("traçabilité : protocol_id, lock_sha256, baseline, politique", () => {
  deepStrictEqual(
    [IMMEDIATE.protocol_id, IMMEDIATE.lock_sha256, IMMEDIATE.baseline, IMMEDIATE.policy_version],
    [IMMEDIATE.history[0].boundary.protocol_id, judgeLockSha256(LOCK), "architecture-baseline-v1.0.3", POLICY.version]
  );
});

const { result: ONE, calls: ONE_CALLS } = await run(MODELS.inhabitable);

await test("une ronde de réparation : PASS en deux rondes", () => {
  deepStrictEqual([ONE.script_status, ONE.rounds, ONE.history.map(entry => entry.repair.status)], ["PASS", 2, ["PLANNED", "NO_REPAIR"]]);
});

await test("une ronde de réparation : unité supprimée, texte restant exact", () => {
  deepStrictEqual([[...ONE.history[0].delete.deleted_unit_ids], ONE.final_voiceover], [["u4"], S[0] + S[1] + S[2]]);
});

await test("une ronde de réparation : frontière reconstruite sur le nouveau voiceover", () => {
  deepStrictEqual([ONE.history[1].voiceover_sha256, ONE.history[1].boundary.units.length, ONE.final_boundary === ONE.history[1].boundary], [sha256(S[0] + S[1] + S[2]), 3, true]);
});

await test("une ronde de réparation : empreintes enchaînées entre rondes", () => {
  deepStrictEqual(ONE.history[0].delete.repaired_voiceover_sha256, ONE.history[1].voiceover_sha256);
  deepStrictEqual(ONE.final_voiceover_sha256, sha256(ONE.final_voiceover));
});

await test("une ronde de réparation : protocole constant, deux appels", () => {
  deepStrictEqual([ONE.history[0].protocol_id === ONE.history[1].protocol_id, ONE.protocol_id === ONE.history[0].protocol_id, ONE_CALLS.length], [true, true, 2]);
});

const { result: MULTI } = await run(MODELS.lastWhileMoreThanTwo);

await test("rondes multiples : convergence avant la limite", () => {
  deepStrictEqual([MULTI.script_status, MULTI.rounds, MULTI.final_voiceover], ["PASS", 3, S[0] + S[1]]);
});

await test("rondes multiples : une suppression par ronde, dans l'ordre", () => {
  deepStrictEqual(MULTI.history.map(entry => entry.delete?.deleted_unit_ids?.[0] ?? null), ["u4", "u3", null]);
});

await test("rondes multiples : historique complet par ronde", () => {
  deepStrictEqual(MULTI.history.map(entry => entry.round), [1, 2, 3]);
  for (const entry of MULTI.history) {
    deepStrictEqual(Object.keys(entry), ["round", "voiceover_sha256", "protocol_id", "boundary", "judgment", "repair", "delete"]);
    deepStrictEqual(entry.voiceover_sha256, entry.boundary.voiceover_sha256);
  }
});

const { result: MAXED } = await run(MODELS.lastWhileMoreThanTwo, { policy: { ...POLICY, max_rounds: 2 } });

await test("limite de rondes atteinte : NOT_PASS MAX_ROUNDS_REACHED", () => {
  expectNotPass(MAXED, "MAX_ROUNDS_REACHED");
  deepStrictEqual([MAXED.rounds, [...MAXED.segment_status.unit_ids]], [2, ["u3"]]);
});

await test("limite de rondes atteinte : jamais de PASS sur un texte non rejugé", () => {
  deepStrictEqual(MAXED.history.at(-1).repair.status, "PLANNED");
});

await test("politique d'une seule ronde : PASS immédiat possible, réparation non rejugée refusée", async () => {
  deepStrictEqual((await run(MODELS.allCovered, { policy: { ...POLICY, max_rounds: 1 } })).result.script_status, "PASS");
  expectNotPass((await run(MODELS.inhabitable, { policy: { ...POLICY, max_rounds: 1 } })).result, "MAX_ROUNDS_REACHED");
});

await test("relance : un échec du transport puis succès → PASS, deux appels", async () => {
  const { result, calls } = await run(MODELS.allCovered, {}, { fail: n => (n === 1 ? "throw" : null) });
  deepStrictEqual([result.script_status, calls.length, result.judge_calls, result.rounds], ["PASS", 2, 2, 1]);
});

await test("relance : trois échecs puis succès dans le budget → PASS", async () => {
  const { result, calls } = await run(MODELS.allCovered, {}, { fail: n => (n <= 3 ? "throw" : null) });
  deepStrictEqual([result.script_status, calls.length], ["PASS", 4]);
});

await test("échecs répétés du transport : budget épuisé → NOT_PASS", async () => {
  const { result, calls } = await run(MODELS.allCovered, { policy: { ...POLICY, max_total_judge_calls: 3 } }, { fail: () => "throw" });
  expectNotPass(result, "JUDGE_BUDGET_EXHAUSTED", "TRANSPORT_ERROR");
  deepStrictEqual(calls.length, 3);
});

await test("budget partagé entre rondes : épuisé en deuxième ronde → NOT_PASS", async () => {
  const { result, calls } = await run(MODELS.inhabitable, { policy: { ...POLICY, max_total_judge_calls: 1 } });
  expectNotPass(result, "JUDGE_BUDGET_EXHAUSTED");
  deepStrictEqual([calls.length, result.rounds], [1, 2]);
});

await test("réponse vide : non relancée → NOT_PASS JUDGE_NOT_JUDGED", async () => {
  const { result, calls } = await run(MODELS.allCovered, {}, { fail: () => "empty" });
  expectNotPass(result, "JUDGE_NOT_JUDGED", "EMPTY_RESPONSE");
  deepStrictEqual(calls.length, 1);
});

await test("réponse non textuelle : non relancée → NOT_PASS", async () => {
  const { result, calls } = await run(MODELS.allCovered, {}, { fail: () => "nontext" });
  expectNotPass(result, "JUDGE_NOT_JUDGED", "NON_TEXT_RESPONSE");
  deepStrictEqual(calls.length, 1);
});

await test("réponse hors protocole (protocol_id altéré) : non relancée → NOT_PASS", async () => {
  const { result, calls } = await run(MODELS.allCovered, {}, { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) });
  expectNotPass(result, "JUDGE_NOT_JUDGED", "NOT_JUDGED");
  deepStrictEqual(calls.length, 1);
});

await test("réponse hors protocole (lock_sha256 altéré) : NOT_PASS", async () => {
  expectNotPass((await run(MODELS.allCovered, {}, { alter: data => ({ ...data, lock_sha256: "0".repeat(64) }) })).result, "JUDGE_NOT_JUDGED");
});

await test("transport absent : NOT_PASS sans relance", async () => {
  const result = await coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: undefined, policy: POLICY });
  expectNotPass(result, "JUDGE_NOT_JUDGED", "TRANSPORT_MISSING");
  deepStrictEqual(result.judge_calls, 1);
});

await test("NOT_REPAIRABLE : toutes les unités non couvertes → NOT_PASS", async () => {
  const { result } = await run(MODELS.everything);
  expectNotPass(result, "NOT_REPAIRABLE");
  deepStrictEqual([[...result.segment_status.unit_ids], result.final_voiceover], [["u1", "u2", "u3", "u4"], VOICEOVER]);
});

await test("INPUT_REFUSED de la réparation : DECLARE → NOT_PASS REPAIR_REFUSED", async () => {
  const { result } = await run(MODELS.declare);
  expectNotPass(result, "REPAIR_REFUSED", "DECLARE_NOT_SUPPORTED");
  deepStrictEqual([[...result.segment_status.unit_ids], result.final_voiceover], [["u4"], VOICEOVER]);
});

await test("juge hors bornes (25 claims) → NOT_PASS JUDGE_OUT_OF_BOUNDS, aucun appel", async () => {
  const { result, calls } = await run(MODELS.allCovered, { claims: Array.from({ length: 25 }, (_, index) => ({ text: `Fait ${index}.` })) });
  expectNotPass(result, "JUDGE_OUT_OF_BOUNDS", "OUT_OF_BOUNDS");
  deepStrictEqual(calls.length, 0);
});

await test("juge en refus (claims invalides) → NOT_PASS JUDGE_REFUSED", async () => {
  expectNotPass((await run(MODELS.allCovered, { claims: [{ text: "" }] })).result, "JUDGE_REFUSED", "INPUT_REFUSED");
});

await test("frontière impossible : voiceover vide → NOT_PASS BOUNDARY_FAILED", async () => {
  for (const voiceover of ["", "   "]) {
    const { result, calls } = await run(MODELS.allCovered, { segment: segmentOf(voiceover) });
    expectNotPass(result, "BOUNDARY_FAILED", "texte vide");
    deepStrictEqual(calls.length, 0);
  }
});

const LOCK_CASES = [
  ["verrou absent", null, "LOCK_INVALID"],
  ["politique absente du verrou", (({ coordinator, ...rest }) => rest)(LOCK), "LOCK_INVALID"],
  ["politique du verrou différente", { ...LOCK, coordinator: "coverage-coordinator-policy.v2" }, "LOCK_INVALID"],
  ["découpeur divergent", { ...LOCK, splitter: `${LOCK.splitter}x` }, "LOCK_INVALID"],
  ["empreinte d'entités divergente", { ...LOCK, entities_fingerprint: "0".repeat(64) }, "LOCK_INVALID"],
  ["juge absent du verrou", (({ judge, ...rest }) => rest)(LOCK), "JUDGE_REFUSED"],
  ["baseline divergente", { ...LOCK, baseline: "architecture-baseline-v1.0.2" }, "JUDGE_REFUSED"]
];

for (const [name, lock, reason] of LOCK_CASES) {
  await test(`verrou invalide — ${name} → NOT_PASS ${reason}`, async () => {
    expectNotPass((await run(MODELS.allCovered, { lock })).result, reason);
  });
}

await test("langue non prise en charge (en) : découpeur dégradé, voiceover jugé en une seule unité (dégradé sûr)", async () => {
  const { result } = await run(MODELS.allCovered, { lock: { ...LOCK, language: "en" } });
  deepStrictEqual([result.history[0].boundary.splitter.status, result.history[0].boundary.units.length, [...result.history[0].boundary.analysed_unit_ids]], ["DEGRADED", 1, ["u1"]]);
  deepStrictEqual(result.script_status, "PASS");
});

const POLICY_CASES = [
  ["politique absente", undefined],
  ["politique sans version", { max_rounds: 5, max_total_judge_calls: 10 }],
  ["max_rounds nul", { ...POLICY, max_rounds: 0 }],
  ["max_rounds non entier", { ...POLICY, max_rounds: 1.5 }],
  ["max_total_judge_calls nul", { ...POLICY, max_total_judge_calls: 0 }],
  ["max_total_judge_calls absent", { version: POLICY.version, max_rounds: 5 }],
  ["politique non objet", "max_rounds=5"]
];

for (const [name, policy] of POLICY_CASES) {
  await test(`politique invalide — ${name} → NOT_PASS POLICY_INVALID, aucun appel`, async () => {
    const { result, calls } = await run(MODELS.allCovered, { policy });
    expectNotPass(result, "POLICY_INVALID");
    deepStrictEqual([calls.length, result.rounds], [0, 0]);
  });
}

const INPUT_CASES = [
  ["segment absent", undefined],
  ["segment sans voiceover", { segment_id: "s2-g4", entities: ENTITIES }],
  ["segment sans identifiant", { voiceover: VOICEOVER, entities: ENTITIES }],
  ["segment sans entités", { segment_id: "s2-g4", voiceover: VOICEOVER }],
  ["voiceover non textuel", { segment_id: "s2-g4", voiceover: 42, entities: ENTITIES }]
];

for (const [name, segment] of INPUT_CASES) {
  await test(`entrée invalide — ${name} → NOT_PASS INPUT_INVALID`, async () => {
    expectNotPass((await run(MODELS.allCovered, { segment })).result, "INPUT_INVALID");
  });
}

await test("identifiant de segment invalide → refusé par le juge, NOT_PASS", async () => {
  expectNotPass((await run(MODELS.allCovered, { segment: segmentOf(VOICEOVER, "segment-4") })).result, "JUDGE_REFUSED");
});

await test("ne lève jamais : appel sans argument → NOT_PASS", async () => {
  expectNotPass(await coordinateCoverage(), "INPUT_INVALID");
});

await test("aucun texte régénéré : le voiceover final est une sous-suite exacte des phrases d'origine", () => {
  for (const result of [IMMEDIATE, ONE, MULTI, MAXED]) {
    const kept = S.filter(sentence => result.final_voiceover.includes(sentence.trim()));
    deepStrictEqual(result.final_voiceover, kept.join(""));
  }
});

await test("historique déterministe : octets identiques, indépendamment de l'historique d'appels", async () => {
  const first = JSON.stringify((await run(MODELS.lastWhileMoreThanTwo)).result);
  await run(MODELS.declare);
  await run(MODELS.everything);
  for (let round = 0; round < 3; round += 1) deepStrictEqual(JSON.stringify((await run(MODELS.lastWhileMoreThanTwo)).result), first);
});

await test("idempotence : relancer la coordination donne le même résultat, sur tous les scénarios", async () => {
  for (const model of Object.values(MODELS)) {
    deepStrictEqual(JSON.stringify((await run(model)).result), JSON.stringify((await run(model)).result));
  }
});

await test("idempotence : coordonner le voiceover final d'un PASS donne PASS immédiat sur le même texte", async () => {
  const again = await coordinateCoverage({ segment: segmentOf(ONE.final_voiceover), claims: CLAIMS, lock: LOCK, transport: transport({ verdict: MODELS.inhabitable }).fn, policy: POLICY });
  deepStrictEqual([again.script_status, again.rounds, again.final_voiceover], ["PASS", 1, ONE.final_voiceover]);
});

await test("entrées immuables : segment, claims, verrou et politique intacts", async () => {
  const inputs = { segment: clone(segmentOf()), claims: clone(CLAIMS), lock: clone(LOCK), policy: clone(POLICY) };
  const snapshot = JSON.stringify(inputs);
  const t = transport({ verdict: MODELS.lastWhileMoreThanTwo });
  const result = await coordinateCoverage({ ...inputs, transport: t.fn });
  deepStrictEqual([JSON.stringify(inputs), result.script_status], [snapshot, "PASS"]);
});

await test("entrées figées acceptées", async () => {
  const frozen = Object.freeze({ ...segmentOf(), entities: ENTITIES });
  const result = await coordinateCoverage({ segment: frozen, claims: CLAIMS, lock: LOCK, transport: transport().fn, policy: POLICY });
  deepStrictEqual(result.script_status, "PASS");
});

await test("sorties immuables : résultat, historique, statut et sorties des modules figés", () => {
  for (const result of [IMMEDIATE, MULTI, MAXED]) {
    if (!Object.isFrozen(result) || !Object.isFrozen(result.history) || !Object.isFrozen(result.segment_status) || !Object.isFrozen(result.segment_status.unit_ids)) throw new Error("sortie modifiable");
    for (const entry of result.history) {
      if (!Object.isFrozen(entry) || !Object.isFrozen(entry.boundary) || !Object.isFrozen(entry.judgment) || !Object.isFrozen(entry.repair)) throw new Error("historique modifiable");
    }
  }
});

await test("aucune régénération ni écriture : imports limités aux cinq modules, aucun réseau, aucun cache", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-coordinator.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")), [
    'import { composeCoverageBoundary } from "./composite-coverage-boundary.js";',
    'import { judgeLockSha256, judgeSegmentCoverageV2 } from "./coverage-judge-v2.js";',
    'import { executeJudgeRequest } from "./coverage-judge-executor.js";',
    'import { planCoverageRepair } from "./coverage-repair.js";',
    'import { applyCoverageDeletePlan } from "./coverage-delete-applier.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["fetch(", "http", "createMessage", "call-guard", "cache", "crypto", "sha256(", "writeFile", "checkpoint", "regenerat", "replace(", "trim("]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
  deepStrictEqual(networkGuard.attempts().length, 0);
});

const MIXED_VOICEOVER = "Imaginez la scène. Le bassin couvre environ un million de kilomètres carrés. Sans lui, l’intérieur serait inhabitable.";
const MIXED_S = ["Imaginez la scène. ", "Le bassin couvre environ un million de kilomètres carrés. ", "Sans lui, l’intérieur serait inhabitable."];
const mixedRun = (model, overrides = {}) => {
  const t = transport({ verdict: model, sentences: MIXED_S });
  return coordinateCoverage({ segment: segmentOf(MIXED_VOICEOVER), claims: CLAIMS, lock: LOCK, transport: t.fn, policy: POLICY, ...overrides }).then(result => ({ result, calls: t.calls }));
};

await test("structure de sortie figée (PASS)", () => {
  deepStrictEqual(Object.keys(IMMEDIATE), ["script_status", "segment_status", "rounds", "final_voiceover", "final_voiceover_sha256", "final_boundary", "history", "protocol_id", "lock_sha256", "baseline", "judge_calls", "policy_version"]);
});

await test("structure de sortie figée (NOT_PASS)", () => {
  deepStrictEqual(Object.keys(MAXED), Object.keys(IMMEDIATE));
  deepStrictEqual(Object.keys(MAXED.segment_status), ["segment_id", "status", "reason", "category", "unit_ids"]);
});

await test("statut du Script égal au statut du segment, sur tous les scénarios", async () => {
  for (const model of Object.values(MODELS)) {
    const { result } = await run(model);
    deepStrictEqual(result.script_status, result.segment_status.status);
  }
});

await test("identifiant de segment repris tel quel", () => {
  for (const result of [IMMEDIATE, ONE, MULTI, MAXED]) deepStrictEqual(result.segment_status.segment_id, "s2-g4");
});

await test("rondes multiples : un appel par ronde", () => {
  deepStrictEqual(MULTI.judge_calls, 3);
});

await test("frontière finale = frontière de la dernière ronde, sur tous les scénarios", () => {
  for (const result of [IMMEDIATE, ONE, MULTI, MAXED]) if (result.final_boundary !== result.history.at(-1).boundary) throw new Error("frontière finale incohérente");
});

await test("limite atteinte : voiceover final = dernier texte réparé, non rejugé (NOT_PASS)", () => {
  deepStrictEqual([MAXED.final_voiceover, MAXED.final_voiceover_sha256], [S[0] + S[1], sha256(S[0] + S[1])]);
});

await test("frontière impossible : aucune empreinte de verrou, ronde sans jugement", async () => {
  const { result } = await run(MODELS.allCovered, { segment: segmentOf("") });
  deepStrictEqual([result.lock_sha256, result.history[0].judgment, result.history[0].repair, result.rounds], [null, null, null, 1]);
});

await test("politique invalide : aucune ronde, voiceover d’entrée conservé", async () => {
  const { result } = await run(MODELS.allCovered, { policy: undefined });
  deepStrictEqual([result.rounds, result.final_voiceover, result.history.length, result.protocol_id], [0, VOICEOVER, 0, null]);
});

await test("unités exclues : jamais supprimées, PASS après suppression d’une unité analysée", async () => {
  const { result } = await mixedRun(MODELS.inhabitable);
  deepStrictEqual([result.script_status, result.rounds, [...result.history[0].boundary.excluded_unit_ids], result.final_voiceover.startsWith("Imaginez la scène. ")], ["PASS", 2, ["u1"], true]);
});

await test("unité protégée jugée non couverte : supprimée, puis PASS", async () => {
  const { result } = await mixedRun(sentence => (sentence?.includes("million") ? DELETE : null));
  deepStrictEqual([result.script_status, [...result.history[0].delete.deleted_unit_ids], result.history[0].boundary.units[1].state], ["PASS", ["u2"], "protected"]);
});

await test("aucune unité désignée : PASS sans appel au transport", async () => {
  const t = transport();
  const result = await coordinateCoverage({ segment: segmentOf("Imaginez la scène. Pourquoi ?"), claims: CLAIMS, lock: LOCK, transport: t.fn, policy: POLICY });
  deepStrictEqual([result.script_status, result.rounds, t.calls.length, result.history[0].judgment.status], ["PASS", 1, 0, "NO_DESIGNATED_UNITS"]);
});

await test("relance en deuxième ronde : échec du transport puis succès → PASS", async () => {
  const { result, calls } = await run(MODELS.inhabitable, {}, { fail: n => (n === 2 ? "throw" : null) });
  deepStrictEqual([result.script_status, result.rounds, calls.length, result.judge_calls], ["PASS", 2, 3, 3]);
});

await test("historique déterministe sur chaque scénario", async () => {
  const digest = result => JSON.stringify(result.history.map(entry => [entry.round, entry.voiceover_sha256, entry.protocol_id, entry.repair?.status ?? null, entry.delete?.status ?? null]));
  for (const model of Object.values(MODELS)) deepStrictEqual(digest((await run(model)).result), digest((await run(model)).result));
});

// ---------------------------------------------------------------------------
// Copies isolées hors dépôt : coordinateur muté et/ou modules de remplacement.

function isolatedCoordinator(prefix, { replacements = [], stubs = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let source = fs.readFileSync(new URL("../src/utils/coverage-coordinator.js", import.meta.url), "utf8");
  for (const name of ["composite-coverage-boundary.js", "coverage-judge-v2.js", "coverage-judge-executor.js", "coverage-repair.js", "coverage-delete-applier.js"]) {
    const real = pathToFileURL(new URL(`../src/utils/${name}`, import.meta.url).pathname).href;
    let target = real;
    if (stubs[name]) {
      fs.writeFileSync(path.join(root, `stub-${name}`), stubs[name].replaceAll("__REAL__", real));
      target = pathToFileURL(path.join(root, `stub-${name}`)).href;
    }
    source = source.replace(`"./${name}"`, JSON.stringify(target));
  }
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(root, "coverage-coordinator.js"), source);
  return import(pathToFileURL(path.join(root, "coverage-coordinator.js")).href).then(module => ({ root, module }));
}

const cleanup = root => fs.rmSync(root, { recursive: true, force: true });

await test("frontière incohérente (dérive du protocole en deuxième ronde) → NOT_PASS PROTOCOL_DRIFT", async () => {
  const stub = `import { composeCoverageBoundary as real } from "__REAL__";
let calls = 0;
export function composeCoverageBoundary(input) {
  const output = real(input);
  calls += 1;
  return calls === 2 ? Object.freeze({ ...output, protocol_id: "f".repeat(64) }) : output;
}`;
  const { root, module } = await isolatedCoordinator("r28-9-drift-", { stubs: { "composite-coverage-boundary.js": stub } });
  try {
    const result = await module.coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: transport({ verdict: MODELS.inhabitable }).fn, policy: POLICY });
    expectNotPass(result, "PROTOCOL_DRIFT");
    deepStrictEqual(result.rounds, 2);
  } finally {
    cleanup(root);
  }
});

await test("réparation incohérente (statut inconnu) → jamais PASS", async () => {
  const stub = `import { planCoverageRepair as real } from "__REAL__";
export function planCoverageRepair(input) { return Object.freeze({ ...real(input), status: "DONE" }); }`;
  const { root, module } = await isolatedCoordinator("r28-9-repair-", { stubs: { "coverage-repair.js": stub } });
  try {
    const result = await module.coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: transport().fn, policy: POLICY });
    deepStrictEqual(result.script_status, "NOT_PASS");
  } finally {
    cleanup(root);
  }
});

await test("suppression refusée par l'applicateur → NOT_PASS DELETE_REFUSED, texte inchangé", async () => {
  const stub = `export function applyCoverageDeletePlan() {
  return Object.freeze({ status: "INPUT_REFUSED", refusal: Object.freeze({ code: "EMPTY_RESULT", unit_id: null }) });
}`;
  const { root, module } = await isolatedCoordinator("r28-9-delete-", { stubs: { "coverage-delete-applier.js": stub } });
  try {
    const result = await module.coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: transport({ verdict: MODELS.inhabitable }).fn, policy: POLICY });
    expectNotPass(result, "DELETE_REFUSED", "EMPTY_RESULT");
    deepStrictEqual(result.final_voiceover, VOICEOVER);
  } finally {
    cleanup(root);
  }
});

await test("exception inattendue d'un module → NOT_PASS UNEXPECTED, jamais d'exception propagée", async () => {
  const stub = `export function planCoverageRepair() { throw new Error("panne"); }`;
  const { root, module } = await isolatedCoordinator("r28-9-throw-", { stubs: { "coverage-repair.js": stub } });
  try {
    expectNotPass(await module.coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: transport().fn, policy: POLICY }), "UNEXPECTED");
  } finally {
    cleanup(root);
  }
});

// R28.9A — verrou complet : éléments 9 (réparation) et 10 (coordinateur).
const OLD_LOCK = Object.freeze((({ repair, coordinator, ...rest }) => rest)(LOCK));

await test("R28.9A — version de réparation absente du verrou → NOT_PASS (juge en refus)", async () => {
  const { repair: _removed, ...partial } = LOCK;
  const { result, calls } = await run(MODELS.allCovered, { lock: partial });
  expectNotPass(result, "JUDGE_REFUSED");
  deepStrictEqual(calls.length, 0);
});

await test("R28.9A — version de réparation modifiée → NOT_PASS (réparation en refus)", async () => {
  const { result } = await run(MODELS.allCovered, { lock: { ...LOCK, repair: "coverage-repair.v2" } });
  expectNotPass(result, "REPAIR_REFUSED", "LOCK_MISMATCH");
});

await test("R28.9A — version du coordinateur absente ou modifiée → NOT_PASS LOCK_INVALID, aucun appel", async () => {
  const { coordinator: _removed, ...partial } = LOCK;
  for (const lock of [partial, { ...LOCK, coordinator: "coverage-coordinator-policy.v2" }]) {
    const { result, calls } = await run(MODELS.allCovered, { lock });
    expectNotPass(result, "LOCK_INVALID");
    deepStrictEqual(calls.length, 0);
  }
});

await test("R28.9A — lock_sha256 propagé = empreinte du verrou complet, protocol_id inchangé", () => {
  deepStrictEqual([IMMEDIATE.lock_sha256, IMMEDIATE.protocol_id], [judgeLockSha256(LOCK), boundaryProtocolIdFromLock(OLD_LOCK)]);
  if (judgeLockSha256(LOCK) === judgeLockSha256(OLD_LOCK)) throw new Error("empreinte inchangée");
});

await test("R28.9A — rejeu avec l'ancien verrou refusé, verrou complet accepté", async () => {
  expectNotPass((await run(MODELS.allCovered, { lock: OLD_LOCK })).result, "LOCK_INVALID");
  deepStrictEqual((await run(MODELS.inhabitable)).result.script_status, "PASS");
});

await test("R28.9A — jugement lié à un autre verrou (module de remplacement) → NOT_PASS LOCK_INVALID ; détecté sans le contrôle", async () => {
  const stub = `import { judgeSegmentCoverageV2 as real } from "__REAL__";
export * from "__REAL__";
export async function judgeSegmentCoverageV2(input) {
  const output = await real(input);
  return Object.freeze({ ...output, lock_sha256: "0".repeat(64) });
}`;
  const control = await isolatedCoordinator("r28-9a-locksha-", { stubs: { "coverage-judge-v2.js": stub } });
  const mutant = await isolatedCoordinator("r28-9a-locksha-mutant-", {
    stubs: { "coverage-judge-v2.js": stub },
    replacements: [{ from: 'if (judgment.lock_sha256 !== judgeLockSha256(lock)) return notPass(NOT_PASS_REASON.LOCK_INVALID, "lock_sha256");', to: "" }]
  });
  try {
    const input = () => ({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: transport().fn, policy: POLICY });
    expectNotPass(await control.module.coordinateCoverage(input()), "LOCK_INVALID", "lock_sha256");
    const mutated = await mutant.module.coordinateCoverage(input());
    if (mutated.segment_status.reason === "LOCK_INVALID") throw new Error("mutant non détecté");
  } finally {
    cleanup(control.root);
    cleanup(mutant.root);
  }
});

async function behaviourFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  const exec = async (model, overrides = {}, transportOptions = {}) => {
    const t = transport({ verdict: model, ...transportOptions });
    const guard = new Promise(resolve => setTimeout(() => resolve({ script_status: "BLOQUÉ" }), 2000));
    try {
      const result = await Promise.race([
        module.coordinateCoverage({ segment: segmentOf(), claims: CLAIMS, lock: LOCK, transport: t.fn, policy: POLICY, ...overrides }),
        guard
      ]);
      return { result, calls: t.calls.length };
    } catch (error) {
      return { result: { script_status: "EXCEPTION", error: error.message }, calls: t.calls.length };
    }
  };
  const retry = await exec(MODELS.allCovered, {}, { fail: n => (n === 1 ? "throw" : null) });
  check("relance", [retry.result.script_status, retry.calls], ["PASS", 2]);
  const bounded = await exec(MODELS.lastWhileMoreThanTwo, { policy: { ...POLICY, max_rounds: 2 } });
  check("rondes bornées", [bounded.result.script_status, bounded.result.segment_status?.reason, bounded.result.rounds], ["NOT_PASS", "MAX_ROUNDS_REACHED", 2]);
  const one = await exec(MODELS.inhabitable);
  check("réparation appliquée", [one.result.script_status, one.result.rounds, one.result.final_voiceover], ["PASS", 2, S[0] + S[1] + S[2]]);
  check("protocole propagé", one.result.protocol_id, one.result.history?.[0]?.boundary?.protocol_id);
  check("verrou propagé", one.result.lock_sha256, judgeLockSha256(LOCK));
  check("frontière reconstruite", one.result.history?.[1]?.boundary?.units?.length, 3);
  const declare = await exec(MODELS.declare);
  check("NOT_PASS conservé", [declare.result.script_status, declare.result.segment_status?.reason], ["NOT_PASS", "REPAIR_REFUSED"]);
  check("historique figé", Object.isFrozen(one.result.history) && one.result.history.every(Object.isFrozen), true);
  return failures;
}

const MUTATIONS = [
  ["relance absente", [{ from: "if (!RETRYABLE_TRANSPORT_FAILURES.includes(transportFailure)) {", to: "if (true) {" }]],
  ["boucle infinie (rondes non bornées)", [{ from: "round <= policy.max_rounds;", to: "round <= 1000;" }]],
  ["réparation ignorée", [{ from: 'if (repair.status === "NO_REPAIR") return result(state, { status: COVERAGE_STATUS.PASS });', to: 'if (repair.status !== "INPUT_REFUSED") return result(state, { status: COVERAGE_STATUS.PASS });' }]],
  ["suppression ignorée", [{ from: "state.voiceover = applied.repaired_voiceover;", to: "" }]],
  ["dérive du protocole", [{ from: "protocol_id: state.protocolId,", to: "protocol_id: state.lockSha256," }]],
  ["dérive du verrou", [{ from: "judgment = await judgeSegmentCoverageV2({ boundary, lock, claims", to: "judgment = await judgeSegmentCoverageV2({ boundary, lock: round > 1 ? { ...lock, baseline: \"autre\" } : lock, claims" }]],
  ["frontière non reconstruite", [{ from: "const boundary = composeCoverageBoundary({ voiceover: state.voiceover, lock, entities: segment.entities });", to: "const boundary = state.firstBoundary ??= composeCoverageBoundary({ voiceover: state.voiceover, lock, entities: segment.entities });" }]],
  ["PASS trop tôt", [{ from: 'if (repair.status === "NO_REPAIR") return result(state, { status: COVERAGE_STATUS.PASS });', to: 'if (repair.status === "NO_REPAIR" || repair.status === "PLANNED") return result(state, { status: COVERAGE_STATUS.PASS });' }]],
  ["NOT_PASS ignoré", [{ from: "if (repair.status === \"INPUT_REFUSED\") {", to: "if (false) {" }, { from: 'if (repair.status === "NO_REPAIR") return', to: 'if (repair.status === "NO_REPAIR" || repair.status === "INPUT_REFUSED") return' }]],
  ["historique modifiable", [{ from: "  if (value !== null && typeof value === \"object\" && !Object.isFrozen(value)) {\n    for (const key of Object.keys(value)) freezeAll(value[key]);\n    Object.freeze(value);\n  }", to: "" }]]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt)", async () => {
  const control = await isolatedCoordinator("r28-9-control-");
  try {
    deepStrictEqual(await behaviourFailures(control.module), [], "témoin");
  } finally {
    cleanup(control.root);
  }
  for (const [name, replacements] of MUTATIONS) {
    const mutant = await isolatedCoordinator("r28-9-mutant-", { replacements });
    try {
      if ((await behaviourFailures(mutant.module)).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      cleanup(mutant.root);
    }
  }
});

await test("aucune tentative réseau réelle", () => deepStrictEqual(networkGuard.attempts().length, 0));

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-coordinator-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
