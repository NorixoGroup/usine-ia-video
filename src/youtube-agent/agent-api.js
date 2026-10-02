// Pont local JSON (lecture seule) vers le YouTube Agent. Il n'appelle QUE la
// façade (agent.js) qu'on lui injecte : aucun moteur, aucun module de données.
// Garde : Host loopback, aucun Origin (appel serveur à serveur), jeton du pont.

import { allowedHosts } from "./guard.js";
import { tokensEqual } from "./session.js";
import { isValidChannelId } from "./channels.js";
import { DEFAULT_CHANNEL_ID } from "./config.js";
import { BRIDGE_CONTRACT, BRIDGE_TOKEN_HEADER, BRIDGE_API_PREFIX } from "./bridge-config.js";

const HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
});

const reply = (status, payload, extra = {}) => ({ status, headers: { ...HEADERS, ...extra }, body: JSON.stringify(payload) });
const fail = (status, error, extra) => reply(status, { schema: BRIDGE_CONTRACT, ok: false, error }, extra);

const PRODUCTION_ID = /^prod-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;

// Table des routes : chacune appelle une seule méthode de la façade.
const ROUTES = Object.freeze({
  system: ({ agent, channelId }) => agent.system({ channelId }),
  productions: ({ agent, channelId, query }) => agent.productions({ channelId, includeTests: query.get("include_tests") === "1" }),
  pipeline: ({ agent, channelId, query }) => agent.pipeline({ channelId, productionId: query.get("production_id") }),
  planner: ({ agent, channelId }) => agent.planner({ channelId }),
  comments: ({ agent, channelId }) => agent.comments({ channelId }),
  analytics: ({ agent, channelId }) => agent.analytics({ channelId }),
  learning: ({ agent, channelId }) => agent.learning({ channelId }),
  journal: ({ agent, channelId, query }) => agent.journal({ channelId, limit: Number(query.get("limit")) || 50 }),
  settings: ({ agent, channelId }) => agent.settings({ channelId })
});

export const BRIDGE_ROUTES = Object.freeze(Object.keys(ROUTES));

export function createBridgeHandler({ agent, port, token, now = () => new Date() }) {
  return function handle(req) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const headers = req.headers ?? {};

    if (!url.pathname.startsWith(BRIDGE_API_PREFIX)) return fail(404, "not_found");
    if (!allowedHosts(port).has(String(headers.host ?? "").toLowerCase())) return fail(403, "host_not_allowed");
    // Un navigateur envoie Origin ; le pont n'est destiné qu'à un serveur.
    if (headers.origin !== undefined) return fail(403, "origin_not_allowed");
    if (String(req.method ?? "GET").toUpperCase() !== "GET") return fail(405, "method_not_allowed", { allow: "GET" });

    const name = url.pathname.slice(BRIDGE_API_PREFIX.length);

    // Santé : sans donnée ; distingue « en ligne » de « pont non configuré ».
    if (name === "health") {
      return reply(200, { schema: BRIDGE_CONTRACT, ok: true, service: "youtube-agent", bridge_enabled: Boolean(token), auth_required: true, generated_at: now().toISOString() });
    }

    if (!Object.hasOwn(ROUTES, name)) return fail(404, "not_found");
    if (!token) return fail(503, "bridge_disabled");

    const provided = headers[BRIDGE_TOKEN_HEADER];

    if (provided === undefined) return fail(401, "token_missing");
    if (!tokensEqual(token, provided)) return fail(401, "token_invalid");

    const requested = url.searchParams.get("channel");

    if (requested !== null && !isValidChannelId(requested)) return fail(400, "invalid_channel");

    const productionId = url.searchParams.get("production_id");

    if (productionId !== null && !PRODUCTION_ID.test(productionId)) return fail(400, "invalid_production_id");

    const channelId = requested ?? DEFAULT_CHANNEL_ID;

    try {
      const data = ROUTES[name]({ agent, channelId, query: url.searchParams });

      return reply(200, { schema: BRIDGE_CONTRACT, ok: true, route: name, channel_id: channelId, generated_at: now().toISOString(), data });
    } catch {
      // Aucun détail interne n'est renvoyé.
      return fail(500, "internal_error");
    }
  };
}
