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
  buildTruthReport,
  renderTruthMarkdown,
  validateTruthReport
} from "../agents/truth.js";

import { evaluateSourceHierarchy } from "../utils/source-policy.js";

import {
  buildEvidenceJudgeItems,
  collectEvidence,
  evaluateFactEvidence,
  evidenceJudgeInputSha256,
  evidenceUrls,
  judgeBatches,
  loadEvidenceTexts,
  offlineChecks,
  researchSearchUrls,
  runEvidenceJudgeBatch,
  validateEvidenceArtifact,
  validateEvidenceJudgeResponse
} from "../utils/fact-evidence.js";

import {
  decomposeTitle,
  runTitleJudge,
  titleJudgeInputSha256,
  validateJudgeResponse,
  validatedFacts
} from "../utils/title-validation.js";

import {
  runVisualDirector
} from "../agents/visual-director.js";

import {
  runAssetAgent
} from "../agents/asset.js";

import {
  buildNarrationPlan,
  runVoiceAgent
} from "../agents/voice.js";

import {
  ensureNarrationAudio
} from "../services/narration-provider.js";

import {
  createElevenLabsNarrationProvider,
  elevenLabsRequestIdentity
} from "../services/elevenlabs-narration-provider.js";

import {
  createFixtureNarrationCallGuard,
  createFixtureNarrationProvider
} from "../fixtures/narration-provider.js";

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
  outputNameError
} from "../utils/validate-render-report.js";

import {
  writeJsonArtifact,
  readJsonArtifact
} from "./artifacts.js";

import {
  assertRealCallAuthorization,
  configureCallGuard,
  createRealNarrationCallGuard,
  reconcileNarrationJournal,
  getCallGuardStatus,
  redactSecrets,
  setCacheBypass
} from "../services/call-guard.js";

import {
  DEFAULT_DURATION_PROFILE,
  resolveDurationProfile
} from "../utils/duration-profile.js";

import {
  validateScriptDossier
} from "../utils/validate-script.js";

import {
  REUSABLE_AGENTS,
  STOP_AFTER_VALUES,
  acquireProductionLock,
  applyResume,
  archiveRegeneratedArtifacts,
  describeMediaNeeds,
  rollbackRegenerationCache,
  loadResumableProduction,
  planReuse,
  planRegeneration,
  productionMode,
  sealAndWriteArtifact
} from "./resume.js";

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
const fixtureNarrationProvider = args.includes("--fixture-narration-provider");
const realNarration = args.includes("--real-narration");

if (
  args.some((value) => value.startsWith("--media-dir")) &&
  !mediaDir
) {
  throw new Error(
    "Orchestrateur : --media-dir exige un dossier (--media-dir=<dossier>)."
  );
}

if (realNarration && (!researchScriptMode || !mediaDir)) {
  throw new Error(
    "Orchestrateur : --real-narration exige --research-script et --media-dir."
  );
}

if (
  fixtureNarrationProvider &&
  (!researchScriptMode || !mediaDir)
) {
  throw new Error(
    "Orchestrateur : --fixture-narration-provider exige --research-script et --media-dir."
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

// Nom du MP4 rendu, optionnel : un simple nom de fichier .mp4, écrit
// dans le dossier de sortie. Absent : <production-id>.mp4, comme avant.
const renderOutputNameRequested = args.some(
  (value) => value.startsWith("--output-name")
);

const renderOutputName = getArgument("output-name");

if (renderOutputNameRequested && !renderRequested) {
  throw new Error(
    "Orchestrateur : --output-name exige --render."
  );
}

if (
  renderOutputNameRequested &&
  outputNameError(renderOutputName) !== null
) {
  throw new Error(
    "Orchestrateur : --output-name invalide — " +
    `${outputNameError(renderOutputName)} ` +
    `("${renderOutputName ?? ""}").`
  );
}

// Mode d'exécution (R13). Sans --mode : test, comme avant. Le mode
// complet n'est jamais implicite : il exige un plafond d'appels réels
// explicite et l'accusé d'environnement (voir call-guard).
const modeRequested = args.some((value) => value.startsWith("--mode"));
const mode = getArgument("mode") ?? "test";
const testMode = mode !== "full";

if (fixtureNarrationProvider && !testMode) {
  throw new Error(
    "Orchestrateur : --fixture-narration-provider est réservé au mode test local."
  );
}

if (realNarration && mode !== "full") {
  throw new Error("Orchestrateur : --real-narration exige --mode=full.");
}

if (modeRequested && !["test", "full"].includes(mode)) {
  throw new Error(
    `Orchestrateur : --mode inconnu "${mode}". Valeurs admises : test, full.`
  );
}

const realCallsCapRequested = args.some(
  (value) => value.startsWith("--real-calls-cap")
);
const realCallsCap = getArgument("real-calls-cap");

if (mode === "full") {
  if (!researchScriptMode) {
    throw new Error(
      "Orchestrateur : --mode=full exige --research-script."
    );
  }

  // NO_API, accusé d'environnement et plafond : refus AVANT toute
  // création de production.
  assertRealCallAuthorization({ cap: realCallsCap });
} else if (realCallsCapRequested) {
  throw new Error(
    "Orchestrateur : --real-calls-cap exige --mode=full."
  );
}

const resumeRequested = args.some(
  (value) => value.startsWith("--resume")
);
const resumeId = getArgument("resume");

if (resumeRequested && !resumeId) {
  throw new Error(
    "Orchestrateur : --resume exige un identifiant (--resume=<production-id>)."
  );
}

if (resumeRequested && !researchScriptMode) {
  throw new Error(
    "Orchestrateur : --resume exige --research-script."
  );
}

if (
  resumeRequested &&
  args.some(
    (value) =>
      value.startsWith("--title") || value.startsWith("--prompt")
  )
) {
  throw new Error(
    "Orchestrateur : --title et --prompt sont interdits avec --resume " +
    "(l'entrée de la production est immuable)."
  );
}

const acceptUnresolved = args
  .filter((value) => value.startsWith("--accept-unresolved-calls"))
  .map((value) =>
    value.startsWith("--accept-unresolved-calls=")
      ? value.slice("--accept-unresolved-calls=".length).trim()
      : ""
  );

if (acceptUnresolved.length > 0 && !(resumeRequested && mode === "full")) {
  throw new Error(
    "Orchestrateur : --accept-unresolved-calls exige --resume et --mode=full."
  );
}

const stopAfterRequested = args.some(
  (value) => value.startsWith("--stop-after")
);
const stopAfter = getArgument("stop-after");

if (stopAfterRequested) {
  if (!researchScriptMode) {
    throw new Error(
      "Orchestrateur : --stop-after exige --research-script."
    );
  }

  if (!STOP_AFTER_VALUES.includes(stopAfter)) {
    throw new Error(
      `Orchestrateur : --stop-after invalide "${stopAfter ?? ""}". ` +
      `Valeurs admises : ${STOP_AFTER_VALUES.join(", ")}.`
    );
  }

  if (renderRequested) {
    throw new Error(
      "Orchestrateur : --stop-after est incompatible avec --render."
    );
  }
}

// Régénération volontaire d'un agent (D′1) : reprise en mode complet
// uniquement, un seul agent, mêmes identifiants que --stop-after.
const regenerateArgs = args.filter((value) => value.startsWith("--regenerate"));
const regenerate = getArgument("regenerate");

if (regenerateArgs.length > 0) {
  if (regenerateArgs.length > 1) {
    throw new Error("Orchestrateur : --regenerate n'accepte qu'un seul agent par exécution.");
  }

  if (!(resumeRequested && mode === "full")) {
    throw new Error("Orchestrateur : --regenerate exige --resume et --mode=full.");
  }

  if (!REUSABLE_AGENTS.includes(regenerate)) {
    throw new Error(
      `Orchestrateur : --regenerate invalide "${regenerate ?? ""}". ` +
      `Valeurs admises : ${REUSABLE_AGENTS.join(", ")}.`
    );
  }

  if (stopAfter && STOP_AFTER_VALUES.indexOf(stopAfter) < STOP_AFTER_VALUES.indexOf(regenerate)) {
    throw new Error(
      `Orchestrateur : --stop-after=${stopAfter} arrêterait la production avant l'agent régénéré (${regenerate}).`
    );
  }
}

// Régénération transactionnelle : seul l'agent régénéré contourne le cache,
// et seulement pendant son exécution. Son résultat est un candidat : il n'est
// promu (archivage de la version active, puis écriture par l'appelant)
// qu'après avoir passé tous ses gates. En cas de rejet, la version active,
// ses scellés et son cache restent la référence.
async function runAgent(agentId, run) {
  if (regenerate !== agentId) {
    return run();
  }

  const journalFile = path.join(productionDir, "calls.json");
  const journalSeq = () => (fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, "utf8")).entries : []);
  const startSeq = journalSeq().length;
  const history = production.resume_history.at(-1);
  let candidate;

  setCacheBypass(true);

  try {
    candidate = await run();
  } catch (error) {
    setCacheBypass(false);

    const cache = rollbackRegenerationCache({
      productionDir,
      hashes: journalSeq().filter(entry => entry.seq > startSeq && entry.cache_bypass).map(entry => entry.request_sha256),
      timestamp: regeneration.timestamp
    });

    Object.assign(production, structuredClone(regenerationSnapshot));
    history.outcome = "rejected";
    history.archived_artifacts = 0;
    history.rejected_error = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500);
    history.rejected_cache = cache.rejected;
    regenerationRejected = true;

    throw error;
  } finally {
    setCacheBypass(false);
  }

  history.outcome = "promoted";
  history.archive = archiveRegeneratedArtifacts({ productionDir, production, regeneration });
  console.log(
    `    ✓ Régénération promue : ${regeneration.archived_artifacts} artefact(s) archivé(s) dans ${history.archive}`
  );

  return candidate;
}

// Profil de durée (R14A) et cadre narré (R14B). Sans option : profil
// standard (25-30 min) et script historique, comme avant.
const durationProfileRequested = args.some(
  (value) => value.startsWith("--duration-profile")
);
const durationProfileName = getArgument("duration-profile");
const narratedFrameRequested = args.includes("--narrated-frame");

if (durationProfileRequested && !durationProfileName) {
  throw new Error(
    "Orchestrateur : --duration-profile exige un nom (--duration-profile=<profil>)."
  );
}

if (
  (durationProfileRequested || narratedFrameRequested) &&
  !researchScriptMode
) {
  throw new Error(
    "Orchestrateur : --duration-profile et --narrated-frame exigent --research-script."
  );
}

const resumed = resumeRequested
  ? loadResumableProduction({ root: ROOT, productionId: resumeId })
  : null;

// Profil et cadre d'une production reprise : ceux de la production
// (immuables) ; une option contradictoire est refusée.
const storedProfileName = resumed
  ? resumed.production.duration_profile ?? DEFAULT_DURATION_PROFILE
  : null;
const storedNarratedFrame = resumed
  ? resumed.production.narrated_frame === true
  : null;

if (
  resumed &&
  durationProfileRequested &&
  durationProfileName !== storedProfileName
) {
  throw new Error(
    `Reprise refusée : --duration-profile=${durationProfileName} différent ` +
    `du profil de la production ("${storedProfileName}").`
  );
}

if (resumed && narratedFrameRequested && !storedNarratedFrame) {
  throw new Error(
    "Reprise refusée : --narrated-frame alors que la production n'a pas de cadre narré."
  );
}

const durationProfile = resolveDurationProfile(
  pipelineConfig.video,
  resumed
    ? storedProfileName
    : durationProfileName ?? DEFAULT_DURATION_PROFILE
);

// Le mode complet produit toujours un script à cadre narré : c'est la
// condition d'une vidéo publiable (hook et conclusion narrés, illustrés).
const narratedFrame = resumed
  ? storedNarratedFrame
  : narratedFrameRequested || mode === "full";

if (
  resumed &&
  (resumed.production.target?.duration_minutes?.min !==
    durationProfile.min ||
    resumed.production.target?.duration_minutes?.max !==
    durationProfile.max)
) {
  throw new Error(
    "Reprise refusée : la plage de durée du profil " +
    `"${durationProfile.name}" a changé depuis la création de la production.`
  );
}

if (resumed && productionMode(resumed.production) !== mode) {
  throw new Error(
    `Reprise refusée : --mode=${mode} différent du mode de la production ` +
    `("${productionMode(resumed.production)}").`
  );
}

const productionId = resumed
  ? resumed.production.id
  : `prod-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;

const productionDir = resumed
  ? resumed.productionDir
  : path.join(ROOT, "projects", productionId);

if (!resumed) {
  fs.mkdirSync(productionDir, { recursive: true });
}

const production = resumed ? resumed.production : {
  id: productionId,
  created_at: new Date().toISOString(),
  status: "created",
  mode,
  // Hiérarchie des sources (R20.4, phase B) : bloquante pour les nouvelles
  // productions. Une production historique, sans ce champ, reste en rapport.
  source_hierarchy_enforcement: "block",
  // Validation du titre (R20.4, phase A) : juge appelé pour toute nouvelle
  // production ; un titre non démontré bloque en mode full. Le mode test
  // (fixtures, dossier minimal) signale seulement. Une production
  // historique, sans ce champ, n'appelle pas le juge et reste en rapport.
  title_validation_enforcement: mode === "full" ? "block" : "report",
  // Fact ↔ Evidence (R20.4, phase E) : preuves lues localement et juge pour
  // toute nouvelle production ; bloquant en mode full seulement. Une
  // production historique, sans ce champ, n'accède pas au réseau.
  fact_evidence_enforcement: mode === "full" ? "block" : "report",
  duration_profile: durationProfile.name,
  narrated_frame: narratedFrame,

  input: {
    title,
    prompt
  },

  target: {
    platform: pipelineConfig.project.platform,
    language: pipelineConfig.project.language,
    content_type: pipelineConfig.project.content_type,
    duration_minutes: {
      target: durationProfile.target,
      min: durationProfile.min,
      max: durationProfile.max
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

if (mediaDir && !resumed) {
  production.input.media_dir = mediaDir;
}

// État de l'étape technique de rendu, entre Assembly et Quality. Ce
// n'est pas un agent : les 7 agents restent inchangés.
const renderBlock = renderRequested
  ? {
      status: "pending",
      profile: renderProfile,
      output_dir: renderOutputDir,
      output_file: renderOutputName ?? `${productionId}.mp4`,
      started_at: null,
      completed_at: null,
      error: null
    }
  : null;

if (renderBlock && !resumed) {
  production.render = renderBlock;
}

function saveProduction() {
  fs.writeFileSync(
    path.join(productionDir, "production.json"),
    JSON.stringify(production, null, 2) + "\n"
  );
}

if (!resumed) {
  saveProduction();
}

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
if (resumed) {
  console.log("Reprise    : production existante (agents 1-3 réutilisés si scellés valides)");
}
if (mode === "full") {
  console.log(
    "Appels réels :",
    `mode complet, plafond ${realCallsCap} pour cette exécution`
  );
}
if (stopAfter) {
  console.log("Pause      : après", stopAfter);
}
if (durationProfile.name !== DEFAULT_DURATION_PROFILE) {
  console.log("Profil durée :", durationProfile.name);
}
if (narratedFrame) {
  console.log("Cadre narré : hook et conclusion sont de vrais segments");
}
console.log("");

if (!dryRun && !researchScriptMode) {
  console.log("STOP — le mode LIVE complet n'est pas encore autorisé.");
  console.log(
    "Utilise --dry-run ou --research-script pendant la construction du MVP."
  );
  process.exit(2);
}

// Verrou, garde des appels réels et état de reprise (mode
// research-script uniquement).
let reuse = {};
let regeneration = null;
let regenerationSnapshot = null;
let regenerationRejected = false;

function pauseIfRequested(agentId) {
  if (stopAfter !== agentId) {
    return;
  }

  production.status = "paused";
  production.paused_after = agentId;
  production.paused_at = new Date().toISOString();
  saveProduction();

  console.log("");
  console.log("==============================================");
  console.log(` RESULTAT : PAUSE — après ${agentId}`);
  console.log(` État : projects/${production.id}/production.json`);

  if (agentId === "truth") {
    console.log(` Relecture : projects/${production.id}/truth-report.md`);
  }

  if (["asset", "voice", "assembly"].includes(agentId)) {
    const needs = describeMediaNeeds({
      assets: readJsonArtifact(productionDir, "assets.json").data,
      voice:
        agentId === "asset"
          ? undefined
          : readJsonArtifact(productionDir, "voice.json").data
    });

    for (const line of needs) {
      console.log(` ${line}`);
    }
  }

  console.log(
    ` Reprise : node src/orchestrator/mvp.js --research-script --resume=${production.id}`
  );
  console.log(
    "           (mêmes options de mode et d'appels réels, + --media-dir=<dossier> --render)"
  );
  console.log("==============================================");

  process.exit(0);
}

if (researchScriptMode) {
  acquireProductionLock(productionDir);

  if (resumed) {
    reuse = planReuse({ productionDir, production });

    if (regenerate) {
      regeneration = planRegeneration({ reuse, regenerate });
    }
  }

  // Une reprise real-narration peut avoir publié un MP3 validé juste avant
  // une chute. Réconcilier exclusivement cette fenêtre F avant le garde
  // générique préserve le blocage de tout autre started call.
  if (mode === "full" && realNarration && resumed && mediaDir) {
    const configuredVoice = pipelineConfig.providers.voice;
    if (configuredVoice?.kind === "elevenlabs" && configuredVoice.voice_id) {
      const scriptForReconciliation = readJsonArtifact(productionDir, "script.json").data;
      const localVoice = await inspectLocalVoice({ mediaDir });
      const candidates = buildNarrationPlan(scriptForReconciliation)
        .filter(unit => Object.hasOwn(localVoice, unit.unitId))
        .map(unit => ({
          request: elevenLabsRequestIdentity({
            unitId: unit.unitId,
            text: unit.text,
            providerConfig: {
              modelId: configuredVoice.model_id,
              voiceId: configuredVoice.voice_id,
              outputFormat: configuredVoice.output_format
            }
          }),
          artifact: {
            provider_kind: "elevenlabs",
            unit_id: unit.unitId,
            ...localVoice[unit.unitId]
          }
        }));
      reconcileNarrationJournal({ productionDir, candidates });
    }
  }

  if (mode === "full") {
    configureCallGuard({
      productionDir,
      cap: realCallsCap,
      acceptUnresolved
    });
  }

  if (resumed) {
    // État de référence restauré si la régénération est rejetée.
    if (regeneration) {
      regenerationSnapshot = structuredClone({
        agents: production.agents,
        status: production.status,
        input: production.input,
        ...(production.render ? { render: production.render } : {}),
        ...(production.completed_at ? { completed_at: production.completed_at } : {}),
        ...(production.paused_after ? { paused_after: production.paused_after, paused_at: production.paused_at } : {})
      });
    }

    applyResume({
      production,
      reuse,
      mediaDir,
      render: renderBlock,
      regeneration
    });

    if (regeneration) {
      console.log(
        `Régénération : ${regeneration.agents.join(", ")} — version active conservée jusqu'à validation du candidat`
      );
    }
  }

  // Registre des scellés SHA-256 : présent dès le départ, y compris
  // pour une production qui échoue avant son premier artefact.
  production.artifact_sha256 ??= {};
  production.status = "running";
  saveProduction();
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

    if (!reuse.research) {
      researchState.status = "running";
      researchState.started_at = new Date().toISOString();
      saveProduction();

      const researchResult = await runAgent("research", () => runResearchAgent({
        title: production.input.title,
        prompt: production.input.prompt,
        testMode,
        durationProfile
      }));

      sealAndWriteArtifact({
        productionDir,
        production,
        filename: "research.json",
        data: researchResult,
        save: saveProduction
      });

      researchState.status = "completed";
      researchState.completed_at = new Date().toISOString();
      saveProduction();

      console.log("    ✓ Research PASS");
      console.log("    ✓ research.json écrit");
    } else {
      console.log("    ↺ Research RÉUTILISÉ — scellé SHA-256 vérifié, aucun appel");
    }

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

    pauseIfRequested("research");

    // Truth Report : étape technique déterministe, recalculée à chaque
    // exécution depuis le dossier Research scellé. Le Script ne lit plus
    // research.json : il reçoit le dossier transmis par truth.json.
    console.log("");
    console.log("[truth] Truth Report");

    const previousTitleJudge = production.truth?.title_judge ?? null;
    const previousEvidenceJudge = production.truth?.evidence_judge ?? [];

    production.truth = {
      status: "running",
      started_at: new Date().toISOString(),
      completed_at: null,
      error: null
    };
    saveProduction();

    const hierarchyEnforcement = production.source_hierarchy_enforcement === "block" ? "block" : "report";
    const hierarchyBlocks = hierarchyEnforcement === "block" && evaluateSourceHierarchy(persistedResearch.data).status !== "compliant";
    let titleJudge = null;
    let titleSkipReason = null;

    // Fact ↔ Evidence : preuves lues une seule fois, enregistrées et
    // scellées (evidence.json + evidence/<sha256>.txt), puis relues sur le
    // disque à chaque reprise, sans réseau. Production historique : aucun
    // accès réseau, aucun juge, contrôles hors réseau seulement.
    const offline = offlineChecks(persistedResearch.data, { searchUrls: researchSearchUrls(productionDir) });
    let factEvidence;

    if (typeof production.fact_evidence_enforcement !== "string") {
      factEvidence = evaluateFactEvidence({ research: persistedResearch.data, skipReason: "production historique, aucun accès réseau", offline });
    } else {
      const evidenceFile = path.join(productionDir, "evidence.json");
      let evidence = null;

      if (fs.existsSync(evidenceFile)) {
        const content = fs.readFileSync(evidenceFile, "utf8");

        if (crypto.createHash("sha256").update(content).digest("hex") !== production.artifact_sha256?.["evidence.json"]) {
          throw new Error("Preuves : scellé de evidence.json absent ou différent — artefact refusé.");
        }

        evidence = JSON.parse(content);

        if (validateEvidenceArtifact(evidence, persistedResearch.data).length > 0) {
          // Dossier Research changé (régénération) : les preuves sont relues.
          evidence = null;
        } else {
          console.log("    ↺ preuves RÉUTILISÉES — evidence.json scellé, aucun accès réseau");
        }
      }

      if (!evidence && evidenceUrls(persistedResearch.data).length > 0) {
        evidence = await collectEvidence({ research: persistedResearch.data, productionDir });
        sealAndWriteArtifact({ productionDir, production, filename: "evidence.json", data: evidence, save: saveProduction });
        console.log(`    ✓ preuves lues localement (${evidence.sources.filter(record => record.technical_status === "fetched").length}/${evidence.sources.length} pages)`);
      }

      evidence ??= { schema: "evidence.v1", sources: [] };

      const texts = loadEvidenceTexts({ evidence, productionDir });
      const pending = evaluateFactEvidence({ research: persistedResearch.data, evidence, texts, skipReason: "en attente du juge", offline });
      const judgements = new Map();
      let evidenceSkipReason = null;

      if (hierarchyBlocks) {
        evidenceSkipReason = "hiérarchie des sources à résoudre d'abord";
      } else {
        const toJudge = buildEvidenceJudgeItems({ research: persistedResearch.data, evidence, texts })
          .filter(item => item.excerpts.length > 0 && pending.facts[item.index].awaiting_judge === true);
        const reused = [];

        for (const batch of judgeBatches(toJudge)) {
          const inputSha256 = evidenceJudgeInputSha256(batch);
          const previous = previousEvidenceJudge.find(entry => entry.input_sha256 === inputSha256);
          let response;

          if (previous && validateEvidenceJudgeResponse(previous.response, batch).length === 0) {
            response = previous.response;
            reused.push(previous);
            console.log("    ↺ juge des preuves RÉUTILISÉ — mêmes entrées, aucun appel");
          } else {
            const judged = await runEvidenceJudgeBatch(batch);

            response = judged.response;
            reused.push({ input_sha256: inputSha256, response, attempts: judged.attempts, usage: judged.usage });
            console.log(`    ✓ juge des preuves (${batch.length} fait${batch.length > 1 ? "s" : ""}, ${judged.attempts} appel${judged.attempts > 1 ? "s" : ""})`);
          }

          for (const item of response.facts) judgements.set(item.id, item);
        }

        production.truth.evidence_judge = reused;
      }

      factEvidence = evaluateFactEvidence({ research: persistedResearch.data, evidence, texts, judgements, skipReason: evidenceSkipReason, offline });
    }

    // Juge du titre : nouvelles productions seulement, et seulement si la
    // hiérarchie des sources ne met pas déjà la production en pause.
    if (typeof production.title_validation_enforcement !== "string") {
      titleSkipReason = "production historique, aucun appel";
    } else if (hierarchyBlocks) {
      titleSkipReason = "hiérarchie des sources à résoudre d'abord";
    } else {
      const judgeInput = {
        title: production.input.title,
        assertions: decomposeTitle(production.input.title),
        facts: validatedFacts(persistedResearch.data, evaluateSourceHierarchy(persistedResearch.data), undefined, factEvidence),
        research: persistedResearch.data
      };
      const inputSha256 = titleJudgeInputSha256(judgeInput);

      // Reprise : même entrée → réponse déjà validée réutilisée, sans appel
      // (revalidée par le code, fail-closed).
      if (
        previousTitleJudge?.input_sha256 === inputSha256 &&
        validateJudgeResponse(previousTitleJudge.response, judgeInput).length === 0
      ) {
        titleJudge = previousTitleJudge.response;
        production.truth.title_judge = previousTitleJudge;
        console.log("    ↺ juge du titre RÉUTILISÉ — mêmes entrées, aucun appel");
      } else {
        const judged = await runTitleJudge(judgeInput);

        titleJudge = judged.response;
        production.truth.title_judge = { input_sha256: inputSha256, response: judged.response, attempts: judged.attempts, usage: judged.usage };
        console.log(`    ✓ juge du titre (${judged.attempts} appel${judged.attempts > 1 ? "s" : ""})`);
      }
    }

    const truthData = buildTruthReport({
      research: persistedResearch.data,
      title: production.input.title,
      enforcement: hierarchyEnforcement,
      titleEnforcement: production.title_validation_enforcement === "block" ? "block" : "report",
      titleJudge,
      titleSkipReason,
      evidenceEnforcement: production.fact_evidence_enforcement === "block" ? "block" : "report",
      factEvidence
    });
    const truthValidation = validateTruthReport(truthData, persistedResearch.data);

    if (!truthValidation.valid) {
      throw new Error(
        "Truth Report : contrat invalide. " +
        truthValidation.errors.join(" | ")
      );
    }

    sealAndWriteArtifact({
      productionDir,
      production,
      filename: "truth.json",
      data: {
        agent: "truth",
        mode,
        data: truthData,
        validation: truthValidation
      },
      save: saveProduction
    });

    fs.writeFileSync(
      path.join(productionDir, "truth-report.md"),
      renderTruthMarkdown(truthData)
    );

    console.log("    ✓ truth.json écrit (scellé)");
    console.log("    ✓ truth-report.md écrit");

    // Hiérarchie des sources en mode block : un rejet arrête la production
    // (échec) ; un domaine inconnu la met en pause pour revue humaine. Après
    // ajout d'une règle, la reprise recalcule le Truth Report sans appel.
    if (truthData.stop.stopped && truthData.stop.kind === "rejected") {
      throw new Error(
        "Truth Report : hiérarchie des sources non respectée. " +
        truthData.stop.reasons.join(" | ") +
        ` Détail : projects/${production.id}/truth-report.md`
      );
    }

    if (truthData.stop.stopped && ["review_required", "title_review", "evidence_review", "evidence_unverifiable"].includes(truthData.stop.kind)) {
      const titleReview = truthData.stop.kind === "title_review";
      const evidenceReview = truthData.stop.kind.startsWith("evidence_");

      production.truth.status = truthData.stop.kind;
      production.truth.completed_at = new Date().toISOString();
      production.truth.review = truthData.stop.review;

      if (evidenceReview) {
        production.truth.evidence_review = {
          kind: truthData.stop.kind,
          reasons: truthData.stop.reasons,
          rejected_facts: truthData.facts.filter(fact => fact.truth_status === "rejected").map(fact => fact.index),
          actions: truthData.stop.actions
        };
      }

      if (titleReview) {
        production.truth.title_review = {
          verdict: truthData.title.verdict,
          reasons: truthData.title.reasons,
          alternative_titles: truthData.alternative_titles,
          actions: truthData.stop.actions
        };
      }

      production.status = "paused";
      production.paused_after = "truth";
      production.paused_at = new Date().toISOString();
      saveProduction();

      console.log("");
      console.log("==============================================");
      console.log(titleReview
        ? " RESULTAT : PAUSE — TITRE À REVOIR (non démontré par les faits validés)"
        : truthData.stop.kind === "evidence_review"
          ? " RESULTAT : PAUSE — PREUVE À REVOIR (fait HIGH non soutenu par sa preuve)"
          : truthData.stop.kind === "evidence_unverifiable"
            ? " RESULTAT : PAUSE — REVUE REQUISE (preuve illisible d'un fait HIGH)"
            : " RESULTAT : PAUSE — REVUE REQUISE (hiérarchie des sources)");
      for (const reason of truthData.stop.reasons) console.log(` ${reason}`);

      if (evidenceReview) {
        for (const action of truthData.stop.actions) console.log(` Action possible : ${action}`);
      } else if (titleReview) {
        for (const item of truthData.alternative_titles) console.log(` Titre alternatif vérifié : ${item.title}`);
        for (const action of truthData.stop.actions) console.log(` Action possible : ${action}`);
      } else {
        console.log(` Action : ${truthData.stop.review[0].action}`);
      }

      console.log(` Relecture : projects/${production.id}/truth-report.md`);
      console.log(` Reprise : node src/orchestrator/mvp.js --research-script --resume=${production.id}`);
      console.log("==============================================");

      process.exit(0);
    }

    production.truth.status = "completed";
    production.truth.completed_at = new Date().toISOString();
    delete production.truth.review;
    delete production.truth.title_review;
    delete production.truth.evidence_review;
    saveProduction();

    const persistedTruth = readJsonArtifact(productionDir, "truth.json");

    if (!persistedTruth?.data?.research_dossier) {
      throw new Error(
        "Orchestrateur : truth.json ne contient pas research_dossier."
      );
    }

    pauseIfRequested("truth");

    console.log("");
    console.log(
      `[${scriptState.order}/${production.agents.length}] script`
    );

    if (!reuse.script) {
      scriptState.status = "running";
      scriptState.started_at = new Date().toISOString();
      saveProduction();

      const scriptResult = await runAgent("script", () => runScriptAgent({
        research: persistedTruth.data.research_dossier,
        title: production.input.title,
        testMode,
        durationProfile,
        narratedFrame
      }));

      sealAndWriteArtifact({
        productionDir,
        production,
        filename: "script.json",
        data: scriptResult,
        save: saveProduction
      });

      scriptState.status = "completed";
      scriptState.completed_at = new Date().toISOString();
      saveProduction();

      console.log("    ✓ Script PASS");
      console.log("    ✓ script.json écrit");
    } else {
      console.log("    ↺ Script RÉUTILISÉ — scellé SHA-256 vérifié, aucun appel");
    }

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

    // Cadre narré : le script persisté (y compris réutilisé à la
    // reprise) doit porter un hook et une conclusion en vrais segments.
    if (narratedFrame) {
      const frameValidation = validateScriptDossier(
        persistedScript.data,
        {
          durationRange: {
            min: durationProfile.min,
            max: durationProfile.max
          },
          requireNarratedFrame: true
        }
      );

      if (!frameValidation.valid) {
        throw new Error(
          "Orchestrateur : script.json sans cadre narré valide. " +
          frameValidation.errors.join(" | ")
        );
      }
    }

    pauseIfRequested("script");

    console.log("");
    console.log(
      `[${visualDirectorState.order}/${production.agents.length}] visual_director`
    );

    if (!reuse.visual_director) {
      visualDirectorState.status = "running";
      visualDirectorState.started_at = new Date().toISOString();
      saveProduction();

      const visualResult = await runAgent("visual_director", () => runVisualDirector({
        script: persistedScript.data,
        testMode,
        durationProfile
      }));

      sealAndWriteArtifact({
        productionDir,
        production,
        filename: "visual.json",
        data: visualResult,
        save: saveProduction
      });

      visualDirectorState.status = "completed";
      visualDirectorState.completed_at = new Date().toISOString();
      saveProduction();

      console.log("    ✓ Visual Director PASS");
      console.log("    ✓ visual.json écrit");
    } else {
      console.log("    ↺ Visual Director RÉUTILISÉ — scellé SHA-256 vérifié, aucun appel");
    }

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

    pauseIfRequested("visual_director");

    console.log("");
    console.log(
      `[${assetState.order}/${production.agents.length}] asset`
    );

    assetState.status = "running";
    assetState.started_at = new Date().toISOString();
    saveProduction();

    const assetResult = await runAssetAgent({
      visual: persistedVisual.data,
      testMode,
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

    pauseIfRequested("asset");

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

    const voiceProviderConfig = pipelineConfig.providers.voice;
    const realProviderConfig = voiceProviderConfig?.kind === "elevenlabs"
      ? {
        modelId: voiceProviderConfig.model_id,
        voiceId: voiceProviderConfig.voice_id,
        outputFormat: voiceProviderConfig.output_format,
        timeoutMs: voiceProviderConfig.timeout_ms
      }
      : null;

    if (realNarration && !realProviderConfig?.voiceId) {
      throw new Error(
        "Orchestrateur : --real-narration exige un voice_id ElevenLabs configuré."
      );
    }

    const localAudio = mediaDir
      ? fixtureNarrationProvider
        ? await ensureNarrationAudio({
          mediaDir,
          units: buildNarrationPlan(voiceSourceScript.data),
          provider: createFixtureNarrationProvider(),
          callGuard: createFixtureNarrationCallGuard()
        })
        : realNarration
          ? await ensureNarrationAudio({
            mediaDir,
            units: buildNarrationPlan(voiceSourceScript.data),
            provider: createElevenLabsNarrationProvider(),
            providerConfig: realProviderConfig,
            callGuard: createRealNarrationCallGuard()
          })
        : await inspectLocalVoice({ mediaDir })
      : undefined;

    const voiceResult = await runVoiceAgent({
      script: voiceSourceScript.data,
      testMode,
      durationProfile,
      localAudio
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

    pauseIfRequested("voice");

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
      testMode,
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

    pauseIfRequested("assembly");

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
        testMode
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
      scriptDurationRange: {
        min: durationProfile.min,
        max: durationProfile.max
      },
      testMode,
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
    if (mode === "full") {
      const guardStatus = getCallGuardStatus();
      console.log(
        ` Appels réels : ${guardStatus.used}/${guardStatus.cap} (cache : ${guardStatus.cache_hits})`
      );
    }
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

    // Aucun secret dans production.json ni sur stderr.
    const failureMessage = redactSecrets(
      error instanceof Error
        ? error.message
        : String(error)
    );

    // Régénération rejetée : la production est restaurée telle qu'elle était
    // avant la tentative (statuts, scellés, cache) ; rien n'est dégradé.
    if (regenerationRejected) {
      saveProduction();

      console.error("");
      console.error("==============================================");
      console.error(" RESULTAT : RÉGÉNÉRATION REJETÉE — version active conservée");
      console.error(failureMessage);
      console.error(` Candidat rejeté (cache) : ${production.resume_history.at(-1).rejected_cache ?? "aucun"}`);
      console.error("==============================================");

      process.exit(1);
    }

    if (production.truth?.status === "running") {
      production.truth.status = "failed";
      production.truth.completed_at = new Date().toISOString();
      production.truth.error = failureMessage;
    }

    if (production.render?.status === "running") {
      production.render.status = "failed";
      production.render.completed_at = new Date().toISOString();
      production.render.error = failureMessage;
    }

    if (runningAgent) {
      runningAgent.status = "failed";
      runningAgent.completed_at = new Date().toISOString();
      runningAgent.error = failureMessage;
    }

    production.status = "failed";
    production.completed_at = new Date().toISOString();
    saveProduction();

    console.error("");
    console.error("==============================================");
    console.error(" RESULTAT : FAIL — PIPELINE ARRETE");
    console.error(failureMessage);
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
