// Serveur local du YouTube Agent : 127.0.0.1 uniquement, jeton par lancement,
// aucune route de service de fichiers, aucune sortie réseau.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LOOPBACK_HOST,
  DEFAULT_PORT,
  DEFAULT_CHANNEL_ID,
  MAX_BODY_BYTES
} from "./config.js";
import { checkRequest, allowedHosts } from "./guard.js";
import { createSession } from "./session.js";
import { createYouTubeAgent } from "./agent.js";
import { createBridgeHandler } from "./agent-api.js";
import { readBridgeToken, BRIDGE_API_PREFIX } from "./bridge-config.js";
import { renderDashboard, renderError } from "./views.js";
import { createYoutubeAuthService } from "./connectors/youtube/auth/service.js";
import { createYoutubeChannel } from "./connectors/youtube/channel.js";
import { createYoutubeAnalytics } from "./connectors/youtube/analytics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const STYLE = fs.readFileSync(path.join(HERE, "ui", "style.css"), "utf8");

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function html(status, body) {
  return { status, headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8" }, body };
}

const OAUTH_LOGIN_PATH = "/oauth/youtube/login";
const OAUTH_CALLBACK_PATH = "/oauth/youtube/callback";
const YOUTUBE_SYNC_PATH = "/youtube/sync";
const YOUTUBE_ANALYTICS_SYNC_PATH = "/youtube/analytics/sync";

function redirect(location) {
  return { status: 303, headers: { ...BASE_HEADERS, location }, body: "" };
}

function parseChecklist(text) {
  return String(text ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = /^\[( |x|X)\]\s*(.*)$/.exec(line);

      return match ? { label: match[2], done: match[1].toLowerCase() === "x" } : { label: line, done: false };
    });
}

// Gestionnaire : { method, url, headers, body } → { status, headers, body }.
// Le callback OAuth (échange du code) et la synchronisation répondent par une promesse ; le reste est synchrone.
export function createHandler({ root = ROOT, port, token, youtubeAuth = null, youtubeChannel = null, youtubeAnalytics = null }) {
  const agent = createYouTubeAgent({ root, youtubeAuth, youtubeChannel, youtubeAnalytics });
  const youtubeView = () => ({ ...agent.youtubeStatus(), mirror: agent.youtubeMirror(), analytics: agent.youtubeAnalytics() });

  return function handle(req) {
    const url = new URL(req.url, `http://${LOOPBACK_HOST}:${port}`);
    const method = String(req.method ?? "GET").toUpperCase();
    const headers = req.headers ?? {};

    // Callback OAuth : appelé par le navigateur au retour de Google (donc sans jeton de session).
    // Protégé par le Host exact puis par l'état à usage unique, vérifié avant tout échange.
    if (url.pathname === OAUTH_CALLBACK_PATH) {
      if (method !== "GET") return html(405, renderError({ title: "Méthode refusée", message: "Méthode non autorisée." }));
      if (!allowedHosts(port).has(String(headers.host ?? "").toLowerCase())) return html(403, renderError({ title: "Accès refusé", message: "Requête non autorisée." }));
      // Sans configuration, aucune URL de retour n'est connue.
      if (!youtubeAuth?.enabled) return html(503, renderError({ title: "Connexion Google indisponible", message: "La configuration de la connexion Google est incomplète." }));

      return agent
        .youtubeCallback({
          code: url.searchParams.get("code") ?? undefined,
          state: url.searchParams.get("state") ?? undefined,
          error: url.searchParams.get("error") ?? undefined
        })
        // R20.5 lot 2 : aucune lecture automatique après la connexion ; la chaîne se
        // synchronise uniquement à la demande (bouton local ou commande).
        .then(() => redirect(youtubeAuth.returnUrl));
    }

    const verdict = checkRequest({ headers, searchParams: url.searchParams, port, token, method });

    if (!verdict.ok) {
      return html(verdict.status, renderError({ title: "Accès refusé", message: "Requête non autorisée." }));
    }

    const channelId = DEFAULT_CHANNEL_ID;

    if (url.pathname === "/style.css" && method === "GET") {
      return { status: 200, headers: { ...BASE_HEADERS, "content-type": "text/css; charset=utf-8" }, body: STYLE };
    }

    if (url.pathname === OAUTH_LOGIN_PATH && method === "GET") {
      try {
        return redirect(agent.youtubeLogin().authorizeUrl);
      } catch {
        return html(503, renderError({ title: "Connexion Google indisponible", message: "La configuration de la connexion Google est incomplète.", token }));
      }
    }

    if (url.pathname === "/" && method === "GET") {
      const { productions, registry } = agent.status({ channelId });

      return html(200, renderDashboard({ productions, registry, token, youtube: youtubeView() }));
    }

    // Synchronisation des analytiques à la demande depuis l'interface locale (seul déclencheur avec la commande).
    if (url.pathname === YOUTUBE_ANALYTICS_SYNC_PATH && method === "POST") {
      const contentType = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

      if (contentType !== "application/x-www-form-urlencoded") {
        return html(415, renderError({ title: "Refusé", message: "Type de contenu non pris en charge.", token }));
      }

      if (!youtubeAnalytics) {
        return html(503, renderError({ title: "Synchronisation indisponible", message: "Le lecteur Analytics n'est pas initialisé.", token }));
      }

      return agent.youtubeAnalyticsSync().then(result => {
        const { productions, registry } = agent.status({ channelId });
        const s = result.summary;
        const message = result.status === "ok"
          ? `Analytiques synchronisées : ${s.days_received} jours reçus (${s.start_date} → ${s.end_date}), ${s.analytics_requests} requête Analytics.`
          : `Synchronisation des analytiques impossible (${result.reason}). Les données précédentes sont conservées.`;

        return html(result.status === "ok" ? 200 : 502, renderDashboard({ productions, registry, token, message, youtube: youtubeView() }));
      });
    }

    // Synchronisation à la demande depuis l'interface locale (seul déclencheur avec la commande).
    if (url.pathname === YOUTUBE_SYNC_PATH && method === "POST") {
      const contentType = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();

      if (contentType !== "application/x-www-form-urlencoded") {
        return html(415, renderError({ title: "Refusé", message: "Type de contenu non pris en charge.", token }));
      }

      if (!youtubeChannel) {
        return html(503, renderError({ title: "Synchronisation indisponible", message: "Le lecteur YouTube n'est pas initialisé.", token }));
      }

      return agent.youtubeSync().then(result => {
        const { productions, registry } = agent.status({ channelId });
        const s = result.summary;
        const message = result.status === "ok"
          ? `Synchronisation réussie : ${s.present} vidéos (${s.added} nouvelles, ${s.updated} modifiées, ${s.removed} retirées, ${s.restored} restaurées), ${s.quota_units} unités de quota.`
          : `Synchronisation impossible (${result.reason}). Le miroir précédent est conservé.`;

        return html(result.status === "ok" ? 200 : 502, renderDashboard({ productions, registry, token, message, youtube: youtubeView() }));
      });
    }

    if (url.pathname === "/videos" && method === "POST") {
      const contentType = String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const raw = String(req.body ?? "");

      if (contentType !== "application/x-www-form-urlencoded") {
        return html(415, renderError({ title: "Refusé", message: "Type de contenu non pris en charge.", token }));
      }

      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        return html(413, renderError({ title: "Refusé", message: "Requête trop volumineuse.", token }));
      }

      const form = new URLSearchParams(raw);

      try {
        agent.linkVideo({
          channelId,
          entry: {
            production_id: form.get("production_id"),
            type: form.get("type"),
            video_id: form.get("video_id") ?? "",
            target_date: form.get("target_date") ?? "",
            publication_checklist: parseChecklist(form.get("publication_checklist")),
            notes: form.get("notes") ?? ""
          }
        });
      } catch (error) {
        return html(400, renderError({ title: "Entrée refusée", message: error.message, token }));
      }

      return {
        status: 303,
        headers: { ...BASE_HEADERS, location: `/?t=${encodeURIComponent(token)}` },
        body: ""
      };
    }

    const known = ["/", "/style.css", "/videos", OAUTH_LOGIN_PATH, YOUTUBE_SYNC_PATH, YOUTUBE_ANALYTICS_SYNC_PATH].includes(url.pathname);

    return known
      ? html(405, renderError({ title: "Méthode refusée", message: "Méthode non autorisée.", token }))
      : html(404, renderError({ title: "Introuvable", message: "Page inconnue.", token }));
  };
}

export function startServer({ root = ROOT, port = DEFAULT_PORT, bridgeToken = readBridgeToken() } = {}) {
  const session = createSession();
  let youtubeAuth = null;
  let youtubeChannel = null;
  let youtubeAnalytics = null;

  const server = http.createServer((req, res) => {
    // Pont JSON en lecture seule pour Norixo : garde propre (Host, jeton du pont).
    if ((req.url ?? "").startsWith(BRIDGE_API_PREFIX)) {
      const out = createBridgeHandler({ agent: createYouTubeAgent({ root, youtubeAuth, youtubeChannel }), port: server.address().port, token: bridgeToken })({ method: req.method, url: req.url, headers: req.headers });

      res.writeHead(out.status, out.headers).end(out.body);
      req.resume();

      return;
    }

    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        rejected = true;
        res.writeHead(413, BASE_HEADERS).end();
        req.destroy();

        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (rejected) return;

      try {
        const handle = createHandler({ root, port: server.address().port, token: session.token, youtubeAuth, youtubeChannel, youtubeAnalytics });

        Promise.resolve(handle({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8")
        }))
          .then(out => res.writeHead(out.status, out.headers).end(out.body))
          .catch(() => res.writeHead(500, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" }).end("Erreur interne"));
      } catch {
        res.writeHead(500, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" }).end("Erreur interne");
      }
    });
  });

  return new Promise(resolve => {
    server.listen(port, LOOPBACK_HOST, () => {
      const actual = server.address().port;

      youtubeAuth = createYoutubeAuthService({ root, port: actual });
      // R20.5 lot 2 : aucun appel Google au démarrage ; l'agent lit le miroir local.
      youtubeChannel = createYoutubeChannel({ root });
      // R20.5 lot 4A : aucune lecture Analytics au démarrage ; synchronisation à la demande seulement.
      youtubeAnalytics = createYoutubeAnalytics({ root });

      resolve({ server, port: actual, token: session.token, bridgeEnabled: Boolean(bridgeToken), oauthEnabled: youtubeAuth.enabled, url: `http://${LOOPBACK_HOST}:${actual}/?t=${session.token}` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portArg = process.argv.indexOf("--port");
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : DEFAULT_PORT;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("Port invalide");
    process.exit(1);
  }

  const { url, bridgeEnabled, oauthEnabled } = await startServer({ port });

  console.log(`YouTube Agent (local, 127.0.0.1 uniquement)\n${url}`);
  console.log(`Pont Norixo : ${bridgeEnabled ? "activé (jeton fourni)" : "désactivé (aucun jeton valide fourni)"}`);
  console.log(`Connexion Google : ${oauthEnabled ? "configurée" : "non configurée (variables YOUTUBE_OAUTH_* à fournir)"}`);
}
