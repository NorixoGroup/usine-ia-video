// Smoke du pilote ElevenLabs (AA-Z) — exclusivement en mode simulation.
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/elevenlabs-pilot-smoke.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { networkGuard } from "./fixture-network-guard.js";
import { JOURNAL_FILE } from "../src/services/call-guard.js";
import {
  DEMO_UNIT,
  buildSimulationBytes,
  createSimulationProvider,
  evaluateRealModeAuthorization,
  runElevenLabsPilot
} from "./elevenlabs-pilot.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`       ${error.message}`);
  }
}

async function expectReject(fn, expression) {
  let error;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, "échec attendu");
  assert(expression.test(error.message), `erreur inattendue : ${error.message}`);
}

function freshOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "elevenlabs-pilot-smoke-"));
}

function readJournal(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8"));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const createdDirs = [];

function tracked(directory) {
  createdDirs.push(directory);
  return directory;
}

// ---------------------------------------------------------------------
// Autorisation réelle — jamais atteinte dans ce smoke (aucun des drapeaux/
// variables requis n'est fourni), vérifié explicitement.
// ---------------------------------------------------------------------

await test("Autorisation réelle refusée par défaut (aucun argument)", () => {
  const result = evaluateRealModeAuthorization({ argv: [], env: {} });
  assert(result.authorized === false, JSON.stringify(result));
});

await test("Autorisation réelle refusée même avec --real seul (signaux manquants)", () => {
  const result = evaluateRealModeAuthorization({ argv: ["--real"], env: {} });
  assert(result.authorized === false, JSON.stringify(result));
});

await test("Autorisation réelle refusée : NO_API=1 prime même avec tout le reste fourni", () => {
  const result = evaluateRealModeAuthorization({
    argv: ["--real"],
    env: {
      NO_API: "1",
      ELEVENLABS_PILOT_REAL_CALLS_ACK: "1",
      PIPELINE_REAL_CALLS_ACK: "1",
      ELEVENLABS_API_KEY: "x"
    }
  });
  assert(result.authorized === false, JSON.stringify(result));
});

// ---------------------------------------------------------------------
// 1-6. Simulation : une unité, un appel, zéro réseau, journal, MP3, hash.
// ---------------------------------------------------------------------

await test("1-2. Une seule unité s01-g01, un seul appel provider simulé", async () => {
  const outputDir = tracked(freshOutputDir());
  const bytes = buildSimulationBytes(outputDir);
  const provider = createSimulationProvider({ bytes });

  const result = await runElevenLabsPilot({ outputDir, provider, argv: [] });

  assert(result.mode === "simulation", result.mode);
  assert(Object.keys(result.localAudio).length === 1, "une seule unité attendue");
  assert(Object.keys(result.localAudio)[0] === "s01-g01", "unité s01-g01 attendue");
  assert(provider.calls.length === 1, `appels=${provider.calls.length}`);
  assert(provider.calls[0].unitId === DEMO_UNIT.unitId, provider.calls[0].unitId);
});

await test("3. Aucun appel réseau pendant la simulation", async () => {
  const before = networkGuard.attempts().length;
  const outputDir = tracked(freshOutputDir());
  const bytes = buildSimulationBytes(outputDir);
  await runElevenLabsPilot({ outputDir, provider: createSimulationProvider({ bytes }), argv: [] });
  assert(networkGuard.attempts().length === before, JSON.stringify(networkGuard.attempts()));
});

await test("4. Journal calls.json cohérent", async () => {
  const outputDir = tracked(freshOutputDir());
  const bytes = buildSimulationBytes(outputDir);
  await runElevenLabsPilot({ outputDir, provider: createSimulationProvider({ bytes }), argv: [] });

  const journal = readJournal(outputDir);
  assert(journal.entries.length === 1, `entrées=${journal.entries.length}`);
  const [entry] = journal.entries;
  assert(entry.status === "succeeded", entry.status);
  assert(entry.unit_id === "s01-g01", entry.unit_id);
  assert(entry.provider_kind === "simulation:elevenlabs-pilot", entry.provider_kind);
  assert(entry.path === "voice/s01-g01.mp3", entry.path);
});

await test("5-6. MP3 local vérifiable, SHA-256 et taille corrects", async () => {
  const outputDir = tracked(freshOutputDir());
  const bytes = buildSimulationBytes(outputDir);
  await runElevenLabsPilot({ outputDir, provider: createSimulationProvider({ bytes }), argv: [] });

  const file = path.join(outputDir, "voice", "s01-g01.mp3");
  assert(fs.existsSync(file), "MP3 absent");

  const journal = readJournal(outputDir);
  const [entry] = journal.entries;
  const stat = fs.statSync(file);

  assert(/^[0-9a-f]{64}$/.test(entry.sha256), entry.sha256);
  assert(sha256File(file) === entry.sha256, "SHA-256 ne correspond pas au fichier réel");
  assert(stat.size === entry.size_bytes, `taille réelle=${stat.size} vs journal=${entry.size_bytes}`);
});

// ---------------------------------------------------------------------
// 7-8. Reprise sans nouvel appel ; échec contrôlé sans retry.
// ---------------------------------------------------------------------

await test("7. Deuxième exécution sur le même dossier : aucun nouvel appel", async () => {
  const outputDir = tracked(freshOutputDir());
  const bytes = buildSimulationBytes(outputDir);

  const first = createSimulationProvider({ bytes });
  await runElevenLabsPilot({ outputDir, provider: first, argv: [] });
  assert(first.calls.length === 1, "premier appel attendu");

  const second = createSimulationProvider({ bytes });
  await runElevenLabsPilot({ outputDir, provider: second, argv: [] });
  assert(second.calls.length === 0, `reprise a réinvoqué le provider : ${second.calls.length}`);

  const journal = readJournal(outputDir);
  assert(journal.entries.length === 1, `une reprise ne doit ajouter aucune entrée : ${journal.entries.length}`);
});

await test("8. Échec contrôlé : aucun retry, aucun fichier final, journal 'failed'", async () => {
  const outputDir = tracked(freshOutputDir());
  const provider = createSimulationProvider({ fail: true });

  await expectReject(
    () => runElevenLabsPilot({ outputDir, provider, argv: [] }),
    /échec simulé du provider/
  );

  assert(provider.calls.length === 1, `appels=${provider.calls.length} (retry suspecté)`);
  const voiceDir = path.join(outputDir, "voice");
  const files = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
  assert(files.length === 0, `fichier résiduel : ${files.join(", ")}`);

  const journal = readJournal(outputDir);
  assert(journal.entries.length === 1 && journal.entries[0].status === "failed", JSON.stringify(journal.entries));
});

// ---------------------------------------------------------------------
// 9-10. Nettoyage des temporaires ; aucune modification des productions.
// ---------------------------------------------------------------------

const projectsSnapshotBefore = fs.existsSync("projects")
  ? fs.readdirSync("projects").sort()
  : null;

await test("10. Aucune modification de projects/ pendant tout le smoke", () => {
  const after = fs.existsSync("projects") ? fs.readdirSync("projects").sort() : null;
  assert(
    JSON.stringify(after) === JSON.stringify(projectsSnapshotBefore),
    "projects/ a changé pendant le smoke"
  );
});

await test("9. Nettoyage des temporaires du pilote", () => {
  for (const directory of createdDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const directory of createdDirs) {
    assert(!fs.existsSync(directory), `résidu non nettoyé : ${directory}`);
  }
});

console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
