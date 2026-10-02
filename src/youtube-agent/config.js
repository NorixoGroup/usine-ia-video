// Constantes du YouTube Agent (socle). Aucune valeur secrète ici.

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4177;

// Un seul canal par défaut tant qu'aucun autre n'est configuré.
export const DEFAULT_CHANNEL_ID = "nomade";
export const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DATA_DIR = "data/youtube-agent";

export const SESSION_TOKEN_HEADER = "x-agent-token";
export const SESSION_TOKEN_QUERY = "t";

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_PRODUCTIONS_LISTED = 50;
export const MAX_PRODUCTIONS_HARD_LIMIT = 200;

export const VIDEOS_SCHEMA = "youtube-agent.videos.v1";
export const VIDEO_TYPES = ["real", "test"];
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_CHECKLIST_ITEMS = 30;
export const MAX_CHECKLIST_LABEL = 120;
export const MAX_VIDEOS_PER_CHANNEL = 5000;
