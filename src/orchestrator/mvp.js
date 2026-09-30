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
  runVoiceAgent
} from "../agents/voice.js";

import {
  runAssemblyAgent
} from "../agents/assembly.js";

import {
  runQualityAgent
} from "../agents/quality.js";

import {
  inspectLocalAssets,
  inspectLocalVoice,
  verifyLocalMedia
} from "../media/local-media.js";

import {
  renderVideo,
  verifyRenderedVideo
} from "../render/ffmpeg-renderer.js";

import {
  RENDER_PROFILE_NAMES
} from "../render/render-timeline.js";

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

// Dossier de médias locaux, optionnel. Absent : le pipeline ne produit
// que des contrats, comme avant. Présent : chaque asset et chaque unité
// de narration doit y trouver son fichier (tout ou rien).
const mediaDir = getArgument("media-dir");

if (
  args.some((value) => value.startsWith("--media-dir")) &&
  !mediaDir
) {
  throw new Error(
    "Orchestrateur : --media-dir exige un dossier (--media-dir=<dossier>)."
  );
}

// Rendu réel du MP4, sur demande explicite uniquement. Sans --render,
// le pipeline s'arrête au plan de montage, comme avant.
const renderRequested = args.includes("--render");
const renderProfile = getArgument("render-profile") || "target";
const renderOutputDir =
  getArgument("output-dir") || path.join(ROOT, "output");

if (renderRequested && !mediaDir) {
  throw new Error(
    "Orchestrateur : --render exige --media-dir=<dossier>."
  );
}

if (renderRequested && !researchScriptMode) {
  throw new Error(
    "Orchestrateur : --render exige --research-script."
  );
}

if (
  !renderRequested &&
  args.some(
    (value) =>
      value.startsWith("--render-profile") ||
      value.startsWith("--output-dir")
  )
) {
  throw new Error(
    "Orchestrateur : --render-profile et --output-dir exigent --render."
  );
}

if (!RENDER_PROFILE_NAMES.includes(renderProfile)) {
  throw new Error(
    `Orchestrateur : --render-profile inconnu "${renderProfile}". ` +
    `Valeurs admises : ${RENDER_PROFILE_NAMES.join(", ")}.`
  );
}

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

if (mediaDir) {
  production.input.media_dir = mediaDir;
}

// État de l'étape technique de rendu, entre Assembly et Quality. Ce
// n'est pas un agent : les 7 agents restent inchangés.
if (renderRequested) {
  production.render = {
    status: "pending",
    profile: renderProfile,
    output_dir: renderOutputDir,
    output_file: `${productionId}.mp4`,
    started_at: null,
    completed_at: null,
    error: null
  };
}

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
console.log(
  "Médias     :",
  mediaDir
    ? `locaux — ${mediaDir}`
    : "aucun (contrats seuls)"
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

  const voiceState = production.agents.find(
    (agent) => agent.id === "voice"
  );

  const assemblyState = production.agents.find(
    (agent) => agent.id === "assembly"
  );

  const qualityState = production.agents.find(
    (agent) => agent.id === "quality"
  );

  if (
    !researchState ||
    !scriptState ||
    !visualDirectorState ||
    !assetState ||
    !voiceState ||
    !assemblyState ||
    !qualityState
  ) {
    throw new Error(
      "Orchestrateur : états Research/Script/Visual Director/Asset/Voice/Assembly/Quality introuvables."
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
      testMode: true,
      localMedia: mediaDir
        ? await inspectLocalAssets({ mediaDir })
        : undefined
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

    const voiceSourceScript = readJsonArtifact(
      productionDir,
      "script.json"
    );

    if (
      !voiceSourceScript ||
      !voiceSourceScript.data
    ) {
      throw new Error(
        "Orchestrateur : script.json ne contient pas data."
      );
    }

    console.log("");
    console.log(
      `[${voiceState.order}/${production.agents.length}] voice`
    );

    voiceState.status = "running";
    voiceState.started_at = new Date().toISOString();
    saveProduction();

    const voiceResult = await runVoiceAgent({
      script: voiceSourceScript.data,
      testMode: true,
      localAudio: mediaDir
        ? await inspectLocalVoice({ mediaDir })
        : undefined
    });

    writeJsonArtifact(
      productionDir,
      "voice.json",
      voiceResult
    );

    voiceState.status = "completed";
    voiceState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Voice PASS");
    console.log("    ✓ voice.json écrit");

    const persistedAssets = readJsonArtifact(
      productionDir,
      "assets.json"
    );

    const persistedVoice = readJsonArtifact(
      productionDir,
      "voice.json"
    );

    if (
      !persistedAssets ||
      !persistedAssets.data
    ) {
      throw new Error(
        "Orchestrateur : assets.json ne contient pas data."
      );
    }

    if (
      !persistedVoice ||
      !persistedVoice.data
    ) {
      throw new Error(
        "Orchestrateur : voice.json ne contient pas data."
      );
    }

    console.log("");
    console.log(
      `[${assemblyState.order}/${production.agents.length}] assembly`
    );

    assemblyState.status = "running";
    assemblyState.started_at = new Date().toISOString();
    saveProduction();

    // Les médias référencés sont recontrôlés sur disque juste avant
    // l'étape qui les utilise.
    const assemblyResult = await runAssemblyAgent({
      assets: persistedAssets.data,
      voice: persistedVoice.data,
      target: production.target.video,
      testMode: true,
      mediaVerification: mediaDir
        ? await verifyLocalMedia({
            mediaDir,
            assets: persistedAssets.data,
            voice: persistedVoice.data
          })
        : undefined
    });

    writeJsonArtifact(
      productionDir,
      "assembly.json",
      assemblyResult
    );

    assemblyState.status = "completed";
    assemblyState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Assembly PASS");
    console.log("    ✓ assembly.json écrit");

    // Étape technique de rendu : le plan, les manifestes et les médias
    // sont relus et recontrôlés sur disque juste avant de lancer ffmpeg.
    if (renderRequested) {
      const renderAssembly = readJsonArtifact(
        productionDir,
        "assembly.json"
      );

      const renderAssets = readJsonArtifact(
        productionDir,
        "assets.json"
      );

      const renderVoice = readJsonArtifact(
        productionDir,
        "voice.json"
      );

      console.log("");
      console.log(`[rendu] ffmpeg — profil ${renderProfile}`);

      production.render.status = "running";
      production.render.started_at = new Date().toISOString();
      saveProduction();

      fs.mkdirSync(renderOutputDir, { recursive: true });

      const renderResult = await renderVideo({
        assembly: renderAssembly?.data,
        assets: renderAssets?.data,
        voice: renderVoice?.data,
        mediaDir,
        mediaVerification: await verifyLocalMedia({
          mediaDir,
          assets: renderAssets?.data,
          voice: renderVoice?.data
        }),
        profile: renderProfile,
        outputDir: renderOutputDir,
        outputName: production.render.output_file,
        workDir: path.join(ROOT, "tmp", `render-${productionId}`),
        testMode: true
      });

      writeJsonArtifact(
        productionDir,
        "render.json",
        renderResult
      );

      production.render.status = "completed";
      production.render.completed_at = new Date().toISOString();
      saveProduction();

      console.log("    ✓ Rendu PASS");
      console.log("    ✓ render.json écrit");
    }

    // Quality audite les six enveloppes complètes, relues depuis le disque.
    const qualityArtifacts = {
      research: readJsonArtifact(productionDir, "research.json"),
      script: readJsonArtifact(productionDir, "script.json"),
      visual: readJsonArtifact(productionDir, "visual.json"),
      assets: readJsonArtifact(productionDir, "assets.json"),
      voice: readJsonArtifact(productionDir, "voice.json"),
      assembly: readJsonArtifact(productionDir, "assembly.json")
    };

    // Avec un rendu : render.json s'ajoute, et la vidéo est recontrôlée
    // sur disque juste avant l'audit.
    if (renderRequested) {
      qualityArtifacts.render = readJsonArtifact(
        productionDir,
        "render.json"
      );
    }

    console.log("");
    console.log(
      `[${qualityState.order}/${production.agents.length}] quality`
    );

    qualityState.status = "running";
    qualityState.started_at = new Date().toISOString();
    saveProduction();

    const qualityResult = await runQualityAgent({
      artifacts: qualityArtifacts,
      target: production.target,
      testMode: true,
      mediaVerification: mediaDir
        ? await verifyLocalMedia({
            mediaDir,
            assets: qualityArtifacts.assets?.data,
            voice: qualityArtifacts.voice?.data
          })
        : undefined,
      renderVerification: renderRequested
        ? await verifyRenderedVideo({
            outputDir: renderOutputDir,
            render: qualityArtifacts.render,
            assembly: qualityArtifacts.assembly?.data
          })
        : undefined
    });

    writeJsonArtifact(
      productionDir,
      "quality.json",
      qualityResult
    );

    qualityState.status = "completed";
    qualityState.completed_at = new Date().toISOString();
    saveProduction();

    console.log("    ✓ Quality PASS");
    console.log("    ✓ quality.json écrit");

    production.status =
      "research_script_visual_asset_voice_assembly_quality_pass";
    production.completed_at = new Date().toISOString();
    saveProduction();

    console.log("");
    console.log("==============================================");
    console.log(
      " RESULTAT : PASS — RESEARCH -> SCRIPT -> VISUAL DIRECTOR -> ASSET -> VOICE -> ASSEMBLY -> QUALITY"
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
    console.log(
      `             projects/${production.id}/voice.json`
    );
    console.log(
      `             projects/${production.id}/assembly.json`
    );
    console.log(
      `             projects/${production.id}/quality.json`
    );
    console.log(" Agents 1-7 : EXECUTES");
    console.log(
      mediaDir
        ? " Médias     : locaux, inspectés et recontrôlés sur disque"
        : " Médias     : aucun — contrats seuls"
    );
    if (renderRequested) {
      console.log(
        `             projects/${production.id}/render.json`
      );
      console.log(
        ` Vidéo finale : RENDUE — ${path.join(renderOutputDir, production.render.output_file)}`
      );
      console.log(
        `                profil ${renderProfile}, contrôlée par ffprobe`
      );
    } else {
      console.log(" Vidéo finale : NON RENDUE (aucun final.mp4)");
    }

    console.log("==============================================");

    process.exit(0);
  } catch (error) {
    const runningAgent = production.agents.find(
      (agent) => agent.status === "running"
    );

    if (production.render?.status === "running") {
      production.render.status = "failed";
      production.render.completed_at = new Date().toISOString();
      production.render.error =
        error instanceof Error
          ? error.message
          : String(error);
    }

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
