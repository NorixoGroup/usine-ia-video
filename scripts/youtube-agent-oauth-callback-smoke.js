// Smoke R19.3 — connexion Google de bout en bout (Google simulé) : URL, callback,
// état, échange, stockage, absence de fuite. Aucun appel réel. Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-oauth-callback-smoke.js

import fs from "node:fs";
import path from "node:path";

import { createHandler } from "../src/youtube-agent/server.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createYoutubeAuthService, challengeFor, STATE_TTL_MS } from "../src/youtube-agent/connectors/youtube/auth/service.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { loadRefreshToken, readConnectionMeta } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const SESSION = "s".repeat(64);
const KEY = Buffer.alloc(32, 7);
const SECRET = "test-client-secret-001";
const CODE = "4/0AeaYSHTestAuthorizationCode_123-abc";
const ACCESS = "test-access-token-001";
const REFRESH = "test-refresh-token-001";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const GOOD_TOKENS = { access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, scope: `${YOUTUBE_READONLY_SCOPE} ${YT_ANALYTICS_READONLY_SCOPE}`, token_type: "Bearer" };
const HOST = { host: `127.0.0.1:${PORT}` };

const urls = [];
const env = { time: Date.parse("2026-06-01T10:00:00Z") };

function setup({ tokens = GOOD_TOKENS, status = 200, body = null, envOverride = ENV, port = PORT } = {}) {
  const root = tmpRoot("oauth-cb");
  const exchanges = [];
  const current = { tokens };
  const fetchImpl = async (url, init) => {
    urls.push(url);
    exchanges.push(Object.fromEntries(new URLSearchParams(init.body)));
    return new Response(JSON.stringify(body ?? current.tokens), { status });
  };
  const connector = createYoutubeAuthService({ root, port, env: envOverride, fetchImpl, now: () => new Date(env.time) });
  const handle = createHandler({ root, port: PORT, token: SESSION, youtubeAuth: connector });

  return { root, exchanges, current, handle, connector, agent: createYouTubeAgent({ root, youtubeAuth: connector, now: () => new Date(env.time) }) };
}

const login = ctx => ctx.handle({ method: "GET", url: `/oauth/youtube/login?t=${SESSION}`, headers: HOST });
const callback = (ctx, query, headers = HOST, method = "GET") => ctx.handle({ method, url: `/oauth/youtube/callback?${new URLSearchParams(query)}`, headers });
const params = location => Object.fromEntries(new URL(location).searchParams);
// Le navigateur revient toujours sur Nomad Studio ; le résultat détaillé se lit sur le connecteur.
const RETURN = ENV.YOUTUBE_OAUTH_RETURN_URL;
const reasonOf = async (ctx, query) => (await ctx.connector.completeCallback(query)).reason;
const files = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);
const diskDump = root => files(path.join(root, "data")).map(f => `${f}\n${fs.readFileSync(f, "utf8")}`).join("\n");
const stored = ctx => readConnectionMeta({ root: ctx.root }).status;
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };

async function fullFlow(ctx) {
  const l = login(ctx);
  const p = params(l.headers.location);
  const out = await callback(ctx, { code: CODE, state: p.state });

  return { p, out };
}

async function fullOutcome(ctx) {
  const p = params(login(ctx).headers.location);

  return ctx.connector.completeCallback({ code: CODE, state: p.state });
}

await asyncCheck("login : jeton de session obligatoire ; redirection 303 vers Google avec état, PKCE et lecture seule", async () => {
  const ctx = setup();
  if (ctx.handle({ method: "GET", url: "/oauth/youtube/login", headers: HOST }).status !== 403) throw new Error("login sans jeton accepté");
  if (ctx.handle({ method: "GET", url: "/oauth/youtube/login?t=faux", headers: HOST }).status !== 403) throw new Error("mauvais jeton accepté");
  if (ctx.handle({ method: "GET", url: `/oauth/youtube/login?t=${SESSION}`, headers: { host: "evil.test" } }).status !== 403) throw new Error("mauvais Host accepté");
  const out = login(ctx);
  if (out.status !== 303) throw new Error(`statut ${out.status}`);
  const p = params(out.headers.location);
  if (!out.headers.location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")) throw new Error("hôte");
  if (p.response_type !== "code" || p.access_type !== "offline" || p.prompt !== "consent" || p.code_challenge_method !== "S256" || p.redirect_uri !== ENV.YOUTUBE_OAUTH_REDIRECT_URI) throw new Error("paramètres");
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.state) || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) throw new Error("état / challenge");
  if (p.scope !== `${YOUTUBE_READONLY_SCOPE} ${YT_ANALYTICS_READONLY_SCOPE}`) throw new Error("scopes");
  if (out.headers["referrer-policy"] !== "no-referrer" || out.headers["cache-control"] !== "no-store") throw new Error("en-têtes");
  for (const secret of [SECRET, SESSION, ENV.YOUTUBE_OAUTH_TOKEN_KEY]) if (decodeURIComponent(out.headers.location).includes(secret)) throw new Error("fuite dans l'URL Google");
  cleanup(ctx.root);
});

await asyncCheck("callback valide : échange réussi, refresh token chiffré, retour sur Nomad Studio sans paramètre", async () => {
  const ctx = setup();
  const { p, out } = await fullFlow(ctx);
  if (out.status !== 303 || out.headers.location !== RETURN) throw new Error(out.headers.location);
  if (ctx.exchanges.length !== 1) throw new Error(`${ctx.exchanges.length} échanges`);
  const x = ctx.exchanges[0];
  if (x.code !== CODE || x.grant_type !== "authorization_code" || x.redirect_uri !== ENV.YOUTUBE_OAUTH_REDIRECT_URI) throw new Error("échange");
  if (challengeFor(x.code_verifier) !== p.code_challenge) throw new Error("vérificateur non lié au challenge de l'URL");
  if (loadRefreshToken({ root: ctx.root, key: KEY }) !== REFRESH) throw new Error("refresh token non stocké");
  const meta = readConnectionMeta({ root: ctx.root });
  if (meta.status !== "connected" || meta.scopes.length !== 2) throw new Error(JSON.stringify(meta));
  cleanup(ctx.root);
});

await asyncCheck("aucun access token ni secret sur disque ; refresh token chiffré seulement", async () => {
  const ctx = setup();
  await fullFlow(ctx);
  const dump = diskDump(ctx.root);
  for (const secret of [ACCESS, REFRESH, SECRET, CODE, ENV.YOUTUBE_OAUTH_TOKEN_KEY, "access_token"]) if (dump.includes(secret)) throw new Error(`présent sur disque : ${secret.slice(0, 12)}`);
  const list = files(path.join(ctx.root, "data")).map(f => path.relative(path.join(ctx.root, "data"), f));
  if (list.join() !== path.join("youtube-agent", "channels", "nomade", "oauth", "youtube.json")) throw new Error(`fichiers : ${list}`);
  const file = files(path.join(ctx.root, "data"))[0];
  if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error("droits du fichier");
  cleanup(ctx.root);
});

await asyncCheck("aucune fuite dans les réponses, la page ou le statut", async () => {
  const ctx = setup();
  const { out } = await fullFlow(ctx);
  const page = ctx.handle({ method: "GET", url: `/?t=${SESSION}`, headers: HOST });
  const status = JSON.stringify(ctx.agent.youtubeStatus());
  const everything = `${JSON.stringify(out)}\n${page.body}\n${JSON.stringify(page.headers)}\n${status}`;
  for (const secret of [ACCESS, REFRESH, SECRET, CODE, SESSION, ENV.YOUTUBE_OAUTH_TOKEN_KEY, "ciphertext", "refresh_token"]) if (JSON.stringify(out).includes(secret) || (secret !== SESSION && everything.includes(secret))) throw new Error(`fuite : ${secret.slice(0, 12)}`);
  if (!page.body.includes("Connectée le") || !page.body.includes("lecture YouTube")) throw new Error("page de succès");
  // R20.5 lot 2 : la mention « Aucune donnée YouTube n'est encore lue » est remplacée par l'état du miroir local.
  if (!page.body.includes("Se reconnecter à Google") || !page.body.includes("Non lue : aucune synchronisation n'a encore été faite.") || !page.body.includes("Synchroniser la chaîne")) throw new Error("bouton ou mention");
  cleanup(ctx.root);
});

await asyncCheck("page avant connexion : bouton « Se connecter à Google », aucun secret", async () => {
  const ctx = setup();
  const page = ctx.handle({ method: "GET", url: `/?t=${SESSION}`, headers: HOST });
  if (page.status !== 200 || !page.body.includes("Se connecter à Google") || !page.body.includes(`/oauth/youtube/login?t=${SESSION}`)) throw new Error("bouton absent");
  for (const secret of [SECRET, ENV.YOUTUBE_OAUTH_TOKEN_KEY, ENV.YOUTUBE_OAUTH_CLIENT_ID]) if (page.body.includes(secret)) throw new Error("secret affiché");
  cleanup(ctx.root);
});

await asyncCheck("callback invalide : état inconnu, forgé, malformé ou absent → refusé, aucun échange", async () => {
  const ctx = setup();
  for (const state of [Buffer.alloc(32, 1).toString("base64url"), "court", undefined, "x".repeat(300)]) {
    const query = state === undefined ? { code: CODE } : { code: CODE, state };
    if (await reasonOf(ctx, query) !== "state_invalid") throw new Error(`état accepté : ${String(state).slice(0, 10)}`);
    const out = await callback(ctx, query);
    if (out.status !== 303 || out.headers.location !== RETURN) throw new Error("retour vers Nomad Studio");
  }
  if (ctx.exchanges.length !== 0 || stored(ctx) !== "not_connected") throw new Error("échange ou stockage malgré un état invalide");
  cleanup(ctx.root);
});

await asyncCheck("état expiré : refusé sans échange", async () => {
  const ctx = setup();
  const p = params(login(ctx).headers.location);
  env.time += STATE_TTL_MS + 1;
  const reason = await reasonOf(ctx, { code: CODE, state: p.state });
  env.time -= STATE_TTL_MS + 1;
  if (reason !== "state_invalid" || ctx.exchanges.length !== 0 || stored(ctx) !== "not_connected") throw new Error("état expiré accepté");
  cleanup(ctx.root);
});

await asyncCheck("état réutilisé : le rejeu est refusé, un seul échange a eu lieu", async () => {
  const ctx = setup();
  const { p } = await fullFlow(ctx);
  if (await reasonOf(ctx, { code: CODE, state: p.state }) !== "state_invalid" || ctx.exchanges.length !== 1) throw new Error("rejeu accepté");
  cleanup(ctx.root);
});

await asyncCheck("refus sur l'écran Google, code absent : traités, état consommé", async () => {
  const ctx = setup();
  const a = params(login(ctx).headers.location);
  const denied = await callback(ctx, { error: "access_denied", state: a.state });
  if (denied.status !== 303 || denied.headers.location !== RETURN) throw new Error("retour après refus");
  if (await reasonOf(ctx, { code: CODE, state: a.state }) !== "state_invalid") throw new Error("état non consommé après refus");
  const b = params(login(ctx).headers.location);
  if (await reasonOf(ctx, { error: "server_error", state: b.state }) !== "google_error") throw new Error("autre erreur");
  const c = params(login(ctx).headers.location);
  if (await reasonOf(ctx, { state: c.state }) !== "missing_code") throw new Error("code absent");
  const d = params(login(ctx).headers.location);
  if (await reasonOf(ctx, { code: "court", state: d.state }) !== "missing_code") throw new Error("code invalide");
  const e = params(login(ctx).headers.location);
  if (await reasonOf(ctx, { error: "access_denied", state: e.state }) !== "access_denied") throw new Error("refus sur l'écran Google");
  if (await reasonOf(ctx, { error: "access_denied", state: "x".repeat(43) }) !== "state_invalid") throw new Error("erreur sans état valide");
  if (ctx.exchanges.length !== 0 || stored(ctx) !== "not_connected") throw new Error("échange ou stockage inattendu");
  cleanup(ctx.root);
});

await asyncCheck("échange refusé par Google : rien n'est stocké, retour sur Nomad Studio, aucune fuite", async () => {
  const ctx = setup({ status: 400, body: { error: "invalid_grant", error_description: `${CODE} ${SECRET}` } });
  if ((await fullOutcome(ctx)).reason !== "exchange_failed") throw new Error("raison");
  const { out } = await fullFlow(ctx);
  if (out.headers.location !== RETURN || stored(ctx) !== "not_connected" || files(path.join(ctx.root, "data")).length !== 0) throw new Error("stockage malgré l'échec");
  for (const secret of [CODE, SECRET, ACCESS]) if (JSON.stringify(out).includes(secret)) throw new Error("fuite");
  cleanup(ctx.root);
});

await asyncCheck("réponse sans refresh token ou avec permission de lecture refusée : rien n'est stocké", async () => {
  const noRefresh = setup({ tokens: { ...GOOD_TOKENS, refresh_token: undefined } });
  if ((await fullOutcome(noRefresh)).reason !== "exchange_failed" || stored(noRefresh) !== "not_connected") throw new Error("sans refresh token");
  const analyticsOnly = setup({ tokens: { ...GOOD_TOKENS, scope: YT_ANALYTICS_READONLY_SCOPE } });
  if ((await fullOutcome(analyticsOnly)).reason !== "scope_insufficient" || stored(analyticsOnly) !== "not_connected") throw new Error("lecture YouTube refusée");
  const partial = setup({ tokens: { ...GOOD_TOKENS, scope: YOUTUBE_READONLY_SCOPE } });
  if (!(await fullOutcome(partial)).ok || readConnectionMeta({ root: partial.root }).scopes.length !== 1) throw new Error("consentement partiel");
  for (const c of [noRefresh, analyticsOnly, partial]) cleanup(c.root);
});

await asyncCheck("callback : Host exact et méthode GET obligatoires ; pas de jeton de session requis ; état préservé par un Host refusé", async () => {
  const ctx = setup();
  const p = params(login(ctx).headers.location);
  if ((await callback(ctx, { code: CODE, state: p.state }, { host: "evil.test" })).status !== 403) throw new Error("Host étranger accepté");
  if ((await callback(ctx, { code: CODE, state: p.state }, HOST, "POST")).status !== 405) throw new Error("POST accepté");
  if (ctx.exchanges.length !== 0) throw new Error("échange malgré un refus");
  const out = await callback(ctx, { code: CODE, state: p.state });
  if (out.headers.location !== RETURN || stored(ctx) !== "connected") throw new Error("état perdu après un refus de Host");
  cleanup(ctx.root);
});

await asyncCheck("reconnexion : un nouveau flux remplace le jeton, un seul fichier, l'ancien disparaît", async () => {
  const ctx = setup();
  await fullFlow(ctx);
  const SECOND = "test-refresh-token-003";
  ctx.current.tokens = { ...GOOD_TOKENS, refresh_token: SECOND };
  const again = await fullFlow(ctx);
  if (again.out.headers.location !== RETURN) throw new Error("reconnexion refusée");
  if (loadRefreshToken({ root: ctx.root, key: KEY }) !== SECOND) throw new Error("jeton non remplacé");
  if (files(path.join(ctx.root, "data")).length !== 1 || diskDump(ctx.root).includes(REFRESH)) throw new Error("ancien jeton conservé ou second fichier");
  cleanup(ctx.root);
});

await asyncCheck("configuration absente ou incohérente : connexion désactivée, noms seulement, aucune valeur", async () => {
  const none = setup({ envOverride: {} });
  const out = none.handle({ method: "GET", url: `/oauth/youtube/login?t=${SESSION}`, headers: HOST });
  if (out.status !== 503) throw new Error(`statut ${out.status}`);
  const page = none.handle({ method: "GET", url: `/?t=${SESSION}`, headers: HOST });
  if (!page.body.includes("YOUTUBE_OAUTH_CLIENT_ID") || page.body.includes("Se connecter à Google")) throw new Error("page non configurée");
  const cb = await callback(none, { code: CODE, state: "a".repeat(43) });
  if (cb.status !== 503 || cb.headers.location !== undefined || none.exchanges.length !== 0) throw new Error("callback non configuré");
  const partial = setup({ envOverride: { ...ENV, YOUTUBE_OAUTH_CLIENT_SECRET: "", YOUTUBE_OAUTH_REDIRECT_URI: "http://example.com:4177/oauth/youtube/callback" } });
  const pp = partial.handle({ method: "GET", url: `/?t=${SESSION}`, headers: HOST });
  for (const value of [ENV.YOUTUBE_OAUTH_CLIENT_ID, ENV.YOUTUBE_OAUTH_TOKEN_KEY, "example.com"]) if (pp.body.includes(value)) throw new Error("valeur affichée");
  if (!pp.body.includes("YOUTUBE_OAUTH_CLIENT_SECRET") || !pp.body.includes("YOUTUBE_OAUTH_REDIRECT_URI")) throw new Error("noms absents");
  const mismatch = setup({ port: 4999 });
  if (mismatch.agent.youtubeStatus().enabled !== false || mismatch.agent.youtubeStatus().problem.invalid.join() !== "YOUTUBE_OAUTH_REDIRECT_URI") throw new Error("port incohérent accepté");
  for (const c of [none, partial, mismatch]) cleanup(c.root);
});

await asyncCheck("échec de stockage : signalé, aucun secret affiché", async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.root, "data"), "bloque");
  const reason = (await fullOutcome(ctx)).reason;
  if (reason !== "storage_failed") throw new Error(reason);
  cleanup(ctx.root);
});

await asyncCheck("page de l'agent : paramètres youtube / reason ignorés, aucune valeur externe affichée", async () => {
  const ctx = setup();
  const page = ctx.handle({ method: "GET", url: `/?t=${SESSION}&youtube=error&reason=${encodeURIComponent("<script>alert(1)</script>")}`, headers: HOST });
  if (page.status !== 200 || /<script>alert/.test(page.body) || page.body.includes("La connexion Google a échoué.")) throw new Error("paramètres encore lus");
  cleanup(ctx.root);
});

await asyncCheck("un seul endpoint réseau appelé sur toute la suite : l'échange OAuth", async () => {
  if (urls.length === 0 || urls.some(u => u !== GOOGLE_TOKEN_ENDPOINT)) throw new Error(`endpoints : ${[...new Set(urls)]}`);
  if (urls.some(u => /youtube\.googleapis|youtubeanalytics|\/youtube\/v3/.test(u))) throw new Error("appel YouTube");
});

done("youtube-agent-oauth-callback-smoke");
