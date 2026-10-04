// Smoke R20.6 — lecture et exploitation du bloc Analytics (aucun réseau pendant la lecture).
// Propositions de liaison production ↔ vidéo, filiation (Truth Report, Script, Storyboard,
// publication), classements, vue d'ensemble, fiche vidéo, performance par production,
// modèle préparé pour le Dashboard, interface locale (validation par le registre existant,
// échappement), pont inchangé.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-analytics-read-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import { titleSimilarity, proposeLinks, productionLineage, MAX_PROPOSALS } from "../src/youtube-agent/analytics/linking.js";
import { rankVideos, analyticsOverview, analyticsVideo, analyticsProductions, analyticsDashboard, analyticsLinkProposals } from "../src/youtube-agent/analytics/read-model.js";
import { createYoutubeVideoAnalytics } from "../src/youtube-agent/connectors/youtube/video-analytics.js";
import { createYoutubeAnalyticsSuite } from "../src/youtube-agent/connectors/youtube/analytics-suite.js";
import { GOOGLE_TOKEN_ENDPOINT } from "../src/youtube-agent/connectors/youtube/auth/google-oauth.js";
import { saveConnection } from "../src/youtube-agent/connectors/youtube/auth/token-store.js";
import { YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE } from "../src/youtube-agent/connectors/youtube/auth/config.js";
import { upsertVideo, loadRegistry } from "../src/youtube-agent/videos-registry.js";
import { listProductions } from "../src/youtube-agent/productions-reader.js";
import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { createBridgeHandler } from "../src/youtube-agent/agent-api.js";
import { createHandler } from "../src/youtube-agent/server.js";
import { readJournal } from "../src/youtube-agent/journal.js";
import { tmpRoot, cleanup, check, done } from "./youtube-agent-test-helpers.js";

const PORT = 4177;
const KEY = Buffer.alloc(32, 6);
const SESSION = "s".repeat(64);
const BRIDGE = "bridge-token-0123456789abcdef0123456789abcdef";
const ENV = {
  YOUTUBE_OAUTH_CLIENT_ID: "1234567890-abcdefgh.apps.googleusercontent.com",
  YOUTUBE_OAUTH_CLIENT_SECRET: "test-client-secret-read",
  YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/youtube/callback`,
  YOUTUBE_OAUTH_RETURN_URL: "http://localhost:3000/dashboard/nomad-studio",
  YOUTUBE_OAUTH_TOKEN_KEY: KEY.toString("base64")
};
const REPORTS = "https://youtubeanalytics.googleapis.com/v2/reports";
const NOW = new Date("2026-10-04T10:00:00Z");
const P1 = "prod-2026-08-20T10-00-00-000Z-aaaaaa";
const P2 = "prod-2026-08-25T10-00-00-000Z-bbbbbb";
const P3 = "prod-2026-09-01T10-00-00-000Z-cccccc";
const V1 = "vid1aaaaaaa";
const V2 = "vid2bbbbbbb";
const V3 = "vid3ccccccc";
const VT = "vidtestaaaa";
const VR = "vidremoveda";
const EVIL = "<script>alert(1)</script>";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const asyncCheck = async (name, fn) => { let err = null; try { await fn(); } catch (e) { err = e; } check(name, () => { if (err) throw err; }); };
const days = (from, to) => { const out = []; for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
const host = { host: `127.0.0.1:${PORT}` };
const form = { ...host, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" };

function writeProduction(root, id, title, { artifacts = true } = {}) {
  const dir = path.join(root, "projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "production.json"), JSON.stringify({ status: "completed", mode: "full", created_at: `${id.slice(5, 15)}T10:00:00.000Z`, input: { title }, agents: [] }));
  if (!artifacts) return;
  fs.writeFileSync(path.join(dir, "truth.json"), JSON.stringify({ title: { verdict: "supported" } }));
  fs.writeFileSync(path.join(dir, "script.json"), JSON.stringify({ agent: "script", mode: "full", data: { title }, validation: {} }));
  fs.writeFileSync(path.join(dir, "visual.json"), JSON.stringify({ agent: "visual_director", mode: "full", data: { sections: [{ segments: [{ shots: [{}, {}] }, { shots: [{}] }] }] }, validation: {} }));
}

// Racine complète : productions, registre, miroir, analytiques par vidéo (Google simulé).
async function setup() {
  const root = tmpRoot("analytics-read");
  writeProduction(root, P1, "Les secrets de Chefchaouen, la ville bleue");
  writeProduction(root, P2, "Marrakech la nuit : souks et places");
  writeProduction(root, P3, "Désert d'Erg Chebbi au lever du soleil", { artifacts: false });
  upsertVideo({ root, channelId: "nomade", entry: { production_id: P1, type: "real", video_id: V1, target_date: "2026-09-01", publication_checklist: [{ label: "Miniature", done: true }, { label: "Description", done: false }], notes: "" }, now: NOW });
  upsertVideo({ root, channelId: "nomade", entry: { production_id: P2, type: "test", video_id: VT, publication_checklist: [], notes: "" }, now: NOW });
  upsertVideo({ root, channelId: "nomade", entry: { production_id: P3, type: "real", target_date: "2026-09-20", publication_checklist: [{ label: "Titre", done: true }], notes: "à publier" }, now: NOW });

  const mirror = [
    { video_id: V1, title: "Les secrets de Chefchaouen", privacy_status: "public", published_at: "2026-09-01T10:00:00Z", mirror_status: "present" },
    { video_id: V2, title: "Le désert d'Erg Chebbi au lever du soleil", privacy_status: "public", published_at: "2026-09-20T08:00:00Z", mirror_status: "present" },
    { video_id: V3, title: EVIL, privacy_status: "unlisted", published_at: "2026-09-15T08:00:00Z", mirror_status: "present" },
    { video_id: VT, title: "Marrakech test", privacy_status: "private", published_at: "2026-08-26T08:00:00Z", mirror_status: "present" },
    { video_id: VR, title: "Marrakech la nuit souks", privacy_status: "public", published_at: "2026-08-30T08:00:00Z", mirror_status: "removed" }
  ];
  const mirrorDir = path.join(root, "data", "youtube-agent", "channels", "nomade", "youtube");
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.writeFileSync(path.join(mirrorDir, "videos.json"), JSON.stringify({ schema: "youtube-agent.mirror.v1", videos: mirror }));

  saveConnection({ root, key: KEY, refreshToken: "test-refresh-token-read", scopes: [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE], now: NOW });
  const views = { [V1]: 50, [V2]: 20, [V3]: 5, [VT]: 999, [VR]: 300 };
  const fetchImpl = async url => {
    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: "test-access-token-read", expires_in: 3599 });
    const q = new URL(url).searchParams;
    const metrics = q.get("metrics").split(",");
    const headers = [{ name: q.get("dimensions") }, ...metrics.map(name => ({ name }))];
    if (q.get("dimensions") === "video") return json(200, { columnHeaders: headers, rows: [VR].map(id => [id, ...metrics.map(() => 1)]) });
    const id = (q.get("filters") ?? "").replace(/^video==/, "");
    return json(200, { columnHeaders: headers, rows: days(q.get("startDate"), q.get("endDate")).map(d => [d, views[id] ?? 0, 10, 60, 40, 1, 0, 2, 1, 0]) });
  };
  const sync = await createYoutubeVideoAnalytics({ root, env: ENV, fetchImpl, now: () => NOW }).sync();
  if (sync.status !== "ok") throw new Error(JSON.stringify(sync));

  return { root };
}

const ctx = await setup();
const offline = () => { throw new Error("aucun appel réseau attendu"); };

check("similarité des titres : accents, ponctuation et mots vides ignorés", () => {
  if (titleSimilarity("Désert d'Erg Chebbi", "desert ERG chebbi !") !== 1 || titleSimilarity("Chefchaouen", "Marrakech") !== 0 || titleSimilarity("", "x") !== 0) throw new Error("similarité");
});

check("propositions : vidéo non liée ↔ production non liée, une seule chacune, champs du registre conservés", () => {
  const proposals = analyticsLinkProposals({ root: ctx.root, channelId: "nomade" });
  if (proposals.length !== 1) throw new Error(JSON.stringify(proposals.map(p => [p.video_id, p.production_id, p.score])));
  const p = proposals[0];
  if (p.video_id !== V2 || p.production_id !== P3 || p.score < 0.9 || !p.reasons.includes("publiée à la date cible")) throw new Error(JSON.stringify(p));
  if (p.entry.type !== "real" || p.entry.target_date !== "2026-09-20" || p.entry.notes !== "à publier" || p.entry.publication_checklist[0].label !== "Titre") throw new Error(JSON.stringify(p.entry));
});

check("propositions : ni vidéo retirée, ni vidéo ou production déjà liée, ni production postérieure ; plafond", () => {
  const productions = [{ id: P3, readable: true, title: "Souks de Marrakech", created_at: "2026-10-01T00:00:00Z", mode: "full" }];
  const registry = { videos: [] };
  const late = proposeLinks({ productions, registry, videos: [{ video_id: V2, title: "Souks de Marrakech", published_at: "2026-09-01T00:00:00Z", mirror_status: "present" }] });
  if (late.length !== 1 || late[0].score !== 0.7 || !late[0].reasons.includes("production postérieure à la publication")) throw new Error(JSON.stringify(late));
  const removed = proposeLinks({ productions, registry, videos: [{ video_id: V2, title: "Souks de Marrakech", published_at: "2026-10-02T00:00:00Z", mirror_status: "removed" }] });
  if (removed.length !== 0) throw new Error("vidéo retirée proposée");
  const many = Array.from({ length: 15 }, (_, i) => ({ id: `prod-2026-09-01T10-00-00-000Z-${String(i).padStart(6, "0")}`, readable: true, title: `Voyage ${i} Maroc`, created_at: "2026-09-01T00:00:00Z", mode: "full" }));
  const videos = many.map((p, i) => ({ video_id: `v${String(i).padStart(10, "0")}`, title: `Voyage ${i} Maroc`, published_at: "2026-09-05T00:00:00Z", mirror_status: "present" }));
  const capped = proposeLinks({ productions: many, registry, videos });
  if (capped.length !== MAX_PROPOSALS || new Set(capped.map(c => c.video_id)).size !== capped.length || new Set(capped.map(c => c.production_id)).size !== capped.length) throw new Error(`${capped.length}`);
});

check("filiation : production, Truth Report, Script, Storyboard (enveloppes lues), publication ; artefacts absents", () => {
  const productions = listProductions({ root: ctx.root }).shown;
  const registry = loadRegistry({ root: ctx.root, channelId: "nomade" });
  const l1 = productionLineage({ root: ctx.root, production: productions.find(p => p.id === P1), entry: registry.videos.find(v => v.production_id === P1) });
  if (l1.production.id !== P1 || l1.artifacts.truth_report.title_verdict !== "supported" || l1.artifacts.script.title !== "Les secrets de Chefchaouen, la ville bleue" || l1.artifacts.storyboard.segments !== 2 || l1.artifacts.storyboard.shots !== 3) throw new Error(JSON.stringify(l1.artifacts));
  if (l1.publication.video_id !== V1 || l1.publication.checklist_done !== 1 || l1.publication.checklist_total !== 2) throw new Error(JSON.stringify(l1.publication));
  const l3 = productionLineage({ root: ctx.root, production: productions.find(p => p.id === P3), entry: null });
  if (Object.values(l3.artifacts).some(a => a.present) || l3.publication !== null) throw new Error(JSON.stringify(l3));
  if (productionLineage({ root: ctx.root, production: { id: "../etc" }, entry: null }) !== null) throw new Error("identifiant invalide accepté");
});

check("classements : vidéos test et retirées exclues, meilleures et moins bonnes sans recouvrement", () => {
  const o = analyticsOverview({ root: ctx.root, channelId: "nomade" });
  if (o.videos.status !== "ok" || o.videos.tracked !== 5 || o.videos.eligible !== 3) throw new Error(JSON.stringify(o.videos));
  if (o.videos.top.map(v => v.video_id).join() !== `${V1},${V2},${V3}` || o.videos.worst.length !== 0) throw new Error(JSON.stringify(o.videos.top));
  if (o.videos.top[0].production_id !== P1 || o.videos.top[0].views !== 1400 || o.videos.top[0].average_view_percentage !== 40) throw new Error(JSON.stringify(o.videos.top[0]));
  if (o.links.linked_videos !== 2 || o.links.proposals !== 1 || o.channel.status !== "not_loaded" || o.breakdowns.status !== "not_loaded") throw new Error(JSON.stringify(o.links));
  const many = Array.from({ length: 12 }, (_, i) => ({ video_id: `v${String(i).padStart(10, "0")}`, mirror_status: "present", days_stored: 3, totals: { views: i, watch_time_minutes: 0, average_view_percentage: null } }));
  const r = rankVideos({ videos: many, registry: { videos: [] } });
  if (r.top.map(v => v.views).join() !== "11,10,9,8,7" || r.worst.map(v => v.views).join() !== "0,1,2,3,4") throw new Error(JSON.stringify(r));
});

check("fiche vidéo : invalide, inconnue, analytiques, série quotidienne bornée, liaison et filiation", () => {
  if (analyticsVideo({ root: ctx.root, channelId: "nomade", videoId: "../x" }).status !== "invalid") throw new Error("invalide");
  if (analyticsVideo({ root: ctx.root, channelId: "nomade", videoId: "zzzzzzzzzzz" }).status !== "not_found") throw new Error("inconnue");
  const d = analyticsVideo({ root: ctx.root, channelId: "nomade", videoId: V1 });
  if (d.status !== "ok" || d.title !== "Les secrets de Chefchaouen" || d.analytics.days_stored !== 90 || d.analytics.recent.views !== 1400 || d.analytics.lifetime.views !== 4500 || d.daily.length !== 90 || d.daily.at(-1).day !== "2026-10-03") throw new Error(JSON.stringify(d.analytics));
  if (d.link.production_id !== P1 || d.lineage.artifacts.storyboard.shots !== 3) throw new Error("filiation");
});

check("performance par production liée : vidéo, totaux et artefacts", () => {
  const list = analyticsProductions({ root: ctx.root, channelId: "nomade" });
  if (list.map(p => p.production_id).join() !== `${P2},${P1}` || list[1].recent.views !== 1400 || list[1].artifacts.truth_report !== true || list[0].type !== "test") throw new Error(JSON.stringify(list));
});

await asyncCheck("modèle préparé pour le Dashboard : cartes (CTR et revenus non disponibles), listes, répartitions", async () => {
  const empty = analyticsDashboard({ root: ctx.root, channelId: "nomade" });
  if (empty.source !== "not_loaded" || empty.cards.find(c => c.key === "views").status !== "not_loaded" || empty.top_videos.status !== "ok") throw new Error(JSON.stringify(empty.cards));
  const root = tmpRoot("analytics-dash");
  saveConnection({ root, key: KEY, refreshToken: "test-refresh-token-read", scopes: [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE], now: NOW });
  const fetchImpl = async url => {
    if (url === GOOGLE_TOKEN_ENDPOINT) return json(200, { access_token: "test-access-token-read" });
    const q = new URL(url).searchParams;
    const metrics = q.get("metrics").split(",");
    const dims = q.get("dimensions");
    const headers = [{ name: dims }, ...metrics.map(name => ({ name }))];
    if (dims === "day") return json(200, { columnHeaders: headers, rows: days(q.get("startDate"), q.get("endDate")).map(d => [d, 10, 20, 60, 50, 3, 1, 2, 1, 0]) });
    if (dims === "video") return json(200, { columnHeaders: headers, rows: [] });
    return json(200, { columnHeaders: headers, rows: [["MOBILE", 9, 3]] });
  };
  const r = await createYoutubeAnalyticsSuite({ root, env: ENV, fetchImpl, now: () => NOW }).sync();
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  const m = analyticsDashboard({ root, channelId: "nomade" });
  const card = key => m.cards.find(c => c.key === key);
  if (m.source !== "local_analytics" || m.data_until !== "2026-10-03" || card("views").value !== 280 || card("watch_time").value !== 560 || card("subscribers").value !== 56 || card("retention").value !== 50 || card("views").unit !== "count") throw new Error(JSON.stringify(m.cards));
  if (card("ctr").status !== "not_available" || card("revenue").status !== "not_available" || card("ctr").value !== null) throw new Error("CTR ou revenus");
  if (m.cards.map(c => c.key).join() !== "ctr,watch_time,retention,subscribers,views,revenue") throw new Error("ordre des cartes");
  if (m.breakdowns.device_type.rows[0].key !== "MOBILE" || m.top_videos.items.length !== 0) throw new Error(JSON.stringify(m.breakdowns));
  cleanup(root);
});

await asyncCheck("interface locale : bloc Analytics, proposition validée par le registre existant, fiche vidéo, échappement", async () => {
  const auth = { enabled: true, returnUrl: ENV.YOUTUBE_OAUTH_RETURN_URL, status: () => ({ enabled: true, problem: null, connection: { status: "connected", connected_at: "2026-10-03T10:00:00.000Z", scopes: [YOUTUBE_READONLY_SCOPE, YT_ANALYTICS_READONLY_SCOPE] } }) };
  const suite = createYoutubeAnalyticsSuite({ root: ctx.root, env: ENV, fetchImpl: offline });
  const handle = createHandler({ root: ctx.root, port: PORT, token: SESSION, youtubeAuth: auth, youtubeAnalytics: suite });
  const page = handle({ method: "GET", url: `/?t=${SESSION}`, headers: host });
  if (page.status !== 200 || !page.body.includes("Meilleures vidéos") || !page.body.includes("1 proposition(s) à valider") || !page.body.includes(`name="video_id" value="${V2}"`) || !page.body.includes("Valider le lien")) throw new Error(page.body.slice(-2500));
  if (page.body.includes(EVIL) || !page.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;")) throw new Error("échappement");
  if (!page.body.includes(`/analytics/video?v=${V1}&amp;t=${SESSION}`)) throw new Error("lien vers la fiche");
  const body = new URLSearchParams({ production_id: P3, type: "real", video_id: V2, target_date: "2026-09-20", publication_checklist: "[x] Titre", notes: "à publier" }).toString();
  const out = handle({ method: "POST", url: `/videos?t=${SESSION}`, headers: form, body });
  if (out.status !== 303) throw new Error(`${out.status}`);
  const entry = loadRegistry({ root: ctx.root, channelId: "nomade" }).videos.find(v => v.production_id === P3);
  if (entry.video_id !== V2 || entry.notes !== "à publier" || entry.publication_checklist[0].done !== true) throw new Error(JSON.stringify(entry));
  if (readJournal({ root: ctx.root, channelId: "nomade" }).at(-1).type !== "video_linked") throw new Error("journal");
  if (analyticsLinkProposals({ root: ctx.root, channelId: "nomade" }).length !== 0) throw new Error("proposition encore présente");
  const detail = handle({ method: "GET", url: `/analytics/video?v=${V1}&t=${SESSION}`, headers: host });
  if (detail.status !== 200 || !detail.body.includes("Les secrets de Chefchaouen") || !detail.body.includes("Détail quotidien") || !detail.body.includes("3 plan(s)") || !detail.body.includes("2026-10-03")) throw new Error(detail.body.slice(0, 1500));
  const evil = handle({ method: "GET", url: `/analytics/video?v=${V3}&t=${SESSION}`, headers: host });
  if (evil.body.includes(EVIL)) throw new Error("échappement de la fiche");
  if (handle({ method: "GET", url: `/analytics/video?v=%3Cx%3E&t=${SESSION}`, headers: host }).status !== 400) throw new Error("identifiant invalide");
  if (handle({ method: "GET", url: `/analytics/video?v=zzzzzzzzzzz&t=${SESSION}`, headers: host }).status !== 404) throw new Error("inconnue");
  if (handle({ method: "GET", url: `/analytics/video?v=${V1}`, headers: host }).status !== 403) throw new Error("sans jeton");
  if (handle({ method: "POST", url: `/analytics/video?v=${V1}&t=${SESSION}`, headers: form, body: "" }).status !== 405) throw new Error("méthode");
});

check("pont inchangé : la route analytics reste not_connected malgré les données locales", () => {
  const agent = createYouTubeAgent({ root: ctx.root });
  const out = createBridgeHandler({ agent, port: PORT, token: BRIDGE })({ method: "GET", url: "/api/v1/analytics", headers: { ...host, "x-agent-bridge-token": BRIDGE } });
  const data = JSON.parse(out.body).data;
  if (out.status !== 200 || data.source !== "not_connected" || data.cards.some(c => c.value !== null) || data.top_videos.status !== "not_connected") throw new Error(out.body);
});

cleanup(ctx.root);

if (networkGuard.attempts().length !== 0) check("aucune tentative réseau réelle", () => { throw new Error(`${networkGuard.attempts().length} tentatives`); });

done("youtube-agent-analytics-read-smoke");
