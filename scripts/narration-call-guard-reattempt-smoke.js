// Smoke dédié à la protection contre une nouvelle tentative narration
// automatique pour une requête déjà tentée (R30 — sécurisation
// inter-processus des appels ElevenLabs). Zéro réseau, zéro clé réelle.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/narration-call-guard-reattempt-smoke.js

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { networkGuard } from "./fixture-network-guard.js";
import { generateAudio, generateImage, generateVideo } from "./local-media-fixtures.js";
import {
  JOURNAL_FILE,
  REAL_CALLS_ACK_ENV,
  configureCallGuard,
  resetCallGuard,
  createRealNarrationCallGuard,
  requestSha256
} from "../src/services/call-guard.js";
import { ensureNarrationAudio } from "../src/services/narration-provider.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = path.join(ROOT, "tmp");
const PROJECTS = path.join(ROOT, "projects");

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

function tmpDir(prefix) {
  fs.mkdirSync(TMP, { recursive: true });
  return fs.mkdtempSync(path.join(TMP, prefix));
}

function readJournal(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8"));
}

function unitFor(unitId, text) {
  return { unitId, text, estimatedSeconds: 3 };
}

function fakeProvider({ bytes, failUnitIds = [], failError } = {}) {
  const calls = [];
  return {
    kind: "fixture:reattempt-smoke",
    calls,
    async generate({ unitId, text, estimatedSeconds }) {
      calls.push({ unitId, text, estimatedSeconds });
      if (failUnitIds.includes(unitId)) {
        throw failError ?? new Error(`échec provider simulé pour ${unitId}`);
      }
      return { bytes, extension: ".mp3" };
    }
  };
}

function withRealCallsAuthorized(fn) {
  const previousNoApi = process.env.NO_API;
  const previousAck = process.env[REAL_CALLS_ACK_ENV];
  delete process.env.NO_API;
  process.env[REAL_CALLS_ACK_ENV] = "1";
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousNoApi === undefined) delete process.env.NO_API;
      else process.env.NO_API = previousNoApi;
      if (previousAck === undefined) delete process.env[REAL_CALLS_ACK_ENV];
      else process.env[REAL_CALLS_ACK_ENV] = previousAck;
      resetCallGuard();
    });
}

const mediaRoot = tmpDir("reattempt-media-");
const sourceFile = path.join(mediaRoot, "source.mp3");
generateAudio(sourceFile, { seconds: 0.2 });
const sourceBytes = fs.readFileSync(sourceFile);

// ---------------------------------------------------------------------
// 1. Premier appel simulé et journalisé.
// ---------------------------------------------------------------------

await test("1. Premier appel simulé : journalisé 'succeeded'", async () => {
  const dir = tmpDir("reattempt-first-");
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("s01-g01", "premier texte")],
        provider,
        callGuard: createRealNarrationCallGuard()
      });
      assert(provider.calls.length === 1, "un appel attendu");
    });
    const journal = readJournal(dir);
    assert(journal.entries.length === 1 && journal.entries[0].status === "succeeded", JSON.stringify(journal.entries));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 2. Relance après échec : aucun deuxième appel (le correctif central).
// ---------------------------------------------------------------------

await test("2. Relance après échec (même requête) : refus fermé, aucun deuxième appel", async () => {
  const dir = tmpDir("reattempt-failed-");
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ failUnitIds: ["s01-g01"] });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte identique")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(error && /échec provider simulé/.test(error.message), error?.message);
      assert(provider.calls.length === 1, "un seul appel attendu au premier essai");
    });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte identique")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(error && /Nouvelle tentative narration refusée/.test(error.message), error?.message);
      assert(error && /"failed"/.test(error.message), error.message);
      assert(provider.calls.length === 0, `aucun appel ne devait être tenté : ${provider.calls.length}`);
    });

    const journal = readJournal(dir);
    assert(journal.entries.length === 1, `une seule entrée attendue au total : ${journal.entries.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 3. Relance après timeout (même requête) : aucun deuxième appel.
// ---------------------------------------------------------------------

await test("3. Relance après timeout (même requête) : refus fermé, aucun deuxième appel", async () => {
  const dir = tmpDir("reattempt-timeout-");
  try {
    const timeoutError = Object.assign(new Error("provider timeout"), { name: "AbortError" });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ failUnitIds: ["s01-g01"], failError: timeoutError });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte stable")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(error && /timeout/.test(error.message), error?.message);
    });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte stable")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(error && /Nouvelle tentative narration refusée/.test(error.message), error?.message);
      assert(provider.calls.length === 0, "aucun appel ne devait être tenté après un timeout");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 4. Relance après entrée "started" non résolue : blocage — y compris
// via --accept-unresolved-calls, qui ne lève jamais ce refus-ci.
// ---------------------------------------------------------------------

await test("4. Entrée 'started' non résolue : reprise bloquée, --accept-unresolved-calls ne lève pas le refus de la requête", async () => {
  const dir = tmpDir("reattempt-started-");
  try {
    // Simule un crash exact après la réservation (avant endNarrationCall) :
    // écrit directement un journal avec une entrée "started", sans jamais
    // appeler le vrai provider.
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
    });

    const hash = requestSha256({
      kind: "narration",
      provider_kind: "fixture:reattempt-smoke",
      unit_id: "s01-g01",
      request: {
        unit_id: "s01-g01",
        text: "texte interrompu",
        estimated_seconds: 3,
        provider_config: {}
      }
    });

    fs.writeFileSync(
      path.join(dir, JOURNAL_FILE),
      JSON.stringify({
        schema: 1,
        entries: [{
          call_id: `c0001-${hash.slice(0, 12)}`,
          seq: 1,
          status: "started",
          request_sha256: hash,
          provider_kind: "fixture:reattempt-smoke",
          unit_id: "s01-g01",
          started_at: new Date().toISOString(),
          ended_at: null
        }]
      }, null, 2) + "\n"
    );

    // Sans déblocage : la reprise au niveau production doit être refusée
    // (mécanisme préexistant, non modifié par ce correctif).
    await withRealCallsAuthorized(async () => {
      let error;
      try { configureCallGuard({ productionDir: dir, cap: 1 }); } catch (caught) { error = caught; }
      assert(error && /sans issue connue/.test(error.message), error?.message);
    });

    // Avec déblocage nominatif : la production redevient utilisable,
    // MAIS la requête identique reste refusée par le nouveau garde.
    const callId = JSON.parse(fs.readFileSync(path.join(dir, JOURNAL_FILE), "utf8")).entries[0].call_id;

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1, acceptUnresolved: [callId] });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte interrompu")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(
        error && /Nouvelle tentative narration refusée/.test(error.message),
        `--accept-unresolved-calls n'aurait jamais dû lever ce refus : ${error?.message}`
      );
      assert(provider.calls.length === 0, "aucun appel ne devait être tenté");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 5. Relance après succès avec MP3 valide : réutilisation sans appel.
// ---------------------------------------------------------------------

await test("5. Relance après succès, MP3 valide : réutilisation sans appel", async () => {
  const dir = tmpDir("reattempt-reuse-ok-");
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("s01-g01", "texte stable")],
        provider,
        callGuard: createRealNarrationCallGuard()
      });
    });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("s01-g01", "texte stable")],
        provider,
        callGuard: createRealNarrationCallGuard()
      });
      assert(provider.calls.length === 0, "réutilisation attendue, aucun appel");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 6. Relance après succès, MP3 absent (supprimé manuellement) : blocage.
// ---------------------------------------------------------------------

await test("6. Relance après succès, MP3 absent : blocage (fail-closed, pas de refacturation)", async () => {
  const dir = tmpDir("reattempt-missing-file-");
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("s01-g01", "texte stable")],
        provider,
        callGuard: createRealNarrationCallGuard()
      });
    });

    fs.unlinkSync(path.join(dir, "voice", "s01-g01.mp3"));

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte stable")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(
        error && /Nouvelle tentative narration refusée/.test(error.message) && /"succeeded"/.test(error.message),
        error?.message
      );
      assert(provider.calls.length === 0, "aucune nouvelle synthèse automatique ne doit être déclenchée");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 7. Modification du texte : aucun recyclage du MP3 précédent.
// ---------------------------------------------------------------------

await test("7. Texte modifié sur une unité déjà synthétisée : rejet, aucun recyclage", async () => {
  const dir = tmpDir("reattempt-text-change-");
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("s01-g01", "texte ORIGINAL")],
        provider,
        callGuard: createRealNarrationCallGuard()
      });
    });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("s01-g01", "texte MODIFIÉ")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(error && /Réutilisation refusée/.test(error.message), error?.message);
      assert(provider.calls.length === 0, "aucun appel ne devait être tenté");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 8. Deux processus concurrents sur la même reprise : aucune double
// réservation (via acquireProductionLock, déjà existant et vérifié ici
// pour ce scénario précis).
// ---------------------------------------------------------------------

function runOrchestratorAsync(extraArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["src/orchestrator/mvp.js", "--research-script", ...extraArgs],
      { cwd: ROOT, env: { PATH: process.env.PATH, ...env } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function prepareConcurrencyMediaDir(root) {
  const asset = name => path.join(root, "assets", name);
  generateImage(asset("s01-g01-sh01.png"));
  generateVideo(asset("s01-g01-sh02.mp4"), { seconds: 8 });
  generateVideo(asset("s01-g02-sh01.mp4"), { seconds: 8 });
  generateImage(asset("s01-g02-sh02.png"), { color: "gray" });
  generateVideo(asset("s01-g02-sh03.mp4"), { seconds: 5, color: "gray" });
  generateImage(asset("s02-g01-sh01.png"), { color: "orange" });
  generateVideo(asset("s02-g01-sh02.mp4"), { seconds: 8, color: "orange" });
  generateImage(asset("s02-g02-sh01.png"), { color: "green" });
  generateVideo(asset("s02-g02-sh02.mp4"), { seconds: 8, color: "green" });
  return root;
}

const UNROUTABLE_PROXY = "http://127.0.0.1:1";
const NETWORK_ISOLATION_ENV = {
  HTTP_PROXY: UNROUTABLE_PROXY,
  HTTPS_PROXY: UNROUTABLE_PROXY,
  http_proxy: UNROUTABLE_PROXY,
  https_proxy: UNROUTABLE_PROXY,
  NO_PROXY: ""
};

await test(
  "8. Deux processus concurrents visant la même reprise : un seul progresse, l'autre refusé par le verrou de production",
  async () => {
    const concurrencyMediaRoot = tmpDir("reattempt-concurrency-media-");
    prepareConcurrencyMediaDir(concurrencyMediaRoot);

    const baseEnv = {
      PIPELINE_REAL_CALLS_ACK: "1",
      ANTHROPIC_FIXTURES: "1",
      ANTHROPIC_FIXTURE_SCENARIO: "happy",
      ANTHROPIC_FIXTURE_WEB_SEARCH_STUB: "1",
      ELEVENLABS_API_KEY: "",
      ...NETWORK_ISOLATION_ENV
    };

    // Amorce : une première exécution fraîche va jusqu'à Research/Script/
    // Visual Director/Asset (fixtures, zéro réseau) puis échoue à Voice
    // (clé ElevenLabs absente) — exactement comme le pilote réel. La
    // production qui en résulte est alors resumable : c'est elle que les
    // deux processus concurrents vont se disputer.
    const before = fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [];
    spawnSync(
      process.execPath,
      [
        "src/orchestrator/mvp.js",
        "--research-script",
        "--mode=full",
        "--real-narration",
        `--media-dir=${concurrencyMediaRoot}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01"
      ],
      { cwd: ROOT, env: { PATH: process.env.PATH, ...baseEnv }, encoding: "utf8" }
    );
    const after = fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [];
    const productionId = after.find((name) => !before.includes(name));

    try {
      assert(productionId, "amorce : aucune production créée pour le test de concurrence");

      const resumeArgs = [
        "--mode=full",
        `--resume=${productionId}`,
        "--real-narration",
        `--media-dir=${concurrencyMediaRoot}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01"
      ];

      const [first, second] = await Promise.all([
        runOrchestratorAsync(resumeArgs, baseEnv),
        runOrchestratorAsync(resumeArgs, baseEnv)
      ]);

      const lockRejections = [first, second].filter(
        (result) => /Production verrouillée/.test(result.stderr)
      );

      assert(
        lockRejections.length >= 1,
        "au moins l'un des deux processus concurrents doit être refusé par le verrou de production — " +
        `stderr1=${first.stderr.slice(-300)} | stderr2=${second.stderr.slice(-300)}`
      );

      const journalPath = path.join(PROJECTS, productionId, JOURNAL_FILE);
      if (fs.existsSync(journalPath)) {
        const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
        const matching = journal.entries.filter((entry) => entry.unit_id === "s01-g01");
        assert(
          matching.length <= 1,
          `au plus une réservation pour s01-g01 attendue, obtenu ${matching.length}`
        );
      }
    } finally {
      if (productionId) {
        fs.rmSync(path.join(PROJECTS, productionId), { recursive: true, force: true });
      }
      fs.rmSync(concurrencyMediaRoot, { recursive: true, force: true });
    }
  }
);

fs.rmSync(mediaRoot, { recursive: true, force: true });

console.log(`\n${passed} PASS, ${failed} FAIL`);
assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log("NETWORK ATTEMPTS = 0");
process.exit(failed > 0 ? 1 : 0);
