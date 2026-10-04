// Smoke du pont local (agent-api.js) : garde, lecture seule, aucune fuite.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-bridge-smoke.js

import fs from "node:fs";
import path from "node:path";

import { createBridgeHandler, BRIDGE_ROUTES } from "../src/youtube-agent/agent-api.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createYoutubeAuthService } from "../src/youtube-agent/connectors/youtube/auth/service.js";
import { readBridgeToken, isValidBridgeToken, BRIDGE_CONTRACT, BRIDGE_TOKEN_ENV } from "../src/youtube-agent/bridge-config.js";
import { tmpRoot, cleanup, check, done, makeProduction, PROD_A, PROD_B } from "./youtube-agent-test-helpers.js";

const PORT = 4777;
const TOKEN = "bridge-token-0123456789abcdef0123456789abcdef";
const root = tmpRoot("bridge");
const SECRET = "test-client-secret-bridge";
const oauthEnv = port => ({
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: SECRET,
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64")
});
makeProduction(root, PROD_A, { mode: "full", input: { title: "<script>alert(1)</script>" } });
makeProduction(root, PROD_B, { mode: "test" });
fs.mkdirSync(path.join(root, "config"), { recursive: true });
fs.writeFileSync(path.join(root, "config", "pipeline.json"), JSON.stringify({ project: { language: "fr", api_key: "sk-LEAKLEAKLEAKLEAK12345" }, providers: { voice: { kind: "elevenlabs", voice_id: "v", secret: "TOPSECRETVALUE" } } }));

const agent = createYouTubeAgent({ root, youtubeAuth: createYoutubeAuthService({ root, port: PORT, env: oauthEnv(PORT) }) });
const handle = createBridgeHandler({ agent, port: PORT, token: TOKEN, now: () => new Date("2026-06-01T10:00:00Z") });
const good = { host: `127.0.0.1:${PORT}`, "x-agent-bridge-token": TOKEN };
const get = (p, headers = good, method = "GET") => handle({ method, url: p, headers });
const json = r => JSON.parse(r.body);

check("contrat du jeton : fort requis, sinon pont désactivé", () => {
  if (readBridgeToken({}) !== null || readBridgeToken({ [BRIDGE_TOKEN_ENV]: "court" }) !== null || readBridgeToken({ [BRIDGE_TOKEN_ENV]: "a b".repeat(20) }) !== null) throw new Error("faible accepté");
  if (readBridgeToken({ [BRIDGE_TOKEN_ENV]: TOKEN }) !== TOKEN || !isValidBridgeToken(TOKEN)) throw new Error("valide refusé");
});

check("santé : sans jeton, sans donnée, indique l'état du pont", () => {
  const r = get("/api/v1/health", { host: good.host });
  const b = json(r);
  if (r.status !== 200 || b.schema !== BRIDGE_CONTRACT || b.bridge_enabled !== true || b.auth_required !== true || Object.keys(b).some(k => /data|productions|channel/.test(k))) throw new Error(r.body);
  const off = createBridgeHandler({ agent, port: PORT, token: null })({ method: "GET", url: "/api/v1/health", headers: { host: good.host } });
  if (json(off).bridge_enabled !== false) throw new Error("désactivé non signalé");
});

check("routes : les neuf vues de lecture et la connexion Google", () => {
  if (BRIDGE_ROUTES.join() !== "system,productions,pipeline,planner,comments,analytics,learning,journal,settings,youtube_login") throw new Error(BRIDGE_ROUTES.join());
});

check("jeton absent / invalide → 401 distincts ; pont désactivé → 503", () => {
  if (get("/api/v1/system", { host: good.host }).status !== 401 || json(get("/api/v1/system", { host: good.host })).error !== "token_missing") throw new Error("absent");
  const bad = get("/api/v1/system", { ...good, "x-agent-bridge-token": "x".repeat(44) });
  if (bad.status !== 401 || json(bad).error !== "token_invalid") throw new Error("invalide");
  const off = createBridgeHandler({ agent, port: PORT, token: null })({ method: "GET", url: "/api/v1/system", headers: good });
  if (off.status !== 503 || json(off).error !== "bridge_disabled") throw new Error("503");
});

check("Host étranger, Origin présent (même avec bon jeton), méthodes non-GET refusés", () => {
  if (get("/api/v1/system", { ...good, host: "evil.test" }).status !== 403) throw new Error("host");
  if (get("/api/v1/system", { ...good, host: "127.0.0.1" }).status !== 403) throw new Error("host sans port");
  if (get("/api/v1/system", { ...good, origin: "http://127.0.0.1:3000" }).status !== 403) throw new Error("origin");
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) if (get("/api/v1/system", good, m).status !== 405) throw new Error(m);
});

check("chemins inconnus et traversées → 404, paramètre de chaîne refusé, production invalide → 400", () => {
  for (const p of ["/api/v1/nope", "/api/v1/", "/api/v1/../package.json", "/api/v1/system/../../x", "/other", "/api/v1/%2e%2e/x"]) if (get(p).status !== 404) throw new Error(`${p} → ${get(p).status}`);
  for (const q of ["channel=nomade", "channel=autre", "channel=", "channel=../x"]) {
    const r = get(`/api/v1/system?${q}`);
    if (r.status !== 400 || json(r).error !== "unsupported_parameter") throw new Error(`${q} accepté`);
  }
  if (get("/api/v1/pipeline?production_id=../../x").status !== 400) throw new Error("production");
});

check("chaque route répond avec l'enveloppe du contrat", () => {
  for (const name of BRIDGE_ROUTES) {
    const r = get(`/api/v1/${name}`);
    const b = json(r);
    if (r.status !== 200 || b.schema !== BRIDGE_CONTRACT || b.route !== name || b.channel_id !== "nomade" || b.generated_at !== "2026-06-01T10:00:00.000Z" || typeof b.data !== "object") throw new Error(`${name}: ${r.body.slice(0, 120)}`);
    if (r.headers["cache-control"] !== "no-store" || !r.headers["content-type"].startsWith("application/json")) throw new Error(`${name} en-têtes`);
  }
});

check("include_tests, canal et limite transmis à la façade", () => {
  if (json(get("/api/v1/productions")).data.items.some(i => i.id === PROD_B)) throw new Error("tests visibles par défaut");
  if (!json(get("/api/v1/productions?include_tests=1")).data.items.some(i => i.id === PROD_B)) throw new Error("include_tests");
});

check("aucune écriture sur disque par les routes de lecture", () => {
  if (fs.existsSync(path.join(root, "data"))) throw new Error("data/ créé par le pont");
});

check("aucun secret ni jeton dans les réponses ; titres hostiles transportés tels quels (échappés côté UI)", () => {
  const payload = BRIDGE_ROUTES.map(n => get(`/api/v1/${n}`).body).join("\n") + get("/api/v1/system", { host: good.host }).body;
  if (/sk-LEAK|TOPSECRET|api_key|secret/i.test(payload) || payload.includes(TOKEN)) throw new Error("fuite");
  if (!json(get("/api/v1/productions")).data.items[0].title.includes("<script>")) throw new Error("titre altéré");
});

check("erreur interne : 500 sans détail", () => {
  const broken = createBridgeHandler({ agent: { system() { throw new Error("chemin /Users/mac/secret"); } }, port: PORT, token: TOKEN })({ method: "GET", url: "/api/v1/system", headers: good });
  if (broken.status !== 500 || broken.body.includes("/Users") || json(broken).error !== "internal_error") throw new Error(broken.body);
});

check("youtube_login : URL Google construite par l'agent, sans secret", () => {
  const r = get("/api/v1/youtube_login");
  const url = new URL(json(r).data.authorizeUrl);
  const q = Object.fromEntries(url.searchParams);
  if (r.status !== 200 || url.origin + url.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error(r.body.slice(0, 160));
  if (q.client_id !== oauthEnv(PORT).YOUTUBE_OAUTH_CLIENT_ID || q.redirect_uri !== oauthEnv(PORT).YOUTUBE_OAUTH_REDIRECT_URI || q.response_type !== "code") throw new Error("paramètres");
  if (!q.state || !q.scope || q.access_type !== "offline" || q.prompt !== "consent") throw new Error("paramètres OAuth");
  if (r.body.includes(SECRET) || /client_secret|refresh_token|access_token/.test(r.body)) throw new Error("fuite");
  if (fs.existsSync(path.join(root, "data"))) throw new Error("écriture disque");
});

check("youtube_login : connexion non configurée → 500 sans détail", () => {
  const off = createBridgeHandler({ agent: createYouTubeAgent({ root, youtubeAuth: createYoutubeAuthService({ root, port: PORT, env: {} }) }), port: PORT, token: TOKEN })({ method: "GET", url: "/api/v1/youtube_login", headers: good });
  if (off.status !== 500 || json(off).error !== "internal_error") throw new Error(off.body);
});

cleanup(root);
done("youtube-agent-bridge-smoke");
