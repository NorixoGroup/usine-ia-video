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
import { isValidChannelId } from "./channels.js";
import { checkRequest } from "./guard.js";
import { createSession } from "./session.js";
import { createYouTubeAgent } from "./agent.js";
import { createBridgeHandler } from "./agent-api.js";
import { readBridgeToken, BRIDGE_API_PREFIX } from "./bridge-config.js";
import { renderDashboard, renderError } from "./views.js";

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

// Gestionnaire pur : { method, url, headers, body } → { status, headers, body }.
export function createHandler({ root = ROOT, port, token }) {
  const agent = createYouTubeAgent({ root });

  return function handle(req) {
    const url = new URL(req.url, `http://${LOOPBACK_HOST}:${port}`);
    const method = String(req.method ?? "GET").toUpperCase();
    const headers = req.headers ?? {};

    const verdict = checkRequest({ headers, searchParams: url.searchParams, port, token, method });

    if (!verdict.ok) {
      return html(verdict.status, renderError({ title: "Accès refusé", message: "Requête non autorisée." }));
    }

    const requested = url.searchParams.get("channel");
    const channelId = requested && isValidChannelId(requested) ? requested : DEFAULT_CHANNEL_ID;

    if (url.pathname === "/style.css" && method === "GET") {
      return { status: 200, headers: { ...BASE_HEADERS, "content-type": "text/css; charset=utf-8" }, body: STYLE };
    }

    if (url.pathname === "/" && method === "GET") {
      const { productions, registry } = agent.status({ channelId });

      return html(200, renderDashboard({ channelId, productions, registry, token }));
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
      const formChannel = form.get("channel_id");
      const targetChannel = formChannel && isValidChannelId(formChannel) ? formChannel : DEFAULT_CHANNEL_ID;

      try {
        agent.linkVideo({
          channelId: targetChannel,
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

    const known = url.pathname === "/" || url.pathname === "/style.css" || url.pathname === "/videos";

    return known
      ? html(405, renderError({ title: "Méthode refusée", message: "Méthode non autorisée.", token }))
      : html(404, renderError({ title: "Introuvable", message: "Page inconnue.", token }));
  };
}

export function startServer({ root = ROOT, port = DEFAULT_PORT, bridgeToken = readBridgeToken() } = {}) {
  const session = createSession();
  const agent = createYouTubeAgent({ root });

  const server = http.createServer((req, res) => {
    // Pont JSON en lecture seule pour Norixo : garde propre (Host, jeton du pont).
    if ((req.url ?? "").startsWith(BRIDGE_API_PREFIX)) {
      const out = createBridgeHandler({ agent, port: server.address().port, token: bridgeToken })({ method: req.method, url: req.url, headers: req.headers });

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
        const handle = createHandler({ root, port: server.address().port, token: session.token });
        const out = handle({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });

        res.writeHead(out.status, out.headers).end(out.body);
      } catch {
        res.writeHead(500, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" }).end("Erreur interne");
      }
    });
  });

  return new Promise(resolve => {
    server.listen(port, LOOPBACK_HOST, () => {
      const actual = server.address().port;

      resolve({ server, port: actual, token: session.token, bridgeEnabled: Boolean(bridgeToken), url: `http://${LOOPBACK_HOST}:${actual}/?t=${session.token}` });
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

  const { url, bridgeEnabled } = await startServer({ port });

  console.log(`YouTube Agent (local, 127.0.0.1 uniquement)\n${url}`);
  console.log(`Pont Norixo : ${bridgeEnabled ? "activé (jeton fourni)" : "désactivé (aucun jeton valide fourni)"}`);
}
