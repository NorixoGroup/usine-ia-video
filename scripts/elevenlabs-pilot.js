// Pilote technique ElevenLabs — AA-Z.
//
// Objectif : exercer le VRAI provider ElevenLabs (src/services/
// elevenlabs-narration-provider.js), le VRAI call-guard narration
// (src/services/call-guard.js) et le VRAI service de persistance
// (src/services/narration-provider.js), pour une seule unité de
// démonstration synthétique ("s01-g01"), totalement indépendant du
// pipeline documentaire : aucun import de src/orchestrator/mvp.js (qui
// exécute des effets de bord dès son chargement), aucun Research, Truth,
// Script, Visual Director, Asset, Assembly ni rendu.
//
// MODE SIMULATION PAR DÉFAUT, TOUJOURS. Le mode réel exige TOUTES les
// conditions suivantes, qui n'ont volontairement jamais lieu dans ce
// dépôt aujourd'hui :
//   - le drapeau CLI --real ;
//   - ELEVENLABS_PILOT_REAL_CALLS_ACK=1 (signal dédié à ce pilote,
//     distinct de PIPELINE_REAL_CALLS_ACK et jamais défini ici) ;
//   - PIPELINE_REAL_CALLS_ACK=1 (accusé générique du call-guard réel) ;
//   - NO_API différent de "1" ;
//   - ELEVENLABS_API_KEY non vide.
// Sans TOUTES ces conditions, le pilote reste en simulation : aucun
// réseau, aucune clé lue, aucun euro dépensé.
//
// Usage (simulation uniquement, ce qui est démontré dans cette mission) :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js \
//     scripts/elevenlabs-pilot.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateAudio } from "./local-media-fixtures.js";
import { ensureNarrationAudio } from "../src/services/narration-provider.js";
import {
  configureCallGuard,
  resetCallGuard,
  createRealNarrationCallGuard
} from "../src/services/call-guard.js";
import { createElevenLabsNarrationProvider } from "../src/services/elevenlabs-narration-provider.js";

// Unité de démonstration unique : texte explicitement synthétique, sans
// aucune revendication factuelle sur l'Australie ni sur aucun sujet réel.
export const DEMO_UNIT = Object.freeze({
  unitId: "s01-g01",
  text:
    "Ceci est un texte de démonstration technique, entièrement " +
    "synthétique. Il ne décrit aucun fait réel et n'a aucun rapport " +
    "avec le documentaire sur l'Australie.",
  estimatedSeconds: 3
});

const REAL_FLAG = "--real";
const REAL_PILOT_ACK_ENV = "ELEVENLABS_PILOT_REAL_CALLS_ACK";
const REAL_CALLS_ACK_ENV = "PIPELINE_REAL_CALLS_ACK";

// Plafond strict, non paramétrable par l'appelant : un appel maximum,
// quel que soit le mode.
const STRICT_CAP = 1;

// Même configuration provider que la production (config/pipeline.json
// → providers.voice), recopiée ici en dur pour ne dépendre d'aucune
// lecture de fichier : ce pilote est volontairement indépendant du
// pipeline documentaire et de sa configuration.
const REAL_PROVIDER_CONFIG = Object.freeze({
  modelId: "eleven_multilingual_v2",
  voiceId: "UBXZKOKbt62aLQHhc1Jm",
  outputFormat: "mp3_44100_128",
  timeoutMs: 30000
});

// Décision d'autorisation réelle — pure, aucun effet de bord, aucune
// lecture de clé au-delà de tester sa présence (jamais sa valeur).
export function evaluateRealModeAuthorization({ argv = [], env = process.env } = {}) {
  if (!argv.includes(REAL_FLAG)) {
    return { authorized: false, reason: `drapeau ${REAL_FLAG} absent` };
  }

  if (env.NO_API === "1") {
    return { authorized: false, reason: "NO_API=1 — coupe-circuit actif" };
  }

  if (env[REAL_PILOT_ACK_ENV] !== "1") {
    return {
      authorized: false,
      reason: `${REAL_PILOT_ACK_ENV}=1 requis (non fourni)`
    };
  }

  if (env[REAL_CALLS_ACK_ENV] !== "1") {
    return {
      authorized: false,
      reason: `${REAL_CALLS_ACK_ENV}=1 requis (non fourni)`
    };
  }

  if (!env.ELEVENLABS_API_KEY) {
    return { authorized: false, reason: "ELEVENLABS_API_KEY absente" };
  }

  return { authorized: true, reason: "toutes les conditions réunies" };
}

// Provider de simulation : FFmpeg local uniquement (fixture déjà utilisée
// par scripts/narration-provider-smoke.js et scripts/
// narration-unit-selection-smoke.js), zéro réseau, zéro clé. Les octets
// sont réellement encodés (libmp3lame, bitexact) : un MP3 décodable, pas
// un buffer arbitraire présenté comme tel.
export function createSimulationProvider({ bytes, fail = false } = {}) {
  const calls = [];

  return {
    kind: "simulation:elevenlabs-pilot",
    calls,
    async generate({ unitId, text, estimatedSeconds }) {
      calls.push({ unitId, text, estimatedSeconds });

      if (fail) {
        throw new Error("échec simulé du provider (pilote ElevenLabs)");
      }

      return { bytes, extension: ".mp3" };
    }
  };
}

export function buildSimulationBytes(outputDir) {
  const file = path.join(outputDir, ".pilot-source.mp3");
  generateAudio(file, { seconds: DEMO_UNIT.estimatedSeconds });
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  return bytes;
}

// Autorise temporairement les appels réels EN MÉMOIRE pour le vrai
// call-guard (NO_API désactivé, accusé posé le temps de l'appel), puis
// restaure l'environnement et réinitialise le call-guard. En simulation,
// aucun transport n'est jamais invoqué par le provider ; en mode réel
// (jamais exercé dans cette mission), c'est la condition que le vrai
// call-guard impose de toute façon avant tout appel réel.
async function withCallGuardAuthorized(fn) {
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

// Exécution unique du pilote : une unité, un appel maximum. `provider`
// est injectable (tests) ; par défaut, simulation FFmpeg locale.
// `outputDir` doit être un dossier isolé, créé par l'appelant, jamais
// projects/<production réelle>.
export async function runElevenLabsPilot({
  outputDir,
  provider,
  argv = process.argv.slice(2),
  env = process.env
} = {}) {
  if (typeof outputDir !== "string" || outputDir.length === 0) {
    throw new Error("Pilote ElevenLabs : outputDir obligatoire.");
  }

  const authorization = evaluateRealModeAuthorization({ argv, env });
  const mode = authorization.authorized ? "real" : "simulation";

  const resolvedProvider =
    provider ??
    (mode === "real"
      ? createElevenLabsNarrationProvider()
      : createSimulationProvider({ bytes: buildSimulationBytes(outputDir) }));

  let localAudio;

  await withCallGuardAuthorized(async () => {
    configureCallGuard({ productionDir: outputDir, cap: STRICT_CAP });
    localAudio = await ensureNarrationAudio({
      mediaDir: outputDir,
      units: [DEMO_UNIT],
      provider: resolvedProvider,
      providerConfig: REAL_PROVIDER_CONFIG,
      callGuard: createRealNarrationCallGuard()
    });
  });

  return {
    mode,
    authorization,
    provider: resolvedProvider,
    localAudio
  };
}

const isDirectInvocation =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectInvocation) {
  const networkGuardActive = Boolean(globalThis.__fixtureNetworkGuard);
  const argv = process.argv.slice(2);
  const authorization = evaluateRealModeAuthorization({ argv });

  // Défense en profondeur : en simulation (le seul mode jamais exercé
  // dans cette mission), le garde réseau est obligatoire — ce pilote
  // bascule temporairement NO_API en mémoire pour le vrai call-guard, et
  // le garde réseau garantit qu'aucun transport n'est physiquement
  // possible pendant cette fenêtre, quel que soit le provider résolu.
  if (!authorization.authorized && !networkGuardActive) {
    console.error(
      "Pilote ElevenLabs (simulation) : lancer avec " +
      "--import ./scripts/fixture-network-guard.js (défense en profondeur obligatoire)."
    );
    process.exit(1);
  }

  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "elevenlabs-pilot-")
  );

  try {
    console.log(`Pilote ElevenLabs — mode : ${authorization.authorized ? "RÉEL" : "SIMULATION"}`);
    console.log(`Autorisation réelle : ${authorization.authorized} (${authorization.reason})`);
    console.log(`Dossier de sortie isolé : ${outputDir}`);

    const result = await runElevenLabsPilot({ outputDir, argv });

    console.log(`Unité traitée : ${DEMO_UNIT.unitId}`);
    console.log(`Appels provider : ${result.provider.calls.length}`);
    console.log(`Fichier : ${path.join(outputDir, "voice", `${DEMO_UNIT.unitId}.mp3`)}`);
    console.log(`Journal : ${path.join(outputDir, "calls.json")}`);
    process.exit(0);
  } catch (error) {
    console.error(`Pilote ElevenLabs — échec : ${error.message}`);
    console.error(`Dossier conservé pour inspection : ${outputDir}`);
    process.exit(1);
  }
}
