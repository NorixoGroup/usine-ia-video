// Smoke du moteur de rendu local — un VRAI MP4, zéro API, zéro réseau.
//
// Usage :
//   NO_API=1 node scripts/render-smoke.js
//
// Fabrique quelques faux médias avec le ffmpeg local, fait passer un
// plan court par les agents Asset, Voice et Assembly, puis demande au
// moteur de rendu un vrai fichier MP4, sondé avec ffprobe.
//
// Ce smoke rend volontairement PEU et PETIT pour rester rapide :
// 3 clips, 2 unités de narration, 5,5 secondes, profil "preview"
// 640x360 à 30 images/s. Le moteur est le même que pour la cible de
// production 3840x2160 (profil "target"), qui n'est pas rendue ici.
//
// Tous les fichiers sont créés dans tmp/r9-media-*/, dans des dossiers
// dont le nom contient des espaces, et supprimés par ce smoke seul.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { inspectMediaFile } from "../src/media/probe.js";

import {
  inspectLocalAssets,
  inspectLocalVoice,
  verifyLocalMedia
} from "../src/media/local-media.js";

import { runAssetAgent } from "../src/agents/asset.js";
import { runVoiceAgent } from "../src/agents/voice.js";
import { runAssemblyAgent } from "../src/agents/assembly.js";

import {
  buildRenderTimeline,
  resolveRenderProfile
} from "../src/render/render-timeline.js";

import {
  checkRenderedOutput,
  planRenderCommands,
  renderVideo,
  verifyRenderedVideo
} from "../src/render/ffmpeg-renderer.js";

import {
  validateRenderPlanMapping,
  validateRenderReport
} from "../src/utils/validate-render-report.js";

import {
  copyMediaSet,
  createMediaFixtureRoot,
  generateAudio,
  generateImage,
  generateVideo,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";

if (process.env.NO_API !== "1") {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1."
  );
  process.exit(1);
}

delete process.env.ANTHROPIC_FIXTURES;
delete process.env.ANTHROPIC_API_KEY;

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const TITLE = "Smoke de rendu local";

const TARGET = {
  width: 3840,
  height: 2160,
  fps: 30,
  aspect_ratio: "16:9"
};

let failed = 0;
let passed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`       ${error?.message ?? error}`);
  }
}

async function expectReject(fn, pattern) {
  let error = null;

  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "une erreur était attendue, aucune n'a été levée");

  assert(
    pattern.test(error.message),
    `erreur inattendue : ${error.message}`
  );

  return error;
}

function expectInvalid(verdict, pattern, label) {
  assert(
    verdict.valid === false,
    `${label} : FAIL attendu, PASS obtenu`
  );

  assert(
    verdict.errors.some(error => pattern.test(error)),
    `${label} : erreur attendue ${pattern} — obtenu : ${verdict.errors.join(" | ")}`
  );
}

function listDirectory(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).sort()
    : [];
}

// Couleur moyenne d'un carré de 2x2 pixels d'une image du MP4.
function samplePixel(file, seconds, x, y) {
  const pixel = execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v", "error",
      "-ss", String(seconds),
      "-i", file,
      "-frames:v", "1",
      "-vf", `crop=2:2:${x}:${y},scale=1:1`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-"
    ]
  );

  return [...pixel.subarray(0, 3)];
}

function isColor([red, green, blue], name) {
  switch (name) {
    case "red":
      return red > 200 && green < 60 && blue < 60;
    case "green":
      return green > 90 && red < 60 && blue < 60;
    case "blue":
      return blue > 200 && red < 60 && green < 60;
    case "black":
      return red < 30 && green < 30 && blue < 30;
    default:
      return false;
  }
}

// ------------------------------------------------------------------
// Plan court : 2 unités, 3 clips, 5 secondes prévues.
// ------------------------------------------------------------------

function shot(order, durationSeconds, type, refs) {
  return {
    order,
    duration_seconds: durationSeconds,
    visual_description: `Plan de test ${type} numéro ${order}.`,
    asset_query: `test clip ${type} ${order}`,
    asset_type: type,
    requires_exact_location: false,
    research_fact_refs: refs
  };
}

function buildVisual() {
  return {
    title: TITLE,
    sections: [
      {
        title: "Première unité",
        segments: [
          {
            script_segment_index: 0,
            estimated_seconds: 3,
            shots: [
              shot(1, 2, "stock_video", [0]),
              shot(2, 1, "map", [0])
            ]
          }
        ]
      },
      {
        title: "Seconde unité",
        segments: [
          {
            script_segment_index: 0,
            estimated_seconds: 2,
            shots: [shot(1, 2, "generated", [])]
          }
        ]
      }
    ]
  };
}

function segment(voiceover, estimatedSeconds) {
  return {
    voiceover,
    estimated_seconds: estimatedSeconds,
    research_fact_refs: [0],
    contains_unverified_claim: false,
    claims: [
      {
        text: voiceover,
        research_fact_ref: 0,
        is_unverified: false
      }
    ]
  };
}

function buildScript() {
  return {
    title: TITLE,
    hook: "Accroche de test.",
    thesis: "Thèse de test.",
    estimated_duration_minutes: 27,
    sections: [
      {
        title: "Première unité",
        purpose: "Tester le rendu.",
        segments: [segment("Première narration de test.", 3)]
      },
      {
        title: "Seconde unité",
        purpose: "Tester le rendu.",
        segments: [segment("Seconde narration de test.", 2)]
      }
    ],
    conclusion: "Conclusion de test."
  };
}

// Faux médias, dans un dossier dont le nom contient des espaces.
//
//   assets/s01-g01-sh01.mp4   rouge, 320x180, 3 s
//   assets/s01-g01-sh02.png   vert, image fixe
//   assets/s02-g01-sh01.mp4   bleu, 320x240 (4:3), 25 images/s, 3 s
//   voice/s01-g01.wav         3 s   (égale à l'estimation)
//   voice/s02-g01.mp3         2,5 s (estimation : 2 s)
function generateMediaSet(mediaDir) {
  const asset = name => path.join(mediaDir, "assets", name);
  const voice = name => path.join(mediaDir, "voice", name);

  generateVideo(asset("s01-g01-sh01.mp4"), {
    seconds: 3,
    color: "red"
  });
  generateImage(asset("s01-g01-sh02.png"), { color: "green" });
  generateVideo(asset("s02-g01-sh01.mp4"), {
    seconds: 3,
    color: "blue",
    size: "320x240",
    fps: 25
  });

  generateAudio(voice("s01-g01.wav"), { seconds: 3 });
  generateAudio(voice("s02-g01.mp3"), {
    seconds: 2.5,
    frequency: 660
  });
}

const repositoryOutputBefore = listDirectory(path.join(ROOT, "output"));

const fixtureRoot = createMediaFixtureRoot();

const mediaDir = path.join(fixtureRoot, "media avec espaces");
const outputDir = path.join(fixtureRoot, "sortie avec espaces");
const workBase = path.join(fixtureRoot, "travail avec espaces");

console.log("========================================");
console.log(" RENDER — SMOKE (VRAI MP4, ZERO API)");
console.log("========================================");

try {
  generateMediaSet(mediaDir);
  fs.mkdirSync(outputDir);

  // Chaîne réelle des agents 4 à 6 sur les faux médias.
  const assets = await runAssetAgent({
    visual: buildVisual(),
    testMode: true,
    localMedia: await inspectLocalAssets({ mediaDir })
  });

  const voice = await runVoiceAgent({
    script: buildScript(),
    testMode: true,
    localAudio: await inspectLocalVoice({ mediaDir })
  });

  const verification = await verifyLocalMedia({
    mediaDir,
    assets: assets.data,
    voice: voice.data
  });

  const assembly = await runAssemblyAgent({
    assets: assets.data,
    voice: voice.data,
    target: TARGET,
    testMode: true,
    mediaVerification: verification
  });

  let renderCounter = 0;

  // Options d'un rendu : copies indépendantes des entrées, nom de
  // sortie et dossier de travail propres à chaque appel.
  function renderOptions(overrides = {}) {
    renderCounter += 1;

    return {
      assembly: structuredClone(assembly.data),
      assets: structuredClone(assets.data),
      voice: structuredClone(voice.data),
      mediaDir,
      mediaVerification: structuredClone(verification),
      profile: "preview",
      outputDir,
      outputName: `rendu ${renderCounter}.mp4`,
      workDir: path.join(workBase, `render ${renderCounter}`),
      testMode: true,
      ...overrides
    };
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 1. Timeline réelle : la voix mesurée fait foi ---");

  const EXPECTED_VIDEO = [
    {
      asset_id: "s01-g01-sh01",
      unit_id: "s01-g01",
      start_seconds: 0,
      end_seconds: 2,
      duration_seconds: 2,
      source: { path: "assets/s01-g01-sh01.mp4", kind: "video" }
    },
    {
      asset_id: "s01-g01-sh02",
      unit_id: "s01-g01",
      start_seconds: 2,
      end_seconds: 3,
      duration_seconds: 1,
      source: { path: "assets/s01-g01-sh02.png", kind: "image" }
    },
    {
      asset_id: "s02-g01-sh01",
      unit_id: "s02-g01",
      start_seconds: 3,
      end_seconds: 5.5,
      duration_seconds: 2.5,
      source: { path: "assets/s02-g01-sh01.mp4", kind: "video" }
    }
  ];

  const EXPECTED_AUDIO = [
    {
      unit_id: "s01-g01",
      start_seconds: 0,
      end_seconds: 3,
      duration_seconds: 3,
      source: { path: "voice/s01-g01.wav" }
    },
    {
      unit_id: "s02-g01",
      start_seconds: 3,
      end_seconds: 5.5,
      duration_seconds: 2.5,
      source: { path: "voice/s02-g01.mp3" }
    }
  ];

  await test("le plan reste un plan : 5 s prévues, status unrendered", () => {
    assert(
      assembly.data.status === "unrendered" &&
      assembly.data.summary.total_duration_seconds === 5 &&
      assembly.data.audio_track[1].duration_seconds === 2 &&
      assembly.data.audio_track[1].audio.duration_seconds === 2.5,
      "plan de montage inattendu"
    );
  });

  await test("timeline recalée : unité 2 de 2 s prévues → 2,5 s mesurées", () => {
    const timeline = buildRenderTimeline({
      assembly: assembly.data,
      fps: 30
    });

    assert(
      isDeepStrictEqual(timeline.video_track, EXPECTED_VIDEO),
      `video_track : ${JSON.stringify(timeline.video_track)}`
    );

    assert(
      isDeepStrictEqual(timeline.audio_track, EXPECTED_AUDIO),
      `audio_track : ${JSON.stringify(timeline.audio_track)}`
    );

    assert(
      isDeepStrictEqual(timeline.summary, {
        total_clips: 3,
        total_units: 2,
        planned_duration_seconds: 5,
        rendered_duration_seconds: 5.5
      }),
      `summary : ${JSON.stringify(timeline.summary)}`
    );

    assert(
      isDeepStrictEqual(timeline.frames, {
        video: [60, 30, 75],
        audio: [90, 75],
        total: 165
      }),
      `frames : ${JSON.stringify(timeline.frames)}`
    );
  });

  await test("timeline déterministe, plan non modifié", () => {
    const plan = structuredClone(assembly.data);

    assert(
      isDeepStrictEqual(
        buildRenderTimeline({ assembly: plan, fps: 30 }),
        buildRenderTimeline({ assembly: plan, fps: 30 })
      ),
      "deux calculs différents"
    );

    assert(
      isDeepStrictEqual(plan, assembly.data),
      "le plan a été modifié"
    );
  });

  await test("clips recalés en proportion de leurs durées prévues", () => {
    const plan = structuredClone(assembly.data);

    // Audio de l'unité 1 : 3 s prévues, 2,4 s mesurées (plus court).
    plan.audio_track[0].audio.duration_seconds = 2.4;

    const timeline = buildRenderTimeline({ assembly: plan, fps: 30 });

    assert(
      isDeepStrictEqual(timeline.frames.video, [48, 24, 75]) &&
      timeline.video_track[0].duration_seconds === 1.6 &&
      timeline.video_track[1].duration_seconds === 0.8 &&
      timeline.audio_track[0].duration_seconds === 2.4,
      `frames : ${JSON.stringify(timeline.frames)}`
    );
  });

  await test("fenêtre arrondie à l'image supérieure : la narration n'est jamais coupée", () => {
    const plan = structuredClone(assembly.data);

    plan.audio_track[0].audio.duration_seconds = 2.41;

    const timeline = buildRenderTimeline({ assembly: plan, fps: 30 });

    // 2,41 s × 30 = 72,3 images → 73 images, soit 2,433 s.
    assert(
      timeline.frames.audio[0] === 73 &&
      isDeepStrictEqual(timeline.frames.video.slice(0, 2), [49, 24]) &&
      timeline.audio_track[0].duration_seconds >= 2.41 &&
      timeline.audio_track[0].duration_seconds < 2.41 + 1 / 30,
      `frames : ${JSON.stringify(timeline.frames)}`
    );
  });

  await test("une image fixe couvre n'importe quelle durée", () => {
    const plan = structuredClone(assembly.data);

    // L'unité 1 ne garde que l'image fixe, pour 3 s d'audio.
    plan.video_track.shift();

    const timeline = buildRenderTimeline({ assembly: plan, fps: 30 });

    assert(
      timeline.frames.video[0] === 90 &&
      timeline.video_track[0].source.kind === "image",
      `frames : ${JSON.stringify(timeline.frames)}`
    );
  });

  const timelineFailures = [
    [
      "vidéo source trop courte après calage",
      plan => {
        plan.audio_track[1].audio.duration_seconds = 3.5;
      },
      /^Render Timeline : vidéo source trop courte pour le clip s02-g01-sh01 : 3s disponibles, 3\.5s nécessaires après calage sur la voix/
    ],
    [
      "unité sans audio local (média non résolu)",
      plan => {
        delete plan.audio_track[0].audio;
      },
      /^Render Timeline : unité s01-g01 sans audio local mesuré : média non résolu/
    ],
    [
      "clip sans média local (média non résolu)",
      plan => {
        delete plan.video_track[0].media;
      },
      /^Render Timeline : clip s01-g01-sh01 sans média local : média non résolu/
    ],
    [
      "durée impossible (moins d'une image)",
      plan => {
        plan.audio_track[0].audio.duration_seconds = 0.03;
      },
      /^Render Timeline : durée impossible pour le clip s01-g01-sh02 : moins d'une image/
    ],
    [
      "durée audio nulle",
      plan => {
        plan.audio_track[0].audio.duration_seconds = 0;
      },
      /^Render Timeline : unité s01-g01 sans audio local mesuré/
    ],
    [
      "unité sans aucun clip",
      plan => {
        plan.video_track.pop();
      },
      /^Render Timeline : unité s02-g01 sans aucun clip/
    ],
    [
      "plan absent",
      () => null,
      /^Render Timeline : plan de montage absent ou invalide/
    ]
  ];

  for (const [name, mutate, pattern] of timelineFailures) {
    await test(`timeline → FAIL — ${name}`, async () => {
      let plan = structuredClone(assembly.data);

      if (mutate(plan) === null) {
        plan = undefined;
      }

      await expectReject(
        () => buildRenderTimeline({ assembly: plan, fps: 30 }),
        pattern
      );
    });
  }

  await test("profils : preview 640x360, target = cible du plan", async () => {
    assert(
      isDeepStrictEqual(
        resolveRenderProfile("preview", assembly.data.output),
        { name: "preview", width: 640, height: 360, fps: 30 }
      ) &&
      isDeepStrictEqual(
        resolveRenderProfile("target", assembly.data.output),
        { name: "target", width: 3840, height: 2160, fps: 30 }
      ),
      "profils inattendus"
    );

    await expectReject(
      () => resolveRenderProfile("4k", assembly.data.output),
      /^Render Timeline : profil de rendu inconnu "4k"/
    );

    await expectReject(
      () => resolveRenderProfile("target", {
        width: 1921,
        height: 1080,
        fps: 30
      }),
      /^Render Timeline : dimensions ou cadence de sortie invalides/
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 2. Commandes ffmpeg : contrôlées et déterministes ---");

  await test("plan de commandes déterministe, sans shell, fichiers locaux seuls", () => {
    const profile = resolveRenderProfile(
      "preview",
      assembly.data.output
    );

    const build = () => planRenderCommands({
      timeline: buildRenderTimeline({
        assembly: assembly.data,
        fps: profile.fps
      }),
      profile,
      sources: {
        video: [
          "/medias avec espaces/a.mp4",
          "/medias avec espaces/b.png",
          "/medias avec espaces/c.mp4"
        ],
        audio: [
          "/medias avec espaces/u1.wav",
          "/medias avec espaces/u2.mp3"
        ]
      },
      workDir: "/travail avec espaces"
    });

    const commands = build();

    assert(
      isDeepStrictEqual(commands, build()),
      "deux plans de commandes différents"
    );

    assert(
      isDeepStrictEqual(
        commands.map(command => command.kind),
        [
          "video-segment",
          "video-segment",
          "video-segment",
          "video-concat",
          "audio-unit",
          "audio-unit",
          "mux"
        ]
      ),
      `étapes : ${commands.map(command => command.kind)}`
    );

    for (const command of commands) {
      assert(
        command.args.every(argument => typeof argument === "string"),
        `${command.step} : argument non texte`
      );

      const inputs = command.args.filter(
        (argument, index) => command.args[index - 1] === "-i"
      );

      const whitelists = command.args.filter(
        (argument, index) =>
          argument === "-protocol_whitelist" &&
          command.args[index + 1] === "file"
      );

      assert(
        inputs.length > 0 && whitelists.length === inputs.length,
        `${command.step} : une entrée n'est pas limitée aux fichiers locaux`
      );
    }

    // Un chemin avec espaces reste un seul argument, jamais découpé.
    assert(
      commands[0].args.includes("file:/medias avec espaces/a.mp4") &&
      commands[0].args.includes("/travail avec espaces/seg-0001.mp4"),
      "chemin avec espaces découpé ou absent"
    );

    const flat = commands.flatMap(command => command.args);

    for (const expected of [
      "libx264",
      "18",
      "yuv420p",
      "aac",
      "192k",
      "48000",
      "+faststart",
      "veryfast"
    ]) {
      assert(
        flat.includes(expected),
        `réglage d'encodage absent : ${expected}`
      );
    }

    assert(
      commands[0].args.includes("60") &&
      commands[1].args.includes("-loop") &&
      commands[2].args.includes("75"),
      "nombres d'images ou boucle d'image fixe inattendus"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 3. Rendu réel d'un MP4 ---");

  let render = null;
  let renderedFile = null;

  const mediaBefore = listDirectory(path.join(mediaDir, "assets"))
    .concat(listDirectory(path.join(mediaDir, "voice")));

  await test("rendu réel : enveloppe render.json conforme au contrat", async () => {
    const options = renderOptions();
    const snapshot = structuredClone(options);

    render = await renderVideo(options);
    renderedFile = path.join(outputDir, options.outputName);

    assert(
      isDeepStrictEqual(Object.keys(render), [
        "stage",
        "mode",
        "data",
        "validation",
        "usage"
      ]) &&
      render.stage === "render" &&
      render.mode === "test" &&
      render.usage === null &&
      render.validation.valid === true,
      "enveloppe inattendue"
    );

    assert(
      isDeepStrictEqual(Object.keys(render.data), [
        "title",
        "profile",
        "output",
        "video_track",
        "audio_track",
        "summary",
        "status"
      ]) &&
      render.data.title === TITLE &&
      render.data.profile === "preview" &&
      render.data.status === "rendered",
      `clés ou valeurs inattendues : ${Object.keys(render.data)}`
    );

    assert(
      isDeepStrictEqual(options, snapshot),
      "les entrées du rendu ont été modifiées"
    );
  });

  await test("le fichier existe, n'est pas vide, et porte un nom avec espaces", () => {
    assert(
      renderedFile.endsWith("rendu 1.mp4") &&
      fs.existsSync(renderedFile) &&
      fs.statSync(renderedFile).size > 1000 &&
      render.data.output.path === "rendu 1.mp4" &&
      render.data.output.size_bytes ===
        fs.statSync(renderedFile).size,
      `sortie inattendue : ${JSON.stringify(render.data.output)}`
    );
  });

  await test("ffprobe : MP4, H.264, AAC, 640x360, 30 images/s, 5,5 s à ±0,2 s", async () => {
    // Sondage indépendant du moteur : le fichier, pas son extension.
    const probed = await inspectMediaFile(renderedFile);

    assert(
      probed.kind === "video" &&
      probed.container.split(",").includes("mp4") &&
      probed.video_codec === "h264" &&
      probed.audio_codec === "aac" &&
      probed.width === 640 &&
      probed.height === 360 &&
      probed.fps === 30 &&
      probed.sample_rate === 48000 &&
      probed.channels === 2 &&
      probed.duration_seconds > 0 &&
      Math.abs(probed.duration_seconds - 5.5) <= 0.2,
      `relevé inattendu : ${JSON.stringify(probed)}`
    );

    const video = probed.streams.find(
      stream => stream.type === "video"
    );

    const audio = probed.streams.find(
      stream => stream.type === "audio"
    );

    assert(
      probed.streams.length === 2 &&
      Math.abs(video.duration_seconds - 5.5) <= 0.2 &&
      Math.abs(audio.duration_seconds - 5.5) <= 0.2 &&
      Math.abs(video.duration_seconds - audio.duration_seconds) <= 0.2,
      `flux inattendus : ${JSON.stringify(probed.streams)}`
    );

    assert(
      render.data.output.container === probed.container &&
      render.data.output.width === 640 &&
      render.data.output.height === 360 &&
      render.data.output.fps === 30 &&
      render.data.output.video_codec === "h264" &&
      render.data.output.audio_codec === "aac" &&
      render.data.output.duration_seconds ===
        probed.duration_seconds &&
      /^[0-9a-f]{64}$/.test(render.data.output.sha256),
      `output : ${JSON.stringify(render.data.output)}`
    );
  });

  await test("timeline réellement appliquée : 3 clips, 2 unités, 5,5 s", () => {
    assert(
      isDeepStrictEqual(render.data.video_track, EXPECTED_VIDEO) &&
      isDeepStrictEqual(render.data.audio_track, EXPECTED_AUDIO) &&
      isDeepStrictEqual(render.data.summary, {
        total_clips: 3,
        total_units: 2,
        planned_duration_seconds: 5,
        rendered_duration_seconds: 5.5
      }),
      `timeline : ${JSON.stringify(render.data.summary)}`
    );
  });

  await test("ordre des clips prouvé dans l'image : rouge, vert, bleu", () => {
    // Milieu de chaque clip dans la timeline rendue.
    const samples = [
      [1.0, "red"],
      [2.5, "green"],
      [4.2, "blue"]
    ];

    for (const [seconds, color] of samples) {
      const pixel = samplePixel(renderedFile, seconds, 320, 180);

      assert(
        isColor(pixel, color),
        `à ${seconds}s : ${color} attendu, pixel ${pixel}`
      );
    }
  });

  await test("ratio 4:3 conservé avec bandes noires, sans recadrage", () => {
    // Le clip bleu est en 320x240 : il occupe 480x360 au centre.
    assert(
      isColor(samplePixel(renderedFile, 4.2, 4, 180), "black") &&
      isColor(samplePixel(renderedFile, 4.2, 634, 180), "black") &&
      isColor(samplePixel(renderedFile, 4.2, 100, 180), "blue"),
      "bandes noires latérales attendues autour du clip 4:3"
    );
  });

  await test("index en tête du MP4 (lecture progressive)", () => {
    const head = fs
      .readFileSync(renderedFile)
      .subarray(0, 4096)
      .toString("latin1");

    assert(
      head.includes("ftyp") &&
      head.includes("moov") &&
      head.indexOf("moov") <
        (head.includes("mdat") ? head.indexOf("mdat") : Infinity),
      "atome moov absent du début du fichier"
    );
  });

  await test("dossier de travail supprimé, médias sources intacts", () => {
    assert(
      listDirectory(workBase).length === 0,
      `dossier de travail restant : ${listDirectory(workBase)}`
    );

    assert(
      isDeepStrictEqual(
        listDirectory(path.join(mediaDir, "assets"))
          .concat(listDirectory(path.join(mediaDir, "voice"))),
        mediaBefore
      ),
      "le dossier média a été modifié par le rendu"
    );

    assert(
      isDeepStrictEqual(listDirectory(outputDir), ["rendu 1.mp4"]),
      `sortie : ${listDirectory(outputDir)}`
    );
  });

  await test("rapport validé : contrat fermé et fidélité au plan", () => {
    const report = validateRenderReport(render.data);
    const mapping = validateRenderPlanMapping(
      render.data,
      assembly.data
    );

    assert(
      report.valid && mapping.valid,
      [...report.errors, ...mapping.errors].join(" | ")
    );
  });

  await test("déterminisme logique : un second rendu donne la même vidéo", async () => {
    const options = renderOptions();
    const second = await renderVideo(options);

    const comparable = report => ({
      ...report.data,
      output: {
        ...report.data.output,
        path: null,
        size_bytes: null,
        sha256: null
      }
    });

    assert(
      isDeepStrictEqual(comparable(second), comparable(render)),
      "les deux rendus diffèrent logiquement"
    );

    assert(
      fs.existsSync(path.join(outputDir, options.outputName)),
      "second fichier absent"
    );
  });

  await test("profil target : le même moteur rend en 3840x2160 à 30 images/s", async () => {
    // Seul rendu 4K du smoke, sur 5,5 s : il prouve que rien dans le
    // moteur n'est lié au format réduit des essais.
    const options = renderOptions({ profile: "target" });
    const target = await renderVideo(options);

    const probed = await inspectMediaFile(
      path.join(outputDir, options.outputName)
    );

    assert(
      target.data.profile === "target" &&
      probed.width === 3840 &&
      probed.height === 2160 &&
      probed.fps === 30 &&
      probed.video_codec === "h264" &&
      probed.audio_codec === "aac" &&
      Math.abs(probed.duration_seconds - 5.5) <= 0.2,
      `relevé inattendu : ${JSON.stringify(probed)}`
    );

    assert(
      isDeepStrictEqual(target.data.video_track, render.data.video_track) &&
      validateRenderPlanMapping(target.data, assembly.data).valid,
      "timeline du rendu target différente de celle du rendu preview"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 4. Fail closed ---");

  const outputsAfterRenders = listDirectory(outputDir);

  // Jeux de médias altérés APRÈS le recontrôle disque : le rapport de
  // recontrôle transmis reste celui du jeu intact.
  const missingAsset = copyMediaSet(
    mediaDir,
    path.join(fixtureRoot, "media asset absent")
  );

  fs.rmSync(path.join(missingAsset, "assets", "s01-g01-sh02.png"));

  const unreadableAsset = copyMediaSet(
    mediaDir,
    path.join(fixtureRoot, "media asset illisible")
  );

  fs.truncateSync(
    path.join(unreadableAsset, "assets", "s01-g01-sh01.mp4"),
    300
  );

  // Vidéo réellement plus courte que ce que le manifeste a enregistré.
  const shorterAsset = copyMediaSet(
    mediaDir,
    path.join(fixtureRoot, "media asset raccourci")
  );

  generateVideo(
    path.join(shorterAsset, "assets", "s01-g01-sh01.mp4"),
    { seconds: 1, color: "red" }
  );

  const unreadableVoice = copyMediaSet(
    mediaDir,
    path.join(fixtureRoot, "media voix illisible")
  );

  fs.writeFileSync(
    path.join(unreadableVoice, "voice", "s02-g01.mp3"),
    "ceci n'est pas un son"
  );

  const contracts = {
    assets: await runAssetAgent({
      visual: buildVisual(),
      testMode: true
    }),
    voice: await runVoiceAgent({
      script: buildScript(),
      testMode: true
    })
  };

  contracts.assembly = await runAssemblyAgent({
    assets: contracts.assets.data,
    voice: contracts.voice.data,
    target: TARGET,
    testMode: true
  });

  const renderFailures = [
    [
      "plan de montage invalide",
      options => {
        options.assembly.status = "rendered";
      },
      /^Renderer : plan de montage invalide\. status doit être "unrendered"/
    ],
    [
      "plan de montage absent",
      options => {
        options.assembly = undefined;
      },
      /^Renderer : plan de montage invalide\. Assembly plan absent ou invalide/
    ],
    [
      "médias non résolus (pipeline sans média)",
      options => {
        options.assembly = structuredClone(contracts.assembly.data);
        options.assets = structuredClone(contracts.assets.data);
        options.voice = structuredClone(contracts.voice.data);
        options.mediaVerification = undefined;
      },
      /^Renderer : médias non résolus : le plan ne référence aucun média local recontrôlé/
    ],
    [
      "médias référencés sans recontrôle disque",
      options => {
        options.mediaVerification = undefined;
      },
      /^Renderer : plan de montage incohérent avec ses sources\. médias locaux référencés sans rapport de vérification disque/
    ],
    [
      "recontrôle disque en échec",
      options => {
        options.mediaVerification.valid = false;
        options.mediaVerification.errors.push("média modifié");
      },
      /^Renderer : plan de montage incohérent avec ses sources\. vérification disque des médias en échec — média modifié/
    ],
    [
      "asset requis absent du disque",
      options => {
        options.mediaDir = missingAsset;
      },
      /^Renderer : Local Media : fichier média absent \(assets\/s01-g01-sh02\.png\)/
    ],
    [
      "dossier média introuvable",
      options => {
        options.mediaDir = path.join(fixtureRoot, "media absent");
      },
      /^Local Media : dossier média introuvable/
    ],
    [
      "média vidéo illisible (ffmpeg retourne non zéro)",
      options => {
        options.mediaDir = unreadableAsset;
      },
      /^Renderer : ffmpeg a échoué — étape segment vidéo s01-g01-sh01, code [1-9]\d* — /
    ],
    [
      "média audio illisible (ffmpeg retourne non zéro)",
      options => {
        options.mediaDir = unreadableVoice;
      },
      /^Renderer : ffmpeg a échoué — étape narration s02-g01, code [1-9]\d* — /
    ],
    [
      "vidéo source trop courte pour la durée recalée",
      options => {
        options.voice.narration_units[1].audio.duration_seconds = 3.5;
        options.assembly.audio_track[1].audio.duration_seconds = 3.5;
      },
      /^Render Timeline : vidéo source trop courte pour le clip s02-g01-sh01 : 3s disponibles, 3\.5s nécessaires/
    ],
    [
      "vidéo réellement plus courte que son relevé (ni boucle ni image figée)",
      options => {
        options.mediaDir = shorterAsset;
      },
      /^Renderer : segment incomplet — étape segment vidéo s01-g01-sh01 : 1s rendues pour 2s nécessaires/
    ],
    [
      "ffmpeg absent",
      options => {
        options.ffmpegPath = "ffmpeg-introuvable-r10";
      },
      /^Renderer : ffmpeg indisponible \(ffmpeg-introuvable-r10\)/
    ],
    [
      "ffmpeg retourne non zéro",
      options => {
        options.ffmpegPath = "false";
      },
      /^Renderer : ffmpeg a échoué — étape segment vidéo s01-g01-sh01, code 1/
    ],
    [
      "ffmpeg ne produit aucune sortie",
      options => {
        options.ffmpegPath = "true";
      },
      /^Renderer : sortie absente ou vide — étape segment vidéo s01-g01-sh01/
    ],
    [
      "ffmpeg dépasse le délai",
      options => {
        options.timeoutMs = 1;
      },
      /^Renderer : ffmpeg interrompu après 1 ms — étape segment vidéo s01-g01-sh01/
    ],
    [
      "la sortie existe déjà (écrasement refusé)",
      options => {
        options.outputName = "rendu 1.mp4";
      },
      /^Renderer : la sortie existe déjà, écrasement refusé \(rendu 1\.mp4\)/
    ],
    [
      "nom de sortie en traversal",
      options => {
        options.outputName = "../evasion.mp4";
      },
      /^Renderer : nom de sortie invalide — path doit être un simple nom de fichier/
    ],
    [
      "nom de sortie en URL",
      options => {
        options.outputName = "https://exemple.invalid/video.mp4";
      },
      /^Renderer : nom de sortie invalide — path doit être un simple nom de fichier/
    ],
    [
      "nom de sortie sans extension .mp4",
      options => {
        options.outputName = "video.mov";
      },
      /^Renderer : nom de sortie invalide — path doit être un nom de fichier \.mp4/
    ],
    [
      "nom de sortie absent",
      options => {
        options.outputName = undefined;
      },
      /^Renderer : nom de sortie invalide — path manquant/
    ],
    [
      "dossier de sortie introuvable",
      options => {
        options.outputDir = path.join(fixtureRoot, "sortie absente");
      },
      /^Renderer : dossier de sortie introuvable/
    ],
    [
      "dossier de sortie en URL",
      options => {
        options.outputDir = "https://exemple.invalid/sortie";
      },
      /^Renderer : le dossier de sortie doit être un chemin local/
    ],
    [
      "dossier de travail relatif",
      options => {
        options.workDir = "travail";
      },
      /^Renderer : dossier de travail absolu obligatoire/
    ],
    [
      "profil de rendu inconnu",
      options => {
        options.profile = "ultra";
      },
      /^Render Timeline : profil de rendu inconnu "ultra"/
    ]
  ];

  for (const [name, mutate, pattern] of renderFailures) {
    await test(`rendu → FAIL — ${name}`, async () => {
      const options = renderOptions();

      mutate(options);

      await expectReject(() => renderVideo(options), pattern);

      // Aucune sortie partielle, aucun dossier de travail laissé.
      assert(
        isDeepStrictEqual(listDirectory(outputDir), outputsAfterRenders),
        `sortie inattendue après échec : ${listDirectory(outputDir)}`
      );

      assert(
        listDirectory(workBase).length === 0,
        `dossier de travail laissé après échec : ${listDirectory(workBase)}`
      );
    });
  }

  await test("rendu → FAIL — le dossier de travail existe déjà (jamais supprimé)", async () => {
    const options = renderOptions();

    fs.mkdirSync(options.workDir, { recursive: true });
    fs.writeFileSync(path.join(options.workDir, "a-garder.txt"), "x");

    await expectReject(
      () => renderVideo(options),
      /^Renderer : le dossier de travail existe déjà/
    );

    // Le moteur ne supprime pas un dossier qu'il n'a pas créé.
    assert(
      fs.existsSync(path.join(options.workDir, "a-garder.txt")),
      "un dossier préexistant a été supprimé par le moteur"
    );

    fs.rmSync(options.workDir, { recursive: true });
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 5. Contrôle de la sortie (relevé ffprobe) ---");

  const probedOutput = await inspectMediaFile(renderedFile);

  const previewProfile = resolveRenderProfile(
    "preview",
    assembly.data.output
  );

  await test("sortie réelle acceptée par le contrôle", () => {
    const errors = checkRenderedOutput(probedOutput, {
      profile: previewProfile,
      expectedDuration: 5.5
    });

    assert(errors.length === 0, errors.join(" | "));
  });

  const withStreams = mutate => {
    const probed = structuredClone(probedOutput);

    mutate(probed);

    return probed;
  };

  const outputCases = [
    [
      "sortie non sondable",
      () => undefined,
      /sortie non sondable/
    ],
    [
      "aucun flux vidéo",
      probed => {
        probed.kind = "audio";
      },
      /aucun flux vidéo dans la sortie/
    ],
    [
      "aucun flux audio",
      probed => {
        probed.audio_codec = null;
      },
      /aucun flux audio dans la sortie/
    ],
    [
      "codec vidéo inattendu",
      probed => {
        probed.video_codec = "hevc";
      },
      /codec vidéo inattendu \(hevc\)/
    ],
    [
      "codec audio inattendu",
      probed => {
        probed.audio_codec = "mp3";
      },
      /codec audio inattendu \(mp3\)/
    ],
    [
      "conteneur inattendu",
      probed => {
        probed.container = "matroska,webm";
      },
      /conteneur inattendu \(matroska,webm\)/
    ],
    [
      "dimensions inattendues",
      probed => {
        probed.width = 320;
        probed.height = 180;
      },
      /dimensions 320x180 au lieu de 640x360/
    ],
    [
      "cadence inattendue",
      probed => {
        probed.fps = 25;
      },
      /cadence 25 au lieu de 30 images\/s/
    ],
    [
      "audio mono 44,1 kHz",
      probed => {
        probed.sample_rate = 44100;
        probed.channels = 1;
      },
      /audio 44100 Hz \/ 1 canal\(aux\) au lieu de 48000 Hz \/ 2/
    ],
    [
      "durée nulle",
      probed => {
        probed.duration_seconds = 0;
      },
      /durée de la sortie nulle ou absente/
    ],
    [
      "durée hors tolérance (+0,3 s)",
      probed => {
        probed.duration_seconds = 5.8;
      },
      /durée 5\.8s à plus de 0\.2s de la durée attendue 5\.5s/
    ],
    [
      "flux audio plus court que la timeline",
      probed => {
        probed.streams.find(
          stream => stream.type === "audio"
        ).duration_seconds = 5.0;
      },
      /flux audio de 5s à plus de 0\.2s de la durée attendue 5\.5s/
    ],
    [
      "flux vidéo plus court que la timeline",
      probed => {
        probed.streams.find(
          stream => stream.type === "video"
        ).duration_seconds = 3.0;
      },
      /flux vidéo de 3s à plus de 0\.2s de la durée attendue 5\.5s/
    ],
    [
      "durée de flux indisponible",
      probed => {
        probed.streams[0].duration_seconds = null;
      },
      /durée du flux (vidéo|audio) indisponible/
    ]
  ];

  for (const [name, mutate, pattern] of outputCases) {
    await test(`sortie invalide → FAIL — ${name}`, () => {
      const probed =
        name === "sortie non sondable"
          ? undefined
          : withStreams(mutate);

      const errors = checkRenderedOutput(probed, {
        profile: previewProfile,
        expectedDuration: 5.5
      });

      assert(
        errors.some(error => pattern.test(error)),
        `erreur attendue ${pattern} — obtenu : ${errors.join(" | ")}`
      );
    });
  }

  await test("tolérance de durée : ±0,2 s acceptés, au-delà refusés", () => {
    const check = duration =>
      checkRenderedOutput(
        withStreams(probed => {
          probed.duration_seconds = duration;
        }),
        { profile: previewProfile, expectedDuration: 5.5 }
      ).filter(error => error.startsWith("durée "));

    assert(
      check(5.69).length === 0 &&
      check(5.31).length === 0 &&
      check(5.75).length === 1 &&
      check(5.25).length === 1,
      "tolérance de durée inattendue"
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 6. Contrat render.json ---");

  const reportCases = [
    [
      "rapport absent",
      () => null,
      /Render report absent ou invalide/
    ],
    [
      "status différent de rendered",
      data => {
        data.status = "unrendered";
      },
      /status doit être "rendered"/
    ],
    [
      "profil inconnu",
      data => {
        data.profile = "ultra";
      },
      /profile invalide/
    ],
    [
      "champ racine inconnu",
      data => {
        data.ffmpeg_command = "ffmpeg -i";
      },
      /report: champ ffmpeg_command non autorisé/
    ],
    [
      "champ output inconnu (url)",
      data => {
        data.output.url = "https://exemple.invalid/video.mp4";
      },
      /output: champ url non autorisé/
    ],
    [
      "output.path avec dossier",
      data => {
        data.output.path = "output/rendu.mp4";
      },
      /output: path doit être un simple nom de fichier/
    ],
    [
      "output.path en chemin absolu",
      data => {
        data.output.path = "/tmp/rendu.mp4";
      },
      /output: path doit être un simple nom de fichier/
    ],
    [
      "output.path en URL",
      data => {
        data.output.path = "https://exemple.invalid/rendu.mp4";
      },
      /output: path doit être un simple nom de fichier/
    ],
    [
      "output.path sans .mp4",
      data => {
        data.output.path = "rendu.mov";
      },
      /output: path doit être un nom de fichier \.mp4/
    ],
    [
      "conteneur non MP4",
      data => {
        data.output.container = "matroska,webm";
      },
      /output: container doit être un MP4/
    ],
    [
      "codec vidéo non H.264",
      data => {
        data.output.video_codec = "hevc";
      },
      /output: video_codec doit être h264/
    ],
    [
      "codec audio non AAC",
      data => {
        data.output.audio_codec = "mp3";
      },
      /output: audio_codec doit être aac/
    ],
    [
      "dimensions différentes du profil preview",
      data => {
        data.output.width = 1280;
        data.output.height = 720;
      },
      /output: dimensions différentes du profil preview 640x360/
    ],
    [
      "largeur impaire",
      data => {
        data.output.width = 641;
      },
      /output: width invalide/
    ],
    [
      "durée du fichier nulle",
      data => {
        data.output.duration_seconds = 0;
      },
      /output: duration_seconds invalide/
    ],
    [
      "durée du fichier loin de la timeline",
      data => {
        data.output.duration_seconds = 6;
      },
      /output: durée du fichier 6s à plus de 0\.2s de la timeline 5\.5s/
    ],
    [
      "taille nulle",
      data => {
        data.output.size_bytes = 0;
      },
      /output: size_bytes invalide/
    ],
    [
      "empreinte invalide",
      data => {
        data.output.sha256 = "abc";
      },
      /output: sha256 invalide/
    ],
    [
      "piste vidéo vide",
      data => {
        data.video_track = [];
      },
      /video_track doit être un tableau non vide/
    ],
    [
      "trou dans la piste vidéo",
      data => {
        data.video_track[1].start_seconds += 0.5;
        data.video_track[1].end_seconds += 0.5;
      },
      /video_track\[1\]: trou entre 2s et 2\.5s/
    ],
    [
      "chevauchement dans la piste vidéo",
      data => {
        data.video_track[1].start_seconds -= 0.5;
        data.video_track[1].end_seconds -= 0.5;
      },
      /video_track\[1\]: chevauchement entre 1\.5s et 2s/
    ],
    [
      "fin de clip incohérente",
      data => {
        data.video_track[0].end_seconds = 1.5;
      },
      /video_track\[0\]: end_seconds différent de start_seconds \+ duration_seconds/
    ],
    [
      "clip dupliqué",
      data => {
        data.video_track[1].asset_id = "s01-g01-sh01";
      },
      /video_track\[1\]: asset_id dupliqué s01-g01-sh01/
    ],
    [
      "fenêtre audio différente de ses clips",
      data => {
        data.audio_track[0].end_seconds = 2.5;
        data.audio_track[0].duration_seconds = 2.5;
        data.audio_track[1].start_seconds = 2.5;
        data.audio_track[1].duration_seconds = 3;
      },
      /audio_track\[0\]: fenêtre vidéo 0s–3s différente de la fenêtre audio 0s–2\.5s/
    ],
    [
      "source en URL",
      data => {
        data.video_track[0].source.path =
          "https://exemple.invalid/a.mp4";
      },
      /video_track\[0\]\.source: path ne doit pas être une URL/
    ],
    [
      "source en traversal",
      data => {
        data.audio_track[0].source.path = "voice/../../u1.wav";
      },
      /audio_track\[0\]\.source: path ne doit contenir ni remontée/
    ],
    [
      "source hors du dossier attendu",
      data => {
        data.video_track[0].source.path = "voice/s01-g01.wav";
      },
      /video_track\[0\]\.source: path doit être assets\/<fichier>/
    ],
    [
      "champ de clip inconnu",
      data => {
        data.video_track[0].transition = "fade";
      },
      /video_track\[0\]: champ transition non autorisé/
    ],
    [
      "champ de source inconnu",
      data => {
        data.video_track[0].source.absolute_path = "/tmp/a.mp4";
      },
      /video_track\[0\]\.source: champ absolute_path non autorisé/
    ],
    [
      "summary fausse : rendered_duration_seconds",
      data => {
        data.summary.rendered_duration_seconds = 5;
      },
      /summary: rendered_duration_seconds incorrect/
    ],
    [
      "summary fausse : total_clips",
      data => {
        data.summary.total_clips = 2;
      },
      /summary: total_clips incorrect/
    ],
    [
      "champ summary inconnu",
      data => {
        data.summary.frames = 165;
      },
      /summary: champ frames non autorisé/
    ]
  ];

  for (const [name, mutate, pattern] of reportCases) {
    await test(`render.json altéré → FAIL — ${name}`, () => {
      let data = structuredClone(render.data);

      if (mutate(data) === null) {
        data = undefined;
      }

      expectInvalid(
        validateRenderReport(data),
        pattern,
        "contrat render.json"
      );
    });
  }

  const mappingCases = [
    [
      "narration coupée (fenêtre plus courte que l'audio mesuré)",
      data => {
        data.audio_track[1].duration_seconds = 2;
      },
      /audio_track\[1\]: fenêtre 2s plus courte que l'audio mesuré 2\.5s — narration coupée/
    ],
    [
      "narration étirée (fenêtre plus longue de plus d'une image)",
      data => {
        data.audio_track[1].duration_seconds = 3;
      },
      /audio_track\[1\]: fenêtre 3s plus longue que l'audio mesuré 2\.5s de plus d'une image/
    ],
    [
      "clips dans un autre ordre que le plan",
      data => {
        const [first, second] = data.video_track;

        [first.asset_id, second.asset_id] =
          [second.asset_id, first.asset_id];
      },
      /video_track\[0\]: clip différent du plan de montage/
    ],
    [
      "source différente du média du plan",
      data => {
        data.video_track[0].source.path = "assets/s01-g01-sh01.mov";
      },
      /video_track\[0\]: source différente du média du plan/
    ],
    [
      "audio différent de celui du plan",
      data => {
        data.audio_track[0].source.path = "voice/s01-g01.mp3";
      },
      /audio_track\[0\]: source différente de l'audio du plan/
    ],
    [
      "clip manquant",
      data => {
        data.video_track.pop();
      },
      /2 clip\(s\) rendu\(s\) pour 3 prévu\(s\)/
    ],
    [
      "titre différent du plan",
      data => {
        data.title = "Un autre titre";
      },
      /title différent du plan de montage/
    ],
    [
      "durée prévue différente du plan",
      data => {
        data.summary.planned_duration_seconds = 6;
      },
      /summary: planned_duration_seconds différent du plan de montage/
    ],
    [
      "cadence différente de la cible du plan",
      data => {
        data.output.fps = 25;
      },
      /output: cadence différente de la cible du plan de montage/
    ],
    [
      "profil target mais dimensions preview",
      data => {
        data.profile = "target";
      },
      /output: dimensions différentes de la cible du plan de montage/
    ]
  ];

  for (const [name, mutate, pattern] of mappingCases) {
    await test(`rendu infidèle au plan → FAIL — ${name}`, () => {
      const data = structuredClone(render.data);

      mutate(data);

      expectInvalid(
        validateRenderPlanMapping(data, assembly.data),
        pattern,
        "fidélité au plan"
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 7. Recontrôle disque de la vidéo rendue ---");

  await test("vidéo intacte → rapport valide, périmètre rendered_video", async () => {
    const report = await verifyRenderedVideo({
      outputDir,
      render,
      assembly: assembly.data
    });

    assert(
      report.scope === "rendered_video" &&
      report.valid === true &&
      report.errors.length === 0 &&
      isDeepStrictEqual(report.output, render.data.output),
      `rapport inattendu : ${JSON.stringify(report)}`
    );
  });

  // Copies de la sortie, altérées, dans des dossiers propres au test.
  function outputCopy(name, alter) {
    const directory = path.join(fixtureRoot, name);

    fs.mkdirSync(directory);
    fs.copyFileSync(
      renderedFile,
      path.join(directory, render.data.output.path)
    );

    alter?.(path.join(directory, render.data.output.path));

    return directory;
  }

  const verificationCases = [
    [
      "vidéo modifiée après le rendu",
      () => outputCopy("sortie modifiee", file => {
        fs.appendFileSync(file, "altération");
      }),
      data => data,
      /vidéo rendue modifiée depuis le rendu \(rendu 1\.mp4 — .*sha256/
    ],
    [
      "vidéo supprimée après le rendu",
      () => outputCopy("sortie supprimee", file => {
        fs.rmSync(file);
      }),
      data => data,
      /Renderer : vidéo rendue absente \(rendu 1\.mp4\)/
    ],
    [
      "vidéo remplacée par un fichier non vidéo (sortie non sondable)",
      () => outputCopy("sortie illisible", file => {
        fs.writeFileSync(file, "ceci n'est pas un MP4");
      }),
      data => data,
      /Media Inspector : fichier illisible par ffprobe/
    ],
    [
      "vidéo remplacée par un fichier sans flux vidéo",
      () => outputCopy("sortie audio seul", file => {
        fs.copyFileSync(
          path.join(mediaDir, "voice", "s01-g01.wav"),
          file
        );
      }),
      data => data,
      /vidéo rendue modifiée depuis le rendu/
    ],
    [
      "empreinte falsifiée dans render.json",
      () => outputDir,
      data => {
        data.output.sha256 = "0".repeat(64);

        return data;
      },
      /vidéo rendue modifiée depuis le rendu \(rendu 1\.mp4 — sha256\)/
    ],
    [
      "render.json absent",
      () => outputDir,
      () => undefined,
      /Render report absent ou invalide/
    ],
    [
      "render.json infidèle au plan",
      () => outputDir,
      data => {
        data.title = "Un autre titre";

        return data;
      },
      /title différent du plan de montage/
    ],
    [
      "dossier de sortie disparu",
      () => path.join(fixtureRoot, "sortie disparue"),
      data => data,
      /Renderer : dossier de sortie introuvable/
    ]
  ];

  for (const [name, directory, mutate, pattern] of verificationCases) {
    await test(`recontrôle vidéo → FAIL — ${name}`, async () => {
      const data = mutate(structuredClone(render.data));

      const report = await verifyRenderedVideo({
        outputDir: directory(),
        render: data === undefined ? undefined : { ...render, data },
        assembly: assembly.data
      });

      expectInvalid(report, pattern, "recontrôle vidéo");

      assert(
        report.output === null,
        "une vidéo fautive figure comme vérifiée"
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 8. Zéro API, zéro réseau ---");

  await test("moteur de rendu : execFile sans shell, protocole file seul, aucun module réseau", () => {
    const allowed = {
      "src/render/render-timeline.js": [],
      "src/render/ffmpeg-renderer.js": [
        "node:fs",
        "node:path",
        "node:crypto",
        "node:child_process",
        "../media/probe.js",
        "../media/local-media.js",
        "../utils/validate-asset-manifest.js",
        "../utils/validate-voice-manifest.js",
        "../utils/validate-assembly-plan.js",
        "../utils/validate-render-report.js",
        "./render-timeline.js"
      ],
      "src/utils/validate-render-report.js": ["node:util"]
    };

    for (const [file, imports] of Object.entries(allowed)) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");

      assert(
        isDeepStrictEqual(
          [...source.matchAll(/from\s+"([^"]+)"/g)].map(
            match => match[1]
          ),
          imports
        ),
        `${file} : imports inattendus`
      );

      assert(
        !/\bfetch\s*\(|node:https?|node:net|node:dns|shell\s*:|execSync|\bspawn\b|\bexec\s*\(|createMessage|process\.env/.test(
          source
        ),
        `${file} : réseau, shell, modèle ou environnement détecté`
      );
    }

    const renderer = fs.readFileSync(
      path.join(ROOT, "src/render/ffmpeg-renderer.js"),
      "utf8"
    );

    assert(
      renderer.includes('["-protocol_whitelist", "file"]') &&
      renderer.includes("execFile("),
      "lancement de ffmpeg non conforme"
    );
  });

  await test("Quality et les agents restent purs : ni rendu, ni disque, ni processus", () => {
    for (const file of [
      "src/agents/asset.js",
      "src/agents/voice.js",
      "src/agents/assembly.js",
      "src/agents/quality.js",
      "src/utils/validate-quality-report.js"
    ]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");

      assert(
        !/\/render\/|\/media\/|node:fs|child_process|execFile|process\.env/.test(
          source
        ),
        `${file} : accès au rendu, au disque ou à un processus`
      );
    }
  });

  await test("NO_API=1, sans ANTHROPIC_FIXTURES ni clé API", () => {
    assert(
      process.env.NO_API === "1" &&
      !("ANTHROPIC_FIXTURES" in process.env) &&
      !("ANTHROPIC_API_KEY" in process.env),
      "environnement inattendu"
    );
  });

  await test("le smoke n'a rien écrit hors de son dossier de fixtures", () => {
    assert(
      isDeepStrictEqual(
        listDirectory(path.join(ROOT, "output")),
        repositoryOutputBefore
      ),
      "output/ du dépôt modifié par le smoke"
    );

    const strangers = listDirectory(path.join(ROOT, "tmp")).filter(
      name => !name.startsWith(".") && !name.startsWith("r9-media-")
    );

    assert(
      strangers.length === 0,
      `tmp/ contient des fichiers inattendus : ${strangers}`
    );
  });

  await test("garde réseau Node : 0 tentative réseau, 0 appel SDK", () => {
    const attempts = networkGuard.attempts();

    assert(
      attempts.length === 0,
      `tentatives bloquées : ${attempts.join(", ")}`
    );
  });
} finally {
  // Le smoke ne supprime que le dossier de fixtures qu'il a créé.
  removeMediaFixtureRoot(fixtureRoot);
}

await test("dossier de fixtures du smoke supprimé (MP4 de test compris)", () => {
  assert(
    !fs.existsSync(fixtureRoot),
    `dossier encore présent : ${fixtureRoot}`
  );
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API réelle utilisée : NON");
console.log("MP4 réel rendu et sondé : OUI (profil preview, supprimé après le test)");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — moteur de rendu local"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — moteur de rendu local : vrai MP4, timeline calée sur la voix, fail-closed, zéro API"
);

process.exit(0);
