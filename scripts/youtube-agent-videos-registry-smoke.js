// Smoke du registre de vidéos — écritures atomiques, validation.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-videos-registry-smoke.js

import fs from "node:fs";
import path from "node:path";

import { loadRegistry, upsertVideo, validateVideoEntry } from "../src/youtube-agent/videos-registry.js";
import { channelDir, partitionFile } from "../src/youtube-agent/paths.js";
import { isValidChannelId } from "../src/youtube-agent/channels.js";
import { tmpRoot, cleanup, check, throwsWith, done, PROD_A, PROD_B } from "./youtube-agent-test-helpers.js";

const root = tmpRoot("registry");
const base = { production_id: PROD_A, type: "test" };

check("registre vide par défaut, schéma et channel_id", () => {
  const r = loadRegistry({ root, channelId: "nomade" });
  if (r.schema !== "youtube-agent.videos.v1" || r.channel_id !== "nomade" || r.videos.length !== 0) throw new Error("vide");
});

check("upsert crée puis remplace sans doublon", () => {
  upsertVideo({ root, channelId: "nomade", entry: { ...base, notes: "a" } });
  upsertVideo({ root, channelId: "nomade", entry: { ...base, type: "real", video_id: "dQw4w9WgXcQ", notes: "b" } });
  const r = loadRegistry({ root, channelId: "nomade" });
  if (r.videos.length !== 1 || r.videos[0].notes !== "b" || r.videos[0].type !== "real") throw new Error("remplacement");
});

check("aucun fichier temporaire ou verrou résiduel", () => {
  const dir = path.dirname(partitionFile(root, "nomade", "videos", "registry.json"));
  const leftovers = fs.readdirSync(dir).filter(f => f !== "registry.json");
  if (leftovers.length) throw new Error(leftovers.join());
});

check("validation : production_id, type, video_id, date, notes, checklist", () => {
  throwsWith(() => validateVideoEntry({ ...base, production_id: "../x" }), "production_id");
  throwsWith(() => validateVideoEntry({ ...base, type: "prod" }), "type");
  throwsWith(() => validateVideoEntry({ ...base, video_id: "short" }), "video_id");
  throwsWith(() => validateVideoEntry({ ...base, target_date: "2026-13-45" }), "target_date");
  throwsWith(() => validateVideoEntry({ ...base, notes: "x".repeat(2001) }), "notes");
  throwsWith(() => validateVideoEntry({ ...base, publication_checklist: [{ label: "" }] }), "checklist");
  throwsWith(() => validateVideoEntry({ ...base, publication_checklist: Array(31).fill({ label: "a" }) }), "checklist");
});

check("registre d'un autre schéma refusé", () => {
  const file = partitionFile(root, "nomade", "videos", "registry.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...data, schema: "x" }));
  throwsWith(() => loadRegistry({ root, channelId: "nomade" }), "Registre");
});

check("identifiant interne et chemins : traversée refusée", () => {
  for (const bad of ["", "..", "../x", "A", "a/b", "a b", "x".repeat(41), null, 5]) {
    if (isValidChannelId(bad)) throw new Error(`accepté : ${bad}`);
    throwsWith(() => channelDir(root, bad), "channel_id");
  }
  throwsWith(() => partitionFile(root, "nomade", "videos", "../x.json"), "refusé");
  throwsWith(() => partitionFile(root, "nomade", "inconnue", "x.json"), "Partition");
});

cleanup(root);
done("youtube-agent-videos-registry-smoke");
