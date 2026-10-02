// Modèles de vue du YouTube Studio : mise en forme en lecture seule de l'état
// existant. Aucune écriture, aucune génération, aucune valeur inventée : quand
// une donnée n'existe pas (API YouTube, ingestion), le modèle le dit explicitement.

import fs from "node:fs";

import { ENGINES, getEngine } from "./engines.js";
import { listProductions } from "./productions-reader.js";
import { loadRegistry } from "./videos-registry.js";
import { planNext, stageStatesFromProduction } from "./planner.js";
import { getEpisode } from "./workflow/manager.js";
import { readJournal } from "./journal.js";
import { selectContext, selectForReview } from "./memory/contract.js";
import { readJson } from "./atomic-json.js";
import { channelDir, partitionFile } from "./paths.js";
import { readPipelineSettings } from "./settings-reader.js";
import { EPISODE_TRANSITIONS } from "./workflow/transitions.js";
import { requiresApproval, isExecutableInR182 } from "./capabilities.js";

export const STUDIO_STAGES = Object.freeze([
  { key: "research", label: "Recherche", engine: "research" },
  { key: "script", label: "Script", engine: "script" },
  { key: "storyboard", label: "Storyboard", engine: "visual" },
  { key: "assets", label: "Assets", engine: "asset" },
  { key: "voice", label: "Voix", engine: "voice" },
  { key: "assembly", label: "Montage", engine: "assembly" },
  { key: "quality", label: "Qualité", engine: "quality" },
  { key: "publication", label: "Publication", engine: "publishing" }
]);

const PIPELINE_STAGE_COUNT = STUDIO_STAGES.length - 1;
const IN_PROGRESS_STATES = ["in_production", "paused", "failed", "quality_passed", "ready_to_publish"];
const PUBLISHED_STATES = ["published", "tracking"];
const REVIEW_BUDGET = { max_entries: 50, max_bytes: 16 * 1024 };

function stageView(stage, production, workflowState) {
  if (stage.key === "publication") {
    return PUBLISHED_STATES.includes(workflowState)
      ? { ...stage, status: "done", tone: "green", percent: 100 }
      : { ...stage, status: "not_connected", tone: "grey", percent: null };
  }

  const agentId = getEngine(stage.engine).pipeline_agent;
  const found = production?.agents?.find(a => a.id === agentId);

  switch (found?.status) {
    case "completed": return { ...stage, status: "done", tone: "green", percent: 100 };
    case "running": return { ...stage, status: "running", tone: "orange", percent: null };
    case "failed": return { ...stage, status: "failed", tone: "red", percent: null };
    default: return { ...stage, status: "pending", tone: "grey", percent: null };
  }
}

function pipelineOf(production, workflowState) {
  const stages = STUDIO_STAGES.map(stage => stageView(stage, production, workflowState));
  const done = stages.slice(0, PIPELINE_STAGE_COUNT).filter(s => s.status === "done").length;

  return { stages, progress_percent: Math.round((done / PIPELINE_STAGE_COUNT) * 100) };
}

// Planned = idée sans pipeline démarré ; in_progress = pipeline démarré ou états de
// production ; published = publiée / suivie. Les épisodes archivés sont à part.
function bucketOf(workflowState, progress) {
  if (workflowState === "archived") return "archived";
  if (PUBLISHED_STATES.includes(workflowState)) return "published";
  if (IN_PROGRESS_STATES.includes(workflowState)) return "in_progress";

  return progress > 0 ? "in_progress" : "planned";
}

function collect({ root, channelId, includeTests, limit }) {
  const listed = listProductions({ root, limit });
  const registry = loadRegistry({ root, channelId });
  const byId = new Map(registry.videos.map(v => [v.production_id, v]));
  const items = [];
  let hiddenTests = 0;

  for (const p of listed.shown) {
    const entry = byId.get(p.id) ?? null;
    const type = entry ? entry.type : p.mode === "full" ? "real" : "test";

    if (!includeTests && (type === "test" || !p.readable)) {
      hiddenTests += 1;
      continue;
    }

    const workflowState = getEpisode({ root, channelId, productionId: p.id }).state;
    const { progress_percent } = pipelineOf(p, workflowState);

    items.push({
      id: p.id,
      title: p.title || "(sans titre)",
      type,
      mode: p.mode,
      pipeline_status: p.status,
      workflow_state: workflowState,
      bucket: bucketOf(workflowState, progress_percent),
      progress_percent,
      video_id: entry?.video_id ?? null,
      target_date: entry?.target_date ?? null,
      linked: Boolean(entry),
      locked: Boolean(p.locked),
      thumbnail: null,
      _production: p
    });
  }

  items.sort((a, b) => {
    if (a.target_date && b.target_date && a.target_date !== b.target_date) return a.target_date < b.target_date ? -1 : 1;
    if (a.target_date !== b.target_date) return a.target_date ? -1 : 1;

    return a.id < b.id ? 1 : -1;
  });

  return { items, listed, hiddenTests };
}

const strip = ({ _production, ...item }) => item;

export function productionsView({ root, channelId, includeTests = false, limit = 200 }) {
  const { items, listed, hiddenTests } = collect({ root, channelId, includeTests, limit });
  const counts = { planned: 0, in_progress: 0, published: 0, archived: 0 };

  for (const item of items) counts[item.bucket] += 1;

  return {
    items: items.map(strip),
    counts,
    totals: { in_pipeline: listed.total, shown: items.length, hidden_tests: hiddenTests, truncated: listed.total > listed.shown.length },
    thumbnails: "not_available"
  };
}

export function pipelineView({ root, channelId, productionId = null }) {
  const { items } = collect({ root, channelId, includeTests: false, limit: 200 });
  const target = productionId ? items.find(i => i.id === productionId) : items.find(i => i.bucket !== "published" && i.bucket !== "archived") ?? items[0];

  if (!target) return { production: null, stages: STUDIO_STAGES.map(s => stageView(s, null, "idea")), progress_percent: 0 };

  return { production: { id: target.id, title: target.title, workflow_state: target.workflow_state }, ...pipelineOf(target._production, target.workflow_state) };
}

function blockersOf(item, plan) {
  const blockers = [];

  if (item.locked) blockers.push({ code: "locked", label: "Production verrouillée (exécution en cours ou interrompue)" });

  for (const stage of pipelineOf(item._production, item.workflow_state).stages) {
    if (stage.status === "failed") blockers.push({ code: "stage_failed", label: `Étape « ${stage.label} » en échec` });
  }

  if (plan.requires_approval) blockers.push({ code: "approval_required", label: "Approbation humaine requise avant la prochaine étape" });
  if (!item.target_date) blockers.push({ code: "no_target_date", label: "Aucune date cible définie" });

  return blockers;
}

export function plannerView({ root, channelId }) {
  const { items } = collect({ root, channelId, includeTests: false, limit: 200 });
  const open = items.filter(i => i.bucket === "planned" || i.bucket === "in_progress");

  if (open.length === 0) return { next: null, queue: [], priority: "not_defined" };

  const describe = item => {
    const plan = planNext({ stageStates: stageStatesFromProduction(item._production) });

    return {
      production_id: item.id,
      title: item.title,
      deadline: item.target_date,
      workflow_state: item.workflow_state,
      bucket: item.bucket,
      progress_percent: item.progress_percent,
      recommendation: { next_engine: plan.next, action: plan.action, reason: plan.reason, requires_approval: plan.requires_approval },
      blockers: blockersOf(item, plan)
    };
  };

  return { next: describe(open[0]), queue: open.slice(1, 6).map(describe), priority: "not_defined" };
}

const COMMENT_COLUMNS = Object.freeze([
  { key: "new", label: "Nouveau", states: ["ingested", "classified"] },
  { key: "priority", label: "Prioritaire", states: ["prioritized"] },
  { key: "fact_check", label: "Fact-check", states: ["contextualized", "fact_checked"] },
  { key: "proposed", label: "Réponse proposée", states: ["proposed"] },
  { key: "human_review", label: "Validation humaine", states: ["in_review", "approved"] },
  { key: "published", label: "Publié", states: ["published"] }
]);

export function commentsView({ root, channelId }) {
  const base = { root, channelId, engine: "agent", purpose: "studio_comments_board" };
  const board = selectContext({ ...base, partition: "comments", budget: REVIEW_BUDGET });
  const review = selectForReview({ ...base, budget: REVIEW_BUDGET });
  const reviewByRef = new Map(review.entries.map(e => [e.data.comment_ref, e.data]));

  const columns = COMMENT_COLUMNS.map(col => ({
    key: col.key,
    label: col.label,
    items: board.entries
      .filter(e => col.states.includes(e.data.state))
      .map(e => {
        const detail = reviewByRef.get(e.data.comment_ref) ?? {};

        return {
          ref: String(e.data.comment_ref ?? e.id).slice(0, 12),
          video_id: e.data.video_id ?? null,
          type: e.data.class ?? null,
          priority_score: e.data.priority_score ?? null,
          author_label: detail.author_ref ? `Auteur ${String(detail.author_ref).slice(0, 6)}` : null,
          excerpt: detail.excerpt ?? null,
          proposal_text: detail.proposal_text ?? null,
          state: e.data.state
        };
      })
  }));

  return {
    columns,
    ingestion: "not_connected",
    untrusted_text: true,
    auto_reply: false,
    human_validation_required: true,
    actions: { enabled: false, reason: "ingestion_unavailable", available: ["validate", "edit", "ignore"] }
  };
}

const ANALYTICS_CARDS = Object.freeze([
  ["ctr", "CTR"], ["watch_time", "Watch Time"], ["retention", "Retention"], ["subscribers", "Subscribers"], ["views", "Views"], ["revenue", "Revenue"]
]);

export function analyticsView() {
  return {
    source: "not_connected",
    reason: "youtube_api_not_connected",
    cards: ANALYTICS_CARDS.map(([key, label]) => ({ key, label, status: "not_connected", value: null })),
    top_videos: { status: "not_connected", items: [] },
    worst_videos: { status: "not_connected", items: [] }
  };
}

function learningItems({ root, channelId, type }) {
  return selectContext({
    root, channelId, partition: "learning", engine: "agent", purpose: "studio_learning_view",
    budget: { max_entries: 20, max_bytes: 8 * 1024 }, filter: { types: [type] }
  }).entries.map(e => ({ id: e.id, ts: e.ts, text: e.data?.text ?? e.data?.rule?.statement ?? null }));
}

export function learningView({ root, channelId }) {
  const index = readJson(partitionFile(root, channelId, "knowledge", "index.json"), null);
  const documents = Array.isArray(index?.documents) ? index.documents.length : 0;

  return {
    read_only: true,
    observations: learningItems({ root, channelId, type: "observation" }),
    validated_learnings: learningItems({ root, channelId, type: "validated_learning" }),
    prompt_updates: learningItems({ root, channelId, type: "prompt_update" }),
    knowledge: { status: documents > 0 ? "ok" : "empty", documents }
  };
}

export function journalView({ root, channelId, limit = 50 }) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));

  return {
    entries: readJournal({ root, channelId, maxLines: capped }).reverse().map(e => ({
      ts: e.ts,
      type: e.type,
      action: e.action ?? e.type,
      engine: e.engine ?? null,
      subject_id: e.subject_id ?? null,
      outcome: e.outcome ?? null,
      // Aucun nom d'utilisateur n'est stocké : on distingue seulement la validation humaine.
      actor: e.approval_hash ? "human_approved" : "agent_recorded",
      validation: e.approval_hash ? "approved" : "none"
    }))
  };
}

export function settingsView({ root, channelId }) {
  const pipeline = readPipelineSettings(root);

  return {
    read_only: true,
    channel: { id: channelId },
    language: pipeline.project?.language ?? null,
    project: pipeline.project ?? null,
    writing_style: { status: "not_defined" },
    narration_voice: pipeline.voice ?? null,
    workflow: {
      transitions: EPISODE_TRANSITIONS.length,
      approval_required_on: EPISODE_TRANSITIONS.filter(t => t.approval).map(t => `${t.from}→${t.to}`)
    },
    comments: { human_validation_required: true, auto_reply: false, ingestion: "not_connected" },
    publication: { status: "not_connected", approval_required: true }
  };
}

export function systemView({ root, channelId }) {
  const listed = listProductions({ root, limit: 200 });
  const registry = loadRegistry({ root, channelId });
  const journal = readJournal({ root, channelId, maxLines: 1 });
  let dataReady = false;

  try {
    dataReady = fs.existsSync(channelDir(root, channelId));
  } catch {
    dataReady = false;
  }

  return {
    agent: { name: "youtube-agent", phase: "R18.3" },
    channel_id: channelId,
    data: { channel_dir_exists: dataReady },
    productions: { in_pipeline: listed.total, readable: listed.shown.filter(p => p.readable).length, inspected: listed.shown.length },
    registry: { linked: registry.videos.length, updated_at: registry.updated_at },
    journal: { last_ts: journal.at(-1)?.ts ?? null },
    engines: {
      existing: ENGINES.filter(e => e.kind === "existing").length,
      planned: ENGINES.filter(e => e.kind === "planned").length,
      undecided: ENGINES.filter(e => e.kind === "undecided").length,
      external_actions_require_approval: ENGINES.filter(e => e.capabilities.some(requiresApproval)).length
    },
    integrations: { youtube_api: "not_connected", oauth: "not_connected", network: "loopback_only" },
    safety: { auto_reply: false, human_validation_required: true, engines_executable: ENGINES.filter(e => isExecutableInR182(e.capabilities)).length }
  };
}
