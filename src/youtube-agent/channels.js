// Identifiant de chaîne : clé de premier rang de toutes les données.

import { CHANNEL_ID_PATTERN, DEFAULT_CHANNEL_ID } from "./config.js";

export function isValidChannelId(channelId) {
  return typeof channelId === "string" && CHANNEL_ID_PATTERN.test(channelId);
}

export function assertChannelId(channelId) {
  if (!isValidChannelId(channelId)) {
    throw new Error("channel_id invalide");
  }

  return channelId;
}

export function defaultChannelId() {
  return DEFAULT_CHANNEL_ID;
}
