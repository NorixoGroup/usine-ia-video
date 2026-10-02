// Garde des requêtes : Host, Origin, jeton. Fonction pure, testable sans réseau.

import { SESSION_TOKEN_HEADER, SESSION_TOKEN_QUERY } from "./config.js";
import { tokensEqual } from "./session.js";

export function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

// Retourne { ok: true } ou { ok: false, status, reason }.
export function checkRequest({ headers, searchParams, port, token, method }) {
  const host = String(headers.host ?? "").toLowerCase();

  if (!allowedHosts(port).has(host)) {
    return { ok: false, status: 403, reason: "host" };
  }

  const origin = headers.origin;

  if (origin !== undefined) {
    const allowed = [...allowedHosts(port)].map(h => `http://${h}`);

    if (!allowed.includes(String(origin).toLowerCase())) {
      return { ok: false, status: 403, reason: "origin" };
    }
  } else if (method === "POST") {
    // Un POST sans Origin n'est pas un envoi de formulaire navigateur.
    return { ok: false, status: 403, reason: "origin" };
  }

  const provided =
    headers[SESSION_TOKEN_HEADER] ?? searchParams.get(SESSION_TOKEN_QUERY);

  if (!tokensEqual(token, provided)) {
    return { ok: false, status: 403, reason: "token" };
  }

  return { ok: true };
}
