// Smoke R19.2 — état OAuth, PKCE et URL d'autorisation. Aucun réseau. Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-oauth-state-smoke.js

import {
  challengeFor, createPkcePair, PKCE_METHOD, createStateStore, STATE_TTL_MS, STATE_MAX_PENDING, buildAuthorizeUrl, GOOGLE_AUTHORIZE_ENDPOINT
} from "../src/youtube-agent/connectors/youtube/auth/service.js";
import { readOAuthConfig, REQUESTED_SCOPES, YOUTUBE_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const SECRET = "test-client-secret-001";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:4177/oauth/youtube/callback",
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY_B64
};
const { config } = readOAuthConfig(ENV);
const clock = () => { let t = 1_000_000; return { now: () => t, advance: ms => { t += ms; } }; };

check("PKCE : vecteur officiel RFC 7636", () => {
  if (challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") !== "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") throw new Error("challenge");
  if (PKCE_METHOD !== "S256") throw new Error("méthode");
});

check("PKCE : vérificateur de 43 caractères, challenge cohérent, paires distinctes", () => {
  const a = createPkcePair();
  const b = createPkcePair();
  if (!/^[A-Za-z0-9_-]{43}$/.test(a.verifier) || a.challenge !== challengeFor(a.verifier) || a.method !== "S256") throw new Error("paire");
  if (a.verifier === b.verifier || a.challenge === b.challenge) throw new Error("non aléatoire");
  if (a.challenge.includes(a.verifier)) throw new Error("challenge = vérificateur");
  for (const bad of ["", "court", "a".repeat(129), "avec espace".padEnd(43, "x"), null, 5]) throwsWith(() => challengeFor(bad), "PKCE_VERIFIER_INVALID");
});

check("état : 43 caractères base64url, distincts, jamais le vérificateur", () => {
  const store = createStateStore();
  const a = store.issue();
  const b = store.issue();
  if (!/^[A-Za-z0-9_-]{43}$/.test(a.state) || a.state === b.state) throw new Error("état");
  if (!/^[A-Za-z0-9_-]{43}$/.test(a.codeChallenge) || a.codeChallengeMethod !== "S256") throw new Error("challenge");
  if (JSON.stringify(a).includes(store.consume(a.state).codeVerifier)) throw new Error("vérificateur divulgué");
});

check("usage unique : la deuxième présentation est refusée", () => {
  const store = createStateStore();
  const { state, codeChallenge } = store.issue();
  const first = store.consume(state);
  if (!first.ok || challengeFor(first.codeVerifier) !== codeChallenge) throw new Error("vérificateur non lié au challenge");
  const second = store.consume(state);
  if (second.ok || second.reason !== "unknown") throw new Error("rejeu accepté");
});

check("expiration à 10 min : refusé puis consommé (aucun rejeu possible)", () => {
  const c = clock();
  const store = createStateStore({ now: c.now });
  const alive = store.issue();
  c.advance(STATE_TTL_MS);
  const ok = store.consume(alive.state);
  if (!ok.ok) throw new Error("expiré trop tôt (limite incluse)");
  const old = store.issue();
  c.advance(STATE_TTL_MS + 1);
  const r = store.consume(old.state);
  if (r.ok || r.reason !== "expired") throw new Error("expiration non détectée");
  if (store.consume(old.state).reason !== "unknown") throw new Error("état expiré non supprimé");
});

check("états malformés ou inconnus : refusés sans toucher aux états valides", () => {
  const store = createStateStore();
  const { state } = store.issue();
  for (const bad of ["", "court", `${state}x`, `${state.slice(0, 42)}!`, null, undefined, 42, {}]) {
    const r = store.consume(bad);
    if (r.ok || r.reason !== "malformed") throw new Error(`malformé accepté : ${String(bad)}`);
  }
  const forged = Buffer.alloc(32, 1).toString("base64url");
  if (store.consume(forged).reason !== "unknown") throw new Error("état forgé");
  if (store.pendingCount() !== 1 || !store.consume(state).ok) throw new Error("état valide perdu");
});

check("plafond de 5 états : le plus ancien est abandonné, les expirés sont purgés d'abord", () => {
  const c = clock();
  const store = createStateStore({ now: c.now });
  const issued = [];
  for (let i = 0; i < STATE_MAX_PENDING + 2; i += 1) { issued.push(store.issue()); c.advance(1000); }
  if (store.pendingCount() !== STATE_MAX_PENDING) throw new Error(`en attente : ${store.pendingCount()}`);
  if (store.consume(issued[0].state).reason !== "unknown" || store.consume(issued[1].state).reason !== "unknown") throw new Error("anciens non abandonnés");
  if (!store.consume(issued.at(-1).state).ok) throw new Error("dernier état perdu");
  c.advance(STATE_TTL_MS + 5000);
  store.issue();
  if (store.pendingCount() !== 1) throw new Error("expirés non purgés");
});

check("l'état ne porte ni utilisateur ni chaîne : aucune donnée liée à l'extérieur", () => {
  const store = createStateStore();
  if (store.issue.length !== 0 || store.consume.length !== 1) throw new Error("signature");
  const dump = JSON.stringify(store.issue());
  if (/channel|user|actor|nomade/i.test(dump)) throw new Error("identité dans l'état");
});

check("URL d'autorisation : point d'accès Google et paramètres exacts", () => {
  const { state, codeChallenge } = createStateStore().issue();
  const url = new URL(buildAuthorizeUrl({ config, state, codeChallenge }));
  const p = Object.fromEntries(url.searchParams);
  if (`${url.origin}${url.pathname}` !== GOOGLE_AUTHORIZE_ENDPOINT) throw new Error(url.href);
  const expected = { client_id: ENV.YOUTUBE_OAUTH_CLIENT_ID, redirect_uri: ENV.YOUTUBE_OAUTH_REDIRECT_URI, response_type: "code", scope: REQUESTED_SCOPES.join(" "), state, code_challenge: codeChallenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent" };
  if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error(`paramètres : ${Object.keys(p)}`);
  for (const [k, v] of Object.entries(expected)) if (p[k] !== v) throw new Error(`${k} = ${p[k]}`);
});

check("URL : lecture seule, sans secret, sans identité, sans paramètre superflu", () => {
  const { state, codeChallenge } = createStateStore().issue();
  const href = buildAuthorizeUrl({ config, state, codeChallenge });
  const decoded = decodeURIComponent(href);
  for (const secret of [SECRET, KEY_B64, "client_secret", "code_verifier"]) if (href.includes(secret) || decoded.includes(secret)) throw new Error(`fuite : ${secret}`);
  for (const forbidden of ["force-ssl", "youtube.upload", "auth/youtube ", "openid", "email", "profile", "channel", "login_hint", "include_granted_scopes", "monetary"]) if (decoded.includes(forbidden)) throw new Error(`présent : ${forbidden}`);
  if (!decoded.includes(YOUTUBE_READONLY_SCOPE)) throw new Error("scope de lecture absent");
});

check("URL : entrées invalides refusées (scopes d'écriture, état, challenge, configuration)", () => {
  const { state, codeChallenge } = createStateStore().issue();
  throwsWith(() => buildAuthorizeUrl({ config, state, codeChallenge, scopes: [YOUTUBE_READONLY_SCOPE, "https://www.googleapis.com/auth/youtube.force-ssl"] }), "SCOPES_INVALID");
  throwsWith(() => buildAuthorizeUrl({ config, state, codeChallenge, scopes: [] }), "SCOPES_INVALID");
  throwsWith(() => buildAuthorizeUrl({ config, state: "court", codeChallenge }), "AUTHORIZE_STATE_INVALID");
  throwsWith(() => buildAuthorizeUrl({ config, state, codeChallenge: "x" }), "AUTHORIZE_CHALLENGE_INVALID");
  throwsWith(() => buildAuthorizeUrl({ config: null, state, codeChallenge }), "AUTHORIZE_CONFIG_INVALID");
  throwsWith(() => buildAuthorizeUrl({ config: { clientId: 1 }, state, codeChallenge }), "AUTHORIZE_CONFIG_INVALID");
});

check("URL : un état ou un challenge forgé ne peut pas injecter de paramètre", () => {
  const { codeChallenge } = createStateStore().issue();
  throwsWith(() => buildAuthorizeUrl({ config, state: `${"a".repeat(30)}&scope=x&aaaa`, codeChallenge }), "AUTHORIZE_STATE_INVALID");
  throwsWith(() => buildAuthorizeUrl({ config, state: "a".repeat(43), codeChallenge: `${"a".repeat(30)}&x=1&aaaaaaaaa` }), "AUTHORIZE_CHALLENGE_INVALID");
});

done("youtube-agent-oauth-state-smoke");
