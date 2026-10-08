// Smoke R28.8 — réparation déterministe de la couverture (baseline v1.0.2,
// contrat 4.6, DELETE seul), zéro API. Les verdicts viennent du juge v2 réel
// avec un transport simulé ; aucun appel fournisseur, aucun réseau. Vérifie
// le plan nominal, les refus qualifiés (dont DECLARE), la traçabilité, le
// déterminisme, l'idempotence, l'immuabilité des entrées, l'absence de texte
// généré, et des mutations avec témoin (copies hors dépôt).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-repair-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import {
  COVERAGE_REPAIR_VERSION,
  REPAIR_ACTIONS,
  REPAIR_REASON,
  REPAIR_REFUSAL,
  REPAIR_STATUS,
  planCoverageRepair
} from "../src/utils/coverage-repair.js";
import { coverageJudgeV2Version, judgeLockSha256, judgeSegmentCoverageV2, JUDGE_LOCK_KEYS } from "../src/utils/coverage-judge-v2.js";
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
const BOUNDARY_LOCK = Object.freeze({
  splitter: coverageUnitSplitterVersion(),
  normalization: "coverage-normalization.v1",
  protection: coverageProtectionVersion(),
  entities_rule_version: ENTITIES.rule_version,
  entities_fingerprint: ENTITIES.fingerprint,
  classification: coverageClassificationVersion(),
  language: "fr"
});
const LOCK = Object.freeze({ ...BOUNDARY_LOCK, judge: coverageJudgeV2Version(), repair: COVERAGE_REPAIR_VERSION, coordinator: "coverage-coordinator-policy.v1", baseline: "architecture-baseline-v1.0.3" });

const boundaryOf = voiceover => composeCoverageBoundary({ voiceover, lock: BOUNDARY_LOCK, entities: ENTITIES });

// Juge v2 réel, transport simulé : `operations` fixe la réponse par unité.
async function judgeOf(boundary, operations = {}, claims = [{ text: "Le bassin couvre environ un million de kilomètres carrés." }]) {
  const send = async request => {
    const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
    const data = {
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results: payload.designated_unit_ids.map(unit_id => operations[unit_id]
        ? { unit_id, verdict: "UNCOVERED", operations: [operations[unit_id]] }
        : { unit_id, verdict: "COVERED", operations: [] })
    };
    return { request_sha256: "a".repeat(64), meta: { stop_reason: "end_turn" }, response: { content: [{ type: "text", text: JSON.stringify(data) }] } };
  };
  return judgeSegmentCoverageV2({ boundary, lock: LOCK, claims, segmentId: "s2-g4", send });
}

// Exemple de la baseline : u1 à u4 analysées (u2 protégée).
const BASELINE_VOICEOVER =
  "Mais avant cela, un détour. Le bassin couvre environ un million de kilomètres carrés. Ce n’est pas un hasard. Sans lui, l’intérieur serait inhabitable.";
// Segment mixte : u1 et u3 exclues, u2 protégée, u4 analysée.
const MIXED_VOICEOVER =
  "Imaginez la scène. Le bassin couvre environ un million de kilomètres carrés. Pourquoi ? Sans lui, l’intérieur serait inhabitable.";

const BOUNDARY = boundaryOf(BASELINE_VOICEOVER);
const MIXED = boundaryOf(MIXED_VOICEOVER);
const DELETE = { action: "DELETE" };
const J_U4 = await judgeOf(BOUNDARY, { u4: DELETE });
const J_NONE = await judgeOf(BOUNDARY);
const J_TWO = await judgeOf(BOUNDARY, { u4: DELETE, u1: DELETE });
const J_ALL = await judgeOf(BOUNDARY, { u1: DELETE, u2: DELETE, u3: DELETE, u4: DELETE });
const J_DECLARE = await judgeOf(BOUNDARY, { u4: { action: "DECLARE", claim_id: "s2-g4-c1" } });
const J_DECLARE_MIXED = await judgeOf(BOUNDARY, { u1: DELETE, u4: { action: "DECLARE", claim_id: "s2-g4-c1" } });
const J_MIXED_PROTECTED = await judgeOf(MIXED, { u2: DELETE });
const J_MIXED_NONE = await judgeOf(MIXED);
const ALL_EXCLUDED = boundaryOf("Imaginez la scène. Pourquoi ?");
const J_ALL_EXCLUDED = await judgeOf(ALL_EXCLUDED);

const plan = (judgment, overrides = {}) => planCoverageRepair({ boundary: BOUNDARY, judgment, lock: LOCK, ...overrides });

function expectRefused(result, code, unitId = null) {
  deepStrictEqual(
    [result.status, result.refusal?.code, result.refusal?.unit_id, result.repair_plan.length, result.repaired_unit_ids.length, result.protocol_id],
    ["INPUT_REFUSED", code, unitId, 0, 0, null]
  );
}

await test("constantes publiques : version, statuts, DELETE seul, codes de refus fermés", () => {
  deepStrictEqual(COVERAGE_REPAIR_VERSION, "coverage-repair.v1");
  deepStrictEqual(Object.values(REPAIR_STATUS), ["PLANNED", "NO_REPAIR", "NOT_REPAIRABLE", "INPUT_REFUSED"]);
  deepStrictEqual([...REPAIR_ACTIONS], ["DELETE"]);
  deepStrictEqual({ ...REPAIR_REASON }, { JUDGED_UNCOVERED: "JUDGED_UNCOVERED" });
  deepStrictEqual(Object.keys(REPAIR_REFUSAL).length, 20);
  for (const constant of [REPAIR_STATUS, REPAIR_ACTIONS, REPAIR_REASON, REPAIR_REFUSAL]) if (!Object.isFrozen(constant)) throw new Error("constante modifiable");
});

await test("préconditions : verdicts du juge v2 réel obtenus hors ligne", () => {
  for (const judgment of [J_U4, J_NONE, J_TWO, J_ALL, J_DECLARE, J_DECLARE_MIXED, J_MIXED_PROTECTED, J_MIXED_NONE]) deepStrictEqual(judgment.status, "JUDGED");
  deepStrictEqual(J_ALL_EXCLUDED.status, "NO_DESIGNATED_UNITS");
  deepStrictEqual([...MIXED.excluded_unit_ids], ["u1", "u3"]);
});

await test("DELETE nominal : un plan, une opération, traçabilité complète", () => {
  const result = plan(J_U4);
  deepStrictEqual(clone(result), {
    protocol_id: BOUNDARY.protocol_id,
    voiceover_sha256: sha256(BASELINE_VOICEOVER),
    lock_sha256: judgeLockSha256(LOCK),
    repair_version: "coverage-repair.v1",
    baseline: "architecture-baseline-v1.0.3",
    repair_plan: [{ unit_id: "u4", action: "DELETE", reason: "JUDGED_UNCOVERED", claim_ids: [] }],
    repaired_unit_ids: ["u4"],
    untouched_unit_ids: ["u1", "u2", "u3"],
    status: "PLANNED",
    refusal: null
  });
});

await test("plan vide : tout couvert → NO_REPAIR, toutes les unités intactes", () => {
  const result = plan(J_NONE);
  deepStrictEqual([result.status, result.repair_plan.length, [...result.untouched_unit_ids]], ["NO_REPAIR", 0, ["u1", "u2", "u3", "u4"]]);
});

await test("DELETE multiples : opérations rangées dans l'ordre des unités", () => {
  const result = plan(J_TWO);
  deepStrictEqual([result.status, result.repair_plan.map(item => item.unit_id), [...result.untouched_unit_ids]], ["PLANNED", ["u1", "u4"], ["u2", "u3"]]);
});

await test("aucune unité désignée → NO_REPAIR, unités exclues intactes", () => {
  const result = planCoverageRepair({ boundary: ALL_EXCLUDED, judgment: J_ALL_EXCLUDED, lock: LOCK });
  deepStrictEqual([result.status, [...result.untouched_unit_ids]], ["NO_REPAIR", ["u1", "u2"]]);
});

await test("unité protégée jugée non couverte → DELETE ; exclues jamais touchées", () => {
  const result = planCoverageRepair({ boundary: MIXED, judgment: J_MIXED_PROTECTED, lock: LOCK });
  deepStrictEqual([result.status, [...result.repaired_unit_ids], [...result.untouched_unit_ids]], ["PLANNED", ["u2"], ["u1", "u3", "u4"]]);
  deepStrictEqual(MIXED.units[1].state, "protected");
});

await test("unité protégée couverte → jamais touchée", () => {
  const result = planCoverageRepair({ boundary: MIXED, judgment: J_MIXED_NONE, lock: LOCK });
  deepStrictEqual([result.status, [...result.untouched_unit_ids]], ["NO_REPAIR", ["u1", "u2", "u3", "u4"]]);
});

await test("toutes les unités supprimées → NOT_REPAIRABLE (résultat vide interdit), aucun plan", () => {
  const result = plan(J_ALL);
  deepStrictEqual([result.status, result.repair_plan.length, result.repaired_unit_ids.length, [...result.untouched_unit_ids], result.refusal], ["NOT_REPAIRABLE", 0, 0, ["u1", "u2", "u3", "u4"], null]);
});

await test("verdict DECLARE → INPUT_REFUSED, aucun plan, aucune conversion", () => {
  expectRefused(plan(J_DECLARE), "DECLARE_NOT_SUPPORTED", "u4");
});

await test("DECLARE parmi des DELETE → INPUT_REFUSED, jamais de réparation partielle", () => {
  expectRefused(plan(J_DECLARE_MIXED), "DECLARE_NOT_SUPPORTED", "u4");
});

// Verdicts altérés après le juge (sortie du juge forgée ou corrompue).
const withResults = (judgment, map) => ({ ...clone(judgment), results: map(clone(judgment).results) });

const VERDICT_CASES = [
  ["action inconnue (REWRITE)", withResults(J_U4, results => results.map(item => (item.unit_id === "u4" ? { ...item, operation: { action: "REWRITE", claim_id: null } } : item))), "UNKNOWN_ACTION", "u4"],
  ["action INSERT", withResults(J_U4, results => results.map(item => (item.unit_id === "u4" ? { ...item, operation: { action: "INSERT", claim_id: null } } : item))), "UNKNOWN_ACTION", "u4"],
  ["UNCOVERED sans opération", withResults(J_U4, results => results.map(item => (item.unit_id === "u4" ? { ...item, operation: null } : item))), "UNKNOWN_ACTION", "u4"],
  ["verdict inconnu", withResults(J_U4, results => results.map(item => (item.unit_id === "u1" ? { ...item, verdict: "PARTIAL" } : item))), "UNKNOWN_VERDICT", "u1"],
  ["COVERED avec opération", withResults(J_U4, results => results.map(item => (item.unit_id === "u1" ? { ...item, operation: { action: "DELETE", claim_id: null } } : item))), "JUDGE_MALFORMED", "u1"],
  ["unité dupliquée", withResults(J_U4, results => [...results, results[3]]), "DUPLICATE_UNIT", "u4"],
  ["unité inconnue", withResults(J_U4, results => [...results, { unit_id: "u9", verdict: "UNCOVERED", operation: { action: "DELETE", claim_id: null } }]), "UNKNOWN_UNIT", "u9"],
  ["unité absente", withResults(J_U4, results => results.slice(1)), "MISSING_UNIT", "u1"],
  ["résultat sans unit_id", withResults(J_U4, results => [{ verdict: "COVERED", operation: null }, ...results.slice(1)]), "JUDGE_MALFORMED", null],
  ["résultat nul", withResults(J_U4, results => [null, ...results.slice(1)]), "JUDGE_MALFORMED", null]
];

for (const [name, judgment, code, unitId] of VERDICT_CASES) {
  await test(`refus — ${name}`, () => expectRefused(plan(judgment), code, unitId));
}

await test("refus — réparation sur une unité exclue", () => {
  const forged = withResults(J_MIXED_NONE, results => [...results, { unit_id: "u1", verdict: "UNCOVERED", operation: { action: "DELETE", claim_id: null } }]);
  expectRefused(planCoverageRepair({ boundary: MIXED, judgment: forged, lock: LOCK }), "EXCLUDED_UNIT", "u1");
});

const JUDGE_CASES = [
  ["juge absent (undefined)", undefined, "JUDGE_MISSING"],
  ["juge absent (null)", null, "JUDGE_MISSING"],
  ["juge non objet", "JUDGED", "JUDGE_MALFORMED"],
  ["juge sans results", { ...clone(J_U4), results: null }, "JUDGE_MALFORMED"],
  ["juge sans designated_unit_ids", { ...clone(J_U4), designated_unit_ids: undefined }, "JUDGE_MALFORMED"],
  ["juge en échec (FAILED)", { ...clone(J_U4), status: "FAILED" }, "JUDGE_NOT_JUDGED"],
  ["protocole du juge différent", { ...clone(J_U4), protocol: "coverage-judge.v1" }, "LOCK_MISMATCH"],
  ["version du juge différente du verrou", { ...clone(J_U4), version: "coverage-judge.v2+prompt.0" }, "LOCK_MISMATCH"],
  ["protocol_id absent", { ...clone(J_U4), protocol_id: null }, "PROTOCOL_MISSING"],
  ["protocol_id divergent", { ...clone(J_U4), protocol_id: "f".repeat(64) }, "PROTOCOL_MISMATCH"],
  ["lock_sha256 divergent", { ...clone(J_U4), lock_sha256: "0".repeat(64) }, "LOCK_SHA_MISMATCH"],
  ["voiceover_sha256 divergent", { ...clone(J_U4), voiceover_sha256: "0".repeat(64) }, "VOICEOVER_MISMATCH"],
  ["désignation du juge différente de la frontière", { ...clone(J_U4), designated_unit_ids: ["u1", "u2", "u4"] }, "DESIGNATION_MISMATCH"],
  ["NO_DESIGNATED_UNITS avec résultats", { ...clone(J_U4), status: "NO_DESIGNATED_UNITS" }, "JUDGE_MALFORMED"]
];

for (const [name, judgment, code] of JUDGE_CASES) {
  await test(`juge mal formé ou incohérent — ${name}`, () => expectRefused(plan(judgment), code));
}

const BOUNDARY_CASES = [
  ["frontière absente (undefined)", undefined, "BOUNDARY_MISSING"],
  ["frontière absente (null)", null, "BOUNDARY_MISSING"],
  ["frontière vide", {}, "BOUNDARY_MALFORMED"],
  ["frontière sans unités", { ...clone(BOUNDARY), units: [] }, "BOUNDARY_MALFORMED"],
  ["frontière en échec", { ...clone(BOUNDARY), status: "FAILED" }, "BOUNDARY_MALFORMED"],
  ["état d'unité inconnu", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).map((item, index) => (index === 0 ? { ...item, state: "ignored" } : item)) }, "BOUNDARY_MALFORMED"],
  ["identifiant d'unité renommé", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).map((item, index) => (index === 1 ? { ...item, unit_id: "u9" } : item)) }, "BOUNDARY_MALFORMED"],
  ["unités dans un ordre modifié", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).reverse() }, "BOUNDARY_MALFORMED"],
  ["protocol_id de la frontière absent", { ...clone(BOUNDARY), protocol_id: undefined }, "PROTOCOL_MISSING"],
  ["protocol_id de la frontière falsifié (identique au juge falsifié)", { ...clone(BOUNDARY), protocol_id: "f".repeat(64) }, "PROTOCOL_MISMATCH"],
  ["divergences de verrou dans la frontière", { ...clone(BOUNDARY), lock_divergences: [{ element: "classification" }] }, "LOCK_MISMATCH"],
  ["verrou recopié par la frontière différent", { ...clone(BOUNDARY), lock: { ...clone(BOUNDARY.lock), protection: "autre" } }, "LOCK_MISMATCH"],
  ["texte d'unité altéré", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).map((item, index) => (index === 3 ? { ...item, unit: { ...item.unit, text: "Autre." } } : item)) }, "VOICEOVER_MISMATCH"],
  ["analysed_unit_ids incohérents", { ...clone(BOUNDARY), analysed_unit_ids: ["u1", "u2"] }, "DESIGNATION_MISMATCH"]
];

for (const [name, boundary, code] of BOUNDARY_CASES) {
  await test(`frontière mal formée ou incohérente — ${name}`, () => {
    const judgment = name.includes("falsifié") ? { ...clone(J_U4), protocol_id: "f".repeat(64) } : J_U4;
    expectRefused(planCoverageRepair({ boundary, judgment, lock: LOCK }), code);
  });
}

await test("verrou mal formé — absent", () => {
  for (const lock of [undefined, null, "lock", []]) expectRefused(plan(J_U4, { lock }), "LOCK_MISSING");
});

await test("verrou mal formé — chaque élément absent ou vide", () => {
  for (const key of JUDGE_LOCK_KEYS) {
    const { [key]: _removed, ...partial } = LOCK;
    expectRefused(plan(J_U4, { lock: partial }), "LOCK_INCOMPLETE");
    expectRefused(plan(J_U4, { lock: { ...LOCK, [key]: "" } }), "LOCK_INCOMPLETE");
  }
});

await test("verrou divergent — baseline, juge, composant de la frontière", () => {
  expectRefused(plan(J_U4, { lock: { ...LOCK, baseline: "architecture-baseline-v1.0.2" } }), "LOCK_MISMATCH");
  expectRefused(plan(J_U4, { lock: { ...LOCK, judge: "coverage-judge.v2+prompt.0" } }), "LOCK_MISMATCH");
  for (const key of ["splitter", "normalization", "protection", "entities_rule_version", "entities_fingerprint", "classification", "language"]) {
    expectRefused(plan(J_U4, { lock: { ...LOCK, [key]: `${LOCK[key]}x` } }), "LOCK_MISMATCH");
  }
});

await test("sortie déterministe : octets identiques, indépendamment de l'historique", () => {
  const first = JSON.stringify(plan(J_U4));
  plan(J_DECLARE);
  plan(J_TWO, { lock: null });
  for (let round = 0; round < 5; round += 1) deepStrictEqual(JSON.stringify(plan(J_U4)), first);
  deepStrictEqual(JSON.stringify(planCoverageRepair({ boundary: clone(BOUNDARY), judgment: clone(J_U4), lock: clone(LOCK) })), first);
});

await test("idempotence : même plan à chaque exécution, sur tous les cas", () => {
  for (const judgment of [J_U4, J_NONE, J_TWO, J_ALL, J_DECLARE]) deepStrictEqual(JSON.stringify(plan(judgment)), JSON.stringify(plan(judgment)));
});

await test("entrées immuables : frontière, juge et verrou intacts ; entrées figées acceptées", () => {
  const boundary = clone(BOUNDARY);
  const judgment = clone(J_TWO);
  const lock = clone(LOCK);
  const snapshot = JSON.stringify([boundary, judgment, lock]);
  const result = planCoverageRepair({ boundary, judgment, lock });
  deepStrictEqual(JSON.stringify([boundary, judgment, lock]), snapshot);
  deepStrictEqual(result.status, "PLANNED");
  deepStrictEqual(JSON.stringify(plan(J_TWO)), JSON.stringify(result));
  if (!Object.isFrozen(BOUNDARY) || !Object.isFrozen(J_TWO)) throw new Error("précondition : entrées figées");
});

await test("sortie immuable", () => {
  const result = plan(J_TWO);
  if (!Object.isFrozen(result) || !Object.isFrozen(result.repair_plan) || !result.repair_plan.every(item => Object.isFrozen(item) && Object.isFrozen(item.claim_ids))) throw new Error("sortie modifiable");
});

await test("DELETE seul et aucun texte généré : seules des valeurs fermées en sortie", () => {
  const texts = [BASELINE_VOICEOVER, ...BOUNDARY.units.map(item => item.unit.text.trim()), "Le bassin couvre environ"];
  for (const result of [plan(J_U4), plan(J_TWO), plan(J_NONE), plan(J_ALL), plan(J_DECLARE)]) {
    const serialized = JSON.stringify(result);
    for (const text of texts) if (serialized.includes(text)) throw new Error(`texte présent : ${text}`);
    for (const item of result.repair_plan) {
      deepStrictEqual([item.action, item.reason, [...item.claim_ids]], ["DELETE", "JUDGED_UNCOVERED", []]);
      deepStrictEqual(Object.keys(item), ["unit_id", "action", "reason", "claim_ids"]);
    }
    for (const value of Object.values(result)) {
      if (typeof value === "string" && !/^([0-9a-f]{64}|coverage-repair\.v1|architecture-baseline-v1\.0\.3|PLANNED|NO_REPAIR|NOT_REPAIRABLE|INPUT_REFUSED)$/.test(value)) {
        throw new Error(`valeur libre : ${value}`);
      }
    }
  }
});

await test("ne lève jamais : entrées absentes ou aberrantes → INPUT_REFUSED", () => {
  expectRefused(planCoverageRepair(), "LOCK_MISSING");
  expectRefused(planCoverageRepair({}), "LOCK_MISSING");
  expectRefused(planCoverageRepair({ boundary: BOUNDARY, judgment: { ...clone(J_U4), results: [42] }, lock: LOCK }), "JUDGE_MALFORMED");
});

await test("imports limités, aucun réseau, aucun cache, aucune réécriture", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-repair.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ") || line.startsWith("} from ")), [
    'import crypto from "node:crypto";',
    "import {",
    '} from "./coverage-judge-v2.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["fetch(", "http", "createMessage", "call-guard", "discardCachedResponse", "cache", "splitCoverageUnits", "normalizeCoverageText", "protectCoverageUnit", "classifyCoverageUnit", "composeCoverageBoundary", "judgeSegmentCoverageV2", "replace(", "key_fact", "REWRITE", "INSERT"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
  deepStrictEqual(networkGuard.attempts().length, 0);
});

// R28.9A — verrou complet : éléments 9 (réparation) et 10 (coordinateur).
const OLD_LOCK = Object.freeze((({ repair, coordinator, ...rest }) => rest)(LOCK));

await test("R28.9A — version de réparation absente du verrou → LOCK_INCOMPLETE", () => {
  const { repair: _removed, ...partial } = LOCK;
  expectRefused(plan(J_U4, { lock: partial }), "LOCK_INCOMPLETE");
});

await test("R28.9A — version de réparation modifiée → LOCK_MISMATCH", () => {
  expectRefused(plan(J_U4, { lock: { ...LOCK, repair: "coverage-repair.v2" } }), "LOCK_MISMATCH");
});

await test("R28.9A — version du coordinateur absente du verrou → LOCK_INCOMPLETE", () => {
  const { coordinator: _removed, ...partial } = LOCK;
  expectRefused(plan(J_U4, { lock: partial }), "LOCK_INCOMPLETE");
});

await test("R28.9A — version du coordinateur modifiée → LOCK_SHA_MISMATCH (verdict lié à l'autre verrou)", () => {
  expectRefused(plan(J_U4, { lock: { ...LOCK, coordinator: "coverage-coordinator-policy.v2" } }), "LOCK_SHA_MISMATCH");
});

await test("R28.9A — rejeu avec l'ancien verrou refusé, verrou complet accepté", () => {
  expectRefused(plan(J_U4, { lock: OLD_LOCK }), "LOCK_INCOMPLETE");
  const result = plan(J_U4);
  deepStrictEqual([result.status, result.lock_sha256], ["PLANNED", judgeLockSha256(LOCK)]);
  if (judgeLockSha256(LOCK) === judgeLockSha256(OLD_LOCK)) throw new Error("empreinte inchangée");
});

// Copie isolée hors dépôt du module de réparation, avec des remplacements
// textuels facultatifs. Le juge v2 est importé depuis le dépôt.
async function isolatedRepair(prefix, replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let source = fs.readFileSync(new URL("../src/utils/coverage-repair.js", import.meta.url), "utf8")
    .replace('"./coverage-judge-v2.js"', JSON.stringify(pathToFileURL(new URL("../src/utils/coverage-judge-v2.js", import.meta.url).pathname).href));
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(root, "coverage-repair.js"), source);
  const module = await import(pathToFileURL(path.join(root, "coverage-repair.js")).href);
  return { root, module };
}

function behaviourFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  const run = (judgment, overrides = {}) => {
    try {
      const result = module.planCoverageRepair({ boundary: clone(BOUNDARY), judgment: clone(judgment), lock: clone(LOCK), ...overrides });
      return [result.status, result.refusal?.code ?? null, result.repair_plan.map(item => `${item.unit_id}:${item.action}`)];
    } catch (error) {
      return ["EXCEPTION", error.message, []];
    }
  };
  check("DELETE nominal", run(J_U4), ["PLANNED", null, ["u4:DELETE"]]);
  check("DECLARE refusé", run(J_DECLARE), ["INPUT_REFUSED", "DECLARE_NOT_SUPPORTED", []]);
  check("action inconnue refusée", run(VERDICT_CASES[0][1]), ["INPUT_REFUSED", "UNKNOWN_ACTION", []]);
  check("protocole vérifié", run({ ...clone(J_U4), protocol_id: "f".repeat(64) }), ["INPUT_REFUSED", "PROTOCOL_MISMATCH", []]);
  check("lock_sha256 vérifié", run({ ...clone(J_U4), lock_sha256: "0".repeat(64) }), ["INPUT_REFUSED", "LOCK_SHA_MISMATCH", []]);
  check("verrou vérifié", run(J_U4, { lock: { ...clone(LOCK), protection: "autre" } }), ["INPUT_REFUSED", "LOCK_MISMATCH", []]);
  const excludedForged = withResults(J_MIXED_NONE, results => [...results, { unit_id: "u1", verdict: "UNCOVERED", operation: { action: "DELETE", claim_id: null } }]);
  check("exclue refusée", run(excludedForged, { boundary: clone(MIXED) }), ["INPUT_REFUSED", "EXCLUDED_UNIT", []]);
  check("doublon refusé", run(VERDICT_CASES[5][1]), ["INPUT_REFUSED", "DUPLICATE_UNIT", []]);
  check("version de réparation verrouillée", run(J_U4, { lock: { ...clone(LOCK), repair: "coverage-repair.v2" } }), ["INPUT_REFUSED", "LOCK_MISMATCH", []]);
  const inputs = { boundary: clone(BOUNDARY), judgment: clone(J_TWO), lock: clone(LOCK) };
  const snapshot = JSON.stringify(inputs);
  try {
    module.planCoverageRepair(inputs);
  } catch {
    // une exception est déjà un échec du comportement attendu
  }
  check("entrées immuables", JSON.stringify(inputs), snapshot);
  return failures;
}

const MUTATIONS = [
  ["DELETE remplacé", [{ from: 'operations.push({ unit_id: unitId, action: "DELETE"', to: 'operations.push({ unit_id: unitId, action: "REWRITE"' }]],
  ["DECLARE accepté", [
    { from: "if (action === \"DECLARE\") refuse(REPAIR_REFUSAL.DECLARE_NOT_SUPPORTED, unitId);", to: "" },
    { from: "if (action !== \"DELETE\") refuse(REPAIR_REFUSAL.UNKNOWN_ACTION, unitId);", to: "if (action !== \"DELETE\" && action !== \"DECLARE\") refuse(REPAIR_REFUSAL.UNKNOWN_ACTION, unitId);" }
  ]],
  ["action inconnue acceptée", [{ from: "if (action !== \"DELETE\") refuse(REPAIR_REFUSAL.UNKNOWN_ACTION, unitId);", to: "" }]],
  ["protocole ignoré", [{ from: "if (judgment.protocol_id !== boundary.protocol_id || boundary.protocol_id !== expectedProtocolId) {", to: "if (false) {" }]],
  ["empreinte du verrou ignorée", [{ from: "if (judgment.lock_sha256 !== judgeLockSha256(lock)) refuse(REPAIR_REFUSAL.LOCK_SHA_MISMATCH);", to: "" }]],
  ["verrou de la frontière ignoré", [{ from: "if (boundary.lock_divergences.length > 0 || BOUNDARY_LOCK_ECHO.some(key => boundary.lock[key] !== lock[key])) {", to: "if (false) {" }]],
  ["unité exclue réparée", [{ from: 'if (states.get(unitId) === "excluded") refuse(REPAIR_REFUSAL.EXCLUDED_UNIT, unitId);', to: "" }, { from: "if (!designated.has(unitId)) refuse(REPAIR_REFUSAL.UNKNOWN_UNIT, unitId);", to: "" }]],
  ["doublons acceptés", [{ from: "if (seen.has(unitId)) refuse(REPAIR_REFUSAL.DUPLICATE_UNIT, unitId);", to: "" }]],
  ["version de réparation non verrouillée", [{ from: "if (lock.repair !== COVERAGE_REPAIR_VERSION) refuse(REPAIR_REFUSAL.LOCK_MISMATCH);", to: "" }]],
  ["entrées modifiées", [{ from: "    checkLock(lock);\n", to: "    if (lock && typeof lock === \"object\" && !Object.isFrozen(lock)) lock.repaired = true;\n    checkLock(lock);\n" }]]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt)", async () => {
  const control = await isolatedRepair("r28-8-control-");
  try {
    deepStrictEqual(behaviourFailures(control.module), [], "témoin");
  } finally {
    fs.rmSync(control.root, { recursive: true, force: true });
  }
  for (const [name, replacements] of MUTATIONS) {
    const mutant = await isolatedRepair("r28-8-mutant-", replacements);
    try {
      if (behaviourFailures(mutant.module).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      fs.rmSync(mutant.root, { recursive: true, force: true });
    }
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-repair-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
