// Smoke de frontières : analyse statique de src/youtube-agent/.
// Pas de réseau hors server.js, pas de SDK, pas d'import des agents/services,
// écritures de fichiers confinées à atomic-json.js, façade sans logique métier.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-boundaries-smoke.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check, done } from "./youtube-agent-test-helpers.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "youtube-agent");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

const files = walk(SRC).map(file => ({
  file,
  rel: path.relative(SRC, file),
  code: fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}));

const imports = code => [...code.matchAll(/(?:import\s+(?:[^'"]*?from\s+)?|import\()\s*["']([^"']+)["']/g)].map(m => m[1]);

check("des fichiers sont analysés", () => {
  if (files.length < 10) throw new Error("trop peu de fichiers");
});

check("aucun SDK, socket, DNS, https ni sous-processus", () => {
  const banned = ["@anthropic-ai/sdk", "node:net", "node:dns", "node:https", "node:child_process", "https", "net", "dns", "child_process", "node:worker_threads", "node:cluster"];
  for (const f of files) for (const i of imports(f.code)) if (banned.includes(i)) throw new Error(`${f.rel} importe ${i}`);
});

check("node:http uniquement dans server.js ; aucun fetch/XMLHttpRequest/WebSocket", () => {
  for (const f of files) {
    if (imports(f.code).some(i => i === "node:http" || i === "http") && f.rel !== "server.js") throw new Error(`${f.rel} importe http`);
    if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|\.connect\s*\(/.test(f.code)) throw new Error(`${f.rel} : appel réseau`);
  }
});

check("imports relatifs : seuls le pipeline (resume.js) et le module lui-même", () => {
  for (const f of files) {
    for (const i of imports(f.code)) {
      if (!i.startsWith(".")) continue;
      const target = path.resolve(path.dirname(f.file), i);
      if (target.startsWith(SRC)) continue;
      if (target !== path.resolve(SRC, "..", "orchestrator", "resume.js")) throw new Error(`${f.rel} importe ${i}`);
    }
  }
});

check("seuls AGENT_ORDER, LOCK_FILE, isValidProductionId, productionMode sont importés du pipeline", () => {
  const allowed = new Set(["AGENT_ORDER", "LOCK_FILE", "isValidProductionId", "productionMode"]);
  for (const f of files) {
    for (const m of f.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:\.\.\/)+orchestrator\/resume\.js["']/g)) {
      for (const name of m[1].split(",").map(s => s.trim()).filter(Boolean)) if (!allowed.has(name)) throw new Error(`${f.rel} importe ${name}`);
    }
  }
});

check("écritures de fichiers confinées à atomic-json.js", () => {
  const writes = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|rm|rmSync|unlink|unlinkSync|mkdir|mkdirSync|openSync|copyFile|copyFileSync|symlink|chmod|truncate)\b\s*\(/;
  for (const f of files) {
    if (f.rel === "atomic-json.js") continue;
    if (writes.test(f.code.replace(/\bfs\.readFileSync\b/g, ""))) throw new Error(`${f.rel} écrit directement`);
  }
});

check("environnement : seul bridge-config.js lit le jeton du pont ; aucun .env, aucun secret", () => {
  for (const f of files) {
    // Exception unique, bornée : la configuration OAuth lit exactement ses cinq variables nommées.
    if (f.rel === "connectors/youtube/auth/config.js") {
      const allowedNames = new Set(["OAUTH_CLIENT_ID_ENV", "OAUTH_CLIENT_SECRET_ENV", "OAUTH_REDIRECT_URI_ENV", "OAUTH_RETURN_URL_ENV", "OAUTH_TOKEN_KEY_ENV"]);
      const names = [...f.code.matchAll(/\benv\[(\w+)\]/g)].map(m => m[1]);
      if (names.length !== 5 || new Set(names).size !== 5 || names.some(n => !allowedNames.has(n))) throw new Error("config OAuth : lecture d'environnement non conforme");
      if ((f.code.match(/process\.env/g) ?? []).length !== 1) throw new Error("config OAuth : process.env doit apparaître une seule fois (valeur par défaut)");
      continue;
    }
    if (f.rel === "bridge-config.js") {
      const uses = f.code.match(/process\.env|env\[[^\]]*\]/g) ?? [];
      if (uses.length !== 2 || !/env\[BRIDGE_TOKEN_ENV\]/.test(f.code)) throw new Error("bridge-config.js : lecture d'environnement non conforme");
      continue;
    }
    if (/\.env\b|process\.env/i.test(f.code)) throw new Error(`${f.rel} : accès à l'environnement`);
    // journal.js contient la liste de noms de champs sensibles qu'il refuse d'écrire.
    if (!["journal.js", "connectors/youtube/auth/config.js", "connectors/youtube/auth/google-oauth.js", "connectors/youtube/channel.js"].includes(f.rel) && /API_KEY|SECRET|PASSWORD/i.test(f.code)) throw new Error(`${f.rel} : référence sensible`);
  }
});

check("réseau Google : seuls google-oauth.js (échange du code) et channel.js (chaîne et vidéos) appellent fetchImpl", () => {
  for (const f of files) {
    if (f.rel === "connectors/youtube/auth/google-oauth.js" || f.rel === "connectors/youtube/channel.js") continue;
    if (/fetchImpl\s*\(|globalThis\.fetch/.test(f.code)) throw new Error(`${f.rel} : appel réseau hors google-oauth.js`);
  }
  const oauth = files.find(f => f.rel === "connectors/youtube/auth/google-oauth.js");
  const calls = oauth.code.match(/fetchImpl\s*\(/g) ?? [];
  if (calls.length !== 1 || !/GOOGLE_TOKEN_ENDPOINT/.test(oauth.code) || /youtube\/v3|youtubeanalytics|playlistItems|channels\.list/i.test(oauth.code)) throw new Error("google-oauth.js : un seul appel, vers l'échange OAuth uniquement");
  // R20.1 / R20.2 : un seul point d'appel réseau, vers l'échange OAuth, youtube/v3/channels et youtube/v3/playlistItems uniquement.
  const channel = files.find(f => f.rel === "connectors/youtube/channel.js");
  // Les adresses sont lues dans le source brut : le retrait des commentaires coupe aussi « https:// ».
  const urls = fs.readFileSync(channel.file, "utf8").match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^"'`\s]*/g) ?? [];
  if ((channel.code.match(/fetchImpl\s*\(/g) ?? []).length !== 1 || urls.join() !== "https://www.googleapis.com/youtube/v3/channels,https://www.googleapis.com/youtube/v3/playlistItems") throw new Error("channel.js : endpoints non conformes");
  if (/youtubeanalytics|commentThreads|\/search|\/videos|\/subscriptions|\/playlists|method:\s*"(?:PUT|DELETE|PATCH)"/i.test(channel.code)) throw new Error("channel.js : endpoint ou méthode interdits");
});

check("adresses Google uniquement dans le connecteur YouTube", () => {
  for (const f of files) {
    if (f.rel.startsWith("connectors/youtube/")) continue;
    if (/googleapis\.com|accounts\.google\.com|youtube\.com|oauth2\.googleapis/i.test(f.code)) throw new Error(`${f.rel} : adresse Google hors connecteur`);
  }
});

check("serveur et pont : aucun import direct des moteurs ni des modules de données (façade seule)", () => {
  const forbidden = /(?:^|\/)(?:planner|approvals|engines|journal|videos-registry|productions-reader|studio-models|settings-reader|atomic-json|paths|capabilities)\.js$|(?:^|\/)(?:workflow|memory|comments|analytics|learning)\//;
  const allowed = {
    "agent-api.js": ["./guard.js", "./session.js", "./channels.js", "./config.js", "./bridge-config.js"],
    "server.js": ["./config.js", "./channels.js", "./guard.js", "./session.js", "./agent.js", "./agent-api.js", "./bridge-config.js", "./views.js", "./connectors/youtube/auth/service.js", "./connectors/youtube/channel.js"]
  };
  for (const rel of Object.keys(allowed)) {
    const f = files.find(x => x.rel === rel);
    if (!f) throw new Error(`${rel} introuvable`);
    for (const i of imports(f.code)) {
      if (!i.startsWith(".")) continue;
      if (forbidden.test(i)) throw new Error(`${rel} importe directement ${i}`);
      if (!allowed[rel].includes(i)) throw new Error(`${rel} : import non prévu ${i}`);
    }
  }
});

check("le pont est en lecture seule : aucune route non-GET, aucune écriture", () => {
  const api = files.find(f => f.rel === "agent-api.js");
  if (!/method_not_allowed/.test(api.code) || /\.(?:linkVideo|advance|execute)\(/.test(api.code)) throw new Error("le pont expose une action");
});

check("aucun eval / Function dynamique", () => {
  for (const f of files) if (/\beval\s*\(|new\s+Function\s*\(/.test(f.code)) throw new Error(`${f.rel} : exécution dynamique`);
});

const facade = files.find(f => f.rel === "agent.js");

if (facade) {
  check("façade : aucun prompt, aucun fournisseur, uniquement des délégations", () => {
    if (/\bprompt\b|anthropic|elevenlabs|claude|openai|messages\.create/i.test(facade.code)) throw new Error("terme de logique métier");
    for (const i of imports(facade.code)) if (!i.startsWith(".")) throw new Error(`import externe ${i}`);
    if (facade.code.split("\n").length > 220) throw new Error("façade trop volumineuse");
  });
}

done("youtube-agent-boundaries-smoke");
