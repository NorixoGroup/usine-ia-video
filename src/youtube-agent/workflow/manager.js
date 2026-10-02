// Workflow Manager : machine à états persistée par épisode (partition « videos »).
// Il décide si une transition est permise, l'enregistre et la journalise.
// Il n'exécute AUCUN moteur et n'écrit jamais dans le pipeline.

import { readJson, writeJsonAtomic, withFileLock } from "../atomic-json.js";
import { partitionFile } from "../paths.js";
import { assertChannelId } from "../channels.js";
import { isValidProductionId } from "../../orchestrator/resume.js";
import { verifyApproval } from "../approvals.js";
import { appendJournal } from "../journal.js";
import { EPISODE_STATES, INITIAL_EPISODE_STATE, findTransition } from "./transitions.js";

export const WORKFLOW_SCHEMA = "youtube-agent.workflow.v1";
const WORKFLOW_FILE = "workflow.json";
const MAX_HISTORY = 200;

function file(root, channelId) {
  return partitionFile(root, channelId, "videos", WORKFLOW_FILE);
}

function load(root, channelId) {
  const data = readJson(file(root, channelId), null);

  if (data === null) return { schema: WORKFLOW_SCHEMA, channel_id: channelId, episodes: {} };

  if (data.schema !== WORKFLOW_SCHEMA || data.channel_id !== channelId || typeof data.episodes !== "object") {
    throw new Error("Workflow illisible ou d'un autre schéma");
  }

  return data;
}

// Action que l'approbation doit viser pour autoriser from → to.
export function approvalActionFor({ channelId, productionId, from, to }) {
  const rule = findTransition(from, to);

  if (!rule?.approval) return null;

  return {
    channel_id: channelId,
    engine: rule.approval.engine,
    action: `workflow:${from}->${to}`,
    subject_id: productionId,
    content_sha256: null
  };
}

export function getEpisode({ root, channelId, productionId }) {
  assertChannelId(channelId);

  if (!isValidProductionId(productionId)) throw new Error("production_id invalide");

  return load(root, channelId).episodes[productionId] ?? { state: INITIAL_EPISODE_STATE, history: [] };
}

export function transitionEpisode({ root, channelId, productionId, to, approval = null, now = new Date() }) {
  assertChannelId(channelId);

  if (!isValidProductionId(productionId)) throw new Error("production_id invalide");

  const refuse = reason => {
    appendJournal({
      root, channelId, now,
      entry: { type: "workflow_refused", engine: "workflow", action: `to:${String(to).slice(0, 40)}`, subject_id: productionId, outcome: reason }
    });

    return { ok: false, reason };
  };

  if (!EPISODE_STATES.includes(to)) return refuse("unknown_state");

  return withFileLock(file(root, channelId), () => {
    const data = load(root, channelId);
    const current = data.episodes[productionId] ?? { state: INITIAL_EPISODE_STATE, history: [] };

    // Idempotence : rejouer une transition déjà appliquée ne change rien.
    if (current.state === to) return { ok: true, changed: false, state: current.state };

    const rule = findTransition(current.state, to);

    if (!rule) return refuse("transition_not_allowed");

    let approvalHash = null;

    if (rule.approval) {
      const action = approvalActionFor({ channelId, productionId, from: current.state, to });
      const verdict = verifyApproval(approval, action, { now });

      if (!verdict.ok) return refuse(verdict.reason);

      approvalHash = approval.action_hash;
    }

    const history = [...current.history, { from: current.state, to, at: now.toISOString(), approval_hash: approvalHash }].slice(-MAX_HISTORY);

    data.episodes[productionId] = { state: to, history };
    writeJsonAtomic(file(root, channelId), data);

    appendJournal({
      root, channelId, now,
      entry: { type: "workflow_transition", engine: "workflow", action: `${current.state}->${to}`, subject_id: productionId, outcome: "applied", ...(approvalHash ? { approval_hash: approvalHash } : {}) }
    });

    return { ok: true, changed: true, state: to };
  });
}
