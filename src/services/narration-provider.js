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
  const expectedIds = new Set(units.map(unit => unit.unitId));
  const existing = await inspectExisting({ root, mediaDir });
  assertNoUnexpectedLocalAudio(existing, expectedIds);

  const missing = units.filter(unit => !Object.hasOwn(existing, unit.unitId));

  // Le preflight est global, après reuse, et précède le premier provider call.
  callGuard.preflight({
    calls: missing.length,
    label: "narration"
  });

  for (const unit of missing) {
    const request = typeof provider.requestIdentity === "function"
      ? provider.requestIdentity({ unit, providerConfig })
      : {
        unit_id: unit.unitId,
        text: unit.text,
        estimated_seconds: unit.estimatedSeconds,
        provider_config: providerConfig
      };
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
