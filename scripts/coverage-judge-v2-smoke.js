// Smoke R28.6 — juge de couverture v2 par identifiants d'unités (baseline
// v1.0.1, contrat 4.5 ; I8, I16, I17, I22, I23), zéro API. Le transport est
// toujours simulé : aucun appel fournisseur, aucun accès réseau. Vérifie le
// protocole nominal, la requête (unités sans position ni texte), la liaison
// au protocol_id, au voiceover_sha256 et au verrou complet, la désignation,
// les bornes, la validation stricte des réponses, les refus qualifiés,
// l'échec fermé, le déterminisme, l'idempotence, et des mutations avec
// témoin (copies hors dépôt, reproductibles depuis ce smoke).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-judge-v2-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepStrictEqual, notEqual } from "node:assert/strict";

import {
  COVERAGE_JUDGE_V2_PROTOCOL,
  COVERAGE_JUDGE_V2_RULES_VERSION,
  JUDGE_BOUNDS,
  JUDGE_FAILURE,
  JUDGE_STATUS,
  coverageJudgeV2Version,
  judgeSegmentCoverageV2
} from "../src/utils/coverage-judge-v2.js";
import {
  ARCHITECTURE_BASELINE_VERSION,
  COMPOSITE_COVERAGE_BOUNDARY_VERSION,
  COVERAGE_LOCK_KEYS,
  boundaryProtocolIdFromLock,
  lockSha256
} from "../src/utils/coverage-lock.js";
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

// Version publique écrite en clair : elle fige le prompt, le format et les bornes.
const V2 = "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60";

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
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
const LOCK = Object.freeze({ ...BOUNDARY_LOCK, judge: V2, repair: "coverage-repair.v1", coordinator: "coverage-coordinator-policy.v1", baseline: "architecture-baseline-v1.0.3" });

// Exemple de la baseline (section 11), segment s2-g4.
const BASELINE_VOICEOVER =
  "Mais avant cela, un détour. Le bassin couvre environ un million de kilomètres carrés. Ce n’est pas un hasard. Sans lui, l’intérieur serait inhabitable.";
const BASELINE_CLAIMS = [{ text: "Le bassin couvre environ un million de kilomètres carrés." }];
const boundaryOf = (voiceover, lock = BOUNDARY_LOCK) => composeCoverageBoundary({ voiceover, lock, entities: ENTITIES });
const BOUNDARY = boundaryOf(BASELINE_VOICEOVER);

// Transport simulé : lit la requête, produit une réponse conforme (u4 non
// couverte, DELETE ; le reste couvert), puis applique une altération.
function model({ alter = data => data, uncovered = { u4: [{ action: "DELETE" }] }, meta = {}, raw = null, throws = null } = {}) {
  const calls = [];
  const send = async request => {
    calls.push(request);
    if (throws) throw new Error(throws);
    const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
    const data = {
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results: payload.designated_unit_ids.map(unit_id => uncovered[unit_id]
        ? { unit_id, verdict: "UNCOVERED", operations: uncovered[unit_id] }
        : { unit_id, verdict: "COVERED", operations: [] })
    };
    const text = raw ?? JSON.stringify(alter(data), null, 2);
    return {
      request_sha256: sha256(JSON.stringify(request)),
      meta: { stop_reason: "end_turn", input_tokens: 1, output_tokens: 1, ...meta },
      response: { content: [{ type: "text", text }] }
    };
  };
  return { send, calls };
}

const judge = (overrides = {}, transport = model()) => judgeSegmentCoverageV2({
  boundary: BOUNDARY,
  lock: LOCK,
  claims: BASELINE_CLAIMS,
  segmentId: "s2-g4",
  send: transport.send,
  ...overrides
});
const payloadOf = transport => JSON.parse(transport.calls[0].messages[0].content.slice(HEADER.length));

async function expectRefused(overrides, reasonPrefix, transport = model()) {
  const result = await judge(overrides, transport);
  deepStrictEqual([result.status, result.failure?.category, result.results.length], ["FAILED", "INPUT_REFUSED", 0], reasonPrefix);
  if (!result.failure.reason.startsWith(reasonPrefix)) throw new Error(`raison : ${result.failure.reason}`);
  deepStrictEqual(transport.calls.length, 0, "aucun appel attendu");
  return result;
}

async function expectNotJudged(transportOptions, reasonPrefix) {
  const transport = model(transportOptions);
  const result = await judge({}, transport);
  deepStrictEqual([result.status, result.failure?.category, result.results.length], ["FAILED", "NOT_JUDGED", 0], reasonPrefix);
  if (!result.failure.reason.startsWith(reasonPrefix)) throw new Error(`raison : ${result.failure.reason}`);
  deepStrictEqual(transport.calls.length, 1);
  return result;
}

await test("constantes publiques : protocole, version, verrou, bornes, statuts", () => {
  deepStrictEqual(COVERAGE_JUDGE_V2_PROTOCOL, "coverage-judge.v2-unit-ids");
  deepStrictEqual(COVERAGE_JUDGE_V2_RULES_VERSION, "coverage-judge.v2");
  deepStrictEqual(ARCHITECTURE_BASELINE_VERSION, "architecture-baseline-v1.0.3");
  deepStrictEqual(coverageJudgeV2Version(), V2);
  deepStrictEqual([...COVERAGE_LOCK_KEYS], [
    "splitter", "normalization", "protection", "entities_rule_version", "entities_fingerprint",
    "classification", "judge", "repair", "coordinator", "language", "baseline"
  ]);
  deepStrictEqual(plain(JUDGE_BOUNDS), {
    max_tokens: 2000, output_token_budget: 1400, output_envelope_chars: 340, output_entry_chars: 140,
    output_chars_per_token: 3, max_input_chars: 12000, max_claims: 24
  });
  deepStrictEqual(Object.values(JUDGE_STATUS), ["JUDGED", "NO_DESIGNATED_UNITS", "FAILED"]);
  deepStrictEqual(Object.values(JUDGE_FAILURE), ["INPUT_REFUSED", "OUT_OF_BOUNDS", "NOT_JUDGED"]);
});

await test("fonctionnement nominal : exemple de la baseline, u4 non couverte (DELETE)", async () => {
  const transport = model();
  const result = await judge({}, transport);
  deepStrictEqual(result.status, "JUDGED");
  deepStrictEqual(plain(result.results), [
    { unit_id: "u1", verdict: "COVERED", operation: null },
    { unit_id: "u2", verdict: "COVERED", operation: null },
    { unit_id: "u3", verdict: "COVERED", operation: null },
    { unit_id: "u4", verdict: "UNCOVERED", operation: { action: "DELETE", claim_id: null } }
  ]);
  deepStrictEqual(
    [result.protocol_id, result.voiceover_sha256, result.lock_sha256, result.segment_id, result.version],
    [BOUNDARY.protocol_id, sha256(BASELINE_VOICEOVER), lockSha256(LOCK), "s2-g4", V2]
  );
  deepStrictEqual(result.request_sha256, sha256(JSON.stringify(transport.calls[0])));
});

await test("liaison au verrou complet : lock_sha256 couvre chaque élément du verrou", () => {
  const base = lockSha256(LOCK);
  if (!/^[0-9a-f]{64}$/.test(base)) throw new Error("format");
  for (const key of COVERAGE_LOCK_KEYS) {
    if (lockSha256({ ...LOCK, [key]: `${LOCK[key]}x` }) === base) throw new Error(`élément non couvert : ${key}`);
  }
  deepStrictEqual(lockSha256({ ...LOCK, extra: "ignoré" }), base);
});

await test("requête : un seul appel (I23), voiceover exact une seule fois (I8), unités sans position ni texte", async () => {
  const transport = model();
  await judge({}, transport);
  deepStrictEqual(transport.calls.length, 1);
  const request = transport.calls[0];
  deepStrictEqual([request.maxTokens, request.temperature, request.messages.length, request.messages[0].role], [2000, 0, 1, "user"]);
  deepStrictEqual(request.messages[0].content.split(BASELINE_VOICEOVER).length - 1, 1);
  const payload = payloadOf(transport);
  deepStrictEqual(Object.keys(payload), ["protocol", "protocol_id", "voiceover_sha256", "lock_sha256", "segment_id", "voiceover", "units", "designated_unit_ids", "claims"]);
  deepStrictEqual(payload.voiceover, BASELINE_VOICEOVER);
  deepStrictEqual(plain(payload.units), [
    { unit_id: "u1", type: "phrase" }, { unit_id: "u2", type: "phrase" },
    { unit_id: "u3", type: "phrase" }, { unit_id: "u4", type: "phrase" }
  ]);
  deepStrictEqual(plain(payload.claims), [{ claim_id: "s2-g4-c1", text: BASELINE_CLAIMS[0].text }]);
  deepStrictEqual(payload.lock_sha256, lockSha256(LOCK));
});

await test("propagation exacte des unit_id et désignation (I22) : unités exclues jamais désignées", async () => {
  const boundary = boundaryOf("Imaginez la scène. Le bassin couvre environ un million de kilomètres carrés. Pourquoi ? Sans lui, l’intérieur serait inhabitable.");
  const transport = model({ uncovered: { u4: [{ action: "DELETE" }] } });
  const result = await judge({ boundary }, transport);
  deepStrictEqual([...boundary.excluded_unit_ids], ["u1", "u3"]);
  deepStrictEqual([...payloadOf(transport).designated_unit_ids], ["u2", "u4"]);
  deepStrictEqual([...result.designated_unit_ids], ["u2", "u4"]);
  deepStrictEqual(result.results.map(item => [item.unit_id, item.verdict]), [["u2", "COVERED"], ["u4", "UNCOVERED"]]);
  const answeringExcluded = model({ alter: data => ({ ...data, results: [...data.results, { unit_id: "u1", verdict: "COVERED", operations: [] }] }) });
  const rejected = await judge({ boundary }, answeringExcluded);
  deepStrictEqual([rejected.failure.category, rejected.failure.reason], ["NOT_JUDGED", "unité inconnue ou non désignée : u1"]);
});

await test("analysed_unit_ids vide → segment couvert sans appel", async () => {
  const transport = model();
  const result = await judge({ boundary: boundaryOf("Imaginez la scène. Pourquoi ?") }, transport);
  deepStrictEqual([result.status, result.results.length, transport.calls.length], ["NO_DESIGNATED_UNITS", 0, 0]);
});

await test("ordre des unités modifié dans la réponse : accepté, résultats rangés dans l'ordre désigné", async () => {
  const result = await judge({}, model({ alter: data => ({ ...data, results: [...data.results].reverse() }) }));
  deepStrictEqual([result.status, result.results.map(item => item.unit_id)], ["JUDGED", ["u1", "u2", "u3", "u4"]]);
});

await test("aucune réparation, aucune citation, aucun offset dans la sortie", async () => {
  const declared = await judge({}, model({ uncovered: { u4: [{ action: "DECLARE", claim_id: "s2-g4-c1" }] } }));
  deepStrictEqual(plain(declared.results[3]), { unit_id: "u4", verdict: "UNCOVERED", operation: { action: "DECLARE", claim_id: "s2-g4-c1" } });
  const serialized = JSON.stringify(declared);
  for (const forbidden of [BASELINE_VOICEOVER, "Sans lui", BASELINE_CLAIMS[0].text, "\"start\"", "\"end\"", "\"text\"", "\"sentence\"", "\"voiceover\""]) {
    if (serialized.includes(forbidden)) throw new Error(`sortie contient : ${forbidden}`);
  }
  deepStrictEqual(Object.keys(declared), [
    "version", "protocol", "protocol_id", "voiceover_sha256", "lock_sha256", "segment_id",
    "designated_unit_ids", "bounds", "status", "failure", "request_sha256", "usage", "results"
  ]);
  const deleted = await judge({}, model({ uncovered: { u4: [{ action: "DELETE", claim_id: "n'importe" }] } }));
  deepStrictEqual(plain(deleted.results[3].operation), { action: "DELETE", claim_id: null });
});

await test("déterminisme et idempotence : même requête, même résultat, indépendamment de l'historique", async () => {
  const first = model();
  const a = await judge({}, first);
  await judge({ boundary: boundaryOf("Le désert avance. La côte est humide.") }, model());
  const second = model();
  const b = await judge({}, second);
  deepStrictEqual(JSON.stringify(first.calls), JSON.stringify(second.calls));
  deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
});

const RESPONSE_CASES = [
  ["protocol_id divergent", { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) }, "protocol_id différent"],
  ["voiceover_sha256 divergent", { alter: data => ({ ...data, voiceover_sha256: "0".repeat(64) }) }, "voiceover_sha256 différent"],
  ["lock_sha256 divergent", { alter: data => ({ ...data, lock_sha256: "0".repeat(64) }) }, "lock_sha256 différent"],
  ["lock_sha256 absent", { alter: ({ lock_sha256, ...data }) => data }, "enveloppe hors schéma"],
  ["segment divergent", { alter: data => ({ ...data, segment_id: "s9-g9" }) }, "segment_id différent"],
  ["unité absente", { alter: data => ({ ...data, results: data.results.slice(1) }) }, "unité absente : u1"],
  ["unité inconnue", { alter: data => ({ ...data, results: [...data.results, { unit_id: "u9", verdict: "COVERED", operations: [] }] }) }, "unité inconnue ou non désignée : u9"],
  ["identifiant dupliqué", { alter: data => ({ ...data, results: [...data.results, data.results[0]] }) }, "unité dupliquée : u1"],
  ["réponse sans unit_id", { alter: data => ({ ...data, results: data.results.map(({ unit_id, ...rest }, index) => (index === 0 ? { id: unit_id, ...rest } : { unit_id, ...rest })) }) }, "résultat 1 hors schéma"],
  ["citation textuelle", { alter: data => ({ ...data, results: data.results.map(item => ({ ...item, sentence: "Sans lui, l’intérieur serait inhabitable." })) }) }, "résultat 1 hors schéma"],
  ["offset", { alter: data => ({ ...data, results: data.results.map(item => ({ ...item, start: 0 })) }) }, "résultat 1 hors schéma"],
  ["texte de réparation", { uncovered: { u4: [{ action: "DELETE", replacement: "Texte réparé." }] } }, "u4 : opération hors schéma"],
  ["champ d'enveloppe supplémentaire", { alter: data => ({ ...data, comment: "ok" }) }, "enveloppe hors schéma"],
  ["verdict inconnu", { alter: data => ({ ...data, results: data.results.map(item => ({ ...item, verdict: "PARTIAL" })) }) }, "u1 : verdict invalide"],
  ["COVERED avec opération", { alter: data => ({ ...data, results: data.results.map(item => ({ ...item, verdict: "COVERED", operations: [{ action: "DELETE" }] })) }) }, "u1 : COVERED avec opération"],
  ["UNCOVERED sans opération", { uncovered: { u4: [] } }, "u4 : UNCOVERED exige exactement une opération"],
  ["deux opérations", { uncovered: { u4: [{ action: "DELETE" }, { action: "DELETE" }] } }, "u4 : UNCOVERED exige exactement une opération"],
  ["DECLARE claim_id inconnu", { uncovered: { u4: [{ action: "DECLARE", claim_id: "s2-g4-c9" }] } }, "u4 : claim_id inconnu"],
  ["DECLARE sans claim_id", { uncovered: { u4: [{ action: "DECLARE" }] } }, "u4 : opération hors schéma"],
  ["action de réécriture", { uncovered: { u4: [{ action: "REWRITE" }] } }, "u4 : action invalide"],
  ["réponse tronquée", { meta: { stop_reason: "max_tokens" } }, "réponse tronquée"],
  ["JSON illisible", { raw: "{ \"protocol_id\": " }, "JSON illisible"],
  ["réponse vide", { raw: "" }, "JSON illisible"],
  ["résultats absents", { alter: data => ({ ...data, results: null }) }, "results absent"]
];

for (const [name, options, reason] of RESPONSE_CASES) {
  await test(`échec fermé, réponse rejetée (NOT_JUDGED, rejet signalé) — ${name}`, async () => {
    const result = await expectNotJudged(options, reason);
    if (!/^[0-9a-f]{64}$/.test(result.request_sha256 ?? "")) throw new Error("rejet non signalé (request_sha256)");
  });
}

await test("échec fermé : appel en échec → NOT_JUDGED, sans empreinte de requête", async () => {
  const result = await expectNotJudged({ throws: "réseau indisponible" }, "appel en échec — réseau indisponible");
  deepStrictEqual(result.request_sha256, null);
});

await test("composants absents : transport ou frontière → refus explicite", async () => {
  for (const send of [undefined, null, "createMessage", {}]) {
    const result = await judgeSegmentCoverageV2({ boundary: BOUNDARY, lock: LOCK, claims: BASELINE_CLAIMS, segmentId: "s2-g4", send });
    deepStrictEqual([result.status, result.failure.category, result.failure.reason], ["FAILED", "INPUT_REFUSED", "composant absent : transport"]);
  }
  await expectRefused({ boundary: null }, "composant absent : frontière");
  await expectRefused({ boundary: undefined }, "composant absent : frontière");
});

await test("verrou absent ou incomplet (dont version du juge absente) → refus explicite", async () => {
  await expectRefused({ lock: null }, "verrou absent");
  for (const key of COVERAGE_LOCK_KEYS) {
    const { [key]: _removed, ...partial } = LOCK;
    await expectRefused({ lock: partial }, `verrou incomplet : ${key}`);
    await expectRefused({ lock: { ...LOCK, [key]: "" } }, `verrou incomplet : ${key}`);
  }
});

await test("versions divergentes : juge, baseline et chaque composant de la frontière", async () => {
  await expectRefused({ lock: { ...LOCK, judge: `${V2}x` } }, "version divergente : judge");
  await expectRefused({ lock: { ...LOCK, baseline: "architecture-baseline-v1.0.2" } }, "version divergente : baseline");
  for (const key of ["splitter", "normalization", "protection", "classification", "entities_rule_version", "language"]) {
    await expectRefused({ lock: { ...LOCK, [key]: `${LOCK[key]}x` } }, `version divergente : ${key}`);
  }
});

await test("incohérences de verrou dans la frontière → refus explicite", async () => {
  const divergentBoundary = boundaryOf(BASELINE_VOICEOVER, { ...BOUNDARY_LOCK, classification: `${BOUNDARY_LOCK.classification}x` });
  await expectRefused({ boundary: divergentBoundary }, "incohérence de verrou dans la frontière");
  await expectRefused({ boundary: { ...BOUNDARY, lock: { ...BOUNDARY.lock, entities_fingerprint: "0".repeat(64) } } }, "incohérence de verrou dans la frontière : entities_fingerprint");
  await expectRefused({ boundary: { ...BOUNDARY, lock_divergences: undefined } }, "incohérence de verrou dans la frontière");
});

await test("refus explicite : frontière en échec, protocol_id invalide, segment invalide", async () => {
  await expectRefused({ boundary: boundaryOf("") }, "frontière en échec (texte vide)");
  await expectRefused({ boundary: { ...BOUNDARY, protocol_id: "abc" } }, "protocol_id absent ou invalide");
  await expectRefused({ boundary: { ...BOUNDARY, protocol_id: undefined } }, "protocol_id absent ou invalide");
  await expectRefused({ segmentId: "segment-4" }, "segment_id invalide");
});

await test("empreintes divergentes : entités, voiceover_sha256, texte d'unité altéré", async () => {
  await expectRefused({ lock: { ...LOCK, entities_fingerprint: "0".repeat(64) } }, "incohérence de verrou dans la frontière : entities_fingerprint");
  await expectRefused({ boundary: { ...BOUNDARY, fingerprints: { ...BOUNDARY.fingerprints, entities_fingerprint: "0".repeat(64) } } }, "empreinte divergente : entities_fingerprint");
  await expectRefused({ boundary: { ...BOUNDARY, voiceover_sha256: "0".repeat(64) } }, "empreinte divergente : voiceover_sha256");
  await expectRefused({ boundary: { ...BOUNDARY, fingerprints: { ...BOUNDARY.fingerprints, voiceover_sha256: "0".repeat(64) } } }, "empreinte divergente : voiceover_sha256");
  const tampered = BOUNDARY.units.map((item, index) => (index === 3 ? { ...item, unit: { ...item.unit, text: "Texte remplacé." } } : item));
  await expectRefused({ boundary: { ...BOUNDARY, units: tampered } }, "empreinte divergente : voiceover_sha256");
});

await test("unités absentes, dupliquées, inconnues ou dans un ordre modifié → refus explicite", async () => {
  await expectRefused({ boundary: { ...BOUNDARY, units: [] } }, "unités absentes");
  await expectRefused({ boundary: { ...BOUNDARY, units: undefined } }, "unités absentes");
  await expectRefused({ boundary: { ...BOUNDARY, units: [...BOUNDARY.units].reverse() } }, "unités inconnues ou désordonnées");
  await expectRefused({ boundary: { ...BOUNDARY, units: [BOUNDARY.units[0], BOUNDARY.units[0], BOUNDARY.units[2], BOUNDARY.units[3]] } }, "unités : identifiant dupliqué");
  const renamed = BOUNDARY.units.map((item, index) => (index === 1 ? { ...item, unit_id: "u9" } : item));
  await expectRefused({ boundary: { ...BOUNDARY, units: renamed } }, "unités inconnues ou désordonnées");
});

await test("analysed_unit_ids incohérents : dupliqués, inconnus, hors liste, incomplets, désordonnés, absents", async () => {
  const withIds = ids => ({ boundary: { ...BOUNDARY, analysed_unit_ids: ids } });
  await expectRefused(withIds(["u1", "u1", "u2", "u3", "u4"]), "analysed_unit_ids : identifiant dupliqué");
  await expectRefused(withIds(["u1", "u2", "u3", "u4", "u9"]), "analysed_unit_ids : unité inconnue");
  await expectRefused(withIds(["u1", "u2", "u3"]), "analysed_unit_ids incomplets ou désordonnés");
  await expectRefused(withIds(["u2", "u1", "u3", "u4"]), "analysed_unit_ids incomplets ou désordonnés");
  await expectRefused(withIds(undefined), "analysed_unit_ids absents");
  const withExcluded = boundaryOf("Imaginez la scène. Le désert avance.");
  await expectRefused({ boundary: { ...withExcluded, analysed_unit_ids: ["u1", "u2"] } }, "analysed_unit_ids : unité exclue désignée");
});

await test("claims absents ou invalides → refus explicite", async () => {
  await expectRefused({ claims: undefined }, "claims absents");
  await expectRefused({ claims: [{ text: "" }] }, "claims invalides");
  await expectRefused({ claims: [null] }, "claims invalides");
});

await test("bornes : hors bornes → OUT_OF_BOUNDS avant tout appel, segment jamais découpé", async () => {
  for (const [label, overrides, reason] of [
    ["claims", { claims: Array.from({ length: 25 }, (_, index) => ({ text: `Fait ${index}.` })) }, "segment hors bornes du juge — claims : 25 > 24"],
    ["entrée", { boundary: boundaryOf(`${"Le désert avance encore et toujours vers la côte. ".repeat(230).trim()}`) }, "segment hors bornes du juge — entrée"],
    ["sortie", { boundary: boundaryOf(Array.from({ length: 28 }, (_, index) => `Le lieu ${index} reste sec.`).join(" ")) }, "segment hors bornes du juge — sortie dans le pire cas"]
  ]) {
    const transport = model();
    const result = await judge(overrides, transport);
    deepStrictEqual([result.status, result.failure?.category, transport.calls.length], ["FAILED", "OUT_OF_BOUNDS", 0], label);
    if (!result.failure.reason.startsWith(reason)) throw new Error(`${label} : ${result.failure.reason}`);
  }
  const fits = await judge({ boundary: boundaryOf(Array.from({ length: 27 }, (_, index) => `Le lieu ${index} reste sec.`).join(" ")) }, model({ uncovered: {} }));
  deepStrictEqual([fits.status, fits.bounds.estimated_output_tokens], ["JUDGED", 1374]);
});

await test("aucun appel réseau, aucune gestion du cache, aucun recalcul, aucun appelant", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-judge-v2.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")), [
    'import crypto from "node:crypto";',
    'import { extractText } from "../services/anthropic.js";',
    'import { ARCHITECTURE_BASELINE_VERSION, BOUNDARY_LOCK_KEYS, COMPOSITE_COVERAGE_BOUNDARY_VERSION, boundaryProtocolIdFromLock, invalidLockElements, lockSha256 } from "./coverage-lock.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["discardCachedResponse", "call-guard", "splitCoverageUnits", "normalizeCoverageText", "protectCoverageUnit", "classifyCoverageUnit", "composeCoverageBoundary", "fetch(", "http"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
  deepStrictEqual(networkGuard.attempts().length, 0);
});

await test("sortie immuable et sérialisable", async () => {
  const result = await judge();
  if (!Object.isFrozen(result) || !Object.isFrozen(result.results) || !result.results.every(Object.isFrozen)) throw new Error("sortie modifiable");
  deepStrictEqual(JSON.parse(JSON.stringify(result)), plain(result));
});

await test("aucune dépendance à la plateforme dans le module (hors commentaires)", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-judge-v2.js", import.meta.url), "utf8")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["normalize(", "Intl", "localeCompare", "toLowerCase", "toUpperCase", "toLocale", "\\p{", "/u", "\\s"]) {
    if (source.includes(forbidden)) throw new Error(`usage interdit : ${forbidden}`);
  }
});

// R28.6A — protocol_id recalculé depuis le verrou validé et comparé.
async function expectProtocolRefused(protocolId, reasonPrefix) {
  const transport = model();
  const result = await expectRefused({ boundary: { ...BOUNDARY, protocol_id: protocolId } }, reasonPrefix, transport);
  deepStrictEqual([result.protocol_id, result.request_sha256, result.results.length, transport.calls.length], [null, null, 0, 0]);
  return result;
}

await test("protocol_id correct : recalcul depuis le verrou identique à celui de la frontière (même algorithme)", async () => {
  deepStrictEqual(COMPOSITE_COVERAGE_BOUNDARY_VERSION, "composite-coverage-boundary.v1");
  deepStrictEqual(boundaryProtocolIdFromLock(LOCK), BOUNDARY.protocol_id);
  const sydney = extractResearchEntities({ keyFacts: ["La ville de Sydney grandit."], ruleVersion: "research-entities.v1" });
  const sydneyLock = { ...BOUNDARY_LOCK, entities_fingerprint: sydney.fingerprint };
  for (const [voiceover, lock, entities] of [
    [BASELINE_VOICEOVER, BOUNDARY_LOCK, ENTITIES],
    ["Le désert avance. La côte est humide.", BOUNDARY_LOCK, ENTITIES],
    ["La ville de sydney grandit. Pourquoi ?", sydneyLock, sydney]
  ]) {
    const boundary = composeCoverageBoundary({ voiceover, lock, entities });
    deepStrictEqual(boundaryProtocolIdFromLock(lock), boundary.protocol_id, voiceover);
  }
  const result = await judge();
  deepStrictEqual([result.status, result.protocol_id], ["JUDGED", boundaryProtocolIdFromLock(LOCK)]);
});

await test("protocol_id falsifié → INPUT_REFUSED, aucune requête, aucun signal de cache", async () => {
  const result = await expectProtocolRefused("f".repeat(64), "protocol_id divergent");
  if (!result.failure.reason.includes(`recalculé depuis le verrou ${BOUNDARY.protocol_id}`)) throw new Error(result.failure.reason);
});

await test("protocol_id calculé avec un verrou modifié → refusé", async () => {
  for (const key of ["splitter", "normalization", "protection", "classification", "entities_rule_version", "entities_fingerprint", "language"]) {
    await expectProtocolRefused(boundaryProtocolIdFromLock({ ...LOCK, [key]: `${LOCK[key]}x` }), "protocol_id divergent");
  }
});

await test("protocol_id absent → refusé", async () => {
  for (const protocolId of [undefined, null, ""]) await expectProtocolRefused(protocolId, "protocol_id absent ou invalide");
});

await test("protocol_id d'une autre frontière : refusé si son verrou diffère ; identique si même verrou", async () => {
  const sydney = extractResearchEntities({ keyFacts: ["La ville de Sydney grandit."], ruleVersion: "research-entities.v1" });
  const other = composeCoverageBoundary({
    voiceover: "La ville de sydney grandit.",
    lock: { ...BOUNDARY_LOCK, entities_fingerprint: sydney.fingerprint },
    entities: sydney
  });
  notEqual(other.protocol_id, BOUNDARY.protocol_id);
  await expectProtocolRefused(other.protocol_id, "protocol_id divergent");
  // Le protocol_id identifie les versions, pas le texte : deux frontières sous
  // le même verrou le partagent ; le texte reste lié par voiceover_sha256.
  deepStrictEqual(boundaryOf("Le désert avance.").protocol_id, BOUNDARY.protocol_id);
});

await test("protocol_id valide syntaxiquement mais incohérent → refusé", async () => {
  for (const protocolId of [sha256("autre chose"), BOUNDARY.voiceover_sha256, lockSha256(LOCK), BOUNDARY.protocol_id.toUpperCase()]) {
    await expectProtocolRefused(protocolId, protocolId === BOUNDARY.protocol_id.toUpperCase() ? "protocol_id absent ou invalide" : "protocol_id divergent");
  }
});

await test("version de la frontière composée divergente → refusée", async () => {
  await expectRefused({ boundary: { ...BOUNDARY, version: "composite-coverage-boundary.v2" } }, "version divergente : composite");
  await expectRefused({ boundary: { ...BOUNDARY, versions: { ...BOUNDARY.versions, composite: "composite-coverage-boundary.v2" } } }, "version divergente : composite");
});

// R28.9A — verrou complet : éléments 9 (réparation) et 10 (coordinateur).
const OLD_LOCK = Object.freeze((({ repair, coordinator, ...rest }) => rest)(LOCK));
const stable = value => (value === null || typeof value !== "object")
  ? JSON.stringify(value ?? null)
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;

await test("R28.9A — empreinte du verrou : SHA-256 du JSON stable des 11 champs, recalculée indépendamment", () => {
  const expected = sha256(stable(Object.fromEntries(COVERAGE_LOCK_KEYS.map(key => [key, LOCK[key]]))));
  deepStrictEqual(lockSha256(LOCK), expected);
  deepStrictEqual(COVERAGE_LOCK_KEYS.length, 11);
  if (lockSha256(LOCK) === lockSha256(OLD_LOCK)) throw new Error("ancien verrou indiscernable");
});

await test("R28.9A — réparation absente du verrou → refus explicite", async () => {
  const { repair: _removed, ...partial } = LOCK;
  await expectRefused({ lock: partial }, "verrou incomplet : repair");
});

await test("R28.9A — coordinateur absent du verrou → refus explicite", async () => {
  const { coordinator: _removed, ...partial } = LOCK;
  await expectRefused({ lock: partial }, "verrou incomplet : coordinator");
});

await test("R28.9A — version de réparation ou de coordinateur modifiée : lock_sha256 change", () => {
  for (const key of ["repair", "coordinator"]) {
    if (lockSha256({ ...LOCK, [key]: `${LOCK[key]}x` }) === lockSha256(LOCK)) throw new Error(`élément ${key} non couvert`);
  }
});

await test("R28.9A — version de réparation modifiée : jugement lié au nouveau verrou, pas à l'ancien", async () => {
  const modified = { ...LOCK, repair: "coverage-repair.v2" };
  const result = await judge({ lock: modified });
  deepStrictEqual([result.status, result.lock_sha256], ["JUDGED", lockSha256(modified)]);
  if (result.lock_sha256 === lockSha256(LOCK)) throw new Error("lock_sha256 inchangé");
});

await test("R28.9A — protocol_id inchangé : il ne dépend que du protocole de frontière", () => {
  deepStrictEqual(boundaryProtocolIdFromLock(LOCK), boundaryProtocolIdFromLock(OLD_LOCK));
  deepStrictEqual(boundaryProtocolIdFromLock({ ...LOCK, repair: "x", coordinator: "y" }), BOUNDARY.protocol_id);
});

await test("R28.9A — rejeu avec l'ancien verrou (9 champs) refusé", async () => {
  await expectRefused({ lock: OLD_LOCK }, "verrou incomplet : repair, coordinator");
});

await test("R28.9A — rejeu avec le verrou complet accepté, empreinte du verrou complet", async () => {
  const result = await judge();
  deepStrictEqual([result.status, result.lock_sha256, result.protocol_id], ["JUDGED", lockSha256(LOCK), BOUNDARY.protocol_id]);
});

// Copie isolée hors dépôt du juge, avec une mutation textuelle facultative.
// Le service fournisseur est importé depuis le dépôt (chemin absolu), mais
// n'est jamais appelé : le transport est toujours simulé.
async function isolatedJudge(prefix, mutation = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sources = {
    "coverage-judge-v2.js": fs.readFileSync(new URL("../src/utils/coverage-judge-v2.js", import.meta.url), "utf8")
      .replace('"../services/anthropic.js"', JSON.stringify(pathToFileURL(new URL("../src/services/anthropic.js", import.meta.url).pathname).href)),
    // R29.4 : le verrou est défini dans coverage-lock.js, copié à côté du juge.
    "coverage-lock.js": fs.readFileSync(new URL("../src/utils/coverage-lock.js", import.meta.url), "utf8")
  };
  if (mutation) {
    const target = mutation.target ?? "coverage-judge-v2.js";
    if (sources[target].split(mutation.from).length !== 2) throw new Error(`mutation non applicable : ${mutation.from}`);
    sources[target] = sources[target].replace(mutation.from, mutation.to);
  }
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, name), source);
  const module = await import(pathToFileURL(path.join(root, "coverage-judge-v2.js")).href);
  return { root, module };
}

async function behaviourFailures(module) {
  const failures = [];
  const lock = { ...LOCK, judge: module.coverageJudgeV2Version() };
  const run = async (overrides = {}, options = {}) => {
    const transport = model(options);
    try {
      const result = await module.judgeSegmentCoverageV2({
        boundary: BOUNDARY, lock, claims: BASELINE_CLAIMS, segmentId: "s2-g4", send: transport.send, ...overrides
      });
      return [result.status, result.failure?.category ?? null, transport.calls.length];
    } catch (error) {
      return ["EXCEPTION", error.message, transport.calls.length];
    }
  };
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  check("nominal", await run(), ["JUDGED", null, 1]);
  check("protocol_id", await run({}, { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) }), ["FAILED", "NOT_JUDGED", 1]);
  check("hash", await run({}, { alter: data => ({ ...data, voiceover_sha256: "0".repeat(64) }) }), ["FAILED", "NOT_JUDGED", 1]);
  check("verrou de la réponse", await run({}, { alter: data => ({ ...data, lock_sha256: "0".repeat(64) }) }), ["FAILED", "NOT_JUDGED", 1]);
  check("unité absente", await run({}, { alter: data => ({ ...data, results: data.results.slice(1) }) }), ["FAILED", "NOT_JUDGED", 1]);
  check("doublon", await run({}, { alter: data => ({ ...data, results: [...data.results, data.results[0]] }) }), ["FAILED", "NOT_JUDGED", 1]);
  check("citation", await run({}, { alter: data => ({ ...data, results: data.results.map(item => ({ ...item, sentence: "x" })) }) }), ["FAILED", "NOT_JUDGED", 1]);
  check("verrou incomplet", await run({ lock: { ...lock, baseline: undefined } }), ["FAILED", "INPUT_REFUSED", 0]);
  // Le refus doit être qualifié comme verrou incomplet, pas seulement refusé.
  const incomplete = await module.judgeSegmentCoverageV2({
    boundary: BOUNDARY, lock: { ...lock, baseline: undefined }, claims: BASELINE_CLAIMS, segmentId: "s2-g4", send: model().send
  });
  check("raison du verrou incomplet", incomplete.failure?.reason, "verrou incomplet : baseline");
  // R28.9A : un verrou sans réparation ou sans coordinateur est incomplet.
  for (const key of ["repair", "coordinator"]) {
    const { [key]: _removed, ...partial } = lock;
    check(`verrou sans ${key}`, await run({ lock: partial }), ["FAILED", "INPUT_REFUSED", 0]);
  }
  check("version divergente", await run({ lock: { ...lock, classification: "x" } }), ["FAILED", "INPUT_REFUSED", 0]);
  const divergent = await module.judgeSegmentCoverageV2({
    boundary: BOUNDARY, lock: { ...lock, classification: "x" }, claims: BASELINE_CLAIMS, segmentId: "s2-g4", send: model().send
  });
  check("raison de la version divergente", divergent.failure?.reason, "version divergente : classification");
  check("désignation", await run({ boundary: { ...BOUNDARY, analysed_unit_ids: ["u1", "u2", "u3"] } }), ["FAILED", "INPUT_REFUSED", 0]);
  check("composant absent", await run({ send: undefined }), ["FAILED", "INPUT_REFUSED", 0]);
  check("protocol_id falsifié", await run({ boundary: { ...BOUNDARY, protocol_id: "f".repeat(64) } }), ["FAILED", "INPUT_REFUSED", 0]);
  check("version composite", await run({ boundary: { ...BOUNDARY, version: "x" } }), ["FAILED", "INPUT_REFUSED", 0]);
  check("bornes", await run({ claims: Array.from({ length: 25 }, (_, index) => ({ text: `Fait ${index}.` })) }), ["FAILED", "OUT_OF_BOUNDS", 0]);
  return failures;
}

const MUTATIONS = [
  ["protocol_id non vérifié", { from: 'if (data.protocol_id !== protocolId) return { reason: "protocol_id différent" };', to: "" }],
  ["hash non vérifié", { from: 'if (data.voiceover_sha256 !== voiceoverSha256) return { reason: "voiceover_sha256 différent" };', to: "" }],
  ["verrou de la réponse non vérifié", { from: 'if (data.lock_sha256 !== lockSha256) return { reason: "lock_sha256 différent" };', to: "" }],
  ["unité absente acceptée", { from: "if (missing.length > 0) return { reason: `unité absente", to: "if (false) return { reason: `unité absente" }],
  ["doublon accepté", { from: "if (byId.has(result.unit_id)) return", to: "if (false) return" }],
  ["champs libres acceptés", { from: 'if (!keysExactly(result, ["unit_id", "verdict", "operations"]))', to: 'if (!result || typeof result !== "object")' }],
  ["verrou incomplet accepté", { from: "if (missing.length > 0) return `verrou incomplet", to: "if (false) return `verrou incomplet" }],
  ["versions non vérifiées", { from: "if (versions[key] !== lock[key]) return", to: "if (false) return" }],
  ["désignation non vérifiée", { from: 'if (!sameJson(designated, expected)) return "analysed_unit_ids incomplets ou désordonnés";', to: "" }],
  ["composant absent accepté", { from: 'if (typeof send !== "function") return "composant absent : transport";', to: "" }],
  ["bornes non vérifiées", { from: "if (outOfBounds) return", to: "if (false) return" }],
  ["réparation hors du verrou", { target: "coverage-lock.js", from: '  "repair",\n', to: "" }],
  ["coordinateur hors du verrou", { target: "coverage-lock.js", from: '  "coordinator",\n', to: "" }],
  ["protocol_id non recalculé", { from: "if (boundary.protocol_id !== expectedProtocolId) {", to: "if (false) {" }],
  ["algorithme du protocol_id altéré", { target: "coverage-lock.js", from: "composite: COMPOSITE_COVERAGE_BOUNDARY_VERSION,", to: "" }],
  ["version composite non vérifiée", { from: "if (boundary.version !== COMPOSITE_COVERAGE_BOUNDARY_VERSION || boundary.versions?.composite !== COMPOSITE_COVERAGE_BOUNDARY_VERSION) {", to: "if (false) {" }]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt, transport simulé)", async () => {
  const control = await isolatedJudge("r28-6-v2-control-");
  try {
    deepStrictEqual(control.module.coverageJudgeV2Version(), V2);
    deepStrictEqual(await behaviourFailures(control.module), [], "témoin");
  } finally {
    fs.rmSync(control.root, { recursive: true, force: true });
  }
  for (const [name, mutation] of MUTATIONS) {
    const mutant = await isolatedJudge("r28-6-v2-mutant-", mutation);
    try {
      if ((await behaviourFailures(mutant.module)).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      fs.rmSync(mutant.root, { recursive: true, force: true });
    }
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-judge-v2-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
