import path from "node:path";
import { execFile } from "node:child_process";

// Media Inspector — point d'entrée unique vers ffprobe.
//
// - ffprobe est lancé sans shell, avec un tableau d'arguments ;
// - seul le protocole "file" est autorisé : ffprobe sait ouvrir des
//   URL (http, ftp, tcp…) et le garde réseau Node ne voit pas un
//   processus enfant ;
// - le chemin doit être absolu et il est préfixé par "file:" ;
// - le binaire est résolu par le PATH.

const DEFAULT_FFPROBE = "ffprobe";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

const IMAGE_CONTAINERS = ["png_pipe", "jpeg_pipe", "image2"];

function fail(message) {
  throw new Error(`Media Inspector : ${message}`);
}

function toPositiveNumber(value) {
  const number =
    typeof value === "string" ? Number(value) : value;

  return (
    typeof number === "number" &&
    Number.isFinite(number) &&
    number > 0
  )
    ? number
    : null;
}

function parseRate(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^(\d+)\/(\d+)$/);

  if (!match || Number(match[2]) === 0) {
    return null;
  }

  return toPositiveNumber(
    Math.round((Number(match[1]) / Number(match[2])) * 1000) / 1000
  );
}

function roundSeconds(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

// Transforme la sortie JSON brute de ffprobe en relevé normalisé.
// Toute métadonnée essentielle absente est une erreur.
export function normalizeProbeResult(raw, absolutePath) {
  if (
    !raw ||
    typeof raw !== "object" ||
    !raw.format ||
    typeof raw.format !== "object" ||
    !Array.isArray(raw.streams) ||
    raw.streams.length === 0
  ) {
    fail(`aucun flux lisible dans ${absolutePath}`);
  }

  const container = raw.format.format_name;

  if (typeof container !== "string" || container.length === 0) {
    fail(`format de conteneur absent pour ${absolutePath}`);
  }

  const sizeBytes = toPositiveNumber(raw.format.size);

  if (sizeBytes === null || !Number.isInteger(sizeBytes)) {
    fail(`taille de fichier absente ou invalide pour ${absolutePath}`);
  }

  const streams = raw.streams.map(stream => ({
    index: stream.index,
    type: stream.codec_type,
    codec: stream.codec_name ?? null,
    width: stream.width ?? null,
    height: stream.height ?? null,
    fps: parseRate(stream.avg_frame_rate) ??
      parseRate(stream.r_frame_rate),
    sample_rate: toPositiveNumber(stream.sample_rate),
    channels: toPositiveNumber(stream.channels),
    // Durée propre du flux, lorsque le conteneur la fournit.
    duration_seconds:
      toPositiveNumber(stream.duration) === null
        ? null
        : roundSeconds(toPositiveNumber(stream.duration)),
    // Une pochette incrustée dans un fichier audio n'est pas une vidéo.
    attached_picture: stream.disposition?.attached_pic === 1
  }));

  const videoStream = streams.find(
    stream => stream.type === "video" && !stream.attached_picture
  );

  const audioStream = streams.find(
    stream => stream.type === "audio"
  );

  const duration = toPositiveNumber(raw.format.duration);

  const base = {
    path: absolutePath,
    container,
    size_bytes: sizeBytes,
    streams
  };

  if (videoStream) {
    if (
      !Number.isInteger(videoStream.width) ||
      videoStream.width <= 0 ||
      !Number.isInteger(videoStream.height) ||
      videoStream.height <= 0 ||
      typeof videoStream.codec !== "string"
    ) {
      fail(
        `métadonnées essentielles absentes (dimensions ou codec) pour ${absolutePath}`
      );
    }

    const isImage = IMAGE_CONTAINERS.some(
      name => container.split(",").includes(name)
    );

    if (isImage) {
      return {
        ...base,
        kind: "image",
        duration_seconds: null,
        width: videoStream.width,
        height: videoStream.height,
        fps: null,
        video_codec: videoStream.codec,
        audio_codec: null,
        sample_rate: null,
        channels: null
      };
    }

    if (duration === null) {
      fail(`durée absente ou nulle pour ${absolutePath}`);
    }

    if (videoStream.fps === null) {
      fail(
        `métadonnées essentielles absentes (cadence) pour ${absolutePath}`
      );
    }

    return {
      ...base,
      kind: "video",
      duration_seconds: roundSeconds(duration),
      width: videoStream.width,
      height: videoStream.height,
      fps: videoStream.fps,
      video_codec: videoStream.codec,
      audio_codec: audioStream?.codec ?? null,
      sample_rate: audioStream?.sample_rate ?? null,
      channels: audioStream?.channels ?? null
    };
  }

  if (audioStream) {
    if (duration === null) {
      fail(`durée absente ou nulle pour ${absolutePath}`);
    }

    if (
      typeof audioStream.codec !== "string" ||
      audioStream.sample_rate === null ||
      audioStream.channels === null
    ) {
      fail(
        `métadonnées essentielles absentes (codec, fréquence ou canaux) pour ${absolutePath}`
      );
    }

    return {
      ...base,
      kind: "audio",
      duration_seconds: roundSeconds(duration),
      width: null,
      height: null,
      fps: null,
      video_codec: null,
      audio_codec: audioStream.codec,
      sample_rate: audioStream.sample_rate,
      channels: audioStream.channels
    };
  }

  return fail(`aucun flux vidéo ou audio dans ${absolutePath}`);
}

// Arguments communs à tout appel ffprobe. "-protocol_whitelist file"
// interdit à ffprobe tout protocole autre que la lecture d'un fichier
// local, y compris pour les ressources qu'un fichier référencerait.
export const FFPROBE_ARGUMENTS = Object.freeze([
  "-v", "error",
  "-protocol_whitelist", "file",
  "-of", "json",
  "-show_format",
  "-show_streams"
]);

function runFfprobe(ffprobePath, absolutePath, timeoutMs) {
  const args = [
    ...FFPROBE_ARGUMENTS,
    "-i", `file:${absolutePath}`
  ];

  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stderr: String(stderr ?? "")
            })
          );
          return;
        }

        resolve(String(stdout));
      }
    );
  });
}

export async function inspectMediaFile(
  absolutePath,
  {
    ffprobePath = DEFAULT_FFPROBE,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}
) {
  if (
    typeof absolutePath !== "string" ||
    !path.isAbsolute(absolutePath) ||
    absolutePath !== path.normalize(absolutePath)
  ) {
    fail("chemin local absolu et normalisé obligatoire.");
  }

  let stdout;

  try {
    stdout = await runFfprobe(ffprobePath, absolutePath, timeoutMs);
  } catch (error) {
    if (error.code === "ENOENT") {
      fail(`ffprobe indisponible (${ffprobePath}).`);
    }

    if (error.killed) {
      fail(`ffprobe interrompu après ${timeoutMs} ms sur ${absolutePath}`);
    }

    const reason =
      error.stderr
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .at(-1) ?? error.message;

    fail(`fichier illisible par ffprobe — ${reason}`);
  }

  let raw;

  try {
    raw = JSON.parse(stdout);
  } catch {
    fail(`sortie ffprobe illisible pour ${absolutePath}`);
  }

  return normalizeProbeResult(raw, absolutePath);
}
