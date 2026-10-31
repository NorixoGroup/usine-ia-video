// Smoke de --narration-unit (mode pilote : une seule unité de narration
// réelle, un seul appel ElevenLabs maximum).
//
// Usage :
//   node scripts/narration-unit-smoke.js
//
// Famille 1 — validation CLI, zéro FFmpeg/ffprobe : chaque cas est
// refusé par mvp.js à l'analyse des arguments, avant toute lecture de
// --media-dir et avant toute création de production. Le dossier passé
// en --media-dir n'a donc besoin d'exister que pour que la chaîne
// --media-dir=<dossier> soit syntaxiquement acceptée ; il reste vide,
// aucun fichier média n'est fabriqué, aucun FFmpeg n'est invoqué.
//
// Famille 2 — chemin réel jusqu'à la garde de clé API ElevenLabs :
// atteindre l'agent Voice exige de traverser l'agent Asset, qui invoque
// ffprobe (via src/media/probe.js) sur chaque fichier de --media-dir
// dès que ce dossier est fourni. Les cinq fixtures vidéo/image qu'il
// attend sont donc fabriquées localement par FFmpeg (couleur unie,
// aucune source réseau, aucun contenu réel) dans un dossier temporaire
// isolé, supprimé en bloc finally. Aucun fichier voice/ n'est créé :
// les deux unités de narration restent à synthétiser, pour que le
// filtrage par --narration-unit soit observable. La clé ElevenLabs
// reste vide : le provider échoue au contrôle de clé
// (elevenlabs-narration-provider.js, avant toute construction de
// requête HTTP) ; en défense en profondeur, HTTP(S)_PROXY est en plus
// pointé vers une adresse non routée pour ces cas précis, afin qu'un
// éventuel appel réseau échoue immédiatement même si la garde de clé
// était un jour contournée par erreur.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createMediaFixtureRoot,
  generateImage,
  generateVideo,
  generateVideoWithAudio,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const PROJECTS = path.join(ROOT, "projects");
const TMP = path.join(ROOT, "tmp");
const PREFIX = "narration-unit-smoke-";

let failed = 0;
let passed = 0;
let skipped = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listProductions() {
  return fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).sort() : [];
}

function removeProduction(productionId) {
  fs.rmSync(path.join(PROJECTS, productionId), {
    recursive: true,
    force: true
  });
}

function readJournal(productionId) {
  const file = path.join(PROJECTS, productionId, "calls.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

// Jeu de médias minimal : les cinq assets attendus par le plan visuel
// canonique (titre/prompt par défaut), AUCUN fichier voice/ — les deux
// unités de narration restent donc à synthétiser. Couleur unie
// uniquement, fabriquée par le ffmpeg local : aucune source réelle,
// aucune donnée sensible.
function prepareAssetsOnlyMediaDir(root) {
  const asset = name => path.join(root, "assets", name);

  generateVideo(asset("s01-g01-sh01.mp4"), { seconds: 8 });
  generateImage(asset("s01-g01-sh02.png"));
  generateVideo(asset("s01-g01-sh03.mp4"), { seconds: 6, color: "gray" });
  generateVideo(asset("s02-g01-sh01.mp4"), { seconds: 12, color: "orange" });
  generateVideoWithAudio(asset("s02-g01-sh02.mp4"), { seconds: 8 });

  return root;
}

// Exécute fn(mediaDir) avec un jeu de fixtures réel (assets uniquement,
// fabriqué par FFmpeg dans tmp/r9-media-*), garanti nettoyé même en cas
// d'assertion échouée.
function withAssetsOnlyMediaDir(fn) {
  const fixtureRoot = createMediaFixtureRoot();
  const mediaDir = prepareAssetsOnlyMediaDir(
    path.join(fixtureRoot, "media")
  );

  try {
    fn(mediaDir);
  } finally {
    removeMediaFixtureRoot(fixtureRoot);
  }
}

// Dossier --media-dir vide, sans aucun fichier média : suffisant pour
// les cas de la famille 1, où mvp.js refuse avant toute lecture du
// dossier. Créé sous tmp/narration-unit-smoke-<aléatoire>/, supprimé en
// bloc finally.
function createEmptyMediaDir() {
  fs.mkdirSync(TMP, { recursive: true });
  return fs.mkdtempSync(path.join(TMP, PREFIX));
}

function removeMediaDir(directory) {
  if (
    typeof directory !== "string" ||
    path.dirname(directory) !== TMP ||
    !path.basename(directory).startsWith(PREFIX)
  ) {
    throw new Error(
      `narration-unit-smoke — suppression refusée hors de tmp/${PREFIX}* (${directory})`
    );
  }

  fs.rmSync(directory, { recursive: true, force: true });
}

function run(extraArgs, env) {
  const before = listProductions();

  const child = spawnSync(
    process.execPath,
    ["src/orchestrator/mvp.js", "--research-script", ...extraArgs],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8"
    }
  );

  const created = listProductions().filter(name => !before.includes(name));
  const productionId = created[0] ?? null;

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    productionId
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS — ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL — ${name}`);
    console.error(`       ${error.message}`);
    failed += 1;
  }
}

// Exécute fn(mediaDir) avec un --media-dir vide garanti nettoyé, même
// en cas d'assertion échouée ou d'exception imprévue.
function withEmptyMediaDir(fn) {
  const mediaDir = createEmptyMediaDir();

  try {
    fn(mediaDir);
  } finally {
    removeMediaDir(mediaDir);
  }
}

// Exécute fn(result) et nettoie la production créée (s'il y en a une),
// même en cas d'assertion échouée.
function withProductionCleanup(result, fn) {
  try {
    fn();
  } finally {
    if (result.productionId) {
      removeProduction(result.productionId);
    }
  }
}

// ---------------------------------------------------------------------
// Famille 1 — validation CLI, refus avant toute lecture de --media-dir.
// Zéro FFmpeg, zéro ffprobe : aucun fichier média n'est jamais fabriqué
// ni inspecté dans ces cas.
// ---------------------------------------------------------------------

test("--narration-unit= (vide) : refus avant appel", () => {
  const result = run(["--narration-unit="], {});

  withProductionCleanup(result, () => {
    assert(result.status !== 0, "code de sortie attendu non nul");
    assert(result.productionId === null, "aucune production ne doit être créée");
    assert(
      /--narration-unit exige un identifiant/.test(result.stderr),
      `message attendu absent : ${result.stderr}`
    );
  });
});

test("--narration-unit fourni deux fois : refus avant appel", () => {
  const result = run(
    ["--narration-unit=s01-g01", "--narration-unit=s02-g01"],
    {}
  );

  withProductionCleanup(result, () => {
    assert(result.status !== 0, "code de sortie attendu non nul");
    assert(result.productionId === null, "aucune production ne doit être créée");
    assert(
      /ne peut être fourni qu'une seule fois/.test(result.stderr),
      `message attendu absent : ${result.stderr}`
    );
  });
});

test("--narration-unit=../../secret : chemin refusé avant appel", () => {
  const result = run(["--narration-unit=../../secret"], {});

  withProductionCleanup(result, () => {
    assert(result.status !== 0, "code de sortie attendu non nul");
    assert(result.productionId === null, "aucune production ne doit être créée");
    assert(
      /--narration-unit invalide/.test(result.stderr),
      `message attendu absent : ${result.stderr}`
    );
  });
});

test("--narration-unit=s01-g01 sans --real-narration : refus avant appel", () => {
  const result = run(["--narration-unit=s01-g01"], {});

  withProductionCleanup(result, () => {
    assert(result.status !== 0, "code de sortie attendu non nul");
    assert(result.productionId === null, "aucune production ne doit être créée");
    assert(
      /--narration-unit exige --research-script, --real-narration, --media-dir et --mode=full/.test(
        result.stderr
      ),
      `message attendu absent : ${result.stderr}`
    );
  });
});

test("--narration-unit=s01-g01 sans --real-calls-cap : refus historique conservé", () => {
  withEmptyMediaDir((mediaDir) => {
    const result = run(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--narration-unit=s01-g01"
      ],
      { PIPELINE_REAL_CALLS_ACK: "1" }
    );

    withProductionCleanup(result, () => {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(result.productionId === null, "aucune production ne doit être créée");
      assert(
        /--real-calls-cap=<N> est obligatoire/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
    });
  });
});

test("--narration-unit=s01-g01 avec --real-calls-cap=2 : refus mode pilote", () => {
  withEmptyMediaDir((mediaDir) => {
    const result = run(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--real-calls-cap=2",
        "--narration-unit=s01-g01"
      ],
      { PIPELINE_REAL_CALLS_ACK: "1" }
    );

    withProductionCleanup(result, () => {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(result.productionId === null, "aucune production ne doit être créée");
      assert(
        /--narration-unit exige --real-calls-cap=1/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
    });
  });
});

test("--narration-unit=s01-g01 avec --real-calls-cap=0 : refus (plafond invalide)", () => {
  withEmptyMediaDir((mediaDir) => {
    const result = run(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--real-calls-cap=0",
        "--narration-unit=s01-g01"
      ],
      { PIPELINE_REAL_CALLS_ACK: "1" }
    );

    withProductionCleanup(result, () => {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(result.productionId === null, "aucune production ne doit être créée");
      assert(
        /--real-calls-cap invalide/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
    });
  });
});

test("--narration-unit=s01-g01 sans PIPELINE_REAL_CALLS_ACK : refus historique conservé", () => {
  withEmptyMediaDir((mediaDir) => {
    const result = run(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01"
      ],
      {}
    );

    withProductionCleanup(result, () => {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(result.productionId === null, "aucune production ne doit être créée");
      assert(
        /PIPELINE_REAL_CALLS_ACK=1 est obligatoire/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
    });
  });
});

test("--narration-unit=s01-g01 avec NO_API=1 : refus historique conservé (coupe-circuit prioritaire)", () => {
  withEmptyMediaDir((mediaDir) => {
    const result = run(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01"
      ],
      { NO_API: "1", PIPELINE_REAL_CALLS_ACK: "1" }
    );

    withProductionCleanup(result, () => {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(result.productionId === null, "aucune production ne doit être créée");
      assert(
        /NO_API=1 — appels réels interdits/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
    });
  });
});

// ---------------------------------------------------------------------
// Famille 2 — chemin réel jusqu'à la garde de clé API ElevenLabs.
// Traverse réellement Research/Truth/Script/Visual Director/Asset
// (fixtures Anthropic happy + médias locaux synthétiques), puis Voice.
// Isolation réseau en défense en profondeur : HTTP(S)_PROXY pointés
// vers une adresse non routée, en plus de la clé ElevenLabs vide.
// ---------------------------------------------------------------------

const UNROUTABLE_PROXY = "http://127.0.0.1:1";

const NETWORK_ISOLATION_ENV = {
  HTTP_PROXY: UNROUTABLE_PROXY,
  HTTPS_PROXY: UNROUTABLE_PROXY,
  http_proxy: UNROUTABLE_PROXY,
  https_proxy: UNROUTABLE_PROXY,
  NO_PROXY: ""
};

test(
  "--narration-unit=s01-g01, cap=1 : une seule réservation pour s01-g01, échec contrôlé avant tout réseau",
  () => {
    withAssetsOnlyMediaDir((mediaDir) => {
      const result = run(
        [
          "--mode=full",
          "--real-narration",
          `--media-dir=${mediaDir}`,
          "--real-calls-cap=1",
          "--narration-unit=s01-g01"
        ],
        {
          PIPELINE_REAL_CALLS_ACK: "1",
          ANTHROPIC_FIXTURES: "1",
          ANTHROPIC_FIXTURE_SCENARIO: "happy",
          ANTHROPIC_FIXTURE_WEB_SEARCH_STUB: "1",
          ELEVENLABS_API_KEY: "",
          ...NETWORK_ISOLATION_ENV
        }
      );

      withProductionCleanup(result, () => {
        assert(result.productionId !== null, "une production doit être créée");

        const journal = readJournal(result.productionId);

        assert(journal !== null, "calls.json doit exister");
        assert(
          journal.entries.length === 1,
          `exactement une réservation attendue, obtenu ${journal.entries.length}`
        );
        assert(
          journal.entries[0].unit_id === "s01-g01",
          `réservation attendue pour s01-g01, obtenu ${journal.entries[0].unit_id}`
        );
        assert(
          journal.entries[0].provider_kind === "elevenlabs",
          "provider_kind attendu : elevenlabs"
        );
        assert(
          journal.entries[0].status === "failed",
          `statut attendu "failed" (clé absente), obtenu ${journal.entries[0].status}`
        );
        assert(
          !/sk-[A-Za-z0-9_-]+/.test(result.stderr) &&
            !/xi-api-key/i.test(result.stderr),
          "aucun secret ne doit apparaître dans la sortie"
        );
        assert(
          /secret API absent/.test(result.stderr),
          `échec attendu au contrôle de clé, obtenu : ${result.stderr}`
        );

        const voiceDir = path.join(mediaDir, "voice");
        const voiceFiles = fs.existsSync(voiceDir)
          ? fs.readdirSync(voiceDir)
          : [];

        assert(
          voiceFiles.length === 0,
          "aucun fichier audio ne doit être écrit (clé absente avant tout appel)"
        );

        const production = JSON.parse(
          fs.readFileSync(
            path.join(PROJECTS, result.productionId, "production.json"),
            "utf8"
          )
        );
        const voiceAgent = production.agents.find(
          (agent) => agent.id === "voice"
        );

        assert(
          production.status !== "completed",
          "la production ne doit jamais être déclarée completed"
        );
        assert(
          !voiceAgent || voiceAgent.status !== "completed",
          "Voice ne doit jamais être déclaré completed avec une narration partielle"
        );
        assert(
          !fs.existsSync(
            path.join(PROJECTS, result.productionId, "assembly.json")
          ),
          "Assembly ne doit jamais être atteint après un échec Voice"
        );
      });
    });
  }
);

test(
  "deux unités, cap=1, sans sélection : refus historique conservé (non régression)",
  () => {
    withAssetsOnlyMediaDir((mediaDir) => {
      const result = run(
        [
          "--mode=full",
          "--real-narration",
          `--media-dir=${mediaDir}`,
          "--real-calls-cap=1"
        ],
        {
          PIPELINE_REAL_CALLS_ACK: "1",
          ANTHROPIC_FIXTURES: "1",
          ANTHROPIC_FIXTURE_SCENARIO: "happy",
          ANTHROPIC_FIXTURE_WEB_SEARCH_STUB: "1",
          ELEVENLABS_API_KEY: "",
          ...NETWORK_ISOLATION_ENV
        }
      );

      withProductionCleanup(result, () => {
        assert(result.status !== 0, "code de sortie attendu non nul");

        const journal = result.productionId
          ? readJournal(result.productionId)
          : null;

        assert(
          !journal || journal.entries.length === 0,
          "aucune réservation ne doit être enregistrée : le budget est vérifié avant tout appel"
        );
        assert(
          /Budget d'appels réels insuffisant/.test(result.stderr),
          `message de budget attendu absent : ${result.stderr}`
        );

        const voiceDir = path.join(mediaDir, "voice");
        const voiceFiles = fs.existsSync(voiceDir)
          ? fs.readdirSync(voiceDir)
          : [];

        assert(
          voiceFiles.length === 0,
          "aucun fichier audio ne doit être écrit pour aucune des deux unités"
        );
      });
    });
  }
);

// ---------------------------------------------------------------------

console.log(`\n${passed} PASS, ${failed} FAIL, ${skipped} SKIP`);
process.exit(failed > 0 ? 1 : 0);
