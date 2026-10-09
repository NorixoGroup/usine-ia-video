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

import { SCRIPT_COVERAGE_POLICY, buildCoverageLock, researchEntitiesOf } from "../src/utils/coverage-lock-builder.js";
import * as lockModule from "../src/utils/coverage-lock.js";
import { COVERAGE_JUDGE_EXECUTOR_VERSION, EXECUTOR_LIMITS } from "../src/utils/coverage-judge-executor.js";
import { COVERAGE_DELETE_APPLIER_VERSION } from "../src/utils/coverage-delete-applier.js";
import { COVERAGE_COORDINATOR_VERSION } from "../src/utils/coverage-coordinator.js";
import { JUDGE_BOUNDS } from "../src/utils/coverage-judge-v2.js";
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
// VALEURS DE RÉFÉRENCE (R29.5 : verrou à 13 éléments ; protocol_id inchangé).

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
    "applier",
    "coordinator",
    "executor",
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
      "lock": {
        "splitter": "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5",
        "normalization": "coverage-normalization.v1",
        "protection": "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24",
        "entities_rule_version": "research-entities.v1",
        "entities_fingerprint": "bea118b8ed0781ed270dfcb7dd37c550b9a72b9829b83a8a5b26bef6b2221781",
        "classification": "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37",
        "judge": "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60",
        "repair": "coverage-repair.v1",
        "applier": "coverage-delete-applier.v1",
        "coordinator": "coverage-coordinator-policy.v1+coverage-coordinator.v1+bounds.044ac637475a7e34f11c755466e09e0c4456354d91dac5dfdef0175abc2a7765",
        "executor": "coverage-judge-executor.v1+limits.d021945b3ccd19fd6309da261b686af87ade7f17bd4d447bfb2d143c256b785c",
        "language": "fr",
        "baseline": "architecture-baseline-v1.0.3"
      },
      "lock_sha256": "5ae4c04fa8236ee7b47967660546df23303227ebccefaee0cdec7163918fd9fa",
      "protocol_id": "f5ddbda24c913f01aa479644b15c52dee88a5a0629231b4692bd7b0392f998c6",
      "boundary_protocol_id": "f5ddbda24c913f01aa479644b15c52dee88a5a0629231b4692bd7b0392f998c6",
      "voiceover_sha256": "f03ecfa6061ed702e0d136e2e6513268d74b5b49ce76b013ced3b7da750348ce"
    },
    "vide": {
      "lock": {
        "splitter": "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5",
        "normalization": "coverage-normalization.v1",
        "protection": "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24",
        "entities_rule_version": "research-entities.v1",
        "entities_fingerprint": "588d35b7806640d99b28f50c8dc34c22d5e783a6869e3e063ccebf643fc9ffcc",
        "classification": "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37",
        "judge": "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60",
        "repair": "coverage-repair.v1",
        "applier": "coverage-delete-applier.v1",
        "coordinator": "coverage-coordinator-policy.v1+coverage-coordinator.v1+bounds.044ac637475a7e34f11c755466e09e0c4456354d91dac5dfdef0175abc2a7765",
        "executor": "coverage-judge-executor.v1+limits.d021945b3ccd19fd6309da261b686af87ade7f17bd4d447bfb2d143c256b785c",
        "language": "fr",
        "baseline": "architecture-baseline-v1.0.3"
      },
      "lock_sha256": "72ee8520cc022553715a3aefc4663b5df86c38e5ddb0e089bd0ca6b9e43415ca",
      "protocol_id": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080",
      "boundary_protocol_id": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080",
      "voiceover_sha256": "f03ecfa6061ed702e0d136e2e6513268d74b5b49ce76b013ced3b7da750348ce"
    },
    "autre": {
      "lock": {
        "splitter": "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5",
        "normalization": "coverage-normalization.v1",
        "protection": "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24",
        "entities_rule_version": "research-entities.v1",
        "entities_fingerprint": "6251cdce46c4a7370ca133246d0a8826f872a25cb12e802749c4d681ffd5ccfe",
        "classification": "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37",
        "judge": "coverage-judge.v2+prompt.68cabf114f72f11dacc0163aff87ada549d145eb0886f559c694b2a752771c60",
        "repair": "coverage-repair.v1",
        "applier": "coverage-delete-applier.v1",
        "coordinator": "coverage-coordinator-policy.v1+coverage-coordinator.v1+bounds.044ac637475a7e34f11c755466e09e0c4456354d91dac5dfdef0175abc2a7765",
        "executor": "coverage-judge-executor.v1+limits.d021945b3ccd19fd6309da261b686af87ade7f17bd4d447bfb2d143c256b785c",
        "language": "fr",
        "baseline": "architecture-baseline-v1.0.3"
      },
      "lock_sha256": "ed155c75355f961ea5ad90fc0032f00c8569977f75b06f1b1e4d53ffea83fff3",
      "protocol_id": "760d2617cd6d6b4385c5847b57d7f83b442af5646267a7a73cc04872e91c4e61",
      "boundary_protocol_id": "760d2617cd6d6b4385c5847b57d7f83b442af5646267a7a73cc04872e91c4e61",
      "voiceover_sha256": "f03ecfa6061ed702e0d136e2e6513268d74b5b49ce76b013ced3b7da750348ce"
    }
  },
  "partial": {
    "lock_sha256": "46432ddec52f1fcb60ea7b7ed0eea75f4a88808f4f67e7946d17ce9479032195",
    "protocol_id": "f5ddbda24c913f01aa479644b15c52dee88a5a0629231b4692bd7b0392f998c6"
  },
  "extra": {
    "lock_sha256": "5ae4c04fa8236ee7b47967660546df23303227ebccefaee0cdec7163918fd9fa"
  },
  "empty": {
    "lock_sha256": "8f50aeea0e50f06d860cb05b5404bf0fe9dbe89607ec3f800fbb4fdd1f30d786",
    "protocol_id": "ad8f6f99a2114ab6d1113a501cc9432c7fecce25c69756c325cbee256c7601cd"
  },
  "script_json_sha256": {
    "happy": "645eed3a623529598c4d3daaa2f054dcea9356ef00a3d67822a8a13a91750d12",
    "script-coverage-repair": "d07f17d7d8840876cc1a2b90cb4efac95a3fe23098cf22f3188d2e65114001f9"
  },
  "script_json_protocol_id": {
    "happy": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080",
    "script-coverage-repair": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080"
  }
};

// Valeurs de R29.4 (verrou à 11 éléments), conservées pour prouver que R29.5 ne
// change que le verrou : protocol_id, empreinte du voiceover et éléments hérités
// restent identiques, lock_sha256 change.
const GOLDEN_R294 = {
  "cases": {
    "exemple": {
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
      },
      "lock_sha256": "d8584ddca53f8e7f313f4b4412f078e31dfe7560bfb4e0a12514835c50ec0281"
    },
    "vide": {
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
      },
      "lock_sha256": "9fc84a5e3c274cc907ce7775aa2d812eaca1fdeb9b08ecafdab0cf1070d80393"
    },
    "autre": {
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
      },
      "lock_sha256": "3eae4202f340c8e9d18a5afc4c314a9dd25fb3f1fd1ac8739449d9cb122500f9"
    }
  },
  "script_json_sha256": {
    "happy": "709153beb05ed4a9576bc4c7d4fe83e70d2d737a192ca46c183273fe8733270e",
    "script-coverage-repair": "0b7e8877f2b4bdec0665742623270a87d5d9db699862b41c732796d855e83085"
  },
  "script_json_protocol_id": {
    "happy": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080",
    "script-coverage-repair": "160161bc25ff12a1f0f5beb3cb34e129972a9ce227f9b1bf68906502b00c9080"
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

await test("liste des 13 éléments du verrou, dans l'ordre de la section 8 (R29.5)", () => {
  deepStrictEqual([...COVERAGE_LOCK_KEYS], GOLDEN.keys);
  deepStrictEqual(GOLDEN.keys.length, 13);
});

await test("liste des 7 éléments consommés par la frontière", () => {
  deepStrictEqual([...BOUNDARY_LOCK_KEYS], GOLDEN.boundaryKeys);
  deepStrictEqual(GOLDEN.boundaryKeys, GOLDEN.keys.filter(key => !["judge", "repair", "applier", "coordinator", "executor", "baseline"].includes(key)));
});

await test("baseline et version de la frontière composée", () => {
  deepStrictEqual([ARCHITECTURE_BASELINE_VERSION, COMPOSITE_COVERAGE_BOUNDARY_VERSION], [GOLDEN.baseline, GOLDEN.composite]);
  deepStrictEqual(GOLDEN.composite, GOLDEN.expected);
});

for (const name of Object.keys(RESEARCH)) {
  const reference = GOLDEN.cases[name];
  const entities = researchEntitiesOf(RESEARCH[name]);
  const lock = buildCoverageLock({ entities });

  await test(`verrou courant « ${name} » : les 13 éléments sont identiques`, () => {
    deepStrictEqual(clone(lock), reference.lock);
  });

  await test(`verrou « ${name} » : lock_sha256 conforme à la référence R29.5`, () => {
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

await test("R29.5 : seul lock_sha256 change — protocol_id, voiceover et éléments hérités identiques à R29.4", () => {
  for (const name of Object.keys(GOLDEN.cases)) {
    const now = GOLDEN.cases[name];
    const before = GOLDEN_R294.cases[name];
    if (now.lock_sha256 === before.lock_sha256) throw new Error(`${name} : lock_sha256 inchangé`);
    const changed = Object.keys(now.lock).filter(key => key in before.lock && now.lock[key] !== before.lock[key]);
    const added = Object.keys(now.lock).filter(key => !(key in before.lock));
    deepStrictEqual([name, changed, added], [name, ["coordinator"], ["applier", "executor"]]);
    deepStrictEqual(Object.keys(before.lock).filter(key => !(key in now.lock)), []);
  }
});

await test("R29.5 : les 13 éléments courants sont exactement les 11 de R29.4 plus applier, executor et la nouvelle valeur de coordinator", () => {
  for (const name of Object.keys(RESEARCH)) {
    const lock = clone(buildCoverageLock({ entities: researchEntitiesOf(RESEARCH[name]) }));
    const old = GOLDEN_R294.cases[name].lock;
    for (const key of Object.keys(old)) if (key !== "coordinator") deepStrictEqual([key, lock[key]], [key, old[key]]);
    deepStrictEqual(lock.applier, "coverage-delete-applier.v1");
    deepStrictEqual(lock.coordinator.startsWith("coverage-coordinator-policy.v1+coverage-coordinator.v1+bounds."), true);
    deepStrictEqual(lock.executor.startsWith("coverage-judge-executor.v1+limits."), true);
  }
});

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
  await test(`script.json (scénario ${scenario}) : octets identiques à la référence R29.5, protocol_id identique à R29.4`, () => {
    const run = runPipeline(scenario);
    if (run.status !== 0 || !run.id) throw new Error(`exit ${run.status}\n${run.stderr.slice(-400)}`);
    const raw = fs.readFileSync(path.join(PROJECTS, run.id, "script.json"));
    const sha = crypto.createHash("sha256").update(raw).digest("hex");
    const coverage = JSON.parse(raw.toString("utf8")).claim_coverage_validation;
    deepStrictEqual([sha, run.blocked], [GOLDEN.script_json_sha256[scenario], 0]);
    deepStrictEqual(coverage.protocol_id, GOLDEN_R294.script_json_protocol_id[scenario]);
    deepStrictEqual(coverage.protocol_id, GOLDEN.script_json_protocol_id[scenario]);
    if (sha === GOLDEN_R294.script_json_sha256[scenario]) throw new Error("script.json inchangé : le verrou n'a pas été étendu");
    deepStrictEqual(Object.keys(coverage.lock), GOLDEN.keys);
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
    "boundaryProtocolIdFromLock", "boundsFingerprint", "coordinatorLockElement", "executorLockElement", "firstDifferingLockElement",
    "invalidLockElements", "isLockRecord", "lockMatchesPolicy", "lockSha256", "protocolIdFromVersions", "unexpectedLockElements"
  ]);
});

await test("listes d'éléments figées et immuables", () => {
  if (!Object.isFrozen(COVERAGE_LOCK_KEYS) || !Object.isFrozen(BOUNDARY_LOCK_KEYS)) throw new Error("liste modifiable");
  deepStrictEqual(COVERAGE_LOCK_KEYS.length, 13);
  deepStrictEqual(BOUNDARY_LOCK_KEYS.length, 7);
});

await test("la liste de la frontière est dérivée de la liste complète, dans le même ordre", () => {
  deepStrictEqual([...BOUNDARY_LOCK_KEYS], COVERAGE_LOCK_KEYS.filter(key => BOUNDARY_LOCK_KEYS.includes(key)));
  for (const key of ["judge", "repair", "applier", "coordinator", "executor", "baseline"]) if (BOUNDARY_LOCK_KEYS.includes(key)) throw new Error(`${key} ne concerne pas la frontière`);
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

const REF_POLICY = { version: "coverage-coordinator-policy.v1", max_rounds: 10, max_total_judge_calls: 12 };

await test("lockMatchesPolicy : le coordinateur du verrou doit porter la version et les bornes de la politique (R29.5)", () => {
  deepStrictEqual(lockMatchesPolicy(BASE_LOCK, REF_POLICY), true);
  deepStrictEqual(lockMatchesPolicy(BASE_LOCK, { ...REF_POLICY, version: "autre" }), false);
  deepStrictEqual(lockMatchesPolicy(BASE_LOCK, { ...REF_POLICY, max_rounds: 11 }), false);
  deepStrictEqual(lockMatchesPolicy(BASE_LOCK, { ...REF_POLICY, max_total_judge_calls: 13 }), false);
  deepStrictEqual([null, undefined, [], "x"].map(lock => lockMatchesPolicy(lock, REF_POLICY)), [false, false, false, false]);
  deepStrictEqual(lockMatchesPolicy({ ...BASE_LOCK, coordinator: 42 }, REF_POLICY), false);
});

await test("R29.5 : empreintes de bornes — dérivées du contenu, indépendantes de l'ordre des clés", () => {
  deepStrictEqual(lockModule.boundsFingerprint({ a: 1, b: 2 }), lockModule.boundsFingerprint({ b: 2, a: 1 }));
  if (lockModule.boundsFingerprint({ a: 1 }) === lockModule.boundsFingerprint({ a: 2 })) throw new Error("empreinte insensible à la valeur");
  const executor = lockModule.executorLockElement({ executorVersion: "v", limits: { x: 1 } });
  if (executor === lockModule.executorLockElement({ executorVersion: "v", limits: { x: 2 } })) throw new Error("limites non empreintées");
  if (executor === lockModule.executorLockElement({ executorVersion: "w", limits: { x: 1 } })) throw new Error("version non reprise");
  const coordinator = lockModule.coordinatorLockElement({ policy: REF_POLICY, coordinatorVersion: "c1" });
  for (const other of [{ ...REF_POLICY, max_rounds: 9 }, { ...REF_POLICY, max_total_judge_calls: 11 }, { ...REF_POLICY, version: "p2" }]) {
    if (lockModule.coordinatorLockElement({ policy: other, coordinatorVersion: "c1" }) === coordinator) throw new Error("politique non reprise");
  }
  if (lockModule.coordinatorLockElement({ policy: REF_POLICY, coordinatorVersion: "c2" }) === coordinator) throw new Error("version du coordinateur non reprise");
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
  ["la liste des 13 éléments du verrou", /"executor",\s*\n\s*"language",/, ["coverage-lock.js"]],
  ["le JSON stable du verrou", /function stableJson\(/, ["coverage-lock.js"]],
  ["l'algorithme de protocol_id", /stableJson\(\{\s*versions/, ["coverage-lock.js"]],
  ["l'empreinte du verrou", /function lockSha256\(/, ["coverage-lock.js"]],
  ["la liaison coordinateur / politique", /lock\.coordinator\.(startsWith|endsWith)\(/, ["coverage-lock.js"]],
  ["l'empreinte des bornes", /function boundsFingerprint\(/, ["coverage-lock.js"]],
  ["l'élément coordinateur (version, code, bornes)", /function coordinatorLockElement\(/, ["coverage-lock.js"]],
  ["l'élément exécuteur (version, limites)", /function executorLockElement\(/, ["coverage-lock.js"]],
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

// D7 (R29.5) : inventaire des constantes de bornes. Toute constante exportée de
// type bornes / limites / politique, ou toute constante numérique de module,
// d'un module de couverture doit être verrouillée ou figurer dans une liste
// d'exclusions justifiée. Une nouvelle constante non déclarée fait échouer ce test.
const LOCKED_BOUNDS = {
  JUDGE_BOUNDS: "judge",
  EXECUTOR_LIMITS: "executor",
  SCRIPT_COVERAGE_POLICY: "coordinator"
};
const NUMERIC_EXCLUSIONS = {
  // Validée contre slot_max_bound du registre de classification, lui-même couvert par l'empreinte du registre (élément classification).
  MAX_SLOT_BOUND: "classification"
};

await test("D7 — inventaire : chaque constante de bornes est verrouillée ou exclue avec justification", () => {
  const exported = {};
  const numeric = [];
  for (const name of COVERAGE_FILES) {
    const code = codeOf(name);
    for (const match of code.matchAll(/^export const ([A-Z][A-Z0-9_]*(?:BOUNDS|LIMITS|POLICY)) = /gm)) exported[match[1]] = name;
    for (const match of code.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = \d+;/gm)) numeric.push(match[1]);
  }
  deepStrictEqual(Object.keys(exported).sort(), Object.keys(LOCKED_BOUNDS).sort());
  deepStrictEqual(numeric.sort(), Object.keys(NUMERIC_EXCLUSIONS).sort());
});

await test("D7 — chaque constante de bornes verrouillée modifie l'élément correspondant du verrou", () => {
  const entities = researchEntitiesOf(RESEARCH.exemple);
  const lock = buildCoverageLock({ entities });
  // exécuteur : limites réelles
  deepStrictEqual(lock.executor, lockModule.executorLockElement({ executorVersion: COVERAGE_JUDGE_EXECUTOR_VERSION, limits: EXECUTOR_LIMITS }));
  for (const key of Object.keys(EXECUTOR_LIMITS)) {
    const changed = lockModule.executorLockElement({ executorVersion: COVERAGE_JUDGE_EXECUTOR_VERSION, limits: { ...EXECUTOR_LIMITS, [key]: EXECUTOR_LIMITS[key] + 1 } });
    if (changed === lock.executor) throw new Error(`limite ${key} non verrouillée`);
  }
  // coordinateur : bornes réelles de la politique
  for (const key of ["max_rounds", "max_total_judge_calls"]) {
    const other = buildCoverageLock({ entities, policy: { ...SCRIPT_COVERAGE_POLICY, [key]: SCRIPT_COVERAGE_POLICY[key] + 1 } });
    if (other.coordinator === lock.coordinator) throw new Error(`borne ${key} non verrouillée`);
    if (lockSha256(other) === lockSha256(lock)) throw new Error(`borne ${key} absente de l'empreinte`);
  }
  // juge : les bornes réelles sont dans la version publique du juge
  const judgeSource = codeOf("coverage-judge-v2.js");
  if (!/bounds: JUDGE_BOUNDS/.test(judgeSource)) throw new Error("JUDGE_BOUNDS absent de la version du juge");
  deepStrictEqual(Object.keys(JUDGE_BOUNDS).length > 0, true);
  // applicateur et coordinateur : versions de code reprises
  deepStrictEqual(lock.applier, COVERAGE_DELETE_APPLIER_VERSION);
  if (!lock.coordinator.includes(`+${COVERAGE_COORDINATOR_VERSION}+`)) throw new Error("version du coordinateur absente");
});

await test("le contrat n'a aucune dépendance interne, le constructeur n'importe que des composants et le contrat", () => {
  const graph = importGraph();
  deepStrictEqual(graph.get(path.join("src", "utils", "coverage-lock.js")), []);
  deepStrictEqual(graph.get(path.join("src", "utils", "coverage-lock-builder.js")).map(file => path.basename(file)).sort(), [
    "coverage-classification.js", "coverage-coordinator.js", "coverage-delete-applier.js", "coverage-judge-executor.js", "coverage-judge-v2.js",
    "coverage-lock.js", "coverage-normalization.js", "coverage-protection.js", "coverage-repair.js", "coverage-unit-splitter.js"
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
  check("liste des 13", [...module.COVERAGE_LOCK_KEYS], GOLDEN.keys);
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
  check("liaison à la politique", [module.lockMatchesPolicy(BASE_LOCK, REF_POLICY), module.lockMatchesPolicy(BASE_LOCK, { ...REF_POLICY, version: "x" }), module.lockMatchesPolicy([], REF_POLICY)], [true, false, false]);
  check("liaison aux bornes de la politique", [module.lockMatchesPolicy(BASE_LOCK, { ...REF_POLICY, max_rounds: 11 }), module.lockMatchesPolicy(BASE_LOCK, { ...REF_POLICY, max_total_judge_calls: 13 })], [false, false]);
  check("élément coordinateur", module.coordinatorLockElement({ policy: REF_POLICY, coordinatorVersion: "coverage-coordinator.v1" }), BASE_LOCK.coordinator);
  check("élément coordinateur, bornes", module.coordinatorLockElement({ policy: { ...REF_POLICY, max_rounds: 11 }, coordinatorVersion: "coverage-coordinator.v1" }) === BASE_LOCK.coordinator, false);
  check("élément coordinateur, version du code", module.coordinatorLockElement({ policy: REF_POLICY, coordinatorVersion: "coverage-coordinator.v2" }) === BASE_LOCK.coordinator, false);
  check("élément exécuteur", module.executorLockElement({ executorVersion: "coverage-judge-executor.v1", limits: { max_request_chars: 16000, max_tokens: 4000, max_response_chars: 16000, timeout_ms: 120000 } }), BASE_LOCK.executor);
  check("élément exécuteur, limites", module.executorLockElement({ executorVersion: "coverage-judge-executor.v1", limits: { max_request_chars: 16001, max_tokens: 4000, max_response_chars: 16000, timeout_ms: 120000 } }) === BASE_LOCK.executor, false);
  check("empreinte de bornes, ordre des clés", module.boundsFingerprint({ a: 1, b: 2 }) === module.boundsFingerprint({ b: 2, a: 1 }), true);
  check("protocol_id selon les versions", module.protocolIdFromVersions({ versions: { composite: "c", language: "fr" }, entitiesFingerprint: "f" }), protocolIdFromVersions({ versions: { composite: "c", language: "fr" }, entitiesFingerprint: "f" }));
  return failures;
}

const MUTATIONS = [
  ["élément « réparation » retiré de la liste", [{ from: '  "repair",\n', to: "" }]],
  ["élément « coordinateur » retiré de la liste", [{ from: '  "coordinator",\n', to: "" }]],
  ["élément superflu pris en compte dans l'empreinte", [{ from: "Object.fromEntries(COVERAGE_LOCK_KEYS.map(key => [key, lock?.[key] ?? null]))", to: "{ ...lock }" }]],
  ["verrou absent non neutralisé dans l'empreinte", [{ from: "lock?.[key] ?? null]))));", to: "lock[key] ?? null]))));" }]],
  ["élément « applicateur » retiré de la liste", [{ from: '  "applier",\n', to: "" }]],
  ["élément « exécuteur » retiré de la liste", [{ from: '  "executor",\n', to: "" }]],
  ["liste de la frontière contient la baseline", [{ from: '["judge", "repair", "applier", "coordinator", "executor", "baseline"]', to: '["judge", "repair", "applier", "coordinator", "executor"]' }]],
  ["liste de la frontière contient l'applicateur", [{ from: '["judge", "repair", "applier", "coordinator", "executor", "baseline"]', to: '["judge", "repair", "coordinator", "executor", "baseline"]' }]],
  ["liste de la frontière contient l'exécuteur", [{ from: '["judge", "repair", "applier", "coordinator", "executor", "baseline"]', to: '["judge", "repair", "applier", "coordinator", "baseline"]' }]],
  ["empreinte de bornes constante", [{ from: "return sha256(stableJson(bounds ?? null));", to: 'return sha256("bornes");' }]],
  ["bornes de la politique ignorées dans l'élément coordinateur", [{ from: "return `${policy?.version ?? null}+${coordinatorVersion}+bounds.${boundsFingerprint(policyBounds(policy))}`;", to: "return `${policy?.version ?? null}+${coordinatorVersion}+bounds.${boundsFingerprint({})}`;" }]],
  ["version du code du coordinateur ignorée", [{ from: "${policy?.version ?? null}+${coordinatorVersion}+bounds.", to: "${policy?.version ?? null}+bounds." }]],
  ["limites de l'exécuteur ignorées", [{ from: "return `${executorVersion}+limits.${boundsFingerprint(limits)}`;", to: "return `${executorVersion}+limits.${boundsFingerprint({})}`;" }]],
  ["liaison aux bornes de la politique ignorée", [{ from: "    lock.coordinator.startsWith(`${policy.version}+`) &&\n    lock.coordinator.endsWith(`+bounds.${boundsFingerprint(policyBounds(policy))}`);", to: "    lock.coordinator.startsWith(`${policy.version}+`);" }]],
  ["identifiant de protocole sans la version composite", [{ from: "      composite: COMPOSITE_COVERAGE_BOUNDARY_VERSION,\n", to: "" }]],
  ["identifiant de protocole sans la langue", [{ from: "      language: lock?.language ?? null\n", to: "      language: null\n" }]],
  ["identifiant de protocole sans l'empreinte des entités", [{ from: "entitiesFingerprint: lock?.entities_fingerprint ?? null", to: "entitiesFingerprint: null" }]],
  ["élément vide accepté", [{ from: 'typeof lock[key] !== "string" || lock[key] === ""', to: 'typeof lock[key] !== "string"' }]],
  ["élément non chaîne accepté", [{ from: 'typeof lock[key] !== "string" || lock[key] === ""', to: "lock[key] === undefined" }]],
  ["éléments superflus ignorés", [{ from: "Object.keys(lock).filter(key => !COVERAGE_LOCK_KEYS.includes(key))", to: "[]" }]],
  ["premier écart cherché à rebours", [{ from: "COVERAGE_LOCK_KEYS.find(key => stored[key] !== current[key])", to: "[...COVERAGE_LOCK_KEYS].reverse().find(key => stored[key] !== current[key])" }]],
  ["tableau accepté comme verrou", [{ from: 'value !== null && typeof value === "object" && !Array.isArray(value)', to: 'value !== null && typeof value === "object"' }]],
  ["liaison à la politique ignorée", [{ from: "return isLockRecord(lock) && typeof lock.coordinator === \"string\" &&", to: "return isLockRecord(lock) || true ||" }]]
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
