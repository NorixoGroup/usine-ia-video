// Smoke de la couche média locale — zéro API, zéro réseau, aucun rendu.
//
// Usage :
//   NO_API=1 node scripts/media-layer-smoke.js
//
// Fabrique de faux médias avec le ffmpeg local dans tmp/r9-media-*/,
// les inspecte avec ffprobe, les rattache aux manifestes Asset et
// Voice, les propage au plan Assembly et à l'audit Quality, puis
// supprime son propre dossier de fixtures. Aucun final.mp4 n'est
// produit : le rendu appartient à une release ultérieure.

import { networkGuard } from "./fixture-network-guard.js";

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  FFPROBE_ARGUMENTS,
  inspectMediaFile,
  normalizeProbeResult
} from "../src/media/probe.js";

import {
  inspectLocalAssets,
  inspectLocalVoice,
  resolveMediaReference,
  resolveMediaRoot,
  verifyLocalMedia
} from "../src/media/local-media.js";

import { runAssetAgent } from "../src/agents/asset.js";
import { runVoiceAgent } from "../src/agents/voice.js";
import { runAssemblyAgent } from "../src/agents/assembly.js";
import { runQualityAgent } from "../src/agents/quality.js";

import {
  validateAssetManifest
} from "../src/utils/validate-asset-manifest.js";

import {
  validateVoiceManifest
} from "../src/utils/validate-voice-manifest.js";

import {
  validateAssemblyPlan,
  validateAssemblySourceMapping
} from "../src/utils/validate-assembly-plan.js";

import {
  QUALITY_CHECK_IDS,
  validateQualityReport
} from "../src/utils/validate-quality-report.js";

import {
  buildArtifacts,
  buildScript,
  buildTarget,
  buildVisual
} from "./canonical-artifacts.js";

import {
  copyMediaSet,
  createMediaFixtureRoot,
  generateAudio,
  generateCanonicalMediaSet,
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

const SHA256 = /^[0-9a-f]{64}$/;

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

function expectValid(verdict, label) {
  assert(
    verdict.valid === true && verdict.errors.length === 0,
    `${label} : PASS attendu — ${verdict.errors.join(" | ")}`
  );
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() || entry.isSymbolicLink())
    .map(entry =>
      path.relative(
        directory,
        path.join(entry.parentPath ?? entry.path, entry.name)
      )
    )
    .sort();
}

// ------------------------------------------------------------------
// Fixtures : fabriquées une fois, copiées pour chaque cas destructif.
// ------------------------------------------------------------------

// Contenu de output/ avant le smoke, pour prouver qu'il n'y touche pas.
function listOutputDirectory() {
  const target = path.join(ROOT, "output");

  return fs.existsSync(target)
    ? fs.readdirSync(target).sort()
    : [];
}

const outputBefore = listOutputDirectory();

const fixtureRoot = createMediaFixtureRoot();
const base = path.join(fixtureRoot, "base");

let caseCounter = 0;

// Copie indépendante du jeu canonique, que le cas peut altérer.
function caseSet(mutate) {
  caseCounter += 1;

  const directory = copyMediaSet(
    base,
    path.join(fixtureRoot, `case-${caseCounter}`)
  );

  mutate?.(directory);

  return directory;
}

const assetFile = (directory, name) =>
  path.join(directory, "assets", name);

const voiceFile = (directory, name) =>
  path.join(directory, "voice", name);

console.log("========================================");
console.log(" MEDIA LAYER — SMOKE (ZERO API, AUCUN RENDU)");
console.log("========================================");

try {
  generateCanonicalMediaSet(base);

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 1. Media Inspector (ffprobe) ---");

  await test("faux médias fabriqués localement : 5 assets, 2 voix", () => {
    assert(
      isDeepStrictEqual(listFiles(base), [
        "assets/s01-g01-sh01.mp4",
        "assets/s01-g01-sh02.png",
        "assets/s01-g01-sh03.mp4",
        "assets/s02-g01-sh01.mp4",
        "assets/s02-g01-sh02.mp4",
        "voice/s01-g01.wav",
        "voice/s02-g01.mp3"
      ]),
      `fixtures : ${listFiles(base)}`
    );
  });

  await test("inspection vidéo : durée, dimensions, cadence, codec mesurés", async () => {
    const file = assetFile(base, "s01-g01-sh01.mp4");
    const result = await inspectMediaFile(file);

    assert(
      result.kind === "video" &&
      result.path === file &&
      result.duration_seconds === 8 &&
      result.width === 320 &&
      result.height === 180 &&
      result.fps === 30 &&
      result.video_codec === "h264" &&
      result.audio_codec === null &&
      result.container.split(",").includes("mp4") &&
      result.size_bytes === fs.statSync(file).size &&
      result.streams.length === 1,
      `relevé inattendu : ${JSON.stringify(result)}`
    );
  });

  await test("inspection image : ni durée ni cadence", async () => {
    const result = await inspectMediaFile(
      assetFile(base, "s01-g01-sh02.png")
    );

    assert(
      result.kind === "image" &&
      result.duration_seconds === null &&
      result.fps === null &&
      result.width === 320 &&
      result.height === 180 &&
      result.video_codec === "png" &&
      result.container === "png_pipe",
      `relevé inattendu : ${JSON.stringify(result)}`
    );
  });

  await test("inspection audio WAV et MP3 : durée réelle mesurée", async () => {
    const wav = await inspectMediaFile(
      voiceFile(base, "s01-g01.wav")
    );

    assert(
      wav.kind === "audio" &&
      wav.duration_seconds === 20 &&
      wav.audio_codec === "pcm_s16le" &&
      wav.sample_rate === 44100 &&
      wav.channels === 1 &&
      wav.container === "wav" &&
      wav.width === null &&
      wav.video_codec === null,
      `WAV inattendu : ${JSON.stringify(wav)}`
    );

    const mp3 = await inspectMediaFile(
      voiceFile(base, "s02-g01.mp3")
    );

    assert(
      mp3.kind === "audio" &&
      mp3.duration_seconds === 21.5 &&
      mp3.audio_codec === "mp3" &&
      mp3.container === "mp3",
      `MP3 inattendu : ${JSON.stringify(mp3)}`
    );
  });

  await test("vidéo avec piste audio : reste une vidéo", async () => {
    const result = await inspectMediaFile(
      assetFile(base, "s02-g01-sh02.mp4")
    );

    assert(
      result.kind === "video" &&
      result.audio_codec === "aac" &&
      result.duration_seconds >= 8 &&
      result.streams.length === 2,
      `relevé inattendu : ${JSON.stringify(result)}`
    );
  });

  await test("relevé stable : deux inspections du même fichier sont identiques", async () => {
    for (const file of [
      assetFile(base, "s01-g01-sh01.mp4"),
      assetFile(base, "s01-g01-sh02.png"),
      voiceFile(base, "s02-g01.mp3")
    ]) {
      assert(
        isDeepStrictEqual(
          await inspectMediaFile(file),
          await inspectMediaFile(file)
        ),
        `relevés différents pour ${file}`
      );
    }
  });

  const broken = path.join(fixtureRoot, "broken");

  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, "empty.mp4"), "");
  fs.writeFileSync(
    path.join(broken, "text.mp4"),
    "ceci n'est pas une vidéo"
  );
  fs.writeFileSync(
    path.join(broken, "truncated.mp4"),
    fs.readFileSync(assetFile(base, "s02-g01-sh01.mp4")).subarray(0, 600)
  );

  const unreadable = [
    ["fichier absent", path.join(broken, "absent.mp4")],
    ["fichier vide", path.join(broken, "empty.mp4")],
    ["fichier texte renommé en .mp4", path.join(broken, "text.mp4")],
    ["fichier tronqué", path.join(broken, "truncated.mp4")]
  ];

  for (const [name, file] of unreadable) {
    await test(`ffprobe rejette — ${name}`, async () => {
      await expectReject(
        () => inspectMediaFile(file),
        /^Media Inspector : fichier illisible par ffprobe/
      );
    });
  }

  const unsafeInputs = [
    ["chemin relatif", "assets/s01-g01-sh01.mp4"],
    ["chemin non normalisé", `${base}/assets/../assets/s01-g01-sh01.mp4`],
    ["URL http", "http://127.0.0.1:9/video.mp4"],
    ["URL https", "https://exemple.invalid/video.mp4"],
    ["URL file://", `file://${assetFile(base, "s01-g01-sh01.mp4")}`],
    ["valeur non texte", 42],
    ["valeur absente", undefined]
  ];

  for (const [name, input] of unsafeInputs) {
    await test(`Media Inspector refuse avant tout lancement — ${name}`, async () => {
      await expectReject(
        () => inspectMediaFile(input),
        /^Media Inspector : chemin local absolu et normalisé obligatoire/
      );
    });
  }

  await test("ffprobe introuvable → FAIL, aucun repli", async () => {
    await expectReject(
      () => inspectMediaFile(assetFile(base, "s01-g01-sh01.mp4"), {
        ffprobePath: "ffprobe-introuvable-r9"
      }),
      /^Media Inspector : ffprobe indisponible \(ffprobe-introuvable-r9\)/
    );
  });

  await test("ffprobe en échec → FAIL", async () => {
    await expectReject(
      () => inspectMediaFile(assetFile(base, "s01-g01-sh01.mp4"), {
        ffprobePath: "false"
      }),
      /^Media Inspector : fichier illisible par ffprobe/
    );
  });

  await test("sortie ffprobe illisible → FAIL", async () => {
    await expectReject(
      () => inspectMediaFile(assetFile(base, "s01-g01-sh01.mp4"), {
        ffprobePath: "true"
      }),
      /^Media Inspector : sortie ffprobe illisible/
    );
  });

  const videoStream = {
    index: 0,
    codec_type: "video",
    codec_name: "h264",
    width: 320,
    height: 180,
    avg_frame_rate: "30/1",
    disposition: { attached_pic: 0 }
  };

  const audioStream = {
    index: 0,
    codec_type: "audio",
    codec_name: "mp3",
    sample_rate: "44100",
    channels: 1,
    disposition: { attached_pic: 0 }
  };

  const mp4 = { format_name: "mov,mp4,m4a", size: "1000" };

  const invalidMetadata = [
    ["sortie vide", {}, /aucun flux lisible/],
    ["aucun flux", { format: mp4, streams: [] }, /aucun flux lisible/],
    [
      "durée nulle",
      { format: { ...mp4, duration: "0.000000" }, streams: [videoStream] },
      /durée absente ou nulle/
    ],
    [
      "durée négative",
      { format: { ...mp4, duration: "-3" }, streams: [videoStream] },
      /durée absente ou nulle/
    ],
    [
      "durée absente",
      { format: { ...mp4, duration: "N/A" }, streams: [videoStream] },
      /durée absente ou nulle/
    ],
    [
      "largeur absente",
      {
        format: { ...mp4, duration: "8" },
        streams: [{ ...videoStream, width: undefined }]
      },
      /métadonnées essentielles absentes \(dimensions ou codec\)/
    ],
    [
      "codec vidéo absent",
      {
        format: { ...mp4, duration: "8" },
        streams: [{ ...videoStream, codec_name: undefined }]
      },
      /métadonnées essentielles absentes \(dimensions ou codec\)/
    ],
    [
      "cadence absente",
      {
        format: { ...mp4, duration: "8" },
        streams: [{ ...videoStream, avg_frame_rate: "0/0" }]
      },
      /métadonnées essentielles absentes \(cadence\)/
    ],
    [
      "audio sans fréquence",
      {
        format: { format_name: "mp3", size: "1000", duration: "20" },
        streams: [{ ...audioStream, sample_rate: undefined }]
      },
      /métadonnées essentielles absentes \(codec, fréquence ou canaux\)/
    ],
    [
      "taille absente",
      {
        format: { format_name: "mp3", duration: "20" },
        streams: [audioStream]
      },
      /taille de fichier absente ou invalide/
    ],
    [
      "conteneur absent",
      { format: { size: "1000", duration: "20" }, streams: [audioStream] },
      /format de conteneur absent/
    ],
    [
      "flux de données seul",
      {
        format: { ...mp4, duration: "8" },
        streams: [{ index: 0, codec_type: "data" }]
      },
      /aucun flux vidéo ou audio/
    ]
  ];

  for (const [name, raw, pattern] of invalidMetadata) {
    await test(`métadonnées invalides → FAIL — ${name}`, async () => {
      await expectReject(
        () => normalizeProbeResult(raw, "/fixture"),
        pattern
      );
    });
  }

  await test("pochette incrustée dans un fichier audio : reste un audio", () => {
    const result = normalizeProbeResult(
      {
        format: { format_name: "mp3", size: "1000", duration: "20" },
        streams: [
          audioStream,
          {
            index: 1,
            codec_type: "video",
            codec_name: "mjpeg",
            width: 500,
            height: 500,
            disposition: { attached_pic: 1 }
          }
        ]
      },
      "/fixture"
    );

    assert(result.kind === "audio", `kind=${result.kind}`);
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 2. Sécurité des chemins ---");

  const realBase = fs.realpathSync(base);

  const invalidRoots = [
    ["dossier inexistant", path.join(fixtureRoot, "absent"), /dossier média introuvable/],
    ["fichier au lieu d'un dossier", assetFile(base, "s01-g01-sh01.mp4"), /n'est pas un dossier/],
    ["URL https", "https://exemple.invalid/medias", /pas une URL/],
    ["URL file://", `file://${base}`, /pas une URL/],
    ["valeur vide", "  ", /dossier média absent ou invalide/],
    ["valeur absente", undefined, /dossier média absent ou invalide/]
  ];

  for (const [name, input, pattern] of invalidRoots) {
    await test(`racine média refusée — ${name}`, async () => {
      await expectReject(() => resolveMediaRoot(input), pattern);
    });
  }

  await test("racine média acceptée : chemin réel du dossier fourni", () => {
    assert(
      resolveMediaRoot(base) === realBase,
      "chemin réel inattendu"
    );
  });

  const outside = path.join(fixtureRoot, "outside.mp4");

  fs.copyFileSync(assetFile(base, "s01-g01-sh01.mp4"), outside);

  const linked = caseSet(directory => {
    fs.symlinkSync(outside, assetFile(directory, "escape.mp4"));
    fs.symlinkSync(
      assetFile(directory, "s01-g01-sh01.mp4"),
      assetFile(directory, "inside-link.mp4")
    );
    fs.mkdirSync(assetFile(directory, "folder.mp4"));
    fs.writeFileSync(assetFile(directory, "empty.mp4"), "");
  });

  const realLinked = fs.realpathSync(linked);

  const unsafeReferences = [
    ["URL http", "http://exemple.invalid/a.mp4", /référence distante ou URL interdite/],
    ["URL https", "https://exemple.invalid/a.mp4", /référence distante ou URL interdite/],
    ["URL file://", "file:///etc/hosts", /référence distante ou URL interdite/],
    ["chemin absolu", "/etc/hosts", /chemin absolu interdit/],
    ["chemin absolu vers un vrai média", outside, /chemin absolu interdit/],
    ["antislash", "assets\\s01-g01-sh01.mp4", /chemin absolu interdit/],
    ["traversal simple", "../outside.mp4", /remontée ou segment vide interdit/],
    ["traversal au milieu", "assets/../../outside.mp4", /remontée ou segment vide interdit/],
    ["segment vide", "assets//s01-g01-sh01.mp4", /remontée ou segment vide interdit/],
    ["segment point", "assets/./s01-g01-sh01.mp4", /remontée ou segment vide interdit/],
    ["fichier absent", "assets/absent.mp4", /fichier média absent/],
    ["fichier vide", "assets/empty.mp4", /fichier média vide/],
    ["dossier", "assets/folder.mp4", /n'est pas un fichier/],
    ["lien symbolique sortant de la racine", "assets/escape.mp4", /hors du dossier média autorisé/],
    ["référence vide", "", /référence média absente ou invalide/],
    ["référence non texte", 42, /référence média absente ou invalide/]
  ];

  for (const [name, reference, pattern] of unsafeReferences) {
    await test(`référence refusée — ${name}`, async () => {
      await expectReject(
        () => resolveMediaReference(realLinked, reference),
        pattern
      );
    });
  }

  await test("lien symbolique interne à la racine : accepté et résolu", () => {
    const resolved = resolveMediaReference(
      realLinked,
      "assets/inside-link.mp4"
    );

    assert(
      resolved.absolutePath ===
        path.join(realLinked, "assets", "s01-g01-sh01.mp4"),
      `chemin résolu : ${resolved.absolutePath}`
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 3. Inventaire et inspection du dossier média ---");

  let localMedia = null;
  let localAudio = null;

  await test("assets/ : un relevé par asset, référence relative, empreinte", async () => {
    localMedia = await inspectLocalAssets({ mediaDir: base });

    assert(
      isDeepStrictEqual(Object.keys(localMedia), [
        "s01-g01-sh01",
        "s01-g01-sh02",
        "s01-g01-sh03",
        "s02-g01-sh01",
        "s02-g01-sh02"
      ]),
      `identifiants : ${Object.keys(localMedia)}`
    );

    for (const [id, record] of Object.entries(localMedia)) {
      assert(
        isDeepStrictEqual(Object.keys(record), [
          "path",
          "kind",
          "container",
          "duration_seconds",
          "width",
          "height",
          "fps",
          "video_codec",
          "size_bytes",
          "sha256"
        ]),
        `${id} : clés ${Object.keys(record)}`
      );

      assert(
        record.path.startsWith(`assets/${id}.`) &&
        SHA256.test(record.sha256) &&
        record.size_bytes > 0,
        `${id} : relevé inattendu ${JSON.stringify(record)}`
      );
    }

    assert(
      localMedia["s01-g01-sh02"].kind === "image" &&
      localMedia["s01-g01-sh03"].duration_seconds === 6 &&
      localMedia["s02-g01-sh01"].duration_seconds === 12,
      "types ou durées mesurés inattendus"
    );

    assert(
      !JSON.stringify(localMedia).includes(fixtureRoot),
      "un chemin absolu figure dans les relevés"
    );
  });

  await test("voice/ : un relevé par unité, durée mesurée", async () => {
    localAudio = await inspectLocalVoice({ mediaDir: base });

    assert(
      isDeepStrictEqual(Object.keys(localAudio), [
        "s01-g01",
        "s02-g01"
      ]),
      `identifiants : ${Object.keys(localAudio)}`
    );

    assert(
      isDeepStrictEqual(Object.keys(localAudio["s01-g01"]), [
        "path",
        "container",
        "duration_seconds",
        "audio_codec",
        "sample_rate",
        "channels",
        "size_bytes",
        "sha256"
      ]),
      `clés : ${Object.keys(localAudio["s01-g01"])}`
    );

    assert(
      localAudio["s01-g01"].path === "voice/s01-g01.wav" &&
      localAudio["s01-g01"].duration_seconds === 20 &&
      localAudio["s02-g01"].path === "voice/s02-g01.mp3" &&
      localAudio["s02-g01"].duration_seconds === 21.5 &&
      SHA256.test(localAudio["s02-g01"].sha256),
      `relevés inattendus : ${JSON.stringify(localAudio)}`
    );
  });

  await test("déterminisme : deux inventaires identiques, fichiers inchangés", async () => {
    const before = listFiles(base).map(file => [
      file,
      fs.statSync(path.join(base, file)).size,
      fs.statSync(path.join(base, file)).mtimeMs
    ]);

    assert(
      isDeepStrictEqual(
        await inspectLocalAssets({ mediaDir: base }),
        localMedia
      ) &&
      isDeepStrictEqual(
        await inspectLocalVoice({ mediaDir: base }),
        localAudio
      ),
      "relevés différents entre deux inventaires"
    );

    const after = listFiles(base).map(file => [
      file,
      fs.statSync(path.join(base, file)).size,
      fs.statSync(path.join(base, file)).mtimeMs
    ]);

    assert(
      isDeepStrictEqual(before, after),
      "l'inspection a modifié le dossier média"
    );
  });

  await test("fichiers cachés du système ignorés", async () => {
    const directory = caseSet(target => {
      fs.writeFileSync(assetFile(target, ".DS_Store"), "x");
    });

    assert(
      isDeepStrictEqual(
        await inspectLocalAssets({ mediaDir: directory }),
        localMedia
      ),
      "un fichier caché a modifié l'inventaire"
    );
  });

  const inventoryFailures = [
    [
      "sous-dossier assets/ absent",
      "asset",
      target => {
        fs.rmSync(path.join(target, "assets"), { recursive: true });
      },
      /sous-dossier assets\/ absent du dossier média/
    ],
    [
      "sous-dossier voice/ absent",
      "voice",
      target => {
        fs.rmSync(path.join(target, "voice"), { recursive: true });
      },
      /sous-dossier voice\/ absent du dossier média/
    ],
    [
      "extension non autorisée (.txt)",
      "asset",
      target => {
        fs.writeFileSync(assetFile(target, "notes.txt"), "x");
      },
      /extension non autorisée \(assets\/notes\.txt\)/
    ],
    [
      "extension non autorisée (.gif)",
      "asset",
      target => {
        fs.renameSync(
          assetFile(target, "s01-g01-sh02.png"),
          assetFile(target, "s01-g01-sh02.gif")
        );
      },
      /extension non autorisée/
    ],
    [
      "fichier audio déposé dans assets/",
      "asset",
      target => {
        fs.rmSync(assetFile(target, "s01-g01-sh01.mp4"));
        fs.copyFileSync(
          voiceFile(target, "s01-g01.wav"),
          assetFile(target, "s01-g01-sh01.wav")
        );
      },
      /extension \.wav interdite pour un média de type asset/
    ],
    [
      "contenu audio renommé en .mp4 (mauvais type)",
      "asset",
      target => {
        fs.copyFileSync(
          voiceFile(target, "s01-g01.wav"),
          assetFile(target, "s01-g01-sh01.mp4")
        );
      },
      /mauvais type de média \(assets\/s01-g01-sh01\.mp4\) : contenu audio, video attendu/
    ],
    [
      "image renommée en .mp4 (mauvais type)",
      "asset",
      target => {
        fs.copyFileSync(
          assetFile(target, "s01-g01-sh02.png"),
          assetFile(target, "s01-g01-sh01.mp4")
        );
      },
      /mauvais type de média \(assets\/s01-g01-sh01\.mp4\) : contenu image, video attendu/
    ],
    [
      "PNG renommé en .jpg (mauvaise extension)",
      "asset",
      target => {
        fs.renameSync(
          assetFile(target, "s01-g01-sh02.png"),
          assetFile(target, "s01-g01-sh02.jpg")
        );
      },
      /extension \.jpg incohérente avec le conteneur png_pipe/
    ],
    [
      "fichier vidéo déposé dans voice/",
      "voice",
      target => {
        fs.copyFileSync(
          assetFile(target, "s01-g01-sh01.mp4"),
          voiceFile(target, "s03-g01.mp4")
        );
      },
      /extension \.mp4 interdite pour un média de type voice/
    ],
    [
      "contenu vidéo renommé en .wav (mauvais type)",
      "voice",
      target => {
        fs.copyFileSync(
          assetFile(target, "s01-g01-sh01.mp4"),
          voiceFile(target, "s01-g01.wav")
        );
      },
      /mauvais type de média \(voice\/s01-g01\.wav\) : contenu video, audio attendu/
    ],
    [
      "deux fichiers pour le même asset",
      "asset",
      target => {
        fs.copyFileSync(
          assetFile(target, "s01-g01-sh01.mp4"),
          assetFile(target, "s01-g01-sh01.mov")
        );
      },
      /plusieurs fichiers pour l'identifiant s01-g01-sh01/
    ],
    [
      "fichier vide",
      "asset",
      target => {
        fs.writeFileSync(assetFile(target, "s01-g01-sh01.mp4"), "");
      },
      /fichier média vide \(assets\/s01-g01-sh01\.mp4\)/
    ],
    [
      "fichier corrompu (tronqué)",
      "asset",
      target => {
        fs.truncateSync(assetFile(target, "s02-g01-sh01.mp4"), 600);
      },
      /assets\/s02-g01-sh01\.mp4 — Media Inspector : fichier illisible par ffprobe/
    ],
    [
      "fichier corrompu (texte)",
      "voice",
      target => {
        fs.writeFileSync(voiceFile(target, "s01-g01.wav"), "texte");
      },
      /voice\/s01-g01\.wav — Media Inspector : fichier illisible par ffprobe/
    ],
    [
      "nom de fichier invalide",
      "asset",
      target => {
        fs.renameSync(
          assetFile(target, "s01-g01-sh01.mp4"),
          assetFile(target, "mon asset.mp4")
        );
      },
      /nom de fichier média invalide \(assets\/mon asset\.mp4\)/
    ],
    [
      "lien symbolique sortant de la racine",
      "asset",
      target => {
        fs.rmSync(assetFile(target, "s01-g01-sh01.mp4"));
        fs.symlinkSync(
          outside,
          assetFile(target, "s01-g01-sh01.mp4")
        );
      },
      /référence hors du dossier média autorisé \(assets\/s01-g01-sh01\.mp4\)/
    ]
  ];

  for (const [name, role, mutate, pattern] of inventoryFailures) {
    await test(`dossier média refusé — ${name}`, async () => {
      const directory = caseSet(mutate);

      const error = await expectReject(
        () => (
          role === "asset"
            ? inspectLocalAssets({ mediaDir: directory })
            : inspectLocalVoice({ mediaDir: directory })
        ),
        pattern
      );

      assert(
        error.message.startsWith("Local Media : "),
        `l'erreur ne vient pas de la couche média : ${error.message}`
      );
    });
  }

  await test("ffprobe indisponible pendant l'inventaire → FAIL", async () => {
    await expectReject(
      () => inspectLocalAssets({
        mediaDir: base,
        ffprobePath: "ffprobe-introuvable-r9"
      }),
      /Media Inspector : ffprobe indisponible/
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 4. Asset résolu localement ---");

  const visual = buildVisual();
  let assets = null;

  await test("Asset Agent + relevés → tous les assets resolved_local", async () => {
    const records = structuredClone(localMedia);

    assets = await runAssetAgent({
      visual,
      testMode: true,
      localMedia: records
    });

    assert(
      isDeepStrictEqual(Object.keys(assets), [
        "agent",
        "mode",
        "data",
        "validation",
        "visual_mapping_validation",
        "usage"
      ]) &&
      assets.validation.valid &&
      assets.visual_mapping_validation.valid &&
      assets.usage === null,
      "enveloppe ou gates inattendus"
    );

    for (const asset of assets.data.assets) {
      assert(
        asset.status === "resolved_local" &&
        Object.keys(asset).at(-1) === "media" &&
        Object.keys(asset).length === 12 &&
        isDeepStrictEqual(asset.media, localMedia[asset.asset_id]),
        `${asset.asset_id} : asset résolu inattendu`
      );
    }

    assert(
      isDeepStrictEqual(records, localMedia),
      "les relevés fournis ont été modifiés"
    );

    assert(
      isDeepStrictEqual(visual, buildVisual()),
      "le plan visuel source a été modifié"
    );
  });

  await test("sans relevés : contrat historique unresolved inchangé", async () => {
    const historic = await runAssetAgent({
      visual: buildVisual(),
      testMode: true
    });

    assert(
      historic.data.assets.every(
        asset =>
          asset.status === "unresolved" &&
          !Object.hasOwn(asset, "media") &&
          Object.keys(asset).length === 11
      ),
      "le contrat historique a changé"
    );
  });

  const assetAgentFailures = [
    [
      "média manquant pour un asset (tout ou rien)",
      records => {
        delete records["s01-g01-sh02"];
      },
      /^Asset Agent : média local manquant pour s01-g01-sh02\./
    ],
    [
      "aucun média",
      records => {
        for (const id of Object.keys(records)) {
          delete records[id];
        }
      },
      /^Asset Agent : média local manquant pour s01-g01-sh01, s01-g01-sh02/
    ],
    [
      "fichier sans asset correspondant",
      records => {
        records["s09-g01-sh01"] = structuredClone(
          records["s01-g01-sh01"]
        );
      },
      /^Asset Agent : fichier média sans asset correspondant — s09-g01-sh01\./
    ],
    [
      "image fournie pour un asset stock_video",
      records => {
        records["s01-g01-sh01"] = {
          ...structuredClone(records["s01-g01-sh02"]),
          path: "assets/s01-g01-sh01.png"
        };
      },
      /Asset Gate\..*mauvais type de média — image fourni pour un asset stock_video/
    ],
    [
      "vidéo plus courte que la durée nécessaire",
      records => {
        records["s02-g01-sh01"].duration_seconds = 11.9;
      },
      /Asset Gate\..*média plus court \(11\.9s\) que la durée nécessaire \(12s\)/
    ],
    [
      "relevé d'un autre asset (chemin incohérent)",
      records => {
        records["s01-g01-sh03"] = structuredClone(
          records["s01-g01-sh01"]
        );
      },
      /Asset Gate\..*path doit être assets\/<asset_id>\.<extension>/
    ]
  ];

  for (const [name, mutate, pattern] of assetAgentFailures) {
    await test(`Asset Agent → FAIL — ${name}`, async () => {
      const records = structuredClone(localMedia);

      mutate(records);

      await expectReject(
        () => runAssetAgent({
          visual: buildVisual(),
          testMode: true,
          localMedia: records
        }),
        pattern
      );
    });
  }

  for (const [name, value] of [
    ["null", null],
    ["tableau", []],
    ["texte", "assets"]
  ]) {
    await test(`Asset Agent → FAIL — relevés invalides (${name})`, async () => {
      await expectReject(
        () => runAssetAgent({
          visual: buildVisual(),
          testMode: true,
          localMedia: value
        }),
        /^Asset Agent : relevés de médias locaux invalides/
      );
    });
  }

  const assetContractCases = [
    [
      "resolved_local sans media",
      manifest => {
        for (const asset of manifest.assets) {
          delete asset.media;
        }
      },
      /assets\[0\]: status "resolved_local" sans média local inspecté/
    ],
    [
      "media présent avec unresolved",
      manifest => {
        for (const asset of manifest.assets) {
          asset.status = "unresolved";
        }
      },
      /assets\[0\]: champ media non autorisé/
    ],
    [
      "résolution partielle",
      manifest => {
        manifest.assets[4].status = "unresolved";
        delete manifest.assets[4].media;
      },
      /résolution partielle interdite : 4 asset\(s\) résolu\(s\) sur 5/
    ],
    [
      "status inconnu",
      manifest => {
        manifest.assets[0].status = "resolved";
      },
      /assets\[0\]: status doit être "unresolved" ou "resolved_local"/
    ],
    [
      "path : URL http",
      manifest => {
        manifest.assets[0].media.path = "http://exemple.invalid/a.mp4";
      },
      /assets\[0\]\.media: path ne doit pas être une URL/
    ],
    [
      "path : URL https",
      manifest => {
        manifest.assets[0].media.path = "https://exemple.invalid/a.mp4";
      },
      /assets\[0\]\.media: path ne doit pas être une URL/
    ],
    [
      "path : file://",
      manifest => {
        manifest.assets[0].media.path =
          "file:///tmp/assets/s01-g01-sh01.mp4";
      },
      /assets\[0\]\.media: path ne doit pas être une URL/
    ],
    [
      "path : chemin absolu",
      manifest => {
        manifest.assets[0].media.path = "/tmp/assets/s01-g01-sh01.mp4";
      },
      /assets\[0\]\.media: path ne doit pas être un chemin absolu/
    ],
    [
      "path : traversal",
      manifest => {
        manifest.assets[0].media.path =
          "assets/../../s01-g01-sh01.mp4";
      },
      /assets\[0\]\.media: path ne doit contenir ni remontée/
    ],
    [
      "path : autre dossier",
      manifest => {
        manifest.assets[0].media.path = "voice/s01-g01-sh01.mp4";
      },
      /assets\[0\]\.media: path doit être assets\/<asset_id>\.<extension>/
    ],
    [
      "path : autre identifiant",
      manifest => {
        manifest.assets[0].media.path = "assets/s02-g01-sh02.mp4";
      },
      /assets\[0\]\.media: path doit être assets\/<asset_id>\.<extension>/
    ],
    [
      "path : extension non autorisée",
      manifest => {
        manifest.assets[0].media.path = "assets/s01-g01-sh01.exe";
      },
      /assets\[0\]\.media: path : extension non autorisée/
    ],
    [
      "kind audio",
      manifest => {
        manifest.assets[0].media.kind = "audio";
      },
      /assets\[0\]\.media: kind invalide/
    ],
    [
      "kind incohérent avec l'extension",
      manifest => {
        manifest.assets[1].media.kind = "video";
        manifest.assets[1].media.duration_seconds = 7;
        manifest.assets[1].media.fps = 30;
      },
      /assets\[1\]\.media: extension incohérente avec kind video/
    ],
    [
      "durée nulle",
      manifest => {
        manifest.assets[0].media.duration_seconds = 0;
      },
      /assets\[0\]\.media: duration_seconds invalide/
    ],
    [
      "durée absente pour une vidéo",
      manifest => {
        manifest.assets[0].media.duration_seconds = null;
      },
      /assets\[0\]\.media: duration_seconds invalide/
    ],
    [
      "durée sur une image",
      manifest => {
        manifest.assets[1].media.duration_seconds = 7;
      },
      /assets\[1\]\.media: duration_seconds et fps doivent être null pour une image/
    ],
    [
      "largeur nulle",
      manifest => {
        manifest.assets[0].media.width = 0;
      },
      /assets\[0\]\.media: width invalide/
    ],
    [
      "cadence nulle",
      manifest => {
        manifest.assets[0].media.fps = 0;
      },
      /assets\[0\]\.media: fps invalide/
    ],
    [
      "codec absent",
      manifest => {
        manifest.assets[0].media.video_codec = "";
      },
      /assets\[0\]\.media: video_codec manquant/
    ],
    [
      "taille nulle",
      manifest => {
        manifest.assets[0].media.size_bytes = 0;
      },
      /assets\[0\]\.media: size_bytes invalide/
    ],
    [
      "empreinte invalide",
      manifest => {
        manifest.assets[0].media.sha256 = "abc";
      },
      /assets\[0\]\.media: sha256 invalide/
    ],
    [
      "champ inconnu dans media (url)",
      manifest => {
        manifest.assets[0].media.url = "https://exemple.invalid/a.mp4";
      },
      /assets\[0\]\.media: champ url non autorisé/
    ],
    [
      "champ manquant dans media",
      manifest => {
        delete manifest.assets[0].media.sha256;
      },
      /assets\[0\]\.media: champ sha256 manquant/
    ],
    [
      "media non objet",
      manifest => {
        manifest.assets[0].media = "assets/s01-g01-sh01.mp4";
      },
      /assets\[0\]: status "resolved_local" sans média local inspecté/
    ]
  ];

  for (const [name, mutate, pattern] of assetContractCases) {
    await test(`contrat Asset → FAIL — ${name}`, () => {
      const manifest = structuredClone(assets.data);

      mutate(manifest);

      expectInvalid(
        validateAssetManifest(manifest),
        pattern,
        "Asset Gate"
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 5. Voice synthétisée localement ---");

  const script = buildScript();
  let voice = null;

  await test("Voice Agent + relevés → toutes les unités synthesized_local", async () => {
    const records = structuredClone(localAudio);

    voice = await runVoiceAgent({
      script,
      testMode: true,
      localAudio: records
    });

    assert(
      voice.validation.valid &&
      voice.script_mapping_validation.valid &&
      voice.usage === null,
      "gates inattendus"
    );

    for (const unit of voice.data.narration_units) {
      assert(
        unit.status === "synthesized_local" &&
        Object.keys(unit).at(-1) === "audio" &&
        Object.keys(unit).length === 7 &&
        isDeepStrictEqual(unit.audio, localAudio[unit.unit_id]),
        `${unit.unit_id} : unité inattendue`
      );
    }

    assert(
      isDeepStrictEqual(records, localAudio) &&
      isDeepStrictEqual(script, buildScript()),
      "une entrée a été modifiée"
    );
  });

  await test("durée estimée et durée mesurée coexistent sans se confondre", () => {
    const [first, second] = voice.data.narration_units;

    assert(
      first.estimated_seconds === 20 &&
      first.audio.duration_seconds === 20 &&
      second.estimated_seconds === 20 &&
      second.audio.duration_seconds === 21.5 &&
      voice.data.summary.total_estimated_seconds === 40,
      "estimation ou mesure inattendue"
    );
  });

  await test("sans relevés : contrat historique unsynthesized inchangé", async () => {
    const historic = await runVoiceAgent({
      script: buildScript(),
      testMode: true
    });

    assert(
      historic.data.narration_units.every(
        unit =>
          unit.status === "unsynthesized" &&
          !Object.hasOwn(unit, "audio") &&
          Object.keys(unit).length === 6
      ),
      "le contrat historique a changé"
    );
  });

  const voiceAgentFailures = [
    [
      "audio manquant pour une unité (tout ou rien)",
      records => {
        delete records["s02-g01"];
      },
      /^Voice Agent : audio local manquant pour s02-g01\./
    ],
    [
      "fichier sans unité correspondante",
      records => {
        records["s09-g01"] = structuredClone(records["s01-g01"]);
      },
      /^Voice Agent : fichier audio sans unité correspondante — s09-g01\./
    ],
    [
      "relevé d'une autre unité (chemin incohérent)",
      records => {
        records["s02-g01"] = structuredClone(records["s01-g01"]);
      },
      /Voice Gate\..*path doit être voice\/<unit_id>\.<extension>/
    ],
    [
      "relevés invalides",
      () => null,
      /^Voice Agent : relevés d'audio locaux invalides/
    ]
  ];

  for (const [name, mutate, pattern] of voiceAgentFailures) {
    await test(`Voice Agent → FAIL — ${name}`, async () => {
      let records = structuredClone(localAudio);

      if (mutate(records) === null) {
        records = null;
      }

      await expectReject(
        () => runVoiceAgent({
          script: buildScript(),
          testMode: true,
          localAudio: records
        }),
        pattern
      );
    });
  }

  const voiceContractCases = [
    [
      "synthesized_local sans audio",
      manifest => {
        for (const unit of manifest.narration_units) {
          delete unit.audio;
        }
      },
      /narration_units\[0\]: status "synthesized_local" sans audio local inspecté/
    ],
    [
      "audio présent avec unsynthesized",
      manifest => {
        for (const unit of manifest.narration_units) {
          unit.status = "unsynthesized";
        }
      },
      /narration_units\[0\]: champ audio non autorisé/
    ],
    [
      "synthèse partielle",
      manifest => {
        manifest.narration_units[1].status = "unsynthesized";
        delete manifest.narration_units[1].audio;
      },
      /synthèse partielle interdite : 1 unité\(s\) sur 2/
    ],
    [
      "status inconnu",
      manifest => {
        manifest.narration_units[0].status = "synthesized";
      },
      /narration_units\[0\]: status doit être "unsynthesized" ou "synthesized_local"/
    ],
    [
      "path : URL https",
      manifest => {
        manifest.narration_units[0].audio.path =
          "https://exemple.invalid/s01-g01.mp3";
      },
      /narration_units\[0\]\.audio: path ne doit pas être une URL/
    ],
    [
      "path : file://",
      manifest => {
        manifest.narration_units[0].audio.path =
          "file:///tmp/voice/s01-g01.wav";
      },
      /narration_units\[0\]\.audio: path ne doit pas être une URL/
    ],
    [
      "path : chemin absolu",
      manifest => {
        manifest.narration_units[0].audio.path =
          "/tmp/voice/s01-g01.wav";
      },
      /narration_units\[0\]\.audio: path ne doit pas être un chemin absolu/
    ],
    [
      "path : traversal",
      manifest => {
        manifest.narration_units[0].audio.path =
          "voice/../../s01-g01.wav";
      },
      /narration_units\[0\]\.audio: path ne doit contenir ni remontée/
    ],
    [
      "path : extension vidéo",
      manifest => {
        manifest.narration_units[0].audio.path = "voice/s01-g01.mp4";
      },
      /narration_units\[0\]\.audio: path : extension audio non autorisée/
    ],
    [
      "path : autre dossier",
      manifest => {
        manifest.narration_units[0].audio.path = "assets/s01-g01.wav";
      },
      /narration_units\[0\]\.audio: path doit être voice\/<unit_id>\.<extension>/
    ],
    [
      "durée mesurée nulle",
      manifest => {
        manifest.narration_units[0].audio.duration_seconds = 0;
      },
      /narration_units\[0\]\.audio: duration_seconds invalide/
    ],
    [
      "durée mesurée absente",
      manifest => {
        manifest.narration_units[0].audio.duration_seconds = null;
      },
      /narration_units\[0\]\.audio: duration_seconds invalide/
    ],
    [
      "fréquence invalide",
      manifest => {
        manifest.narration_units[0].audio.sample_rate = 0;
      },
      /narration_units\[0\]\.audio: sample_rate invalide/
    ],
    [
      "canaux invalides",
      manifest => {
        manifest.narration_units[0].audio.channels = 0;
      },
      /narration_units\[0\]\.audio: channels invalide/
    ],
    [
      "codec absent",
      manifest => {
        manifest.narration_units[0].audio.audio_codec = "";
      },
      /narration_units\[0\]\.audio: audio_codec manquant/
    ],
    [
      "empreinte invalide",
      manifest => {
        manifest.narration_units[0].audio.sha256 = "0".repeat(63);
      },
      /narration_units\[0\]\.audio: sha256 invalide/
    ],
    [
      "champ inconnu dans audio (voice_id)",
      manifest => {
        manifest.narration_units[0].audio.voice_id = "voix-1";
      },
      /narration_units\[0\]\.audio: champ voice_id non autorisé/
    ],
    [
      "champ manquant dans audio",
      manifest => {
        delete manifest.narration_units[0].audio.size_bytes;
      },
      /narration_units\[0\]\.audio: champ size_bytes manquant/
    ]
  ];

  for (const [name, mutate, pattern] of voiceContractCases) {
    await test(`contrat Voice → FAIL — ${name}`, () => {
      const manifest = structuredClone(voice.data);

      mutate(manifest);

      expectInvalid(
        validateVoiceManifest(manifest),
        pattern,
        "Voice Gate"
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 6. Recontrôle sur disque (taille, SHA-256, ffprobe) ---");

  let verification = null;

  await test("médias intacts → rapport valide couvrant les 7 fichiers", async () => {
    verification = await verifyLocalMedia({
      mediaDir: base,
      assets: assets.data,
      voice: voice.data
    });

    assert(
      verification.scope === "local_media" &&
      verification.valid === true &&
      verification.errors.length === 0 &&
      verification.files.length === 7,
      `rapport inattendu : ${JSON.stringify(verification)}`
    );

    assert(
      isDeepStrictEqual(
        verification.files.map(file => `${file.role}:${file.id}`),
        [
          "asset:s01-g01-sh01",
          "asset:s01-g01-sh02",
          "asset:s01-g01-sh03",
          "asset:s02-g01-sh01",
          "asset:s02-g01-sh02",
          "voice:s01-g01",
          "voice:s02-g01"
        ]
      ) &&
      verification.files.every(
        file => SHA256.test(file.sha256) && file.size_bytes > 0
      ),
      "fichiers vérifiés inattendus"
    );
  });

  const alterations = [
    [
      "média modifié après inspection (octets ajoutés)",
      target => {
        fs.appendFileSync(
          assetFile(target, "s01-g01-sh01.mp4"),
          "altération"
        );
      },
      /assets\[0\]: média modifié depuis l'inspection \(assets\/s01-g01-sh01\.mp4 — .*size_bytes.*sha256/
    ],
    [
      "média remplacé par un autre de même nom",
      target => {
        fs.copyFileSync(
          assetFile(target, "s02-g01-sh01.mp4"),
          assetFile(target, "s01-g01-sh01.mp4")
        );
      },
      /assets\[0\]: média modifié depuis l'inspection \(assets\/s01-g01-sh01\.mp4 — .*duration_seconds/
    ],
    [
      "asset supprimé après inspection",
      target => {
        fs.rmSync(assetFile(target, "s02-g01-sh02.mp4"));
      },
      /assets\[4\]: Local Media : fichier média absent \(assets\/s02-g01-sh02\.mp4\)/
    ],
    [
      "audio supprimé après inspection",
      target => {
        fs.rmSync(voiceFile(target, "s01-g01.wav"));
      },
      /narration_units\[0\]: Local Media : fichier média absent \(voice\/s01-g01\.wav\)/
    ],
    [
      "audio vidé après inspection",
      target => {
        fs.writeFileSync(voiceFile(target, "s02-g01.mp3"), "");
      },
      /narration_units\[1\]: Local Media : fichier média vide/
    ],
    [
      "audio corrompu après inspection",
      target => {
        fs.writeFileSync(voiceFile(target, "s01-g01.wav"), "texte");
      },
      /narration_units\[0\]: Local Media : voice\/s01-g01\.wav — Media Inspector : fichier illisible par ffprobe/
    ]
  ];

  for (const [name, mutate, pattern] of alterations) {
    await test(`altération détectée — ${name}`, async () => {
      const report = await verifyLocalMedia({
        mediaDir: caseSet(mutate),
        assets: assets.data,
        voice: voice.data
      });

      expectInvalid(report, pattern, "recontrôle disque");

      assert(
        report.files.length < 7,
        "un fichier fautif figure parmi les fichiers vérifiés"
      );
    });
  }

  const manifestAlterations = [
    [
      "empreinte du manifeste altérée",
      (a) => {
        a.assets[0].media.sha256 = "0".repeat(64);
      },
      /assets\[0\]: média modifié depuis l'inspection \(assets\/s01-g01-sh01\.mp4 — sha256\)/
    ],
    [
      "durée mesurée du manifeste altérée",
      (a, v) => {
        v.narration_units[1].audio.duration_seconds = 20;
      },
      /narration_units\[1\]: média modifié depuis l'inspection \(voice\/s02-g01\.mp3 — duration_seconds\)/
    ],
    [
      "référence du manifeste en traversal",
      (a) => {
        a.assets[0].media.path = "assets/../../outside.mp4";
      },
      /assets\[0\]: Local Media : remontée ou segment vide interdit/
    ],
    [
      "référence du manifeste en URL",
      (a, v) => {
        v.narration_units[0].audio.path =
          "https://exemple.invalid/s01-g01.wav";
      },
      /narration_units\[0\]: Local Media : référence distante ou URL interdite/
    ],
    [
      "référence du manifeste en chemin absolu",
      (a) => {
        a.assets[0].media.path = outside;
      },
      /assets\[0\]: Local Media : chemin absolu interdit/
    ],
    [
      "manifestes sans média local",
      (a, v) => {
        for (const asset of a.assets) {
          delete asset.media;
        }

        for (const unit of v.narration_units) {
          delete unit.audio;
        }
      },
      /assets\[0\]: aucun média local référencé/
    ],
    [
      "manifeste d'assets illisible",
      (a) => {
        delete a.assets;
      },
      /manifeste d'assets illisible/
    ]
  ];

  for (const [name, mutate, pattern] of manifestAlterations) {
    await test(`recontrôle → FAIL — ${name}`, async () => {
      const assetManifest = structuredClone(assets.data);
      const voiceManifest = structuredClone(voice.data);

      mutate(assetManifest, voiceManifest);

      expectInvalid(
        await verifyLocalMedia({
          mediaDir: base,
          assets: assetManifest,
          voice: voiceManifest
        }),
        pattern,
        "recontrôle disque"
      );
    });
  }

  await test("recontrôle : dossier média disparu → FAIL", async () => {
    await expectReject(
      () => verifyLocalMedia({
        mediaDir: path.join(fixtureRoot, "absent"),
        assets: assets.data,
        voice: voice.data
      }),
      /^Local Media : dossier média introuvable/
    );
  });

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 7. Assembly : propagation sans rendu ---");

  const target = buildTarget();
  let assembly = null;

  await test("plan référençant les médias inspectés, toujours unrendered", async () => {
    const filesBefore = listFiles(base);

    assembly = await runAssemblyAgent({
      assets: structuredClone(assets.data),
      voice: structuredClone(voice.data),
      target: target.video,
      testMode: true,
      mediaVerification: structuredClone(verification)
    });

    assert(
      assembly.validation.valid &&
      assembly.source_mapping_validation.valid &&
      assembly.data.status === "unrendered",
      "gates ou status inattendus"
    );

    assert(
      isDeepStrictEqual(assembly.data.video_track[0], {
        asset_id: "s01-g01-sh01",
        unit_id: "s01-g01",
        start_seconds: 0,
        end_seconds: 8,
        duration_seconds: 8,
        media: {
          path: "assets/s01-g01-sh01.mp4",
          kind: "video",
          duration_seconds: 8
        }
      }),
      `clip : ${JSON.stringify(assembly.data.video_track[0])}`
    );

    assert(
      isDeepStrictEqual(assembly.data.video_track[1].media, {
        path: "assets/s01-g01-sh02.png",
        kind: "image",
        duration_seconds: null
      }),
      `clip image : ${JSON.stringify(assembly.data.video_track[1])}`
    );

    assert(
      isDeepStrictEqual(assembly.data.audio_track[1], {
        unit_id: "s02-g01",
        start_seconds: 20,
        end_seconds: 40,
        duration_seconds: 20,
        audio: {
          path: "voice/s02-g01.mp3",
          duration_seconds: 21.5
        }
      }),
      `unité : ${JSON.stringify(assembly.data.audio_track[1])}`
    );

    assert(
      isDeepStrictEqual(listFiles(base), filesBefore),
      "Assembly a créé ou supprimé un fichier média"
    );
  });

  await test("la timeline garde les durées prévues ; les mesures sont dans les références", () => {
    assert(
      assembly.data.summary.total_duration_seconds === 40 &&
      assembly.data.video_track[2].duration_seconds === 5 &&
      assembly.data.video_track[2].media.duration_seconds === 6,
      "durées prévues ou mesurées inattendues"
    );
  });

  const assemblyFailures = [
    [
      "médias référencés sans rapport de recontrôle",
      input => {
        delete input.mediaVerification;
      },
      /Source Mapping Gate\..*médias locaux référencés sans rapport de vérification disque/
    ],
    [
      "rapport de recontrôle en échec",
      input => {
        input.mediaVerification.valid = false;
        input.mediaVerification.errors.push(
          "assets[0]: Local Media : fichier média absent (assets/s01-g01-sh01.mp4)"
        );
      },
      /Source Mapping Gate\..*vérification disque des médias en échec — assets\[0\]: Local Media : fichier média absent/
    ],
    [
      "fichier absent du rapport",
      input => {
        input.mediaVerification.files.shift();
      },
      /Source Mapping Gate\..*média non vérifié sur disque : assets\/s01-g01-sh01\.mp4/
    ],
    [
      "empreinte du rapport différente du manifeste",
      input => {
        input.mediaVerification.files[5].sha256 = "0".repeat(64);
      },
      /Source Mapping Gate\..*média non vérifié sur disque : voice\/s01-g01\.wav/
    ],
    [
      "rapport d'un autre périmètre",
      input => {
        input.mediaVerification.scope = "contracts_only";
      },
      /Source Mapping Gate\..*médias locaux référencés sans rapport de vérification disque/
    ],
    [
      "assets résolus mais voix non synthétisée",
      input => {
        for (const unit of input.voice.narration_units) {
          unit.status = "unsynthesized";
          delete unit.audio;
        }
      },
      /Assembly Gate\..*références média partielles interdites : 5 élément\(s\) sur 7/
    ],
    [
      "voix synthétisée mais assets non résolus",
      input => {
        for (const asset of input.assets.assets) {
          asset.status = "unresolved";
          delete asset.media;
        }
      },
      /Assembly Gate\..*références média partielles interdites : 2 élément\(s\) sur 7/
    ],
    [
      "asset resolved_local sans média",
      input => {
        delete input.assets.assets[0].media;
      },
      /manifeste d'assets source invalide\..*status "resolved_local" sans média local inspecté/
    ],
    [
      "voice synthesized_local sans audio",
      input => {
        delete input.voice.narration_units[0].audio;
      },
      /manifeste voice source invalide\..*status "synthesized_local" sans audio local inspecté/
    ],
    [
      "référence d'asset en URL",
      input => {
        input.assets.assets[0].media.path =
          "https://exemple.invalid/s01-g01-sh01.mp4";
      },
      /manifeste d'assets source invalide\..*path ne doit pas être une URL/
    ]
  ];

  for (const [name, mutate, pattern] of assemblyFailures) {
    await test(`Assembly → FAIL — ${name}`, async () => {
      const input = {
        assets: structuredClone(assets.data),
        voice: structuredClone(voice.data),
        target: target.video,
        testMode: true,
        mediaVerification: structuredClone(verification)
      };

      mutate(input);

      await expectReject(
        () => runAssemblyAgent(input),
        pattern
      );
    });
  }

  await test("Assembly → FAIL — rapport de recontrôle fourni sans aucun média", async () => {
    const contracts = await buildArtifacts();

    await expectReject(
      () => runAssemblyAgent({
        assets: contracts.assets.data,
        voice: contracts.voice.data,
        target: target.video,
        testMode: true,
        mediaVerification: structuredClone(verification)
      }),
      /Source Mapping Gate\..*rapport de vérification média fourni sans média local référencé/
    );
  });

  await test("Assembly → FAIL — média réellement supprimé avant l'étape", async () => {
    const directory = caseSet(targetDirectory => {
      fs.rmSync(assetFile(targetDirectory, "s01-g01-sh03.mp4"));
    });

    await expectReject(
      async () => runAssemblyAgent({
        assets: structuredClone(assets.data),
        voice: structuredClone(voice.data),
        target: target.video,
        testMode: true,
        mediaVerification: await verifyLocalMedia({
          mediaDir: directory,
          assets: assets.data,
          voice: voice.data
        })
      }),
      /Source Mapping Gate\..*vérification disque des médias en échec — assets\[2\]: Local Media : fichier média absent \(assets\/s01-g01-sh03\.mp4\)/
    );
  });

  const planCases = [
    [
      "référence retirée d'un clip",
      plan => {
        delete plan.video_track[0].media;
      },
      /références média partielles interdites : 6 élément\(s\) sur 7/,
      /video_track\[0\]: media différent du média de l'asset source/
    ],
    [
      "référence de clip vers un autre fichier",
      plan => {
        plan.video_track[0].media.path = "assets/s01-g01-sh01.mov";
      },
      null,
      /video_track\[0\]: media différent du média de l'asset source/
    ],
    [
      "référence de clip en URL",
      plan => {
        plan.video_track[0].media.path =
          "https://exemple.invalid/s01-g01-sh01.mp4";
      },
      /video_track\[0\]\.media: path ne doit pas être une URL/,
      /video_track\[0\]: media différent du média de l'asset source/
    ],
    [
      "référence de clip en traversal",
      plan => {
        plan.video_track[0].media.path =
          "assets/../../s01-g01-sh01.mp4";
      },
      /video_track\[0\]\.media: path ne doit contenir ni remontée/,
      /video_track\[0\]: media différent du média de l'asset source/
    ],
    [
      "référence de clip vers l'asset d'un autre clip",
      plan => {
        plan.video_track[0].media.path = "assets/s02-g01-sh02.mp4";
      },
      /video_track\[0\]\.media: path doit être assets\/<asset_id>\.<extension>/,
      /video_track\[0\]: media différent du média de l'asset source/
    ],
    [
      "durée mesurée d'audio altérée dans le plan",
      plan => {
        plan.audio_track[1].audio.duration_seconds = 20;
      },
      null,
      /audio_track\[1\]: audio différent de l'audio de l'unité source/
    ],
    [
      "champ inconnu dans une référence (rendered_file)",
      plan => {
        plan.video_track[0].media.rendered_file = "final.mp4";
      },
      /video_track\[0\]\.media: champ rendered_file non autorisé/,
      /video_track\[0\]: media différent du média de l'asset source/
    ],
    [
      "status rendered",
      plan => {
        plan.status = "rendered";
      },
      /status doit être "unrendered"/,
      null
    ]
  ];

  for (const [name, mutate, gate, mapping] of planCases) {
    await test(`plan altéré → FAIL — ${name}`, () => {
      const plan = structuredClone(assembly.data);

      mutate(plan);

      const gateVerdict = validateAssemblyPlan(plan);

      if (gate === null) {
        expectValid(gateVerdict, "Assembly Gate");
      } else {
        expectInvalid(gateVerdict, gate, "Assembly Gate");
      }

      const mappingVerdict = validateAssemblySourceMapping(
        plan,
        assets.data,
        voice.data,
        target.video,
        verification
      );

      if (mapping === null) {
        expectValid(mappingVerdict, "Source Mapping Gate");
      } else {
        expectInvalid(mappingVerdict, mapping, "Source Mapping Gate");
      }
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 8. Quality : périmètre explicite, jamais de vidéo finale ---");

  async function mediaArtifacts() {
    const contracts = await buildArtifacts();

    return {
      ...contracts,
      assets: structuredClone(assets),
      voice: structuredClone(voice),
      assembly: structuredClone(assembly)
    };
  }

  let quality = null;

  await test("audit avec médias locaux → scope local_media, final_video not_rendered", async () => {
    const input = await mediaArtifacts();
    const snapshot = structuredClone(input);

    quality = await runQualityAgent({
      artifacts: input,
      target: buildTarget(),
      testMode: true,
      mediaVerification: structuredClone(verification)
    });

    assert(
      isDeepStrictEqual(quality.data.media, {
        scope: "local_media",
        final_video: "not_rendered",
        assets_inspected: 5,
        narration_units_inspected: 2,
        estimated_narration_seconds: 40,
        measured_narration_seconds: 41.5
      }),
      `media : ${JSON.stringify(quality.data.media)}`
    );

    assert(
      isDeepStrictEqual(
        quality.data.checks.map(check => check.id),
        [...QUALITY_CHECK_IDS, "media_files"]
      ) &&
      quality.data.checks.every(
        check => check.valid && check.errors.length === 0
      ) &&
      quality.data.verdict === "pass" &&
      quality.validation.valid,
      "contrôles inattendus"
    );

    assert(
      isDeepStrictEqual(input, snapshot),
      "Quality a modifié un artefact"
    );
  });

  await test("warnings non bloquants : résolution et écart de durée audio", () => {
    assert(
      isDeepStrictEqual(quality.data.warnings, [
        "durée totale 40s hors de la cible 25–30 min — non bloquant en mode test",
        "5 média(s) sous la résolution cible 3840x2160",
        "s02-g01: durée audio mesurée 21.5s, estimée 20s (écart +1.5s)"
      ]),
      `warnings : ${JSON.stringify(quality.data.warnings)}`
    );
  });

  await test("warnings non bloquants : ratio et cadence différents", async () => {
    const directory = caseSet(targetDirectory => {
      generateVideo(
        assetFile(targetDirectory, "s01-g01-sh01.mp4"),
        { seconds: 8, size: "320x240", fps: 25 }
      );
    });

    const records = await inspectLocalAssets({ mediaDir: directory });

    const altAssets = await runAssetAgent({
      visual: buildVisual(),
      testMode: true,
      localMedia: records
    });

    const altReport = await verifyLocalMedia({
      mediaDir: directory,
      assets: altAssets.data,
      voice: voice.data
    });

    const altAssembly = await runAssemblyAgent({
      assets: altAssets.data,
      voice: voice.data,
      target: target.video,
      testMode: true,
      mediaVerification: altReport
    });

    const output = await runQualityAgent({
      artifacts: {
        ...(await buildArtifacts()),
        assets: altAssets,
        voice: structuredClone(voice),
        assembly: altAssembly
      },
      target: buildTarget(),
      testMode: true,
      mediaVerification: altReport
    });

    assert(
      output.data.warnings.includes(
        "1 média(s) au ratio différent de 16:9"
      ) &&
      output.data.warnings.includes(
        "1 vidéo(s) à une cadence différente de 30 images/s"
      ),
      `warnings : ${JSON.stringify(output.data.warnings)}`
    );
  });

  await test("audit sans média → scope contracts_only, final_video not_rendered", async () => {
    const output = await runQualityAgent({
      artifacts: await buildArtifacts(),
      target: buildTarget(),
      testMode: true
    });

    assert(
      isDeepStrictEqual(output.data.media, {
        scope: "contracts_only",
        final_video: "not_rendered"
      }) &&
      isDeepStrictEqual(
        output.data.checks.map(check => check.id),
        QUALITY_CHECK_IDS
      ),
      `media : ${JSON.stringify(output.data.media)}`
    );
  });

  await test("aucun rapport ne prétend qu'une vidéo finale existe", async () => {
    const contractsOnly = await runQualityAgent({
      artifacts: await buildArtifacts(),
      target: buildTarget(),
      testMode: true
    });

    for (const report of [quality, contractsOnly]) {
      assert(
        report.data.media.final_video === "not_rendered" &&
        !/production.ready|final.video.valid|render.validated|"rendered"|final\.mp4/i.test(
          JSON.stringify(report)
        ),
        "le rapport suggère une vidéo finale"
      );
    }
  });

  const qualityFailures = [
    [
      "médias référencés mais aucun recontrôle fourni",
      input => {
        delete input.mediaVerification;
      },
      "[assembly_source_mapping] médias locaux référencés sans rapport de vérification disque"
    ],
    [
      "recontrôle en échec (fichier absent)",
      input => {
        input.mediaVerification.valid = false;
        input.mediaVerification.errors.push(
          "assets[0]: Local Media : fichier média absent (assets/s01-g01-sh01.mp4)"
        );
        input.mediaVerification.files.shift();
      },
      "[media_files] assets[0]: Local Media : fichier média absent (assets/s01-g01-sh01.mp4)"
    ],
    [
      "recontrôle incomplet",
      input => {
        input.mediaVerification.files.pop();
      },
      "[media_files] 6 fichier(s) vérifié(s) sur disque pour 7 attendu(s)"
    ],
    [
      "recontrôle invalide sans erreur listée",
      input => {
        input.mediaVerification.valid = false;
      },
      "[media_files] rapport de vérification média en échec"
    ],
    [
      "recontrôle d'un autre périmètre",
      input => {
        input.mediaVerification.scope = "contracts_only";
      },
      "[media_files] rapport de vérification média absent ou invalide"
    ],
    [
      "empreinte du manifeste altérée après le montage",
      input => {
        input.artifacts.assets.data.assets[0].media.sha256 =
          "0".repeat(64);
      },
      "[assembly_source_mapping] média non vérifié sur disque : assets/s01-g01-sh01.mp4"
    ],
    [
      "référence du plan différente du manifeste",
      input => {
        input.artifacts.assembly.data.audio_track[0].audio.path =
          "voice/s01-g01.mp3";
      },
      "[assembly_source_mapping] audio_track[0]: audio différent de l'audio de l'unité source"
    ],
    [
      "asset resolved_local sans média",
      input => {
        delete input.artifacts.assets.data.assets[0].media;
      },
      '[structure] assets.json: assets[0]: status "resolved_local" sans média local inspecté'
    ],
    [
      "voice synthesized_local sans audio",
      input => {
        delete input.artifacts.voice.data.narration_units[0].audio;
      },
      '[structure] voice.json: narration_units[0]: status "synthesized_local" sans audio local inspecté'
    ],
    [
      "plan prétendu rendu",
      input => {
        input.artifacts.assembly.data.status = "rendered";
      },
      '[structure] assembly.json: status doit être "unrendered"'
    ]
  ];

  for (const [name, mutate, expected] of qualityFailures) {
    await test(`Quality → FAIL — ${name}`, async () => {
      const input = {
        artifacts: await mediaArtifacts(),
        target: buildTarget(),
        testMode: true,
        mediaVerification: structuredClone(verification)
      };

      mutate(input);

      const error = await expectReject(
        () => runQualityAgent(input),
        /^Quality Agent : audit rejeté\./
      );

      const [id, detail] = [
        expected.slice(0, expected.indexOf("]") + 1),
        expected.slice(expected.indexOf("]") + 2)
      ];

      assert(
        error.message
          .split(" || ")
          .some(
            block =>
              block.includes(`${id} `) && block.includes(detail)
          ),
        `contrôle ${id} attendu avec « ${detail} » — obtenu : ${error.message}`
      );
    });
  }

  await test("Quality → FAIL — recontrôle fourni alors qu'aucun média n'est rattaché", async () => {
    const error = await expectReject(
      async () => runQualityAgent({
        artifacts: await buildArtifacts(),
        target: buildTarget(),
        testMode: true,
        mediaVerification: structuredClone(verification)
      }),
      /^Quality Agent : audit rejeté\./
    );

    assert(
      error.message.includes(
        "[assembly_source_mapping] rapport de vérification média fourni sans média local référencé"
      ) &&
      error.message.includes(
        "[media_files] assets.json: 5 asset(s) sans média local"
      ),
      `erreur inattendue : ${error.message}`
    );
  });

  await test("Quality → FAIL — média réellement modifié avant l'audit", async () => {
    const directory = caseSet(targetDirectory => {
      fs.appendFileSync(
        voiceFile(targetDirectory, "s02-g01.mp3"),
        "altération"
      );
    });

    const error = await expectReject(
      async () => runQualityAgent({
        artifacts: await mediaArtifacts(),
        target: buildTarget(),
        testMode: true,
        mediaVerification: await verifyLocalMedia({
          mediaDir: directory,
          assets: assets.data,
          voice: voice.data
        })
      }),
      /^Quality Agent : audit rejeté\./
    );

    assert(
      error.message.includes(
        "[media_files] narration_units[1]: média modifié depuis l'inspection (voice/s02-g01.mp3"
      ),
      `erreur inattendue : ${error.message}`
    );
  });

  const reportCases = [
    [
      "bloc media absent",
      report => {
        delete report.media;
      },
      /media: périmètre absent ou invalide/
    ],
    [
      "scope inconnu",
      report => {
        report.media.scope = "production_ready";
      },
      /media: périmètre absent ou invalide/
    ],
    [
      "final_video rendered",
      report => {
        report.media.final_video = "rendered";
      },
      /media: final_video doit être "not_rendered"/
    ],
    [
      "final_video absent",
      report => {
        delete report.media.final_video;
      },
      /media: champ final_video manquant/
    ],
    [
      "scope local_media sans le contrôle média",
      report => {
        report.checks.pop();
      },
      /checks ne contient pas exactement les contrôles attendus/
    ],
    [
      "scope contracts_only avec des compteurs média",
      report => {
        report.media.scope = "contracts_only";
      },
      /media: champ assets_inspected non autorisé/
    ],
    [
      "compteur média nul",
      report => {
        report.media.assets_inspected = 0;
      },
      /media: assets_inspected invalide/
    ],
    [
      "champ inconnu dans media (final_video_path)",
      report => {
        report.media.final_video_path = "output/final.mp4";
      },
      /media: champ final_video_path non autorisé/
    ]
  ];

  for (const [name, mutate, pattern] of reportCases) {
    await test(`rapport Quality altéré → FAIL — ${name}`, () => {
      const report = structuredClone(quality.data);

      mutate(report);

      expectInvalid(
        validateQualityReport(report),
        pattern,
        "Quality Gate"
      );
    });
  }

  // ----------------------------------------------------------------
  console.log("");
  console.log("--- 9. Zéro API, zéro réseau, aucun rendu ---");

  await test("couche média : lancement sans shell, protocole file seul, aucun module réseau", () => {
    const allowed = {
      "src/media/probe.js": ["node:path", "node:child_process"],
      "src/media/local-media.js": [
        "node:fs",
        "node:path",
        "node:crypto",
        "./probe.js"
      ]
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
        !/\bfetch\s*\(|node:https?|node:net|node:dns|shell\s*:|execSync|\bspawn|createMessage|ffmpeg/.test(
          source
        ),
        `${file} : réseau, shell, modèle ou rendu détecté`
      );
    }

    assert(
      isDeepStrictEqual(
        [...FFPROBE_ARGUMENTS].slice(0, 4),
        ["-v", "error", "-protocol_whitelist", "file"]
      ),
      `arguments ffprobe : ${FFPROBE_ARGUMENTS}`
    );
  });

  await test("sonde volontaire : ffprobe refuse une URL réseau (protocole hors liste)", async () => {
    const stderr = await new Promise(resolve => {
      execFile(
        "ffprobe",
        [...FFPROBE_ARGUMENTS, "-i", "http://127.0.0.1:9/video.mp4"],
        { timeout: 10000 },
        (error, stdout, output) => {
          resolve(`${error ? "EXIT" : "OK"} ${output}`);
        }
      );
    });

    assert(
      stderr.startsWith("EXIT") &&
      /Protocol 'http' not on whitelist 'file'/.test(stderr),
      `ffprobe n'a pas refusé le protocole : ${stderr}`
    );
  });

  await test("agents 4 à 7 : aucun accès direct à la couche média ni au disque", () => {
    for (const file of [
      "src/agents/asset.js",
      "src/agents/voice.js",
      "src/agents/assembly.js",
      "src/agents/quality.js",
      "src/utils/validate-asset-manifest.js",
      "src/utils/validate-voice-manifest.js",
      "src/utils/validate-assembly-plan.js",
      "src/utils/validate-quality-report.js"
    ]) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");

      assert(
        !/\/media\/|node:fs|child_process|ffprobe|process\.env/.test(
          source
        ),
        `${file} : accès direct au disque ou à la couche média`
      );
    }
  });

  await test("aucun final.mp4 ni rendu : seuls les faux médias du test existent", () => {
    const rendered = listFiles(fixtureRoot).filter(
      file =>
        /final|render|output/i.test(path.basename(file))
    );

    assert(
      rendered.length === 0,
      `fichiers de rendu inattendus : ${rendered}`
    );

    // output/ peut contenir de vrais rendus : ce smoke doit seulement
    // prouver qu'il n'y a lui-même rien créé ni supprimé.
    assert(
      isDeepStrictEqual(listOutputDirectory(), outputBefore),
      `output/ modifié par le smoke : ${listOutputDirectory()}`
    );

    for (const directory of ["tmp"]) {
      const target = path.join(ROOT, directory);

      const strangers = fs.existsSync(target)
        ? fs.readdirSync(target).filter(
            name =>
              !name.startsWith(".") &&
              !name.startsWith("r9-media-")
          )
        : [];

      assert(
        strangers.length === 0,
        `${directory}/ contient des fichiers inattendus : ${strangers}`
      );
    }
  });

  await test("fonctionne sans ANTHROPIC_FIXTURES ni clé API", () => {
    assert(
      !("ANTHROPIC_FIXTURES" in process.env) &&
      !("ANTHROPIC_API_KEY" in process.env),
      "ANTHROPIC_FIXTURES ou une clé est présente dans le processus"
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
  // Le test ne supprime que le dossier de fixtures qu'il a créé.
  removeMediaFixtureRoot(fixtureRoot);
}

await test("dossier de fixtures du test supprimé", () => {
  assert(
    !fs.existsSync(fixtureRoot),
    `dossier encore présent : ${fixtureRoot}`
  );
});

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API réelle utilisée : NON");
console.log("Vidéo finale rendue : NON");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — couche média locale"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — couche média locale : inspection ffprobe, contrats résolus, fail-closed, zéro API, aucun rendu"
);

process.exit(0);
