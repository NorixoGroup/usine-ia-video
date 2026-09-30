// Faux médias locaux pour les tests de la couche média.
//
// FIXTURES DE TEST uniquement : aucun fichier de production n'importe
// ce module, et ces fichiers ne sont pas des assets de production.
//
// Tout est fabriqué hors ligne par le ffmpeg local à partir de ses
// sources synthétiques (couleur unie, sinusoïde), dans un dossier
// tmp/r9-media-<aléatoire>/ ignoré par Git. Le test qui crée un dossier
// est le seul à le supprimer.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const TMP = path.join(ROOT, "tmp");
const PREFIX = "r9-media-";

// Petits fichiers : le contenu importe peu, seules les propriétés
// mesurées par ffprobe comptent.
const VIDEO_SIZE = "320x180";
const VIDEO_FPS = 30;
const AUDIO_SAMPLE_RATE = 44100;

function ffmpeg(args) {
  execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v", "error",
      "-y",
      "-fflags", "+bitexact",
      ...args
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function prepare(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  return file;
}

// Crée tmp/r9-media-<aléatoire>/ et retourne son chemin absolu.
export function createMediaFixtureRoot() {
  fs.mkdirSync(TMP, { recursive: true });

  return fs.mkdtempSync(path.join(TMP, PREFIX));
}

// Supprime un dossier de fixtures — uniquement s'il s'agit bien d'un
// dossier tmp/r9-media-* créé par createMediaFixtureRoot().
export function removeMediaFixtureRoot(root) {
  if (
    typeof root !== "string" ||
    path.dirname(root) !== TMP ||
    !path.basename(root).startsWith(PREFIX)
  ) {
    throw new Error(
      `local-media-fixtures — suppression refusée hors de tmp/${PREFIX}* (${root})`
    );
  }

  fs.rmSync(root, { recursive: true, force: true });
}

export function generateVideo(
  file,
  {
    seconds,
    color = "blue",
    size = VIDEO_SIZE,
    fps = VIDEO_FPS
  }
) {
  ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=${color}:s=${size}:r=${fps}`,
    "-t", String(seconds),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-flags:v", "+bitexact",
    "-map_metadata", "-1",
    prepare(file)
  ]);

  return file;
}

export function generateImage(
  file,
  {
    color = "red",
    size = VIDEO_SIZE
  } = {}
) {
  ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=${color}:s=${size}:r=1`,
    "-frames:v", "1",
    prepare(file)
  ]);

  return file;
}

export function generateAudio(
  file,
  {
    seconds,
    frequency = 440
  }
) {
  const codec = {
    ".wav": ["-c:a", "pcm_s16le"],
    ".mp3": ["-c:a", "libmp3lame", "-flags:a", "+bitexact"],
    ".m4a": ["-c:a", "aac", "-flags:a", "+bitexact"]
  }[path.extname(file).toLowerCase()];

  if (!codec) {
    throw new Error(
      `local-media-fixtures — extension audio non prévue (${file})`
    );
  }

  ffmpeg([
    "-f", "lavfi",
    "-i", `sine=frequency=${frequency}:sample_rate=${AUDIO_SAMPLE_RATE}`,
    "-t", String(seconds),
    ...codec,
    "-map_metadata", "-1",
    prepare(file)
  ]);

  return file;
}

// Vidéo portant aussi une piste audio (stock footage sonore).
export function generateVideoWithAudio(file, { seconds }) {
  ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=green:s=${VIDEO_SIZE}:r=${VIDEO_FPS}`,
    "-f", "lavfi",
    "-i", `sine=frequency=330:sample_rate=${AUDIO_SAMPLE_RATE}`,
    "-t", String(seconds),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    "-map_metadata", "-1",
    prepare(file)
  ]);

  return file;
}

// Jeu complet correspondant au plan canonique des fixtures du
// pipeline : 5 shots (8, 7, 5, 12, 8 s) et 2 unités de 20 s estimées.
//
//   assets/s01-g01-sh01.mp4   stock_video  vidéo 8 s
//   assets/s01-g01-sh02.png   map          image fixe
//   assets/s01-g01-sh03.mp4   generated    vidéo 6 s (plus longue que le besoin)
//   assets/s02-g01-sh01.mp4   map          vidéo 12 s
//   assets/s02-g01-sh02.mp4   stock_video  vidéo 8 s avec piste audio
//   voice/s01-g01.wav         20 s   (égale à l'estimation)
//   voice/s02-g01.mp3         21,5 s (différente de l'estimation)
export function generateCanonicalMediaSet(mediaDir) {
  const asset = name => path.join(mediaDir, "assets", name);
  const voice = name => path.join(mediaDir, "voice", name);

  generateVideo(asset("s01-g01-sh01.mp4"), { seconds: 8 });
  generateImage(asset("s01-g01-sh02.png"));
  generateVideo(asset("s01-g01-sh03.mp4"), {
    seconds: 6,
    color: "gray"
  });
  generateVideo(asset("s02-g01-sh01.mp4"), {
    seconds: 12,
    color: "orange"
  });
  generateVideoWithAudio(asset("s02-g01-sh02.mp4"), {
    seconds: 8
  });

  generateAudio(voice("s01-g01.wav"), { seconds: 20 });
  generateAudio(voice("s02-g01.mp3"), { seconds: 21.5 });

  return mediaDir;
}

// Copie un jeu de fixtures vers un nouveau dossier du même espace de
// test, pour qu'un cas puisse altérer ses fichiers sans toucher aux
// autres.
export function copyMediaSet(source, destination) {
  fs.cpSync(source, destination, { recursive: true });

  return destination;
}
