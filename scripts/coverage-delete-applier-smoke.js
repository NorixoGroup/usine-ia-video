// Smoke R28.8A — application déterministe du plan DELETE (baseline v1.0.2,
// contrat 4.6), zéro API. Les plans viennent de la réparation R28.8 réelle,
// alimentée par le juge v2 réel avec un transport simulé ; aucun appel
// fournisseur, aucun réseau. Vérifie le voiceover réparé octet pour octet,
// l'empreinte, la traçabilité, les refus, le déterminisme, l'idempotence,
// l'immuabilité, l'absence de texte généré et des mutations avec témoin.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-delete-applier-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import {
  APPLY_REFUSAL,
  APPLY_STATUS,
  COVERAGE_DELETE_APPLIER_VERSION,
  applyCoverageDeletePlan
} from "../src/utils/coverage-delete-applier.js";
import { planCoverageRepair } from "../src/utils/coverage-repair.js";
import { coverageJudgeV2Version, judgeLockSha256, judgeSegmentCoverageV2 } from "../src/utils/coverage-judge-v2.js";
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
const LOCK = Object.freeze({ ...BOUNDARY_LOCK, judge: coverageJudgeV2Version(), repair: "coverage-repair.v1", coordinator: "coverage-coordinator-policy.v1", baseline: "architecture-baseline-v1.0.3" });
const boundaryOf = voiceover => composeCoverageBoundary({ voiceover, lock: BOUNDARY_LOCK, entities: ENTITIES });

async function repairOf(boundary, deletes = []) {
  const send = async request => {
    const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
    const data = {
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results: payload.designated_unit_ids.map(unit_id => deletes.includes(unit_id)
        ? { unit_id, verdict: "UNCOVERED", operations: [{ action: "DELETE" }] }
        : { unit_id, verdict: "COVERED", operations: [] })
    };
    return { request_sha256: "a".repeat(64), meta: { stop_reason: "end_turn" }, response: { content: [{ type: "text", text: JSON.stringify(data) }] } };
  };
  const judgment = await judgeSegmentCoverageV2({ boundary, lock: LOCK, claims: [{ text: "Le bassin couvre environ un million de kilomètres carrés." }], segmentId: "s2-g4", send });
  return planCoverageRepair({ boundary, judgment, lock: LOCK });
}

// Textes d'unités attendus, écrits en clair (espace final compris).
const T1 = "Mais avant cela, un détour. ";
const T2 = "Le bassin couvre environ un million de kilomètres carrés. ";
const T3 = "Ce n’est pas un hasard. ";
const T4 = "Sans lui, l’intérieur serait inhabitable.";
const BASELINE_VOICEOVER = T1 + T2 + T3 + T4;
const MIXED_VOICEOVER = "Imaginez la scène. Le bassin couvre environ un million de kilomètres carrés. Pourquoi ? Sans lui, l’intérieur serait inhabitable.";
const SPACED_VOICEOVER = "  Un fait   ici.  Le\tdésert avance.  ";

const BOUNDARY = boundaryOf(BASELINE_VOICEOVER);
const MIXED = boundaryOf(MIXED_VOICEOVER);
const SPACED = boundaryOf(SPACED_VOICEOVER);
const R = {
  none: await repairOf(BOUNDARY),
  u1: await repairOf(BOUNDARY, ["u1"]),
  u2: await repairOf(BOUNDARY, ["u2"]),
  u3: await repairOf(BOUNDARY, ["u3"]),
  u4: await repairOf(BOUNDARY, ["u4"]),
  u1u4: await repairOf(BOUNDARY, ["u1", "u4"]),
  u1u2u3: await repairOf(BOUNDARY, ["u1", "u2", "u3"]),
  all: await repairOf(BOUNDARY, ["u1", "u2", "u3", "u4"]),
  mixedAnalysed: await repairOf(MIXED, ["u2", "u4"]),
  spaced: await repairOf(SPACED, ["u1"])
};

const apply = (repair, overrides = {}) => applyCoverageDeletePlan({ boundary: BOUNDARY, repair, lock: LOCK, ...overrides });

function expectRefused(result, code, unitId = null) {
  deepStrictEqual(
    [result.status, result.refusal?.code, result.refusal?.unit_id, result.repaired_voiceover, result.repaired_voiceover_sha256, result.deleted_unit_ids.length, result.protocol_id],
    ["INPUT_REFUSED", code, unitId, null, null, 0, null]
  );
}

function expectApplied(result, repair, voiceover, deleted, remaining) {
  deepStrictEqual(clone(result), {
    protocol_id: repair.protocol_id,
    previous_voiceover_sha256: repair.voiceover_sha256,
    repaired_voiceover: voiceover,
    repaired_voiceover_sha256: sha256(voiceover),
    deleted_unit_ids: deleted,
    remaining_unit_ids: remaining,
    lock_sha256: repair.lock_sha256,
    repair_version: "coverage-repair.v1",
    baseline: "architecture-baseline-v1.0.3",
    status: deleted.length > 0 ? "APPLIED" : "UNCHANGED",
    refusal: null
  });
}

await test("constantes publiques : version, statuts, codes de refus", () => {
  deepStrictEqual(COVERAGE_DELETE_APPLIER_VERSION, "coverage-delete-applier.v1");
  deepStrictEqual(Object.values(APPLY_STATUS), ["APPLIED", "UNCHANGED", "INPUT_REFUSED"]);
  deepStrictEqual(Object.keys(APPLY_REFUSAL).length, 18);
  if (!Object.isFrozen(APPLY_STATUS) || !Object.isFrozen(APPLY_REFUSAL)) throw new Error("constante modifiable");
});

await test("préconditions : plans réels de la réparation R28.8", () => {
  deepStrictEqual(BOUNDARY.units.map(item => item.unit.text), [T1, T2, T3, T4]);
  deepStrictEqual([R.none.status, R.u4.status, R.u1u4.status, R.all.status, R.mixedAnalysed.status], ["NO_REPAIR", "PLANNED", "PLANNED", "NOT_REPAIRABLE", "PLANNED"]);
});

await test("DELETE nominal (dernière unité) : voiceover exact, espace final conservé", () => {
  expectApplied(apply(R.u4), R.u4, T1 + T2 + T3, ["u4"], ["u1", "u2", "u3"]);
});

await test("aucune suppression : plan vide → UNCHANGED, voiceover identique octet pour octet", () => {
  expectApplied(apply(R.none), R.none, BASELINE_VOICEOVER, [], ["u1", "u2", "u3", "u4"]);
  deepStrictEqual(apply(R.none).repaired_voiceover_sha256, BOUNDARY.voiceover_sha256);
});

await test("suppression de la première unité", () => {
  expectApplied(apply(R.u1), R.u1, T2 + T3 + T4, ["u1"], ["u2", "u3", "u4"]);
});

await test("suppression d'une unité du milieu (u2)", () => {
  expectApplied(apply(R.u2), R.u2, T1 + T3 + T4, ["u2"], ["u1", "u3", "u4"]);
});

await test("suppression d'une unité du milieu (u3)", () => {
  expectApplied(apply(R.u3), R.u3, T1 + T2 + T4, ["u3"], ["u1", "u2", "u4"]);
});

await test("suppressions multiples : ordre d'origine conservé", () => {
  expectApplied(apply(R.u1u4), R.u1u4, T2 + T3, ["u1", "u4"], ["u2", "u3"]);
  expectApplied(apply(R.u1u2u3), R.u1u2u3, T4, ["u1", "u2", "u3"], ["u4"]);
});

await test("toutes les unités analysées supprimées : les unités exclues restent, intactes", () => {
  const result = applyCoverageDeletePlan({ boundary: MIXED, repair: R.mixedAnalysed, lock: LOCK });
  expectApplied(result, R.mixedAnalysed, "Imaginez la scène. Pourquoi ? ", ["u2", "u4"], ["u1", "u3"]);
});

await test("espaces, insécables et tabulations conservés tels quels", () => {
  const result = applyCoverageDeletePlan({ boundary: SPACED, repair: R.spaced, lock: LOCK });
  const remaining = SPACED.units.slice(1).map(item => item.unit.text).join("");
  expectApplied(result, R.spaced, remaining, ["u1"], SPACED.units.slice(1).map(item => item.unit_id));
  deepStrictEqual(remaining, "Le\tdésert avance.  ");
});

await test("voiceover vide → INPUT_REFUSED : plan NOT_REPAIRABLE refusé", () => {
  expectRefused(apply(R.all), "REPAIR_NOT_APPLICABLE");
});

await test("voiceover vide → INPUT_REFUSED : plan forgé supprimant tout (EMPTY_RESULT)", () => {
  const forged = { ...clone(R.u1u2u3), repair_plan: ["u1", "u2", "u3", "u4"].map(unit_id => ({ unit_id, action: "DELETE", reason: "JUDGED_UNCOVERED", claim_ids: [] })), repaired_unit_ids: ["u1", "u2", "u3", "u4"], untouched_unit_ids: [] };
  expectRefused(apply(forged), "EMPTY_RESULT");
});

await test("ronde suivante : la frontière du voiceover réparé redonne les unités restantes", () => {
  for (const repair of [R.u4, R.u1, R.u1u4]) {
    const result = apply(repair);
    const next = boundaryOf(result.repaired_voiceover);
    deepStrictEqual(next.voiceover_sha256, result.repaired_voiceover_sha256);
    deepStrictEqual(next.units.map(item => item.unit.text), BOUNDARY.units.filter(item => result.remaining_unit_ids.includes(item.unit_id)).map(item => item.unit.text));
    deepStrictEqual(next.protocol_id, result.protocol_id);
  }
});

await test("empreinte réparée : SHA-256 UTF-8 du voiceover réparé, différente de la précédente", () => {
  for (const repair of [R.u1, R.u2, R.u3, R.u4, R.u1u4]) {
    const result = apply(repair);
    deepStrictEqual(result.repaired_voiceover_sha256, sha256(result.repaired_voiceover));
    if (result.repaired_voiceover_sha256 === result.previous_voiceover_sha256) throw new Error("empreinte inchangée");
  }
});

await test("propagation : protocol_id, lock_sha256, version et baseline repris de la réparation", () => {
  const result = apply(R.u4);
  deepStrictEqual([result.protocol_id, result.lock_sha256, result.repair_version, result.baseline], [BOUNDARY.protocol_id, judgeLockSha256(LOCK), "coverage-repair.v1", LOCK.baseline]);
});

const plannedPlan = () => clone(R.u4);
const OPERATION_CASES = [
  ["DECLARE", repair => ({ ...repair, repair_plan: [{ unit_id: "u4", action: "DECLARE", reason: "JUDGED_UNCOVERED", claim_ids: ["s2-g4-c1"] }] }), "DECLARE_NOT_SUPPORTED", "u4"],
  ["opération inconnue (REWRITE)", repair => ({ ...repair, repair_plan: [{ ...repair.repair_plan[0], action: "REWRITE" }] }), "UNKNOWN_OPERATION", "u4"],
  ["opération inconnue (MERGE)", repair => ({ ...repair, repair_plan: [{ ...repair.repair_plan[0], action: "MERGE" }] }), "UNKNOWN_OPERATION", "u4"],
  ["opération sans action", repair => ({ ...repair, repair_plan: [{ unit_id: "u4" }] }), "UNKNOWN_OPERATION", "u4"],
  ["DELETE dupliqué", repair => ({ ...repair, repair_plan: [repair.repair_plan[0], repair.repair_plan[0]] }), "DUPLICATE_DELETE", "u4"],
  ["unité inconnue", repair => ({ ...repair, repair_plan: [{ ...repair.repair_plan[0], unit_id: "u9" }], repaired_unit_ids: ["u9"] }), "UNKNOWN_UNIT", "u9"],
  ["unité déjà absente (non listée comme réparée)", repair => ({ ...repair, repaired_unit_ids: [] }), "ABSENT_UNIT", null],
  ["unités intactes incohérentes", repair => ({ ...repair, untouched_unit_ids: ["u1", "u2", "u3", "u4"] }), "ABSENT_UNIT", null],
  ["unités réparées désordonnées", repair => ({ ...clone(R.u1u4), repaired_unit_ids: ["u4", "u1"] }), "ABSENT_UNIT", null],
  ["opération nulle", repair => ({ ...repair, repair_plan: [null] }), "REPAIR_MALFORMED", null],
  ["opération sans unit_id", repair => ({ ...repair, repair_plan: [{ action: "DELETE" }] }), "REPAIR_MALFORMED", null],
  ["PLANNED sans opération", repair => ({ ...repair, repair_plan: [], repaired_unit_ids: [], untouched_unit_ids: ["u1", "u2", "u3", "u4"] }), "REPAIR_MALFORMED", null],
  ["NO_REPAIR avec opération", repair => ({ ...repair, status: "NO_REPAIR" }), "REPAIR_MALFORMED", null]
];

for (const [name, change, code, unitId] of OPERATION_CASES) {
  await test(`refus — ${name}`, () => expectRefused(apply(change(plannedPlan())), code, unitId));
}

await test("refus — suppression d'une unité exclue", () => {
  const forged = { ...clone(R.mixedAnalysed), repair_plan: [{ unit_id: "u1", action: "DELETE", reason: "JUDGED_UNCOVERED", claim_ids: [] }], repaired_unit_ids: ["u1"], untouched_unit_ids: ["u2", "u3", "u4"] };
  expectRefused(applyCoverageDeletePlan({ boundary: MIXED, repair: forged, lock: LOCK }), "EXCLUDED_UNIT", "u1");
});

const REPAIR_CASES = [
  ["réparation absente (undefined)", undefined, "REPAIR_MISSING"],
  ["réparation absente (null)", null, "REPAIR_MISSING"],
  ["réparation non objet", "PLANNED", "REPAIR_MALFORMED"],
  ["réparation sans plan", { ...clone(R.u4), repair_plan: null }, "REPAIR_MALFORMED"],
  ["réparation sans unités réparées", { ...clone(R.u4), repaired_unit_ids: undefined }, "REPAIR_MALFORMED"],
  ["version de réparation inconnue", { ...clone(R.u4), repair_version: "coverage-repair.v2" }, "REPAIR_MALFORMED"],
  ["réparation refusée (INPUT_REFUSED)", { ...clone(R.u4), status: "INPUT_REFUSED" }, "REPAIR_NOT_APPLICABLE"],
  ["statut de réparation inconnu", { ...clone(R.u4), status: "DONE" }, "REPAIR_NOT_APPLICABLE"],
  ["lock_sha256 absent", { ...clone(R.u4), lock_sha256: null }, "REPAIR_MALFORMED"],
  ["baseline de la réparation différente du verrou", { ...clone(R.u4), baseline: "architecture-baseline-v1.0.2" }, "LOCK_MISMATCH"],
  ["protocol_id différent de la frontière", { ...clone(R.u4), protocol_id: "f".repeat(64) }, "PROTOCOL_MISMATCH"],
  ["protocol_id absent", { ...clone(R.u4), protocol_id: null }, "PROTOCOL_MISMATCH"],
  ["voiceover_sha256 différent de la frontière", { ...clone(R.u4), voiceover_sha256: "0".repeat(64) }, "VOICEOVER_MISMATCH"],
  ["réparation d'une autre frontière", clone(R.mixedAnalysed), "VOICEOVER_MISMATCH"]
];

for (const [name, repair, code] of REPAIR_CASES) {
  await test(`réparation mal formée ou incohérente — ${name}`, () => expectRefused(apply(repair), code));
}

const BOUNDARY_CASES = [
  ["frontière absente (undefined)", undefined, "BOUNDARY_MISSING"],
  ["frontière absente (null)", null, "BOUNDARY_MISSING"],
  ["frontière vide", {}, "BOUNDARY_MALFORMED"],
  ["frontière en échec", { ...clone(BOUNDARY), status: "FAILED" }, "BOUNDARY_MALFORMED"],
  ["version de frontière inconnue", { ...clone(BOUNDARY), version: "composite-coverage-boundary.v2" }, "BOUNDARY_MALFORMED"],
  ["frontière sans unités", { ...clone(BOUNDARY), units: [] }, "BOUNDARY_MALFORMED"],
  ["unités désordonnées", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).reverse() }, "BOUNDARY_MALFORMED"],
  ["état d'unité inconnu", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).map((item, index) => (index === 0 ? { ...item, state: "x" } : item)) }, "BOUNDARY_MALFORMED"],
  ["unité de texte vide", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).map((item, index) => (index === 0 ? { ...item, unit: { ...item.unit, text: "" } } : item)) }, "BOUNDARY_MALFORMED"],
  ["texte d'unité altéré", { ...clone(BOUNDARY), units: clone(BOUNDARY.units).map((item, index) => (index === 3 ? { ...item, unit: { ...item.unit, text: "Autre." } } : item)) }, "VOICEOVER_MISMATCH"],
  ["empreinte du voiceover altérée", { ...clone(BOUNDARY), voiceover_sha256: "0".repeat(64) }, "VOICEOVER_MISMATCH"],
  ["divergences de verrou", { ...clone(BOUNDARY), lock_divergences: [{ element: "splitter" }] }, "LOCK_MISMATCH"],
  ["protocol_id de la frontière modifié", { ...clone(BOUNDARY), protocol_id: "f".repeat(64) }, "PROTOCOL_MISMATCH"]
];

for (const [name, boundary, code] of BOUNDARY_CASES) {
  await test(`frontière mal formée ou incohérente — ${name}`, () => expectRefused(applyCoverageDeletePlan({ boundary, repair: R.u4, lock: LOCK }), code));
}

await test("verrou mal formé — absent", () => {
  for (const lock of [undefined, null, "lock", []]) expectRefused(apply(R.u4, { lock }), "LOCK_MISSING");
});

await test("verrou mal formé — chaque élément absent ou vide", () => {
  for (const key of Object.keys(LOCK)) {
    const { [key]: _removed, ...partial } = LOCK;
    expectRefused(apply(R.u4, { lock: partial }), "LOCK_INCOMPLETE");
    expectRefused(apply(R.u4, { lock: { ...LOCK, [key]: "" } }), "LOCK_INCOMPLETE");
  }
});

await test("verrou divergent — composants de la frontière et baseline", () => {
  for (const key of ["splitter", "normalization", "protection", "entities_rule_version", "entities_fingerprint", "classification", "language", "baseline"]) {
    expectRefused(apply(R.u4, { lock: { ...LOCK, [key]: `${LOCK[key]}x` } }), "LOCK_MISMATCH");
  }
});

await test("sortie déterministe : octets identiques, indépendamment de l'historique", () => {
  const first = JSON.stringify(apply(R.u1u4));
  apply(R.all);
  apply(R.u4, { lock: null });
  for (let round = 0; round < 5; round += 1) deepStrictEqual(JSON.stringify(apply(R.u1u4)), first);
  deepStrictEqual(JSON.stringify(applyCoverageDeletePlan({ boundary: clone(BOUNDARY), repair: clone(R.u1u4), lock: clone(LOCK) })), first);
});

await test("idempotence : même résultat à chaque application, sur tous les plans", () => {
  for (const repair of Object.values(R)) deepStrictEqual(JSON.stringify(apply(repair)), JSON.stringify(apply(repair)));
});

await test("entrées immuables : frontière, réparation et verrou intacts ; entrées figées acceptées", () => {
  const inputs = { boundary: clone(BOUNDARY), repair: clone(R.u1u4), lock: clone(LOCK) };
  const snapshot = JSON.stringify(inputs);
  const result = applyCoverageDeletePlan(inputs);
  deepStrictEqual(JSON.stringify(inputs), snapshot);
  deepStrictEqual(JSON.stringify(apply(R.u1u4)), JSON.stringify(result));
  if (!Object.isFrozen(BOUNDARY) || !Object.isFrozen(R.u1u4)) throw new Error("précondition : entrées figées");
});

await test("sortie immuable (y compris en refus)", () => {
  for (const result of [apply(R.u1u4), apply(R.all)]) {
    if (!Object.isFrozen(result) || !Object.isFrozen(result.deleted_unit_ids) || !Object.isFrozen(result.remaining_unit_ids)) throw new Error("sortie modifiable");
  }
});

await test("aucun texte généré : le voiceover réparé n'est fait que de textes d'unités, sans caractère ajouté", () => {
  for (const repair of [R.u1, R.u2, R.u3, R.u4, R.u1u4, R.u1u2u3, R.none]) {
    const result = apply(repair);
    const expected = BOUNDARY.units.filter(item => !result.deleted_unit_ids.includes(item.unit_id)).map(item => item.unit.text).join("");
    deepStrictEqual(result.repaired_voiceover, expected);
    if (BASELINE_VOICEOVER.length - result.repaired_voiceover.length !== BOUNDARY.units.filter(item => result.deleted_unit_ids.includes(item.unit_id)).reduce((total, item) => total + item.unit.text.length, 0)) {
      throw new Error("longueur incohérente");
    }
  }
});

await test("ne lève jamais : entrées absentes ou aberrantes → INPUT_REFUSED", () => {
  expectRefused(applyCoverageDeletePlan(), "LOCK_MISSING");
  expectRefused(applyCoverageDeletePlan({}), "LOCK_MISSING");
  expectRefused(apply({ ...clone(R.u4), repair_plan: [42] }), "REPAIR_MALFORMED");
});

await test("imports limités, aucun réseau, aucun cache, aucune réécriture", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-delete-applier.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")), [
    'import crypto from "node:crypto";',
    'import { BOUNDARY_LOCK_KEYS, COMPOSITE_COVERAGE_BOUNDARY_VERSION } from "./composite-coverage-boundary.js";',
    'import { COVERAGE_REPAIR_VERSION, REPAIR_STATUS } from "./coverage-repair.js";',
    'import { JUDGE_LOCK_KEYS, judgeLockSha256 } from "./coverage-judge-v2.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["fetch(", "http", "createMessage", "call-guard", "cache", "replace(", "trim(", "normalize", "toLowerCase", "boundaryProtocolIdFromLock", "composeCoverageBoundary", "planCoverageRepair", "+ \" \"", "join(\" \")"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
  deepStrictEqual(networkGuard.attempts().length, 0);
});

// R28.9A — verrou complet : éléments 9 (réparation) et 10 (coordinateur).
const OLD_LOCK = Object.freeze((({ repair, coordinator, ...rest }) => rest)(LOCK));

await test("R28.9A — version de réparation absente du verrou → LOCK_INCOMPLETE", () => {
  const { repair: _removed, ...partial } = LOCK;
  expectRefused(apply(R.u4, { lock: partial }), "LOCK_INCOMPLETE");
});

await test("R28.9A — version de réparation modifiée → LOCK_MISMATCH", () => {
  expectRefused(apply(R.u4, { lock: { ...LOCK, repair: "coverage-repair.v2" } }), "LOCK_MISMATCH");
});

await test("R28.9A — version du coordinateur absente du verrou → LOCK_INCOMPLETE", () => {
  const { coordinator: _removed, ...partial } = LOCK;
  expectRefused(apply(R.u4, { lock: partial }), "LOCK_INCOMPLETE");
});

await test("R28.9A — version du coordinateur modifiée → LOCK_SHA_MISMATCH", () => {
  expectRefused(apply(R.u4, { lock: { ...LOCK, coordinator: "coverage-coordinator-policy.v2" } }), "LOCK_SHA_MISMATCH");
});

await test("R28.9A — lock_sha256 de la réparation falsifié → LOCK_SHA_MISMATCH", () => {
  expectRefused(apply({ ...clone(R.u4), lock_sha256: "0".repeat(64) }), "LOCK_SHA_MISMATCH");
});

await test("R28.9A — rejeu avec l'ancien verrou refusé, verrou complet accepté", () => {
  expectRefused(apply(R.u4, { lock: OLD_LOCK }), "LOCK_INCOMPLETE");
  const result = apply(R.u4);
  deepStrictEqual([result.status, result.lock_sha256], ["APPLIED", judgeLockSha256(LOCK)]);
});

// Copie isolée hors dépôt de l'applicateur, avec des remplacements textuels.
async function isolatedApplier(prefix, replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let source = fs.readFileSync(new URL("../src/utils/coverage-delete-applier.js", import.meta.url), "utf8");
  for (const name of ["composite-coverage-boundary.js", "coverage-repair.js", "coverage-judge-v2.js"]) {
    source = source.replace(`"./${name}"`, JSON.stringify(pathToFileURL(new URL(`../src/utils/${name}`, import.meta.url).pathname).href));
  }
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(root, "coverage-delete-applier.js"), source);
  const module = await import(pathToFileURL(path.join(root, "coverage-delete-applier.js")).href);
  return { root, module };
}

function behaviourFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  const run = (repair, overrides = {}) => {
    try {
      return module.applyCoverageDeletePlan({ boundary: clone(BOUNDARY), repair: clone(repair), lock: clone(LOCK), ...overrides });
    } catch (error) {
      return { status: "EXCEPTION", error: error.message };
    }
  };
  const u4 = run(R.u4);
  check("suppression appliquée", [u4.status, u4.repaired_voiceover], ["APPLIED", T1 + T2 + T3]);
  check("empreinte réparée", u4.repaired_voiceover_sha256, sha256(T1 + T2 + T3));
  check("protocole propagé", u4.protocol_id, R.u4.protocol_id);
  check("verrou propagé", u4.lock_sha256, R.u4.lock_sha256);
  const multi = run(R.u1u4);
  check("ordre conservé", multi.repaired_voiceover, T2 + T3);
  const spaced = module.applyCoverageDeletePlan({ boundary: clone(SPACED), repair: clone(R.spaced), lock: clone(LOCK) });
  check("espaces conservés", spaced.repaired_voiceover, "Le\tdésert avance.  ");
  check("doublon refusé", run({ ...clone(R.u4), repair_plan: [R.u4.repair_plan[0], R.u4.repair_plan[0]] }).status, "INPUT_REFUSED");
  check("lock_sha256 vérifié", run({ ...clone(R.u4), lock_sha256: "0".repeat(64) }).refusal?.code, "LOCK_SHA_MISMATCH");
  check("version de réparation verrouillée", run(R.u4, { lock: { ...clone(LOCK), repair: "coverage-repair.v2" } }).refusal?.code, "LOCK_MISMATCH");
  check("sortie figée", Object.isFrozen(u4), true);
  const inputs = { boundary: clone(BOUNDARY), repair: clone(R.u1u4), lock: clone(LOCK) };
  const snapshot = JSON.stringify(inputs);
  try {
    module.applyCoverageDeletePlan(inputs);
  } catch {
    // une exception est déjà un échec du comportement attendu
  }
  check("entrées immuables", JSON.stringify(inputs), snapshot);
  return failures;
}

const MUTATIONS = [
  ["suppression ignorée", [{ from: "const remaining = boundary.units.filter(item => !deleted.includes(item.unit_id));", to: "const remaining = boundary.units.filter(() => true);" }]],
  ["suppression dupliquée acceptée", [{ from: "if (deleted.includes(unitId)) refuse(APPLY_REFUSAL.DUPLICATE_DELETE, unitId);\n    deleted.push(unitId);", to: "deleted.push(unitId);" }, { from: "const ordered = allIds.filter(id => deleted.includes(id));", to: "const ordered = deleted;" }, { from: "if (!sameList(repair.repaired_unit_ids, ordered)) refuse(APPLY_REFUSAL.ABSENT_UNIT);", to: "" }]],
  ["unités réordonnées", [{ from: "const repaired = remaining.map(item => item.unit.text).join(\"\");", to: "const repaired = [...remaining].reverse().map(item => item.unit.text).join(\"\");" }]],
  ["texte réécrit", [{ from: "const repaired = remaining.map(item => item.unit.text).join(\"\");", to: "const repaired = remaining.map(item => item.unit.text.toUpperCase()).join(\"\");" }]],
  ["espaces retirés", [{ from: "const repaired = remaining.map(item => item.unit.text).join(\"\");", to: "const repaired = remaining.map(item => item.unit.text.trim()).join(\" \");" }]],
  ["protocole recalculé", [{ from: "protocol_id: repair.protocol_id,\n      previous_voiceover_sha256", to: "protocol_id: sha256(JSON.stringify(lock)),\n      previous_voiceover_sha256" }]],
  ["verrou recalculé", [{ from: "lock_sha256: repair.lock_sha256,", to: "lock_sha256: sha256(JSON.stringify(lock))," }]],
  ["sortie modifiable", [{ from: "    return freezeAll({\n      protocol_id: repair.protocol_id,", to: "    return ({\n      protocol_id: repair.protocol_id," }]],
  ["entrées modifiées", [{ from: "    checkLock(lock);\n", to: "    if (lock && typeof lock === \"object\" && !Object.isFrozen(lock)) lock.applied = true;\n    checkLock(lock);\n" }]],
  ["lock_sha256 non vérifié", [{ from: "if (repair.lock_sha256 !== judgeLockSha256(lock)) refuse(APPLY_REFUSAL.LOCK_SHA_MISMATCH);", to: "" }]],
  ["version de réparation non verrouillée", [{ from: " || lock.repair !== repair.repair_version", to: "" }]],
  ["empreinte réparée fausse", [{ from: "repaired_voiceover_sha256: sha256(repaired),", to: "repaired_voiceover_sha256: sha256(`${repaired} `)," }]]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt)", async () => {
  const control = await isolatedApplier("r28-8a-control-");
  try {
    deepStrictEqual(behaviourFailures(control.module), [], "témoin");
  } finally {
    fs.rmSync(control.root, { recursive: true, force: true });
  }
  for (const [name, replacements] of MUTATIONS) {
    const mutant = await isolatedApplier("r28-8a-mutant-", replacements);
    try {
      if (behaviourFailures(mutant.module).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      fs.rmSync(mutant.root, { recursive: true, force: true });
    }
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-delete-applier-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
