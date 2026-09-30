import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  runResearchAgent
} from "../agents/research.js";

import {
  runScriptAgent
} from "../agents/script.js";

import {
  runVisualDirector
} from "../agents/visual-director.js";

import {
  runAssetAgent
} from "../agents/asset.js";

import {
  writeJsonArtifact,
  readJsonArtifact
} from "./artifacts.js";

const ROOT = process.cwd();

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, relativePath), "utf8")
  );
}

const pipelineConfig = readJson("config/pipeline.json");
const agentsConfig = readJson("config/agents.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const researchScriptMode = args.includes("--research-script");

if (dryRun && researchScriptMode) {
  throw new Error(
    "Orchestrateur : --dry-run et --research-script sont incompatibles."
  );
}

function getArgument(name) {
  const prefix = `--${name}=`;
  const arg = args.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : null;
}

const title =
  getArgument("title") ||
  "Pourquoi 95 % de l'Australie est presque vide ?";

const prompt =
  getArgument("prompt") ||
  "Documentaire géographique factuel destiné à la chaîne Les Découvertes du Nomade.";

const productionId = `prod-${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;

const productionDir = path.join(ROOT, "projects", productionId);

fs.mkdirSync(productionDir, { recursive: true });

const production = {
  id: productionId,
  created_at: new Date().toISOString(),
  status: "created",

  input: {
    title,
    prompt
  },

  target: {
    platform: pipelineConfig.project.platform,
    language: pipelineConfig.project.language,
    content_type: pipelineConfig.project.content_type,
    duration_minutes: {
      target: pipelineConfig.video.target_duration_minutes,
      min: pipelineConfig.video.minimum_duration_minutes,
      max: pipelineConfig.video.maximum_duration_minutes
    },
    video: {
      aspect_ratio: pipelineConfig.video.aspect_ratio,
      width: pipelineConfig.video.resolution.width,
      height: pipelineConfig.video.resolution.height,
      fps: pipelineConfig.video.fps
    }
  },

  agents: agentsConfig.agents.map((agent) => ({
    id: agent.id,
    order: agent.order,
    status: "pending",
    started_at: null,
    completed_at: null,
    error: null
  }))
};

function saveProduction() {
  fs.writeFileSync(
    path.join(productionDir, "production.json"),
    JSON.stringify(production, null, 2) + "\n"
  );
}

saveProduction();

console.log("==============================================");
console.log(" LES DECOUVERTES DU NOMADE — USINE IA VIDEO");
console.log("==============================================");
console.log("");
console.log("Production :", production.id);
console.log("Titre      :", production.input.title);
console.log(
  "Format     :",
  `${production.target.video.width}x${production.target.video.height}`,
  production.target.video.aspect_ratio,
  `${production.target.video.fps}fps`
);
console.log(
  "Durée      :",
  `${production.target.duration_minutes.min}-${production.target.duration_minutes.max} min`
);
console.log(
  "Mode       :",
  dryRun
    ? "DRY-RUN"
    : researchScriptMode
      ? "RESEARCH-SCRIPT"
      : "LIVE"
);
console.log("");

if (!dryRun && !researchScriptMode) {
  console.log("STOP — le mode LIVE complet n'est pas encore autorisé.");
  console.log(
    "Utilise --dry-run ou --research-script pendant la construction du MVP."
  );
  process.exit(2);
}

console.log("--- PIPELINE ---");

if (dryRun) {
  for (const agentState of production.agents) {
    const agentDefinition = agentsConfig.agents.find(
      (agent) => agent.id === agentState.id
    );

    agentState.status = "running";
    agentState.started_at = new Date().toISOString();
    saveProduction();

    console.log("");
    console.log(
      `[${agentState.order}/${production.agents.length}] ${agentState.id}`
    );
    console.log(`    ${agentDefinition.role}`);

    // DRY-RUN historique : aucune API appelée.
    agentState.status = "dry_run_pass";
    agentState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ DRY-RUN PASS");
  }
} else if (researchScriptMode) {
  const researchState = production.agents.find(
    (agent) => agent.id === "research"
  );

  const scriptState = production.agents.find(
    (agent) => agent.id === "script"
  );

  const visualDirectorState = production.agents.find(
    (agent) => agent.id === "visual_director"
  );

  const assetState = production.agents.find(
    (agent) => agent.id === "asset"
  );

  if (
    !researchState ||
    !scriptState ||
    !visualDirectorState ||
    !assetState
  ) {
    throw new Error(
      "Orchestrateur : états Research/Script/Visual Director/Asset introuvables."
    );
  }

  try {
    console.log("");
    console.log(
      `[${researchState.order}/${production.agents.length}] research`
    );

    researchState.status = "running";
    researchState.started_at = new Date().toISOString();
    saveProduction();

    const researchResult = await runResearchAgent({
      title,
      prompt,
      testMode: true
    });

    writeJsonArtifact(
      productionDir,
      "research.json",
      researchResult
    );

    researchState.status = "completed";
    researchState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Research PASS");
    console.log("    ✓ research.json écrit");

    const persistedResearch = readJsonArtifact(
      productionDir,
      "research.json"
    );

    if (
      !persistedResearch ||
      !persistedResearch.data
    ) {
      throw new Error(
        "Orchestrateur : research.json ne contient pas data."
      );
    }

    console.log("");
    console.log(
      `[${scriptState.order}/${production.agents.length}] script`
    );

    scriptState.status = "running";
    scriptState.started_at = new Date().toISOString();
    saveProduction();

    const scriptResult = await runScriptAgent({
      research: persistedResearch.data,
      title,
      testMode: true
    });

    writeJsonArtifact(
      productionDir,
      "script.json",
      scriptResult
    );

    scriptState.status = "completed";
    scriptState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Script PASS");
    console.log("    ✓ script.json écrit");

    const persistedScript = readJsonArtifact(
      productionDir,
      "script.json"
    );

    if (
      !persistedScript ||
      !persistedScript.data
    ) {
      throw new Error(
        "Orchestrateur : script.json ne contient pas data."
      );
    }

    console.log("");
    console.log(
      `[${visualDirectorState.order}/${production.agents.length}] visual_director`
    );

    visualDirectorState.status = "running";
    visualDirectorState.started_at = new Date().toISOString();
    saveProduction();

    const visualResult = await runVisualDirector({
      script: persistedScript.data,
      testMode: true
    });

    writeJsonArtifact(
      productionDir,
      "visual.json",
      visualResult
    );

    visualDirectorState.status = "completed";
    visualDirectorState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Visual Director PASS");
    console.log("    ✓ visual.json écrit");

    const persistedVisual = readJsonArtifact(
      productionDir,
      "visual.json"
    );

    if (
      !persistedVisual ||
      !persistedVisual.data
    ) {
      throw new Error(
        "Orchestrateur : visual.json ne contient pas data."
      );
    }

    console.log("");
    console.log(
      `[${assetState.order}/${production.agents.length}] asset`
    );

    assetState.status = "running";
    assetState.started_at = new Date().toISOString();
    saveProduction();

    const assetResult = await runAssetAgent({
      visual: persistedVisual.data,
      testMode: true
    });

    writeJsonArtifact(
      productionDir,
      "assets.json",
      assetResult
    );

    assetState.status = "completed";
    assetState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Asset PASS");
    console.log("    ✓ assets.json écrit");

    for (const agentState of production.agents) {
      if (
        agentState.id !== "research" &&
        agentState.id !== "script" &&
        agentState.id !== "visual_director" &&
        agentState.id !== "asset"
      ) {
        agentState.status = "pending";
      }
    }

    production.status = "research_script_visual_asset_pass";
    production.completed_at = new Date().toISOString();
    saveProduction();

    console.log("");
    console.log("==============================================");
    console.log(
      " RESULTAT : PASS — RESEARCH -> SCRIPT -> VISUAL DIRECTOR -> ASSET"
    );
    console.log(
      ` Artefacts : projects/${production.id}/research.json`
    );
    console.log(
      `             projects/${production.id}/script.json`
    );
    console.log(
      `             projects/${production.id}/visual.json`
    );
    console.log(
      `             projects/${production.id}/assets.json`
    );
    console.log(" Agents 5-7 : NON EXECUTES");
    console.log("==============================================");

    process.exit(0);
  } catch (error) {
    const runningAgent = production.agents.find(
      (agent) => agent.status === "running"
    );

    if (runningAgent) {
      runningAgent.status = "failed";
      runningAgent.completed_at = new Date().toISOString();
      runningAgent.error =
        error instanceof Error
          ? error.message
          : String(error);
    }

    production.status = "failed";
    production.completed_at = new Date().toISOString();
    saveProduction();

    console.error("");
    console.error("==============================================");
    console.error(" RESULTAT : FAIL — PIPELINE ARRETE");
    console.error(
      error instanceof Error
        ? error.message
        : String(error)
    );
    console.error("==============================================");

    process.exit(1);
  }
}

production.status = "dry_run_pass";
production.completed_at = new Date().toISOString();

saveProduction();

console.log("");
console.log("==============================================");
console.log(" RESULTAT : PASS — ORCHESTRATEUR DRY-RUN");
console.log(" Aucun appel API effectué.");
console.log(" Aucun crédit consommé.");
console.log(` État : projects/${production.id}/production.json`);
console.log("==============================================");
