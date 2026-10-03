// Smoke de bout en bout AVEC rendu réel — zéro API, zéro réseau.
//
// Usage :
//   NO_API=1 node scripts/render-pipeline-smoke.js
//
// Démontre la chaîne complète :
//
//   Research, Script, Visual (fixtures Anthropic locales)
//   → Asset → médias locaux → Voice → Assembly
//   → rendu ffmpeg → vrai MP4 → ffprobe → Quality "rendered_video"
//
// Le smoke pipeline historique (fixture-pipeline-smoke.js) reste sans
// rendu, donc rapide. Celui-ci ne lance que quelques productions, au
// profil "preview" 640x360 : la vidéo de test dure 41,5 s. La cible de
// production 3840x2160 (profil "target") n'est pas rendue ici.
//
// Les MP4 sont écrits dans le dossier de fixtures du smoke
// (tmp/r9-media-*), jamais dans output/, et supprimés avec lui.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { inspectMediaFile } from "../src/media/probe.js";
import { verifyLocalMedia } from "../src/media/local-media.js";

import {
  verifyRenderedVideo
} from "../src/render/ffmpeg-renderer.js";

import { runQualityAgent } from "../src/agents/quality.js";

import {
  validateRenderPlanMapping,
  validateRenderReport
} from "../src/utils/validate-render-report.js";

import {
  QUALITY_CHECK_IDS,
  validateQualityReport
} from "../src/utils/validate-quality-report.js";

import {
  RENDERABLE_CLIP_COLORS,
  createMediaFixtureRoot,
  generateCanonicalMediaSet,
  generateRenderableMediaSet,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";

if (process.env.NO_API !== "1") {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1."
  );
  process.exit(1);
}

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");

const FAULT_INJECTOR = path.join(
  ROOT,
  "scripts",
  "pipeline-fault-injector.js"
);

const PROJECTS = path.join(ROOT, "projects");

const AGENTS = [
  "research",
  "script",
  "visual_director",
  "asset",
  "voice",
  "assembly",
  "quality"
];

const ARTIFACTS = [
  "research",
  "script",
  "visual",
  "assets",
  "voice",
  "assembly",
  "render",
  "quality"
];

const FINAL_STATUS =
  "research_script_visual_asset_voice_assembly_quality_pass";

let failed = 0;
let passed = 0;

const createdProductions = [];

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

function listDirectory(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).sort()
    : [];
}

function readArtifact(productionId, name) {
  const target = path.join(PROJECTS, productionId, `${name}.json`);

  return fs.existsSync(target)
    ? JSON.parse(fs.readFileSync(target, "utf8"))
    : null;
}

// Lance l'orchestrateur réel dans un processus enfant, sans aucune clé
// dans l'environnement et sous garde réseau.
function runPipeline({ args = [], fault }) {
  const env = {
    PATH: process.env.PATH,
    NO_API: "1",
    ANTHROPIC_FIXTURES: "1"
  };

  const preload = ["--import", GUARD];

  if (fault !== undefined) {
    env.PIPELINE_FAULT = fault;
    preload.push("--import", FAULT_INJECTOR);
  }

  const before = listDirectory(PROJECTS);

  const child = spawnSync(
    process.execPath,
    [...preload, "src/orchestrator/mvp.js", ...args],
    {
      cwd: ROOT,
      env,
      encoding: "utf8"
    }
  );

  const created = listDirectory(PROJECTS).filter(
    name => !before.includes(name)
  );

  createdProductions.push(...created);

  const productionId =
    child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null;

  const guardLine = child.stderr.match(
    /\[fixture-network-guard\] actif — tentatives bloquées : (\d+)/
  );

  const injectorLine = child.stderr.match(
    /\[pipeline-fault-injector\] faute (\S+) — injections : (\d+)/
  );

  const run = {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created,
    productionId,
    blockedAttempts: guardLine ? Number(guardLine[1]) : null,
    injections: injectorLine ? Number(injectorLine[2]) : null,
    files: productionId
      ? listDirectory(path.join(PROJECTS, productionId))
      : [],
    production: productionId
      ? readArtifact(productionId, "production")
      : null
  };

  for (const name of ARTIFACTS) {
    run[name] = productionId
      ? readArtifact(productionId, name)
      : null;
  }

  return run;
}

function agentState(run, id) {
  return run.production.agents.find(agent => agent.id === id);
}

// Couleur moyenne d'un carré de 2x2 pixels d'une image du MP4.
function samplePixel(file, seconds) {
  const pixel = execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v", "error",
      "-ss", String(seconds),
      "-i", file,
      "-frames:v", "1",
      "-vf", "crop=2:2:320:180,scale=1:1",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-"
    ]
  );

  return [...pixel.subarray(0, 3)];
}

const COLOR_TESTS = {
  red: ([r, g, b]) => r > 200 && g < 60 && b < 60,
  yellow: ([r, g, b]) => r > 200 && g > 200 && b < 60,
  blue: ([r, g, b]) => b > 200 && r < 60 && g < 60,
  magenta: ([r, g, b]) => r > 200 && b > 200 && g < 60,
  cyan: ([r, g, b]) => g > 200 && b > 200 && r < 60
};

const repositoryOutputBefore = listDirectory(path.join(ROOT, "output"));

const fixtureRoot = createMediaFixtureRoot();

const renderableMedia = path.join(fixtureRoot, "medias rendables");
const shortMedia = path.join(fixtureRoot, "medias trop courts");

let outputCounter = 0;

// Dossier de sortie propre à chaque production lancée par le smoke.
function outputDirectory() {
  outputCounter += 1;

  return path.join(fixtureRoot, `sortie ${outputCounter}`);
}

function renderArgs(mediaDir, outputDir, extra = []) {
  return [
    "--research-script",
    `--media-dir=${mediaDir}`,
    "--render",
    "--render-profile=preview",
    `--output-dir=${outputDir}`,
    ...extra
  ];
}

console.log("========================================");
console.log(" PIPELINE + RENDU — SMOKE (VRAI MP4, ZERO API)");
console.log("========================================");

try {
  generateRenderableMediaSet(renderableMedia);
  generateCanonicalMediaSet(shortMedia);

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 1. Pipeline complet avec rendu réel ---");

  const nominalOutput = outputDirectory();

  const nominal = runPipeline({
    args: renderArgs(renderableMedia, nominalOutput)
  });

  const videoFile = path.join(
    nominalOutput,
    `${nominal.productionId}.mp4`
  );

  console.log(
    `       projects/${nominal.productionId} — exit=${nominal.status} — ` +
    `status=${nominal.production?.status}`
  );

  await test("pipeline 1→7 + rendu : PASS, 7 agents completed, rendu completed", () => {
    assert(
      nominal.status === 0,
      `code de sortie ${nominal.status}\n${nominal.stdout}\n${nominal.stderr}`
    );

    assert(
      nominal.production.status === FINAL_STATUS,
      `status=${nominal.production.status}`
    );

    for (const id of AGENTS) {
      assert(
        agentState(nominal, id).status === "completed",
        `Agent ${id} : ${agentState(nominal, id).status}`
      );
    }

    const render = nominal.production.render;

    assert(
      render.status === "completed" &&
      render.profile === "preview" &&
      render.output_file === `${nominal.productionId}.mp4` &&
      render.started_at !== null &&
      render.completed_at !== null &&
      render.error === null,
      `production.render : ${JSON.stringify(render)}`
    );

    // Toujours 7 agents : le rendu n'est pas un huitième agent.
    assert(
      nominal.production.agents.length === 7,
      `agents : ${nominal.production.agents.length}`
    );

    assert(
      nominal.stdout.includes("Vidéo finale : RENDUE") &&
      !nominal.stdout.includes("NON RENDUE"),
      "bandeau final inattendu"
    );
  });

  await test("artefacts : 8 JSON + render.json, aucun média dans projects/", () => {
    assert(
      isDeepStrictEqual(nominal.files, [
        "assembly.json",
        "assets.json",
        "production.json",
        "quality.json",
        "render.json",
        "research.json",
        "script.json",
        "truth-report.md",
        "truth.json",
        "visual.json",
        "voice.json"
      ]),
      `fichiers : ${nominal.files}`
    );
  });

  await test("un vrai MP4 existe : H.264, AAC, 640x360, 30 images/s, 41,5 s à ±0,2 s", async () => {
    assert(
      fs.existsSync(videoFile) && fs.statSync(videoFile).size > 1000,
      `vidéo absente ou vide : ${videoFile}`
    );

    // Sondage indépendant : le fichier lui-même, pas son extension.
    const probed = await inspectMediaFile(videoFile);

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
      probed.streams.length === 2 &&
      Math.abs(probed.duration_seconds - 41.5) <= 0.2,
      `relevé inattendu : ${JSON.stringify(probed)}`
    );

    for (const stream of probed.streams) {
      assert(
        Math.abs(stream.duration_seconds - 41.5) <= 0.2,
        `flux ${stream.type} : ${stream.duration_seconds}s`
      );
    }
  });

  await test("render.json : contrat validé, fidèle au plan, calé sur la voix", () => {
    const { render, assembly } = nominal;

    assert(
      render.stage === "render" &&
      render.mode === "test" &&
      render.usage === null &&
      render.validation.valid === true &&
      render.data.status === "rendered" &&
      render.data.profile === "preview" &&
      render.data.output.path === `${nominal.productionId}.mp4`,
      "enveloppe render.json inattendue"
    );

    const report = validateRenderReport(render.data);
    const mapping = validateRenderPlanMapping(
      render.data,
      assembly.data
    );

    assert(
      report.valid && mapping.valid,
      [...report.errors, ...mapping.errors].join(" | ")
    );

    // Unité 1 : 20 s mesurées = 20 s prévues. Unité 2 : 21,5 s
    // mesurées pour 20 s prévues → clips de 12 s et 8 s recalés.
    assert(
      isDeepStrictEqual(
        render.data.video_track.map(clip => clip.duration_seconds),
        [8, 7, 5, 12.9, 8.6]
      ) &&
      isDeepStrictEqual(
        render.data.audio_track.map(unit => unit.duration_seconds),
        [20, 21.5]
      ) &&
      isDeepStrictEqual(render.data.summary, {
        total_clips: 5,
        total_units: 2,
        planned_duration_seconds: 40,
        rendered_duration_seconds: 41.5
      }),
      `timeline : ${JSON.stringify(render.data.summary)}`
    );
  });

  await test("assembly.json reste un plan : unrendered, 40 s prévues", () => {
    assert(
      nominal.assembly.data.status === "unrendered" &&
      nominal.assembly.data.summary.total_duration_seconds === 40,
      "le plan de montage a été modifié par le rendu"
    );
  });

  await test("ordre des 5 clips prouvé dans l'image du MP4", () => {
    nominal.render.data.video_track.forEach((clip, index) => {
      const middle = (clip.start_seconds + clip.end_seconds) / 2;
      const color = RENDERABLE_CLIP_COLORS[index];
      const pixel = samplePixel(videoFile, middle);

      assert(
        COLOR_TESTS[color](pixel),
        `${clip.asset_id} à ${middle}s : ${color} attendu, pixel ${pixel}`
      );
    });
  });

  await test("Quality : scope rendered_video, final_video rendered, 12 contrôles", () => {
    const { quality } = nominal;

    assert(
      validateQualityReport(quality.data).valid,
      validateQualityReport(quality.data).errors.join(" | ")
    );

    assert(
      isDeepStrictEqual(quality.data.media, {
        scope: "rendered_video",
        final_video: "rendered",
        assets_inspected: 5,
        narration_units_inspected: 2,
        estimated_narration_seconds: 40,
        measured_narration_seconds: 41.5,
        rendered_duration_seconds: 41.5,
        render_profile: "preview"
      }),
      `media : ${JSON.stringify(quality.data.media)}`
    );

    assert(
      isDeepStrictEqual(
        quality.data.checks.map(check => check.id),
        [...QUALITY_CHECK_IDS, "media_files", "final_video"]
      ) &&
      quality.data.checks.every(
        check => check.valid && check.errors.length === 0
      ) &&
      quality.data.verdict === "pass",
      "contrôles Quality inattendus"
    );

    assert(
      quality.data.warnings.includes(
        "vidéo rendue au profil preview 640x360, inférieur à la cible 3840x2160 — non bloquant en mode test"
      ),
      `warnings : ${JSON.stringify(quality.data.warnings)}`
    );
  });

  await test("dossier de travail supprimé, output/ du dépôt intact, zéro réseau", () => {
    assert(
      !fs.existsSync(
        path.join(ROOT, "tmp", `render-${nominal.productionId}`)
      ),
      "dossier de travail du rendu encore présent"
    );

    assert(
      isDeepStrictEqual(
        listDirectory(path.join(ROOT, "output")),
        repositoryOutputBefore
      ),
      "output/ du dépôt modifié"
    );

    assert(
      isDeepStrictEqual(listDirectory(nominalOutput), [
        `${nominal.productionId}.mp4`
      ]),
      `sortie : ${listDirectory(nominalOutput)}`
    );

    assert(
      nominal.blockedAttempts === 0,
      `tentatives réseau bloquées : ${nominal.blockedAttempts}`
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 2. Quality sur la vidéo rendue (agent pur) ---");

  const target = nominal.production.target;

  function artifacts() {
    return structuredClone({
      research: nominal.research,
      script: nominal.script,
      visual: nominal.visual,
      assets: nominal.assets,
      voice: nominal.voice,
      assembly: nominal.assembly,
      render: nominal.render
    });
  }

  const mediaVerification = await verifyLocalMedia({
    mediaDir: renderableMedia,
    assets: nominal.assets.data,
    voice: nominal.voice.data
  });

  const renderVerification = await verifyRenderedVideo({
    outputDir: nominalOutput,
    render: nominal.render,
    assembly: nominal.assembly.data
  });

  await test("recontrôles indépendants valides ; l'audit rejoué donne le même rapport", async () => {
    assert(
      mediaVerification.valid && renderVerification.valid,
      [...mediaVerification.errors, ...renderVerification.errors].join(" | ")
    );

    const replay = await runQualityAgent({
      artifacts: artifacts(),
      target,
      testMode: true,
      mediaVerification,
      renderVerification
    });

    assert(
      isDeepStrictEqual(replay, nominal.quality),
      "l'audit rejoué diffère du quality.json persisté"
    );
  });

  // Copie altérée de la vidéo, pour un recontrôle en échec.
  const alteredOutput = path.join(fixtureRoot, "sortie alteree");

  fs.mkdirSync(alteredOutput);
  fs.copyFileSync(
    videoFile,
    path.join(alteredOutput, `${nominal.productionId}.mp4`)
  );
  fs.appendFileSync(
    path.join(alteredOutput, `${nominal.productionId}.mp4`),
    "altération après le rendu"
  );

  const alteredVerification = await verifyRenderedVideo({
    outputDir: alteredOutput,
    render: nominal.render,
    assembly: nominal.assembly.data
  });

  const emptyOutput = path.join(fixtureRoot, "sortie vide");

  fs.mkdirSync(emptyOutput);

  const missingVerification = await verifyRenderedVideo({
    outputDir: emptyOutput,
    render: nominal.render,
    assembly: nominal.assembly.data
  });

  const qualityFailures = [
    [
      "vidéo modifiée après le rendu",
      input => {
        input.renderVerification = alteredVerification;
      },
      "[final_video]",
      "vidéo rendue modifiée depuis le rendu"
    ],
    [
      "vidéo supprimée après le rendu",
      input => {
        input.renderVerification = missingVerification;
      },
      "[final_video]",
      "Renderer : vidéo rendue absente"
    ],
    [
      "render.json présent sans recontrôle de la vidéo",
      input => {
        delete input.renderVerification;
      },
      "[envelopes]",
      "render.json: artefact fourni sans contrôle de la vidéo rendue"
    ],
    [
      "recontrôle fourni sans render.json",
      input => {
        delete input.artifacts.render;
      },
      "[final_video]",
      "render.json: artefact absent ou invalide"
    ],
    [
      "recontrôle d'un autre périmètre",
      input => {
        input.renderVerification = {
          ...input.renderVerification,
          scope: "local_media"
        };
      },
      "[final_video]",
      "rapport de contrôle de la vidéo rendue absent ou invalide"
    ],
    [
      "vidéo contrôlée différente de celle de render.json",
      input => {
        input.artifacts.render.data.output.sha256 = "0".repeat(64);
      },
      "[final_video]",
      "vidéo contrôlée sur disque différente de celle décrite par render.json"
    ],
    [
      "render.json prétendu non rendu",
      input => {
        input.artifacts.render.data.status = "unrendered";
      },
      "[final_video]",
      'render.json: status doit être "rendered"'
    ],
    [
      "render.json : validation persistée en échec",
      input => {
        input.artifacts.render.validation.valid = false;
      },
      "[final_video]",
      "render.json: validation n'est pas un PASS persisté"
    ],
    [
      "render.json : titre divergent",
      input => {
        input.artifacts.render.data.title = "Un autre titre";
      },
      "[final_video]",
      "render.json: title différent de script.json"
    ],
    [
      "render.json : clips dans un autre ordre que le plan",
      input => {
        input.artifacts.render.data.video_track.reverse();
      },
      "[final_video]",
      "render.json: clips rendus différents du plan de montage"
    ],
    [
      "render.json : durée rendue plus courte que la narration",
      input => {
        input.artifacts.render.data.summary
          .rendered_duration_seconds = 40;
      },
      "[final_video]",
      "render.json: durée rendue 40s incohérente avec la narration mesurée 41.5s"
    ],
    [
      "render.json : durée du fichier loin de la timeline",
      input => {
        input.artifacts.render.data.output.duration_seconds = 45;
      },
      "[final_video]",
      "render.json: durée du fichier 45s à plus de 0.2s de la timeline 41.5s"
    ],
    [
      "render.json : profil target mais dimensions réduites",
      input => {
        input.artifacts.render.data.profile = "target";
      },
      "[final_video]",
      "render.json: dimensions 640x360 différentes de la cible 3840x2160"
    ],
    [
      "render.json : champ d'enveloppe inconnu",
      input => {
        input.artifacts.render.command = "ffmpeg";
      },
      "[final_video]",
      "render.json: champ command non autorisé"
    ],
    [
      "médias non recontrôlés alors qu'une vidéo est rendue",
      input => {
        delete input.mediaVerification;
      },
      "[media_files]",
      "rapport de vérification média absent ou invalide"
    ]
  ];

  for (const [name, mutate, check, detail] of qualityFailures) {
    await test(`Quality → FAIL — ${name}`, async () => {
      const input = {
        artifacts: artifacts(),
        target,
        testMode: true,
        mediaVerification: structuredClone(mediaVerification),
        renderVerification: structuredClone(renderVerification)
      };

      mutate(input);

      const error = await expectReject(
        () => runQualityAgent(input),
        /^Quality Agent : audit rejeté\./
      );

      assert(
        error.message
          .split(" || ")
          .some(
            block =>
              block.includes(`${check} `) && block.includes(detail)
          ),
        `contrôle ${check} attendu avec « ${detail} » — obtenu : ${error.message}`
      );
    });
  }

  await test("Quality → FAIL — rendu preview refusé en mode complet", async () => {
    const error = await expectReject(
      () => runQualityAgent({
        artifacts: artifacts(),
        target,
        testMode: false,
        mediaVerification,
        renderVerification
      }),
      /^Quality Agent : audit rejeté\./
    );

    assert(
      error.message.includes(
        "vidéo rendue au profil preview 640x360, inférieur à la cible 3840x2160 — refusé en mode complet"
      ),
      `erreur inattendue : ${error.message}`
    );
  });

  const reportCases = [
    [
      "périmètre rendered_video mais final_video not_rendered",
      report => {
        report.media.final_video = "not_rendered";
      },
      /media: final_video doit être "rendered"/
    ],
    [
      "périmètre local_media annonçant une vidéo rendue",
      report => {
        report.media = {
          scope: "local_media",
          final_video: "rendered",
          assets_inspected: 5,
          narration_units_inspected: 2,
          estimated_narration_seconds: 40,
          measured_narration_seconds: 41.5
        };
      },
      /media: final_video doit être "not_rendered"/
    ],
    [
      "périmètre contracts_only annonçant une vidéo rendue",
      report => {
        report.media = {
          scope: "contracts_only",
          final_video: "rendered"
        };
      },
      /media: final_video doit être "not_rendered"/
    ],
    [
      "périmètre rendered_video sans le contrôle final_video",
      report => {
        report.checks.pop();
      },
      /checks ne contient pas exactement les contrôles attendus/
    ],
    [
      "profil de rendu inconnu",
      report => {
        report.media.render_profile = "ultra";
      },
      /media: render_profile invalide/
    ],
    [
      "durée rendue absente",
      report => {
        delete report.media.rendered_duration_seconds;
      },
      /media: champ rendered_duration_seconds manquant/
    ],
    [
      "chemin de vidéo injecté dans le rapport",
      report => {
        report.media.final_video_path = "output/final.mp4";
      },
      /media: champ final_video_path non autorisé/
    ]
  ];

  for (const [name, mutate, pattern] of reportCases) {
    await test(`rapport Quality altéré → FAIL — ${name}`, () => {
      const report = structuredClone(nominal.quality.data);

      mutate(report);

      const verdict = validateQualityReport(report);

      assert(verdict.valid === false, "FAIL attendu, PASS obtenu");

      assert(
        verdict.errors.some(error => pattern.test(error)),
        `erreur attendue ${pattern} — obtenu : ${verdict.errors.join(" | ")}`
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 3. Échecs de rendu dans le pipeline ---");

  // Agents 1 à 6 completed, rendu failed, Quality jamais démarré,
  // aucun render.json, aucun quality.json, aucun MP4.
  function assertRenderFailed(run, outputDir, pattern) {
    assert(
      run.status === 1,
      `code de sortie ${run.status} (1 attendu)\n${run.stdout}`
    );

    assert(
      run.production.status === "failed",
      `status=${run.production.status}`
    );

    for (const id of AGENTS.slice(0, 6)) {
      assert(
        agentState(run, id).status === "completed",
        `Agent ${id} : ${agentState(run, id).status}`
      );
    }

    const quality = agentState(run, "quality");

    assert(
      quality.status === "pending" && quality.started_at === null,
      `Quality ne doit pas démarrer (${quality.status})`
    );

    const render = run.production.render;

    assert(
      render.status === "failed" && pattern.test(render.error ?? ""),
      `production.render : ${render.status} — ${render.error}`
    );

    assert(
      run.render === null && run.quality === null,
      "render.json ou quality.json ne doit pas exister"
    );

    assert(
      listDirectory(outputDir).length === 0,
      `un fichier a été laissé dans la sortie : ${listDirectory(outputDir)}`
    );

    assert(
      !fs.existsSync(
        path.join(ROOT, "tmp", `render-${run.productionId}`)
      ),
      "dossier de travail du rendu encore présent"
    );

    assert(
      run.blockedAttempts === 0,
      `tentatives réseau bloquées : ${run.blockedAttempts}`
    );
  }

  await test("vidéo source trop courte après calage → rendu failed, Quality ne démarre pas", () => {
    const outputDir = outputDirectory();

    // Jeu R9 : vidéo de 12 s pour un besoin recalé de 12,9 s.
    const run = runPipeline({
      args: renderArgs(shortMedia, outputDir)
    });

    assertRenderFailed(
      run,
      outputDir,
      /^Render Timeline : vidéo source trop courte pour le clip s02-g01-sh01 : 12s disponibles, 12\.9s nécessaires après calage sur la voix/
    );
  });

  // Copies du jeu rendable, altérées par l'injecteur de fautes au
  // moment où le rendu relit assembly.json, donc après Assembly.
  function faultyMedia(name) {
    const directory = path.join(fixtureRoot, name);

    fs.cpSync(renderableMedia, directory, { recursive: true });

    return directory;
  }

  await test("asset supprimé entre Assembly et le rendu → rendu failed", () => {
    const outputDir = outputDirectory();

    const run = runPipeline({
      args: renderArgs(faultyMedia("medias asset supprime"), outputDir),
      fault: "media-asset-deleted-before-quality"
    });

    assert(run.injections === 1, `injections : ${run.injections}`);

    assertRenderFailed(
      run,
      outputDir,
      /^Renderer : plan de montage incohérent avec ses sources\. vérification disque des médias en échec — assets\[4\]: Local Media : fichier média absent \(assets\/s02-g01-sh02\.mp4\)/
    );
  });

  await test("audio modifié entre Assembly et le rendu → rendu failed", () => {
    const outputDir = outputDirectory();

    const run = runPipeline({
      args: renderArgs(faultyMedia("medias audio modifie"), outputDir),
      fault: "media-voice-modified-before-quality"
    });

    assert(run.injections === 1, `injections : ${run.injections}`);

    assertRenderFailed(
      run,
      outputDir,
      /^Renderer : plan de montage incohérent avec ses sources\. vérification disque des médias en échec — narration_units\[1\]: média modifié depuis l'inspection \(voice\/s02-g01\.mp3/
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 4. Options de rendu refusées avant toute production ---");

  const refusedOptions = [
    [
      "--render sans --media-dir",
      ["--research-script", "--render"],
      /--render exige --media-dir=<dossier>/
    ],
    [
      "--render sans --research-script",
      ["--dry-run", "--render", `--media-dir=${renderableMedia}`],
      /--render exige --research-script/
    ],
    [
      "--render-profile inconnu",
      renderArgs(renderableMedia, path.join(fixtureRoot, "refus")).map(
        value =>
          value.startsWith("--render-profile")
            ? "--render-profile=ultra"
            : value
      ),
      /--render-profile inconnu "ultra"/
    ],
    [
      "--render-profile sans --render",
      [
        "--research-script",
        `--media-dir=${renderableMedia}`,
        "--render-profile=preview"
      ],
      /--render-profile et --output-dir exigent --render/
    ],
    [
      "--output-dir sans --render",
      [
        "--research-script",
        `--media-dir=${renderableMedia}`,
        `--output-dir=${path.join(fixtureRoot, "refus")}`
      ],
      /--render-profile et --output-dir exigent --render/
    ]
  ];

  for (const [name, args, pattern] of refusedOptions) {
    await test(`option refusée — ${name}`, () => {
      const run = runPipeline({ args });

      assert(
        run.status !== 0 && pattern.test(run.stderr),
        `exit=${run.status} — ${run.stderr.slice(0, 300)}`
      );

      // Rejet avant la création de la production : rien sur le disque.
      assert(
        run.created.length === 0,
        `production créée : ${run.created}`
      );
    });
  }

  await test("le smoke n'a rien écrit dans output/ ni laissé dans tmp/", () => {
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
} finally {
  // Le smoke ne supprime que le dossier de fixtures qu'il a créé,
  // MP4 de test compris.
  removeMediaFixtureRoot(fixtureRoot);
}

console.log("");
console.log("Productions créées par cette exécution :");

for (const name of createdProductions) {
  console.log(`  projects/${name}`);
}

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API réelle utilisée : NON");
console.log("MP4 réel rendu par le pipeline : OUI (profil preview, supprimé après le test)");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — pipeline avec rendu"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — pipeline local 1→7 avec rendu : vrai MP4 sondé, Quality rendered_video, zéro API"
);

process.exit(0);
