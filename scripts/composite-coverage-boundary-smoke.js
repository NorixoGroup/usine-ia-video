// Smoke R28.5 — frontière factuelle composée (baseline v1.0.1 : sections 1,
// 3, 7, 8 ; I6, I9, I10, I13, I15, I21), zéro API. Vérifie la composition
// nominale sans transformation, le déterminisme, l'idempotence, la cohérence
// et la propagation des versions, empreintes, états et erreurs, les
// composants absents ou incohérents, la traçabilité, et des mutations avec
// témoin (copies hors dépôt, reproductibles depuis ce smoke).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/composite-coverage-boundary-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepStrictEqual, notDeepStrictEqual } from "node:assert/strict";

import {
  BOUNDARY_LOCK_KEYS,
  BOUNDARY_STATUS,
  BOUNDARY_UNIT_STATES,
  COMPOSITE_COVERAGE_BOUNDARY_VERSION,
  DEFAULT_COVERAGE_COMPONENTS,
  composeCoverageBoundary
} from "../src/utils/composite-coverage-boundary.js";
import { normalizeCoverageText } from "../src/utils/coverage-normalization.js";
import { coverageUnitSplitterVersion, splitCoverageUnits } from "../src/utils/coverage-unit-splitter.js";
import { coverageProtectionVersion, extractResearchEntities, protectCoverageUnit } from "../src/utils/coverage-protection.js";
import { classifyCoverageUnit, coverageClassificationVersion } from "../src/utils/coverage-classification.js";

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
const plain = value => JSON.parse(JSON.stringify(value));

const SYDNEY = extractResearchEntities({ keyFacts: ["La ville de Sydney grandit."], ruleVersion: "research-entities.v1" });
const NO_ENTITIES = extractResearchEntities({ keyFacts: [], ruleVersion: "research-entities.v1" });
const LOCK = Object.freeze({
  splitter: coverageUnitSplitterVersion(),
  normalization: "coverage-normalization.v1",
  protection: coverageProtectionVersion(),
  entities_rule_version: SYDNEY.rule_version,
  entities_fingerprint: SYDNEY.fingerprint,
  classification: coverageClassificationVersion(),
  language: "fr"
});

const VOICEOVER =
  "Imaginez la scène. Le bassin couvre environ un million de kilomètres carrés. Pourquoi ? Mais avant cela, un détour. La ville de sydney grandit.";
const compose = (voiceover = VOICEOVER, overrides = {}) =>
  composeCoverageBoundary({ voiceover, lock: LOCK, entities: SYDNEY, ...overrides });
const states = result => result.units.map(item => item.state);

// Composants dérivés des composants réels, avec une seule différence.
const withComponent = (name, replacement) => ({ ...DEFAULT_COVERAGE_COMPONENTS, [name]: replacement });
const without = name => {
  const components = { ...DEFAULT_COVERAGE_COMPONENTS };
  delete components[name];
  return components;
};

await test("constantes publiques : version, clés du verrou, états", () => {
  deepStrictEqual(COMPOSITE_COVERAGE_BOUNDARY_VERSION, "composite-coverage-boundary.v1");
  deepStrictEqual([...BOUNDARY_LOCK_KEYS], ["splitter", "normalization", "protection", "entities_rule_version", "entities_fingerprint", "classification", "language"]);
  deepStrictEqual([...BOUNDARY_UNIT_STATES], ["protected", "excluded", "analysed"]);
  deepStrictEqual(Object.values(BOUNDARY_STATUS), ["OK", "DEGRADED", "FAILED"]);
});

await test("composition nominale : statut, états et identifiants", () => {
  const result = compose();
  deepStrictEqual([result.status, result.reason, result.lock_divergences.length, result.missing_components.length, result.errors.length], ["OK", null, 0, 0, 0]);
  deepStrictEqual(states(result), ["excluded", "protected", "excluded", "analysed", "protected"]);
  deepStrictEqual([...result.analysed_unit_ids], ["u2", "u4", "u5"]);
  deepStrictEqual([...result.excluded_unit_ids], ["u1", "u3"]);
  deepStrictEqual(result.units.map(item => item.classification.entry_id), ["engagement.imaginez", null, "question.short", null, null]);
});

await test("aucune transformation : chaque sortie est celle du composant appelé seul", () => {
  const result = compose();
  deepStrictEqual(plain(result.splitter), plain(splitCoverageUnits({ voiceover: VOICEOVER, version: LOCK.splitter, language: "fr" })));
  for (const item of result.units) {
    const normalization = normalizeCoverageText(item.unit.text, LOCK.normalization);
    const protection = protectCoverageUnit({ unit: item.unit, version: LOCK.protection, entities: SYDNEY });
    const classification = classifyCoverageUnit({ unit: item.unit, normalization, protection, version: LOCK.classification });
    deepStrictEqual(plain(item.normalization), plain(normalization));
    deepStrictEqual(plain(item.protection), plain(protection));
    deepStrictEqual(plain(item.classification), plain(classification));
    deepStrictEqual(item.unit, result.splitter.units[item.unit.rank - 1]);
  }
});

await test("cohérence des unités : partition exacte, aucun texte retiré (I21)", () => {
  const result = compose();
  deepStrictEqual(result.units.map(item => item.unit.text).join(""), VOICEOVER);
  deepStrictEqual(result.units.map(item => item.unit_id), ["u1", "u2", "u3", "u4", "u5"]);
  deepStrictEqual([...result.splitter_issues], []);
});

await test("cohérence et propagation des empreintes", () => {
  const result = compose();
  deepStrictEqual(result.voiceover_sha256, sha256(VOICEOVER));
  deepStrictEqual(plain(result.fingerprints), {
    voiceover_sha256: sha256(VOICEOVER),
    entities_fingerprint: SYDNEY.fingerprint,
    registry_sha256: result.units[0].classification.registry_sha256
  });
  for (const item of result.units) {
    deepStrictEqual(item.protection.entities_fingerprint, SYDNEY.fingerprint);
    deepStrictEqual(item.classification.upstream.entities_fingerprint, SYDNEY.fingerprint);
    deepStrictEqual(item.classification.registry_sha256, result.fingerprints.registry_sha256);
  }
});

await test("cohérence et propagation des versions", () => {
  const result = compose();
  deepStrictEqual(plain(result.versions), {
    composite: "composite-coverage-boundary.v1",
    splitter: LOCK.splitter,
    normalization: LOCK.normalization,
    protection: LOCK.protection,
    classification: LOCK.classification,
    entities_rule_version: "research-entities.v1",
    language: "fr"
  });
  deepStrictEqual(plain(result.lock), { ...LOCK });
  for (const item of result.units) {
    deepStrictEqual([item.normalization.version, item.protection.version, item.classification.version], [LOCK.normalization, LOCK.protection, LOCK.classification]);
    deepStrictEqual(item.classification.upstream.protection_version, LOCK.protection);
  }
});

await test("identifiant de protocole (I10) : stable, sensible à chaque version et à l'empreinte des entités", () => {
  const base = compose().protocol_id;
  deepStrictEqual(compose().protocol_id, base);
  if (!/^[0-9a-f]{64}$/.test(base)) throw new Error("format");
  const other = composeCoverageBoundary({
    voiceover: VOICEOVER,
    lock: { ...LOCK, entities_fingerprint: NO_ENTITIES.fingerprint },
    entities: NO_ENTITIES
  }).protocol_id;
  notDeepStrictEqual(other, base);
});

await test("déterminisme et idempotence (I13) : mêmes entrées → même sortie, indépendamment de l'historique", () => {
  const first = JSON.stringify(compose());
  compose("Autre texte. Pourquoi ?");
  for (let round = 0; round < 3; round += 1) deepStrictEqual(JSON.stringify(compose()), first);
});

await test("localité (I6) : les états de A + B sont ceux de A puis ceux de B", () => {
  const sentences = ["Imaginez la scène.", "Pourquoi ?", "Le désert avance.", "Mais avant cela.", "La ville de sydney grandit."];
  for (const a of sentences) {
    for (const b of sentences) {
      deepStrictEqual(states(compose(`${a} ${b}`)), [...states(compose(a)), ...states(compose(b))], `${a} | ${b}`);
    }
  }
});

await test("propagation des états : protégée, exclue, analysée reflètent les composants", () => {
  for (const item of compose().units) {
    if (item.protection.protected) deepStrictEqual(item.state, "protected");
    else if (item.classification.decision === "EXCLUDED") deepStrictEqual(item.state, "excluded");
    else deepStrictEqual(item.state, "analysed");
  }
});

await test("propagation des erreurs : texte vide → FAILED du découpeur, aucune unité", () => {
  for (const voiceover of ["", "  "]) {
    const result = compose(voiceover);
    deepStrictEqual([result.status, result.reason, result.units.length, result.splitter.status], ["FAILED", "texte vide", 0, "FAILED"]);
  }
});

await test("propagation des erreurs : voiceover non textuel → FAILED, erreur du découpeur conservée", () => {
  const result = compose(42);
  deepStrictEqual([result.status, result.splitter, result.units.length], ["FAILED", null, 0]);
  if (!result.errors[0].startsWith("splitter : Coverage Unit Splitter : voiceover invalide")) throw new Error(result.errors[0]);
  deepStrictEqual(result.reason, result.errors[0]);
});

await test("version divergente du découpeur → DEGRADED, unité unique analysée, jamais exclue (I15)", () => {
  const result = compose("Pourquoi ?", { lock: { ...LOCK, splitter: "coverage-unit-splitter.v2" } });
  deepStrictEqual([result.status, result.splitter.status, states(result)], ["DEGRADED", "DEGRADED", ["analysed"]]);
  deepStrictEqual(result.units[0].classification.decision, "EXCLUDED");
  deepStrictEqual(plain(result.lock_divergences), [{ element: "splitter", expected: "coverage-unit-splitter.v2", actual: LOCK.splitter }]);
});

await test("langue divergente → DEGRADED, aucune exclusion", () => {
  const result = compose("Pourquoi ? Imaginez la scène.", { lock: { ...LOCK, language: "en" } });
  deepStrictEqual([result.status, [...result.excluded_unit_ids]], ["DEGRADED", []]);
  if (!result.reason.startsWith("langue inconnue")) throw new Error(result.reason);
});

await test("version divergente de normalisation → erreur conservée, unités analysées", () => {
  const result = compose("Pourquoi ? Imaginez la scène.", { lock: { ...LOCK, normalization: "coverage-normalization.v2" } });
  deepStrictEqual([result.status, states(result)], ["DEGRADED", ["analysed", "analysed"]]);
  for (const item of result.units) {
    deepStrictEqual(item.normalization, null);
    if (!item.errors[0].startsWith("normalization : Coverage Normalization : version")) throw new Error(item.errors[0]);
    deepStrictEqual([item.classification.status, item.classification.reason], ["DEGRADED", "normalisation absente ou incohérente"]);
  }
});

await test("version divergente de Protection ou de Classification → composants dégradés, aucune exclusion", () => {
  for (const key of ["protection", "classification"]) {
    const result = compose("Pourquoi ? Imaginez la scène.", { lock: { ...LOCK, [key]: `${LOCK[key]}x` } });
    deepStrictEqual([result.status, [...result.excluded_unit_ids]], ["DEGRADED", []], key);
    for (const item of result.units) {
      if (!item[key].reason.startsWith("version inconnue")) throw new Error(`${key} : ${item[key].reason}`);
    }
    deepStrictEqual(result.lock_divergences.map(item => item.element), [key]);
  }
});

await test("empreinte d'entités divergente du verrou → liste non transmise, Protection dégradée, aucune exclusion", () => {
  for (const [label, lock] of [
    ["empreinte", { ...LOCK, entities_fingerprint: "0".repeat(64) }],
    ["règle", { ...LOCK, entities_rule_version: "research-entities.v2" }]
  ]) {
    const result = compose("Pourquoi ? Imaginez la scène.", { lock });
    deepStrictEqual([result.status, [...result.excluded_unit_ids]], ["DEGRADED", []], label);
    for (const item of result.units) {
      deepStrictEqual([item.protection.status, item.protection.protected, item.protection.reason], ["DEGRADED", true, "entités Research absentes ou invalides"]);
      deepStrictEqual(item.protection.entities_fingerprint, null);
    }
  }
  // Liste valide en soi mais différente de celle du verrou : jamais utilisée.
  const swapped = compose("La ville de sydney grandit.", { entities: NO_ENTITIES });
  deepStrictEqual([swapped.status, swapped.units[0].protection.status, swapped.units[0].state], ["DEGRADED", "DEGRADED", "protected"]);
  deepStrictEqual(plain(swapped.lock_divergences), [{ element: "entities_fingerprint", expected: SYDNEY.fingerprint, actual: NO_ENTITIES.fingerprint }]);
});

await test("verrou absent → toutes les versions divergentes, aucune exclusion", () => {
  for (const lock of [undefined, null, {}]) {
    const result = composeCoverageBoundary({ voiceover: "Pourquoi ? Imaginez la scène.", lock, entities: SYDNEY });
    deepStrictEqual([result.status, [...result.excluded_unit_ids]], ["DEGRADED", []]);
    deepStrictEqual(result.lock_divergences.map(item => item.element), BOUNDARY_LOCK_KEYS.filter(key => key !== "language"));
  }
});

await test("composants absents : découpeur → FAILED ; autres → DEGRADED, aucune exclusion", () => {
  const noSplitter = compose(VOICEOVER, { components: without("splitter") });
  deepStrictEqual([noSplitter.status, noSplitter.reason, [...noSplitter.missing_components]], ["FAILED", "composant absent : splitter", ["splitter"]]);
  for (const name of ["normalization", "protection", "classification"]) {
    const result = compose(VOICEOVER, { components: without(name) });
    deepStrictEqual([result.status, [...result.missing_components], [...result.excluded_unit_ids]], ["DEGRADED", [name], []], name);
    for (const item of result.units) {
      if (!item.errors.includes(`composant absent : ${name}`)) throw new Error(`${name} : ${item.errors}`);
      deepStrictEqual(item.state, "analysed");
    }
  }
});

await test("composant qui lève une exception → erreur conservée, unité analysée", () => {
  const failing = withComponent("protection", { version: coverageProtectionVersion, protect: () => { throw new Error("panne simulée"); } });
  const result = compose("Pourquoi ?", { components: failing });
  deepStrictEqual([result.status, states(result), [...result.units[0].errors]], ["DEGRADED", ["analysed"], ["protection : panne simulée"]]);
});

await test("sortie incohérente : unité, version ou empreinte amont divergentes → consignées, jamais exclues", () => {
  const cases = [
    ["identifiant de Classification", withComponent("classification", {
      version: coverageClassificationVersion,
      classify: input => ({ ...classifyCoverageUnit(input), unit_id: "u9" })
    }), "Classification : identifiant d'unité différent"],
    ["version de Classification", withComponent("classification", {
      version: coverageClassificationVersion,
      classify: input => ({ ...classifyCoverageUnit(input), version: "autre" })
    }), "Classification : version différente du verrou"],
    ["empreinte amont", withComponent("classification", {
      version: coverageClassificationVersion,
      classify: input => {
        const output = classifyCoverageUnit(input);
        return { ...output, upstream: { ...output.upstream, entities_fingerprint: "0".repeat(64) } };
      }
    }), "Classification : empreinte d'entités amont différente"],
    ["identifiant de Protection", withComponent("protection", {
      version: coverageProtectionVersion,
      protect: input => ({ ...protectCoverageUnit(input), unit_id: "u9" })
    }), "Protection : identifiant d'unité différent"]
  ];
  for (const [label, components, issue] of cases) {
    const result = compose("Pourquoi ?", { components });
    deepStrictEqual([result.status, states(result)], ["DEGRADED", ["analysed"]], label);
    if (!result.units[0].issues.includes(issue)) throw new Error(`${label} : ${result.units[0].issues}`);
  }
  const brokenSplit = withComponent("splitter", {
    version: coverageUnitSplitterVersion,
    split: input => {
      const output = splitCoverageUnits(input);
      return { ...output, units: output.units.slice(0, 1) };
    }
  });
  const result = compose("Pourquoi ? Imaginez la scène.", { components: brokenSplit });
  deepStrictEqual([result.status, states(result), [...result.splitter_issues]], ["DEGRADED", ["analysed"], ["partition incomplète"]]);
});

await test("traçabilité complète : structure figée, rien de perdu, sérialisable", () => {
  const result = compose();
  deepStrictEqual(Object.keys(result), [
    "version", "status", "reason", "voiceover_sha256", "protocol_id", "versions", "fingerprints", "lock",
    "lock_divergences", "missing_components", "errors", "splitter", "splitter_issues", "units",
    "analysed_unit_ids", "excluded_unit_ids"
  ]);
  deepStrictEqual(Object.keys(result.units[0]), ["unit_id", "unit", "normalization", "protection", "classification", "state", "errors", "issues", "degraded"]);
  deepStrictEqual(JSON.parse(JSON.stringify(result)), plain(result));
  if (!Object.isFrozen(result) || !Object.isFrozen(result.units) || !result.units.every(Object.isFrozen)) throw new Error("sortie modifiable");
});

await test("indépendance : composants R28.1 à R28.4 seulement, aucune référence au juge, à la réparation ou au pipeline", () => {
  const source = fs.readFileSync(new URL("../src/utils/composite-coverage-boundary.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")), [
    'import crypto from "node:crypto";',
    'import { COVERAGE_NORMALIZATION_VERSION, normalizeCoverageText } from "./coverage-normalization.js";',
    'import { coverageUnitSplitterVersion, splitCoverageUnits } from "./coverage-unit-splitter.js";',
    'import { coverageProtectionVersion, protectCoverageUnit } from "./coverage-protection.js";',
    'import { coverageClassificationVersion, classifyCoverageUnit } from "./coverage-classification.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n").toLowerCase();
  for (const forbidden of ["judge", "juge", "repair", "répar", "coordinat", "pipeline", "script", "claim", "verdict", "prompt", "research", "fs.", "readfile"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
});

await test("aucune dépendance à la plateforme dans le module (hors commentaires)", () => {
  const source = fs.readFileSync(new URL("../src/utils/composite-coverage-boundary.js", import.meta.url), "utf8")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  // « .normalize( » désigne ici l’appel du composant de normalisation injecté ;
  // seule la normalisation Unicode de la plateforme est interdite.
  for (const forbidden of ["normalize(\"NF", "normalize('NF", ".normalize()", "String.prototype.normalize", "Intl", "localeCompare", "toLowerCase", "toUpperCase", "toLocale", "\\p{", "/u", "\\s"]) {
    if (source.includes(forbidden)) throw new Error(`usage interdit : ${forbidden}`);
  }
});

// Copie isolée hors dépôt des cinq modules et des données, avec une mutation
// textuelle facultative de la frontière composée.
async function isolatedBoundary(prefix, mutation = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(root, "config", "coverage"), { recursive: true });
  for (const file of ["coverage-normalization.js", "coverage-unit-splitter.js", "coverage-protection.js", "coverage-classification.js"]) {
    fs.copyFileSync(new URL(`../src/utils/${file}`, import.meta.url), path.join(root, "src", "utils", file));
  }
  for (const file of fs.readdirSync(new URL("../config/coverage/", import.meta.url))) {
    fs.copyFileSync(new URL(`../config/coverage/${file}`, import.meta.url), path.join(root, "config", "coverage", file));
  }
  let source = fs.readFileSync(new URL("../src/utils/composite-coverage-boundary.js", import.meta.url), "utf8");
  if (mutation) {
    if (source.split(mutation.from).length !== 2) throw new Error(`mutation non applicable : ${mutation.from}`);
    source = source.replace(mutation.from, mutation.to);
  }
  fs.writeFileSync(path.join(root, "src", "utils", "composite-coverage-boundary.js"), source);
  const module = await import(new URL(`file://${path.join(root, "src", "utils", "composite-coverage-boundary.js")}`));
  return { root, module };
}

// Comportements de référence, vérifiés sur le témoin puis sur chaque mutant.
function behaviourFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  const run = (voiceover, overrides = {}) => {
    try {
      return module.composeCoverageBoundary({ voiceover, lock: LOCK, entities: SYDNEY, ...overrides });
    } catch (error) {
      return { status: "EXCEPTION", units: [], analysed_unit_ids: [], excluded_unit_ids: [], error: error.message };
    }
  };
  const components = module.DEFAULT_COVERAGE_COMPONENTS;
  const nominal = run(VOICEOVER);
  check("nominal", [nominal.status, nominal.units.map(item => item.state), nominal.analysed_unit_ids], ["OK", ["excluded", "protected", "excluded", "analysed", "protected"], ["u2", "u4", "u5"]]);
  const degradedSplit = run("Pourquoi ?", { lock: { ...LOCK, splitter: "x" } });
  check("découpeur dégradé : analysée", degradedSplit.units.map(item => item.state), ["analysed"]);
  const swapped = run("La ville de sydney grandit.", { entities: NO_ENTITIES });
  check("entités hors verrou : non transmises", swapped.units.map(item => item.protection?.status), ["DEGRADED"]);
  const failing = run("Pourquoi ?", { components: { ...components, protection: { version: components.protection.version, protect: () => { throw new Error("panne"); } } } });
  check("erreur de composant : DEGRADED", [failing.status, failing.units.map(item => item.state)], ["DEGRADED", ["analysed"]]);
  const incoherent = run("Pourquoi ?", {
    components: { ...components, classification: { version: components.classification.version, classify: input => ({ ...components.classification.classify(input), unit_id: "u9" }) } }
  });
  check("sortie incohérente : analysée", incoherent.units.map(item => item.state), ["analysed"]);
  const brokenSplit = run("Pourquoi ? Imaginez la scène.", {
    components: { ...components, splitter: { version: components.splitter.version, split: input => { const output = components.splitter.split(input); return { ...output, units: output.units.slice(0, 1) }; } } }
  });
  check("partition incomplète : analysée", brokenSplit.units.map(item => item.state), ["analysed"]);
  return failures;
}

const MUTATIONS = [
  ["découpeur dégradé ignoré", { from: "if (!splitOk || errors.length > 0", to: "if (errors.length > 0" }],
  ["entités hors verrou transmises", { from: 'divergences.some(item => item.element.startsWith("entities_")) ? null : entities', to: "entities" }],
  ["erreurs d'unité non agrégées", { from: "units.some(item => item.degraded)", to: "false" }],
  ["incohérences ignorées", { from: "issues.length > 0 || !protection", to: "!protection" }],
  ["exclues comptées comme analysées", { from: 'analysed_unit_ids: units.filter(item => item.state !== "excluded")', to: "analysed_unit_ids: units.filter(() => true)" }],
  ["partition non vérifiée", { from: 'split?.status === "OK" && splitIssues.length === 0', to: 'split?.status === "OK"' }]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt)", async () => {
  const control = await isolatedBoundary("r28-5-control-");
  try {
    deepStrictEqual(behaviourFailures(control.module), [], "témoin");
  } finally {
    fs.rmSync(control.root, { recursive: true, force: true });
  }
  for (const [name, mutation] of MUTATIONS) {
    const mutant = await isolatedBoundary("r28-5-mutant-", mutation);
    try {
      if (behaviourFailures(mutant.module).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      fs.rmSync(mutant.root, { recursive: true, force: true });
    }
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncomposite-coverage-boundary-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
