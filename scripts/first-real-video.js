// FIRST REAL VIDEO — gate local de bout en bout, zéro API, zéro réseau.
//
// Usage :
//   NO_API=1 node scripts/first-real-video.js
//
// Produit output/FIRST_REAL_VIDEO.mp4 par le VRAI pipeline du projet :
//
//   1. fabrique un jeu de médias locaux dans tmp/r9-media-<aléatoire>/ ;
//   2. lance l'orchestrateur réel, sous fixtures Anthropic locales et
//      garde réseau, avec --render au profil target (3840x2160) ;
//   3. revérifie indépendamment le MP4 avec ffprobe, ainsi que
//      render.json, quality.json et production.json ;
//   4. supprime ses médias temporaires et affiche un bilan.
//
// Ce que ce gate prouve : le pipeline sait fabriquer, sonder et valider
// un vrai fichier vidéo. Ce qu'il ne prouve pas : les textes viennent de
// fixtures, les images sont des aplats de couleur synthétiques, et
// l'audio est un son sinusoïdal de test — ce n'est PAS une narration.
//
// Options (utilisées par le smoke, dans des dossiers isolés) :
//   --profile=target|preview   profil de rendu (défaut : target)
//   --output-dir=<dossier>     dossier de sortie (défaut : output/)
//   --media-dir=<dossier>      médias déjà fabriqués ; jamais supprimés
//
// Une sortie déjà présente n'est jamais écrasée, renommée ni supprimée.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readJsonArtifact } from "../src/orchestrator/artifacts.js";

import { inspectMediaFile } from "../src/media/probe.js";

import {
  checkRenderedOutput,
  verifyRenderedVideo
} from "../src/render/ffmpeg-renderer.js";

import {
  RENDER_PROFILE_NAMES,
  resolveRenderProfile
} from "../src/render/render-timeline.js";

import {
  RENDER_DURATION_TOLERANCE,
  validateRenderPlanMapping,
  validateRenderReport
} from "../src/utils/validate-render-report.js";

import {
  validateQualityReport
} from "../src/utils/validate-quality-report.js";

import {
  createMediaFixtureRoot,
  generateRenderableMediaSet,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");
const PROJECTS = path.join(ROOT, "projects");

export const FIRST_REAL_VIDEO_NAME = "FIRST_REAL_VIDEO.mp4";

export const FIRST_REAL_VIDEO_STATUS =
  "research_script_visual_asset_voice_assembly_quality_pass";

const AGENTS = [
  "research",
  "script",
  "visual_director",
  "asset",
  "voice",
  "assembly",
  "quality"
];

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function readArtifact(productionId, filename) {
  try {
    return readJsonArtifact(
      path.join(PROJECTS, productionId),
      filename
    );
  } catch {
    return null;
  }
}

function toolAvailable(tool) {
  try {
    execFileSync(tool, ["-version"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

// Verdict du gate sur une exécution : tout ce qui doit être vrai pour
// que FIRST_REAL_VIDEO.mp4 soit déclaré produit. Fonction pure.
export function evaluateFirstRealVideo({
  childStatus,
  blockedAttempts,
  production,
  assembly,
  render,
  quality,
  probed,
  verification,
  profileName,
  outputName = FIRST_REAL_VIDEO_NAME
}) {
  const errors = [];

  // --- Pipeline -----------------------------------------------------
  if (childStatus !== 0) {
    errors.push(`pipeline terminé avec le code ${childStatus}`);
  }

  if (blockedAttempts !== 0) {
    errors.push(
      blockedAttempts === null
        ? "bilan du garde réseau absent"
        : `${blockedAttempts} tentative(s) réseau bloquée(s)`
    );
  }

  if (!isPlainObject(production)) {
    errors.push("production.json absent ou illisible");
  } else {
    if (production.status !== FIRST_REAL_VIDEO_STATUS) {
      errors.push(`status de production : ${production.status}`);
    }

    for (const id of AGENTS) {
      const agent = production.agents?.find(
        candidate => candidate.id === id
      );

      if (agent?.status !== "completed") {
        errors.push(`agent ${id} : ${agent?.status ?? "absent"}`);
      }
    }

    if (production.render?.status !== "completed") {
      errors.push(
        `rendu : ${production.render?.status ?? "absent"}` +
        (
          production.render?.error
            ? ` — ${production.render.error}`
            : ""
        )
      );
    }

    if (production.render?.output_file !== outputName) {
      errors.push(
        `production.json : fichier de sortie ${production.render?.output_file}`
      );
    }

    if (production.render?.profile !== profileName) {
      errors.push(
        `production.json : profil ${production.render?.profile}`
      );
    }
  }

  // --- render.json --------------------------------------------------
  const renderData = render?.data;

  if (!isPlainObject(render) || !isPlainObject(renderData)) {
    errors.push("render.json absent ou illisible");
  } else {
    if (
      render.stage !== "render" ||
      render.validation?.valid !== true ||
      renderData.status !== "rendered"
    ) {
      errors.push("render.json : rendu non validé");
    }

    if (renderData.output?.path !== outputName) {
      errors.push(
        `render.json : sortie ${renderData.output?.path} au lieu de ${outputName}`
      );
    }

    if (renderData.profile !== profileName) {
      errors.push(`render.json : profil ${renderData.profile}`);
    }

    errors.push(
      ...validateRenderReport(renderData).errors.map(
        error => `render.json : ${error}`
      )
    );

    if (!isPlainObject(assembly?.data)) {
      errors.push("assembly.json absent ou illisible");
    } else {
      errors.push(
        ...validateRenderPlanMapping(
          renderData,
          assembly.data
        ).errors.map(error => `render.json : ${error}`)
      );
    }
  }

  // --- quality.json -------------------------------------------------
  if (!isPlainObject(quality) || !isPlainObject(quality.data)) {
    errors.push("quality.json absent ou illisible");
  } else {
    if (
      quality.agent !== "quality" ||
      quality.validation?.valid !== true ||
      quality.data.verdict !== "pass"
    ) {
      errors.push("quality.json : audit non validé");
    }

    if (
      quality.data.media?.scope !== "rendered_video" ||
      quality.data.media?.final_video !== "rendered"
    ) {
      errors.push(
        "quality.json : périmètre " +
        `${quality.data.media?.scope} / ${quality.data.media?.final_video}`
      );
    }

    errors.push(
      ...validateQualityReport(quality.data).errors.map(
        error => `quality.json : ${error}`
      )
    );
  }

  // --- Le fichier lui-même, sondé indépendamment du pipeline ---------
  if (!isPlainObject(probed)) {
    errors.push(`${outputName} absent ou non sondable par ffprobe`);
  } else if (isPlainObject(assembly?.data) && isPlainObject(renderData)) {
    let profile = null;

    try {
      profile = resolveRenderProfile(
        profileName,
        assembly.data.output
      );
    } catch (error) {
      errors.push(error.message);
    }

    if (profile) {
      errors.push(
        ...checkRenderedOutput(probed, {
          profile,
          expectedDuration:
            renderData.summary?.rendered_duration_seconds
        }).map(error => `${outputName} : ${error}`)
      );
    }

    const streams = Array.isArray(probed.streams)
      ? probed.streams
      : [];

    const videoStreams = streams.filter(
      stream => stream.type === "video"
    ).length;

    const audioStreams = streams.filter(
      stream => stream.type === "audio"
    ).length;

    if (videoStreams !== 1 || audioStreams !== 1) {
      errors.push(
        `${outputName} : ${videoStreams} flux vidéo et ${audioStreams} flux audio ` +
        "au lieu d'un de chaque"
      );
    }

    if (
      !Number.isInteger(probed.size_bytes) ||
      probed.size_bytes <= 0 ||
      probed.size_bytes !== renderData.output?.size_bytes
    ) {
      errors.push(
        `${outputName} : taille ${probed.size_bytes} octets différente de render.json`
      );
    }
  }

  if (!isPlainObject(verification) || verification.valid !== true) {
    errors.push(
      "recontrôle de la vidéo rendue en échec" +
      (
        verification?.errors?.length
          ? ` — ${verification.errors.join(" ; ")}`
          : ""
      )
    );
  }

  return errors;
}

// Relit les artefacts d'une production et sonde le MP4 du dossier de
// sortie, indépendamment du pipeline qui l'a produit.
export async function checkFirstRealVideo({
  outputDir,
  productionId,
  profileName,
  childStatus,
  blockedAttempts,
  outputName = FIRST_REAL_VIDEO_NAME
}) {
  const production = productionId
    ? readArtifact(productionId, "production.json")
    : null;

  const assembly = productionId
    ? readArtifact(productionId, "assembly.json")
    : null;

  const render = productionId
    ? readArtifact(productionId, "render.json")
    : null;

  const quality = productionId
    ? readArtifact(productionId, "quality.json")
    : null;

  const outputPath = path.join(path.resolve(outputDir), outputName);

  let probed = null;

  try {
    probed = await inspectMediaFile(outputPath);
  } catch {
    probed = null;
  }

  let verification = null;

  try {
    verification = await verifyRenderedVideo({
      outputDir,
      render,
      assembly: assembly?.data
    });
  } catch (error) {
    verification = {
      valid: false,
      errors: [error.message]
    };
  }

  return {
    outputPath,
    production,
    render,
    quality,
    probed,
    verification,
    errors: evaluateFirstRealVideo({
      childStatus,
      blockedAttempts,
      production,
      assembly,
      render,
      quality,
      probed,
      verification,
      profileName,
      outputName
    })
  };
}

function printReport(result, log) {
  const { probed, production, quality, outputPath } = result;

  log("");
  log("--- Fichier produit (valeurs mesurées par ffprobe) ---");

  if (probed) {
    const audio = probed.streams.find(
      stream => stream.type === "audio"
    );

    log(`Chemin          : ${outputPath}`);
    log(`Taille          : ${probed.size_bytes} octets`);
    log(`Durée           : ${probed.duration_seconds} s`);
    log(`Résolution      : ${probed.width}x${probed.height}`);
    log(`Cadence         : ${probed.fps} images/s`);
    log(`Codec vidéo     : ${probed.video_codec}`);
    log(`Codec audio     : ${probed.audio_codec}`);
    log(`Audio           : ${audio?.sample_rate} Hz, ${audio?.channels} canaux`);
    log(`Flux            : ${probed.streams.length}`);
    log(`Conteneur       : ${probed.container}`);
  } else {
    log(`Chemin          : ${outputPath} — absent ou non sondable`);
  }

  log("");
  log("--- Pipeline ---");

  if (production) {
    log(`Production      : ${production.id}`);
    log(`Status          : ${production.status}`);
    log(
      "Agents          : " +
      production.agents
        .map(agent => `${agent.id}=${agent.status}`)
        .join(" ")
    );
    log(`Rendu           : ${production.render?.status} (profil ${production.render?.profile})`);
    log(
      "Quality         : " +
      `${quality?.data?.verdict ?? "absent"} — ` +
      `${quality?.data?.media?.scope ?? "?"} / ` +
      `${quality?.data?.media?.final_video ?? "?"}`
    );
  } else {
    log("Production      : aucune");
  }

  log("");
  log("--- Nature du contenu ---");
  log("Textes          : fixtures Anthropic locales (aucun appel modèle)");
  log("Images          : aplats de couleur synthétiques fabriqués par ffmpeg");
  log("Audio           : son sinusoïdal de test — PAS une narration");
}

// Exécute le gate. Retourne { ok, errors, ... } sans jamais lever
// d'erreur pour un échec du pipeline.
export async function runFirstRealVideo({
  profileName = "target",
  outputDir = path.join(ROOT, "output"),
  mediaDir = null,
  log = console.log
} = {}) {
  const outputPath = path.join(
    path.resolve(outputDir),
    FIRST_REAL_VIDEO_NAME
  );

  // 1. Préconditions : rien n'est lancé si l'une d'elles manque.
  const preconditions = [];

  if (process.env.NO_API !== "1") {
    preconditions.push("NO_API=1 est obligatoire pour ce gate.");
  }

  if (!RENDER_PROFILE_NAMES.includes(profileName)) {
    preconditions.push(
      `profil inconnu "${profileName}" — valeurs admises : ${RENDER_PROFILE_NAMES.join(", ")}.`
    );
  }

  for (const tool of ["ffmpeg", "ffprobe"]) {
    if (!toolAvailable(tool)) {
      preconditions.push(`${tool} indisponible dans le PATH.`);
    }
  }

  if (fs.existsSync(outputPath)) {
    preconditions.push(
      `la sortie existe déjà : ${outputPath}. ` +
      "Elle n'est ni écrasée, ni renommée, ni supprimée : " +
      "déplace-la ou supprime-la toi-même avant de relancer."
    );
  }

  if (mediaDir !== null && !fs.existsSync(mediaDir)) {
    preconditions.push(`dossier média introuvable : ${mediaDir}.`);
  }

  if (preconditions.length > 0) {
    return {
      ok: false,
      errors: preconditions,
      outputPath,
      productionId: null
    };
  }

  // 2. Médias locaux : fabriqués ici, supprimés ici. Un dossier fourni
  //    par l'appelant n'est jamais supprimé.
  let createdRoot = null;
  let result = null;

  try {
    let media = mediaDir;

    if (media === null) {
      createdRoot = createMediaFixtureRoot();
      media = generateRenderableMediaSet(
        path.join(createdRoot, "media")
      );

      log(`Médias de test  : ${media}`);
    }

    // 3. Le véritable orchestrateur, sous fixtures et garde réseau,
    //    sans aucune clé dans l'environnement.
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        GUARD,
        "src/orchestrator/mvp.js",
        "--research-script",
        `--media-dir=${media}`,
        "--render",
        `--render-profile=${profileName}`,
        `--output-dir=${path.resolve(outputDir)}`,
        `--output-name=${FIRST_REAL_VIDEO_NAME}`
      ],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          NO_API: "1",
          ANTHROPIC_FIXTURES: "1"
        },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      }
    );

    const productionId =
      child.stdout?.match(/^Production : (\S+)$/m)?.[1] ?? null;

    const guardLine = child.stderr?.match(
      /\[fixture-network-guard\] actif — tentatives bloquées : (\d+)/
    );

    // 4. Vérification indépendante, pendant que les médias existent.
    result = await checkFirstRealVideo({
      outputDir,
      productionId,
      profileName,
      childStatus: child.status,
      blockedAttempts: guardLine ? Number(guardLine[1]) : null
    });

    result.productionId = productionId;
    result.blockedAttempts = guardLine ? Number(guardLine[1]) : null;

    if (child.status !== 0) {
      const failure = (child.stderr ?? "")
        .split("\n")
        .map(line => line.trim())
        .filter(
          line =>
            line.length > 0 &&
            !line.startsWith("=") &&
            !line.startsWith("[fixture-network-guard]")
        )
        .slice(-2)
        .join(" — ");

      if (failure) {
        result.errors.unshift(`orchestrateur : ${failure}`);
      }
    }
  } finally {
    // 5. Nettoyage : uniquement le dossier créé par cette exécution, et
    //    sans masquer une erreur survenue plus haut.
    if (createdRoot !== null) {
      try {
        removeMediaFixtureRoot(createdRoot);
      } catch (error) {
        log(
          `Nettoyage des médias de test impossible (${createdRoot}) : ${error.message}`
        );
      }
    }
  }

  printReport(result, log);

  log(`Garde réseau    : ${result.blockedAttempts} tentative(s) bloquée(s)`);
  log(
    "Médias de test  : " +
    (
      createdRoot === null
        ? "fournis par l'appelant, conservés"
        : fs.existsSync(createdRoot)
          ? "NON supprimés"
          : "supprimés"
    )
  );

  return {
    ...result,
    ok: result.errors.length === 0
  };
}

function parseArguments(argv) {
  const value = name => {
    const prefix = `--${name}=`;
    const argument = argv.find(item => item.startsWith(prefix));

    return argument ? argument.slice(prefix.length) : undefined;
  };

  const known = ["--profile=", "--output-dir=", "--media-dir="];

  const unknown = argv.filter(
    item => !known.some(prefix => item.startsWith(prefix))
  );

  // Une option donnée deux fois est ambiguë : refusée.
  const duplicated = known.filter(
    prefix =>
      argv.filter(item => item.startsWith(prefix)).length > 1
  );

  return {
    unknown,
    duplicated,
    profileName: value("profile") ?? "target",
    outputDir: value("output-dir") ?? path.join(ROOT, "output"),
    mediaDir: value("media-dir") ?? null
  };
}

const launchedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (launchedDirectly) {
  const options = parseArguments(process.argv.slice(2));

  console.log("==============================================");
  console.log(" FIRST REAL VIDEO — GATE LOCAL (ZERO API)");
  console.log("==============================================");

  if (options.unknown.length > 0) {
    console.error(`Option inconnue : ${options.unknown.join(" ")}`);
    console.error("FIRST REAL VIDEO GATE : FAIL");
    process.exit(1);
  }

  if (options.duplicated.length > 0) {
    console.error(
      `Option en double : ${options.duplicated.join(" ")}`
    );
    console.error("FIRST REAL VIDEO GATE : FAIL");
    process.exit(1);
  }

  console.log(`Profil          : ${options.profileName}`);
  console.log(
    `Sortie          : ${path.join(path.resolve(options.outputDir), FIRST_REAL_VIDEO_NAME)}`
  );

  let result;

  try {
    result = await runFirstRealVideo(options);
  } catch (error) {
    // Erreur inattendue du gate lui-même : jamais un succès.
    console.error(`ERREUR : ${error?.message ?? error}`);
    console.error("FIRST REAL VIDEO GATE : FAIL");
    process.exit(1);
  }

  console.log("");
  console.log("==============================================");

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`ERREUR : ${error}`);
    }

    console.error("FIRST REAL VIDEO GATE : FAIL");
    console.error("==============================================");
    process.exit(1);
  }

  console.log("API réelle utilisée : NON");
  console.log(`Tolérance de durée  : ${RENDER_DURATION_TOLERANCE} s`);
  console.log("FIRST REAL VIDEO GATE : PASS");
  console.log("==============================================");
  process.exit(0);
}
