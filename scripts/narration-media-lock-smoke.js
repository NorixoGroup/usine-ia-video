// Smoke du verrou média partagé (R30-B) : empêche deux PRODUCTIONS
// DISTINCTES (productionDir différents) utilisant le même --media-dir de
// tenter une narration réelle simultanément, et vérifie qu'une collision
// séquentielle (l'une après l'autre) ne produit ni refacturation ni
// réutilisation ambiguë. Zéro réseau, zéro clé réelle.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/narration-media-lock-smoke.js

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
  createRealNarrationCallGuard
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
const NARRATION_LOCK_FILE = ".narration-lock";

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

function prepareMediaDir(root) {
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

function baseEnv() {
  return {
    PIPELINE_REAL_CALLS_ACK: "1",
    ANTHROPIC_FIXTURES: "1",
    ANTHROPIC_FIXTURE_SCENARIO: "happy",
    ANTHROPIC_FIXTURE_WEB_SEARCH_STUB: "1",
    ELEVENLABS_API_KEY: "",
    ...NETWORK_ISOLATION_ENV
  };
}

// L'amorce s'arrête volontairement après Asset (--stop-after=asset),
// SANS --real-narration ni --narration-unit : aucune tentative narration
// n'est jamais faite pendant l'amorce, pour que la reprise concurrente
// qui suit soit la toute première tentative narration de chaque
// production — sinon la protection R30 (retentative identique après
// échec, déjà couverte par narration-call-guard-reattempt-smoke.js)
// interviendrait avant même d'exercer le verrou média.
function bootstrapArgs(mediaDir) {
  return [
    "--research-script",
    "--mode=full",
    `--media-dir=${mediaDir}`,
    // Plafond large : sans scope pilote (pas de --narration-unit ici),
    // le précontrôle budgétaire des claims reste pleinement actif par
    // défaut (non-régression volontaire) — 10 couvre l'estimation des
    // claims sous fixtures, zéro coût réel.
    "--real-calls-cap=10",
    "--stop-after=asset"
  ];
}

function spawnBootstrap(mediaDir) {
  const before = fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [];
  spawnSync(
    process.execPath,
    ["src/orchestrator/mvp.js", ...bootstrapArgs(mediaDir)],
    { cwd: ROOT, env: { PATH: process.env.PATH, ...baseEnv() }, encoding: "utf8" }
  );
  const after = fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : [];
  return after.find((name) => !before.includes(name));
}

function runOrchestratorAsync(resumeId, mediaDir) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "src/orchestrator/mvp.js",
        "--research-script",
        "--mode=full",
        `--resume=${resumeId}`,
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01"
      ],
      { cwd: ROOT, env: { PATH: process.env.PATH, ...baseEnv() } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function removeProduction(id) {
  if (id) fs.rmSync(path.join(PROJECTS, id), { recursive: true, force: true });
}

// ---------------------------------------------------------------------
// 1. Verrou atomique, chemin canonique, libéré à la sortie normale.
// ---------------------------------------------------------------------

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

await test("1. Verrou créé puis libéré explicitement à la fin de l'appel narration (succès)", async () => {
  const mediaDir = tmpDir("medialock-basic-");
  try {
    const lockFile = path.join(fs.realpathSync(mediaDir), NARRATION_LOCK_FILE);
    const sourceFile = path.join(mediaDir, "source.mp3");
    generateAudio(sourceFile, { seconds: 0.2 });
    const sourceBytes = fs.readFileSync(sourceFile);

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: mediaDir, cap: 1 });
      await ensureNarrationAudio({
        mediaDir,
        units: [{ unitId: "s01-g01", text: "texte", estimatedSeconds: 3 }],
        provider: {
          kind: "fixture:lock-check",
          async generate() {
            assert(fs.existsSync(lockFile), "le verrou doit exister pendant l'appel narration");
            return { bytes: sourceBytes, extension: ".mp3" };
          }
        },
        callGuard: createRealNarrationCallGuard()
      });
    });

    assert(!fs.existsSync(lockFile), "le verrou doit être supprimé après la fin normale de l'appel");
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

await test("1b. Verrou libéré même après un échec provider (narration en erreur)", async () => {
  const mediaDir = tmpDir("medialock-basic-fail-");
  try {
    const lockFile = path.join(fs.realpathSync(mediaDir), NARRATION_LOCK_FILE);

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: mediaDir, cap: 1 });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir,
          units: [{ unitId: "s01-g01", text: "texte", estimatedSeconds: 3 }],
          provider: {
            kind: "fixture:lock-check-fail",
            async generate() {
              throw new Error("échec provider simulé");
            }
          },
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) { error = caught; }
      assert(error && /échec provider simulé/.test(error.message), error?.message);
    });

    assert(!fs.existsSync(lockFile), "le verrou doit être supprimé même après un échec provider");
  } finally {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 2. Deux PRODUCTIONS DISTINCTES, même --media-dir, concurrentes : une
// seule progresse jusqu'à la tentative narration ; l'autre est refusée
// par le verrou média avant tout appel.
// ---------------------------------------------------------------------

await test(
  "2. Deux productions distinctes, même --media-dir, concurrentes : verrou média effectif",
  async () => {
    const mediaDir = tmpDir("medialock-concurrency-");
    prepareMediaDir(mediaDir);

    const productionA = spawnBootstrap(mediaDir);
    const productionB = spawnBootstrap(mediaDir);

    try {
      assert(productionA && productionB && productionA !== productionB, "deux productions distinctes attendues");

      const [resultA, resultB] = await Promise.all([
        runOrchestratorAsync(productionA, mediaDir),
        runOrchestratorAsync(productionB, mediaDir)
      ]);

      const lockRejections = [resultA, resultB].filter(
        (result) => /dossier média verrouillé/.test(result.stderr)
      );

      assert(
        lockRejections.length >= 1,
        "au moins l'une des deux productions doit être refusée par le verrou média — " +
        `stderrA=${resultA.stderr.slice(-300)} | stderrB=${resultB.stderr.slice(-300)}`
      );

      // Aucune des deux productions ne doit jamais atteindre un vrai
      // appel (clé absente) : soit bloquée par le verrou, soit bloquée
      // par le contrôle de clé ElevenLabs habituel.
      for (const result of [resultA, resultB]) {
        assert(
          /dossier média verrouillé/.test(result.stderr) || /secret API absent/.test(result.stderr),
          `issue inattendue : ${result.stderr.slice(-300)}`
        );
      }
    } finally {
      removeProduction(productionA);
      removeProduction(productionB);
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------
// 3. Collision séquentielle : deux productions successives (jamais
// concurrentes), même --media-dir — aucune réutilisation ambiguë.
// ---------------------------------------------------------------------

await test(
  "3. Collision séquentielle (l'une après l'autre) : aucune réutilisation ambiguë du MP3",
  async () => {
    const mediaDir = tmpDir("medialock-sequential-");
    prepareMediaDir(mediaDir);

    const productionA = spawnBootstrap(mediaDir);
    try {
      assert(productionA, "production A non créée");

      // Production A échoue à Voice (clé absente) — aucun MP3 écrit,
      // donc rien à réutiliser pour l'instant.
      const resumeA = await runOrchestratorAsync(productionA, mediaDir);
      assert(/secret API absent/.test(resumeA.stderr), resumeA.stderr.slice(-300));
      assert(
        !fs.existsSync(path.join(mediaDir, "voice", "s01-g01.mp3")),
        "aucun MP3 ne devait être écrit (échec contrôlé de clé)"
      );

      // Production B, totalement distincte, même média — ne doit jamais
      // silencieusement réutiliser un MP3 qu'elle n'a elle-même ni
      // demandé ni journalisé. Ici, aucun MP3 n'existe encore : B suit
      // le même chemin d'échec contrôlé, sans ambiguïté possible.
      const productionB = spawnBootstrap(mediaDir);
      try {
        const resumeB = await runOrchestratorAsync(productionB, mediaDir);
        assert(/secret API absent/.test(resumeB.stderr), resumeB.stderr.slice(-300));

        const journalA = JSON.parse(
          fs.readFileSync(path.join(PROJECTS, productionA, JOURNAL_FILE), "utf8")
        );
        const journalB = JSON.parse(
          fs.readFileSync(path.join(PROJECTS, productionB, JOURNAL_FILE), "utf8")
        );
        assert(journalA.entries.length === 1 && journalA.entries[0].status === "failed", JSON.stringify(journalA));
        assert(journalB.entries.length === 1 && journalB.entries[0].status === "failed", JSON.stringify(journalB));
        // Les deux journaux sont des fichiers distincts, chacun dans son
        // propre productionDir : chaque production a bien tenté SA PROPRE
        // réservation (aucune n'a jamais lu ni hérité de celle de l'autre).
        // Un même call_id dans les deux (hash de requête identique, seq=1
        // dans chacun) est attendu et sans risque : rien n'est partagé
        // entre les deux fichiers.
      } finally {
        removeProduction(productionB);
      }
    } finally {
      removeProduction(productionA);
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------
// 4. Verrou résiduel (simulant un SIGKILL) : aucun contournement
// automatique, refus fermé explicite.
// ---------------------------------------------------------------------

await test(
  "4. Verrou résiduel (SIGKILL simulé) : refus fermé, aucune levée automatique",
  async () => {
    const mediaDir = tmpDir("medialock-stale-");
    prepareMediaDir(mediaDir);

    // Simule un processus tué brutalement : le verrou existe, mais le
    // processus porteur n'existe plus pour le libérer.
    fs.writeFileSync(
      path.join(mediaDir, NARRATION_LOCK_FILE),
      JSON.stringify({ pid: 999999, acquired_at: new Date().toISOString() }) + "\n"
    );

    const productionId = spawnBootstrap(mediaDir);
    try {
      assert(productionId, "production non créée");
      const result = await runOrchestratorAsync(productionId, mediaDir);
      assert(
        /dossier média verrouillé/.test(result.stderr),
        `refus fermé attendu malgré le verrou résiduel : ${result.stderr.slice(-300)}`
      );
      assert(
        fs.existsSync(path.join(mediaDir, NARRATION_LOCK_FILE)),
        "le verrou résiduel ne doit jamais être levé automatiquement"
      );
    } finally {
      removeProduction(productionId);
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
  }
);

console.log(`\n${passed} PASS, ${failed} FAIL`);
assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log("NETWORK ATTEMPTS = 0");
process.exit(failed > 0 ? 1 : 0);
