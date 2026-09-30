import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

import { inspectMediaFile } from "../media/probe.js";

import {
  resolveMediaReference,
  resolveMediaRoot
} from "../media/local-media.js";

import {
  validateAssetManifest
} from "../utils/validate-asset-manifest.js";

import {
  validateVoiceManifest
} from "../utils/validate-voice-manifest.js";

import {
  validateAssemblyPlan,
  validateAssemblySourceMapping
} from "../utils/validate-assembly-plan.js";

import {
  RENDER_DURATION_TOLERANCE,
  RENDER_STAGE,
  RENDER_STATUS,
  outputNameError,
  validateRenderPlanMapping,
  validateRenderReport
} from "../utils/validate-render-report.js";

import {
  buildRenderTimeline,
  resolveRenderProfile
} from "./render-timeline.js";

// Moteur de rendu local — étape technique entre Assembly et Quality.
//
// Transforme un plan de montage validé et ses médias locaux inspectés
// en un vrai fichier MP4, en trois temps :
//
//   1. chaque clip est normalisé en un segment intermédiaire (taille,
//      cadence, pixels carrés, H.264) ;
//   2. les segments sont enchaînés sans réencodage ;
//   3. la piste vidéo est multiplexée avec la narration en MP4.
//
// ffmpeg est lancé sans shell, avec un tableau d'arguments, et n'a le
// droit d'ouvrir que des fichiers locaux. Toute erreur est remontée :
// aucune boucle, aucune image figée, aucun repli silencieux.

const DEFAULT_FFMPEG = "ffmpeg";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const VIDEO_CODEC = "libx264";
const VIDEO_CRF = "18";
const PIXEL_FORMAT = "yuv420p";

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = "192k";

// Vitesse d'encodage par profil ; la qualité (CRF) est la même.
const PRESETS = {
  target: "medium",
  preview: "veryfast"
};

// Aucune entrée ne peut utiliser un autre protocole que le fichier
// local : le garde réseau Node ne voit pas un processus enfant.
const LOCAL_ONLY = ["-protocol_whitelist", "file"];

const REPRODUCIBLE = ["-fflags", "+bitexact", "-map_metadata", "-1"];

function fail(message) {
  throw new Error(`Renderer : ${message}`);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function segmentName(prefix, index, extension) {
  return `${prefix}-${String(index + 1).padStart(4, "0")}.${extension}`;
}

function sha256File(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");

    fs.createReadStream(absolutePath)
      .on("error", reject)
      .on("data", chunk => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function runFfmpeg(ffmpegPath, args, timeoutMs, step) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ["-nostdin", "-v", "error", "-y", ...args],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }

        if (error.code === "ENOENT") {
          reject(
            new Error(
              `Renderer : ffmpeg indisponible (${ffmpegPath}).`
            )
          );
          return;
        }

        if (error.killed) {
          reject(
            new Error(
              `Renderer : ffmpeg interrompu après ${timeoutMs} ms — étape ${step}.`
            )
          );
          return;
        }

        const detail = String(stderr ?? "")
          .split("\n")
          .map(line => line.trim())
          .filter(Boolean)
          .slice(-3)
          .join(" / ")
          .slice(0, 600);

        reject(
          new Error(
            `Renderer : ffmpeg a échoué — étape ${step}, code ${error.code}` +
            (detail ? ` — ${detail}` : "")
          )
        );
      }
    );
  });
}

// Liste ordonnée et déterministe des commandes ffmpeg du rendu. Les
// fichiers intermédiaires portent des noms choisis par le moteur.
export function planRenderCommands({
  timeline,
  profile,
  sources,
  workDir
}) {
  const filter = [
    `fps=${profile.fps}`,
    `scale=${profile.width}:${profile.height}` +
      ":force_original_aspect_ratio=decrease:force_divisible_by=2",
    `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "setsar=1",
    `format=${PIXEL_FORMAT}`
  ].join(",");

  const commands = [];

  timeline.video_track.forEach((clip, index) => {
    const input =
      clip.source.kind === "image"
        ? [
            ...LOCAL_ONLY,
            "-loop", "1",
            "-framerate", String(profile.fps),
            "-i", `file:${sources.video[index]}`
          ]
        : [
            ...LOCAL_ONLY,
            "-i", `file:${sources.video[index]}`
          ];

    commands.push({
      step: `segment vidéo ${clip.asset_id}`,
      kind: "video-segment",
      index,
      frames: timeline.frames.video[index],
      output: path.join(workDir, segmentName("seg", index, "mp4")),
      args: [
        ...input,
        "-an",
        "-vf", filter,
        "-frames:v", String(timeline.frames.video[index]),
        "-c:v", VIDEO_CODEC,
        "-preset", PRESETS[profile.name],
        "-crf", VIDEO_CRF,
        "-pix_fmt", PIXEL_FORMAT,
        "-flags:v", "+bitexact",
        ...REPRODUCIBLE,
        path.join(workDir, segmentName("seg", index, "mp4"))
      ]
    });
  });

  commands.push({
    step: "enchaînement vidéo",
    kind: "video-concat",
    list: {
      file: path.join(workDir, "video.txt"),
      entries: timeline.video_track.map(
        (clip, index) => segmentName("seg", index, "mp4")
      )
    },
    output: path.join(workDir, "video.mp4"),
    args: [
      ...LOCAL_ONLY,
      "-f", "concat",
      "-safe", "1",
      "-i", path.join(workDir, "video.txt"),
      "-c", "copy",
      ...REPRODUCIBLE,
      path.join(workDir, "video.mp4")
    ]
  });

  timeline.audio_track.forEach((unit, index) => {
    // Fenêtre de l'unité : l'audio mesuré, complété par du silence
    // jusqu'à la fin de l'image en cours. Jamais coupé ni étiré.
    const window = (
      timeline.frames.audio[index] / profile.fps
    ).toFixed(6);

    commands.push({
      step: `narration ${unit.unit_id}`,
      kind: "audio-unit",
      index,
      output: path.join(workDir, segmentName("aud", index, "wav")),
      args: [
        ...LOCAL_ONLY,
        "-i", `file:${sources.audio[index]}`,
        "-vn",
        "-af",
        `aresample=${AUDIO_SAMPLE_RATE},` +
          "aformat=sample_fmts=s16:channel_layouts=stereo," +
          `apad=whole_dur=${window}`,
        "-t", window,
        "-c:a", "pcm_s16le",
        ...REPRODUCIBLE,
        path.join(workDir, segmentName("aud", index, "wav"))
      ]
    });
  });

  commands.push({
    step: "multiplexage",
    kind: "mux",
    list: {
      file: path.join(workDir, "audio.txt"),
      entries: timeline.audio_track.map(
        (unit, index) => segmentName("aud", index, "wav")
      )
    },
    output: path.join(workDir, "final.mp4"),
    args: [
      ...LOCAL_ONLY,
      "-i", `file:${path.join(workDir, "video.mp4")}`,
      ...LOCAL_ONLY,
      "-f", "concat",
      "-safe", "1",
      "-i", path.join(workDir, "audio.txt"),
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", AUDIO_BITRATE,
      "-ar", String(AUDIO_SAMPLE_RATE),
      "-ac", String(AUDIO_CHANNELS),
      "-movflags", "+faststart",
      "-flags:a", "+bitexact",
      ...REPRODUCIBLE,
      path.join(workDir, "final.mp4")
    ]
  });

  return commands;
}

// Contrôle le relevé ffprobe du MP4 produit. Aucune confiance dans
// l'extension : conteneur, flux, codecs, dimensions, cadence et durées.
export function checkRenderedOutput(
  probed,
  { profile, expectedDuration }
) {
  const errors = [];

  if (!isPlainObject(probed)) {
    return ["sortie non sondable"];
  }

  if (probed.kind !== "video") {
    errors.push("aucun flux vidéo dans la sortie");
  }

  if (
    typeof probed.container !== "string" ||
    !probed.container.split(",").includes("mp4")
  ) {
    errors.push(`conteneur inattendu (${probed.container})`);
  }

  if (probed.video_codec !== "h264") {
    errors.push(`codec vidéo inattendu (${probed.video_codec})`);
  }

  if (
    probed.width !== profile.width ||
    probed.height !== profile.height
  ) {
    errors.push(
      `dimensions ${probed.width}x${probed.height} au lieu de ${profile.width}x${profile.height}`
    );
  }

  if (probed.fps !== profile.fps) {
    errors.push(
      `cadence ${probed.fps} au lieu de ${profile.fps} images/s`
    );
  }

  if (probed.audio_codec === null || probed.audio_codec === undefined) {
    errors.push("aucun flux audio dans la sortie");
  } else {
    if (probed.audio_codec !== "aac") {
      errors.push(`codec audio inattendu (${probed.audio_codec})`);
    }

    if (
      probed.sample_rate !== AUDIO_SAMPLE_RATE ||
      probed.channels !== AUDIO_CHANNELS
    ) {
      errors.push(
        `audio ${probed.sample_rate} Hz / ${probed.channels} canal(aux) ` +
        `au lieu de ${AUDIO_SAMPLE_RATE} Hz / ${AUDIO_CHANNELS}`
      );
    }
  }

  if (
    typeof probed.duration_seconds !== "number" ||
    probed.duration_seconds <= 0
  ) {
    errors.push("durée de la sortie nulle ou absente");
  } else if (
    Math.abs(probed.duration_seconds - expectedDuration) >
    RENDER_DURATION_TOLERANCE
  ) {
    errors.push(
      `durée ${probed.duration_seconds}s à plus de ${RENDER_DURATION_TOLERANCE}s ` +
      `de la durée attendue ${expectedDuration}s`
    );
  }

  const streams = Array.isArray(probed.streams) ? probed.streams : [];

  const videoStream = streams.find(
    stream => stream.type === "video" && !stream.attached_picture
  );

  const audioStream = streams.find(
    stream => stream.type === "audio"
  );

  for (const [label, stream] of [
    ["vidéo", videoStream],
    ["audio", audioStream]
  ]) {
    if (!stream) {
      continue;
    }

    if (typeof stream.duration_seconds !== "number") {
      errors.push(`durée du flux ${label} indisponible`);
    } else if (
      Math.abs(stream.duration_seconds - expectedDuration) >
      RENDER_DURATION_TOLERANCE
    ) {
      errors.push(
        `flux ${label} de ${stream.duration_seconds}s à plus de ` +
        `${RENDER_DURATION_TOLERANCE}s de la durée attendue ${expectedDuration}s`
      );
    }
  }

  return errors;
}

function toOutputRecord(outputName, probed, sha256) {
  return {
    path: outputName,
    container: probed.container,
    width: probed.width,
    height: probed.height,
    fps: probed.fps,
    video_codec: probed.video_codec,
    audio_codec: probed.audio_codec,
    duration_seconds: probed.duration_seconds,
    size_bytes: probed.size_bytes,
    sha256
  };
}

function resolveOutputDirectory(outputDir) {
  if (typeof outputDir !== "string" || outputDir.trim().length === 0) {
    fail("dossier de sortie absent ou invalide.");
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(outputDir)) {
    fail(
      `le dossier de sortie doit être un chemin local (${outputDir}).`
    );
  }

  const resolved = path.resolve(outputDir);

  if (
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isDirectory()
  ) {
    fail(`dossier de sortie introuvable (${outputDir}).`);
  }

  return fs.realpathSync(resolved);
}

function moveFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }

    // Dossier de travail et dossier de sortie sur deux volumes.
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.rmSync(source);
  }
}

function assertProduced(file, step) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fail(`sortie absente ou vide — étape ${step}.`);
  }
}

export async function renderVideo({
  assembly,
  assets,
  voice,
  mediaDir,
  mediaVerification,
  profile: profileName = "target",
  outputDir,
  outputName,
  workDir,
  testMode = false,
  ffmpegPath = DEFAULT_FFMPEG,
  ffprobePath,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  // 1. Entrées : manifestes, plan, médias recontrôlés sur disque.
  const assetsValidation = validateAssetManifest(assets);

  if (!assetsValidation.valid) {
    fail(
      "manifeste d'assets invalide. " +
      assetsValidation.errors.join(" | ")
    );
  }

  const voiceValidation = validateVoiceManifest(voice);

  if (!voiceValidation.valid) {
    fail(
      "manifeste voice invalide. " +
      voiceValidation.errors.join(" | ")
    );
  }

  const planValidation = validateAssemblyPlan(assembly);

  if (!planValidation.valid) {
    fail(
      "plan de montage invalide. " +
      planValidation.errors.join(" | ")
    );
  }

  const mapping = validateAssemblySourceMapping(
    assembly,
    assets,
    voice,
    assembly.output,
    mediaVerification
  );

  if (!mapping.valid) {
    fail(
      "plan de montage incohérent avec ses sources. " +
      mapping.errors.join(" | ")
    );
  }

  if (mediaVerification === undefined) {
    fail(
      "médias non résolus : le plan ne référence aucun média local recontrôlé."
    );
  }

  // 2. Profil, timeline réelle, chemins.
  const profile = resolveRenderProfile(profileName, assembly.output);

  const timeline = buildRenderTimeline({
    assembly,
    fps: profile.fps
  });

  const nameError = outputNameError(outputName);

  if (nameError) {
    fail(`nom de sortie invalide — ${nameError} (${outputName}).`);
  }

  const outputRoot = resolveOutputDirectory(outputDir);
  const outputPath = path.join(outputRoot, outputName);

  if (fs.existsSync(outputPath)) {
    fail(`la sortie existe déjà, écrasement refusé (${outputName}).`);
  }

  const mediaRoot = resolveMediaRoot(mediaDir);

  const resolveSource = reference => {
    try {
      return resolveMediaReference(mediaRoot, reference).absolutePath;
    } catch (error) {
      return fail(error.message);
    }
  };

  const sources = {
    video: timeline.video_track.map(
      clip => resolveSource(clip.source.path)
    ),
    audio: timeline.audio_track.map(
      unit => resolveSource(unit.source.path)
    )
  };

  if (
    typeof workDir !== "string" ||
    workDir.trim().length === 0 ||
    !path.isAbsolute(workDir)
  ) {
    fail("dossier de travail absolu obligatoire.");
  }

  if (fs.existsSync(workDir)) {
    fail(`le dossier de travail existe déjà (${workDir}).`);
  }

  const commands = planRenderCommands({
    timeline,
    profile,
    sources,
    workDir
  });

  // 3. Rendu. Le dossier de travail est créé ici et supprimé ici : le
  //    moteur ne supprime rien d'autre que ce qu'il a lui-même créé.
  fs.mkdirSync(workDir, { recursive: true });

  let outputWritten = false;

  try {
    for (const command of commands) {
      if (command.list) {
        fs.writeFileSync(
          command.list.file,
          command.list.entries
            .map(entry => `file '${entry}'\n`)
            .join("")
        );
      }

      await runFfmpeg(
        ffmpegPath,
        command.args,
        timeoutMs,
        command.step
      );

      assertProduced(command.output, command.step);

      // ffmpeg s'arrête sans erreur quand la source est épuisée : le
      // nombre d'images réellement écrites est donc contrôlé.
      if (command.kind === "video-segment") {
        const segment = await inspectMediaFile(command.output, {
          ffprobePath
        });

        const expected = command.frames / profile.fps;

        if (
          Math.abs(segment.duration_seconds - expected) >
          1 / profile.fps + 0.001
        ) {
          fail(
            `segment incomplet — étape ${command.step} : ` +
            `${segment.duration_seconds}s rendues pour ` +
            `${Math.round(expected * 1000) / 1000}s nécessaires ` +
            "(source trop courte ou illisible)."
          );
        }
      }
    }

    moveFile(path.join(workDir, "final.mp4"), outputPath);
    outputWritten = true;

    // 4. Contrôle du MP4 réellement produit.
    let probed;

    try {
      probed = await inspectMediaFile(outputPath, { ffprobePath });
    } catch (error) {
      fail(`sortie non sondable — ${error.message}`);
    }

    const outputErrors = checkRenderedOutput(probed, {
      profile,
      expectedDuration: timeline.summary.rendered_duration_seconds
    });

    if (outputErrors.length > 0) {
      fail(`sortie invalide — ${outputErrors.join(" | ")}`);
    }

    const data = {
      title: assembly.title,
      profile: profile.name,
      output: toOutputRecord(
        outputName,
        probed,
        await sha256File(outputPath)
      ),
      video_track: timeline.video_track,
      audio_track: timeline.audio_track,
      summary: timeline.summary,
      status: RENDER_STATUS
    };

    const validation = validateRenderReport(data);

    const planMapping = validateRenderPlanMapping(data, assembly);

    const errors = [...validation.errors, ...planMapping.errors];

    if (errors.length > 0) {
      fail(`rapport de rendu rejeté. ${errors.join(" | ")}`);
    }

    return {
      stage: RENDER_STAGE,
      mode: testMode ? "test" : "full",
      data,
      validation,
      usage: null
    };
  } catch (error) {
    // Une sortie invalide n'est pas laissée sur le disque.
    if (outputWritten) {
      fs.rmSync(outputPath, { force: true });
    }

    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Recontrôle sur disque la vidéo décrite par render.json : présence,
// taille, SHA-256 et relevé ffprobe identiques à ceux enregistrés, et
// cohérence du rapport avec le plan de montage. Ne lève pas d'erreur
// sur une vidéo fautive : le rapport porte le verdict, que Quality
// audite.
export async function verifyRenderedVideo({
  outputDir,
  render,
  assembly,
  ffprobePath
}) {
  const errors = [];
  let output = null;

  const data = render?.data;

  const structure = validateRenderReport(data);

  errors.push(...structure.errors);

  if (structure.valid) {
    errors.push(
      ...validateRenderPlanMapping(data, assembly).errors
    );
  }

  if (
    isPlainObject(data?.output) &&
    outputNameError(data.output.path) === null
  ) {
    try {
      const outputPath = path.join(
        resolveOutputDirectory(outputDir),
        data.output.path
      );

      if (
        !fs.existsSync(outputPath) ||
        !fs.statSync(outputPath).isFile()
      ) {
        fail(`vidéo rendue absente (${data.output.path}).`);
      }

      const probed = await inspectMediaFile(outputPath, {
        ffprobePath
      });

      const fresh = toOutputRecord(
        data.output.path,
        probed,
        await sha256File(outputPath)
      );

      const changed = Object.keys(fresh).filter(
        key => fresh[key] !== data.output[key]
      );

      if (changed.length > 0) {
        errors.push(
          `vidéo rendue modifiée depuis le rendu (${data.output.path} — ${changed.join(", ")})`
        );
      } else {
        errors.push(
          ...checkRenderedOutput(probed, {
            profile: {
              width: data.output.width,
              height: data.output.height,
              fps: data.output.fps
            },
            expectedDuration:
              data.summary?.rendered_duration_seconds
          })
        );

        output = fresh;
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    scope: "rendered_video",
    valid: errors.length === 0,
    errors,
    output: errors.length === 0 ? output : null
  };
}
