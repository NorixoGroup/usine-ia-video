// Smoke R23 — contrat des métadonnées long-form du Quality Gate.
//
// Usage :
//   NO_API=1 node scripts/r23-quality-envelope-smoke.js
//
// Aucun agent provider ni accès réseau : les six enveloppes sont des
// fixtures canoniques locales. Le smoke vérifie que les deux métadonnées
// R23 restent optionnelles mais, lorsqu'elles existent en mode full,
// restent strictement validées.

import { networkGuard } from "./fixture-network-guard.js";

import { runQualityAgent } from "../src/agents/quality.js";
import { buildArtifacts, buildTarget } from "./canonical-artifacts.js";

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

async function expectReject(fn, pattern) {
  let error;

  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "un rejet était attendu");
  assert(
    pattern.test(error.message),
    `erreur inattendue : ${error.message}`
  );
}

function fullTarget() {
  const target = buildTarget();

  // Les fixtures durent 40 s : une cible de test full cohérente permet
  // d'isoler le contrat d'enveloppe du contrôle de durée éditoriale.
  target.duration_minutes = {
    target: 0.7,
    min: 0.5,
    max: 1
  };

  return target;
}

function sha256(char) {
  return char.repeat(64);
}

function addR23Metadata(artifacts) {
  artifacts.script.script_generation = {
    mode: "segmented",
    total_segments: 2,
    generated_segments: 1,
    reused_segments: 1,
    checkpoint_directory: "script-segments",
    plan_sha256: sha256("a")
  };

  artifacts.visual.storyboard_generation = {
    mode: "batched",
    batch_size: 2,
    total_batches: 1,
    generated_batches: 1,
    reused_batches: 0,
    checkpoint_directory: "storyboard-batches",
    plan_sha256: sha256("b")
  };
}

async function fullArtifacts() {
  return buildArtifacts({ mode: "full" });
}

console.log("========================================");
console.log(" R23 QUALITY ENVELOPE — SMOKE (ZERO API)");
console.log("========================================");

await test("métadonnées R23 valides en full → PASS", async () => {
  const artifacts = await fullArtifacts();
  addR23Metadata(artifacts);

  const output = await runQualityAgent({
    artifacts,
    target: fullTarget(),
    testMode: false
  });

  assert(output.mode === "full", "mode full attendu");
  assert(output.data.verdict === "pass", "verdict pass attendu");
});

await test("script_generation absent reste accepté", async () => {
  const artifacts = await fullArtifacts();
  addR23Metadata(artifacts);
  delete artifacts.script.script_generation;

  const output = await runQualityAgent({
    artifacts,
    target: fullTarget(),
    testMode: false
  });

  assert(output.data.verdict === "pass", "verdict pass attendu");
});

await test("storyboard_generation absent reste accepté", async () => {
  const artifacts = await fullArtifacts();
  addR23Metadata(artifacts);
  delete artifacts.visual.storyboard_generation;

  const output = await runQualityAgent({
    artifacts,
    target: fullTarget(),
    testMode: false
  });

  assert(output.data.verdict === "pass", "verdict pass attendu");
});

await test("script_generation malformé → FAIL", async () => {
  const artifacts = await fullArtifacts();
  addR23Metadata(artifacts);
  artifacts.script.script_generation.total_segments = 0;

  await expectReject(
    () => runQualityAgent({
      artifacts,
      target: fullTarget(),
      testMode: false
    }),
    /script\.json: script_generation: total_segments invalide/
  );
});

await test("storyboard_generation malformé → FAIL", async () => {
  const artifacts = await fullArtifacts();
  addR23Metadata(artifacts);
  artifacts.visual.storyboard_generation.plan_sha256 = "invalid";

  await expectReject(
    () => runQualityAgent({
      artifacts,
      target: fullTarget(),
      testMode: false
    }),
    /visual\.json: storyboard_generation: plan_sha256 invalide/
  );
});

await test("clé d'enveloppe inconnue → FAIL", async () => {
  const artifacts = await fullArtifacts();
  addR23Metadata(artifacts);
  artifacts.script.unexpected_metadata = true;

  await expectReject(
    () => runQualityAgent({
      artifacts,
      target: fullTarget(),
      testMode: false
    }),
    /script\.json: champ unexpected_metadata non autorisé/
  );
});

await test("garde réseau : 0 tentative réseau", () => {
  assert(
    networkGuard.attempts().length === 0,
    `tentatives bloquées : ${networkGuard.attempts().join(", ")}`
  );
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API réelle utilisée : NON");

if (failed > 0) {
  console.error("RESULTAT GLOBAL : FAIL — R23 Quality Envelope");
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — R23 Quality Envelope, strict, zéro API"
);
