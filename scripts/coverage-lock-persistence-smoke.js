// Smoke R28.11 — persistance et contrôle du verrou de couverture à la reprise
// (baseline v1.0.3, sections 7 et 8), zéro API. Le verrou complet (11
// éléments) est enregistré dans script.json au premier passage, relu à la
// reprise et comparé strictement au verrou courant ; toute divergence est un
// échec fermé qualifié (LOCK_MISSING, LOCK_INVALID, LOCK_SHA_MISMATCH,
// LOCK_MISMATCH), avant tout appel et toute écriture.
//
// Parties : module de contrôle pur ; reprise sur un dossier de production
// temporaire (vrais scellés) ; orchestrateur réel en processus enfant sous
// fixtures (premier passage, reprise nominale, verrou altéré) ; câblage ;
// mutations avec témoin (copies hors dépôt).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-lock-persistence-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import {
  COVERAGE_LOCK_CHECK_VERSION,
  LOCK_CHECK_STATUS,
  LOCK_REFUSAL,
  checkPersistedCoverageLock
} from "../src/utils/coverage-lock-persistence.js";
import { buildCoverageLock, researchEntitiesOf } from "../src/utils/coverage-lock-builder.js";
import { COVERAGE_LOCK_KEYS, lockSha256 } from "../src/utils/coverage-lock.js";
import { assertReusedScriptLock, sealAndWriteArtifact } from "../src/orchestrator/resume.js";
import { runScriptAgent } from "../src/agents/script.js";
import { runResearchAgent } from "../src/agents/research.js";
import { CANONICAL_PROMPT, CANONICAL_TITLE } from "../src/fixtures/anthropic-dataset.js";

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
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const expectRefusal = (result, code, category) => deepStrictEqual([result.status, result.code, result.category], [LOCK_CHECK_STATUS.REFUSED, code, category]);

// ---------------------------------------------------------------------------
// Premier passage réel (fixtures) : script.json tel qu'il serait écrit.

process.env.ANTHROPIC_FIXTURES = "1";
process.env.ANTHROPIC_FIXTURE_SCENARIO = "happy";
const research = (await runResearchAgent({ title: CANONICAL_TITLE, prompt: CANONICAL_PROMPT, testMode: true })).data;
const first = await runScriptAgent({ research, title: CANONICAL_TITLE, testMode: true });
const second = await runScriptAgent({ research, title: CANONICAL_TITLE, testMode: true });
delete process.env.ANTHROPIC_FIXTURE_SCENARIO;
delete process.env.ANTHROPIC_FIXTURES;

const COVERAGE = first.claim_coverage_validation;
const buildLock = dossier => buildCoverageLock({ entities: researchEntitiesOf(dossier) });
const CURRENT = buildLock(research);

console.log("--- 1. Premier passage : le verrou est enregistré ---");

await test("script.json : le verrou complet (11 éléments, dans l'ordre de la section 8) est enregistré", () => {
  deepStrictEqual(Object.keys(COVERAGE.lock), [...COVERAGE_LOCK_KEYS]);
  deepStrictEqual(COVERAGE_LOCK_KEYS.length, 11);
  for (const key of COVERAGE_LOCK_KEYS) if (typeof COVERAGE.lock[key] !== "string" || COVERAGE.lock[key] === "") throw new Error(key);
});

await test("script.json : l'empreinte enregistrée est celle du verrou enregistré, reprise par chaque segment", () => {
  deepStrictEqual(COVERAGE.lock_sha256, lockSha256(COVERAGE.lock));
  if (!HEX64.test(COVERAGE.lock_sha256)) throw new Error("empreinte invalide");
  for (const segment of COVERAGE.segments) deepStrictEqual(segment.lock_sha256, COVERAGE.lock_sha256);
});

await test("script.json : le verrou enregistré est le verrou courant des versions et des entités", () => {
  deepStrictEqual(clone(COVERAGE.lock), clone(CURRENT));
  deepStrictEqual(COVERAGE.lock.baseline, "architecture-baseline-v1.0.3");
  deepStrictEqual(COVERAGE.lock.entities_fingerprint, researchEntitiesOf(research).fingerprint);
});

await test("script.json : champs de claim_coverage_validation limités aux métadonnées autorisées", () => {
  deepStrictEqual(Object.keys(COVERAGE), ["valid", "errors", "status", "protocol_id", "lock_sha256", "lock", "segments"]);
});

await test("premier passage déterministe : deux exécutions, octets identiques", () => {
  deepStrictEqual(JSON.stringify(first.claim_coverage_validation), JSON.stringify(second.claim_coverage_validation));
});

// ---------------------------------------------------------------------------
console.log("--- 2. Module de contrôle (pur) ---");

const check = (coverage, currentLock = CURRENT) => checkPersistedCoverageLock({ coverage, currentLock });

// Variante cohérente : un élément du verrou enregistré modifié, empreintes
// recalculées (le contrôle se fait sur le contenu, pas sur l'empreinte).
function coverageWith(key, value) {
  const coverage = clone(COVERAGE);
  coverage.lock[key] = value;
  coverage.lock_sha256 = lockSha256(coverage.lock);
  for (const segment of coverage.segments) segment.lock_sha256 = coverage.lock_sha256;
  return coverage;
}

await test("constantes publiques : version du contrôle, statuts et refus fermés", () => {
  deepStrictEqual(COVERAGE_LOCK_CHECK_VERSION, "coverage-lock-persistence.v1");
  deepStrictEqual(Object.values(LOCK_CHECK_STATUS), ["OK", "REFUSED"]);
  deepStrictEqual(Object.values(LOCK_REFUSAL), ["LOCK_MISSING", "LOCK_INVALID", "LOCK_SHA_MISMATCH", "LOCK_MISMATCH"]);
});

await test("reprise nominale : verrou enregistré identique au verrou courant → OK", () => {
  const result = check(COVERAGE);
  deepStrictEqual([result.status, result.code, result.category, result.detail], ["OK", null, null, null]);
});

await test("sortie figée, sans état : appels répétés identiques", () => {
  const results = [check(COVERAGE), check(COVERAGE), check(coverageWith("repair", "autre"))];
  if (!results.every(Object.isFrozen)) throw new Error("sortie modifiable");
  deepStrictEqual(JSON.stringify(results[0]), JSON.stringify(results[1]));
  deepStrictEqual(JSON.stringify(check(coverageWith("repair", "autre"))), JSON.stringify(results[2]));
});

for (const key of COVERAGE_LOCK_KEYS) {
  await test(`élément divergent (enregistré) : ${key} → LOCK_MISMATCH (${key})`, () => {
    expectRefusal(check(coverageWith(key, `${CURRENT[key]}-ancien`)), "LOCK_MISMATCH", key);
  });

  await test(`élément divergent (courant) : ${key} → LOCK_MISMATCH (${key})`, () => {
    expectRefusal(check(COVERAGE, { ...CURRENT, [key]: `${CURRENT[key]}-nouveau` }), "LOCK_MISMATCH", key);
  });

  await test(`élément modifié sans recalcul de l'empreinte : ${key} → LOCK_SHA_MISMATCH`, () => {
    const coverage = clone(COVERAGE);
    coverage.lock[key] = `${CURRENT[key]}-altéré`;
    expectRefusal(check(coverage), "LOCK_SHA_MISMATCH", "STORED_LOCK");
  });
}

await test("plusieurs éléments divergents : la catégorie est le premier dans l'ordre de la section 8", () => {
  const coverage = coverageWith("baseline", "architecture-baseline-v1.0.2");
  coverage.lock.splitter = "autre";
  coverage.lock_sha256 = lockSha256(coverage.lock);
  for (const segment of coverage.segments) segment.lock_sha256 = coverage.lock_sha256;
  expectRefusal(check(coverage), "LOCK_MISMATCH", "splitter");
});

await test("baseline différente (v1.0.2 enregistrée, v1.0.3 courante) → LOCK_MISMATCH (baseline)", () => {
  expectRefusal(check(coverageWith("baseline", "architecture-baseline-v1.0.2")), "LOCK_MISMATCH", "baseline");
});

await test("réparation différente → LOCK_MISMATCH (repair)", () => {
  expectRefusal(check(coverageWith("repair", "coverage-repair.v0")), "LOCK_MISMATCH", "repair");
});

await test("coordinateur différent → LOCK_MISMATCH (coordinator)", () => {
  expectRefusal(check(coverageWith("coordinator", "coverage-coordinator-policy.v0")), "LOCK_MISMATCH", "coordinator");
});

await test("empreinte des entités différente (dossier Research modifié) → LOCK_MISMATCH (entities_fingerprint)", () => {
  const other = { key_facts: [{ claim: "La ville de Perth grandit." }] };
  expectRefusal(check(COVERAGE, buildLock(other)), "LOCK_MISMATCH", "entities_fingerprint");
});

await test("lock_sha256 différent → LOCK_SHA_MISMATCH", () => {
  const coverage = clone(COVERAGE);
  coverage.lock_sha256 = "0".repeat(64);
  expectRefusal(check(coverage), "LOCK_SHA_MISMATCH", "STORED_LOCK");
});

await test("lock_sha256 d'un segment différent → LOCK_SHA_MISMATCH (SEGMENT)", () => {
  const coverage = clone(COVERAGE);
  coverage.segments[1].lock_sha256 = "f".repeat(64);
  expectRefusal(check(coverage), "LOCK_SHA_MISMATCH", "SEGMENT");
});

await test("segment sans empreinte → LOCK_SHA_MISMATCH (SEGMENT)", () => {
  const coverage = clone(COVERAGE);
  delete coverage.segments[0].lock_sha256;
  expectRefusal(check(coverage), "LOCK_SHA_MISMATCH", "SEGMENT");
});

for (const [name, coverage] of [
  ["metadonnées absentes", undefined],
  ["métadonnées nulles", null],
  ["métadonnées non objet", "x"],
  ["métadonnées sans verrou", (() => { const value = clone(COVERAGE); delete value.lock; return value; })()],
  ["verrou nul", { ...clone(COVERAGE), lock: null }],
  ["ancien format (avant R28.11)", { valid: true, errors: [], status: "PASS", protocol_id: COVERAGE.protocol_id, lock_sha256: COVERAGE.lock_sha256, segments: clone(COVERAGE.segments) }]
]) {
  await test(`verrou absent (${name}) → LOCK_MISSING`, () => expectRefusal(check(coverage), "LOCK_MISSING", "LOCK"));
}

for (const key of COVERAGE_LOCK_KEYS) {
  await test(`verrou incomplet : ${key} absent → LOCK_INVALID (${key})`, () => {
    const coverage = clone(COVERAGE);
    delete coverage.lock[key];
    expectRefusal(check(coverage), "LOCK_INVALID", key);
  });
}

for (const [name, mutate, category] of [
  ["élément vide", coverage => { coverage.lock.judge = ""; }, "judge"],
  ["élément non chaîne", coverage => { coverage.lock.language = 3; }, "language"],
  ["élément nul", coverage => { coverage.lock.protection = null; }, "protection"],
  ["élément superflu", coverage => { coverage.lock.extra = "x"; }, "extra"],
  ["verrou non objet", coverage => { coverage.lock = "texte"; }, "LOCK"],
  ["verrou tableau", coverage => { coverage.lock = [1, 2]; }, "LOCK"],
  ["empreinte absente", coverage => { delete coverage.lock_sha256; }, "lock_sha256"],
  ["empreinte non hexadécimale", coverage => { coverage.lock_sha256 = "ZZ"; }, "lock_sha256"],
  ["segments absents", coverage => { delete coverage.segments; }, "segments"]
]) {
  await test(`verrou invalide (${name}) → LOCK_INVALID (${category})`, () => {
    const coverage = clone(COVERAGE);
    mutate(coverage);
    expectRefusal(check(coverage), "LOCK_INVALID", category);
  });
}

await test("verrou courant incomplet ou absent → LOCK_INVALID (CURRENT_LOCK), jamais un OK", () => {
  const { baseline, ...partial } = CURRENT;
  for (const current of [undefined, null, {}, partial, { ...CURRENT, baseline: "" }]) expectRefusal(checkPersistedCoverageLock({ coverage: COVERAGE, currentLock: current }), "LOCK_INVALID", "CURRENT_LOCK");
});

await test("aucune exception : entrées absentes ou aberrantes → refus qualifié", () => {
  for (const input of [undefined, null, {}, { coverage: COVERAGE }, { currentLock: CURRENT }, { coverage: { get lock() { throw new Error("piège"); } }, currentLock: CURRENT }]) {
    const result = checkPersistedCoverageLock(input);
    deepStrictEqual(result.status, "REFUSED");
  }
});

await test("aucun faux OK : toute modification d'un seul élément, d'un côté ou de l'autre, refuse", () => {
  for (const key of COVERAGE_LOCK_KEYS) {
    deepStrictEqual(check(coverageWith(key, "x")).status, "REFUSED");
    deepStrictEqual(check(COVERAGE, { ...CURRENT, [key]: "x" }).status, "REFUSED");
  }
});

await test("le contrôle ne modifie pas ses entrées", () => {
  const coverage = clone(COVERAGE);
  const current = clone(CURRENT);
  check(coverage, current);
  deepStrictEqual([JSON.stringify(coverage), JSON.stringify(current)], [JSON.stringify(COVERAGE), JSON.stringify(CURRENT)]);
});

// ---------------------------------------------------------------------------
console.log("--- 3. Reprise sur un dossier de production (vrais scellés) ---");

const tempDirs = [];

function productionDirectory({ coverageOf = value => value, truth = true, sealTruth = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-lock-resume-"));
  tempDirs.push(dir);
  const production = { id: "prod-test", mode: "test", artifact_sha256: {} };
  const save = () => {};
  const scriptEnvelope = { agent: "script", mode: "test", data: first.data, validation: first.validation, claim_coverage_validation: coverageOf(clone(COVERAGE)) };
  sealAndWriteArtifact({ productionDir: dir, production, filename: "script.json", save, data: scriptEnvelope });
  if (truth) {
    sealAndWriteArtifact({ productionDir: dir, production, filename: "truth.json", save, data: { agent: "truth", mode: "test", data: { research_dossier: research }, validation: { valid: true } } });
    if (!sealTruth) production.artifact_sha256["truth.json"] = "0".repeat(64);
  }
  return { dir, production };
}

const snapshotOf = directory => Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort().map(name => [name, sha256(fs.readFileSync(path.join(directory, name)))]));
const reprise = ({ dir, production }) => assertReusedScriptLock({ productionDir: dir, production, buildLock });
const expectReprise = (context, pattern) => {
  const before = snapshotOf(context.dir);
  let error = null;
  try {
    reprise(context);
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error("reprise acceptée à tort");
  if (!pattern.test(error.message)) throw new Error(`message inattendu : ${error.message}`);
  if (!error.message.startsWith("Reprise refusée : verrou de couverture")) throw new Error(error.message);
  deepStrictEqual(snapshotOf(context.dir), before);
};

await test("reprise nominale : verrou identique, reprise acceptée, aucune écriture", () => {
  const context = productionDirectory();
  const before = snapshotOf(context.dir);
  const result = reprise(context);
  deepStrictEqual([result.status, snapshotOf(context.dir)], ["OK", before]);
});

await test("reprise : verrou absent du script.json → LOCK_MISSING, rien d'écrit", () => {
  expectReprise(productionDirectory({ coverageOf: coverage => { delete coverage.lock; return coverage; } }), /LOCK_MISSING \(LOCK\)/);
});

await test("reprise : verrou incomplet → LOCK_INVALID", () => {
  expectReprise(productionDirectory({ coverageOf: coverage => { delete coverage.lock.repair; return coverage; } }), /LOCK_INVALID \(repair\)/);
});

await test("reprise : lock_sha256 différent → LOCK_SHA_MISMATCH", () => {
  expectReprise(productionDirectory({ coverageOf: coverage => { coverage.lock_sha256 = "a".repeat(64); return coverage; } }), /LOCK_SHA_MISMATCH \(STORED_LOCK\)/);
});

for (const key of COVERAGE_LOCK_KEYS) {
  await test(`reprise : ${key} différent (rescellé) → LOCK_MISMATCH (${key}), rien d'écrit`, () => {
    expectReprise(productionDirectory({
      coverageOf: coverage => {
        coverage.lock[key] = `${coverage.lock[key]}-ancien`;
        coverage.lock_sha256 = lockSha256(coverage.lock);
        for (const segment of coverage.segments) segment.lock_sha256 = coverage.lock_sha256;
        return coverage;
      }
    }), new RegExp(`LOCK_MISMATCH \\(${key}\\)`));
  });
}

await test("reprise : dossier Research du truth.json modifié → LOCK_MISMATCH (entities_fingerprint)", () => {
  const context = productionDirectory();
  const production = context.production;
  sealAndWriteArtifact({ productionDir: context.dir, production, filename: "truth.json", save: () => {}, data: { agent: "truth", mode: "test", data: { research_dossier: { ...research, key_facts: [{ claim: "La ville de Perth grandit." }] } }, validation: { valid: true } } });
  expectReprise(context, /LOCK_MISMATCH \(entities_fingerprint\)/);
});

await test("reprise : truth.json absent → refus qualifié (ENTITIES_UNAVAILABLE), jamais de repli", () => {
  expectReprise(productionDirectory({ truth: false }), /LOCK_INVALID \(ENTITIES_UNAVAILABLE\)/);
});

await test("reprise : truth.json sans scellé valide → refus qualifié (ENTITIES_UNAVAILABLE)", () => {
  expectReprise(productionDirectory({ sealTruth: false }), /LOCK_INVALID \(ENTITIES_UNAVAILABLE\)/);
});

await test("reprise : script.json illisible → LOCK_INVALID", () => {
  const context = productionDirectory();
  fs.writeFileSync(path.join(context.dir, "script.json"), "pas du json");
  expectReprise(context, /LOCK_INVALID \(script\.json\)/);
});

await test("reprise : constructeur du verrou courant en échec → LOCK_INVALID (CURRENT_LOCK), aucune exception brute", () => {
  const context = productionDirectory();
  let error = null;
  try {
    assertReusedScriptLock({ productionDir: context.dir, production: context.production, buildLock: () => { throw new Error("panne"); } });
  } catch (caught) {
    error = caught;
  }
  if (!error || !/LOCK_INVALID \(CURRENT_LOCK\)/.test(error.message)) throw new Error(error?.message);
});

await test("reprise déterministe : mêmes entrées, même décision et même message", () => {
  const messages = [0, 1].map(() => {
    try {
      reprise(productionDirectory({ coverageOf: coverage => { coverage.lock.baseline = "architecture-baseline-v1.0.2"; coverage.lock_sha256 = lockSha256(coverage.lock); for (const segment of coverage.segments) segment.lock_sha256 = coverage.lock_sha256; return coverage; } }));
      return "accepté";
    } catch (error) {
      return error.message;
    }
  });
  deepStrictEqual(messages[0], messages[1]);
});

// ---------------------------------------------------------------------------
console.log("--- 4. Orchestrateur réel (processus enfants, fixtures) ---");

const createdProductions = [];

function runMvp(args, env = {}) {
  const before = fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [];
  const child = spawnSync(process.execPath, ["--import", GUARD, "src/orchestrator/mvp.js", ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8"
  });
  const created = (fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []).filter(name => !before.includes(name));
  createdProductions.push(...created);
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created,
    productionId: child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null,
    blocked: Number(child.stderr.match(/tentatives bloquées : (\d+)/)?.[1] ?? NaN)
  };
}

const FIXTURES = { NO_API: "1", ANTHROPIC_FIXTURES: "1" };
const firstRun = runMvp(["--research-script", "--stop-after=script"], FIXTURES);
const productionDir = firstRun.productionId ? path.join(PROJECTS, firstRun.productionId) : null;
const readScript = () => JSON.parse(fs.readFileSync(path.join(productionDir, "script.json"), "utf8"));

await test("orchestrateur — premier passage : script.json enregistre le verrou complet, scellé", () => {
  if (firstRun.status !== 0 || !productionDir) throw new Error(`exit ${firstRun.status}\n${firstRun.stdout.slice(-500)}\n${firstRun.stderr.slice(-500)}`);
  const coverage = readScript().claim_coverage_validation;
  deepStrictEqual([Object.keys(coverage.lock), coverage.lock_sha256 === lockSha256(coverage.lock), coverage.lock.baseline], [[...COVERAGE_LOCK_KEYS], true, "architecture-baseline-v1.0.3"]);
  const production = JSON.parse(fs.readFileSync(path.join(productionDir, "production.json"), "utf8"));
  deepStrictEqual(production.artifact_sha256["script.json"], sha256(fs.readFileSync(path.join(productionDir, "script.json"))));
  deepStrictEqual(firstRun.blocked, 0);
});

const snapshotProduction = () => snapshotOf(productionDir);

// Réécrit script.json et son scellé (production.json) comme si le Script avait
// été produit sous un autre verrou.
function resealScript(mutate) {
  const envelope = readScript();
  mutate(envelope.claim_coverage_validation);
  const serialized = JSON.stringify(envelope, null, 2) + "\n";
  fs.writeFileSync(path.join(productionDir, "script.json"), serialized);
  const production = JSON.parse(fs.readFileSync(path.join(productionDir, "production.json"), "utf8"));
  production.artifact_sha256["script.json"] = sha256(Buffer.from(serialized));
  fs.writeFileSync(path.join(productionDir, "production.json"), JSON.stringify(production, null, 2) + "\n");
}

const resumeArgs = () => ["--research-script", `--resume=${firstRun.productionId}`, "--stop-after=script"];

await test("orchestrateur — reprise nominale sous NO_API=1 sans fixtures : Script réutilisé, zéro appel", () => {
  const result = runMvp(resumeArgs(), { NO_API: "1" });
  if (result.status !== 0 || !/Script RÉUTILISÉ/.test(result.stdout)) throw new Error(`exit ${result.status}\n${result.stdout.slice(-500)}\n${result.stderr.slice(-500)}`);
  deepStrictEqual(result.blocked, 0);
});

const original = firstRun.productionId ? fs.readFileSync(path.join(productionDir, "script.json")) : null;
const originalProduction = firstRun.productionId ? fs.readFileSync(path.join(productionDir, "production.json")) : null;
const restore = () => {
  fs.writeFileSync(path.join(productionDir, "script.json"), original);
  fs.writeFileSync(path.join(productionDir, "production.json"), originalProduction);
};

for (const [name, mutate, pattern] of [
  ["verrou absent", coverage => { delete coverage.lock; }, /LOCK_MISSING/],
  ["verrou incomplet", coverage => { delete coverage.lock.coordinator; }, /LOCK_INVALID \(coordinator\)/],
  ["empreinte différente", coverage => { coverage.lock_sha256 = "b".repeat(64); }, /LOCK_SHA_MISMATCH/],
  ["baseline différente", coverage => { coverage.lock.baseline = "architecture-baseline-v1.0.2"; coverage.lock_sha256 = lockSha256(coverage.lock); coverage.segments.forEach(segment => { segment.lock_sha256 = coverage.lock_sha256; }); }, /LOCK_MISMATCH \(baseline\)/],
  ["réparation différente", coverage => { coverage.lock.repair = "coverage-repair.v0"; coverage.lock_sha256 = lockSha256(coverage.lock); coverage.segments.forEach(segment => { segment.lock_sha256 = coverage.lock_sha256; }); }, /LOCK_MISMATCH \(repair\)/],
  ["coordinateur différent", coverage => { coverage.lock.coordinator = "coverage-coordinator-policy.v0"; coverage.lock_sha256 = lockSha256(coverage.lock); coverage.segments.forEach(segment => { segment.lock_sha256 = coverage.lock_sha256; }); }, /LOCK_MISMATCH \(coordinator\)/]
]) {
  await test(`orchestrateur — reprise refusée (${name}) : sortie ≠ 0, message qualifié, aucun fichier modifié, aucun réseau`, () => {
    restore();
    resealScript(mutate);
    const before = snapshotProduction();
    const result = runMvp(resumeArgs(), { NO_API: "1" });
    if (result.status === 0 || result.status === null) throw new Error(`reprise acceptée\n${result.stdout.slice(-300)}`);
    if (!pattern.test(result.stderr)) throw new Error(`stderr : ${result.stderr.slice(0, 600)}`);
    if (!/Reprise refusée : verrou de couverture/.test(result.stderr)) throw new Error(result.stderr.slice(0, 400));
    deepStrictEqual([result.created.length, result.blocked], [0, 0]);
    const after = snapshotProduction();
    delete before[".lock"]; delete after[".lock"];
    deepStrictEqual(after, before);
    if (fs.existsSync(path.join(productionDir, ".lock"))) throw new Error("verrou de production laissé");
  });
}

await test("orchestrateur — le Script régénéré n'est pas bloqué par l'ancien verrou (action explicite)", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/orchestrator/mvp.js"), "utf8");
  const body = source.slice(source.indexOf("reuse = planReuse({ productionDir, production });"), source.indexOf("configureCallGuard({"));
  const planned = body.indexOf("regeneration = planRegeneration({ reuse, regenerate });");
  const guarded = body.indexOf("if (reuse.script) {");
  const asserted = body.indexOf("assertReusedScriptLock({");
  if (!(planned > 0 && planned < guarded && guarded < asserted)) throw new Error(`ordre inattendu ${[planned, guarded, asserted]}`);
});

await test("orchestrateur — contrôle avant la réconciliation des narrations et la configuration du garde d'appels", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/orchestrator/mvp.js"), "utf8");
  const asserted = source.indexOf("assertReusedScriptLock({");
  const reconcile = source.indexOf("reconcileNarrationJournal({ productionDir, candidates })");
  const configure = source.indexOf("configureCallGuard({\n      productionDir,\n      cap: realCallsCap");
  if (!(asserted > 0 && asserted < reconcile && reconcile < configure)) throw new Error(`ordre ${[asserted, reconcile, configure]}`);
});

for (const id of createdProductions) fs.rmSync(path.join(PROJECTS, id), { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log("--- 5. Mutations (copies hors dépôt) ---");

async function isolated(replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r28-11-mutant-"));
  tempDirs.push(root);
  let source = fs.readFileSync(path.join(ROOT, "src/utils/coverage-lock-persistence.js"), "utf8");
  source = source.replace('"./coverage-lock.js"', JSON.stringify(pathToFileURL(path.join(ROOT, "src/utils/coverage-lock.js")).href));
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from.slice(0, 60)}`);
    source = source.replace(from, to);
  }
  const file = path.join(root, "coverage-lock-persistence.js");
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

// Comportements surveillés : chaque écart du contrôle doit être détecté.
function behaviourFailures(module) {
  const failures = [];
  const expectCode = (label, result, code, category) => {
    if (result.status !== "REFUSED" || result.code !== code || (category !== undefined && result.category !== category)) failures.push(label);
  };
  const run = (coverage, current = CURRENT) => module.checkPersistedCoverageLock({ coverage, currentLock: current });
  if (run(COVERAGE).status !== "OK") failures.push("nominal");
  for (const key of COVERAGE_LOCK_KEYS) {
    expectCode(`élément ${key} ignoré`, run(coverageWith(key, "x")), "LOCK_MISMATCH", key);
    expectCode(`élément courant ${key} ignoré`, run(COVERAGE, { ...CURRENT, [key]: "x" }), "LOCK_MISMATCH", key);
  }
  expectCode("verrou absent accepté", run({ ...clone(COVERAGE), lock: undefined }), "LOCK_MISSING");
  const incomplete = clone(COVERAGE);
  delete incomplete.lock.repair;
  expectCode("verrou incomplet accepté", run(incomplete), "LOCK_INVALID");
  const superfluous = clone(COVERAGE);
  superfluous.lock.extra = "x";
  expectCode("élément superflu accepté", run(superfluous), "LOCK_INVALID");
  const tampered = clone(COVERAGE);
  tampered.lock_sha256 = "0".repeat(64);
  expectCode("empreinte ignorée", run(tampered), "LOCK_SHA_MISMATCH", "STORED_LOCK");
  const trap = { get lock() { throw new Error("piège"); } };
  try {
    expectCode("exception non contenue", run(trap), "LOCK_INVALID");
  } catch {
    failures.push("exception propagée");
  }
  try {
    expectCode("entrée nulle non contenue", module.checkPersistedCoverageLock(null), "LOCK_MISSING");
  } catch {
    failures.push("entrée nulle : exception");
  }
  const segment = clone(COVERAGE);
  segment.segments[0].lock_sha256 = "1".repeat(64);
  expectCode("empreinte de segment ignorée", run(segment), "LOCK_SHA_MISMATCH");
  expectCode("verrou courant incomplet accepté", run(COVERAGE, { ...CURRENT, baseline: "" }), "LOCK_INVALID");
  return failures;
}

const MUTATIONS = [
  ["comparaison des éléments supprimée", [{ from: "    const divergent = firstDifferingLockElement(stored, currentLock);", to: "    const divergent = undefined;" }]],
  ["baseline exclue de la comparaison", [{ from: "    const divergent = firstDifferingLockElement(stored, currentLock);", to: "    const divergent = firstDifferingLockElement({ ...stored, baseline: currentLock.baseline }, currentLock);" }]],
  ["repair exclu de la comparaison", [{ from: "    const divergent = firstDifferingLockElement(stored, currentLock);", to: "    const divergent = firstDifferingLockElement({ ...stored, repair: currentLock.repair }, currentLock);" }]],
  ["coordinator exclu de la comparaison", [{ from: "    const divergent = firstDifferingLockElement(stored, currentLock);", to: "    const divergent = firstDifferingLockElement({ ...stored, coordinator: currentLock.coordinator }, currentLock);" }]],
  ["verrou absent accepté", [{ from: "    if (!isObject(coverage) || coverage.lock === undefined || coverage.lock === null) {\n      return refused(LOCK_REFUSAL.LOCK_MISSING, \"LOCK\", \"aucun verrou de couverture enregistré dans script.json\");\n    }", to: "    if (!isObject(coverage)) return refused(LOCK_REFUSAL.LOCK_MISSING, \"LOCK\", \"x\");\n    if (coverage.lock === undefined || coverage.lock === null) return outcome(LOCK_CHECK_STATUS.OK);" }]],
  ["forme du verrou non contrôlée", [{ from: "    const storedIssue = shapeIssue(stored);", to: "    const storedIssue = null;" }]],
  ["empreinte enregistrée non vérifiée", [{ from: "    if (lockSha256(stored) !== coverage.lock_sha256) {", to: "    if (false) {" }]],
  ["empreintes de segments non vérifiées", [{ from: "    if (strayIndex !== -1) {", to: "    if (false) {" }]],
  ["verrou courant non vérifié", [{ from: "    if (currentIssue) return", to: "    if (false) return" }]],
  ["exception propagée", [{ from: "  } catch (error) {\n    return refused(LOCK_REFUSAL.LOCK_INVALID, \"UNEXPECTED\"", to: "  } catch (error) {\n    throw error;\n    return refused(LOCK_REFUSAL.LOCK_INVALID, \"UNEXPECTED\"" }]]
];

await test("mutations : témoin (copie non mutée, hors dépôt) sans aucun écart", async () => {
  deepStrictEqual(behaviourFailures(await isolated()), []);
});

for (const [name, replacements] of MUTATIONS) {
  await test(`mutation détectée : ${name}`, async () => {
    const module = await isolated(replacements);
    let failures;
    try {
      failures = behaviourFailures(module);
    } catch (error) {
      failures = [`exception : ${error.message}`];
    }
    if (failures.length === 0) throw new Error("mutant non détecté");
    console.log(`       témoin : ${failures.slice(0, 4).join(", ")}${failures.length > 4 ? ", …" : ""}`);
  });
}

await test("aucune tentative réseau réelle dans ce processus", () => deepStrictEqual(networkGuard.attempts().length, 0));

for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-lock-persistence-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
