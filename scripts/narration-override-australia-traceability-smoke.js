// Smoke de traçabilité documentaire — JSON éditorial approuvé Australie
// EP01 / s01-g01 (narration/approved/australia-ep01-s01-g01.json).
//
// Distingue explicitement :
// - les tests AUTONOMES, qui ne dépendent que du JSON déjà créé localement
//   dans ce dépôt (toujours exécutables, y compris sur une autre machine) ;
// - les tests DÉPENDANTS DE LA SOURCE, qui comparent le JSON au document
//   Master Script original situé hors de ce dépôt. S'il est absent (autre
//   environnement), ces tests sont annoncés SKIP, jamais une tentative de
//   récupération réseau ni une invention de contenu de substitution.
//
// Zéro réseau, zéro clé réelle, zéro appel.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/narration-override-australia-traceability-smoke.js

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { networkGuard } from "./fixture-network-guard.js";
import { generateImage, generateVideo, createMediaFixtureRoot, removeMediaFixtureRoot } from "./local-media-fixtures.js";
import {
  loadNarrationOverride,
  NARRATION_OVERRIDE_MAX_TEXT_LENGTH
} from "../src/utils/narration-override.js";
import { JOURNAL_FILE } from "../src/services/call-guard.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_PATH = path.join(ROOT, "narration/approved/australia-ep01-s01-g01.json");
const SOURCE_SCRIPT_PATH =
  "/Users/mac/Desktop/Les-Decouvertes-du-Nomade/EP01-Australie/01_MASTER_SCRIPT/MASTER_SCRIPT_V2.1_Australie.txt";
const PROJECTS = path.join(ROOT, "projects");

const EXPECTED_SHA256 =
  "92b3f3a82045f0d00aa37cfb250f424320ef77a7f8cea5d0a4fae6c7454ed881";
const EXPECTED_CODE_POINTS = 2089;
const EXPECTED_WORDS = 324;

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP — ${name}`);
  console.log(`       ${reason}`);
}

// =======================================================================
// Tests AUTONOMES — dépendent uniquement du JSON déjà créé dans ce dépôt.
// =======================================================================

await test("1. Le fichier JSON existe et se parse correctement", () => {
  assert(fs.existsSync(JSON_PATH), `absent : ${JSON_PATH}`);
  const raw = fs.readFileSync(JSON_PATH, "utf8");
  const parsed = JSON.parse(raw);
  assert(parsed && typeof parsed === "object", "JSON racine invalide");
});

await test("2. loadNarrationOverride() accepte le fichier", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(override && typeof override === "object", "chargement refusé");
});

await test("3. unit_id === \"s01-g01\"", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(override.unitId === "s01-g01", override.unitId);
});

await test("4. character_count === 2089", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(override.characterCount === EXPECTED_CODE_POINTS, override.characterCount);
});

await test("5. Nombre de mots du texte chargé === 324", () => {
  const override = loadNarrationOverride(JSON_PATH);
  const words = override.text.split(/\s+/).filter(Boolean).length;
  assert(words === EXPECTED_WORDS, words);
});

await test("7. Les retours à la ligne internes sont conservés (simples et doubles)", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(/\n\n/.test(override.text), "aucun double retour à la ligne trouvé");
  assert(/[^\n]\n[^\n]/.test(override.text), "aucun retour à la ligne simple isolé trouvé");
});

await test("8. Le SHA-256 déclaré correspond exactement au texte chargé", () => {
  const override = loadNarrationOverride(JSON_PATH);
  const recomputed = crypto.createHash("sha256").update(override.text, "utf8").digest("hex");
  assert(recomputed === override.textSha256, `${recomputed} !== ${override.textSha256}`);
});

await test("9. Le SHA-256 correspond à l'empreinte de référence complète de l'audit précédent", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(
    override.textSha256 === EXPECTED_SHA256,
    `${override.textSha256} !== ${EXPECTED_SHA256}`
  );
});

await test("10. Le texte ne contient aucun titre ni horodatage structurel", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(!override.text.includes("00:00"), "marqueur 00:00 résiduel");
  assert(!override.text.includes("02:00"), "marqueur 02:00 résiduel");
  assert(!/\bHOOK\b/.test(override.text), "étiquette HOOK résiduelle");
});

await test("11. Le modèle et la voix correspondent à config/pipeline.json", () => {
  const pipelineConfig = JSON.parse(
    fs.readFileSync(path.join(ROOT, "config/pipeline.json"), "utf8")
  );
  const configuredVoice = pipelineConfig.providers.voice;
  const override = loadNarrationOverride(JSON_PATH);
  assert(override.voice.modelId === configuredVoice.model_id, override.voice.modelId);
  assert(override.voice.voiceId === configuredVoice.voice_id, override.voice.voiceId);
});

await test("12. Le plafond local de 2500 caractères est respecté", () => {
  const override = loadNarrationOverride(JSON_PATH);
  assert(override.characterCount <= NARRATION_OVERRIDE_MAX_TEXT_LENGTH, override.characterCount);
  assert(NARRATION_OVERRIDE_MAX_TEXT_LENGTH === 2500, NARRATION_OVERRIDE_MAX_TEXT_LENGTH);
});

// =======================================================================
// Test DÉPENDANT DE LA SOURCE — comparaison au document Master Script
// original. SKIP explicite si absent (autre environnement), jamais de
// récupération réseau ni de contenu de substitution inventé.
// =======================================================================

if (!fs.existsSync(SOURCE_SCRIPT_PATH)) {
  skip(
    "6. Le texte chargé est strictement identique à l'extraction de la source",
    `document source absent sur cet environnement (${SOURCE_SCRIPT_PATH}) — ` +
    "aucune récupération réseau tentée, aucun contenu de substitution utilisé."
  );
} else {
  await test("6. Le texte chargé est strictement identique à l'extraction de la source", () => {
    const raw = fs.readFileSync(SOURCE_SCRIPT_PATH, "utf8");
    const startMarker = "00:00 — HOOK";
    const endMarker = "02:00 — UN CONTINENT, QUELQUES MÉTROPOLES";
    assert(raw.split(startMarker).length - 1 === 1, "délimiteur de début non unique");
    assert(raw.split(endMarker).length - 1 === 1, "délimiteur de fin non unique");

    const startIdx = raw.indexOf(startMarker);
    const endIdx = raw.indexOf(endMarker);
    const extracted = raw
      .slice(startIdx + startMarker.length, endIdx)
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");

    const override = loadNarrationOverride(JSON_PATH);
    assert(override.text === extracted, "le texte du JSON diffère de l'extraction fraîche de la source");
  });
}

// =======================================================================
// 13. Aucun autre segment de narration n'est modifié — vérifié par une
// exécution orchestrateur réelle (fixtures, zéro réseau) avec ce JSON
// précis, jusqu'à l'échec contrôlé de clé ElevenLabs.
// =======================================================================

function prepareAssetsOnlyMediaDir(root) {
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

function listProductions() {
  return fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).sort() : [];
}

function removeProduction(productionId) {
  if (productionId) fs.rmSync(path.join(PROJECTS, productionId), { recursive: true, force: true });
}

await test(
  "13. Exécution réelle (fixtures) avec le JSON Australie : seule s01-g01 change, échec contrôlé de clé",
  () => {
    const fixtureRoot = createMediaFixtureRoot();
    const mediaDir = prepareAssetsOnlyMediaDir(path.join(fixtureRoot, "media"));

    const before = listProductions();
    const child = spawnSync(
      process.execPath,
      [
        "src/orchestrator/mvp.js",
        "--research-script",
        "--mode=full",
        "--real-narration",
        `--media-dir=${mediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01",
        `--narration-override=${JSON_PATH}`
      ],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          PIPELINE_REAL_CALLS_ACK: "1",
          ANTHROPIC_FIXTURES: "1",
          ANTHROPIC_FIXTURE_SCENARIO: "happy",
          ANTHROPIC_FIXTURE_WEB_SEARCH_STUB: "1",
          ELEVENLABS_API_KEY: "",
          ...NETWORK_ISOLATION_ENV
        },
        encoding: "utf8"
      }
    );
    const after = listProductions();
    const productionId = after.find((name) => !before.includes(name));

    try {
      assert(productionId, `aucune production créée : ${child.stderr}`);
      assert(/secret API absent/.test(child.stderr), `échec clé attendu : ${child.stderr}`);

      const script = JSON.parse(
        fs.readFileSync(path.join(PROJECTS, productionId, "script.json"), "utf8")
      );
      const override = loadNarrationOverride(JSON_PATH);
      const [s1g1, s1g2] = script.data.sections[0].segments;
      const [s2g1, s2g2] = script.data.sections[1].segments;

      assert(s1g1.voiceover === override.text, "s01-g01 n'a pas reçu le texte approuvé");
      assert(script.data.hook === override.text, "le champ hook n'est pas synchronisé");
      assert(s1g2.voiceover !== override.text, "s01-g02 a été altérée");
      assert(s2g1.voiceover !== override.text, "s02-g01 a été altérée");
      assert(s2g2.voiceover !== override.text, "s02-g02 a été altérée");

      const journalPath = path.join(PROJECTS, productionId, JOURNAL_FILE);
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      assert(journal.entries.length === 1 && journal.entries[0].status === "failed", JSON.stringify(journal.entries));

      const voiceDir = path.join(mediaDir, "voice");
      const voiceFiles = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
      assert(voiceFiles.length === 0, "aucun fichier audio ne doit être écrit");
    } finally {
      removeProduction(productionId);
      removeMediaFixtureRoot(fixtureRoot);
    }
  }
);

console.log(`\n${passed} PASS, ${failed} FAIL, ${skipped} SKIP`);
assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log("NETWORK ATTEMPTS = 0");
process.exit(failed > 0 ? 1 : 0);
