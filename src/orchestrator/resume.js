// Reprise d'une production existante (R13).
//
// Une reprise ne rappelle JAMAIS un agent payant déjà réussi :
// - agents 1-3 (Research, Script, Visual Director) : réutilisés si leur
//   artefact existe, correspond au scellé SHA-256 de production.json et
//   porte une enveloppe valide du bon mode ;
// - agents 4-7 : déterministes et gratuits, toujours recalculés (ils
//   dépendent du dossier de médias).
//
// Tout artefact absent, altéré, sans scellé ou incohérent avec l'état
// des agents fait REFUSER la reprise : jamais de réparation silencieuse,
// jamais de régénération de remplacement.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { writeJsonArtifact } from "./artifacts.js";

export const AGENT_ORDER = [
  "research",
  "script",
  "visual_director",
  "asset",
  "voice",
  "assembly",
  "quality"
];

// Agents qu'on peut arrêter avec --stop-after (Quality est la fin).
export const STOP_AFTER_VALUES = AGENT_ORDER.slice(0, 6);

// Agents dont l'artefact est scellé et réutilisable.
export const REUSABLE_AGENTS = ["research", "script", "visual_director"];

export const ARTIFACT_OF = {
  research: "research.json",
  script: "script.json",
  visual_director: "visual.json"
};

const ENVELOPE_AGENT = {
  research: "research",
  script: "script",
  visual_director: "visual_director"
};

export const RESUMABLE_STATUSES = ["failed", "paused", "running"];

export const LOCK_FILE = ".lock";

const PRODUCTION_ID_PATTERN =
  /^prod-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;

function sha256Of(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// Même sérialisation que writeJsonArtifact : le scellé est calculé en
// mémoire, sans relecture du fichier.
export function serializeArtifact(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

// Scelle puis écrit. Le scellé est enregistré dans production.json
// AVANT l'écriture de l'artefact : un crash entre les deux laisse un
// scellé sans artefact (agent relancé), jamais l'inverse.
export function sealAndWriteArtifact({
  productionDir,
  production,
  filename,
  data,
  save
}) {
  production.artifact_sha256 ??= {};
  production.artifact_sha256[filename] = sha256Of(serializeArtifact(data));

  save();

  return writeJsonArtifact(productionDir, filename, data);
}

export function isValidProductionId(productionId) {
  return (
    typeof productionId === "string" &&
    PRODUCTION_ID_PATTERN.test(productionId)
  );
}

export function loadResumableProduction({ root, productionId }) {
  if (!isValidProductionId(productionId)) {
    throw new Error(
      `Reprise : identifiant de production invalide "${productionId ?? ""}".`
    );
  }

  const productionDir = path.join(root, "projects", productionId);

  let stat;

  try {
    stat = fs.lstatSync(productionDir);
  } catch {
    throw new Error(
      `Reprise : production introuvable "${productionId}".`
    );
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `Reprise : "${productionId}" n'est pas un dossier de production.`
    );
  }

  let production;

  try {
    production = JSON.parse(
      fs.readFileSync(path.join(productionDir, "production.json"), "utf8")
    );
  } catch {
    throw new Error(
      `Reprise : production.json illisible pour "${productionId}".`
    );
  }

  if (
    !production ||
    production.id !== productionId ||
    !Array.isArray(production.agents) ||
    !AGENT_ORDER.every(id =>
      production.agents.some(agent => agent.id === id)
    )
  ) {
    throw new Error(
      `Reprise : production.json incohérent pour "${productionId}".`
    );
  }

  if (!RESUMABLE_STATUSES.includes(production.status)) {
    throw new Error(
      `Reprise refusée : statut "${production.status}" non reprenable ` +
      `(admis : ${RESUMABLE_STATUSES.join(", ")}).`
    );
  }

  if (
    !production.artifact_sha256 ||
    typeof production.artifact_sha256 !== "object"
  ) {
    throw new Error(
      "Reprise refusée : aucun scellé SHA-256 dans production.json " +
      "(production antérieure à R13)."
    );
  }

  return { productionDir, production };
}

export function productionMode(production) {
  return production.mode ?? "test";
}

function fail(message) {
  throw new Error(`Reprise refusée : ${message}`);
}

// Décide, agent par agent, ce qui est réutilisé. Lève au moindre doute.
export function planReuse({ productionDir, production }) {
  const mode = productionMode(production);
  const reuse = {};
  let chainBroken = false;

  for (const agentId of REUSABLE_AGENTS) {
    const state = production.agents.find(agent => agent.id === agentId);
    const filename = ARTIFACT_OF[agentId];
    const file = path.join(productionDir, filename);
    const exists = fs.existsSync(file);
    const finished =
      state.status === "completed" || state.status === "running";

    if (finished && exists) {
      if (chainBroken) {
        fail(
          `${filename} présent alors qu'un agent précédent doit être relancé.`
        );
      }

      const seal = production.artifact_sha256[filename];

      if (typeof seal !== "string" || !/^[0-9a-f]{64}$/.test(seal)) {
        fail(`${filename} n'a pas de scellé SHA-256.`);
      }

      const raw = fs.readFileSync(file);

      if (sha256Of(raw) !== seal) {
        fail(`${filename} ne correspond plus à son scellé SHA-256.`);
      }

      let envelope;

      try {
        envelope = JSON.parse(raw.toString("utf8"));
      } catch {
        fail(`${filename} n'est pas un JSON valide.`);
      }

      if (
        !envelope ||
        envelope.agent !== ENVELOPE_AGENT[agentId] ||
        envelope.mode !== mode ||
        !envelope.data ||
        typeof envelope.data !== "object" ||
        !envelope.validation
      ) {
        fail(`${filename} : enveloppe incohérente (agent, mode ou data).`);
      }

      for (const [key, value] of Object.entries(envelope)) {
        if (
          (key === "validation" || key.endsWith("_validation")) &&
          value?.valid !== true
        ) {
          fail(`${filename} : ${key} n'est pas valide.`);
        }
      }

      reuse[agentId] = true;
      continue;
    }

    if (state.status === "completed" && !exists) {
      fail(`${filename} manquant alors que l'agent ${agentId} est terminé.`);
    }

    if (
      (state.status === "failed" || state.status === "pending") &&
      exists
    ) {
      fail(
        `${filename} présent alors que l'agent ${agentId} est "${state.status}".`
      );
    }

    reuse[agentId] = false;
    chainBroken = true;
  }

  return reuse;
}

// Applique la reprise à l'état en mémoire (saveProduction est laissé à
// l'appelant). Lève AVANT toute mutation si la reprise est incohérente.
export function applyResume({ production, reuse, mediaDir, render }) {
  if (production.render && !render) {
    fail(
      "la production a été créée avec --render : reprendre avec --render."
    );
  }

  const history = {
    at: new Date().toISOString(),
    previous_status: production.status,
    previous_media_dir: production.input?.media_dir ?? null,
    media_dir: mediaDir ?? null,
    reused: [],
    recomputed: [],
    previous_errors: []
  };

  for (const agent of production.agents) {
    if (reuse[agent.id]) {
      history.reused.push(agent.id);

      if (agent.status !== "completed") {
        agent.status = "completed";
        agent.completed_at = new Date().toISOString();
        agent.error = null;
      }

      agent.resumed = true;
      continue;
    }

    history.recomputed.push(agent.id);

    if (agent.error) {
      history.previous_errors.push({
        agent: agent.id,
        error: agent.error
      });
    }

    delete agent.resumed;
    agent.status = "pending";
    agent.started_at = null;
    agent.completed_at = null;
    agent.error = null;
  }

  production.status = "running";
  delete production.completed_at;
  delete production.paused_after;
  delete production.paused_at;

  if (mediaDir) {
    production.input.media_dir = mediaDir;
  } else {
    delete production.input.media_dir;
  }

  if (render) {
    production.render = render;
  }

  production.resume_history ??= [];
  production.resume_history.push(history);

  return history;
}

// Verrou exclusif de production : refuse une seconde exécution
// simultanée (donc un double appel). Retiré à la sortie du processus ;
// un verrou périmé (crash brutal) doit être supprimé à la main.
export function acquireProductionLock(productionDir) {
  const file = path.join(productionDir, LOCK_FILE);
  let descriptor;

  try {
    descriptor = fs.openSync(file, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      let holder = "";

      try {
        holder = ` (${fs.readFileSync(file, "utf8").trim()})`;
      } catch {
        // Contenu illisible : le refus reste valable.
      }

      throw new Error(
        `Production verrouillée : ${LOCK_FILE} présent${holder}. ` +
        "Exécution refusée (fail-closed). Si aucun processus ne tourne, " +
        "supprimer ce verrou à la main."
      );
    }

    throw error;
  }

  fs.writeSync(
    descriptor,
    JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString()
    }) + "\n"
  );
  fs.closeSync(descriptor);

  let released = false;

  const release = () => {
    if (released) {
      return;
    }

    released = true;

    try {
      fs.unlinkSync(file);
    } catch {
      // Déjà retiré.
    }
  };

  process.on("exit", release);

  return release;
}

// Besoins de médias, affichés sur stdout (aucun artefact n'est créé).
export function describeMediaNeeds({ assets, voice }) {
  const lines = [];

  if (Array.isArray(assets?.assets)) {
    lines.push(`Assets à déposer (${assets.assets.length}) :`);

    for (const asset of assets.assets) {
      lines.push(
        `  assets/${asset.asset_id}.<ext>  ` +
        `${asset.asset_type}, ${asset.duration_seconds} s — ` +
        `${asset.visual_description}`
      );
    }
  }

  if (Array.isArray(voice?.narration_units)) {
    lines.push(`Narrations à déposer (${voice.narration_units.length}) :`);

    for (const unit of voice.narration_units) {
      lines.push(
        `  voice/${unit.unit_id}.<ext>  ` +
        `narration ~${unit.estimated_seconds} s`
      );
    }
  }

  return lines;
}
