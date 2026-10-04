// Smoke R19.3 — échange du code d'autorisation (seul appel réseau, simulé). Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-oauth-exchange-smoke.js

import { exchangeAuthorizationCode, GOOGLE_TOKEN_ENDPOINT, GoogleOAuthError } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { readOAuthConfig, YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { createPkcePair } from "../src/youtube-agent/connectors/youtube/auth/service.js";
import { check, done } from "./youtube-agent-test-helpers.js";

const SECRET = "test-client-secret-001";
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:4177/oauth/youtube/callback",
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY_B64
};
const { config } = readOAuthConfig(ENV);
const CODE = "4/0AeaYSHTestAuthorizationCode_123-abc";
const ACCESS = "test-access-token-001";
const REFRESH = "test-refresh-token-001";
const { verifier } = createPkcePair();
const GOOD = { access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: `${YOUTUBE_READONLY_SCOPE} ${YT_ANALYTICS_READONLY_SCOPE}`, token_type: "Bearer" };

const reply = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const run = (fetchImpl, over = {}) => exchangeAuthorizationCode({ config, code: CODE, codeVerifier: verifier, fetchImpl, ...over });
const failure = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };
const ok = async (name, fn) => { try { await fn(); check(name, () => {}); } catch (e) { check(name, () => { throw e; }); } };

await ok("requête : un seul appel, vers l'échange OAuth, avec les paramètres attendus", async () => {
  const calls = [];
  await run(async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(GOOD), { status: 200 }); });
  if (calls.length !== 1) throw new Error(`${calls.length} appels`);
  const { url, init } = calls[0];
  if (url !== GOOGLE_TOKEN_ENDPOINT || init.method !== "POST" || init.redirect !== "error" || !init.signal) throw new Error("requête");
  if (init.headers["content-type"] !== "application/x-www-form-urlencoded" || init.headers.authorization || init.headers.Authorization) throw new Error("en-têtes");
  const p = Object.fromEntries(new URLSearchParams(init.body));
  const expected = { code: CODE, client_id: ENV.YOUTUBE_OAUTH_CLIENT_ID, client_secret: SECRET, redirect_uri: ENV.YOUTUBE_OAUTH_REDIRECT_URI, grant_type: "authorization_code", code_verifier: verifier };
  if (JSON.stringify(Object.keys(p).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error(Object.keys(p).join());
  for (const [k, v] of Object.entries(expected)) if (p[k] !== v) throw new Error(`${k} incorrect`);
});

await ok("succès : seul le refresh token et les scopes sont retournés, jamais l'access token", async () => {
  const r = await run(reply(200, GOOD));
  if (r.refreshToken !== REFRESH || r.scopes.join() !== [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE].join()) throw new Error("résultat");
  if (Object.keys(r).sort().join() !== "refreshToken,scopes") throw new Error(`champs : ${Object.keys(r)}`);
  const dump = JSON.stringify(r);
  for (const leaked of [ACCESS, "access_token", "id_token"]) if (dump.includes(leaked)) throw new Error(`fuite : ${leaked}`);
});

await ok("consentement partiel : lecture YouTube seule acceptée ; sans elle, ou avec un scope étranger, refusé", async () => {
  const r = await run(reply(200, { ...GOOD, scope: YOUTUBE_READONLY_SCOPE }));
  if (r.scopes.join() !== YOUTUBE_READONLY_SCOPE) throw new Error("lecture seule");
  for (const scope of [YT_ANALYTICS_READONLY_SCOPE, "https://www.googleapis.com/auth/youtube.force-ssl", `${YOUTUBE_READONLY_SCOPE} https://www.googleapis.com/auth/youtube.upload`, "", undefined, 42]) {
    const e = await failure(() => run(reply(200, { ...GOOD, scope })));
    if (e?.code !== "OAUTH_SCOPE_INVALID") throw new Error(`scope accepté : ${String(scope)}`);
  }
});

await ok("refresh token absent : refusé", async () => {
  for (const refresh_token of [undefined, "", null, 5]) {
    const e = await failure(() => run(reply(200, { ...GOOD, refresh_token })));
    if (e?.code !== "OAUTH_NO_REFRESH_TOKEN") throw new Error(`accepté : ${String(refresh_token)}`);
  }
});

await ok("échange refusé : chaque cause Google devient un code précis", async () => {
  const cases = [
    [400, { error: "invalid_grant", error_description: "Bad Request" }, "OAUTH_INVALID_GRANT"],
    [401, { error: "invalid_client" }, "OAUTH_INVALID_CLIENT"],
    [401, { error: "unauthorized_client" }, "OAUTH_INVALID_CLIENT"],
    [400, { error: "redirect_uri_mismatch" }, "OAUTH_REDIRECT_MISMATCH"],
    [400, { error: "invalid_request" }, "OAUTH_REJECTED"],
    [403, {}, "OAUTH_REJECTED"],
    [500, { error: "backend_error" }, "OAUTH_UPSTREAM"],
    [503, "indisponible", "OAUTH_BAD_RESPONSE"]
  ];
  for (const [status, body, expected] of cases) {
    const e = await failure(() => run(reply(status, body)));
    if (!(e instanceof GoogleOAuthError) || e.code !== expected) throw new Error(`${status} ${JSON.stringify(body)} → ${e?.code}`);
  }
});

await ok("réponse invalide, trop longue, réseau et délai : codes dédiés", async () => {
  const bad = ["<html>", "", "[]", "null"];
  for (const body of bad) {
    const e = await failure(() => run(reply(200, body)));
    if (!["OAUTH_BAD_RESPONSE", "OAUTH_NO_REFRESH_TOKEN"].includes(e?.code)) throw new Error(`réponse ${JSON.stringify(body)} → ${e?.code}`);
  }
  if ((await failure(() => run(reply(200, JSON.stringify({ ...GOOD, padding: "x".repeat(70_000) })))))?.code !== "OAUTH_BAD_RESPONSE") throw new Error("réponse trop longue acceptée");
  if ((await failure(() => run(async () => { throw new TypeError("fetch failed"); })))?.code !== "OAUTH_NETWORK") throw new Error("réseau");
  if ((await failure(() => run(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); })))?.code !== "OAUTH_TIMEOUT") throw new Error("délai");
  if ((await failure(() => run(async () => { throw Object.assign(new Error("a"), { name: "AbortError" }); })))?.code !== "OAUTH_TIMEOUT") throw new Error("abandon");
});

await ok("entrées invalides refusées avant tout appel réseau", async () => {
  let calls = 0;
  const f = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  for (const over of [{ code: "" }, { code: "court" }, { code: "avec espace dans le code" }, { code: "x".repeat(2049) }, { codeVerifier: "court" }, { codeVerifier: "a".repeat(129) }, { codeVerifier: undefined }, { config: null }, { config: { clientId: "x" } }]) {
    const e = await failure(() => run(f, over));
    if (e?.code !== "OAUTH_BAD_REQUEST") throw new Error(`accepté : ${JSON.stringify(over).slice(0, 40)}`);
  }
  if (calls !== 0) throw new Error("appel réseau malgré l'entrée invalide");
});

await ok("aucune fuite : les erreurs ne portent ni code, ni vérificateur, ni secret, ni corps de réponse", async () => {
  const scenarios = [reply(400, { error: "invalid_grant", error_description: `${CODE} ${verifier} ${SECRET}` }), reply(500, `${CODE} ${SECRET} ${REFRESH}`), async () => { throw new Error(`${CODE} ${SECRET}`); }];
  for (const s of scenarios) {
    const e = await failure(() => run(s));
    const dump = `${e.message} ${e.stack?.split("\n")[0]} ${JSON.stringify(e)} ${Object.getOwnPropertyNames(e).map(n => String(e[n])).join(" ")}`;
    for (const secret of [CODE, verifier, SECRET, REFRESH, ACCESS, KEY_B64]) if (dump.includes(secret)) throw new Error("fuite dans l'erreur");
    if (!/^OAUTH_[A-Z_]+$/.test(e.code) || e.message !== e.code) throw new Error("message ≠ code");
  }
});

done("youtube-agent-oauth-exchange-smoke");
