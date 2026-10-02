// Façade du YouTube Agent : orchestration pure. Elle décrit, lit l'état,
// recommande (Planner), fait avancer un épisode (Workflow Manager) et journalise.
// Elle ne génère rien et n'exécute aucun moteur en R18.2.

import { ENGINES, getEngine } from "./engines.js";
import { CAPABILITIES } from "./capabilities.js";
import { listProductions, getProduction } from "./productions-reader.js";
import { loadRegistry, upsertVideo } from "./videos-registry.js";
import { planNext, stageStatesFromProduction } from "./planner.js";
import { getEpisode, transitionEpisode } from "./workflow/manager.js";
import { EPISODE_STATES, EPISODE_TRANSITIONS } from "./workflow/transitions.js";
import { appendJournal } from "./journal.js";
import { assertChannelId } from "./channels.js";
import { PARTITIONS } from "./memory/partitions.js";
import { COMMENT_STATES } from "./comments/states.js";
import { ANALYTICS_STAGES } from "./analytics/stages.js";
import { LEARNING_STATES } from "./learning/cycle.js";
import {
  systemView, productionsView, pipelineView, plannerView, commentsView,
  analyticsView, learningView, journalView, settingsView
} from "./studio-models.js";

export function createYouTubeAgent({ root, now = () => new Date() }) {
  return {
    describe() {
      return {
        engines: ENGINES,
        capabilities: CAPABILITIES,
        partitions: PARTITIONS,
        episode_states: EPISODE_STATES,
        episode_transitions: EPISODE_TRANSITIONS,
        comment_states: COMMENT_STATES,
        analytics_stages: ANALYTICS_STAGES,
        learning_states: LEARNING_STATES
      };
    },

    status({ channelId }) {
      assertChannelId(channelId);

      const productions = listProductions({ root });
      const episodes = {};

      for (const p of productions.shown) {
        episodes[p.id] = getEpisode({ root, channelId, productionId: p.id }).state;
      }

      return { channel_id: channelId, productions, registry: loadRegistry({ root, channelId }), episodes };
    },

    plan({ channelId, productionId }) {
      assertChannelId(channelId);

      const production = getProduction({ root, productionId });

      if (!production) return { ok: false, reason: "production_not_found" };

      return {
        ok: true,
        workflow_state: getEpisode({ root, channelId, productionId }).state,
        plan: planNext({ stageStates: stageStatesFromProduction(production) })
      };
    },

    advance({ channelId, productionId, to, approval = null }) {
      return transitionEpisode({ root, channelId, productionId, to, approval, now: now() });
    },

    // Enregistre le lien production ↔ vidéo (registre) et le journalise.
    linkVideo({ channelId, entry }) {
      assertChannelId(channelId);

      const saved = upsertVideo({ root, channelId, entry, now: now() });

      appendJournal({
        root, channelId, now: now(),
        entry: { type: "video_linked", engine: "agent", action: "link_video", subject_id: saved.production_id, outcome: saved.type }
      });

      return saved;
    },

    // Vues du Studio : lecture seule, aucune valeur inventée.
    system({ channelId }) { return systemView({ root, channelId: assertChannelId(channelId) }); },
    productions({ channelId, includeTests = false }) { return productionsView({ root, channelId: assertChannelId(channelId), includeTests }); },
    pipeline({ channelId, productionId = null }) { return pipelineView({ root, channelId: assertChannelId(channelId), productionId }); },
    planner({ channelId }) { return plannerView({ root, channelId: assertChannelId(channelId) }); },
    comments({ channelId }) { return commentsView({ root, channelId: assertChannelId(channelId) }); },
    analytics({ channelId }) { assertChannelId(channelId); return analyticsView(); },
    learning({ channelId }) { return learningView({ root, channelId: assertChannelId(channelId) }); },
    journal({ channelId, limit = 50 }) { return journalView({ root, channelId: assertChannelId(channelId), limit }); },
    settings({ channelId }) { return settingsView({ root, channelId: assertChannelId(channelId) }); },

    // R18.2 : aucun moteur ne s'exécute. Le refus est motivé et journalisé.
    execute({ channelId, engineId }) {
      assertChannelId(channelId);

      const engine = getEngine(engineId);
      const reason = !engine ? "unknown_engine"
        : engine.kind !== "existing" ? "engine_not_implemented"
        : "not_executable_in_r18_2";

      appendJournal({
        root, channelId, now: now(),
        entry: { type: "execute_refused", engine: String(engineId).slice(0, 40), action: "execute", outcome: reason }
      });

      return { ok: false, reason };
    }
  };
}
