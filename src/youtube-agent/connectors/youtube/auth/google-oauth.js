// Seul appel réseau de R19.3 : l'échange du code d'autorisation contre des jetons
// (point d'accès documenté par Google). Seul le refresh token est conservé : l'access
// token est ignoré dès la réponse. Les erreurs ne portent qu'un code, jamais de valeur.

import { assertAllowedScopes } from "./config.js";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const MAX_RESPONSE_CHARS = 64 * 1024;
const CODE_PATTERN = /^[\x21-\x7E]{10,2048}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export class GoogleOAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

function errorCodeFor(status, googleError) {
  if (googleError === "invalid_grant") return "OAUTH_INVALID_GRANT";
  if (googleError === "invalid_client" || googleError === "unauthorized_client") return "OAUTH_INVALID_CLIENT";
  if (googleError === "redirect_uri_mismatch") return "OAUTH_REDIRECT_MISMATCH";
  if (status >= 500) return "OAUTH_UPSTREAM";

  return "OAUTH_REJECTED";
}

// Retourne { refreshToken, scopes }. Lève GoogleOAuthError (code seulement) en cas d'échec.
export async function exchangeAuthorizationCode({ config, code, codeVerifier, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw new GoogleOAuthError("OAUTH_BAD_REQUEST");
  if (typeof codeVerifier !== "string" || !VERIFIER_PATTERN.test(codeVerifier)) throw new GoogleOAuthError("OAUTH_BAD_REQUEST");
  if (!config || !config.clientId || !config.clientSecret || !config.redirectUri) throw new GoogleOAuthError("OAUTH_BAD_REQUEST");

  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier
  });

  let response;

  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new GoogleOAuthError(error?.name === "TimeoutError" || error?.name === "AbortError" ? "OAUTH_TIMEOUT" : "OAUTH_NETWORK");
  }

  let json;

  try {
    const text = await response.text();

    if (text.length > MAX_RESPONSE_CHARS) throw new Error("trop long");

    json = JSON.parse(text);
  } catch {
    throw new GoogleOAuthError("OAUTH_BAD_RESPONSE");
  }

  if (!response.ok) throw new GoogleOAuthError(errorCodeFor(response.status, typeof json?.error === "string" ? json.error : null));

  if (typeof json?.refresh_token !== "string" || json.refresh_token.length === 0) throw new GoogleOAuthError("OAUTH_NO_REFRESH_TOKEN");

  let scopes;

  try {
    if (typeof json.scope !== "string") throw new Error("scope absent");

    scopes = assertAllowedScopes(json.scope.split(" ").filter(Boolean));
  } catch {
    throw new GoogleOAuthError("OAUTH_SCOPE_INVALID");
  }

  // L'access token (json.access_token) n'est volontairement ni lu ni retourné.
  return { refreshToken: json.refresh_token, scopes };
}
