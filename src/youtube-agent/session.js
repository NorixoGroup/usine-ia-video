// Jeton de session généré à chaque lancement. Jamais écrit sur disque.

import crypto from "node:crypto";

export function createSession() {
  return { token: crypto.randomBytes(32).toString("hex") };
}

export function tokensEqual(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;

  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(provided).digest();

  return crypto.timingSafeEqual(a, b);
}
