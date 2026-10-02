// Smoke des vues du YouTube Studio (façade) : lecture seule, aucune donnée inventée.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-studio-views-smoke.js

import fs from "node:fs";
import path from "node:path";

import { createYouTubeAgent } from "../src/youtube-agent/agent.js";
import { appendMemory } from "../src/youtube-agent/memory/contract.js";
import { approvalActionFor } from "../src/youtube-agent/workflow/manager.js";
import { createApproval } from "../src/youtube-agent/approvals.js";
import { partitionFile } from "../src/youtube-agent/paths.js";
import { writeJsonAtomic } from "../src/youtube-agent/atomic-json.js";
import { tmpRoot, cleanup, check, done, makeProduction, PROD_A, PROD_B, PROD_C } from "./youtube-agent-test-helpers.js";

const PROD_D = "prod-2026-01-04T10-00-00-000Z-dddddd";
const now = new Date("2026-06-01T10:00:00Z");
const ch = "nomade";
const all7 = ["research", "script", "visual_director", "asset", "voice", "assembly", "quality"].map(id => ({ id, status: "completed" }));

const root = tmpRoot("studio");
makeProduction(root, PROD_A, { mode: "full", status: "research_script_visual_asset_voice_assembly_quality_pass", agents: all7, input: { title: "Vidéo publiée" } });
makeProduction(root, PROD_B, { mode: "test", input: { title: "Test jetable" } });
makeProduction(root, PROD_C, { mode: "full", input: { title: "Vidéo en cours" }, agents: [{ id: "research", status: "completed" }, { id: "script", status: "failed" }] });
makeProduction(root, PROD_D, { mode: "full", input: { title: "Vidéo prévue" }, agents: [] });
fs.writeFileSync(path.join(root, "projects", PROD_C, ".lock"), "1");

const agent = createYouTubeAgent({ root, now: () => now });
const step = (productionId, from, to) => agent.advance({ channelId: ch, productionId, to, approval: approvalActionFor({ channelId: ch, productionId, from, to }) ? createApproval({ action: approvalActionFor({ channelId: ch, productionId, from, to }), now }) : null });

check("aucune lecture ne crée de données (vues sur racine vierge)", () => {
  const fresh = tmpRoot("studio-fresh");
  const a = createYouTubeAgent({ root: fresh, now: () => now });
  for (const m of ["system", "productions", "pipeline", "planner", "comments", "analytics", "learning", "journal", "settings"]) a[m]({ channelId: ch });
  if (fs.existsSync(path.join(fresh, "data"))) throw new Error("data/ créé par une lecture");
  cleanup(fresh);
});

check("productions : tests masqués par défaut, visibles sur demande, comptage honnête", () => {
  const def = agent.productions({ channelId: ch });
  if (def.items.some(i => i.id === PROD_B) || def.totals.hidden_tests !== 1 || def.totals.in_pipeline !== 4) throw new Error(JSON.stringify(def.totals));
  const withTests = agent.productions({ channelId: ch, includeTests: true });
  if (!withTests.items.some(i => i.id === PROD_B)) throw new Error("tests absents");
  if (def.items.some(i => i.thumbnail !== null) || def.thumbnails !== "not_available") throw new Error("miniature inventée");
  if (def.items.some(i => "_production" in i)) throw new Error("fuite interne");
});

check("buckets : prévue, en cours (pipeline démarré), publiée (workflow)", () => {
  let by = Object.fromEntries(agent.productions({ channelId: ch }).items.map(i => [i.id, i.bucket]));
  if (by[PROD_D] !== "planned" || by[PROD_C] !== "in_progress" || by[PROD_A] !== "in_progress") throw new Error(JSON.stringify(by));
  step(PROD_A, "idea", "in_production"); step(PROD_A, "in_production", "quality_passed"); step(PROD_A, "quality_passed", "ready_to_publish"); step(PROD_A, "ready_to_publish", "published");
  by = Object.fromEntries(agent.productions({ channelId: ch }).items.map(i => [i.id, i.bucket]));
  if (by[PROD_A] !== "published") throw new Error(`A → ${by[PROD_A]}`);
  const c = agent.productions({ channelId: ch }).counts;
  if (c.planned !== 1 || c.in_progress !== 1 || c.published !== 1) throw new Error(JSON.stringify(c));
});

check("liaison vidéo : journalisée, remonte dans la vue, date cible utilisée", () => {
  agent.linkVideo({ channelId: ch, entry: { production_id: PROD_C, type: "real", video_id: "dQw4w9WgXcQ", target_date: "2026-07-01" } });
  const item = agent.productions({ channelId: ch }).items.find(i => i.id === PROD_C);
  if (item.video_id !== "dQw4w9WgXcQ" || item.target_date !== "2026-07-01" || !item.linked) throw new Error("liaison");
  if (!agent.journal({ channelId: ch }).entries.some(e => e.type === "video_linked")) throw new Error("journal");
});

check("pipeline : 8 étapes dans l'ordre, couleurs et pourcentages vrais", () => {
  const p = agent.pipeline({ channelId: ch, productionId: PROD_A });
  if (p.stages.map(s => s.label).join() !== "Recherche,Script,Storyboard,Assets,Voix,Montage,Qualité,Publication") throw new Error("ordre");
  if (p.progress_percent !== 100 || p.stages.slice(0, 7).some(s => s.tone !== "green" || s.percent !== 100) || p.stages[7].tone !== "green") throw new Error("terminée");
  const c = agent.pipeline({ channelId: ch, productionId: PROD_C });
  const byKey = Object.fromEntries(c.stages.map(s => [s.key, s]));
  if (byKey.research.tone !== "green" || byKey.script.tone !== "red" || byKey.script.percent !== null || byKey.assets.tone !== "grey") throw new Error("couleurs");
  if (c.progress_percent !== 14 || byKey.publication.status !== "not_connected") throw new Error(`global ${c.progress_percent}`);
});

check("planner : prochaine vidéo par deadline, blocages dérivés, priorité non définie", () => {
  const p = agent.planner({ channelId: ch });
  if (p.next.production_id !== PROD_C || p.next.deadline !== "2026-07-01" || p.priority !== "not_defined") throw new Error(JSON.stringify(p.next));
  const codes = p.next.blockers.map(b => b.code);
  for (const code of ["locked", "stage_failed", "approval_required"]) if (!codes.includes(code)) throw new Error(`blocage ${code} absent`);
  if (!p.queue.some(q => q.production_id === PROD_D) || !p.queue[0].blockers.some(b => b.code === "no_target_date")) throw new Error("file");
});

check("commentaires : six colonnes vides, ingestion non connectée, aucune action, validation humaine", () => {
  const c = agent.comments({ channelId: ch });
  if (c.columns.map(x => x.label).join() !== "Nouveau,Prioritaire,Fact-check,Réponse proposée,Validation humaine,Publié") throw new Error("colonnes");
  if (c.columns.some(x => x.items.length) || c.ingestion !== "not_connected" || c.actions.enabled !== false) throw new Error("état");
  if (c.auto_reply !== false || c.human_validation_required !== true) throw new Error("politique");
});

check("commentaires semés : colonnes, texte réservé à la revue, auteur haché, texte brut jamais exposé", () => {
  const rec = (state, extra = {}) => appendMemory({ root, channelId: ch, partition: "comments", engine: "comments", now, record: { type: "comment", data: { comment_ref: `ref-${state}-xxxxxxxx`, state, video_id: "dQw4w9WgXcQ", class: "question", priority_score: 80, author_ref: "abcdef".repeat(10), excerpt: "<b>Salut</b>", proposal_text: "Merci !", text: "TEXTE BRUT INTERDIT", ...extra } } });
  rec("ingested"); rec("proposed"); rec("in_review"); rec("published");
  const cols = Object.fromEntries(agent.comments({ channelId: ch }).columns.map(x => [x.key, x.items]));
  if (cols.new.length !== 1 || cols.proposed.length !== 1 || cols.human_review.length !== 1 || cols.published.length !== 1) throw new Error("répartition");
  if (cols.new[0].excerpt !== null || cols.published[0].proposal_text !== null) throw new Error("texte hors revue");
  if (cols.proposed[0].proposal_text !== "Merci !" || cols.proposed[0].excerpt !== "<b>Salut</b>" || !/^Auteur [0-9a-f]{6}$/.test(cols.proposed[0].author_label)) throw new Error("revue");
  if (JSON.stringify(agent.comments({ channelId: ch })).includes("TEXTE BRUT")) throw new Error("texte brut exposé");
  if (agent.comments({ channelId: ch }).untrusted_text !== true) throw new Error("drapeau untrusted");
});

check("analytics : cartes prévues non connectées, aucune valeur", () => {
  const a = agent.analytics({ channelId: ch });
  if (a.cards.map(c => c.label).join() !== "CTR,Watch Time,Retention,Subscribers,Views,Revenue") throw new Error("cartes");
  if (a.cards.some(c => c.value !== null || c.status !== "not_connected") || a.top_videos.items.length || a.worst_videos.items.length) throw new Error("valeur inventée");
});

check("learning : lecture seule, vide puis alimenté ; knowledge via son index", () => {
  let l = agent.learning({ channelId: ch });
  if (!l.read_only || l.observations.length || l.knowledge.status !== "empty") throw new Error("vide");
  appendMemory({ root, channelId: ch, partition: "learning", engine: "learning", now, record: { type: "observation", data: { text: "Intro courte" } } });
  appendMemory({ root, channelId: ch, partition: "learning", engine: "learning", now, record: { type: "validated_learning", data: { rule: { statement: "Ouvrir sur la question" } } } });
  writeJsonAtomic(partitionFile(root, ch, "knowledge", "index.json"), { documents: [{ id: "d1" }, { id: "d2" }] });
  l = agent.learning({ channelId: ch });
  if (l.observations[0].text !== "Intro courte" || l.validated_learnings[0].text !== "Ouvrir sur la question" || l.knowledge.documents !== 2) throw new Error("alimenté");
});

check("journal : plus récent d'abord ; humain approuvé distingué de l'enregistrement agent", () => {
  const j = agent.journal({ channelId: ch, limit: 100 }).entries;
  if (j[0].ts < j.at(-1).ts) throw new Error("ordre");
  const transition = j.find(e => e.type === "workflow_transition");
  if (transition.actor !== "human_approved" || transition.validation !== "approved") throw new Error("transition");
  if (j.find(e => e.type === "video_linked").actor !== "agent_recorded") throw new Error("lien");
  if (agent.journal({ channelId: ch, limit: 5000 }).entries.length > 200) throw new Error("plafond");
});

check("paramètres : liste blanche, aucun secret, absence de config gérée", () => {
  const s0 = agent.settings({ channelId: ch });
  if (s0.narration_voice !== null || s0.language !== null) throw new Error("config absente");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "pipeline.json"), JSON.stringify({ project: { name: "N", language: "fr", platform: "youtube", content_type: "documentary", api_key: "sk-SECRETSECRETSECRET1234" }, providers: { reasoning: "anthropic", voice: { kind: "elevenlabs", model_id: "m", voice_id: "voiceXYZ", output_format: "f", api_key: "sk-AUTRESECRET1234567890" } } }));
  const s = agent.settings({ channelId: ch });
  if (s.language !== "fr" || s.narration_voice.voice_id !== "voiceXYZ" || s.narration_voice.kind !== "elevenlabs") throw new Error("champs");
  if (/sk-|SECRET|api_key/i.test(JSON.stringify(s))) throw new Error("secret exposé");
  if (s.comments.auto_reply !== false || s.publication.status !== "not_connected" || !s.workflow.approval_required_on.includes("ready_to_publish→published")) throw new Error("politiques");
});

check("système : état honnête, aucune intégration externe, aucun moteur exécutable", () => {
  const s = agent.system({ channelId: ch });
  if (s.productions.in_pipeline !== 4 || s.registry.linked < 1 || s.engines.existing !== 8 || s.engines.planned !== 7 || s.engines.undecided !== 1) throw new Error(JSON.stringify(s.engines));
  if (s.integrations.youtube_api !== "not_connected" || s.integrations.network !== "loopback_only" || s.safety.engines_executable !== 0 || s.safety.auto_reply !== false) throw new Error("intégrations");
  if (s.journal.last_ts !== now.toISOString()) throw new Error("dernier événement");
});

check("projects/ n'est pas modifié par les vues", () => {
  const before = fs.readFileSync(path.join(root, "projects", PROD_A, "production.json"), "utf8");
  agent.productions({ channelId: ch, includeTests: true }); agent.planner({ channelId: ch }); agent.pipeline({ channelId: ch });
  if (fs.readFileSync(path.join(root, "projects", PROD_A, "production.json"), "utf8") !== before) throw new Error("modifié");
});

cleanup(root);
done("youtube-agent-studio-views-smoke");
