// Smoke isolé (AA-W) — sélecteur --narration-unit (module pur), vrai
// call-guard narration (plafond, journal, idempotence, échec contrôlé) et
// persistance MP3 après échec partiel.
//
// Aucun pipeline complet : zéro Research/Truth/Script/Visual Director/
// Asset réel, zéro réseau, zéro clé, zéro ElevenLabs. Le plan de narration
// est synthétique (scripts/canonical-artifacts.js, déjà utilisé par
// scripts/narration-provider-smoke.js). Le provider est un fake local; le
// call-guard est le vrai module de production (src/services/call-guard.js),
// autorisé temporairement en mémoire (NO_API désactivé le temps de l'appel,
// toujours sous garde réseau — aucun transport n'est physiquement possible).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/narration-unit-selection-smoke.js

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { networkGuard } from "./fixture-network-guard.js";
import {
  createMediaFixtureRoot,
  generateAudio,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";
import { buildScript, buildTarget, buildArtifacts } from "./canonical-artifacts.js";

import { buildNarrationPlan, runVoiceAgent } from "../src/agents/voice.js";
import { runAssemblyAgent } from "../src/agents/assembly.js";
import { selectNarrationUnits } from "../src/utils/narration-unit-selector.js";
import { ensureNarrationAudio } from "../src/services/narration-provider.js";
import { inspectLocalVoice } from "../src/media/local-media.js";
import {
  JOURNAL_FILE,
  REAL_CALLS_ACK_ENV,
  configureCallGuard,
  resetCallGuard,
  createRealNarrationCallGuard
} from "../src/services/call-guard.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

const plan = buildNarrationPlan(buildScript());

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

// Autorise temporairement les appels réels EN MÉMOIRE pour le vrai
// call-guard (NO_API désactivé le temps de l'appel) : le garde réseau
// importé en tête de processus reste actif tout du long et bloquerait
// toute tentative de transport réel, fixture ou pas.
async function withRealCallsAuthorized(fn) {
  const previousNoApi = process.env.NO_API;
  const previousAck = process.env[REAL_CALLS_ACK_ENV];

  delete process.env.NO_API;
  process.env[REAL_CALLS_ACK_ENV] = "1";

  try {
    return await fn();
  } finally {
    if (previousNoApi === undefined) delete process.env.NO_API;
    else process.env.NO_API = previousNoApi;

    if (previousAck === undefined) delete process.env[REAL_CALLS_ACK_ENV];
    else process.env[REAL_CALLS_ACK_ENV] = previousAck;

    resetCallGuard();
  }
}

function media(root, name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function readJournal(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8"));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fakeProvider({ bytes, failUnitIds = [] } = {}) {
  const calls = [];
  return {
    kind: "fixture:narration-unit-selection",
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

const root = createMediaFixtureRoot();

// Octets MP3 réellement encodés par FFmpeg — fixture locale déjà utilisée
// par scripts/narration-provider-smoke.js (generateAudio). Un seul
// encodage, réutilisé par chaque appel réussi du fake provider : aucune
// synthèse facturable, aucun réseau. Ce fichier est un MP3 décodable
// (libmp3lame, bitexact) — pas un buffer arbitraire présenté comme tel.
function buildSourceMp3() {
  const file = path.join(root, "provider-source.mp3");
  generateAudio(file, { seconds: 0.2 });
  return fs.readFileSync(file);
}

const sourceBytes = buildSourceMp3();

// ---------------------------------------------------------------------
// 1-3. Sélection pure (src/utils/narration-unit-selector.js) — zéro I/O.
// ---------------------------------------------------------------------

await test("1. Sélection exacte de s01-g01", () => {
  const selected = selectNarrationUnits(plan, "s01-g01");
  assert(selected.length === 1, `longueur=${selected.length}`);
  assert(selected[0].unitId === "s01-g01", selected[0].unitId);
});

await test("2. Unité inconnue : rejet avant tout appel", () => {
  let error;
  try { selectNarrationUnits(plan, "s99-g99"); } catch (caught) { error = caught; }
  assert(error, "échec attendu");
  assert(/introuvable dans le plan de narration/.test(error.message), error.message);
});

await test("3. Aucune sélection implicite d'une autre unité", () => {
  const selected = selectNarrationUnits(plan, "s01-g01");
  assert(!selected.some(unit => unit.unitId === "s02-g01"), "s02-g01 ne doit jamais apparaître");
});

await test("sans sélection : plan complet inchangé (non-régression)", () => {
  assert(selectNarrationUnits(plan, undefined) === plan, "le plan complet doit être retourné tel quel");
});

// ---------------------------------------------------------------------
// 4-9. Vrai call-guard narration (R16/R17, src/services/call-guard.js) +
// ensureNarrationAudio, fake provider local.
// ---------------------------------------------------------------------

await test("4. Aucun appel provider pour s02-g01 (unité exclue)", async () => {
  const directory = media(root, "select-only");
  const fake = fakeProvider({ bytes: sourceBytes });
  const selected = selectNarrationUnits(plan, "s01-g01");

  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await ensureNarrationAudio({
      mediaDir: directory,
      units: selected,
      provider: fake,
      callGuard: createRealNarrationCallGuard()
    });
  });

  assert(fake.calls.length === 1, `appels=${fake.calls.length}`);
  assert(fake.calls[0].unitId === "s01-g01", fake.calls[0].unitId);
  assert(!fake.calls.some(call => call.unitId === "s02-g01"), "s02-g01 n'a jamais dû être appelé");
});

await test("5. Plafond d'un appel : deux unités manquantes, cap=1 → refus avant tout appel", async () => {
  const directory = media(root, "cap-one");
  const fake = fakeProvider({ bytes: sourceBytes });

  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await expectReject(
      () => ensureNarrationAudio({
        mediaDir: directory,
        units: plan,
        provider: fake,
        callGuard: createRealNarrationCallGuard()
      }),
      /Budget d'appels réels insuffisant/
    );
  });

  assert(fake.calls.length === 0, `provider appelé malgré le plafond : ${fake.calls.length}`);
  assert(!fs.existsSync(path.join(directory, JOURNAL_FILE)), "aucun journal ne doit être écrit");
});

await test("6. Journal réel du call-guard : réservation puis succès", async () => {
  const directory = media(root, "journal-success");
  const fake = fakeProvider({ bytes: sourceBytes });
  const selected = selectNarrationUnits(plan, "s01-g01");

  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await ensureNarrationAudio({
      mediaDir: directory,
      units: selected,
      provider: fake,
      callGuard: createRealNarrationCallGuard()
    });
  });

  const journal = readJournal(directory);
  assert(journal.entries.length === 1, `entrées=${journal.entries.length}`);
  const [entry] = journal.entries;
  assert(entry.status === "succeeded", entry.status);
  assert(entry.unit_id === "s01-g01", entry.unit_id);
  assert(entry.provider_kind === "fixture:narration-unit-selection", entry.provider_kind);
  assert(entry.path === "voice/s01-g01.mp3", entry.path);
  assert(/^[0-9a-f]{64}$/.test(entry.sha256), entry.sha256);
  assert(Number.isInteger(entry.size_bytes) && entry.size_bytes > 0, entry.size_bytes);
});

await test("7. Aucun retry automatique après échec provider", async () => {
  const directory = media(root, "no-retry");
  const fake = fakeProvider({ failUnitIds: ["s01-g01"] });
  const selected = selectNarrationUnits(plan, "s01-g01");

  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await expectReject(
      () => ensureNarrationAudio({
        mediaDir: directory,
        units: selected,
        provider: fake,
        callGuard: createRealNarrationCallGuard()
      }),
      /échec provider simulé/
    );
  });

  assert(fake.calls.length === 1, `appels=${fake.calls.length} (retry suspecté)`);
  const journal = readJournal(directory);
  assert(journal.entries.length === 1 && journal.entries[0].status === "failed", JSON.stringify(journal.entries));
});

await test("8. Idempotence : unité déjà synthétisée, provider jamais réinvoqué", async () => {
  const directory = media(root, "idempotent");
  const selected = selectNarrationUnits(plan, "s01-g01");

  const fakeFirst = fakeProvider({ bytes: sourceBytes });
  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await ensureNarrationAudio({
      mediaDir: directory,
      units: selected,
      provider: fakeFirst,
      callGuard: createRealNarrationCallGuard()
    });
  });
  assert(fakeFirst.calls.length === 1, "premier appel attendu");

  const fakeSecond = fakeProvider({ bytes: sourceBytes });
  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await ensureNarrationAudio({
      mediaDir: directory,
      units: selected,
      provider: fakeSecond,
      callGuard: createRealNarrationCallGuard()
    });
  });

  assert(fakeSecond.calls.length === 0, `reprise a réinvoqué le provider : ${fakeSecond.calls.length}`);
  const journal = readJournal(directory);
  assert(journal.entries.length === 1, `une reprise ne doit ajouter aucune entrée : ${journal.entries.length}`);
});

await test("9. Échec contrôlé du provider : fail closed, aucun fichier final", async () => {
  const directory = media(root, "provider-failure");
  const fake = fakeProvider({ failUnitIds: ["s01-g01"] });
  const selected = selectNarrationUnits(plan, "s01-g01");

  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await expectReject(
      () => ensureNarrationAudio({
        mediaDir: directory,
        units: selected,
        provider: fake,
        callGuard: createRealNarrationCallGuard()
      }),
      /échec provider simulé/
    );
  });

  const voiceDir = path.join(directory, "voice");
  const files = fs.existsSync(voiceDir) ? fs.readdirSync(voiceDir) : [];
  assert(files.length === 0, `fichier résiduel : ${files.join(", ")}`);
});

// ---------------------------------------------------------------------
// 10-11. Jamais de faux Voice/Assembly "completed" sous synthèse partielle.
// ---------------------------------------------------------------------

await test("10. Voice Gate : synthèse partielle refusée, jamais 'completed'", async () => {
  const directory = media(root, "voice-partial");
  const fake = fakeProvider({ bytes: sourceBytes });
  const selected = selectNarrationUnits(plan, "s01-g01");

  await withRealCallsAuthorized(async () => {
    configureCallGuard({ productionDir: directory, cap: 1 });
    await ensureNarrationAudio({
      mediaDir: directory,
      units: selected,
      provider: fake,
      callGuard: createRealNarrationCallGuard()
    });
  });

  const localAudio = await inspectLocalVoice({ mediaDir: directory });
  assert(Object.keys(localAudio).length === 1, "une seule unité doit être synthétisée");

  await expectReject(
    () => runVoiceAgent({ script: buildScript(), testMode: true, localAudio }),
    /audio local manquant pour s02-g01/
  );
});

await test("11. Assembly : manifeste Voice à synthèse partielle refusé", async () => {
  const artifacts = await buildArtifacts({ mode: "test" });

  const partialVoice = structuredClone(artifacts.voice.data);
  const [firstUnit] = partialVoice.narration_units;
  firstUnit.status = "synthesized_local";
  firstUnit.audio = {
    path: `voice/${firstUnit.unit_id}.mp3`,
    sha256: "a".repeat(64),
    size_bytes: 10,
    duration_seconds: 1
  };
  // Les autres unités restent "unsynthesized" : synthèse partielle.

  await expectReject(
    () => runAssemblyAgent({
      assets: artifacts.assets.data,
      voice: partialVoice,
      target: buildTarget().video,
      testMode: true
    }),
    /synthèse partielle interdite/
  );
});

// ---------------------------------------------------------------------
// Phase 4 — Persistance critique : succès réel + échec sur l'autre unité,
// intégrité du fichier réussi, journal des deux événements, reprise sans
// refacturation de l'unité déjà réussie.
// ---------------------------------------------------------------------

await test(
  "Phase 4 — succès réel (hash/taille) puis échec sur l'autre unité : fichier intact, journal complet, " +
  "retentative identique refusée (R30), reprise avec texte corrigé sans refacturation de l'unité déjà réussie",
  async () => {
    const directory = media(root, "phase4-mixed");
    const mixed = fakeProvider({ bytes: sourceBytes, failUnitIds: ["s02-g01"] });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: directory, cap: 2 });
      await expectReject(
        () => ensureNarrationAudio({
          mediaDir: directory,
          units: plan,
          provider: mixed,
          callGuard: createRealNarrationCallGuard()
        }),
        /échec provider simulé pour s02-g01/
      );
    });

    assert(mixed.calls.length === 2, `appels=${mixed.calls.length}`);
    assert(mixed.calls[0].unitId === "s01-g01" && mixed.calls[1].unitId === "s02-g01", "ordre inattendu");

    const voiceDir = path.join(directory, "voice");
    assert(fs.existsSync(path.join(voiceDir, "s01-g01.mp3")), "fichier réussi absent");
    assert(!fs.existsSync(path.join(voiceDir, "s02-g01.mp3")), "fichier en échec présent");
    assert(fs.readdirSync(voiceDir).length === 1, "un seul fichier final attendu");

    const hashAfterFailure = sha256File(path.join(voiceDir, "s01-g01.mp3"));

    let journal = readJournal(directory);
    assert(journal.entries.length === 2, `entrées=${journal.entries.length}`);
    assert(
      journal.entries[0].unit_id === "s01-g01" && journal.entries[0].status === "succeeded",
      JSON.stringify(journal.entries[0])
    );
    assert(
      journal.entries[1].unit_id === "s02-g01" && journal.entries[1].status === "failed",
      JSON.stringify(journal.entries[1])
    );
    assert(hashAfterFailure === journal.entries[0].sha256, "le fichier réussi ne doit pas avoir changé");

    // Contrat R30 : une requête déjà échouée (statut "failed") ne peut
    // plus être rejouée automatiquement à l'identique — une facturation
    // réelle reste possible malgré l'absence de résultat local. La
    // reprise avec le plan inchangé doit donc être refusée fermé, sans
    // jamais ré-appeler le provider, pour s02-g01.
    const identicalRetryProvider = fakeProvider({ bytes: sourceBytes });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: directory, cap: 1 });
      await expectReject(
        () => ensureNarrationAudio({
          mediaDir: directory,
          units: plan,
          provider: identicalRetryProvider,
          callGuard: createRealNarrationCallGuard()
        }),
        /Nouvelle tentative narration refusée/
      );
    });

    assert(
      identicalRetryProvider.calls.length === 0,
      `une requête identique après échec ne doit déclencher aucun appel : ${identicalRetryProvider.calls.length}`
    );

    journal = readJournal(directory);
    assert(
      journal.entries.length === 2,
      `le refus fermé ne doit ajouter aucune entrée au journal : ${journal.entries.length}`
    );

    // Reprise légitime : après correction (texte modifié pour s02-g01 —
    // seule l'identité de requête change, pas l'unité), la requête n'est
    // plus "la même" et peut être retentée. s01-g01 reste réutilisé sans
    // appel, par son propre mécanisme de vérification d'identité.
    const correctedPlan = plan.map((unit) =>
      unit.unitId === "s02-g01"
        ? { ...unit, text: `${unit.text} (texte corrigé après investigation du premier échec).` }
        : unit
    );
    const resumeProvider = fakeProvider({ bytes: sourceBytes });

    await withRealCallsAuthorized(async () => {
      configureCallGuard({ productionDir: directory, cap: 1 });
      await ensureNarrationAudio({
        mediaDir: directory,
        units: correctedPlan,
        provider: resumeProvider,
        callGuard: createRealNarrationCallGuard()
      });
    });

    assert(resumeProvider.calls.length === 1, `reprise a appelé le provider ${resumeProvider.calls.length} fois`);
    assert(resumeProvider.calls[0].unitId === "s02-g01", "la reprise devait ne traiter que s02-g01");
    assert(
      sha256File(path.join(voiceDir, "s01-g01.mp3")) === hashAfterFailure,
      "le fichier déjà réussi a été modifié par la reprise"
    );

    journal = readJournal(directory);
    assert(journal.entries.length === 3, `entrées après reprise=${journal.entries.length}`);
    assert(
      journal.entries[0].status === "succeeded" && journal.entries[0].sha256 === hashAfterFailure,
      "l'entrée d'origine de s01-g01 ne doit pas être réécrite"
    );
    assert(journal.entries[2].unit_id === "s02-g01" && journal.entries[2].status === "succeeded", JSON.stringify(journal.entries[2]));
  }
);

// Limites explicites, non démontrées par ce smoke (à documenter dans le
// rapport, jamais à présenter comme couvertes) :
// - validité MP3 au-delà de ce que FFmpeg/ffprobe vérifient ici (décodage
//   bit-exact par un lecteur tiers, tags ID3, etc.) ;
// - durée réelle d'une narration de production (ici 0.2 s fixe, pas la
//   durée mesurée d'une vraie synthèse) ;
// - coupure de processus entre la réponse du provider et l'écriture
//   disque (persistGeneratedAudio est atomique par construction — lien
//   puis suppression du temporaire — mais ce smoke ne simule pas un kill
//   -9 au milieu) ;
// - tout comportement du vrai réseau HTTP d'ElevenLabs (le provider réel
//   n'est jamais instancié ici).

removeMediaFixtureRoot(root);
console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
