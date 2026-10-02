// Configuration du pont local. Seule lecture d'environnement du module : le
// jeton du pont, fourni par l'utilisateur au lancement. Aucun fichier .env n'est lu.

export const BRIDGE_CONTRACT = "youtube-agent.bridge.v1";
export const BRIDGE_TOKEN_ENV = "YOUTUBE_AGENT_BRIDGE_TOKEN";
export const BRIDGE_TOKEN_HEADER = "x-agent-bridge-token";
export const BRIDGE_API_PREFIX = "/api/v1/";

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,200}$/;

export function isValidBridgeToken(token) {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

// Retourne le jeton, ou null si absent / trop faible : le pont est alors désactivé.
export function readBridgeToken(env = process.env) {
  const token = env[BRIDGE_TOKEN_ENV];

  return isValidBridgeToken(token) ? token : null;
}
