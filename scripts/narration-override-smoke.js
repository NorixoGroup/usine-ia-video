// Smoke du remplacement local de narration (--narration-override, s01-g01
// uniquement) : chargement/validation du fichier JSON, vérification de
// réutilisation d'un MP3 existant, et injection de bout en bout via
// l'orchestrateur. Zéro réseau, zéro clé réelle, zéro appel ElevenLabs.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/narration-override-smoke.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { networkGuard } from "./fixture-network-guard.js";
import {
  createMediaFixtureRoot,
  generateAudio,
  generateImage,
  generateVideo,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";

import {
  loadNarrationOverride,
  NARRATION_OVERRIDE_MAX_TEXT_LENGTH
} from "../src/utils/narration-override.js";
import {
  JOURNAL_FILE,
  REAL_CALLS_ACK_ENV,
  configureCallGuard,
  resetCallGuard,
  createRealNarrationCallGuard,
  verifyNarrationReuse
} from "../src/services/call-guard.js";
import { ensureNarrationAudio } from "../src/services/narration-provider.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PROJECTS = path.join(ROOT, "projects");
const TMP = path.join(ROOT, "tmp");

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

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tmpDir(prefix) {
  fs.mkdirSync(TMP, { recursive: true });
  return fs.mkdtempSync(path.join(TMP, prefix));
}

function writeOverrideFile(dir, text, overrides = {}) {
  const file = path.join(dir, "override.json");
  const payload = {
    episode_id: "les-decouvertes-du-nomade-ep01-australie",
    unit_id: "s01-g01",
    text,
    character_count: Array.from(text).length,
    text_sha256: sha256Hex(text),
    source_provenance: "smoke test — extrait fictif",
    editorial_validation: {
      version: "smoke-v1",
      validated_at: "2026-11-01T00:00:00.000Z"
    },
    voice: {
      model_id: "eleven_multilingual_v2",
      voice_id: "UBXZKOKbt62aLQHhc1Jm"
    },
    ...overrides
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

const VALID_TEXT =
  "Ceci est un extrait documentaire validé localement pour le smoke test, " +
  "sans rapport avec un fait réel.";

// ---------------------------------------------------------------------
// 1-8. loadNarrationOverride — chargement et validation du fichier.
// ---------------------------------------------------------------------

await test("1. Chargement valide : champs recalculés corrects", () => {
  const dir = tmpDir("narration-override-ok-");
  try {
    const file = writeOverrideFile(dir, VALID_TEXT);
    const override = loadNarrationOverride(file);
    assert(override.unitId === "s01-g01", override.unitId);
    assert(override.text === VALID_TEXT, "texte altéré par le chargement");
    assert(override.characterCount === Array.from(VALID_TEXT).length, "character_count");
    assert(override.textSha256 === sha256Hex(VALID_TEXT), "text_sha256");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("2. Fichier absent : échec fermé", () => {
  let error;
  try { loadNarrationOverride(path.join(TMP, "n-existe-pas.json")); } catch (caught) { error = caught; }
  assert(error && /introuvable/.test(error.message), error?.message);
});

await test("3. JSON invalide : échec fermé", () => {
  const dir = tmpDir("narration-override-badjson-");
  try {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{ ceci n'est pas du JSON");
    let error;
    try { loadNarrationOverride(file); } catch (caught) { error = caught; }
    assert(error && /JSON invalide/.test(error.message), error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("4. unit_id non autorisé (!= s01-g01) : échec fermé", () => {
  const dir = tmpDir("narration-override-unit-");
  try {
    const file = writeOverrideFile(dir, VALID_TEXT, { unit_id: "s02-g01" });
    let error;
    try { loadNarrationOverride(file); } catch (caught) { error = caught; }
    assert(error && /non autorisé/.test(error.message), error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("5. Texte trop long : échec fermé", () => {
  const dir = tmpDir("narration-override-long-");
  try {
    const longText = "a".repeat(NARRATION_OVERRIDE_MAX_TEXT_LENGTH + 1);
    const file = writeOverrideFile(dir, longText);
    let error;
    try { loadNarrationOverride(file); } catch (caught) { error = caught; }
    assert(error && /trop long/.test(error.message), error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("6. character_count déclaré incohérent : échec fermé", () => {
  const dir = tmpDir("narration-override-count-");
  try {
    const file = writeOverrideFile(dir, VALID_TEXT, { character_count: 1 });
    let error;
    try { loadNarrationOverride(file); } catch (caught) { error = caught; }
    assert(error && /character_count déclaré/.test(error.message), error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("7. text_sha256 déclaré incohérent : échec fermé", () => {
  const dir = tmpDir("narration-override-sha-");
  try {
    const file = writeOverrideFile(dir, VALID_TEXT, { text_sha256: "a".repeat(64) });
    let error;
    try { loadNarrationOverride(file); } catch (caught) { error = caught; }
    assert(error && /text_sha256 déclaré/.test(error.message), error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("8. Métadonnées éditoriales manquantes : échec fermé, jamais inventées", () => {
  const dir = tmpDir("narration-override-meta-");
  try {
    const file = writeOverrideFile(dir, VALID_TEXT, { editorial_validation: undefined });
    let error;
    try { loadNarrationOverride(file); } catch (caught) { error = caught; }
    assert(error && /editorial_validation/.test(error.message), error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 9-13. verifyNarrationReuse (call-guard.js) — identité du MP3 existant.
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

function fakeProvider({ bytes, failUnitIds = [] } = {}) {
  const calls = [];
  return {
    kind: "fixture:narration-override-smoke",
    calls,
    async generate({ unitId, text, estimatedSeconds }) {
      calls.push({ unitId, text, estimatedSeconds });
      if (failUnitIds.includes(unitId)) {
        throw new Error(`échec provider simulé pour ${unitId}`);
      }
      return { bytes, extension: ".mp3" };
    }
  };
}

const mediaRoot = createMediaFixtureRoot();

function buildSourceMp3() {
  const file = path.join(mediaRoot, "override-source.mp3");
  generateAudio(file, { seconds: 0.2 });
  return fs.readFileSync(file);
}
const sourceBytes = buildSourceMp3();

function unitFor(text) {
  return { unitId: "s01-g01", text, estimatedSeconds: 3 };
}

await test("9. verifyNarrationReuse : correspondance exacte → autorisé, réutilisation sans appel", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "override-reuse-ok-"));
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const fake = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("texte A")],
        provider: fake,
        callGuard: createRealNarrationCallGuard()
      });
      assert(fake.calls.length === 1, "premier appel attendu");
    });

    // Deuxième passage (nouveau process simulé par reconfiguration du
    // garde), même texte : doit réutiliser sans appel.
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const second = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("texte A")],
        provider: second,
        callGuard: createRealNarrationCallGuard()
      });
      assert(second.calls.length === 0, `réutilisation attendue sans appel : ${second.calls.length}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("10. Texte différent sur un MP3 existant : rejet avant tout appel", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "override-reuse-mismatch-"));
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const first = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("texte ORIGINAL (fixture)")],
        provider: first,
        callGuard: createRealNarrationCallGuard()
      });
      assert(first.calls.length === 1, "premier appel attendu");
    });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const second = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("texte DIFFÉRENT (override)")],
          provider: second,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) {
        error = caught;
      }
      assert(error && /Réutilisation refusée/.test(error.message), error?.message);
      assert(second.calls.length === 0, `aucun appel ne devait être tenté : ${second.calls.length}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("11. MP3 sans aucune entrée de journal correspondante : rejet", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "override-reuse-orphan-"));
  try {
    fs.mkdirSync(path.join(dir, "voice"), { recursive: true });
    fs.copyFileSync(
      path.join(mediaRoot, "override-source.mp3"),
      path.join(dir, "voice", "s01-g01.mp3")
    );

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("texte quelconque")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) {
        error = caught;
      }
      assert(error && /Réutilisation refusée/.test(error.message), error?.message);
      assert(provider.calls.length === 0, "aucun appel ne devait être tenté");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("12. verifyNarrationReuse : SHA-256 du fichier local altéré après coup → rejet", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "override-reuse-tamper-"));
  try {
    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      await ensureNarrationAudio({
        mediaDir: dir,
        units: [unitFor("texte stable")],
        provider,
        callGuard: createRealNarrationCallGuard()
      });
    });

    // Remplacement du fichier après coup (hors du pipeline) par un autre
    // MP3 valide mais différent : le SHA-256 du fichier ne correspond
    // plus à celui enregistré dans calls.json, tout en restant un MP3
    // décodable (évite un faux négatif dû à un fichier juste corrompu).
    const mp3 = path.join(dir, "voice", "s01-g01.mp3");
    const otherAudioPath = path.join(mediaRoot, "override-source-alt.mp3");
    generateAudio(otherAudioPath, { seconds: 0.2, frequency: 880 });
    fs.copyFileSync(otherAudioPath, mp3);

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: dir, cap: 1 });
      const provider = fakeProvider({ bytes: sourceBytes });
      let error;
      try {
        await ensureNarrationAudio({
          mediaDir: dir,
          units: [unitFor("texte stable")],
          provider,
          callGuard: createRealNarrationCallGuard()
        });
      } catch (caught) {
        error = caught;
      }
      assert(error && /SHA-256/.test(error.message), error?.message);
      assert(provider.calls.length === 0, "aucun appel ne devait être tenté");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("13. verifyNarrationReuse direct : aucune autorisation configurée → échec fermé", () => {
  resetCallGuard();
  let error;
  try {
    verifyNarrationReuse({
      unitId: "s01-g01",
      providerKind: "elevenlabs",
      request: { unit_id: "s01-g01", text: "x" },
      existingRecord: { sha256: "a".repeat(64) }
    });
  } catch (caught) {
    error = caught;
  }
  assert(error && /aucune autorisation configurée/.test(error.message), error?.message);
});

removeMediaFixtureRoot(mediaRoot);

// ---------------------------------------------------------------------
// 14-18. Injection de bout en bout via l'orchestrateur (--narration-override).
// ---------------------------------------------------------------------

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

function listProductions() {
  return fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).sort() : [];
}

function removeProduction(productionId) {
  fs.rmSync(path.join(PROJECTS, productionId), { recursive: true, force: true });
}

const UNROUTABLE_PROXY = "http://127.0.0.1:1";
const NETWORK_ISOLATION_ENV = {
  HTTP_PROXY: UNROUTABLE_PROXY,
  HTTPS_PROXY: UNROUTABLE_PROXY,
  http_proxy: UNROUTABLE_PROXY,
  https_proxy: UNROUTABLE_PROXY,
  NO_PROXY: ""
};

function runOrchestrator(extraArgs, env) {
  const before = listProductions();
  const child = spawnSync(
    process.execPath,
    ["src/orchestrator/mvp.js", "--research-script", ...extraArgs],
    { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" }
  );
  const created = listProductions().filter(name => !before.includes(name));
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, productionId: created[0] ?? null };
}

const overrideFixtureRoot = createMediaFixtureRoot();
const overrideMediaDir = prepareAssetsOnlyMediaDir(path.join(overrideFixtureRoot, "media"));
const OVERRIDE_TEXT =
  "Extrait documentaire validé localement, strictement fictif, pour le smoke test de substitution.";
const overrideFilePath = writeOverrideFile(overrideFixtureRoot, OVERRIDE_TEXT);

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

await test(
  "14. Injection s01-g01 : script.json substitué, hook synchronisé, re-scellé, trace écrite",
  () => {
    const result = runOrchestrator(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${overrideMediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01",
        `--narration-override=${overrideFilePath}`
      ],
      baseEnv()
    );

    try {
      assert(result.productionId !== null, `aucune production créée : ${result.stderr}`);

      const script = JSON.parse(
        fs.readFileSync(path.join(PROJECTS, result.productionId, "script.json"), "utf8")
      );
      const hook = script.data.sections[0].segments[0];

      assert(hook.role === "hook", "le premier segment doit rester le hook");
      assert(hook.voiceover === OVERRIDE_TEXT, "le texte substitué est absent de script.json");
      assert(script.data.hook === OVERRIDE_TEXT, "le champ hook n'est pas synchronisé");

      const overrideTrace = JSON.parse(
        fs.readFileSync(path.join(PROJECTS, result.productionId, "narration-override.json"), "utf8")
      );
      assert(overrideTrace.unit_id === "s01-g01", "trace : unit_id incorrect");
      assert(overrideTrace.text === OVERRIDE_TEXT, "trace : texte incorrect");
      assert(/claims.*grounding|grounding.*claims/i.test(overrideTrace.warning), "avertissement claims/grounding absent");

      const production = JSON.parse(
        fs.readFileSync(path.join(PROJECTS, result.productionId, "production.json"), "utf8")
      );
      assert(
        typeof production.artifact_sha256?.["script.json"] === "string",
        "scellé script.json absent après réécriture"
      );
    } finally {
      if (result.productionId) removeProduction(result.productionId);
    }
  }
);

await test(
  "15. Les trois autres unités conservent leur texte d'origine (fixture)",
  () => {
    const result = runOrchestrator(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${overrideMediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01",
        `--narration-override=${overrideFilePath}`
      ],
      baseEnv()
    );

    try {
      assert(result.productionId !== null, `aucune production créée : ${result.stderr}`);
      const script = JSON.parse(
        fs.readFileSync(path.join(PROJECTS, result.productionId, "script.json"), "utf8")
      );
      const [s1g1, s1g2] = script.data.sections[0].segments;
      const [s2g1, s2g2] = script.data.sections[1].segments;

      assert(s1g1.voiceover === OVERRIDE_TEXT, "s01-g01 doit porter le texte substitué");
      assert(s1g2.voiceover !== OVERRIDE_TEXT && s1g2.voiceover.length > 0, "s01-g02 altérée");
      assert(s2g1.voiceover !== OVERRIDE_TEXT && s2g1.voiceover.length > 0, "s02-g01 altérée");
      assert(s2g2.voiceover !== OVERRIDE_TEXT && s2g2.voiceover.length > 0, "s02-g02 altérée");
      assert(script.data.conclusion === s2g2.voiceover, "conclusion non synchronisée sur s02-g02 d'origine");
    } finally {
      if (result.productionId) removeProduction(result.productionId);
    }
  }
);

await test(
  "16. --narration-override avec --narration-unit != s01-g01 : refus avant tout appel",
  () => {
    const result = runOrchestrator(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${overrideMediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s02-g01",
        `--narration-override=${overrideFilePath}`
      ],
      baseEnv()
    );
    try {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(result.productionId === null, "aucune production ne doit être créée");
      assert(
        /n'est autorisé qu'avec --narration-unit=s01-g01/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
    } finally {
      if (result.productionId) removeProduction(result.productionId);
    }
  }
);

await test(
  "17. --narration-override avec fichier invalide : échec fermé, aucune réservation",
  () => {
    const badFile = path.join(overrideFixtureRoot, "invalid-override.json");
    fs.writeFileSync(badFile, "not json");

    const result = runOrchestrator(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${overrideMediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01",
        `--narration-override=${badFile}`
      ],
      baseEnv()
    );
    try {
      assert(result.status !== 0, "code de sortie attendu non nul");
      assert(
        /JSON invalide/.test(result.stderr),
        `message attendu absent : ${result.stderr}`
      );
      const journal = result.productionId
        ? path.join(PROJECTS, result.productionId, JOURNAL_FILE)
        : null;
      assert(!journal || !fs.existsSync(journal), "aucune réservation ne doit exister");
    } finally {
      if (result.productionId) removeProduction(result.productionId);
    }
  }
);

await test(
  "18. Échec contrôlé ElevenLabs (clé absente) toujours atteint après injection, zéro réseau",
  () => {
    const result = runOrchestrator(
      [
        "--mode=full",
        "--real-narration",
        `--media-dir=${overrideMediaDir}`,
        "--real-calls-cap=1",
        "--narration-unit=s01-g01",
        `--narration-override=${overrideFilePath}`
      ],
      baseEnv()
    );
    try {
      assert(result.productionId !== null, "une production doit être créée");
      assert(/secret API absent/.test(result.stderr), `échec clé attendu : ${result.stderr}`);
      assert(
        !/sk-[A-Za-z0-9_-]+/.test(result.stderr) && !/xi-api-key/i.test(result.stderr),
        "aucun secret ne doit apparaître dans la sortie"
      );

      const journalPath = path.join(PROJECTS, result.productionId, JOURNAL_FILE);
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      assert(journal.entries.length === 1, `exactement une réservation attendue : ${journal.entries.length}`);
      assert(journal.entries[0].unit_id === "s01-g01", journal.entries[0].unit_id);
      assert(journal.entries[0].status === "failed", journal.entries[0].status);

      const voiceDir = path.join(overrideMediaDir, "voice");
      const voiceFiles = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
      assert(voiceFiles.length === 0, "aucun fichier audio ne doit être écrit (clé absente)");

      const production = JSON.parse(
        fs.readFileSync(path.join(PROJECTS, result.productionId, "production.json"), "utf8")
      );
      assert(production.status !== "completed", "la production ne doit jamais être déclarée completed");
      assert(
        !fs.existsSync(path.join(PROJECTS, result.productionId, "assembly.json")),
        "Assembly ne doit jamais être atteint après un échec Voice"
      );
    } finally {
      if (result.productionId) removeProduction(result.productionId);
    }
  }
);

removeMediaFixtureRoot(overrideFixtureRoot);

console.log(`\n${passed} PASS, ${failed} FAIL`);
assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log("NETWORK ATTEMPTS = 0");
process.exit(failed > 0 ? 1 : 0);
