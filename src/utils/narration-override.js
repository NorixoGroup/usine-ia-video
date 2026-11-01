// Chargement et validation d'un extrait documentaire local destiné à
// remplacer exclusivement le texte de narration d'une unité autorisée
// (aujourd'hui : s01-g01 uniquement). Lecture de fichier locale
// uniquement : aucun réseau, aucun appel, aucune génération.
//
// Ce module ne valide jamais une provenance ou une validation éditoriale
// à la place de l'opérateur : chaque champ de métadonnée doit déjà être
// présent et correct dans le fichier fourni. Le module vérifie la
// cohérence interne (longueur, SHA-256 déclarés contre le texte réel) ;
// il ne les invente ni ne les corrige jamais.

import fs from "node:fs";
import crypto from "node:crypto";

// Plafond local conservateur, indépendant de tout plan ElevenLabs réel —
// à vérifier séparément par l'opérateur avant toute exécution réelle.
export const NARRATION_OVERRIDE_MAX_TEXT_LENGTH = 2000;

// Liste blanche stricte et volontairement réduite : seule s01-g01 est
// autorisée aujourd'hui. Toute extension doit être un choix explicite,
// jamais une conséquence accidentelle d'un changement ailleurs.
export const NARRATION_OVERRIDE_ALLOWED_UNIT_IDS = Object.freeze(["s01-g01"]);

function fail(message) {
  throw new Error(`Narration Override : ${message}`);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Nombre de points de code Unicode (pas d'unités UTF-16) : correct même
// si le texte contient un jour des caractères hors plan de base.
function codePointLength(text) {
  return Array.from(text).length;
}

export function loadNarrationOverride(filePath) {
  if (!isNonEmptyString(filePath)) {
    fail("chemin de fichier absent ou invalide.");
  }

  if (!fs.existsSync(filePath)) {
    fail(`fichier introuvable (${filePath}).`);
  }

  if (!fs.statSync(filePath).isFile()) {
    fail(`chemin fourni n'est pas un fichier (${filePath}).`);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (error) {
    fail(`fichier illisible — ${error.message}`);
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    fail("encodage UTF-8 invalide.");
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    fail(`JSON invalide — ${error.message}`);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    fail("objet JSON attendu à la racine.");
  }

  const REQUIRED_STRING_FIELDS = [
    "episode_id",
    "unit_id",
    "text",
    "text_sha256",
    "source_provenance"
  ];

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(payload[field])) {
      fail(`champ "${field}" manquant ou invalide.`);
    }
  }

  if (!NARRATION_OVERRIDE_ALLOWED_UNIT_IDS.includes(payload.unit_id)) {
    fail(
      `unit_id "${payload.unit_id}" non autorisé — seules les unités ` +
      `suivantes sont acceptées actuellement : ` +
      `${NARRATION_OVERRIDE_ALLOWED_UNIT_IDS.join(", ")}.`
    );
  }

  if (
    !Number.isInteger(payload.character_count) ||
    payload.character_count <= 0
  ) {
    fail('champ "character_count" manquant ou invalide.');
  }

  if (
    !payload.editorial_validation ||
    typeof payload.editorial_validation !== "object" ||
    Array.isArray(payload.editorial_validation) ||
    !isNonEmptyString(payload.editorial_validation.version) ||
    !isNonEmptyString(payload.editorial_validation.validated_at)
  ) {
    fail(
      'métadonnées "editorial_validation.version"/"validated_at" ' +
      "manquantes ou invalides."
    );
  }

  if (
    !payload.voice ||
    typeof payload.voice !== "object" ||
    Array.isArray(payload.voice) ||
    !isNonEmptyString(payload.voice.model_id) ||
    !isNonEmptyString(payload.voice.voice_id)
  ) {
    fail(
      'métadonnées "voice.model_id"/"voice.voice_id" manquantes ou invalides.'
    );
  }

  const narrationText = payload.text;
  const actualCharacterCount = codePointLength(narrationText);

  if (actualCharacterCount === 0) {
    fail("texte vide.");
  }

  if (actualCharacterCount > NARRATION_OVERRIDE_MAX_TEXT_LENGTH) {
    fail(
      `texte trop long (${actualCharacterCount} caractères, plafond local ` +
      `${NARRATION_OVERRIDE_MAX_TEXT_LENGTH}) — à vérifier également ` +
      "contre le plan ElevenLabs réel avant toute exécution."
    );
  }

  // Cohérence déclarée vs réelle — jamais une correction silencieuse.
  if (payload.character_count !== actualCharacterCount) {
    fail(
      `character_count déclaré (${payload.character_count}) ne ` +
      `correspond pas au texte réel (${actualCharacterCount}).`
    );
  }

  const actualSha256 = sha256Hex(narrationText);

  if (
    !/^[0-9a-f]{64}$/.test(payload.text_sha256) ||
    payload.text_sha256 !== actualSha256
  ) {
    fail("text_sha256 déclaré ne correspond pas au SHA-256 réel du texte.");
  }

  return Object.freeze({
    episodeId: payload.episode_id,
    unitId: payload.unit_id,
    text: narrationText,
    characterCount: actualCharacterCount,
    textSha256: actualSha256,
    sourceProvenance: payload.source_provenance,
    editorialValidation: Object.freeze({
      version: payload.editorial_validation.version,
      validatedAt: payload.editorial_validation.validated_at
    }),
    voice: Object.freeze({
      modelId: payload.voice.model_id,
      voiceId: payload.voice.voice_id
    }),
    sourcePath: filePath
  });
}
