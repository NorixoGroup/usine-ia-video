// Frontière locale pour une narration injectable.
//
// Ce module ne connaît aucun fournisseur réel et ne fait aucun réseau. Le
// fournisseur injecté retourne uniquement des bytes; le service conserve le
// contrôle exclusif du chemin, de l'écriture atomique et de l'inspection.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  VOICE_DIRECTORY,
  inspectLocalVoice,
  inspectLocalVoiceReference,
  resolveMediaRoot
} from "../media/local-media.js";

const EXTENSIONS = new Set([".wav", ".mp3", ".m4a"]);

// Verrou inter-processus dédié au dossier média partagé (R30-B). Distinct
// du verrou de production (src/orchestrator/resume.js, par productionDir) :
// deux productions différentes peuvent pointer vers le même --media-dir,
// et le verrou de production ne les protège pas l'une de l'autre. Même
// primitive atomique (fs.openSync(..., "wx"), O_CREAT|O_EXCL) sur un
// fichier caché (ignoré par listReferences, qui filtre les noms démarrant
// par un point) posé sous le chemin canonique du dossier média — deux
// --media-dir différents pointant (via symlink ou chemin relatif) vers le
// même dossier réel se heurtent donc au même verrou.
//
// Libération automatique à la sortie normale du processus (process "exit",
// y compris après une exception non interceptée). Après un SIGKILL ou une
// coupure brutale, le fichier reste : aucune levée automatique n'est
// tentée (fail-closed délibéré, identique au verrou de production) —
// suppression manuelle requise une fois confirmé qu'aucun processus actif
// ne détient réellement le verrou.
const NARRATION_LOCK_FILE = ".narration-lock";

function acquireMediaNarrationLock(root) {
  const canonicalRoot = fs.realpathSync(root);
  const file = path.join(canonicalRoot, NARRATION_LOCK_FILE);
  let descriptor;

  try {
    descriptor = fs.openSync(file, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      let holder = "";

      try {
        holder = ` (${fs.readFileSync(file, "utf8").trim()})`;
      } catch {
        // Contenu illisible : le refus reste valable.
      }

      fail(
        `dossier média verrouillé pour la narration : ${NARRATION_LOCK_FILE} ` +
        `présent${holder} — une autre production utilise ce --media-dir ` +
        "pour une narration réelle. Exécution refusée (fail-closed). Si " +
        "aucun processus ne tourne, supprimer ce verrou à la main."
      );
    }

    throw error;
  }

  fs.writeSync(
    descriptor,
    JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString()
    }) + "\n"
  );
  fs.closeSync(descriptor);

  let released = false;

  const release = () => {
    if (released) {
      return;
    }

    released = true;
    process.removeListener("exit", release);

    try {
      fs.unlinkSync(file);
    } catch {
      // Déjà retiré.
    }
  };

  process.on("exit", release);

  return release;
}

function fail(message) {
  throw new Error(`Narration Provider : ${message}`);
}

function assertPlan(units) {
  if (!Array.isArray(units) || units.length === 0) {
    fail("plan de narration absent ou vide.");
  }

  const ids = new Set();

  for (const unit of units) {
    if (
      !unit ||
      typeof unit.unitId !== "string" ||
      unit.unitId.length === 0 ||
      typeof unit.text !== "string" ||
      unit.text.trim().length === 0 ||
      !Number.isFinite(unit.estimatedSeconds) ||
      unit.estimatedSeconds <= 0 ||
      ids.has(unit.unitId)
    ) {
      fail("plan de narration invalide ou unit_id dupliqué.");
    }

    ids.add(unit.unitId);
  }
}

function expectedReference(unitId, extension) {
  if (!EXTENSIONS.has(extension)) {
    fail(`extension provider interdite (${extension}).`);
  }

  return `${VOICE_DIRECTORY}/${unitId}${extension}`;
}

function requireGuard(callGuard) {
  if (
    !callGuard ||
    typeof callGuard.preflight !== "function" ||
    typeof callGuard.begin !== "function" ||
    typeof callGuard.succeed !== "function" ||
    typeof callGuard.fail !== "function"
  ) {
    fail("Call Guard narration injectable obligatoire.");
  }
}

function assertProvider(provider) {
  if (!provider || typeof provider.generate !== "function") {
    fail("provider injectable invalide.");
  }
}

function temporaryReference(unitId, extension) {
  return `${VOICE_DIRECTORY}/.${unitId}.narration-${process.pid}-` +
    `${crypto.randomBytes(8).toString("hex")}${extension}`;
}

// Réutilise les fichiers inspectés. Si le dossier voice/ n'existe pas, il est
// créé pour une future écriture; tout autre problème d'inventaire échoue fermé.
async function inspectExisting({ root, mediaDir }) {
  const voiceDirectory = path.join(root, VOICE_DIRECTORY);

  if (!fs.existsSync(voiceDirectory)) {
    fs.mkdirSync(voiceDirectory, { recursive: true });
    return {};
  }

  return inspectLocalVoice({ mediaDir });
}

function assertNoUnexpectedLocalAudio(records, expectedIds) {
  const unexpected = Object.keys(records).filter(id => !expectedIds.has(id));

  if (unexpected.length > 0) {
    fail(`audio local sans unité correspondante (${unexpected.join(", ")}).`);
  }
}

async function persistGeneratedAudio({
  root,
  mediaDir,
  unit,
  generated
}) {
  if (
    !generated ||
    !Buffer.isBuffer(generated.bytes) ||
    generated.bytes.length === 0 ||
    typeof generated.extension !== "string"
  ) {
    fail(`provider : résultat audio invalide pour ${unit.unitId}.`);
  }

  const finalReference = expectedReference(unit.unitId, generated.extension);
  const temporary = temporaryReference(unit.unitId, generated.extension);
  const finalPath = path.join(root, finalReference);
  const temporaryPath = path.join(root, temporary);

  if (fs.existsSync(finalPath)) {
    fail(`fichier final déjà présent pour ${unit.unitId}; remplacement refusé.`);
  }

  try {
    fs.writeFileSync(temporaryPath, generated.bytes, { flag: "wx" });
    const inspected = await inspectLocalVoiceReference({
      mediaDir,
      reference: temporary
    });

    // link(2) crée la destination sans jamais écraser un fichier concurrent;
    // la suppression du temporaire laisse une publication atomique locale.
    fs.linkSync(temporaryPath, finalPath);
    fs.unlinkSync(temporaryPath);

    return {
      reference: finalReference,
      record: { ...inspected, path: finalReference }
    };
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch {
      // L'erreur primaire reste déterminante; aucun succès n'est retourné.
    }

    throw error;
  }
}

// Assure le contrat voice/<unit_id>.<ext>. Le Call Guard est volontairement
// injecté : les fakes locaux peuvent fournir une implémentation sans réseau,
// tandis qu'un futur provider réel utilisera la garde journalisée de R16.
export async function ensureNarrationAudio({
  mediaDir,
  units,
  provider,
  providerConfig = {},
  callGuard
}) {
  assertPlan(units);
  assertProvider(provider);
  requireGuard(callGuard);

  const root = resolveMediaRoot(mediaDir);

  // Verrou média inter-processus : uniquement pour le garde réel (celui
  // qui expose verifyReuse — src/services/call-guard.js), avant toute
  // inspection du dossier partagé. Les gardes de fixtures/tests, qui ne
  // déclenchent jamais d'appel facturable, n'ont pas besoin de ce verrou.
  // Libéré explicitement à la fin de cet appel (succès ou échec) — pas
  // seulement à la sortie du processus — pour qu'un même processus
  // puisse légitimement ré-appeler ensureNarrationAudio() plus tard
  // (reprise successive) sans se bloquer lui-même ; la libération à la
  // sortie du processus reste un filet de sécurité en cas d'exception
  // non interceptée ailleurs.
  const releaseMediaLock =
    typeof callGuard.verifyReuse === "function"
      ? acquireMediaNarrationLock(root)
      : null;

  try {
    return await ensureNarrationAudioLocked({
      mediaDir,
      root,
      units,
      provider,
      providerConfig,
      callGuard
    });
  } finally {
    releaseMediaLock?.();
  }
}

async function ensureNarrationAudioLocked({
  mediaDir,
  root,
  units,
  provider,
  providerConfig,
  callGuard
}) {
  const expectedIds = new Set(units.map(unit => unit.unitId));
  const existing = await inspectExisting({ root, mediaDir });
  assertNoUnexpectedLocalAudio(existing, expectedIds);

  const missing = units.filter(unit => !Object.hasOwn(existing, unit.unitId));

  function buildRequest(unit) {
    return typeof provider.requestIdentity === "function"
      ? provider.requestIdentity({ unit, providerConfig })
      : {
        unit_id: unit.unitId,
        text: unit.text,
        estimated_seconds: unit.estimatedSeconds,
        provider_config: providerConfig
      };
  }

  // Identité d'un fichier déjà présent : un nom de fichier correspondant à
  // unit_id ne suffit jamais à prouver qu'il provient du texte/config
  // actuels (p. ex. après un --narration-override changeant le texte d'une
  // unité déjà synthétisée). Si le garde expose verifyReuse (garde réel de
  // production), chaque unité déjà présente doit être prouvée par le
  // journal avant d'être exclue des appels à effectuer — échec fermé sinon,
  // jamais de régénération ni de suppression automatique.
  if (typeof callGuard.verifyReuse === "function") {
    for (const unit of units) {
      if (!Object.hasOwn(existing, unit.unitId)) {
        continue;
      }

      callGuard.verifyReuse({
        unitId: unit.unitId,
        providerKind: provider.kind ?? "narration",
        request: buildRequest(unit),
        existingRecord: existing[unit.unitId]
      });
    }
  }

  // Le preflight est global, après reuse, et précède le premier provider call.
  callGuard.preflight({
    calls: missing.length,
    label: "narration"
  });

  for (const unit of missing) {
    const request = buildRequest(unit);
    const reservation = callGuard.begin({
      providerKind: provider.kind ?? "narration",
      unitId: unit.unitId,
      request
    });

    try {
      const generated = await provider.generate({
        unitId: unit.unitId,
        text: unit.text,
        estimatedSeconds: unit.estimatedSeconds,
        providerConfig
      });
      const persisted = await persistGeneratedAudio({
        root,
        mediaDir,
        unit,
        generated
      });

      callGuard.succeed(reservation, {
        provider_kind: provider.kind ?? "narration",
        unit_id: unit.unitId,
        path: persisted.reference,
        sha256: persisted.record.sha256,
        size_bytes: persisted.record.size_bytes,
        duration_seconds: persisted.record.duration_seconds
      });
    } catch (error) {
      callGuard.fail(reservation, error);
      throw error;
    }
  }

  const complete = await inspectLocalVoice({ mediaDir });
  assertNoUnexpectedLocalAudio(complete, expectedIds);

  const stillMissing = units.filter(unit => !Object.hasOwn(complete, unit.unitId));

  if (stillMissing.length > 0) {
    fail(`audio local manquant après génération (${stillMissing.map(unit => unit.unitId).join(", ")}).`);
  }

  return complete;
}
