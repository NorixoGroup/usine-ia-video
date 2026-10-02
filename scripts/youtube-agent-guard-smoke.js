// Smoke du garde et du serveur YouTube Agent — gestionnaire appelé en mémoire.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-guard-smoke.js

import { createHandler } from "../src/youtube-agent/server.js";
import { createSession, tokensEqual } from "../src/youtube-agent/session.js";
import { checkRequest } from "../src/youtube-agent/guard.js";
import { tmpRoot, cleanup, check, done, makeProduction, PROD_A } from "./youtube-agent-test-helpers.js";

const root = tmpRoot("guard");
makeProduction(root, PROD_A);

const PORT = 4999;
const { token } = createSession();
const handle = createHandler({ root, port: PORT, token });
const good = { host: `127.0.0.1:${PORT}` };

check("jetons de session distincts et longs", () => {
  const a = createSession().token;
  const b = createSession().token;
  if (a === b || a.length < 64) throw new Error("jeton faible");
  if (!tokensEqual(a, a) || tokensEqual(a, b) || tokensEqual(a, undefined)) throw new Error("comparaison");
});

check("GET / sans jeton refusé", () => {
  if (handle({ method: "GET", url: "/", headers: good }).status !== 403) throw new Error("accepté");
});

check("mauvais jeton refusé", () => {
  if (handle({ method: "GET", url: "/?t=nope", headers: good }).status !== 403) throw new Error("accepté");
});

check("Host étranger refusé (DNS rebinding)", () => {
  const r = handle({ method: "GET", url: `/?t=${token}`, headers: { host: "evil.example:4999" } });
  if (r.status !== 403) throw new Error("accepté");
});

check("Host sans port refusé", () => {
  const r = handle({ method: "GET", url: `/?t=${token}`, headers: { host: "127.0.0.1" } });
  if (r.status !== 403) throw new Error("accepté");
});

check("Origin étrangère refusée", () => {
  const r = handle({ method: "GET", url: `/?t=${token}`, headers: { ...good, origin: "https://evil.example" } });
  if (r.status !== 403) throw new Error("accepté");
});

check("POST sans Origin refusé", () => {
  const r = handle({ method: "POST", url: `/videos?t=${token}`, headers: { ...good, "content-type": "application/x-www-form-urlencoded" }, body: "" });
  if (r.status !== 403) throw new Error("accepté");
});

check("GET / avec jeton accepté, CSP et no-store présents", () => {
  const r = handle({ method: "GET", url: `/?t=${token}`, headers: good });
  if (r.status !== 200) throw new Error(`statut ${r.status}`);
  if (!r.headers["content-security-policy"].includes("default-src 'none'")) throw new Error("CSP");
  if (r.headers["cache-control"] !== "no-store") throw new Error("cache");
  if (!r.body.includes(PROD_A)) throw new Error("production absente");
});

check("jeton accepté aussi par en-tête", () => {
  const r = handle({ method: "GET", url: "/", headers: { ...good, "x-agent-token": token } });
  if (r.status !== 200) throw new Error("refusé");
});

check("aucune route de fichiers : traversée et chemins inconnus → 404", () => {
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/package.json", "/projects", "/data/youtube-agent", "/.env.local", "/src/youtube-agent/server.js"]) {
    const r = handle({ method: "GET", url: `${p}?t=${token}`, headers: good });
    if (r.status !== 404) throw new Error(`${p} → ${r.status}`);
  }
});

check("méthode non prévue refusée", () => {
  const r = handle({ method: "DELETE", url: `/videos?t=${token}`, headers: { ...good, origin: `http://127.0.0.1:${PORT}` } });
  if (r.status !== 405) throw new Error(`statut ${r.status}`);
});

check("corps trop gros et mauvais type refusés", () => {
  const h = { ...good, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" };
  const big = handle({ method: "POST", url: `/videos?t=${token}`, headers: h, body: "x=".padEnd(20000, "a") });
  if (big.status !== 413) throw new Error(`413 attendu, ${big.status}`);
  const json = handle({ method: "POST", url: `/videos?t=${token}`, headers: { ...h, "content-type": "application/json" }, body: "{}" });
  if (json.status !== 415) throw new Error(`415 attendu, ${json.status}`);
});

check("garde pure : verdict détaillé", () => {
  const v = checkRequest({ headers: { host: "x" }, searchParams: new URLSearchParams(), port: PORT, token, method: "GET" });
  if (v.ok || v.reason !== "host") throw new Error("verdict");
});

cleanup(root);
done("youtube-agent-guard-smoke");
