// Smoke de la reprise de production (R13) — zéro API, zéro réseau.
//
// Usage :
//   NO_API=1 node scripts/resume-smoke.js
//
// Lance l'orchestrateur réel dans des processus enfants, sous garde
// réseau, avec les fixtures Anthropic locales ; les preuves de « zéro
// appel modèle » utilisent NO_API=1 SANS fixtures : le moindre appel
// modèle ferait échouer la reprise.
//
// Les médias de test sont fabriqués dans tmp/r9-media-* et supprimés en
// fin de smoke, MP4 compris (jamais d'écriture dans output/).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import os from "node:os";
import {
  applyResume,
  archiveRegeneratedArtifacts,
  planRegeneration,
  planReuse,
  rollbackRegenerationCache,
  sealAndWriteArtifact
} from "../src/orchestrator/resume.js";
import {
  createMediaFixtureRoot,
  generateCanonicalMediaSet,
  generateRenderableMediaSet,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";

if (process.env.NO_API !== "1") {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1.");
  process.exit(1);
}

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PROJECTS = path.join(ROOT, "projects");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");

const FINAL_STATUS =
  "research_script_visual_asset_voice_assembly_quality_pass";

const AGENTS = [
  "research",
  "script",
  "visual_director",
  "asset",
  "voice",
  "assembly",
  "quality"
];

const ACK = { PIPELINE_REAL_CALLS_ACK: "1" };

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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

function listDirectory(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).sort()
    : [];
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

// Empreinte de chaque fichier d'une production (non récursif).
function snapshot(productionId) {
  const directory = path.join(PROJECTS, productionId);
  const result = {};

  for (const name of listDirectory(directory)) {
    const file = path.join(directory, name);

    if (fs.statSync(file).isFile()) {
      result[name] = sha256(file);
    }
  }

  return result;
}

function readProduction(productionId) {
  return JSON.parse(
    fs.readFileSync(
      path.join(PROJECTS, productionId, "production.json"),
      "utf8"
    )
  );
}

function writeProduction(productionId, production) {
  fs.writeFileSync(
    path.join(PROJECTS, productionId, "production.json"),
    JSON.stringify(production, null, 2) + "\n"
  );
}

function readEnvelope(productionId, name) {
  return JSON.parse(
    fs.readFileSync(
      path.join(PROJECTS, productionId, `${name}.json`),
      "utf8"
    )
  );
}

const createdProductions = [];
const blockedByRun = [];

function run(args, env = {}) {
  const before = listDirectory(PROJECTS);

  const child = spawnSync(
    process.execPath,
    ["--import", GUARD, "src/orchestrator/mvp.js", ...args],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8"
    }
  );

  const created = listDirectory(PROJECTS).filter(
    name => !before.includes(name)
  );

  createdProductions.push(...created);

  const guardLine = child.stderr.match(
    /\[fixture-network-guard\] actif — tentatives bloquées : (\d+)/
  );

  blockedByRun.push(guardLine ? Number(guardLine[1]) : null);

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created,
    productionId:
      child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null,
    blocked: guardLine ? Number(guardLine[1]) : null
  };
}

const FIXTURES = { NO_API: "1", ANTHROPIC_FIXTURES: "1" };

function fixtures(scenario) {
  return scenario === undefined
    ? { ...FIXTURES }
    : { ...FIXTURES, ANTHROPIC_FIXTURE_SCENARIO: scenario };
}

// Refus attendu : code ≠ 0, message, rien de créé, production intacte,
// aucun verrou laissé, aucun réseau.
function expectRefusal(result, pattern, productionId) {
  assert(
    result.status !== 0 && result.status !== null,
    `exit ${result.status}\n${result.stdout}`
  );
  assert(
    pattern.test(result.stderr),
    `stderr : ${result.stderr.slice(0, 500)}`
  );
  assert(result.created.length === 0, `production créée : ${result.created}`);
  assert(result.blocked === 0, `tentatives réseau : ${result.blocked}`);

  if (productionId) {
    assert(
      !listDirectory(path.join(PROJECTS, productionId)).includes(".lock"),
      "verrou laissé par un refus"
    );
  }
}

const outputBefore = listDirectory(path.join(ROOT, "output"));

const fixtureRoot = createMediaFixtureRoot();
const renderableMedia = path.join(fixtureRoot, "medias rendables");
const shortMedia = path.join(fixtureRoot, "medias trop courts");

let outputCounter = 0;

function outputDirectory() {
  outputCounter += 1;

  return path.join(fixtureRoot, `sortie ${outputCounter}`);
}

function renderArgs(mediaDir, outputDir) {
  return [
    `--media-dir=${mediaDir}`,
    "--render",
    "--render-profile=preview",
    `--output-dir=${outputDir}`
  ];
}

console.log("========================================");
console.log(" REPRISE DE PRODUCTION — SMOKE (ZERO API)");
console.log("========================================");

try {
  generateRenderableMediaSet(renderableMedia);
  generateCanonicalMediaSet(shortMedia);

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 1. Chemin nominal inchangé ---");

  const nominal = run(["--research-script"], fixtures());

  await test("sans option R13 : PASS, mêmes fichiers, aucune trace de reprise", () => {
    assert(nominal.status === 0, `exit ${nominal.status}\n${nominal.stderr}`);

    const production = readProduction(nominal.productionId);

    assert(production.status === FINAL_STATUS, production.status);
    assert(production.mode === "test", `mode ${production.mode}`);
    assert(!("resume_history" in production), "resume_history inattendu");
    assert(
      production.agents.every(a => a.status === "completed" && !("resumed" in a)),
      "états d'agents"
    );
    assert(
      JSON.stringify(listDirectory(path.join(PROJECTS, nominal.productionId))) ===
        JSON.stringify([
          "assembly.json", "assets.json", "production.json",
          "quality.json", "research.json", "script.json",
          "truth-report.md", "truth.json", "visual.json", "voice.json"
        ]),
      "fichiers inattendus"
    );
    assert(
      !/Reprise|Appels réels|Pause/.test(nominal.stdout),
      "bannière modifiée hors options R13"
    );
    assert(nominal.blocked === 0, "réseau");
  });

  await test("scellés SHA-256 des agents 1-3 = empreintes réelles des fichiers", () => {
    const production = readProduction(nominal.productionId);
    const seals = production.artifact_sha256;

    assert(
      JSON.stringify(Object.keys(seals).sort()) ===
        JSON.stringify(["research.json", "script.json", "truth.json", "visual.json"]),
      `scellés : ${Object.keys(seals)}`
    );

    for (const [file, seal] of Object.entries(seals)) {
      assert(
        seal === sha256(path.join(PROJECTS, nominal.productionId, file)),
        `${file} : scellé différent`
      );
    }
  });

  await test("une production terminée n'est pas reprenable", () => {
    const before = snapshot(nominal.productionId);
    const result = run(
      ["--research-script", `--resume=${nominal.productionId}`],
      fixtures()
    );

    expectRefusal(result, /statut "research_script_visual_asset_voice_assembly_quality_pass" non reprenable/, nominal.productionId);
    assert(
      JSON.stringify(snapshot(nominal.productionId)) === JSON.stringify(before),
      "production modifiée par un refus"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 2. Pause (--stop-after) puis reprise sans aucun appel modèle ---");

  const paused = run(
    ["--research-script", "--stop-after=voice"],
    fixtures()
  );

  const pausedBefore = paused.productionId ? snapshot(paused.productionId) : {};
  const pausedProduction = paused.productionId
    ? readProduction(paused.productionId)
    : null;

  await test("--stop-after=voice : statut paused, agents 1-5 terminés, 6-7 en attente", () => {
    assert(paused.status === 0, `exit ${paused.status}\n${paused.stderr}`);
    assert(pausedProduction.status === "paused", pausedProduction.status);
    assert(pausedProduction.paused_after === "voice", pausedProduction.paused_after);
    assert(typeof pausedProduction.paused_at === "string", "paused_at");
    assert(!("completed_at" in pausedProduction), "completed_at sur une pause");

    for (const id of AGENTS.slice(0, 5)) {
      assert(
        pausedProduction.agents.find(a => a.id === id).status === "completed",
        `agent ${id}`
      );
    }

    for (const id of AGENTS.slice(5)) {
      assert(
        pausedProduction.agents.find(a => a.id === id).status === "pending",
        `agent ${id}`
      );
    }

    assert(
      JSON.stringify(Object.keys(pausedBefore).sort()) ===
        JSON.stringify([
          "assets.json", "production.json", "research.json",
          "script.json", "truth-report.md", "truth.json", "visual.json", "voice.json"
        ]),
      `fichiers : ${Object.keys(pausedBefore)}`
    );
    assert(/RESULTAT : PAUSE — après voice/.test(paused.stdout), "bannière");
    assert(!("resume_history" in pausedProduction), "resume_history");
  });

  await test("la pause affiche les besoins de médias sur stdout, sans nouvel artefact", () => {
    assert(/Assets à déposer \(\d+\)/.test(paused.stdout), "assets");
    assert(/assets\/s01-g01-sh01\.<ext>/.test(paused.stdout), "asset_id");
    assert(/Narrations à déposer \(\d+\)/.test(paused.stdout), "narrations");
    assert(/voice\/s01-g01\.<ext>/.test(paused.stdout), "unit_id");
    assert(
      new RegExp(`--resume=${paused.productionId}`).test(paused.stdout),
      "commande de reprise"
    );
    assert(
      !listDirectory(path.join(PROJECTS, paused.productionId)).includes(".lock"),
      "verrou laissé par la pause"
    );
  });

  const resumedOutput = outputDirectory();

  const resumed = run(
    [
      "--research-script",
      `--resume=${paused.productionId}`,
      ...renderArgs(renderableMedia, resumedOutput)
    ],
    { NO_API: "1" }
  );

  await test("reprise sous NO_API=1 SANS fixtures : terminée, zéro appel modèle", () => {
    assert(resumed.status === 0, `exit ${resumed.status}\n${resumed.stdout}\n${resumed.stderr}`);
    assert(resumed.blocked === 0, `réseau : ${resumed.blocked}`);

    const production = readProduction(paused.productionId);

    assert(production.status === FINAL_STATUS, production.status);
    assert(
      production.agents.every(a => a.status === "completed"),
      "agents non terminés"
    );
    assert(
      /RÉUTILISÉ/.test(resumed.stdout) &&
      /Research RÉUTILISÉ/.test(resumed.stdout) &&
      /Script RÉUTILISÉ/.test(resumed.stdout) &&
      /Visual Director RÉUTILISÉ/.test(resumed.stdout),
      "agents 1-3 non signalés réutilisés"
    );
  });

  await test("agents 1-3 : artefacts et horodatages strictement inchangés", () => {
    const after = snapshot(paused.productionId);
    const production = readProduction(paused.productionId);

    for (const file of ["research.json", "script.json", "visual.json"]) {
      assert(after[file] === pausedBefore[file], `${file} modifié`);
    }

    for (const id of ["research", "script", "visual_director"]) {
      const before = pausedProduction.agents.find(a => a.id === id);
      const now = production.agents.find(a => a.id === id);

      assert(now.resumed === true, `${id} : resumed`);
      assert(now.started_at === before.started_at, `${id} : started_at`);
      assert(now.completed_at === before.completed_at, `${id} : completed_at`);
    }

    for (const id of AGENTS.slice(3)) {
      assert(
        !("resumed" in production.agents.find(a => a.id === id)),
        `${id} : ne doit pas être marqué réutilisé`
      );
    }
  });

  await test("resume_history : agents réutilisés/recalculés, média, statut précédent", () => {
    const production = readProduction(paused.productionId);

    assert(production.resume_history.length === 1, "une entrée attendue");

    const entry = production.resume_history[0];

    assert(entry.previous_status === "paused", entry.previous_status);
    assert(
      JSON.stringify(entry.reused) ===
        JSON.stringify(["research", "script", "visual_director"]),
      `reused ${entry.reused}`
    );
    assert(
      JSON.stringify(entry.recomputed) ===
        JSON.stringify(["asset", "voice", "assembly", "quality"]),
      `recomputed ${entry.recomputed}`
    );
    assert(entry.media_dir === renderableMedia, "media_dir");
    assert(entry.previous_media_dir === null, "previous_media_dir");
    assert(production.input.media_dir === renderableMedia, "input.media_dir");
    assert(!("paused_after" in production), "paused_after résiduel");
    assert(typeof production.completed_at === "string", "completed_at");
  });

  await test("phase 2 : médias résolus, vrai MP4 rendu, aucun verrou, aucun artefact parasite", () => {
    const directory = path.join(PROJECTS, paused.productionId);

    assert(
      JSON.stringify(listDirectory(directory)) ===
        JSON.stringify([
          "assembly.json", "assets.json", "production.json",
          "quality.json", "render.json", "research.json",
          "script.json", "truth-report.md", "truth.json", "visual.json", "voice.json"
        ]),
      `fichiers : ${listDirectory(directory)}`
    );

    const assets = readEnvelope(paused.productionId, "assets");

    assert(
      assets.data.assets.every(a => a.status === "resolved_local"),
      "assets non résolus"
    );
    assert(
      fs.existsSync(path.join(resumedOutput, `${paused.productionId}.mp4`)) &&
      fs.statSync(path.join(resumedOutput, `${paused.productionId}.mp4`)).size > 0,
      "MP4 absent"
    );
    assert(
      readProduction(paused.productionId).render.status === "completed",
      "rendu non terminé"
    );
    assert(
      !fs.existsSync(path.join(ROOT, "tmp", `render-${paused.productionId}`)),
      "dossier de travail du rendu resté dans tmp/"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 3. Reprise après un échec d'agent ---");

  const failedRun = run(
    ["--research-script"],
    fixtures("script-coverage-unrepairable")
  );

  const failedBefore = failedRun.productionId
    ? snapshot(failedRun.productionId)
    : {};

  await test("échec du Script : Research terminé et scellé, Script en échec, sans artefact", () => {
    assert(failedRun.status === 1, `exit ${failedRun.status}`);

    const production = readProduction(failedRun.productionId);

    assert(production.status === "failed", production.status);
    assert(production.agents.find(a => a.id === "research").status === "completed", "research");
    assert(production.agents.find(a => a.id === "script").status === "failed", "script");
    assert(!("script.json" in failedBefore), "script.json écrit pour un échec");
    assert(
      Object.keys(production.artifact_sha256).join() === "research.json,truth.json",
      `scellés : ${Object.keys(production.artifact_sha256)}`
    );
  });

  const afterFailure = run(
    ["--research-script", `--resume=${failedRun.productionId}`],
    fixtures()
  );

  await test("reprise : Research réutilisé, Script relancé, production terminée", () => {
    assert(afterFailure.status === 0, `exit ${afterFailure.status}\n${afterFailure.stderr}`);

    const production = readProduction(failedRun.productionId);
    const after = snapshot(failedRun.productionId);

    assert(production.status === FINAL_STATUS, production.status);
    assert(after["research.json"] === failedBefore["research.json"], "research.json modifié");
    assert(production.agents.find(a => a.id === "research").resumed === true, "research non réutilisé");
    assert(!("resumed" in production.agents.find(a => a.id === "script")), "script marqué réutilisé");

    const entry = production.resume_history[0];

    assert(entry.previous_status === "failed", entry.previous_status);
    assert(entry.reused.join() === "research", `reused ${entry.reused}`);
    assert(entry.previous_errors.length === 1 && entry.previous_errors[0].agent === "script", "erreur précédente non tracée");
    assert(production.agents.find(a => a.id === "script").error === null, "erreur résiduelle");
    assert(readEnvelope(failedRun.productionId, "script").usage.model === "fixture:script", "modèle du script");
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 4. Refus de reprise (fail-closed) ---");

  const base = run(["--research-script", "--stop-after=script"], fixtures());

  await test("--stop-after=script : pause après le Script", () => {
    assert(base.status === 0, `exit ${base.status}`);
    assert(readProduction(base.productionId).paused_after === "script", "paused_after");
  });

  const truthPause = run(["--research-script", "--stop-after=truth"], fixtures());

  await test("--stop-after=truth : pause après le Truth Report, Script non lancé, rapport indiqué", () => {
    assert(truthPause.status === 0, `exit ${truthPause.status}\n${truthPause.stderr}`);
    const production = readProduction(truthPause.productionId);
    assert(production.status === "paused" && production.paused_after === "truth", `${production.status} ${production.paused_after}`);
    assert(production.truth?.status === "completed", JSON.stringify(production.truth));
    assert(production.agents.find(a => a.id === "script").status === "pending", "script lancé");
    assert(
      JSON.stringify(listDirectory(path.join(PROJECTS, truthPause.productionId))) ===
        JSON.stringify(["production.json", "research.json", "truth-report.md", "truth.json"]),
      listDirectory(path.join(PROJECTS, truthPause.productionId)).join()
    );
    assert(truthPause.stdout.includes("truth-report.md"), "rapport non indiqué");
  });

  await test("reprise après --stop-after=truth : Research réutilisé, Truth recalculé à l'identique, production terminée", () => {
    const truthFile = path.join(PROJECTS, truthPause.productionId, "truth.json");
    const before = sha256(truthFile);
    const resumed = run(["--research-script", `--resume=${truthPause.productionId}`], fixtures());
    assert(resumed.status === 0, `exit ${resumed.status}\n${resumed.stderr}`);
    assert(/Research RÉUTILISÉ/.test(resumed.stdout), "Research non réutilisé");
    assert(sha256(truthFile) === before, "truth.json non déterministe");
    const production = readProduction(truthPause.productionId);
    assert(production.status === FINAL_STATUS, production.status);
    assert(production.artifact_sha256["truth.json"] === before, "scellé truth.json");
  });

  // Hiérarchie des sources (R20.4, phase B) : bloquante pour les nouvelles
  // productions, rapport seulement pour les productions historiques.
  await test("nouvelle production : marquée source_hierarchy_enforcement = block", () => {
    assert(readProduction(truthPause.productionId).source_hierarchy_enforcement === "block", "repère absent");
  });

  // Remplace le dossier Research d'une production en pause après Research
  // par un dossier contrôlé, avec un scellé valide (même sérialisation).
  function sealResearch(productionId, keyFacts, { historical = false } = {}) {
    const envelope = readEnvelope(productionId, "research");
    envelope.data = { ...envelope.data, key_facts: keyFacts };
    const content = JSON.stringify(envelope, null, 2) + "\n";
    fs.writeFileSync(path.join(PROJECTS, productionId, "research.json"), content);
    const production = readProduction(productionId);
    production.artifact_sha256["research.json"] = crypto.createHash("sha256").update(content).digest("hex");
    if (historical) delete production.source_hierarchy_enforcement;
    writeProduction(productionId, production);
  }

  const hierarchySource = (n, url) => ({ title: `Source ${n}`, url, publisher: `Éditeur ${n}`, source_type: "secondary", supports_claim: `Confirme ${n}` });
  const unknownFact = { claim: "Fait HIGH appuyé par un domaine non reconnu", importance: "high", verification_status: "verified", sources: [hierarchySource(1, "https://domaine-inconnu-smoke.example/page")] };
  const wikipediaFact = { claim: "Fait HIGH appuyé seulement par Wikipédia", importance: "high", verification_status: "verified", sources: [hierarchySource(2, "https://fr.wikipedia.org/wiki/Smoke")] };

  const reviewRun = run(["--research-script", "--stop-after=research"], fixtures());
  sealResearch(reviewRun.productionId, [unknownFact]);
  const reviewPause = run(["--research-script", `--resume=${reviewRun.productionId}`], fixtures());

  await test("nouvelle production, domaine inconnu sur un fait HIGH : pause « revue requise », ni rejet ni échec, Script non lancé", () => {
    assert(reviewPause.status === 0, `exit ${reviewPause.status}\n${reviewPause.stderr}`);
    assert(/REVUE REQUISE/.test(reviewPause.stdout) && reviewPause.stdout.includes("domaine-inconnu-smoke.example"), reviewPause.stdout.slice(-800));
    const production = readProduction(reviewRun.productionId);
    assert(production.status === "paused" && production.paused_after === "truth", `${production.status} ${production.paused_after}`);
    assert(production.truth.status === "review_required" && production.truth.review[0].domains.join() === "domaine-inconnu-smoke.example", JSON.stringify(production.truth));
    assert(production.agents.find(a => a.id === "script").status === "pending", "script lancé");
    const truth = readEnvelope(reviewRun.productionId, "truth").data;
    assert(truth.stop.stopped && truth.stop.kind === "review_required", JSON.stringify(truth.stop));
    const md = fs.readFileSync(path.join(PROJECTS, reviewRun.productionId, "truth-report.md"), "utf8");
    assert(md.includes("**Unknown — review required** : domaine-inconnu-smoke.example") && md.includes("Action :"), "rapport");
    assert(reviewPause.blocked === 0, "réseau");
  });

  await test("reprise d'une revue sans décision : Truth Report recalculé sans appel, toujours en pause", () => {
    const again = run(["--research-script", `--resume=${reviewRun.productionId}`], fixtures());
    assert(again.status === 0 && /Research RÉUTILISÉ/.test(again.stdout) && /REVUE REQUISE/.test(again.stdout), `exit ${again.status}\n${again.stderr}`);
    assert(readProduction(reviewRun.productionId).truth.status === "review_required", "statut");
    assert(again.blocked === 0, "réseau");
  });

  const historicalRun = run(["--research-script", "--stop-after=research"], fixtures());
  sealResearch(historicalRun.productionId, [unknownFact, wikipediaFact], { historical: true });
  const historicalTruth = run(["--research-script", `--resume=${historicalRun.productionId}`, "--stop-after=truth"], fixtures());

  await test("production historique (sans repère) : écarts seulement signalés, aucune pause ni échec", () => {
    assert(historicalTruth.status === 0, `exit ${historicalTruth.status}\n${historicalTruth.stderr}`);
    assert(!/REVUE REQUISE/.test(historicalTruth.stdout), "pause de revue sur une production historique");
    const production = readProduction(historicalRun.productionId);
    assert(production.truth.status === "completed" && production.paused_after === "truth", JSON.stringify(production.truth));
    const truth = readEnvelope(historicalRun.productionId, "truth").data;
    assert(truth.source_hierarchy.enforcement === "report" && truth.source_hierarchy.status === "non_compliant" && truth.stop.stopped === false, JSON.stringify(truth.source_hierarchy.status));
  });

  const rejectRun = run(["--research-script", "--stop-after=research"], fixtures());
  sealResearch(rejectRun.productionId, [wikipediaFact]);
  const rejected = run(["--research-script", `--resume=${rejectRun.productionId}`], fixtures());

  await test("nouvelle production, fait HIGH sans source de rang ≤ 2 ni domaine inconnu : échec au Truth Report, Script non lancé", () => {
    assert(rejected.status === 1, `exit ${rejected.status}`);
    assert(/hiérarchie des sources non respectée/.test(rejected.stderr), rejected.stderr.slice(-600));
    const production = readProduction(rejectRun.productionId);
    assert(production.status === "failed" && production.truth.status === "failed", `${production.status} ${production.truth.status}`);
    assert(production.agents.find(a => a.id === "script").status === "pending", "script lancé");
    assert(fs.existsSync(path.join(PROJECTS, rejectRun.productionId, "truth-report.md")), "rapport absent");
    assert(rejected.blocked === 0, "réseau");
  });

  // Validation du titre (R20.4, phase A). Le titre canonique des fixtures
  // (« 95 % ») n'est soutenu par aucun fait validé du dossier minimal.
  await test("nouvelle production de test : juge du titre appelé (fixture), verdict signalé sans pause (mode report)", () => {
    const production = readProduction(truthPause.productionId);
    assert(production.title_validation_enforcement === "report", `repère ${production.title_validation_enforcement}`);
    const truth = readEnvelope(truthPause.productionId, "truth").data;
    assert(truth.title.judged === true && truth.title.verdict === "not_demonstrated" && truth.stop.stopped === false, JSON.stringify(truth.title.verdict));
    assert(truth.title.reasons.some(reason => reason.includes("Chiffre « 95 % » absent des faits validés")), truth.title.reasons.join(" | "));
  });

  const titleRun = run(["--research-script", "--stop-after=research"], fixtures());
  {
    const production = readProduction(titleRun.productionId);
    production.title_validation_enforcement = "block";
    writeProduction(titleRun.productionId, production);
  }
  const titlePause = run(["--research-script", `--resume=${titleRun.productionId}`], fixtures());

  await test("titre non démontré en mode block : pause « titre à revoir », ni rejet ni échec, Script non lancé", () => {
    assert(titlePause.status === 0, `exit ${titlePause.status}\n${titlePause.stderr}`);
    assert(/TITRE À REVOIR/.test(titlePause.stdout) && /Chiffre « 95 % » absent des faits validés/.test(titlePause.stdout) && /Action possible/.test(titlePause.stdout), titlePause.stdout.slice(-900));
    const production = readProduction(titleRun.productionId);
    assert(production.status === "paused" && production.paused_after === "truth" && production.truth.status === "title_review", `${production.status} ${production.truth.status}`);
    assert(production.truth.title_review.verdict === "not_demonstrated" && production.truth.title_review.actions.length === 3, JSON.stringify(production.truth.title_review));
    assert(production.agents.find(a => a.id === "script").status === "pending", "script lancé");
    const md = fs.readFileSync(path.join(PROJECTS, titleRun.productionId, "truth-report.md"), "utf8");
    assert(md.includes("Pause — titre à revoir") && md.includes("Actions possibles :") && md.includes("Justifications :"), "rapport");
    assert(titlePause.blocked === 0, "réseau");
  });

  await test("reprise d'un titre à revoir sans changement : Truth Report recalculé, même pause, aucun réseau", () => {
    const again = run(["--research-script", `--resume=${titleRun.productionId}`], fixtures());
    assert(again.status === 0 && /Research RÉUTILISÉ/.test(again.stdout) && /TITRE À REVOIR/.test(again.stdout), `exit ${again.status}\n${again.stderr}`);
    assert(/juge du titre RÉUTILISÉ — mêmes entrées, aucun appel/.test(again.stdout), "juge rappelé au lieu d'être réutilisé");
    assert(readProduction(titleRun.productionId).truth.status === "title_review", "statut");
    assert(again.blocked === 0, "réseau");
  });

  const historicalTitleRun = run(["--research-script", "--stop-after=research"], fixtures());
  {
    const production = readProduction(historicalTitleRun.productionId);
    delete production.title_validation_enforcement;
    writeProduction(historicalTitleRun.productionId, production);
  }
  const historicalTitle = run(["--research-script", `--resume=${historicalTitleRun.productionId}`], fixtures());

  await test("production historique (sans repère titre) : aucun juge appelé, verdict des chiffres signalé, production terminée", () => {
    assert(historicalTitle.status === 0, `exit ${historicalTitle.status}\n${historicalTitle.stderr}`);
    assert(!/juge du titre/.test(historicalTitle.stdout) && !/TITRE À REVOIR/.test(historicalTitle.stdout), "juge appelé ou pause");
    const production = readProduction(historicalTitleRun.productionId);
    assert(production.status === FINAL_STATUS && !("title_judge" in production.truth), production.status);
    const truth = readEnvelope(historicalTitleRun.productionId, "truth").data;
    assert(truth.title.judged === false && truth.title.judge_skipped_reason === "production historique, aucun appel" && truth.title.verdict === "not_demonstrated", JSON.stringify(truth.title.judge_skipped_reason));
  });

  // Fact ↔ Evidence (R20.4, phase E). Les pages sont servies par un jeu
  // local (EVIDENCE_FIXTURE_DIR, actif seulement sous NO_API=1) : aucune
  // sortie réseau. Les sources sont de rang ≤ 2 pour que la hiérarchie des
  // sources (phase B) ne mette pas la production en pause avant les preuves.
  const evidencePages = fs.mkdtempSync(path.join(os.tmpdir(), "resume-smoke-evidence-"));
  const evidenceFiller = "Texte documentaire de remplissage sans chiffre particulier. ".repeat(6);
  const evidencePage = (url, page) => fs.writeFileSync(path.join(evidencePages, `${crypto.createHash("sha256").update(url).digest("hex")}.json`), JSON.stringify(page));
  evidencePage("https://www.larousse.fr/smoke-e", { status: 200, content_type: "text/html", body: `<html><body><p>Environ 90 % de la population vit sur les bandes littorales. ${evidenceFiller}</p></body></html>` });
  evidencePage("https://www.bom.gov.au/smoke-e", { status: 200, content_type: "text/html", body: `<html><body><p>Plus de 80 % du territoire reçoit moins de 600 mm de pluie par an. ${evidenceFiller}</p></body></html>` });
  evidencePage("https://www.abs.gov.au/smoke-e-403", { status: 403, content_type: "text/html", body: "Forbidden" });
  const withPages = () => ({ ...fixtures(), EVIDENCE_FIXTURE_DIR: evidencePages });
  const evidenceFact = (claim, url) => ({ claim, importance: "high", verification_status: "verified", sources: [hierarchySource(9, url)] });

  function evidenceRun(keyFacts, { historical = false } = {}) {
    const created = run(["--research-script", "--stop-after=research"], fixtures());
    sealResearch(created.productionId, keyFacts);
    const production = readProduction(created.productionId);
    if (historical) delete production.fact_evidence_enforcement; else production.fact_evidence_enforcement = "block";
    writeProduction(created.productionId, production);
    return created.productionId;
  }

  await test("nouvelle production de test : preuves en mode report (repère fact_evidence_enforcement)", () => {
    assert(readProduction(truthPause.productionId).fact_evidence_enforcement === "report", "repère");
    assert(!fs.existsSync(path.join(PROJECTS, truthPause.productionId, "evidence.json")), "evidence.json écrit sans URL à lire");
  });

  const rejectedEvidenceId = evidenceRun([evidenceFact("Environ 90 % de la population vit sur les côtes, dont 70 % à moins de 50 km", "https://www.larousse.fr/smoke-e")]);
  const rejectedEvidence = run(["--research-script", `--resume=${rejectedEvidenceId}`], withPages());

  await test("fait HIGH non soutenu par sa preuve (block) : rejected, pause « preuve à revoir », Script non lancé", () => {
    assert(rejectedEvidence.status === 0, `exit ${rejectedEvidence.status}\n${rejectedEvidence.stderr}`);
    assert(/PREUVE À REVOIR/.test(rejectedEvidence.stdout) && /Chiffre « 70 % » absent/.test(rejectedEvidence.stdout), rejectedEvidence.stdout.slice(-900));
    const production = readProduction(rejectedEvidenceId);
    assert(production.status === "paused" && production.truth.status === "evidence_review" && production.truth.evidence_review.rejected_facts.join() === "0", JSON.stringify(production.truth.evidence_review));
    assert(production.agents.find(a => a.id === "script").status === "pending", "script lancé");
    const truth = readEnvelope(rejectedEvidenceId, "truth").data;
    assert(truth.facts[0].truth_status === "rejected" && truth.rejected_count === 1 && truth.facts[0].evidence.editorial_status === "rejected" && truth.facts[0].evidence.technical_status === "all_read", JSON.stringify(truth.facts[0].evidence));
    const evidence = readEnvelope(rejectedEvidenceId, "evidence");
    const record = evidence.sources[0];
    assert(record.final_url === "https://www.larousse.fr/smoke-e" && record.http_status === 200 && record.content_type === "text/html" && /Z$/.test(record.fetched_at) && record.text_length > 0, JSON.stringify(record));
    assert(production.artifact_sha256["evidence.json"] && fs.existsSync(path.join(PROJECTS, rejectedEvidenceId, "evidence", `${record.text_sha256}.txt`)), "preuve enregistrée et scellée");
    assert(rejectedEvidence.blocked === 0, "réseau");
  });

  await test("reprise sans jeu de pages : preuves relues sur le disque, aucun accès réseau, même pause", () => {
    const again = run(["--research-script", `--resume=${rejectedEvidenceId}`], fixtures());
    assert(again.status === 0 && /preuves RÉUTILISÉES/.test(again.stdout) && /PREUVE À REVOIR/.test(again.stdout), `exit ${again.status}\n${again.stdout.slice(-600)}\n${again.stderr}`);
    assert(again.blocked === 0, "réseau");
  });

  await test("preuve enregistrée modifiée : reprise refusée (fail-closed), production reprenable", () => {
    const record = readEnvelope(rejectedEvidenceId, "evidence").sources[0];
    const file = path.join(PROJECTS, rejectedEvidenceId, "evidence", `${record.text_sha256}.txt`);
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `${original} altéré`);
    const tampered = run(["--research-script", `--resume=${rejectedEvidenceId}`], fixtures());
    fs.writeFileSync(file, original);
    assert(tampered.status === 1 && /texte enregistré modifié/.test(tampered.stderr), `exit ${tampered.status}\n${tampered.stderr.slice(-400)}`);
    assert(readProduction(rejectedEvidenceId).truth.status === "failed", "statut");
  });

  const unreadableId = evidenceRun([evidenceFact("La population dépasse 27 millions d'habitants", "https://www.abs.gov.au/smoke-e-403")]);
  const unreadable = run(["--research-script", `--resume=${unreadableId}`], withPages());

  await test("preuve illisible d'un fait HIGH (HTTP 403) : pause « revue requise », statuts technique et éditorial distincts", () => {
    assert(unreadable.status === 0 && /REVUE REQUISE \(preuve illisible/.test(unreadable.stdout), `exit ${unreadable.status}\n${unreadable.stdout.slice(-600)}`);
    const fact = readEnvelope(unreadableId, "truth").data.facts[0];
    assert(fact.evidence.editorial_status === "unverifiable" && fact.evidence.technical_status === "unreadable" && fact.evidence.sources[0].technical_status === "http_error" && fact.truth_status === "retained", JSON.stringify(fact.evidence));
    assert(readProduction(unreadableId).truth.status === "evidence_unverifiable", "statut");
  });

  const supportedId = evidenceRun([evidenceFact("Plus de 80 % du territoire reçoit moins de 600 mm de pluie par an", "https://www.bom.gov.au/smoke-e")]);
  const supported = run(["--research-script", `--resume=${supportedId}`, "--stop-after=truth"], withPages());

  await test("fait soutenu : juge des preuves appelé (fixture), citation retrouvée dans la preuve, aucune pause de preuve", () => {
    assert(supported.status === 0 && /juge des preuves \(1 fait, 1 appel\)/.test(supported.stdout) && !/PREUVE À REVOIR/.test(supported.stdout), `exit ${supported.status}\n${supported.stdout.slice(-600)}\n${supported.stderr}`);
    const fact = readEnvelope(supportedId, "truth").data.facts[0];
    assert(fact.evidence.editorial_status === "supported" && fact.evidence.quote?.source === "https://www.bom.gov.au/smoke-e" && fact.truth_status === "retained", JSON.stringify(fact.evidence));
    const again = run(["--research-script", `--resume=${supportedId}`, "--stop-after=truth"], fixtures());
    assert(again.status === 0 && /preuves RÉUTILISÉES/.test(again.stdout) && /juge des preuves RÉUTILISÉ/.test(again.stdout), again.stdout.slice(-600));
  });

  const historicalEvidenceId = evidenceRun([evidenceFact("Environ 90 % de la population vit sur les côtes, dont 70 % à moins de 50 km", "https://www.larousse.fr/smoke-e")], { historical: true });
  const historicalEvidence = run(["--research-script", `--resume=${historicalEvidenceId}`, "--stop-after=truth"], withPages());

  await test("production historique (sans repère) : aucune lecture, aucun juge, aucun rejet ni pause de preuve", () => {
    assert(historicalEvidence.status === 0 && !/preuves lues/.test(historicalEvidence.stdout) && !/PREUVE À REVOIR/.test(historicalEvidence.stdout), historicalEvidence.stdout.slice(-600));
    assert(!fs.existsSync(path.join(PROJECTS, historicalEvidenceId, "evidence.json")), "evidence.json écrit");
    const truth = readEnvelope(historicalEvidenceId, "truth").data;
    assert(truth.fact_evidence.checked === false && truth.facts[0].evidence.editorial_status === "not_checked" && truth.facts[0].evidence.technical_status === "not_fetched" && truth.rejected_count === 0, JSON.stringify(truth.fact_evidence));
  });

  fs.rmSync(evidencePages, { recursive: true, force: true });

  await test("--regenerate=script avec --stop-after=truth → refus avant toute production", () => {
    expectRefusal(
      run(
        ["--research-script", "--resume=prod-2099-01-01T00-00-00-000Z-abcdef", "--mode=full", "--real-calls-cap=3", "--regenerate=script", "--stop-after=truth"],
        ACK
      ),
      /arrêterait la production avant l'agent régénéré/
    );
  });

  await test("identifiant inconnu, invalide ou hors projects/ → refus", () => {
    expectRefusal(
      run(["--research-script", "--resume=prod-2099-01-01T00-00-00-000Z-abcdef"], fixtures()),
      /production introuvable/
    );

    for (const bad of ["../etc", "prod-x", "prod-2099-01-01T00-00-00-000Z-ABCDEF", "..", "/etc"]) {
      expectRefusal(
        run(["--research-script", `--resume=${bad}`], fixtures()),
        /identifiant de production invalide/
      );
    }

    expectRefusal(
      run(["--research-script", "--resume="], fixtures()),
      /--resume exige un identifiant/
    );
  });

  await test("--resume exige --research-script, refuse --dry-run, --title et --prompt", () => {
    expectRefusal(
      run([`--resume=${base.productionId}`], fixtures()),
      /--resume exige --research-script/
    );
    expectRefusal(
      run(["--dry-run", `--resume=${base.productionId}`], fixtures()),
      /--resume exige --research-script/
    );
    expectRefusal(
      run(["--research-script", `--resume=${base.productionId}`, "--title=Autre"], fixtures()),
      /interdits avec --resume/
    );
    expectRefusal(
      run(["--research-script", `--resume=${base.productionId}`, "--prompt=Autre"], fixtures()),
      /interdits avec --resume/
    );
  });

  await test("mode différent de celui de la production → refus", () => {
    expectRefusal(
      run(
        ["--research-script", `--resume=${base.productionId}`, "--mode=full", "--real-calls-cap=3"],
        ACK
      ),
      /différent du mode de la production/,
      base.productionId
    );
  });

  await test("--stop-after : valeurs invalides ou incompatibles → refus avant toute production", () => {
    for (const value of ["quality", "bogus", ""]) {
      expectRefusal(
        run(["--research-script", `--stop-after=${value}`], fixtures()),
        /--stop-after invalide/
      );
    }

    expectRefusal(
      run(["--stop-after=voice"], fixtures()),
      /--stop-after exige --research-script/
    );
    expectRefusal(
      run(
        ["--research-script", "--stop-after=voice", ...renderArgs(renderableMedia, outputDirectory())],
        fixtures()
      ),
      /--stop-after est incompatible avec --render/
    );
  });

  await test("artefact altéré : scellé SHA-256 non respecté → refus, rien n'est réparé", () => {
    const directory = path.join(PROJECTS, base.productionId);
    const file = path.join(directory, "research.json");
    const original = fs.readFileSync(file, "utf8");

    try {
      fs.writeFileSync(file, original.replace("\n", " \n"));

      const before = snapshot(base.productionId);
      const result = run(
        ["--research-script", `--resume=${base.productionId}`],
        fixtures()
      );

      expectRefusal(result, /research\.json ne correspond plus à son scellé SHA-256/, base.productionId);
      assert(
        JSON.stringify(snapshot(base.productionId)) === JSON.stringify(before),
        "un refus a modifié la production"
      );
    } finally {
      fs.writeFileSync(file, original);
    }
  });

  await test("artefact manquant pour un agent terminé → refus (renommé, puis remis)", () => {
    const directory = path.join(PROJECTS, base.productionId);
    const file = path.join(directory, "script.json");
    const parked = path.join(directory, "script.json.parked");

    fs.renameSync(file, parked);

    try {
      expectRefusal(
        run(["--research-script", `--resume=${base.productionId}`], fixtures()),
        /script\.json manquant alors que l'agent script est terminé/,
        base.productionId
      );
    } finally {
      fs.renameSync(parked, file);
    }
  });

  await test("scellé absent, ou production antérieure à R13 → refus", () => {
    const original = readProduction(base.productionId);

    try {
      const withoutOne = structuredClone(original);
      delete withoutOne.artifact_sha256["script.json"];
      writeProduction(base.productionId, withoutOne);

      expectRefusal(
        run(["--research-script", `--resume=${base.productionId}`], fixtures()),
        /script\.json n'a pas de scellé SHA-256/,
        base.productionId
      );

      const legacy = structuredClone(original);
      delete legacy.artifact_sha256;
      writeProduction(base.productionId, legacy);

      expectRefusal(
        run(["--research-script", `--resume=${base.productionId}`], fixtures()),
        /antérieure à R13/,
        base.productionId
      );
    } finally {
      writeProduction(base.productionId, original);
    }
  });

  await test("enveloppe incohérente (mode, agent, validation) → refus", () => {
    const directory = path.join(PROJECTS, base.productionId);
    const file = path.join(directory, "research.json");
    const productionOriginal = readProduction(base.productionId);
    const original = fs.readFileSync(file, "utf8");

    const variants = {
      "mode différent": envelope => { envelope.mode = "full"; },
      "agent différent": envelope => { envelope.agent = "script"; },
      "validation invalide": envelope => { envelope.validation.valid = false; },
      "data absente": envelope => { delete envelope.data; }
    };

    try {
      for (const [label, alter] of Object.entries(variants)) {
        const envelope = JSON.parse(original);
        alter(envelope);

        const content = JSON.stringify(envelope, null, 2) + "\n";
        const sealed = structuredClone(productionOriginal);

        // Le scellé est recalculé : seul le contrôle d'enveloppe peut refuser.
        sealed.artifact_sha256["research.json"] = crypto
          .createHash("sha256").update(content).digest("hex");

        fs.writeFileSync(file, content);
        writeProduction(base.productionId, sealed);

        expectRefusal(
          run(["--research-script", `--resume=${base.productionId}`], fixtures()),
          /research\.json : /,
          base.productionId
        );
      }
    } finally {
      fs.writeFileSync(file, original);
      writeProduction(base.productionId, productionOriginal);
    }
  });

  await test("verrou présent : reprise refusée, verrou conservé", () => {
    const lock = path.join(PROJECTS, base.productionId, ".lock");
    const before = snapshot(base.productionId);

    fs.writeFileSync(lock, '{"pid":1,"acquired_at":"test"}\n');

    try {
      const result = run(
        ["--research-script", `--resume=${base.productionId}`],
        fixtures()
      );

      assert(result.status !== 0, `exit ${result.status}`);
      assert(/Production verrouillée/.test(result.stderr), result.stderr.slice(0, 400));
      assert(result.created.length === 0 && result.blocked === 0, "effets de bord");
      assert(fs.existsSync(lock), "le refus a retiré le verrou d'un autre");
      const { ".lock": lockHash, ...others } = snapshot(base.productionId);

      assert(lockHash === sha256(lock), "verrou modifié");
      assert(
        JSON.stringify(others) === JSON.stringify(before),
        "production modifiée"
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  await test("une reprise refusée n'a jamais modifié la production de base", () => {
    const production = readProduction(base.productionId);

    assert(production.status === "paused", production.status);
    assert(!("resume_history" in production), "resume_history");
    assert(
      production.agents.slice(0, 2).every(a => a.status === "completed" && !("resumed" in a)) &&
      production.agents.slice(2).every(a => a.status === "pending"),
      "états modifiés"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 5. Reprise après un échec de rendu ---");

  const renderFailOutput = outputDirectory();

  const renderFail = run(
    ["--research-script", ...renderArgs(shortMedia, renderFailOutput)],
    fixtures()
  );

  await test("médias trop courts : rendu en échec, production failed, verrou retiré", () => {
    assert(renderFail.status === 1, `exit ${renderFail.status}\n${renderFail.stderr}`);

    const production = readProduction(renderFail.productionId);

    assert(production.status === "failed", production.status);
    assert(production.render.status === "failed", production.render.status);
    assert(
      production.agents.slice(0, 6).every(a => a.status === "completed"),
      "agents 1-6"
    );
    assert(
      !listDirectory(path.join(PROJECTS, renderFail.productionId)).includes(".lock"),
      "verrou laissé"
    );
  });

  await test("reprise sans --render d'une production créée avec --render → refus, rien modifié", () => {
    const before = snapshot(renderFail.productionId);

    expectRefusal(
      run(["--research-script", `--resume=${renderFail.productionId}`], fixtures()),
      /créée avec --render/,
      renderFail.productionId
    );

    assert(
      JSON.stringify(snapshot(renderFail.productionId)) === JSON.stringify(before),
      "production modifiée"
    );
  });

  const renderRetryOutput = outputDirectory();

  const renderRetry = run(
    [
      "--research-script",
      `--resume=${renderFail.productionId}`,
      ...renderArgs(renderableMedia, renderRetryOutput)
    ],
    { NO_API: "1" }
  );

  await test("reprise avec les bons médias : agents 1-3 réutilisés, MP4 rendu, zéro appel modèle", () => {
    assert(renderRetry.status === 0, `exit ${renderRetry.status}\n${renderRetry.stdout}\n${renderRetry.stderr}`);

    const production = readProduction(renderFail.productionId);

    assert(production.status === FINAL_STATUS, production.status);
    assert(production.render.status === "completed", production.render.status);
    assert(production.render.error === null, "erreur de rendu résiduelle");
    assert(production.input.media_dir === renderableMedia, "media_dir");
    assert(
      production.resume_history[0].previous_media_dir === shortMedia,
      "ancien media_dir non tracé"
    );
    assert(
      fs.existsSync(path.join(renderRetryOutput, `${renderFail.productionId}.mp4`)),
      "MP4 absent"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 6. Mode complet : reprise et déblocage nominatif (CLI) ---");

  // Le mode complet sous fixtures échoue toujours avant tout appel (les
  // fixtures ne simulent aucun outil) : aucun appel réel n'est possible.
  const fullEnv = { ...ACK, ANTHROPIC_FIXTURES: "1" };
  const fullArgs = ["--research-script", "--mode=full", "--real-calls-cap=3"];

  const fullFailed = run(fullArgs, fullEnv);

  await test("production en mode complet : mode enregistré, échec fail-closed, aucun appel", () => {
    assert(fullFailed.status === 1, `exit ${fullFailed.status}`);
    assert(fullFailed.blocked === 0, "réseau");
    assert(readProduction(fullFailed.productionId).mode === "full", "mode");
    assert(readProduction(fullFailed.productionId).status === "failed", "statut");
  });

  const orphanId = "c0001-" + "a".repeat(12);
  const journalFile = path.join(PROJECTS, fullFailed.productionId, "calls.json");

  fs.writeFileSync(
    journalFile,
    JSON.stringify({
      schema: 1,
      entries: [{
        call_id: orphanId,
        seq: 1,
        status: "started",
        request_sha256: "b".repeat(64),
        model: "claude-sonnet-4-5",
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null
      }]
    }, null, 2) + "\n"
  );

  await test("appel sans issue : reprise refusée (fail-closed), production et journal intacts", () => {
    const before = snapshot(fullFailed.productionId);

    const result = run(
      [...fullArgs, `--resume=${fullFailed.productionId}`],
      fullEnv
    );

    expectRefusal(result, /sans issue connue/, fullFailed.productionId);
    assert(result.stderr.includes(orphanId), "call_id absent du message");
    assert(
      JSON.stringify(snapshot(fullFailed.productionId)) === JSON.stringify(before),
      "production modifiée par le refus"
    );
  });

  await test("déblocage d'un id inconnu ou wildcard → refus, journal intact", () => {
    const before = snapshot(fullFailed.productionId);

    for (const value of ["c0002-" + "c".repeat(12), "*", "c0001-*"]) {
      expectRefusal(
        run(
          [...fullArgs, `--resume=${fullFailed.productionId}`, `--accept-unresolved-calls=${value}`],
          fullEnv
        ),
        /call_id valide|n'est pas un appel sans issue/,
        fullFailed.productionId
      );
    }

    assert(
      JSON.stringify(snapshot(fullFailed.productionId)) === JSON.stringify(before),
      "production modifiée par un refus"
    );
  });

  await test("déblocage nominatif : tracé dans le journal, reprise engagée puis échec fail-closed sans appel", () => {
    const result = run(
      [...fullArgs, `--resume=${fullFailed.productionId}`, `--accept-unresolved-calls=${orphanId}`],
      fullEnv
    );

    assert(result.status === 1, `exit ${result.status}`);
    assert(result.blocked === 0, "réseau");
    assert(/Reprise    : production existante/.test(result.stdout), "bannière de reprise");

    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));

    assert(journal.entries[0].status === "unresolved_accepted", journal.entries[0].status);
    assert(journal.entries[0].resolution.via === "--accept-unresolved-calls", "résolution");

    const production = readProduction(fullFailed.productionId);

    assert(production.resume_history.length === 1, "resume_history");
    assert(production.status === "failed", production.status);
    assert(
      !listDirectory(path.join(PROJECTS, fullFailed.productionId)).includes(".lock"),
      "verrou laissé"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 6b. Régénération volontaire (D′1) ---");

  // Production complète simulée en mémoire : agents 1-3 scellés, puis
  // régénération, archivage et reprise ordinaire. Aucun appel, aucun réseau.
  function sealedProduction() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-regenerate-"));
    const production = {
      id: "prod-2026-01-01T00-00-00-000Z-aaaaaa",
      mode: "full",
      status: "paused",
      input: { title: "Titre", prompt: "Consigne" },
      artifact_sha256: {},
      agents: AGENTS.map(id => ({ id, status: "pending", started_at: null, completed_at: null, error: null }))
    };
    const save = () => fs.writeFileSync(path.join(dir, "production.json"), JSON.stringify(production, null, 2) + "\n");
    for (const [agent, filename] of [["research", "research.json"], ["script", "script.json"], ["visual_director", "visual.json"]]) {
      sealAndWriteArtifact({ productionDir: dir, production, filename, save, data: { agent, mode: "full", data: { version: 1 }, validation: { valid: true } } });
      production.agents.find(a => a.id === agent).status = "completed";
    }
    save();
    return { dir, production };
  }

  for (const [target, expected] of [
    ["research", ["research", "script", "visual_director"]],
    ["script", ["script", "visual_director"]],
    ["visual_director", ["visual_director"]]
  ]) {
    await test(`--regenerate=${target} : agents recalculés ${expected.join(", ")}, amont réutilisé, artefacts archivés, resume_history`, () => {
      const { dir, production } = sealedProduction();
      try {
        const reuse = planReuse({ productionDir: dir, production });
        const regeneration = planRegeneration({ reuse, regenerate: target });
        assert(JSON.stringify(regeneration.agents) === JSON.stringify(expected), JSON.stringify(regeneration));
        assert(regeneration.reason === "manual_regenerate" && regeneration.archived_artifacts === expected.length && typeof regeneration.timestamp === "string", JSON.stringify(regeneration));
        applyResume({ production, reuse, mediaDir: null, render: null, regeneration });
        const archive = archiveRegeneratedArtifacts({ productionDir: dir, production, regeneration });
        const history = production.resume_history.at(-1);
        assert(history.regenerated === target && history.reason === "manual_regenerate" && history.archived_artifacts === expected.length && history.timestamp === regeneration.timestamp, JSON.stringify(history));
        assert(JSON.stringify(history.recomputed.slice(0, expected.length)) === JSON.stringify(expected), JSON.stringify(history));
        const archived = listDirectory(path.join(dir, archive));
        for (const filename of regeneration.files) {
          assert(archived.includes(filename) && !fs.existsSync(path.join(dir, filename)), `${filename} non archivé`);
          assert(!(filename in production.artifact_sha256), `scellé ${filename} conservé`);
        }
        const seals = JSON.parse(fs.readFileSync(path.join(dir, archive, "artifact_sha256.json"), "utf8"));
        assert(Object.keys(seals).length === expected.length, "scellés archivés");
        for (const id of ["research", "script", "visual_director"].filter(id => !expected.includes(id))) {
          assert(production.agents.find(a => a.id === id).status === "completed", `${id} devait rester réutilisé`);
        }
        // Reprise suivante : planReuse accepte l'état, l'amont est réutilisé.
        const next = planReuse({ productionDir: dir, production });
        for (const id of expected) assert(next[id] === false, `${id} devait être relancé`);
        // Le nouvel artefact, une fois écrit et scellé, est réutilisé par une reprise ordinaire.
        const filename = regeneration.files[0];
        sealAndWriteArtifact({ productionDir: dir, production, filename, save: () => {}, data: { agent: target, mode: "full", data: { version: 2 }, validation: { valid: true } } });
        production.agents.find(a => a.id === target).status = "completed";
        assert(planReuse({ productionDir: dir, production })[target] === true, "nouvel artefact non réutilisé");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  await test("régénération rejetée : entrées de la tentative déplacées dans rejected/, entrées remplacées restaurées, archives antérieures ignorées", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-rollback-"));
    const cache = path.join(dir, "call-cache");
    const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    try {
      const timestamp = "2026-10-03T12:00:00.000Z";
      // h1 : remplacé pendant la tentative (archive datée après le début).
      write(path.join(cache, "h1.json"), "candidat-h1");
      write(path.join(cache, "superseded", "2026-10-03T12-00-01-000Z", "h1.json"), "actif-h1");
      // h2 : nouvelle requête de la tentative, sans entrée antérieure ; une
      // archive plus ancienne que la tentative ne doit pas être restaurée.
      write(path.join(cache, "h2.json"), "candidat-h2");
      write(path.join(cache, "superseded", "2026-10-01T00-00-00-000Z", "h2.json"), "ancien-h2");
      // h3 : non concerné par la tentative.
      write(path.join(cache, "h3.json"), "intact-h3");

      const result = rollbackRegenerationCache({ productionDir: dir, hashes: ["h1", "h2", "h1"], timestamp });

      assert(fs.readFileSync(path.join(cache, "h1.json"), "utf8") === "actif-h1", "h1 non restauré");
      assert(!fs.existsSync(path.join(cache, "h2.json")), "h2 candidat resté actif");
      assert(fs.readFileSync(path.join(cache, "h3.json"), "utf8") === "intact-h3", "h3 modifié");
      assert(fs.readFileSync(path.join(cache, "superseded", "2026-10-01T00-00-00-000Z", "h2.json"), "utf8") === "ancien-h2", "archive antérieure déplacée");
      assert(!fs.existsSync(path.join(cache, "superseded", "2026-10-03T12-00-01-000Z")), "dossier d'archive vidé non retiré");
      const rejected = path.join(dir, result.rejected);
      assert(listDirectory(rejected).join() === "h1.json,h2.json", listDirectory(rejected).join());
      assert(fs.readFileSync(path.join(rejected, "h1.json"), "utf8") === "candidat-h1", "candidat rejeté non conservé");
      assert(JSON.stringify(result.restored) === JSON.stringify(["h1"]), JSON.stringify(result));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("--regenerate : agent sans artefact scellé ou inconnu → refus avant toute écriture", () => {
    const { dir, production } = sealedProduction();
    try {
      const reuse = planReuse({ productionDir: dir, production });
      reuse.visual_director = false;
      let error;
      try { planRegeneration({ reuse, regenerate: "visual_director" }); } catch (caught) { error = caught; }
      assert(error && /aucun artefact scellé valide/.test(error.message), error?.message);
      error = null;
      try { planRegeneration({ reuse, regenerate: "visual" }); } catch (caught) { error = caught; }
      assert(error && /--regenerate inconnu/.test(error.message), error?.message);
      assert(listDirectory(dir).join() === "production.json,research.json,script.json,visual.json", listDirectory(dir).join());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 7. Garanties ---");

  await test("aucune tentative réseau dans aucun processus enfant", () => {
    assert(blockedByRun.length >= 30, `${blockedByRun.length} processus`);
    assert(
      blockedByRun.every(count => count === 0),
      `tentatives par processus : ${blockedByRun}`
    );
  });
} finally {
  removeMediaFixtureRoot(fixtureRoot);
}

await test("le smoke n'a rien écrit dans output/ ni laissé dans tmp/", () => {
  assert(
    JSON.stringify(listDirectory(path.join(ROOT, "output"))) ===
      JSON.stringify(outputBefore),
    "output/ modifié"
  );

  const strangers = listDirectory(path.join(ROOT, "tmp")).filter(
    name => !name.startsWith("r9-media-")
  );

  assert(strangers.length === 0, `tmp/ : ${strangers}`);
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log(`Productions créées par le smoke (dans projects/) : ${createdProductions.length}`);
console.log("API Anthropic réelle utilisée : NON");
console.log(
  failed === 0
    ? "RESULTAT GLOBAL : PASS — reprise, scellés SHA, pause, verrou, déblocage nominatif, zéro appel modèle"
    : "RESULTAT GLOBAL : FAIL"
);

process.exit(failed === 0 ? 0 : 1);
