// Timeline réelle du rendu — calcul pur, sans entrée/sortie.
//
// assembly.json est un PLAN : ses durées sont des estimations. Au
// rendu, c'est la durée MESURÉE de chaque audio qui fait foi :
//
// - la fenêtre d'une unité prend la durée mesurée de son audio,
//   arrondie à l'image supérieure : la narration n'est ni coupée, ni
//   accélérée, ni ralentie ;
// - les clips de l'unité se partagent cette fenêtre en proportion de
//   leurs durées prévues, en nombres entiers d'images ;
// - une vidéo source plus courte que la durée dont le rendu a besoin
//   est un échec : ni boucle, ni image figée. Une image fixe couvre
//   n'importe quelle durée.

export const RENDER_PROFILE_NAMES = ["target", "preview"];

const PREVIEW_PROFILE = {
  width: 640,
  height: 360,
  fps: 30
};

function fail(message) {
  throw new Error(`Render Timeline : ${message}`);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isFinitePositiveNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

// Secondes arrondies à la milliseconde.
export function roundSeconds(seconds) {
  return Math.round(seconds * 1000) / 1000;
}

// Profil de sortie : "target" reprend la spécification du plan,
// "preview" est un format réduit pour les essais rapides.
export function resolveRenderProfile(name, planOutput) {
  if (!RENDER_PROFILE_NAMES.includes(name)) {
    fail(
      `profil de rendu inconnu "${name}". ` +
      `Valeurs admises : ${RENDER_PROFILE_NAMES.join(", ")}.`
    );
  }

  const profile =
    name === "preview"
      ? PREVIEW_PROFILE
      : {
          width: planOutput?.width,
          height: planOutput?.height,
          fps: planOutput?.fps
        };

  if (
    !Number.isInteger(profile.width) ||
    profile.width <= 0 ||
    profile.width % 2 !== 0 ||
    !Number.isInteger(profile.height) ||
    profile.height <= 0 ||
    profile.height % 2 !== 0 ||
    !isFinitePositiveNumber(profile.fps)
  ) {
    fail(
      "dimensions ou cadence de sortie invalides " +
      `(${profile.width}x${profile.height} à ${profile.fps} images/s).`
    );
  }

  return {
    name,
    width: profile.width,
    height: profile.height,
    fps: profile.fps
  };
}

// Répartit `total` images entre des clips, en proportion de leurs
// durées prévues (méthode du plus fort reste, déterministe).
function shareFrames(total, weights) {
  const sum = weights.reduce((accumulator, weight) => accumulator + weight, 0);

  const exact = weights.map(weight => (weight / sum) * total);
  const frames = exact.map(value => Math.floor(value));

  let remaining = total - frames.reduce((a, b) => a + b, 0);

  const order = exact
    .map((value, index) => ({
      index,
      remainder: value - Math.floor(value)
    }))
    .sort(
      (left, right) =>
        right.remainder - left.remainder ||
        left.index - right.index
    );

  for (const { index } of order) {
    if (remaining <= 0) {
      break;
    }

    frames[index] += 1;
    remaining -= 1;
  }

  return frames;
}

// Calcule la timeline réelle à partir du plan de montage (références
// média comprises) et de la cadence de sortie.
export function buildRenderTimeline({ assembly, fps }) {
  if (
    !isPlainObject(assembly) ||
    !Array.isArray(assembly.video_track) ||
    !Array.isArray(assembly.audio_track) ||
    assembly.video_track.length === 0 ||
    assembly.audio_track.length === 0
  ) {
    fail("plan de montage absent ou invalide.");
  }

  if (!isFinitePositiveNumber(fps)) {
    fail("cadence de sortie invalide.");
  }

  const videoTrack = [];
  const audioTrack = [];
  const videoFrames = [];
  const audioFrames = [];

  let cursor = 0;

  const seconds = frame => roundSeconds(frame / fps);

  for (const unit of assembly.audio_track) {
    const measured = unit?.audio?.duration_seconds;

    if (
      !isPlainObject(unit?.audio) ||
      typeof unit.audio.path !== "string" ||
      !isFinitePositiveNumber(measured)
    ) {
      fail(
        `unité ${unit?.unit_id} sans audio local mesuré : média non résolu.`
      );
    }

    const clips = assembly.video_track.filter(
      clip => clip?.unit_id === unit.unit_id
    );

    if (clips.length === 0) {
      fail(`unité ${unit.unit_id} sans aucun clip.`);
    }

    // Fenêtre de l'unité : durée mesurée, arrondie à l'image supérieure.
    const unitFrames = Math.ceil(measured * fps - 1e-6);

    const weights = clips.map(clip => clip.duration_seconds);

    if (weights.some(weight => !isFinitePositiveNumber(weight))) {
      fail(`unité ${unit.unit_id} : durée de clip prévue invalide.`);
    }

    const frames = shareFrames(unitFrames, weights);

    const unitStart = cursor;

    clips.forEach((clip, index) => {
      const media = clip.media;

      if (
        !isPlainObject(media) ||
        typeof media.path !== "string" ||
        !["video", "image"].includes(media.kind)
      ) {
        fail(
          `clip ${clip.asset_id} sans média local : média non résolu.`
        );
      }

      if (frames[index] < 1) {
        fail(
          `durée impossible pour le clip ${clip.asset_id} : ` +
          "moins d'une image après calage."
        );
      }

      const duration = frames[index] / fps;

      if (
        media.kind === "video" &&
        (
          !isFinitePositiveNumber(media.duration_seconds) ||
          media.duration_seconds < duration - 1e-6
        )
      ) {
        fail(
          `vidéo source trop courte pour le clip ${clip.asset_id} : ` +
          `${media.duration_seconds}s disponibles, ` +
          `${roundSeconds(duration)}s nécessaires après calage sur la voix.`
        );
      }

      videoTrack.push({
        asset_id: clip.asset_id,
        unit_id: clip.unit_id,
        start_seconds: seconds(cursor),
        end_seconds: seconds(cursor + frames[index]),
        duration_seconds: roundSeconds(duration),
        source: {
          path: media.path,
          kind: media.kind
        }
      });

      videoFrames.push(frames[index]);

      cursor += frames[index];
    });

    audioTrack.push({
      unit_id: unit.unit_id,
      start_seconds: seconds(unitStart),
      end_seconds: seconds(cursor),
      duration_seconds: roundSeconds(unitFrames / fps),
      source: {
        path: unit.audio.path
      }
    });

    audioFrames.push(unitFrames);
  }

  if (videoTrack.length !== assembly.video_track.length) {
    fail("des clips du plan ne sont rattachés à aucune unité.");
  }

  return {
    fps,
    video_track: videoTrack,
    audio_track: audioTrack,
    summary: {
      total_clips: videoTrack.length,
      total_units: audioTrack.length,
      planned_duration_seconds:
        assembly.summary?.total_duration_seconds,
      rendered_duration_seconds: seconds(cursor)
    },
    // Nombres d'images exacts, à l'usage du moteur de rendu.
    frames: {
      video: videoFrames,
      audio: audioFrames,
      total: cursor
    }
  };
}
