// Smoke R29.4 — module unique du verrou de couverture (baseline v1.0.3), zéro API.
//
// Partie 1 (valeurs de référence) : figées AVANT toute centralisation, sur le
// code d'origine. lock_sha256, protocol_id, les listes d'éléments et le
// script.json d'une production fixtures ne doivent jamais changer à cause de
// la centralisation (R29.4) : tout écart est un changement de comportement.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-lock-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import { buildCoverageLock, researchEntitiesOf } from "../src/utils/coverage-lock-builder.js";
import * as lockModule from "../src/utils/coverage-lock.js";
import {
  ARCHITECTURE_BASELINE_VERSION,
  BOUNDARY_LOCK_KEYS,
  COMPOSITE_COVERAGE_BOUNDARY_VERSION,
  COVERAGE_LOCK_KEYS,
  boundaryProtocolIdFromLock,
  firstDifferingLockElement,
  invalidLockElements,
  isLockRecord,
  lockMatchesPolicy,
  lockSha256,
  protocolIdFromVersions,
  unexpectedLockElements
} from "../src/utils/coverage-lock.js";
import { composeCoverageBoundary } from "../src/utils/composite-coverage-boundary.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = path.join(ROOT, "projects");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");

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

// ---------------------------------------------------------------------------
// VALEURS DE RÉFÉRENCE (relevées sur le code d'avant R29.4).

const GOLDEN = {
  "keys": [
    "splitter",
    "normalization",
    "protection",
    "entities_rule_version",
    "entities_fingerprint",
    "classification",
    "judge",
    "repair",
    "coordinator",
    "language",
    "baseline"
  ],
  "boundaryKeys": [
    "splitter",
    "normalization",
    "protection",
    "entities_rule_version",
    "entities_fingerprint",
    "classification",
    "language"
  ],
  "baseline": "architecture-baseline-v1.0.3",
  "composite": "composite-coverage-boundary.v1",
  "expected": "composite-coverage-boundary.v1",
  "cases": {
    "exemple": {
      "lock_sha256": "d8584ddca53f8e7f313f4b4412f078e31dfe7560bfb4e0a12514835c50ec0281",
      "protocol_id": "f5ddbda24c913f01aa479644b15c52dee88a5a0629231b4692bd7b0392f998c6",
      "voiceover_sha256": "f03ecfa6061ed702e0d136e2e6513268d74b5b49ce76b013ced3b7da750348ce",
      "lock": {
        "splitter": "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5",
        "normalization": "coverage-normalization.v1",
        "protection": "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24",
        "entities_rule_version": "research-entities.v1",
        "entities_fingerprint": "bea118b8ed0781ed270dfcb7dd37c550b9a72b9829b83a8a5b26bef6b2221781",
        "classification": "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37",
        "judge": "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60",
        "repair": "coverage-repair.v1",
        "coordinator": "coverage-coordinator-policy.v1",
        "language": "fr",
        "baseline": "architecture-baseline-v1.0.3"
      }
    },
    "vide": {
      "lock_sha256": "9fc84a5e3c274cc907ce7775aa2d812eaca1fdeb9b08ecafdab0cf1070d80393",
      "protocol_id": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080",
      "voiceover_sha256": "f03ecfa6061ed702e0d136e2e6513268d74b5b49ce76b013ced3b7da750348ce",
      "lock": {
        "splitter": "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5",
        "normalization": "coverage-normalization.v1",
        "protection": "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24",
        "entities_rule_version": "research-entities.v1",
        "entities_fingerprint": "588d35b7806640d99b28f50c8dc34c22d5e783a6869e3e063ccebf643fc9ffcc",
        "classification": "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37",
        "judge": "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60",
        "repair": "coverage-repair.v1",
        "coordinator": "coverage-coordinator-policy.v1",
        "language": "fr",
        "baseline": "architecture-baseline-v1.0.3"
      }
    },
    "autre": {
      "lock_sha256": "3eae4202f340c8e9d18a5afc4c314a9dd25fb3f1fd1ac8739449d9cb122500f9",
      "protocol_id": "760d2617cd6d6b4385c5847b57d7f83b442af5646267a7a73cc04872e91c4e61",
      "voiceover_sha256": "f03ecfa6061ed702e0d136e2e6513268d74b5b49ce76b013ced3b7da750348ce",
      "lock": {
        "splitter": "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5",
        "normalization": "coverage-normalization.v1",
        "protection": "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24",
        "entities_rule_version": "research-entities.v1",
        "entities_fingerprint": "6251cdce46c4a7370ca133246d0a8826f872a25cb12e802749c4d681ffd5ccfe",
        "classification": "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37",
        "judge": "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60",
        "repair": "coverage-repair.v1",
        "coordinator": "coverage-coordinator-policy.v1",
        "language": "fr",
        "baseline": "architecture-baseline-v1.0.3"
      }
    }
  },
  "partial": {
    "lock_sha256": "6a150d5db7b23d6b6550cebfde97da338e959024401cc7d95ea0f288fd4771e0",
    "protocol_id": "f5ddbda24c913f01aa479644b15c52dee88a5a0629231b4692bd7b0392f998c6"
  },
  "extra": {
    "lock_sha256": "d8584ddca53f8e7f313f4b4412f078e31dfe7560bfb4e0a12514835c50ec0281"
  },
  "empty": {
    "lock_sha256": "95326f7a53296744e60e9c1ebc57a5a61b7da3a4b683d75ae8d5ae57d4c48ac0",
    "protocol_id": "ad8f6f99a2114ab6d1113a501cc9432c7fecce25c69756c325cbee256c7601cd"
  },
  "script_json_sha256": {
    "happy": "709153beb05ed4a9576bc4c7d4fe83e70d2d737a192ca46c183273fe8733270e",
    "script-coverage-repair": "0b7e8877f2b4bdec0665742623270a87d5d9db699862b41c732796d855e83085"
  }
};

const RESEARCH = {
  exemple: { key_facts: [{ claim: "Le désert avance vite dans le centre." }, { claim: "La ville de Sydney grandit." }] },
  vide: {},
  autre: { key_facts: [{ claim: "La ville de Perth grandit." }, { claim: "Le Queensland compte 5 millions d'habitants." }] }
};
const VOICEOVER = "Le bassin couvre 3 millions de km². Il compte 4 lacs.";
const FRONTIER_KEYS = ["splitter", "normalization", "protection", "entities_rule_version", "entities_fingerprint", "classification", "language"];

// ---------------------------------------------------------------------------
console.log("--- 1. Valeurs de référence ---");

await test("liste des 11 éléments du verrou, dans l'ordre de la section 8", () => {
  deepStrictEqual([...COVERAGE_LOCK_KEYS], GOLDEN.keys);
  deepStrictEqual(GOLDEN.keys.length, 11);
});

await test("liste des 7 éléments consommés par la frontière", () => {
  deepStrictEqual([...BOUNDARY_LOCK_KEYS], GOLDEN.boundaryKeys);
  deepStrictEqual(GOLDEN.boundaryKeys, GOLDEN.keys.filter(key => !["judge", "repair", "coordinator", "baseline"].includes(key)));
});

await test("baseline et version de la frontière composée", () => {
  deepStrictEqual([ARCHITECTURE_BASELINE_VERSION, COMPOSITE_COVERAGE_BOUNDARY_VERSION], [GOLDEN.baseline, GOLDEN.composite]);
  deepStrictEqual(GOLDEN.composite, GOLDEN.expected);
});

for (const name of Object.keys(RESEARCH)) {
  const reference = GOLDEN.cases[name];
  const entities = researchEntitiesOf(RESEARCH[name]);
  const lock = buildCoverageLock({ entities });

  await test(`verrou courant « ${name} » : les 11 éléments sont identiques`, () => {
    deepStrictEqual(clone(lock), reference.lock);
  });

  await test(`verrou « ${name} » : lock_sha256 identique`, () => {
    deepStrictEqual(lockSha256(lock), reference.lock_sha256);
  });

  await test(`verrou « ${name} » : protocol_id identique, calculé depuis le verrou`, () => {
    deepStrictEqual(boundaryProtocolIdFromLock(lock), reference.protocol_id);
  });

  await test(`verrou « ${name} » : la frontière produit le même protocol_id et la même empreinte de voiceover`, () => {
    const boundary = composeCoverageBoundary({ voiceover: VOICEOVER, lock, entities });
    deepStrictEqual([boundary.protocol_id, boundary.voiceover_sha256, boundary.lock_divergences.length], [reference.protocol_id, reference.voiceover_sha256, 0]);
    deepStrictEqual(clone(boundary.lock), Object.fromEntries(GOLDEN.boundaryKeys.map(key => [key, reference.lock[key]])));
  });
}

await test("trois verrous de référence : trois empreintes et trois protocol_id distincts", () => {
  deepStrictEqual(new Set(Object.values(GOLDEN.cases).map(item => item.lock_sha256)).size, 3);
  deepStrictEqual(new Set(Object.values(GOLDEN.cases).map(item => item.protocol_id)).size, 3);
});

await test("verrou incomplet, avec élément en trop ou absent : empreinte et protocol_id identiques à l'original", () => {
  const base = { ...GOLDEN.cases.exemple.lock };
  const { repair, ...partial } = base;
  deepStrictEqual(lockSha256(partial), GOLDEN.partial.lock_sha256);
  deepStrictEqual(boundaryProtocolIdFromLock(partial), GOLDEN.partial.protocol_id);
  deepStrictEqual(lockSha256({ ...base, extra: "x" }), GOLDEN.extra.lock_sha256);
  deepStrictEqual(GOLDEN.extra.lock_sha256, GOLDEN.cases.exemple.lock_sha256);
  deepStrictEqual([lockSha256(undefined), boundaryProtocolIdFromLock(undefined)], [GOLDEN.empty.lock_sha256, GOLDEN.empty.protocol_id]);
  deepStrictEqual([lockSha256(null), boundaryProtocolIdFromLock(null)], [GOLDEN.empty.lock_sha256, GOLDEN.empty.protocol_id]);
});

await test("l'empreinte ne dépend pas de l'ordre des clés", () => {
  const reversed = Object.fromEntries(Object.entries(GOLDEN.cases.exemple.lock).reverse());
  deepStrictEqual(lockSha256(reversed), GOLDEN.cases.exemple.lock_sha256);
});

await test("chaque élément modifié change l'empreinte du verrou ; seuls les 7 éléments de la frontière changent le protocol_id", () => {
  const base = GOLDEN.cases.exemple;
  for (const key of GOLDEN.keys) {
    const changed = { ...base.lock, [key]: `${base.lock[key]}-x` };
    if (lockSha256(changed) === base.lock_sha256) throw new Error(`empreinte insensible à ${key}`);
    const protocolChanges = boundaryProtocolIdFromLock(changed) !== base.protocol_id;
    deepStrictEqual([key, protocolChanges], [key, FRONTIER_KEYS.includes(key)]);
  }
});

// ---------------------------------------------------------------------------
console.log("--- 2. script.json d'une production fixtures (processus enfant) ---");

const createdProductions = [];

function runPipeline(scenario) {
  const before = fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [];
  const child = spawnSync(process.execPath, ["--import", GUARD, "src/orchestrator/mvp.js", "--research-script"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, NO_API: "1", ANTHROPIC_FIXTURES: "1", ANTHROPIC_FIXTURE_SCENARIO: scenario },
    encoding: "utf8"
  });
  const created = (fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []).filter(name => !before.includes(name));
  createdProductions.push(...created);
  const id = child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null;
  return { status: child.status, id, stderr: child.stderr, blocked: Number(child.stderr.match(/tentatives bloquées : (\d+)/)?.[1] ?? NaN) };
}

for (const scenario of Object.keys(GOLDEN.script_json_sha256)) {
  await test(`script.json (scénario ${scenario}) : octets identiques à la référence d'avant R29.4`, () => {
    const run = runPipeline(scenario);
    if (run.status !== 0 || !run.id) throw new Error(`exit ${run.status}\n${run.stderr.slice(-400)}`);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(PROJECTS, run.id, "script.json"))).digest("hex");
    deepStrictEqual([sha, run.blocked], [GOLDEN.script_json_sha256[scenario], 0]);
  });
}

for (const id of createdProductions) fs.rmSync(path.join(PROJECTS, id), { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log("--- 3. Contrat du verrou (coverage-lock.js) ---");

const BASE_LOCK = GOLDEN.cases.exemple.lock;
const SRC = path.join(ROOT, "src", "utils");
const read = name => fs.readFileSync(path.join(SRC, name), "utf8");
const codeOf = name => read(name).split("\n").filter(line => !line.trim().startsWith("//")).join("\n");

await test("exports du contrat : liste fermée, l'ancien nom JUDGE_LOCK_KEYS n'existe plus", () => {
  deepStrictEqual(Object.keys(lockModule).sort(), [
    "ARCHITECTURE_BASELINE_VERSION", "BOUNDARY_LOCK_KEYS", "COMPOSITE_COVERAGE_BOUNDARY_VERSION", "COVERAGE_LOCK_KEYS",
    "boundaryProtocolIdFromLock", "firstDifferingLockElement", "invalidLockElements", "isLockRecord", "lockMatchesPolicy",
    "lockSha256", "protocolIdFromVersions", "unexpectedLockElements"
  ]);
});

await test("listes d'éléments figées et immuables", () => {
  if (!Object.isFrozen(COVERAGE_LOCK_KEYS) || !Object.isFrozen(BOUNDARY_LOCK_KEYS)) throw new Error("liste modifiable");
  deepStrictEqual(COVERAGE_LOCK_KEYS.length, 11);
  deepStrictEqual(BOUNDARY_LOCK_KEYS.length, 7);
});

await test("la liste de la frontière est dérivée de la liste complète, dans le même ordre", () => {
  deepStrictEqual([...BOUNDARY_LOCK_KEYS], COVERAGE_LOCK_KEYS.filter(key => BOUNDARY_LOCK_KEYS.includes(key)));
  for (const key of ["judge", "repair", "coordinator", "baseline"]) if (BOUNDARY_LOCK_KEYS.includes(key)) throw new Error(`${key} ne concerne pas la frontière`);
});

await test("isLockRecord : objet seulement (ni nul, ni tableau, ni primitive)", () => {
  deepStrictEqual([{}, BASE_LOCK].map(isLockRecord), [true, true]);
  deepStrictEqual([null, undefined, [], [1], "x", 3, true].map(isLockRecord), [false, false, false, false, false, false, false]);
});

await test("invalidLockElements : aucun pour un verrou complet", () => {
  deepStrictEqual(invalidLockElements(BASE_LOCK), []);
});

for (const key of COVERAGE_LOCK_KEYS) {
  await test(`invalidLockElements : ${key} absent, vide, nul ou non chaîne → désigné`, () => {
    const { [key]: _removed, ...absent } = BASE_LOCK;
    for (const lock of [absent, { ...BASE_LOCK, [key]: "" }, { ...BASE_LOCK, [key]: null }, { ...BASE_LOCK, [key]: 3 }, { ...BASE_LOCK, [key]: ["x"] }]) {
      deepStrictEqual(invalidLockElements(lock), [key]);
    }
  });
}

await test("invalidLockElements : plusieurs éléments invalides, dans l'ordre du verrou ; tableau et objet vide : tous", () => {
  deepStrictEqual(invalidLockElements({ ...BASE_LOCK, baseline: "", splitter: 1 }), ["splitter", "baseline"]);
  deepStrictEqual(invalidLockElements({}), [...COVERAGE_LOCK_KEYS]);
  deepStrictEqual(invalidLockElements([]), [...COVERAGE_LOCK_KEYS]);
});

await test("unexpectedLockElements : aucun pour un verrou complet ; éléments superflus dans l'ordre des clés", () => {
  deepStrictEqual(unexpectedLockElements(BASE_LOCK), []);
  deepStrictEqual(unexpectedLockElements({ ...BASE_LOCK, zeta: 1, alpha: 2 }), ["zeta", "alpha"]);
});

await test("firstDifferingLockElement : aucun écart, puis le premier dans l'ordre du verrou", () => {
  deepStrictEqual(firstDifferingLockElement(BASE_LOCK, { ...BASE_LOCK }), undefined);
  for (const key of COVERAGE_LOCK_KEYS) deepStrictEqual(firstDifferingLockElement(BASE_LOCK, { ...BASE_LOCK, [key]: "x" }), key);
  deepStrictEqual(firstDifferingLockElement({ ...BASE_LOCK, baseline: "a", splitter: "b" }, BASE_LOCK), "splitter");
});

await test("lockMatchesPolicy : le coordinateur du verrou doit être la version de la politique", () => {
  deepStrictEqual(lockMatchesPolicy(BASE_LOCK, { version: BASE_LOCK.coordinator }), true);
  deepStrictEqual(lockMatchesPolicy(BASE_LOCK, { version: "autre" }), false);
  deepStrictEqual([null, undefined, [], "x"].map(lock => lockMatchesPolicy(lock, { version: BASE_LOCK.coordinator })), [false, false, false, false]);
});

await test("protocolIdFromVersions : même résultat que la frontière, version par version", () => {
  const entities = researchEntitiesOf(RESEARCH.exemple);
  const lock = buildCoverageLock({ entities });
  const boundary = composeCoverageBoundary({ voiceover: VOICEOVER, lock, entities });
  deepStrictEqual(protocolIdFromVersions({ versions: boundary.versions, entitiesFingerprint: boundary.fingerprints.entities_fingerprint }), boundary.protocol_id);
  deepStrictEqual(boundaryProtocolIdFromLock(lock), boundary.protocol_id);
});

await test("protocolIdFromVersions : ordre des clés sans effet, toute version ou empreinte modifiée change l'identifiant", () => {
  const versions = { composite: "c", splitter: "s", normalization: "n", protection: "p", classification: "k", entities_rule_version: "e", language: "fr" };
  const reference = protocolIdFromVersions({ versions, entitiesFingerprint: "f" });
  deepStrictEqual(protocolIdFromVersions({ versions: Object.fromEntries(Object.entries(versions).reverse()), entitiesFingerprint: "f" }), reference);
  for (const key of Object.keys(versions)) if (protocolIdFromVersions({ versions: { ...versions, [key]: "x" }, entitiesFingerprint: "f" }) === reference) throw new Error(`insensible à ${key}`);
  if (protocolIdFromVersions({ versions, entitiesFingerprint: "g" }) === reference) throw new Error("insensible à l'empreinte des entités");
});

await test("contrat déterministe et sans effet de bord : entrées gelées acceptées, aucune modification", () => {
  const frozen = Object.freeze({ ...BASE_LOCK });
  const snapshot = JSON.stringify(frozen);
  for (let round = 0; round < 3; round += 1) {
    lockSha256(frozen);
    boundaryProtocolIdFromLock(frozen);
    invalidLockElements(frozen);
    unexpectedLockElements(frozen);
    firstDifferingLockElement(frozen, BASE_LOCK);
  }
  deepStrictEqual(JSON.stringify(frozen), snapshot);
});

await test("le module du contrat est une feuille pure : il n'importe que node:crypto", () => {
  const imports = read("coverage-lock.js").split("\n").filter(line => line.startsWith("import "));
  deepStrictEqual(imports, ['import crypto from "node:crypto";']);
  const code = codeOf("coverage-lock.js");
  for (const forbidden of ["fs.", "fetch(", "http", "Date", "Math.random", "process.", "await ", "async ", "setTimeout", "createMessage"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
console.log("--- 4. Unicité des définitions et sens des dépendances ---");

const COVERAGE_FILES = fs.readdirSync(SRC).filter(name => /^(coverage-.*|composite-coverage-boundary|script-coverage-gate)\.js$/.test(name)).sort();
const countIn = (pattern, files = COVERAGE_FILES) => files.filter(name => pattern.test(codeOf(name)));

await test("les modules de couverture sont bien ceux attendus", () => {
  deepStrictEqual(COVERAGE_FILES.includes("coverage-lock.js") && COVERAGE_FILES.includes("coverage-lock-builder.js"), true);
  deepStrictEqual(COVERAGE_FILES.length >= 14, true);
});

for (const [name, pattern, expected] of [
  ["la baseline", /architecture-baseline-v\d/, ["coverage-lock.js"]],
  ["la version de la frontière composée", /composite-coverage-boundary\.v\d/, ["coverage-lock.js"]],
  ["la liste des 11 éléments du verrou", /"coordinator",\s*\n\s*"language",/, ["coverage-lock.js"]],
  ["le JSON stable du verrou", /function stableJson\(/, ["coverage-lock.js"]],
  ["l'algorithme de protocol_id", /stableJson\(\{\s*versions/, ["coverage-lock.js"]],
  ["l'empreinte du verrou", /function lockSha256\(/, ["coverage-lock.js"]],
  ["la liaison coordinateur / politique", /coordinator\s*(===|!==)\s*policy\.version/, ["coverage-lock.js"]],
  ["le contrôle d'un élément vide ou non chaîne", /typeof lock\[key\] !== "string" \|\| lock\[key\] === ""/, ["coverage-lock.js"]],
  ["la construction du verrou courant", /function buildCoverageLock\(/, ["coverage-lock-builder.js"]],
  ["la politique par défaut", /max_total_judge_calls: 12/, ["coverage-lock-builder.js"]]
]) {
  await test(`définition unique : ${name}`, () => {
    deepStrictEqual(countIn(pattern).sort(), expected);
  });
}

await test("anciens noms disparus de src/ : JUDGE_LOCK_KEYS, judgeLockSha256, EXPECTED_BOUNDARY_VERSION, BOUNDARY_LOCK_ECHO", () => {
  for (const name of fs.readdirSync(SRC).filter(file => file.endsWith(".js"))) {
    for (const old of ["JUDGE_LOCK_KEYS", "judgeLockSha256", "EXPECTED_BOUNDARY_VERSION", "BOUNDARY_LOCK_ECHO"]) {
      if (codeOf(name).includes(old)) throw new Error(`${name} : ${old}`);
    }
  }
});

function importGraph() {
  const graph = new Map();
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".js")) {
        const source = fs.readFileSync(file, "utf8");
        graph.set(path.relative(ROOT, file), [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map(match => path.relative(ROOT, path.join(path.dirname(file), match[1]))));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return graph;
}

await test("aucun cycle d'imports dans src/ (hors le cycle antérieur validate-research ↔ source-policy)", () => {
  const graph = importGraph();
  const color = new Map();
  const cycles = [];
  const visit = (node, stack) => {
    color.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (color.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!color.get(next)) visit(next, stack);
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const node of graph.keys()) if (!color.get(node)) visit(node, []);
  deepStrictEqual(cycles.map(cycle => cycle.map(file => path.basename(file)).sort().join(" ↔ ")).map(text => [...new Set(text.split(" ↔ "))].join(" ↔ ")), ["source-policy.js ↔ validate-research.js"]);
});

await test("sens des dépendances : les composants importent le contrat, jamais le constructeur", () => {
  const graph = importGraph();
  const importers = target => [...graph.entries()].filter(([, deps]) => deps.includes(path.join("src", "utils", target))).map(([file]) => path.basename(file)).sort();
  deepStrictEqual(importers("coverage-lock.js"), [
    "composite-coverage-boundary.js", "coverage-budget-preflight.js", "coverage-coordinator.js", "coverage-delete-applier.js",
    "coverage-judge-v2.js", "coverage-lock-builder.js", "coverage-lock-persistence.js", "coverage-repair.js", "script-coverage-gate.js"
  ]);
  deepStrictEqual(importers("coverage-lock-builder.js"), ["mvp.js", "script-coverage-gate.js", "script.js"]);
});

await test("le contrat n'a aucune dépendance interne, le constructeur n'importe que des composants et le contrat", () => {
  const graph = importGraph();
  deepStrictEqual(graph.get(path.join("src", "utils", "coverage-lock.js")), []);
  deepStrictEqual(graph.get(path.join("src", "utils", "coverage-lock-builder.js")).map(file => path.basename(file)).sort(), [
    "coverage-classification.js", "coverage-judge-v2.js", "coverage-lock.js", "coverage-normalization.js", "coverage-protection.js", "coverage-repair.js", "coverage-unit-splitter.js"
  ]);
});

await test("script.js et mvp.js n'importent plus la porte de couverture pour construire le verrou", () => {
  for (const file of ["src/agents/script.js", "src/orchestrator/mvp.js"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (/buildCoverageLock|researchEntitiesOf/.test(source)) throw new Error(`${file} construit le verrou lui-même`);
    if (!source.includes("currentCoverageLock")) throw new Error(`${file} n'utilise pas le constructeur partagé`);
  }
});

// ---------------------------------------------------------------------------
console.log("--- 5. Mutations du contrat (copies hors dépôt) ---");

const tempDirs = [];

async function isolatedLock(replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r29-4-mutant-"));
  tempDirs.push(root);
  let source = read("coverage-lock.js");
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from.slice(0, 70)}`);
    source = source.replace(from, to);
  }
  const file = path.join(root, "coverage-lock.js");
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

function contractFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label); };
  check("liste des 11", [...module.COVERAGE_LOCK_KEYS], GOLDEN.keys);
  check("liste des 7", [...module.BOUNDARY_LOCK_KEYS], GOLDEN.boundaryKeys);
  check("baseline", module.ARCHITECTURE_BASELINE_VERSION, GOLDEN.baseline);
  check("version de la frontière", module.COMPOSITE_COVERAGE_BOUNDARY_VERSION, GOLDEN.composite);
  check("empreinte du verrou", module.lockSha256(BASE_LOCK), GOLDEN.cases.exemple.lock_sha256);
  check("empreinte, élément superflu ignoré", module.lockSha256({ ...BASE_LOCK, extra: "x" }), GOLDEN.cases.exemple.lock_sha256);
  check("empreinte, verrou absent", module.lockSha256(undefined), GOLDEN.empty.lock_sha256);
  check("protocol_id", module.boundaryProtocolIdFromLock(BASE_LOCK), GOLDEN.cases.exemple.protocol_id);
  check("protocol_id, verrou absent", module.boundaryProtocolIdFromLock(undefined), GOLDEN.empty.protocol_id);
  for (const key of GOLDEN.keys) {
    check(`élément ${key} invalide non détecté`, module.invalidLockElements({ ...BASE_LOCK, [key]: "" }), [key]);
    check(`écart sur ${key} non détecté`, module.firstDifferingLockElement(BASE_LOCK, { ...BASE_LOCK, [key]: "x" }), key);
  }
  check("élément vide, nul, non chaîne", [module.invalidLockElements({ ...BASE_LOCK, judge: "" }), module.invalidLockElements({ ...BASE_LOCK, judge: null }), module.invalidLockElements({ ...BASE_LOCK, judge: 3 })], [["judge"], ["judge"], ["judge"]]);
  check("éléments superflus", module.unexpectedLockElements({ ...BASE_LOCK, zeta: 1, alpha: 2 }), ["zeta", "alpha"]);
  check("premier écart dans l'ordre du verrou", module.firstDifferingLockElement({ ...BASE_LOCK, baseline: "a", splitter: "b" }, BASE_LOCK), "splitter");
  check("objet enregistrement", [module.isLockRecord({}), module.isLockRecord([]), module.isLockRecord(null)], [true, false, false]);
  check("liaison à la politique", [module.lockMatchesPolicy(BASE_LOCK, { version: BASE_LOCK.coordinator }), module.lockMatchesPolicy(BASE_LOCK, { version: "x" }), module.lockMatchesPolicy([], { version: undefined })], [true, false, false]);
  check("protocol_id selon les versions", module.protocolIdFromVersions({ versions: { composite: "c", language: "fr" }, entitiesFingerprint: "f" }), protocolIdFromVersions({ versions: { composite: "c", language: "fr" }, entitiesFingerprint: "f" }));
  return failures;
}

const MUTATIONS = [
  ["élément « réparation » retiré de la liste", [{ from: '  "repair",\n', to: "" }]],
  ["élément « coordinateur » retiré de la liste", [{ from: '  "coordinator",\n', to: "" }]],
  ["élément superflu pris en compte dans l'empreinte", [{ from: "Object.fromEntries(COVERAGE_LOCK_KEYS.map(key => [key, lock?.[key] ?? null]))", to: "{ ...lock }" }]],
  ["verrou absent non neutralisé dans l'empreinte", [{ from: "lock?.[key] ?? null]))));", to: "lock[key] ?? null]))));" }]],
  ["liste de la frontière contient la baseline", [{ from: '["judge", "repair", "coordinator", "baseline"]', to: '["judge", "repair", "coordinator"]' }]],
  ["identifiant de protocole sans la version composite", [{ from: "      composite: COMPOSITE_COVERAGE_BOUNDARY_VERSION,\n", to: "" }]],
  ["identifiant de protocole sans la langue", [{ from: "      language: lock?.language ?? null\n", to: "      language: null\n" }]],
  ["identifiant de protocole sans l'empreinte des entités", [{ from: "entitiesFingerprint: lock?.entities_fingerprint ?? null", to: "entitiesFingerprint: null" }]],
  ["élément vide accepté", [{ from: 'typeof lock[key] !== "string" || lock[key] === ""', to: 'typeof lock[key] !== "string"' }]],
  ["élément non chaîne accepté", [{ from: 'typeof lock[key] !== "string" || lock[key] === ""', to: "lock[key] === undefined" }]],
  ["éléments superflus ignorés", [{ from: "Object.keys(lock).filter(key => !COVERAGE_LOCK_KEYS.includes(key))", to: "[]" }]],
  ["premier écart cherché à rebours", [{ from: "COVERAGE_LOCK_KEYS.find(key => stored[key] !== current[key])", to: "[...COVERAGE_LOCK_KEYS].reverse().find(key => stored[key] !== current[key])" }]],
  ["tableau accepté comme verrou", [{ from: 'value !== null && typeof value === "object" && !Array.isArray(value)', to: 'value !== null && typeof value === "object"' }]],
  ["liaison à la politique ignorée", [{ from: "return isLockRecord(lock) && lock.coordinator === policy.version;", to: "return isLockRecord(lock);" }]]
];

await test("mutations : témoin (copie non mutée, hors dépôt) sans aucun écart", async () => {
  deepStrictEqual(contractFailures(await isolatedLock()), []);
});

for (const [name, replacements] of MUTATIONS) {
  await test(`mutation détectée : ${name}`, async () => {
    const module = await isolatedLock(replacements);
    let failures;
    try {
      failures = contractFailures(module);
    } catch (error) {
      failures = [`exception : ${error.message}`];
    }
    if (failures.length === 0) throw new Error("mutant non détecté");
    console.log(`       témoin : ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? ", …" : ""}`);
  });
}

for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });


await test("aucune tentative réseau", () => deepStrictEqual(networkGuard.attempts().length, 0));

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-lock-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
