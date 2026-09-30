// Smoke du gate FIRST REAL VIDEO — zéro API, zéro réseau.
//
// Usage :
//   NO_API=1 node scripts/first-real-video-smoke.js
//
// Lance scripts/first-real-video.js dans des dossiers ISOLÉS
// (tmp/r9-media-*), au profil "preview" 640x360 pour rester rapide.
// Il ne touche jamais au livrable réel output/FIRST_REAL_VIDEO.mp4 :
// le rendu 4K du livrable n'est fait que par le gate lui-même, lancé
// sans option.
//
// Le smoke ne supprime que le dossier de fixtures qu'il a créé.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { inspectMediaFile } from "../src/media/probe.js";

import {
  outputNameError
} from "../src/utils/validate-render-report.js";

import {
  FIRST_REAL_VIDEO_NAME,
  FIRST_REAL_VIDEO_STATUS,
  checkFirstRealVideo,
  evaluateFirstRealVideo
} from "./first-real-video.js";

import {
  copyMediaSet,
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

const GATE = path.join(ROOT, "scripts", "first-real-video.js");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");
const PROJECTS = path.join(ROOT, "projects");

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

function listDirectory(directory) {
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).sort()
    : [];
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function readArtifact(productionId, name) {
  const target = path.join(PROJECTS, productionId, `${name}.json`);

  return fs.existsSync(target)
    ? JSON.parse(fs.readFileSync(target, "utf8"))
    : null;
}

function spawnNode(args, env) {
  const before = listDirectory(PROJECTS);

  const child = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });

  const created = listDirectory(PROJECTS).filter(
    name => !before.includes(name)
  );

  createdProductions.push(...created);

  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    created
  };
}

// Lance le gate, toujours au profil preview et dans un dossier isolé.
function runGate({
  outputDir,
  mediaDir,
  profile = "preview",
  extraArgs = [],
  env
}) {
  const args = [GATE, `--profile=${profile}`, `--output-dir=${outputDir}`];

  if (mediaDir) {
    args.push(`--media-dir=${mediaDir}`);
  }

  const run = spawnNode(
    [...args, ...extraArgs],
    env ?? {
      PATH: process.env.PATH,
      NO_API: "1"
    }
  );

  run.productionId =
    run.stdout.match(/^Production\s+: (prod-\S+)$/m)?.[1] ?? null;

  run.output = path.join(outputDir, FIRST_REAL_VIDEO_NAME);

  return run;
}

// Lance l'orchestrateur directement, pour l'option --output-name.
function runOrchestrator(args) {
  return spawnNode(
    ["--import", GUARD, "src/orchestrator/mvp.js", ...args],
    {
      PATH: process.env.PATH,
      NO_API: "1",
      ANTHROPIC_FIXTURES: "1"
    }
  );
}

// Dossier ne contenant qu'un lien vers l'outil voulu : PATH sans
// l'autre outil, sans toucher au code de production.
function toolOnlyPath(directory, tool) {
  const source = process.env.PATH
    .split(path.delimiter)
    .map(entry => path.join(entry, tool))
    .find(candidate => fs.existsSync(candidate));

  assert(source, `${tool} introuvable dans le PATH du smoke`);

  fs.mkdirSync(directory);
  fs.symlinkSync(source, path.join(directory, tool));

  return directory;
}

const repositoryOutputBefore = listDirectory(path.join(ROOT, "output"));
const tmpBefore = listDirectory(path.join(ROOT, "tmp"));

const fixtureRoot = createMediaFixtureRoot();

let outputCounter = 0;

function outputDirectory() {
  outputCounter += 1;

  return path.join(fixtureRoot, `sortie ${outputCounter}`);
}

console.log("========================================");
console.log(" FIRST REAL VIDEO — SMOKE DU GATE (ZERO API)");
console.log("========================================");

try {
  const renderable = generateRenderableMediaSet(
    path.join(fixtureRoot, "medias rendables")
  );

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 1. Gate nominal (profil preview, dossier isolé) ---");

  const firstOutput = outputDirectory();
  const first = runGate({ outputDir: firstOutput });

  let firstProbe = null;

  await test("le gate sort en 0 et annonce PASS", () => {
    assert(
      first.status === 0,
      `code de sortie ${first.status}\n${first.stdout}\n${first.stderr}`
    );

    assert(
      first.stdout.includes("FIRST REAL VIDEO GATE : PASS") &&
      first.stdout.includes("API réelle utilisée : NON"),
      "bilan final inattendu"
    );
  });

  await test("FIRST_REAL_VIDEO.mp4 existe, n'est pas vide, et ffprobe le lit", async () => {
    assert(
      fs.existsSync(first.output) &&
      fs.statSync(first.output).size > 1000,
      `sortie absente ou vide : ${first.output}`
    );

    // Sondage indépendant du gate : ffprobe sort en 0 sur le fichier.
    firstProbe = await inspectMediaFile(first.output);

    assert(
      firstProbe.kind === "video" &&
      firstProbe.container.split(",").includes("mp4"),
      `relevé inattendu : ${JSON.stringify(firstProbe)}`
    );
  });

  await test("un flux vidéo H.264 640x360 à 30 images/s, un flux audio AAC 48 kHz stéréo", () => {
    const video = firstProbe.streams.filter(
      stream => stream.type === "video"
    );

    const audio = firstProbe.streams.filter(
      stream => stream.type === "audio"
    );

    assert(
      firstProbe.streams.length === 2 &&
      video.length === 1 &&
      audio.length === 1 &&
      firstProbe.video_codec === "h264" &&
      firstProbe.audio_codec === "aac" &&
      firstProbe.width === 640 &&
      firstProbe.height === 360 &&
      firstProbe.fps === 30 &&
      audio[0].sample_rate === 48000 &&
      audio[0].channels === 2,
      `flux inattendus : ${JSON.stringify(firstProbe.streams)}`
    );
  });

  await test("durée 41,5 s à ±0,2 s, fichier et flux", () => {
    assert(
      Math.abs(firstProbe.duration_seconds - 41.5) <= 0.2 &&
      firstProbe.streams.every(
        stream => Math.abs(stream.duration_seconds - 41.5) <= 0.2
      ),
      `durées : ${firstProbe.duration_seconds}s — ${JSON.stringify(
        firstProbe.streams.map(stream => stream.duration_seconds)
      )}`
    );
  });

  await test("pipeline fermé : 7 agents completed, rendu completed, status final", () => {
    const production = readArtifact(first.productionId, "production");

    assert(production, "production.json introuvable");

    assert(
      production.status === FIRST_REAL_VIDEO_STATUS &&
      production.agents.length === 7 &&
      production.agents.every(
        agent => agent.status === "completed"
      ) &&
      production.render.status === "completed" &&
      production.render.profile === "preview" &&
      production.render.output_file === FIRST_REAL_VIDEO_NAME,
      `production : ${production.status} — ${JSON.stringify(production.render)}`
    );
  });

  await test("render.json référence le fichier réellement produit", () => {
    const render = readArtifact(first.productionId, "render");

    assert(
      render.validation.valid === true &&
      render.data.status === "rendered" &&
      render.data.output.path === FIRST_REAL_VIDEO_NAME &&
      render.data.output.size_bytes ===
        fs.statSync(first.output).size &&
      render.data.output.sha256 === sha256(first.output) &&
      render.data.summary.rendered_duration_seconds === 41.5,
      `render.json : ${JSON.stringify(render.data.output)}`
    );
  });

  await test("Quality : rendered_video / rendered, verdict pass", () => {
    const quality = readArtifact(first.productionId, "quality");

    assert(
      quality.validation.valid === true &&
      quality.data.verdict === "pass" &&
      quality.data.media.scope === "rendered_video" &&
      quality.data.media.final_video === "rendered" &&
      quality.data.checks.every(check => check.valid === true),
      `quality.json : ${JSON.stringify(quality.data.media)}`
    );
  });

  await test("zéro réseau, médias temporaires supprimés, audio annoncé comme son de test", () => {
    assert(
      /Garde réseau\s+: 0 tentative\(s\) bloquée\(s\)/.test(first.stdout),
      "bilan du garde réseau inattendu"
    );

    assert(
      /Médias de test\s+: supprimés/.test(first.stdout),
      "les médias temporaires du gate n'ont pas été supprimés"
    );

    // Seul le dossier de fixtures du smoke reste dans tmp/.
    assert(
      isDeepStrictEqual(
        listDirectory(path.join(ROOT, "tmp")),
        [...tmpBefore, path.basename(fixtureRoot)].sort()
      ),
      `tmp/ : ${listDirectory(path.join(ROOT, "tmp"))}`
    );

    assert(
      first.stdout.includes("son sinusoïdal de test — PAS une narration") &&
      !/elevenlabs/i.test(first.stdout),
      "la nature de l'audio n'est pas annoncée correctement"
    );
  });

  await test("seul le MP4 est écrit dans le dossier de sortie", () => {
    assert(
      isDeepStrictEqual(
        listDirectory(firstOutput),
        [FIRST_REAL_VIDEO_NAME]
      ),
      `sortie : ${listDirectory(firstOutput)}`
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 2. Reproductibilité ---");

  const secondOutput = outputDirectory();
  const second = runGate({ outputDir: secondOutput });

  await test("deux exécutions isolées : même timeline, mêmes caractéristiques", async () => {
    assert(second.status === 0, `code de sortie ${second.status}`);

    const firstRender = readArtifact(first.productionId, "render");
    const secondRender = readArtifact(second.productionId, "render");

    const comparable = render => ({
      ...render.data,
      output: {
        ...render.data.output,
        size_bytes: null,
        sha256: null
      }
    });

    assert(
      first.productionId !== second.productionId &&
      isDeepStrictEqual(
        comparable(firstRender),
        comparable(secondRender)
      ),
      "les deux rendus diffèrent logiquement"
    );

    const secondProbe = await inspectMediaFile(second.output);

    for (const key of [
      "kind",
      "container",
      "width",
      "height",
      "fps",
      "video_codec",
      "audio_codec",
      "sample_rate",
      "channels",
      "duration_seconds"
    ]) {
      assert(
        secondProbe[key] === firstProbe[key],
        `${key} : ${secondProbe[key]} au lieu de ${firstProbe[key]}`
      );
    }
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 3. Fail closed : le gate refuse et ne produit rien ---");

  await test("sortie déjà présente → refus, fichier intact, aucun pipeline lancé", () => {
    const before = sha256(first.output);
    const run = runGate({ outputDir: firstOutput });

    assert(
      run.status === 1 &&
      run.stderr.includes("la sortie existe déjà") &&
      run.stderr.includes("FIRST REAL VIDEO GATE : FAIL"),
      `exit=${run.status} — ${run.stderr.slice(0, 300)}`
    );

    assert(
      sha256(first.output) === before &&
      isDeepStrictEqual(
        listDirectory(firstOutput),
        [FIRST_REAL_VIDEO_NAME]
      ),
      "le fichier existant a été modifié, renommé ou supprimé"
    );

    assert(
      run.created.length === 0,
      `un pipeline a été lancé : ${run.created}`
    );
  });

  // Jeux de médias fournis au gate, donc jamais supprimés par lui.
  const missingMedia = copyMediaSet(
    renderable,
    path.join(fixtureRoot, "medias asset manquant")
  );

  fs.rmSync(path.join(missingMedia, "assets", "s01-g01-sh02.png"));

  const unreadableMedia = copyMediaSet(
    renderable,
    path.join(fixtureRoot, "medias asset illisible")
  );

  fs.truncateSync(
    path.join(unreadableMedia, "assets", "s02-g01-sh01.mp4"),
    600
  );

  const shortMedia = generateCanonicalMediaSet(
    path.join(fixtureRoot, "medias trop courts")
  );

  const mediaFailures = [
    [
      "média manquant",
      missingMedia,
      /média local manquant pour s01-g01-sh02/
    ],
    [
      "média illisible",
      unreadableMedia,
      /fichier illisible par ffprobe/
    ],
    [
      "vidéo source trop courte",
      shortMedia,
      /vidéo source trop courte pour le clip s02-g01-sh01/
    ]
  ];

  for (const [name, mediaDir, pattern] of mediaFailures) {
    await test(`${name} → gate FAIL, aucun MP4`, () => {
      const outputDir = outputDirectory();
      const run = runGate({ outputDir, mediaDir });

      assert(
        run.status === 1 &&
        pattern.test(run.stderr) &&
        run.stderr.includes("FIRST REAL VIDEO GATE : FAIL"),
        `exit=${run.status} — ${run.stderr.slice(0, 400)}`
      );

      assert(
        !fs.existsSync(run.output),
        "un MP4 a été laissé malgré l'échec"
      );

      // Un dossier fourni par l'appelant n'est jamais supprimé.
      assert(
        fs.existsSync(mediaDir) &&
        /Médias de test\s+: fournis par l'appelant, conservés/.test(
          run.stdout
        ),
        "le dossier média fourni a été supprimé par le gate"
      );
    });
  }

  const preconditionFailures = [
    [
      "ffmpeg indisponible",
      () => ({
        mediaDir: renderable,
        env: {
          PATH: toolOnlyPath(
            path.join(fixtureRoot, "bin ffprobe seul"),
            "ffprobe"
          ),
          NO_API: "1"
        }
      }),
      /ffmpeg indisponible dans le PATH/
    ],
    [
      "ffprobe indisponible",
      () => ({
        mediaDir: renderable,
        env: {
          PATH: toolOnlyPath(
            path.join(fixtureRoot, "bin ffmpeg seul"),
            "ffmpeg"
          ),
          NO_API: "1"
        }
      }),
      /ffprobe indisponible dans le PATH/
    ],
    [
      "NO_API absent",
      () => ({
        env: { PATH: process.env.PATH }
      }),
      /NO_API=1 est obligatoire pour ce gate/
    ],
    [
      "profil inconnu",
      () => ({
        profile: "ultra"
      }),
      /profil inconnu "ultra"/
    ],
    [
      "option donnée deux fois",
      () => ({
        extraArgs: ["--profile=target"]
      }),
      /Option en double : --profile=/
    ],
    [
      "dossier média introuvable",
      () => ({
        mediaDir: path.join(fixtureRoot, "medias absents")
      }),
      /dossier média introuvable/
    ],
    [
      "option inconnue (aucun --force)",
      () => ({
        extraArgs: ["--force"]
      }),
      /Option inconnue : --force/
    ]
  ];

  for (const [name, options, pattern] of preconditionFailures) {
    await test(`${name} → gate FAIL avant tout pipeline`, () => {
      const outputDir = outputDirectory();
      const run = runGate({ outputDir, ...options() });

      assert(
        run.status === 1 &&
        pattern.test(run.stderr) &&
        run.stderr.includes("FIRST REAL VIDEO GATE : FAIL"),
        `exit=${run.status} — ${run.stderr.slice(0, 400)}`
      );

      assert(
        !fs.existsSync(run.output) && run.created.length === 0,
        "un pipeline a été lancé ou un MP4 laissé"
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 4. Vérification indépendante de la sortie ---");

  const checkOptions = outputDir => ({
    outputDir,
    productionId: first.productionId,
    profileName: "preview",
    childStatus: 0,
    blockedAttempts: 0
  });

  await test("sortie intacte → aucune erreur", async () => {
    const result = await checkFirstRealVideo(checkOptions(firstOutput));

    assert(
      result.errors.length === 0,
      result.errors.join(" | ")
    );
  });

  // Copies altérées de la vraie sortie, dans des dossiers du smoke.
  function alteredOutput(name, build) {
    const directory = path.join(fixtureRoot, name);

    fs.mkdirSync(directory);
    build?.(path.join(directory, FIRST_REAL_VIDEO_NAME));

    return directory;
  }

  const ffmpeg = args =>
    execFileSync(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-y", ...args],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

  const outputFailures = [
    [
      "sortie absente",
      () => alteredOutput("verif sortie absente"),
      /FIRST_REAL_VIDEO\.mp4 absent ou non sondable par ffprobe/
    ],
    [
      "sortie corrompue (ffprobe en échec)",
      () => alteredOutput("verif sortie corrompue", file => {
        fs.writeFileSync(file, "ceci n'est pas un MP4");
      }),
      /FIRST_REAL_VIDEO\.mp4 absent ou non sondable par ffprobe/
    ],
    [
      "sortie modifiée après le rendu",
      () => alteredOutput("verif sortie modifiee", file => {
        fs.copyFileSync(first.output, file);
        fs.appendFileSync(file, "altération");
      }),
      /recontrôle de la vidéo rendue en échec — .*vidéo rendue modifiée depuis le rendu/
    ],
    [
      "durée incohérente",
      () => alteredOutput("verif duree", file => {
        ffmpeg(["-i", first.output, "-t", "10", "-c", "copy", file]);
      }),
      /FIRST_REAL_VIDEO\.mp4 : durée 10(\.\d+)?s à plus de 0\.2s de la durée attendue 41\.5s/
    ],
    [
      "résolution incohérente",
      () => alteredOutput("verif resolution", file => {
        ffmpeg([
          "-i", first.output,
          "-vf", "scale=320:180",
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-c:a", "copy",
          file
        ]);
      }),
      /FIRST_REAL_VIDEO\.mp4 : dimensions 320x180 au lieu de 640x360/
    ],
    [
      "flux vidéo absent",
      () => alteredOutput("verif sans video", file => {
        ffmpeg(["-i", first.output, "-vn", "-c:a", "copy", file]);
      }),
      /FIRST_REAL_VIDEO\.mp4 : aucun flux vidéo dans la sortie/
    ],
    [
      "flux audio absent",
      () => alteredOutput("verif sans audio", file => {
        ffmpeg(["-i", first.output, "-an", "-c:v", "copy", file]);
      }),
      /FIRST_REAL_VIDEO\.mp4 : aucun flux audio dans la sortie/
    ]
  ];

  for (const [name, build, pattern] of outputFailures) {
    await test(`${name} → vérification en échec`, async () => {
      const result = await checkFirstRealVideo(checkOptions(build()));

      assert(
        result.errors.some(error => pattern.test(error)),
        `erreur attendue ${pattern} — obtenu : ${result.errors.join(" | ")}`
      );
    });
  }

  // Verdict pur du gate, sur les vrais artefacts de l'exécution
  // nominale puis sur des variantes.
  const nominal = await checkFirstRealVideo(checkOptions(firstOutput));

  function verdictInput() {
    return structuredClone({
      childStatus: 0,
      blockedAttempts: 0,
      production: nominal.production,
      assembly: readArtifact(first.productionId, "assembly"),
      render: nominal.render,
      quality: nominal.quality,
      probed: nominal.probed,
      verification: nominal.verification,
      profileName: "preview"
    });
  }

  const verdictFailures = [
    [
      "pipeline sorti en erreur",
      input => {
        input.childStatus = 1;
      },
      /pipeline terminé avec le code 1/
    ],
    [
      "tentative réseau bloquée",
      input => {
        input.blockedAttempts = 2;
      },
      /2 tentative\(s\) réseau bloquée\(s\)/
    ],
    [
      "bilan du garde réseau absent",
      input => {
        input.blockedAttempts = null;
      },
      /bilan du garde réseau absent/
    ],
    [
      "status final incorrect",
      input => {
        input.production.status = "failed";
      },
      /status de production : failed/
    ],
    [
      "un agent non terminé",
      input => {
        input.production.agents[6].status = "pending";
      },
      /agent quality : pending/
    ],
    [
      "rendu en échec",
      input => {
        input.production.render.status = "failed";
        input.production.render.error = "ffmpeg a échoué";
      },
      /rendu : failed — ffmpeg a échoué/
    ],
    [
      "production.json absent",
      input => {
        input.production = null;
      },
      /production\.json absent ou illisible/
    ],
    [
      "render.json absent",
      input => {
        input.render = null;
      },
      /render\.json absent ou illisible/
    ],
    [
      "render.json référence un autre fichier",
      input => {
        input.render.data.output.path = "autre.mp4";
      },
      /render\.json : sortie autre\.mp4 au lieu de FIRST_REAL_VIDEO\.mp4/
    ],
    [
      "render.json invalide (timeline)",
      input => {
        input.render.data.summary.rendered_duration_seconds = 40;
      },
      /render\.json : summary: rendered_duration_seconds incorrect/
    ],
    [
      "quality.json absent",
      input => {
        input.quality = null;
      },
      /quality\.json absent ou illisible/
    ],
    [
      "Quality resté sur les médias seuls",
      input => {
        input.quality.data.media.scope = "local_media";
      },
      /quality\.json : périmètre local_media \/ rendered/
    ],
    [
      "Quality sans vidéo rendue",
      input => {
        input.quality.data.media.final_video = "not_rendered";
      },
      /quality\.json : périmètre rendered_video \/ not_rendered/
    ],
    [
      "profil attendu différent du profil rendu",
      input => {
        input.profileName = "target";
      },
      /FIRST_REAL_VIDEO\.mp4 : dimensions 640x360 au lieu de 3840x2160/
    ],
    [
      "cadence incohérente",
      input => {
        input.probed.fps = 25;
      },
      /FIRST_REAL_VIDEO\.mp4 : cadence 25 au lieu de 30 images\/s/
    ],
    [
      "codec vidéo inattendu",
      input => {
        input.probed.video_codec = "hevc";
      },
      /FIRST_REAL_VIDEO\.mp4 : codec vidéo inattendu \(hevc\)/
    ],
    [
      "deux flux audio",
      input => {
        input.probed.streams.push(
          structuredClone(
            input.probed.streams.find(
              stream => stream.type === "audio"
            )
          )
        );
      },
      /FIRST_REAL_VIDEO\.mp4 : 1 flux vidéo et 2 flux audio au lieu d'un de chaque/
    ],
    [
      "taille différente de render.json",
      input => {
        input.probed.size_bytes += 1;
      },
      /FIRST_REAL_VIDEO\.mp4 : taille \d+ octets différente de render\.json/
    ],
    [
      "recontrôle de la vidéo en échec",
      input => {
        input.verification = {
          valid: false,
          errors: ["vidéo rendue absente"]
        };
      },
      /recontrôle de la vidéo rendue en échec — vidéo rendue absente/
    ]
  ];

  await test("verdict nominal : aucune erreur", () => {
    const errors = evaluateFirstRealVideo(verdictInput());

    assert(errors.length === 0, errors.join(" | "));
  });

  for (const [name, mutate, pattern] of verdictFailures) {
    await test(`verdict → FAIL — ${name}`, () => {
      const input = verdictInput();

      mutate(input);

      const errors = evaluateFirstRealVideo(input);

      assert(
        errors.some(error => pattern.test(error)),
        `erreur attendue ${pattern} — obtenu : ${errors.join(" | ")}`
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 5. Sécurité de --output-name ---");

  await test("nom accepté : FIRST_REAL_VIDEO.mp4", () => {
    assert(
      outputNameError(FIRST_REAL_VIDEO_NAME) === null,
      `nom refusé : ${outputNameError(FIRST_REAL_VIDEO_NAME)}`
    );
  });

  const rejectedNames = [
    "../FIRST_REAL_VIDEO.mp4",
    "foo/bar.mp4",
    "/foo.mp4",
    "FIRST_REAL_VIDEO",
    "FIRST_REAL_VIDEO.mov",
    ".",
    "..",
    "",
    "..\\FIRST_REAL_VIDEO.mp4",
    "https://exemple.invalid/video.mp4",
    ".cache.mp4"
  ];

  const escapeRoot = path.join(fixtureRoot, "sortie noms");

  fs.mkdirSync(path.join(escapeRoot, "sortie"), { recursive: true });

  const escapeBefore = listDirectory(escapeRoot);

  for (const name of rejectedNames) {
    await test(`nom refusé avant toute production : ${JSON.stringify(name)}`, () => {
      const run = runOrchestrator([
        "--research-script",
        `--media-dir=${renderable}`,
        "--render",
        "--render-profile=preview",
        `--output-dir=${path.join(escapeRoot, "sortie")}`,
        `--output-name=${name}`
      ]);

      assert(
        run.status !== 0 &&
        run.stderr.includes("--output-name invalide"),
        `exit=${run.status} — ${run.stderr.slice(0, 300)}`
      );

      assert(
        run.created.length === 0,
        `production créée : ${run.created}`
      );

      // Rien n'est écrit, ni dans le dossier de sortie, ni au-dessus.
      assert(
        isDeepStrictEqual(listDirectory(escapeRoot), escapeBefore) &&
        listDirectory(path.join(escapeRoot, "sortie")).length === 0,
        "un fichier a été écrit malgré le refus"
      );
    });
  }

  await test("--output-name sans valeur → refus", () => {
    const run = runOrchestrator([
      "--research-script",
      `--media-dir=${renderable}`,
      "--render",
      "--render-profile=preview",
      "--output-name"
    ]);

    assert(
      run.status !== 0 &&
      run.stderr.includes("--output-name invalide") &&
      run.created.length === 0,
      `exit=${run.status} — ${run.stderr.slice(0, 300)}`
    );
  });

  await test("--output-name sans --render → refus", () => {
    const run = runOrchestrator([
      "--research-script",
      `--media-dir=${renderable}`,
      `--output-name=${FIRST_REAL_VIDEO_NAME}`
    ]);

    assert(
      run.status !== 0 &&
      run.stderr.includes("--output-name exige --render") &&
      run.created.length === 0,
      `exit=${run.status} — ${run.stderr.slice(0, 300)}`
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 6. Propreté ---");

  await test("le gate ne supprime, ne renomme et n'écrase jamais une sortie", () => {
    const source = fs.readFileSync(GATE, "utf8");

    assert(
      !/rmSync|unlinkSync|renameSync|copyFileSync|writeFileSync|--force/.test(
        source.replace(/^\s*\/\/.*$/gm, "")
      ),
      "le gate manipule directement des fichiers de sortie"
    );

    assert(
      !/\bfetch\s*\(|node:https?|node:net|elevenlabs|\bsay\b/i.test(
        source.replace(/^\s*\/\/.*$/gm, "")
      ),
      "le gate référence le réseau ou une synthèse vocale"
    );
  });

  await test("le livrable réel output/ n'a pas été touché par le smoke", () => {
    assert(
      isDeepStrictEqual(
        listDirectory(path.join(ROOT, "output")),
        repositoryOutputBefore
      ),
      "output/ du dépôt modifié par le smoke"
    );
  });
} finally {
  // Le smoke ne supprime que le dossier de fixtures qu'il a créé.
  removeMediaFixtureRoot(fixtureRoot);
}

await test("dossier de fixtures du smoke supprimé, tmp/ comme avant", () => {
  assert(
    !fs.existsSync(fixtureRoot) &&
    isDeepStrictEqual(
      listDirectory(path.join(ROOT, "tmp")),
      tmpBefore
    ),
    `tmp/ : ${listDirectory(path.join(ROOT, "tmp"))}`
  );
});

console.log("");
console.log("Productions créées par cette exécution :");

for (const name of createdProductions) {
  console.log(`  projects/${name}`);
}

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API réelle utilisée : NON");
console.log("Livrable output/FIRST_REAL_VIDEO.mp4 touché par le smoke : NON");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — gate FIRST REAL VIDEO"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — gate FIRST REAL VIDEO : vrai MP4 par le pipeline, vérifié, fail-closed, zéro API"
);

process.exit(0);
