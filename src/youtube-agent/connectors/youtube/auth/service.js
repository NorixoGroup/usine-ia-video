// Connexion YouTube : démarrer, traiter le retour, donner l'état.
// Un seul opérateur, un seul compte Google, une seule chaîne : aucun identifiant
// d'utilisateur ni de chaîne n'est accepté de l'extérieur.

import crypto from "node:crypto";

import { readOAuthConfig, OAUTH_REDIRECT_URI_ENV, REQUESTED_SCOPES, assertAllowedScopes } from "./config.js";
import { exchangeAuthorizationCode } from "./google-oauth.js";
import { saveConnection, readConnectionMeta } from "./token-store.js";

// --- Empreinte de contrôle (PKCE, RFC 7636, méthode S256) --------------------------------
// Le vérificateur reste dans l'agent, seule son empreinte (le « challenge ») part vers Google.

export const PKCE_METHOD = "S256";

const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
// Forme commune de l'état, du challenge et du vérificateur générés ici (32 octets en base64url).
const TOKEN43_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function challengeFor(verifier) {
  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) throw new Error("PKCE_VERIFIER_INVALID");

  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");

  return { verifier, challenge: challengeFor(verifier), method: PKCE_METHOD };
}

// --- États éphémères : usage unique, durée de vie courte, plafonnés, en mémoire ----------
// Un état n'est lié ni à un utilisateur ni à une chaîne. Il n'est jamais conservé en clair :
// seule son empreinte sert de clé.

export const STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_MAX_PENDING = 5;

const digest = state => crypto.createHash("sha256").update(state).digest("hex");

export function createStateStore({ now = () => Date.now() } = {}) {
  const pending = new Map();

  const purgeExpired = () => {
    for (const [key, entry] of pending) if (now() - entry.createdAt > STATE_TTL_MS) pending.delete(key);
  };

  return {
    // Crée un état et sa paire PKCE ; retourne ce qui part vers Google (jamais le vérificateur).
    issue() {
      purgeExpired();

      // Plafond : le plus ancien état en attente est abandonné (Map conserve l'ordre d'insertion).
      while (pending.size >= STATE_MAX_PENDING) pending.delete(pending.keys().next().value);

      const state = crypto.randomBytes(32).toString("base64url");
      const pkce = createPkcePair();

      pending.set(digest(state), { createdAt: now(), verifier: pkce.verifier });

      return { state, codeChallenge: pkce.challenge, codeChallengeMethod: pkce.method };
    },

    // Usage unique : l'état est consommé dès la première présentation, même expiré.
    consume(state) {
      if (typeof state !== "string" || !TOKEN43_PATTERN.test(state)) return { ok: false, reason: "malformed" };

      const key = digest(state);
      const entry = pending.get(key);

      if (!entry) return { ok: false, reason: "unknown" };

      pending.delete(key);

      if (now() - entry.createdAt > STATE_TTL_MS) return { ok: false, reason: "expired" };

      return { ok: true, codeVerifier: entry.verifier };
    },

    pendingCount() {
      purgeExpired();

      return pending.size;
    }
  };
}

// --- URL d'autorisation (fonction pure : aucun réseau, jamais le secret du client) -------

export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export function buildAuthorizeUrl({ config, state, codeChallenge, scopes = REQUESTED_SCOPES }) {
  if (!config || typeof config.clientId !== "string" || typeof config.redirectUri !== "string") throw new Error("AUTHORIZE_CONFIG_INVALID");
  if (typeof state !== "string" || !TOKEN43_PATTERN.test(state)) throw new Error("AUTHORIZE_STATE_INVALID");
  if (typeof codeChallenge !== "string" || !TOKEN43_PATTERN.test(codeChallenge)) throw new Error("AUTHORIZE_CHALLENGE_INVALID");

  const allowed = assertAllowedScopes([...scopes]);
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);

  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", allowed.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", PKCE_METHOD);
  // Jeton de rafraîchissement demandé, avec écran de consentement explicite.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return url.toString();
}

// --- Service ------------------------------------------------------------------------------

const CODE_PATTERN = /^[\x21-\x7E]{10,2048}$/;

// `port` : port d'écoute réel de l'agent. L'URI de redirection doit pointer sur ce port,
// sinon la connexion est désactivée (aucune adresse approximative n'est tolérée).
export function createYoutubeAuthService({ root, port, env, fetchImpl, now = () => new Date() }) {
  const result = readOAuthConfig(env);
  let config = null;
  let problem = null;

  if (!result.ok) problem = { missing: result.missing, invalid: result.invalid };
  else if (result.config.redirectPort !== port) problem = { missing: [], invalid: [OAUTH_REDIRECT_URI_ENV] };
  else config = result.config;

  const enabled = config !== null;
  const states = createStateStore({ now: () => now().getTime() });

  return {
    enabled,
    // URL de Nomad Studio vers laquelle le navigateur revient après le callback.
    returnUrl: config?.returnUrl ?? null,

    beginLogin() {
      if (!enabled) throw new Error("OAUTH_NOT_CONFIGURED");

      const { state, codeChallenge } = states.issue();

      return { authorizeUrl: buildAuthorizeUrl({ config, state, codeChallenge }) };
    },

    // Retourne { ok: true } ou { ok: false, reason } (codes fixes, jamais de valeur externe).
    async completeCallback({ code, state, error } = {}) {
      if (!enabled) return { ok: false, reason: "not_configured" };

      // L'état est vérifié et consommé en premier, quoi que contienne le reste de la requête.
      const consumed = states.consume(state);

      if (!consumed.ok) return { ok: false, reason: "state_invalid" };
      if (typeof error === "string" && error) return { ok: false, reason: error === "access_denied" ? "access_denied" : "google_error" };
      if (typeof code !== "string" || !CODE_PATTERN.test(code)) return { ok: false, reason: "missing_code" };

      let tokens;

      try {
        tokens = await exchangeAuthorizationCode({ config, code, codeVerifier: consumed.codeVerifier, fetchImpl });
      } catch (failure) {
        return { ok: false, reason: failure?.code === "OAUTH_SCOPE_INVALID" ? "scope_insufficient" : "exchange_failed" };
      }

      try {
        saveConnection({ root, key: config.tokenKey, refreshToken: tokens.refreshToken, scopes: tokens.scopes, now: now() });
      } catch {
        return { ok: false, reason: "storage_failed" };
      }

      return { ok: true };
    },

    // Statut sans aucun secret.
    status() {
      let connection;

      try {
        connection = readConnectionMeta({ root });
      } catch {
        connection = { status: "invalid" };
      }

      return { enabled, problem, connection };
    }
  };
}
