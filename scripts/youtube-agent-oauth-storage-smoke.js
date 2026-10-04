// Smoke R19.1 — stockage OAuth YouTube : configuration, jeton chiffré, scopes, partitions.
// Aucun réseau. Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-oauth-storage-smoke.js

import fs from "node:fs";
import path from "node:path";

import {
  OAUTH_ENV_NAMES, OAUTH_CLIENT_ID_ENV, OAUTH_CLIENT_SECRET_ENV, OAUTH_REDIRECT_URI_ENV,
  OAUTH_RETURN_URL_ENV, OAUTH_TOKEN_KEY_ENV, readOAuthConfig,
  ALLOWED_SCOPES, REQUESTED_SCOPES, YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE, assertAllowedScopes
} from "../src/youtube-agent/connectors/youtube/auth/config.js";
import {
  OAUTH_SCHEMA, TokenStoreError, saveConnection, loadRefreshToken, readConnectionMeta
} from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { PARTITIONS } from "../src/youtube-agent/memory/partitions.js";
import { appendMemory, selectContext } from "../src/youtube-agent/memory/contract.js";
import { PARTITION_NAMES, partitionFile } from "../src/youtube-agent/paths.js";
import { removeFile } from "../src/youtube-agent/atomic-json.js";
import { tmpRoot, cleanup, check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const KEY = Buffer.alloc(32, 7);
const KEY_B64 = KEY.toString("base64");
const TOKEN = "test-refresh-token-storage";
const SECRET = "test-client-secret-001";
const ENV = {
  [OAUTH_CLIENT_ID_ENV]: "1234567890-abcdefgh.apps.googleusercontent.com",
  [OAUTH_CLIENT_SECRET_ENV]: SECRET,
  [OAUTH_REDIRECT_URI_ENV]: "http://127.0.0.1:4177/oauth/youtube/callback",
  [OAUTH_RETURN_URL_ENV]: "http://localhost:3000/dashboard/nomad-studio",
  [OAUTH_TOKEN_KEY_ENV]: KEY_B64
};
const now = new Date("2026-06-01T10:00:00Z");
const root = tmpRoot("oauth");
const emptyRoot = tmpRoot("oauth-vide");
const base = { root, key: KEY, refreshToken: TOKEN, scopes: [YOUTUBE_READONLY_SCOPE], now };
const FILE = () => partitionFile(root, "nomade", "oauth", "youtube.json");
const code = fn => { try { fn(); } catch (e) { return e.code ?? e.message; } return null; };

check("noms de variables : cinq, convention YOUTUBE_OAUTH_*", () => {
  if (OAUTH_ENV_NAMES.length !== 5 || OAUTH_ENV_NAMES.some(n => !n.startsWith("YOUTUBE_OAUTH_"))) throw new Error(OAUTH_ENV_NAMES.join());
});

check("configuration absente : seuls les noms manquants sont rapportés", () => {
  const r = readOAuthConfig({});
  if (r.ok || r.missing.length !== 5 || r.invalid.length !== 0 || JSON.stringify(r).includes("http")) throw new Error(JSON.stringify(r));
});

check("configuration valide : champs normalisés, clé de 32 octets", () => {
  const r = readOAuthConfig(ENV);
  if (!r.ok) throw new Error(JSON.stringify(r));
  const c = r.config;
  if (c.redirectUri !== ENV[OAUTH_REDIRECT_URI_ENV] || c.redirectPort !== 4177 || c.returnUrl !== ENV[OAUTH_RETURN_URL_ENV]) throw new Error("URI");
  if (!Buffer.isBuffer(c.tokenKey) || c.tokenKey.length !== 32 || c.clientSecret !== SECRET) throw new Error("clé/secret");
});

check("la configuration ne peut pas être sérialisée par accident", () => {
  const dump = JSON.stringify(readOAuthConfig(ENV));
  for (const secret of [SECRET, KEY_B64, ENV[OAUTH_CLIENT_ID_ENV]]) if (dump.includes(secret)) throw new Error("fuite dans JSON.stringify");
});

check("configuration invalide : le nom fautif est rapporté, jamais la valeur", () => {
  const bad = {
    [OAUTH_REDIRECT_URI_ENV]: ["http://example.com:4177/oauth/youtube/callback", "http://localhost:4177/oauth/youtube/callback", "https://127.0.0.1:4177/oauth/youtube/callback", "http://127.0.0.1/oauth/youtube/callback", "http://127.0.0.1:4177/autre", "http://127.0.0.1:4177/oauth/youtube/callback?x=1", "http://u:p@127.0.0.1:4177/oauth/youtube/callback", "http://127.0.0.1:80/oauth/youtube/callback"],
    [OAUTH_RETURN_URL_ENV]: ["http://example.com:3000/dashboard/nomad-studio", "http://localhost:3000/dashboard/autre", "https://localhost:3000/dashboard/nomad-studio", "http://localhost/dashboard/nomad-studio", "http://localhost:3000/dashboard/nomad-studio#x"],
    [OAUTH_TOKEN_KEY_ENV]: ["court", Buffer.alloc(16, 1).toString("base64"), `${KEY_B64}AA`, "!".repeat(44)],
    [OAUTH_CLIENT_ID_ENV]: ["court", "a b c d e f g h i j"],
    [OAUTH_CLIENT_SECRET_ENV]: ["abc", "avec espace long"]
  };
  for (const [name, values] of Object.entries(bad)) {
    for (const value of values) {
      const r = readOAuthConfig({ ...ENV, [name]: value });
      if (r.ok || !r.invalid.includes(name) || r.missing.length) throw new Error(`${name} accepté : ${value}`);
      if (JSON.stringify(r).includes(value) && value.length > 3) throw new Error(`${name} : valeur renvoyée`);
    }
  }
});

check("scopes : lecture seule uniquement, jamais publier / modifier / supprimer", () => {
  if (ALLOWED_SCOPES.length !== 2 || REQUESTED_SCOPES.join() !== ALLOWED_SCOPES.join()) throw new Error("listes");
  assertAllowedScopes([YOUTUBE_READONLY_SCOPE]);
  assertAllowedScopes([YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE]);
  const forbidden = ["https://www.googleapis.com/auth/youtube", "https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtubepartner", "https://www.googleapis.com/auth/yt-analytics-monetary.readonly", "openid", "email", "profile"];
  for (const s of forbidden) {
    throwsWith(() => assertAllowedScopes([YOUTUBE_READONLY_SCOPE, s]), "SCOPES_INVALID");
    throwsWith(() => assertAllowedScopes([s]), "SCOPES_INVALID");
  }
  throwsWith(() => assertAllowedScopes([]), "SCOPES_INVALID");
  throwsWith(() => assertAllowedScopes([YT_ANALYTICS_READONLY_SCOPE]), "SCOPES_INVALID");
  throwsWith(() => assertAllowedScopes([YOUTUBE_READONLY_SCOPE, YOUTUBE_READONLY_SCOPE]), "SCOPES_INVALID");
});

check("aller-retour chiffré : jamais de jeton en clair sur disque, fichier en 0600", () => {
  saveConnection(base);
  const file = FILE();
  const raw = fs.readFileSync(file, "utf8");
  if (raw.includes(TOKEN) || raw.includes(KEY_B64)) throw new Error("secret en clair");
  if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error(`mode ${(fs.statSync(file).mode & 0o777).toString(8)}`);
  if (loadRefreshToken({ root, key: KEY }) !== TOKEN) throw new Error("aller-retour");
  const record = JSON.parse(raw);
  if (record.schema !== OAUTH_SCHEMA || record.refresh_token.alg !== "aes-256-gcm" || record.status !== "connected") throw new Error("enregistrement");
});

check("deux écritures du même jeton donnent des chiffrés différents (IV aléatoire)", () => {
  const file = FILE();
  const a = JSON.parse(fs.readFileSync(file, "utf8")).refresh_token;
  saveConnection(base);
  const b = JSON.parse(fs.readFileSync(file, "utf8")).refresh_token;
  if (a.iv === b.iv || a.ciphertext === b.ciphertext) throw new Error("IV réutilisé");
});

check("statut sans secret : métadonnées seulement", () => {
  const meta = readConnectionMeta({ root });
  if (meta.status !== "connected" || meta.scopes[0] !== YOUTUBE_READONLY_SCOPE || typeof meta.connected_at !== "string") throw new Error(JSON.stringify(meta));
  if (Object.keys(meta).sort().join() !== "connected_at,scopes,status") throw new Error(`champs : ${Object.keys(meta)}`);
  const dump = JSON.stringify(meta);
  for (const forbidden of ["refresh_token", "ciphertext", "iv", "tag", TOKEN]) if (dump.includes(forbidden)) throw new Error(`champ interdit : ${forbidden}`);
  const empty = tmpRoot("oauth-vide-statut");
  if (readConnectionMeta({ root: empty }).status !== "not_connected") throw new Error("not_connected");
  cleanup(empty);
});

check("altération et mauvaise clé détectées", () => {
  const file = FILE();
  const original = fs.readFileSync(file, "utf8");
  for (const field of ["ciphertext", "tag", "iv"]) {
    const copy = JSON.parse(original);
    const buf = Buffer.from(copy.refresh_token[field], "base64");
    buf[0] ^= 0xff;
    copy.refresh_token[field] = buf.toString("base64");
    fs.writeFileSync(file, JSON.stringify(copy));
    if (code(() => loadRefreshToken({ root, key: KEY })) !== "TOKEN_TAMPERED") throw new Error(`${field} non détecté`);
  }
  fs.writeFileSync(file, original);
  if (code(() => loadRefreshToken({ root, key: Buffer.alloc(32, 9) })) !== "TOKEN_TAMPERED") throw new Error("mauvaise clé");
  if (loadRefreshToken({ root, key: KEY }) !== TOKEN) throw new Error("fichier restauré illisible");
});

check("clé invalide et schéma étranger refusés", () => {
  for (const bad of [null, "texte", Buffer.alloc(16), Buffer.alloc(33)]) {
    if (code(() => loadRefreshToken({ root, key: bad })) !== "TOKEN_KEY_INVALID") throw new Error("clé");
    if (code(() => saveConnection({ ...base, key: bad })) !== "TOKEN_KEY_INVALID") throw new Error("clé à l'écriture");
  }
  const file = FILE();
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), schema: "autre" }));
  if (code(() => readConnectionMeta({ root })) !== "TOKEN_SCHEMA" || code(() => loadRefreshToken({ root, key: KEY })) !== "TOKEN_SCHEMA") throw new Error("schéma");
  fs.writeFileSync(file, original);
  if (loadRefreshToken({ root, key: KEY }) !== TOKEN) throw new Error("fichier restauré illisible");
});

check("entrées invalides refusées sans écrire (jeton, scopes)", () => {
  const file = partitionFile(emptyRoot, "nomade", "oauth", "youtube.json");
  for (const refreshToken of ["", "avec espace", "x".repeat(2049), null, 42]) {
    if (code(() => saveConnection({ ...base, root: emptyRoot, refreshToken })) !== "TOKEN_INVALID") throw new Error(`jeton accepté : ${String(refreshToken).slice(0, 10)}`);
  }
  for (const scopes of [[], ["https://www.googleapis.com/auth/youtube.force-ssl"], [YT_ANALYTICS_READONLY_SCOPE]]) {
    if (code(() => saveConnection({ ...base, root: emptyRoot, scopes })) !== "SCOPES_INVALID") throw new Error("scopes");
  }
  if (fs.existsSync(file)) throw new Error("fichier écrit malgré le refus");
});

check("aucune valeur de jeton dans les erreurs", () => {
  const e = (() => { try { saveConnection({ ...base, root: emptyRoot, refreshToken: `${TOKEN} espace` }); } catch (err) { return err; } return null; })();
  if (!(e instanceof TokenStoreError) || String(e.message).includes(TOKEN) || JSON.stringify(e).includes(TOKEN)) throw new Error("fuite");
});

check("réécriture : la nouvelle connexion remplace l'ancienne, un seul fichier, aucun résidu", () => {
  saveConnection({ ...base, refreshToken: "test-refresh-token-002" });
  if (loadRefreshToken({ root, key: KEY }) !== "test-refresh-token-002") throw new Error("remplacement");
  if (fs.readFileSync(FILE(), "utf8").includes(TOKEN)) throw new Error("ancien jeton présent");
  const dir = path.dirname(FILE());
  if (fs.readdirSync(dir).join() !== "youtube.json") throw new Error(`résidus : ${fs.readdirSync(dir)}`);
});

check("partitions oauth / quota / youtube : déclarées, propriétaires, jamais sélectionnables", () => {
  if (Object.keys(PARTITIONS).sort().join() !== [...PARTITION_NAMES].sort().join()) throw new Error("partitions ≠ chemins");
  for (const name of ["oauth", "quota", "youtube"]) {
    if (!PARTITIONS[name] || PARTITIONS[name].format !== "json") throw new Error(`${name} absente`);
    throwsWith(() => selectContext({ root, channelId: "nomade", partition: name, engine: "agent", purpose: "test", budget: { max_entries: 1, max_bytes: 512 } }), "dédié");
    throwsWith(() => appendMemory({ root, channelId: "nomade", partition: name, engine: PARTITIONS[name].owners[0], record: { type: "x", data: {} } }), "dédié");
  }
  if (PARTITIONS.oauth.sensitive !== true || PARTITIONS.oauth.owners.join() !== "connector" || PARTITIONS.youtube.owners.join() !== "sync") throw new Error("propriétaires");
  if (PARTITIONS.videos.owners.includes("sync") || PARTITIONS.comments.owners.includes("connector")) throw new Error("mélange de partitions");
});

check("removeFile : false si absent, aucun verrou résiduel", () => {
  const f = path.join(emptyRoot, "tmp.json");
  if (removeFile(f) !== false) throw new Error("absent → false");
  fs.writeFileSync(f, "{}");
  if (removeFile(f) !== true || fs.existsSync(f) || fs.existsSync(`${f}.lock`)) throw new Error("suppression");
});

cleanup(root);
cleanup(emptyRoot);
done("youtube-agent-oauth-storage-smoke");
