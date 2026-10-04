// Liaison production ↔ vidéo (R20.6) : propositions et filiation, en lecture seule.
//
// Les propositions sont calculées à la demande (aucun stockage, aucune liaison
// automatique) : la validation humaine passe par le registre existant (`linkVideo`).
// La filiation lit, pour une production, `production.json` et la présence des artefacts
// Truth Report, Script et Storyboard, sans jamais parcourir `projects/` récursivement.

import fs from "node:fs";
import path from "node:path";

import { isValidProductionId } from "../../orchestrator/resume.js";

export const MAX_PROPOSALS = 10;
export const MIN_TITLE_SIMILARITY = 0.3;
export const MIN_PROPOSAL_SCORE = 0.4;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOPWORDS = new Set(["les", "des", "une", "pour", "dans", "avec", "sur", "par", "aux", "est", "qui", "que", "the", "and", "for", "with"]);

// Artefacts de la chaîne de production, dans l'ordre : Truth Report, Script, Storyboard.
export const LINEAGE_ARTIFACTS = Object.freeze([
  ["truth_report", "truth.json"],
  ["script", "script.json"],
  ["storyboard", "visual.json"]
]);

export function titleTokens(title) {
  return new Set(String(title ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(t => t.length >= 3 && !STOPWORDS.has(t)));
}

export function titleSimilarity(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);

  if (ta.size === 0 || tb.size === 0) return 0;

  const common = [...ta].filter(t => tb.has(t)).length;

  return common / (ta.size + tb.size - common);
}

// Proximité de date : la production précède la publication ; date cible identique = 1.
function dateScore({ createdAt, targetDate, publishedAt }) {
  const published = Date.parse(publishedAt ?? "");

  if (Number.isNaN(published)) return { score: 0, reason: "date de publication inconnue" };
  if (targetDate && publishedAt.slice(0, 10) === targetDate) return { score: 1, reason: "publiée à la date cible" };

  const created = Date.parse(createdAt ?? "");

  if (Number.isNaN(created)) return { score: 0, reason: "date de production inconnue" };
  if (created > published) return { score: 0, reason: "production postérieure à la publication" };

  const days = Math.round((published - created) / DAY_MS);

  return { score: days <= 30 ? 1 : days <= 90 ? 0.5 : 0, reason: `publiée ${days} jour(s) après la production` };
}

// Propositions : une au plus par vidéo et par production (meilleurs scores d'abord).
export function proposeLinks({ productions, registry, videos }) {
  const linkedVideos = new Set(registry.videos.map(v => v.video_id).filter(Boolean));
  const entries = new Map(registry.videos.map(v => [v.production_id, v]));
  const candidates = [];

  for (const video of videos) {
    if (video.mirror_status === "removed" || linkedVideos.has(video.video_id) || !video.title) continue;

    for (const production of productions) {
      const entry = entries.get(production.id);

      if (!production.readable || entry?.video_id || !production.title) continue;

      const similarity = titleSimilarity(production.title, video.title);

      if (similarity < MIN_TITLE_SIMILARITY) continue;

      const date = dateScore({ createdAt: production.created_at, targetDate: entry?.target_date ?? null, publishedAt: video.published_at });
      const score = Math.round((0.7 * similarity + 0.3 * date.score) * 100) / 100;

      if (score < MIN_PROPOSAL_SCORE) continue;

      candidates.push({
        video_id: video.video_id,
        video_title: video.title,
        published_at: video.published_at ?? null,
        production_id: production.id,
        production_title: production.title,
        score,
        reasons: [`titres semblables à ${Math.round(similarity * 100)} %`, date.reason],
        // Champs du registre conservés à la validation (la route existante remplace l'entrée).
        entry: {
          type: entry?.type ?? (production.mode === "full" ? "real" : "test"),
          target_date: entry?.target_date ?? null,
          publication_checklist: entry?.publication_checklist ?? [],
          notes: entry?.notes ?? ""
        }
      });
    }
  }

  const usedVideos = new Set();
  const usedProductions = new Set();
  const proposals = [];

  for (const c of candidates.sort((a, b) => b.score - a.score || a.video_id.localeCompare(b.video_id) || a.production_id.localeCompare(b.production_id))) {
    if (usedVideos.has(c.video_id) || usedProductions.has(c.production_id)) continue;

    usedVideos.add(c.video_id);
    usedProductions.add(c.production_id);
    proposals.push(c);
    if (proposals.length >= MAX_PROPOSALS) break;
  }

  return proposals;
}

function readArtifact(dir, filename) {
  const file = path.join(dir, filename);

  try {
    const stat = fs.lstatSync(file);

    if (!stat.isFile()) return { present: false };
    if (stat.size > MAX_ARTIFACT_BYTES) return { present: true, bytes: stat.size, readable: false };

    return { present: true, bytes: stat.size, readable: true, json: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return error.code === "ENOENT" ? { present: false } : { present: true, readable: false };
  }
}

const shortText = value => typeof value === "string" && value.trim() ? value.slice(0, 200) : null;

// Filiation d'une production : production → Truth Report → Script → Storyboard → publication.
export function productionLineage({ root, production, entry }) {
  if (!production || !isValidProductionId(production.id)) return null;

  const dir = path.join(path.resolve(root, "projects"), production.id);
  const artifacts = {};

  for (const [name, filename] of LINEAGE_ARTIFACTS) {
    const a = readArtifact(dir, filename);
    const details = {};
    // Les artefacts scellés sont enveloppés ({ agent, mode, data, validation }).
    const body = a.json?.data && typeof a.json.data === "object" ? a.json.data : a.json;

    if (body && name === "truth_report") details.title_verdict = shortText(body.title?.verdict);
    if (body && name === "script") details.title = shortText(body.title);
    if (body && name === "storyboard") {
      // visual.json : sections[] → segments[] → shots[].
      const segments = Array.isArray(body.sections) ? body.sections.flatMap(section => Array.isArray(section?.segments) ? section.segments : []) : null;

      details.segments = segments ? segments.length : null;
      details.shots = segments ? segments.reduce((n, s) => n + (Array.isArray(s?.shots) ? s.shots.length : 0), 0) : null;
    }

    artifacts[name] = { file: filename, present: a.present, ...(a.bytes !== undefined ? { bytes: a.bytes } : {}), ...(a.present ? { readable: a.readable !== false } : {}), ...details };
  }

  return {
    production: { id: production.id, title: production.title, status: production.status, mode: production.mode, created_at: production.created_at },
    artifacts,
    publication: entry ? { type: entry.type, video_id: entry.video_id ?? null, target_date: entry.target_date ?? null, checklist_done: (entry.publication_checklist ?? []).filter(i => i.done).length, checklist_total: (entry.publication_checklist ?? []).length } : null
  };
}
