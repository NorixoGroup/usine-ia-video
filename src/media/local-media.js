import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { inspectMediaFile } from "./probe.js";

// Couche média locale.
//
// Rattache des fichiers LOCAUX aux besoins du pipeline, à partir d'un
// dossier fourni explicitement par l'opérateur :
//
//   <media-dir>/assets/<asset_id>.<ext>
//   <media-dir>/voice/<unit_id>.<ext>
//
// Rien n'est téléchargé, copié ni modifié : les fichiers sont inspectés
// en place, puis recontrôlés (taille, SHA-256, relevé ffprobe) avant
// chaque étape qui les utilise.

export const ASSETS_DIRECTORY = "assets";
export const VOICE_DIRECTORY = "voice";

// Extension → type de contenu attendu et nom de conteneur ffprobe.
const EXTENSIONS = {
  ".mp4": { kind: "video", container: "mp4" },
  ".mov": { kind: "video", container: "mov" },
  ".mkv": { kind: "video", container: "matroska" },
  ".webm": { kind: "video", container: "webm" },
  ".png": { kind: "image", container: "png_pipe" },
  ".jpg": { kind: "image", container: "jpeg_pipe" },
  ".jpeg": { kind: "image", container: "jpeg_pipe" },
  ".wav": { kind: "audio", container: "wav" },
  ".mp3": { kind: "audio", container: "mp3" },
  ".m4a": { kind: "audio", container: "m4a" }
};

const ROLES = {
  asset: {
    directory: ASSETS_DIRECTORY,
    kinds: ["video", "image"]
  },
  voice: {
    directory: VOICE_DIRECTORY,
    kinds: ["audio"]
  }
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function fail(message) {
  throw new Error(`Local Media : ${message}`);
}

function isInside(root, target) {
  return target.startsWith(root + path.sep);
}

// Racine autorisée : un dossier local existant, désigné explicitement.
export function resolveMediaRoot(mediaDir) {
  if (
    typeof mediaDir !== "string" ||
    mediaDir.trim().length === 0
  ) {
    fail("dossier média absent ou invalide.");
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(mediaDir)) {
    fail(
      `le dossier média doit être un chemin local, pas une URL (${mediaDir}).`
    );
  }

  const resolved = path.resolve(mediaDir);

  let stats;

  try {
    stats = fs.statSync(resolved);
  } catch {
    fail(`dossier média introuvable (${mediaDir}).`);
  }

  if (!stats.isDirectory()) {
    fail(`le chemin média n'est pas un dossier (${mediaDir}).`);
  }

  return fs.realpathSync(resolved);
}

// Une référence est toujours relative à la racine média : ni URL, ni
// file://, ni chemin absolu, ni remontée de dossier.
export function assertSafeReference(reference) {
  if (
    typeof reference !== "string" ||
    reference.length === 0
  ) {
    fail("référence média absente ou invalide.");
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    fail(`référence distante ou URL interdite (${reference}).`);
  }

  if (
    path.isAbsolute(reference) ||
    reference.startsWith("/") ||
    reference.includes("\\")
  ) {
    fail(`chemin absolu interdit dans une référence (${reference}).`);
  }

  const segments = reference.split("/");

  if (
    segments.some(
      segment =>
        segment === "" ||
        segment === "." ||
        segment === ".."
    )
  ) {
    fail(
      `remontée ou segment vide interdit dans une référence (${reference}).`
    );
  }

  return segments;
}

// Résout une référence en chemin réel, et vérifie que ce chemin réel
// reste strictement à l'intérieur de la racine (liens symboliques
// compris) et désigne un fichier ordinaire non vide.
export function resolveMediaReference(root, reference) {
  const segments = assertSafeReference(reference);
  const candidate = path.join(root, ...segments);

  let real;

  try {
    real = fs.realpathSync(candidate);
  } catch {
    fail(`fichier média absent (${reference}).`);
  }

  if (!isInside(root, real)) {
    fail(
      `référence hors du dossier média autorisé (${reference}).`
    );
  }

  const stats = fs.statSync(real);

  if (!stats.isFile()) {
    fail(`la référence n'est pas un fichier (${reference}).`);
  }

  if (stats.size === 0) {
    fail(`fichier média vide (${reference}).`);
  }

  return {
    absolutePath: real,
    sizeBytes: stats.size
  };
}

function sha256File(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");

    fs.createReadStream(absolutePath)
      .on("error", reject)
      .on("data", chunk => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function extensionRule(reference) {
  const extension = path.extname(reference).toLowerCase();
  const rule = EXTENSIONS[extension];

  if (!rule) {
    fail(
      `extension non autorisée (${reference}). ` +
      `Extensions admises : ${Object.keys(EXTENSIONS).join(", ")}.`
    );
  }

  return {
    extension,
    ...rule
  };
}

// Inspecte un fichier référencé et retourne son relevé complet.
async function inspectReference(root, reference, role, options) {
  const rule = extensionRule(reference);

  if (!ROLES[role].kinds.includes(rule.kind)) {
    fail(
      `extension ${rule.extension} interdite pour un média de type ${role} (${reference}).`
    );
  }

  const { absolutePath, sizeBytes } =
    resolveMediaReference(root, reference);

  let probed;

  try {
    probed = await inspectMediaFile(absolutePath, options);
  } catch (error) {
    fail(`${reference} — ${error.message}`);
  }

  if (probed.kind !== rule.kind) {
    fail(
      `mauvais type de média (${reference}) : contenu ${probed.kind}, ` +
      `${rule.kind} attendu pour l'extension ${rule.extension}.`
    );
  }

  if (!probed.container.split(",").includes(rule.container)) {
    fail(
      `extension ${rule.extension} incohérente avec le conteneur ` +
      `${probed.container} (${reference}).`
    );
  }

  if (probed.size_bytes !== sizeBytes) {
    fail(`taille incohérente pendant l'inspection (${reference}).`);
  }

  return {
    probed,
    sha256: await sha256File(absolutePath)
  };
}

function toAssetRecord(reference, { probed, sha256 }) {
  return {
    path: reference,
    kind: probed.kind,
    container: probed.container,
    duration_seconds: probed.duration_seconds,
    width: probed.width,
    height: probed.height,
    fps: probed.fps,
    video_codec: probed.video_codec,
    size_bytes: probed.size_bytes,
    sha256
  };
}

function toAudioRecord(reference, { probed, sha256 }) {
  return {
    path: reference,
    container: probed.container,
    duration_seconds: probed.duration_seconds,
    audio_codec: probed.audio_codec,
    sample_rate: probed.sample_rate,
    channels: probed.channels,
    size_bytes: probed.size_bytes,
    sha256
  };
}

const RECORD_BUILDERS = {
  asset: toAssetRecord,
  voice: toAudioRecord
};

// Inventaire d'un sous-dossier : un fichier par identifiant.
function listReferences(root, role) {
  const { directory } = ROLES[role];
  const target = path.join(root, directory);

  let real;

  try {
    real = fs.realpathSync(target);
  } catch {
    fail(`sous-dossier ${directory}/ absent du dossier média.`);
  }

  if (!isInside(root, real) || !fs.statSync(real).isDirectory()) {
    fail(
      `sous-dossier ${directory}/ invalide ou hors du dossier média.`
    );
  }

  const references = new Map();

  const names = fs.readdirSync(real)
    // Fichiers cachés du système (.DS_Store…) ignorés.
    .filter(name => !name.startsWith("."))
    .sort();

  for (const name of names) {
    const reference = `${directory}/${name}`;
    const { extension } = extensionRule(reference);
    const id = name.slice(0, -extension.length);

    if (!ID_PATTERN.test(id)) {
      fail(`nom de fichier média invalide (${reference}).`);
    }

    if (references.has(id)) {
      fail(
        `plusieurs fichiers pour l'identifiant ${id} ` +
        `(${references.get(id)}, ${reference}).`
      );
    }

    references.set(id, reference);
  }

  return references;
}

async function inspectLocalRole(role, { mediaDir, ffprobePath }) {
  const root = resolveMediaRoot(mediaDir);
  const records = {};

  for (const [id, reference] of listReferences(root, role)) {
    records[id] = RECORD_BUILDERS[role](
      reference,
      await inspectReference(root, reference, role, {
        ffprobePath
      })
    );
  }

  return records;
}

// Relevés d'inspection de <media-dir>/assets, par asset_id.
export function inspectLocalAssets(options) {
  return inspectLocalRole("asset", options);
}

// Relevés d'inspection de <media-dir>/voice, par unit_id.
export function inspectLocalVoice(options) {
  return inspectLocalRole("voice", options);
}

// Inspection ciblée d'un fichier Voice déjà situé sous la racine locale.
// Elle applique exactement les mêmes contrôles de chemin, extension,
// ffprobe, taille et SHA-256 que l'inventaire complet.
export async function inspectLocalVoiceReference({
  mediaDir,
  reference,
  ffprobePath
}) {
  const root = resolveMediaRoot(mediaDir);

  if (
    typeof reference !== "string" ||
    !reference.startsWith(`${VOICE_DIRECTORY}/`)
  ) {
    fail("référence Voice invalide.");
  }

  return toAudioRecord(
    reference,
    await inspectReference(root, reference, "voice", { ffprobePath })
  );
}

function listManifestRecords(assets, voice, errors) {
  const entries = [];

  if (!Array.isArray(assets?.assets)) {
    errors.push("manifeste d'assets illisible");
  } else {
    assets.assets.forEach((asset, index) => {
      entries.push({
        role: "asset",
        id: asset?.asset_id,
        record: asset?.media,
        label: `assets[${index}]`
      });
    });
  }

  if (!Array.isArray(voice?.narration_units)) {
    errors.push("manifeste voice illisible");
  } else {
    voice.narration_units.forEach((unit, index) => {
      entries.push({
        role: "voice",
        id: unit?.unit_id,
        record: unit?.audio,
        label: `narration_units[${index}]`
      });
    });
  }

  return entries;
}

// Recontrôle sur disque chaque média référencé par les manifestes :
// présence, racine, taille, SHA-256 et relevé ffprobe identiques à
// ceux enregistrés lors de l'inspection. Ne lève pas d'erreur sur un
// média fautif : le rapport porte le verdict, que l'étape aval audite.
export async function verifyLocalMedia({
  mediaDir,
  assets,
  voice,
  ffprobePath
}) {
  const errors = [];
  const files = [];

  const root = resolveMediaRoot(mediaDir);

  for (const entry of listManifestRecords(assets, voice, errors)) {
    const { role, id, record, label } = entry;

    if (
      !record ||
      typeof record !== "object" ||
      typeof record.path !== "string"
    ) {
      errors.push(`${label}: aucun média local référencé`);
      continue;
    }

    try {
      const fresh = RECORD_BUILDERS[role](
        record.path,
        await inspectReference(root, record.path, role, {
          ffprobePath
        })
      );

      const changed = Object.keys(fresh).filter(
        key => fresh[key] !== record[key]
      );

      if (changed.length > 0) {
        errors.push(
          `${label}: média modifié depuis l'inspection ` +
          `(${record.path} — ${changed.join(", ")})`
        );
        continue;
      }

      files.push({
        role,
        id,
        path: fresh.path,
        size_bytes: fresh.size_bytes,
        sha256: fresh.sha256
      });
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  }

  return {
    scope: "local_media",
    valid: errors.length === 0,
    errors,
    files
  };
}
