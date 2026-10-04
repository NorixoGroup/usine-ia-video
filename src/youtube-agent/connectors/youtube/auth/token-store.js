// Stockage du jeton de rafraîchissement : chiffré (AES-256-GCM) dans la partition `oauth`.
// L'access token n'est JAMAIS stocké ici (mémoire du connecteur uniquement). Les
// métadonnées sont en clair ; le jeton, lui, ne l'est jamais.

import crypto from "node:crypto";

import { DEFAULT_CHANNEL_ID } from "../../../config.js";
import { readJson, writeJsonAtomic, withFileLock } from "../../../atomic-json.js";
import { partitionFile } from "../../../paths.js";
import { assertAllowedScopes } from "./config.js";

export const OAUTH_SCHEMA = "youtube-agent.oauth.v2";
export const OAUTH_FILE = "youtube.json";

const ALG = "aes-256-gcm";
const MAX_TOKEN_LENGTH = 2048;
// Les données associées lient le chiffré au schéma : un fichier altéré ou d'un autre format échoue.
const AAD = Buffer.from(`${OAUTH_SCHEMA}|google`);

// Les erreurs ne portent qu'un code : jamais de valeur de jeton.
export class TokenStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "TokenStoreError";
    this.code = code;
  }
}

const file = root => partitionFile(root, DEFAULT_CHANNEL_ID, "oauth", OAUTH_FILE);

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TokenStoreError("TOKEN_KEY_INVALID");
}

function assertRefreshToken(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new TokenStoreError("TOKEN_INVALID");
  }
}

function encrypt(token, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);

  cipher.setAAD(AAD);

  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);

  return {
    alg: ALG,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decrypt(box, key) {
  try {
    if (box?.alg !== ALG) throw new Error("alg");

    const decipher = crypto.createDecipheriv(ALG, key, Buffer.from(box.iv, "base64"));

    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));

    return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenStoreError("TOKEN_TAMPERED");
  }
}

function readRecord(path) {
  const record = readJson(path, null);

  if (record === null) return null;
  if (record.schema !== OAUTH_SCHEMA || record.provider !== "google") throw new TokenStoreError("TOKEN_SCHEMA");

  return record;
}

// Enregistre la connexion (remplace une éventuelle connexion précédente).
export function saveConnection({ root, key, refreshToken, scopes, now = new Date() }) {
  assertKey(key);
  assertRefreshToken(refreshToken);

  let cleanScopes;

  try {
    cleanScopes = assertAllowedScopes(scopes);
  } catch {
    throw new TokenStoreError("SCOPES_INVALID");
  }

  const path = file(root);

  return withFileLock(path, () => {
    writeJsonAtomic(path, {
      schema: OAUTH_SCHEMA,
      provider: "google",
      status: "connected",
      connected_at: now.toISOString(),
      scopes: cleanScopes,
      refresh_token: encrypt(refreshToken, key)
    });
  });
}

export function loadRefreshToken({ root, key }) {
  assertKey(key);

  const record = readRecord(file(root));

  if (!record) throw new TokenStoreError("TOKEN_MISSING");

  return decrypt(record.refresh_token, key);
}

// Vue sans aucun secret : utilisable par le statut.
export function readConnectionMeta({ root }) {
  const record = readRecord(file(root));

  if (!record) return { status: "not_connected" };

  return { status: record.status, connected_at: record.connected_at, scopes: [...record.scopes] };
}
