// Configuration de la connexion YouTube : seule lecture des variables d'environnement
// (aucune valeur n'est jamais renvoyée dans un message d'erreur : seuls les NOMS des
// variables manquantes ou invalides) et scopes autorisés, en lecture seule.

export const OAUTH_CLIENT_ID_ENV = "YOUTUBE_OAUTH_CLIENT_ID";
export const OAUTH_CLIENT_SECRET_ENV = "YOUTUBE_OAUTH_CLIENT_SECRET";
export const OAUTH_REDIRECT_URI_ENV = "YOUTUBE_OAUTH_REDIRECT_URI";
export const OAUTH_RETURN_URL_ENV = "YOUTUBE_OAUTH_RETURN_URL";
export const OAUTH_TOKEN_KEY_ENV = "YOUTUBE_OAUTH_TOKEN_KEY";

export const OAUTH_ENV_NAMES = Object.freeze([
  OAUTH_CLIENT_ID_ENV,
  OAUTH_CLIENT_SECRET_ENV,
  OAUTH_REDIRECT_URI_ENV,
  OAUTH_RETURN_URL_ENV,
  OAUTH_TOKEN_KEY_ENV
]);

export const CALLBACK_PATH = "/oauth/youtube/callback";
export const RETURN_PATH = "/dashboard/nomad-studio";

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{10,200}$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._~-]{8,200}$/;
const TOKEN_KEY_PATTERN = /^[A-Za-z0-9+/_-]{43}=?$/;

function parseLoopbackUrl(raw, { hosts, path }) {
  let url;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const port = Number(url.port);

  if (url.protocol !== "http:" || !hosts.includes(url.hostname)) return null;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (url.pathname !== path || url.search || url.hash || url.username || url.password) return null;

  return { href: `${url.protocol}//${url.host}${url.pathname}`, port };
}

function parseTokenKey(raw) {
  if (!TOKEN_KEY_PATTERN.test(raw)) return null;

  const key = Buffer.from(raw, "base64");

  return key.length === 32 ? key : null;
}

// Retourne { ok: true, config } ou { ok: false, missing: [noms], invalid: [noms] }.
export function readOAuthConfig(env = process.env) {
  const raw = {
    clientId: env[OAUTH_CLIENT_ID_ENV]?.trim() ?? "",
    clientSecret: env[OAUTH_CLIENT_SECRET_ENV]?.trim() ?? "",
    redirectUri: env[OAUTH_REDIRECT_URI_ENV]?.trim() ?? "",
    returnUrl: env[OAUTH_RETURN_URL_ENV]?.trim() ?? "",
    tokenKey: env[OAUTH_TOKEN_KEY_ENV]?.trim() ?? ""
  };

  const missing = [];
  const invalid = [];
  const check = (name, value, valid) => {
    if (!value) missing.push(name);
    else if (!valid) invalid.push(name);
  };

  const redirect = raw.redirectUri ? parseLoopbackUrl(raw.redirectUri, { hosts: ["127.0.0.1"], path: CALLBACK_PATH }) : null;
  const back = raw.returnUrl ? parseLoopbackUrl(raw.returnUrl, { hosts: ["127.0.0.1", "localhost"], path: RETURN_PATH }) : null;
  const key = raw.tokenKey ? parseTokenKey(raw.tokenKey) : null;

  check(OAUTH_CLIENT_ID_ENV, raw.clientId, CLIENT_ID_PATTERN.test(raw.clientId));
  check(OAUTH_CLIENT_SECRET_ENV, raw.clientSecret, CLIENT_SECRET_PATTERN.test(raw.clientSecret));
  check(OAUTH_REDIRECT_URI_ENV, raw.redirectUri, redirect !== null);
  check(OAUTH_RETURN_URL_ENV, raw.returnUrl, back !== null);
  check(OAUTH_TOKEN_KEY_ENV, raw.tokenKey, key !== null);

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };

  const config = {
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    redirectUri: redirect.href,
    redirectPort: redirect.port,
    returnUrl: back.href,
    tokenKey: key
  };

  // Garde-fou : la configuration contient des secrets et ne doit jamais être sérialisée.
  Object.defineProperty(config, "toJSON", { value: () => "[redacted]", enumerable: false });

  return { ok: true, config };
}

// Scopes : lecture seule, liste blanche fermée. Aucun scope permettant de publier,
// modifier ou supprimer n'est accepté.

export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YT_ANALYTICS_READONLY_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

export const REQUESTED_SCOPES = Object.freeze([YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE]);
export const ALLOWED_SCOPES = REQUESTED_SCOPES;

// Retourne la liste validée : non vide, sans doublon, uniquement des scopes autorisés,
// et contenant au minimum la lecture YouTube.
export function assertAllowedScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > ALLOWED_SCOPES.length) {
    throw new Error("SCOPES_INVALID");
  }

  if (new Set(scopes).size !== scopes.length) throw new Error("SCOPES_INVALID");
  if (scopes.some(scope => !ALLOWED_SCOPES.includes(scope))) throw new Error("SCOPES_INVALID");
  if (!scopes.includes(YOUTUBE_READONLY_SCOPE)) throw new Error("SCOPES_INVALID");

  return [...scopes];
}
