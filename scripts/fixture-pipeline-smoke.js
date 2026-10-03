// Smoke du pipeline local intégré — zéro API.
//
// Usage :
//   NO_API=1 node scripts/fixture-pipeline-smoke.js
//
// Lance src/orchestrator/mvp.js --research-script dans un processus
// enfant par scénario, sans aucune clé dans l'environnement et sous
// garde réseau, puis inspecte les artefacts écrits dans projects/.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  validateAssetManifest,
  validateAssetManifestMapping
} from "../src/utils/validate-asset-manifest.js";

import {
  validateVoiceManifest,
  validateVoiceManifestMapping
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
  verifyLocalMedia
} from "../src/media/local-media.js";

import {
  copyMediaSet,
  createMediaFixtureRoot,
  generateCanonicalMediaSet,
  generateVideo,
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
const PROJECTS = path.join(ROOT, "projects");

const FAULT_INJECTOR = path.join(
  ROOT,
  "scripts",
  "pipeline-fault-injector.js"
);

// Ordre du pipeline : [id de l'agent, nom de son artefact].
const PIPELINE = [
  ["research", "research"],
  ["script", "script"],
  ["visual_director", "visual"],
  ["asset", "assets"],
  ["voice", "voice"],
  ["assembly", "assembly"],
  ["quality", "quality"]
];

const FINAL_STATUS =
  "research_script_visual_asset_voice_assembly_quality_pass";

const FIXTURE_USAGE_IDS = {
  research: "research",
  script: "script",
  visual: "visual-director"
};

let failed = 0;
let passed = 0;

const createdProductions = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function listProductions() {
  return fs.existsSync(PROJECTS)
    ? fs.readdirSync(PROJECTS).sort()
    : [];
}

function readArtifact(productionId, filename) {
  const target = path.join(PROJECTS, productionId, filename);

  return fs.existsSync(target)
    ? JSON.parse(fs.readFileSync(target, "utf8"))
    : null;
}

// Faux médias locaux (tmp/r9-media-*), fabriqués une fois puis copiés
// pour chaque cas qui en a besoin. Supprimés en fin de smoke.
let mediaFixtureRoot = null;
let mediaCaseCounter = 0;

// Copie indépendante du jeu de faux médias ; `prepare` peut l'altérer
// avant le lancement du pipeline.
function prepareMediaDir(prepare) {
  if (mediaFixtureRoot === null) {
    mediaFixtureRoot = createMediaFixtureRoot();

    generateCanonicalMediaSet(
      path.join(mediaFixtureRoot, "base")
    );
  }

  mediaCaseCounter += 1;

  const directory = copyMediaSet(
    path.join(mediaFixtureRoot, "base"),
    path.join(mediaFixtureRoot, `case-${mediaCaseCounter}`)
  );

  if (typeof prepare === "function") {
    prepare(directory);
  }

  return directory;
}

function runPipeline({
  fixtures,
  scenario,
  fault,
  media,
  mediaDirArgument,
  extraArgs = []
}) {
  // media : le pipeline reçoit --media-dir vers un jeu de faux médias.
  // mediaDirArgument : valeur brute de --media-dir (cas invalides).
  const mediaDir = media ? prepareMediaDir(media) : null;
  const mediaArgument = mediaDirArgument ?? mediaDir;

  if (mediaArgument) {
    extraArgs = [...extraArgs, `--media-dir=${mediaArgument}`];
  }

  // Environnement minimal : aucune clé, aucun secret hérité.
  const env = {
    PATH: process.env.PATH,
    NO_API: "1"
  };

  if (fixtures) {
    env.ANTHROPIC_FIXTURES = "1";
  }

  if (scenario !== undefined) {
    env.ANTHROPIC_FIXTURE_SCENARIO = scenario;
  }

  // L'injecteur de fautes n'est préchargé que pour les cas qui le
  // demandent explicitement.
  const preload = ["--import", GUARD];

  if (fault !== undefined) {
    env.PIPELINE_FAULT = fault;
    preload.push("--import", FAULT_INJECTOR);
  }

  const before = listProductions();

  const child = spawnSync(
    process.execPath,
    [
      ...preload,
      "src/orchestrator/mvp.js",
      "--research-script",
      ...extraArgs
    ],
    {
      cwd: ROOT,
      env,
      encoding: "utf8"
    }
  );

  const created = listProductions().filter(
    name => !before.includes(name)
  );

  createdProductions.push(...created);

  const guardLine = child.stderr.match(
    /\[fixture-network-guard\] actif — tentatives bloquées : (\d+)/
  );

  const productionId =
    child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null;

  const injectorLine = child.stderr.match(
    /\[pipeline-fault-injector\] faute (\S+) — injections : (\d+)/
  );

  const run = {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created,
    productionId,
    guardActive: guardLine !== null,
    blockedAttempts: guardLine ? Number(guardLine[1]) : null,
    fault,
    mediaDir,
    mediaArgument,
    mediaVerification: undefined,
    injectedFault: injectorLine ? injectorLine[1] : null,
    injections: injectorLine ? Number(injectorLine[2]) : null,
    files: productionId
      ? fs.readdirSync(path.join(PROJECTS, productionId)).sort()
      : [],
    production: productionId
      ? readArtifact(productionId, "production.json")
      : null
  };

  for (const [, artifact] of PIPELINE) {
    run[artifact] = productionId
      ? readArtifact(productionId, `${artifact}.json`)
      : null;
  }

  return run;
}

function agentState(run, id) {
  return run.production.agents.find(agent => agent.id === id);
}

function collectUsageModels(value, models = []) {
  if (Array.isArray(value)) {
    value.forEach(item => collectUsageModels(item, models));
  } else if (value && typeof value === "object") {
    if (
      typeof value.model === "string" &&
      "stop_reason" in value
    ) {
      models.push(value.model);
    }

    Object.values(value).forEach(
      item => collectUsageModels(item, models)
    );
  }

  return models;
}

function assertCommon(run) {
  assert(
    run.guardActive,
    "le garde réseau n'a pas rendu son bilan"
  );

  assert(
    run.blockedAttempts === 0,
    `tentatives réseau/SDK bloquées : ${run.blockedAttempts}`
  );

  assert(
    run.productionId &&
    run.created.length === 1 &&
    run.created[0] === run.productionId,
    `productions créées inattendues : ${run.created}`
  );

  assert(run.production, "production.json absent");

  // L'injecteur de fautes ne s'active que sur demande explicite, et
  // injecte alors exactement une faute.
  if (run.fault === undefined) {
    assert(
      run.injectedFault === null,
      "injecteur de fautes actif sans avoir été demandé"
    );
  } else {
    assert(
      run.injectedFault === run.fault && run.injections === 1,
      `faute ${run.fault} : ${run.injections} injection(s)`
    );
  }

  // Aucun média, aucun fichier hors artefacts JSON attendus.
  const allowedFiles = [
    "production.json",
    "truth.json",
    "truth-report.md",
    ...PIPELINE.map(([, artifact]) => `${artifact}.json`)
  ];

  assert(
    run.files.every(file => allowedFiles.includes(file)),
    `fichiers inattendus dans la production : ${run.files}`
  );

  // Les médias sont référencés en place, jamais copiés ; le dossier
  // fourni est tracé dans production.json, et seulement s'il est fourni.
  assert(
    (run.production.input.media_dir ?? null) ===
      (run.mediaArgument ?? null),
    `production.json : media_dir=${run.production.input.media_dir}`
  );

  for (const [name, fixtureId] of Object.entries(FIXTURE_USAGE_IDS)) {
    const artifact = run[name];

    if (!artifact) {
      continue;
    }

    assert(
      artifact.usage?.model === `fixture:${fixtureId}`,
      `${name}.json : usage.model=${artifact.usage?.model}`
    );

    const models = collectUsageModels(artifact);

    assert(
      models.length > 0 &&
      models.every(model => model.startsWith("fixture:")),
      `${name}.json : usage non fixture — ${models}`
    );
  }
}

function assertAssets(run) {
  const { assets, visual } = run;

  assert(
    assets.agent === "asset" &&
    assets.usage === null &&
    assets.validation.valid === true &&
    assets.visual_mapping_validation.valid === true,
    "assets.json : enveloppe ou gates persistés invalides"
  );

  const validation = validateAssetManifest(assets.data);

  assert(
    validation.valid,
    `assets.json : ${validation.errors.join(" | ")}`
  );

  const mapping = validateAssetManifestMapping(
    assets.data,
    visual.data
  );

  assert(
    mapping.valid,
    `assets.json / visual.json : ${mapping.errors.join(" | ")}`
  );

  // Sans --media-dir : contrat historique. Avec : tout est résolu.
  const expectedStatus = run.mediaDir
    ? "resolved_local"
    : "unresolved";

  assert(
    assets.data.assets.length === groundingShots(run).length &&
    assets.data.assets.every(
      asset =>
        asset.status === expectedStatus &&
        Object.hasOwn(asset, "media") === Boolean(run.mediaDir)
    ),
    `assets.json : un asset ${expectedStatus} par shot attendu`
  );

  assert(
    !/https?:\/\//i.test(JSON.stringify(assets.data)),
    "assets.json contient une URL"
  );
}

function assertVoice(run) {
  const { voice, script } = run;

  assert(
    voice.agent === "voice" &&
    voice.usage === null &&
    voice.validation.valid === true &&
    voice.script_mapping_validation.valid === true,
    "voice.json : enveloppe ou gates persistés invalides"
  );

  const validation = validateVoiceManifest(voice.data);

  assert(
    validation.valid,
    `voice.json : ${validation.errors.join(" | ")}`
  );

  const mapping = validateVoiceManifestMapping(
    voice.data,
    script.data
  );

  assert(
    mapping.valid,
    `voice.json / script.json : ${mapping.errors.join(" | ")}`
  );

  const expectedStatus = run.mediaDir
    ? "synthesized_local"
    : "unsynthesized";

  assert(
    voice.data.narration_units.length ===
      coverageSegments(run).length &&
    voice.data.narration_units.every(
      unit =>
        unit.status === expectedStatus &&
        Object.hasOwn(unit, "audio") === Boolean(run.mediaDir)
    ),
    `voice.json : une unité ${expectedStatus} par segment attendue`
  );
}

function assertAssembly(run) {
  const { assembly, assets, voice, production } = run;

  assert(
    assembly.agent === "assembly" &&
    assembly.usage === null &&
    assembly.validation.valid === true &&
    assembly.source_mapping_validation.valid === true,
    "assembly.json : enveloppe ou gates persistés invalides"
  );

  const validation = validateAssemblyPlan(assembly.data);

  assert(
    validation.valid,
    `assembly.json : ${validation.errors.join(" | ")}`
  );

  const mapping = validateAssemblySourceMapping(
    assembly.data,
    assets.data,
    voice.data,
    production.target.video,
    run.mediaVerification
  );

  assert(
    mapping.valid,
    `assembly.json / sources : ${mapping.errors.join(" | ")}`
  );

  assert(
    assembly.data.status === "unrendered" &&
    assembly.data.video_track.length ===
      assets.data.assets.length &&
    assembly.data.audio_track.length ===
      voice.data.narration_units.length,
    "assembly.json : plan non rendu couvrant chaque asset et chaque unité attendu"
  );

  // Le plan ne référence des médias que s'ils ont été fournis.
  assert(
    assembly.data.video_track.every(
      clip =>
        Object.hasOwn(clip, "media") === Boolean(run.mediaDir)
    ) &&
    assembly.data.audio_track.every(
      unit =>
        Object.hasOwn(unit, "audio") === Boolean(run.mediaDir)
    ),
    "assembly.json : références média inattendues"
  );
}

function assertQuality(run) {
  const { quality } = run;

  assert(
    quality.agent === "quality" &&
    quality.usage === null &&
    quality.validation.valid === true,
    "quality.json : enveloppe ou gate persisté invalides"
  );

  const validation = validateQualityReport(quality.data);

  assert(
    validation.valid,
    `quality.json : ${validation.errors.join(" | ")}`
  );

  // Avec des médias locaux, un contrôle média s'ajoute aux 10 contrôles
  // de contrats.
  assert(
    quality.data.verdict === "pass" &&
    quality.data.title === run.script.data.title &&
    quality.data.checks.length ===
      QUALITY_CHECK_IDS.length + (run.mediaDir ? 1 : 0) &&
    quality.data.checks.every(
      check => check.valid === true && check.errors.length === 0
    ),
    "quality.json : verdict pass sur tous les contrôles attendu"
  );

  // Le rapport dit toujours ce qu'il a contrôlé, et jamais qu'une
  // vidéo finale existe.
  assert(
    quality.data.media.scope ===
      (run.mediaDir ? "local_media" : "contracts_only") &&
    quality.data.media.final_video === "not_rendered",
    `quality.json : périmètre inattendu ${JSON.stringify(quality.data.media)}`
  );

  assert(
    quality.data.metrics.assets ===
      run.assets.data.assets.length &&
    quality.data.metrics.narration_units ===
      run.voice.data.narration_units.length &&
    quality.data.metrics.total_video_seconds ===
      run.assembly.data.summary.total_duration_seconds,
    "quality.json : métriques incohérentes avec les artefacts"
  );

  // Le jeu de test dure 40 s : hors cible, non bloquant en mode test.
  // Avec les faux médias s'ajoutent la résolution sous la cible et
  // l'écart de durée de l'audio de 21,5 s.
  assert(
    quality.mode === "test" &&
    quality.data.warnings.length === (run.mediaDir ? 3 : 1) &&
    /hors de la cible .* non bloquant en mode test/.test(
      quality.data.warnings[0]
    ),
    `quality.json : warnings inattendus ${JSON.stringify(quality.data.warnings)}`
  );
}

function assertPass(run) {
  assertCommon(run);

  assert(
    run.status === 0,
    `code de sortie ${run.status}\n${run.stdout}\n${run.stderr}`
  );

  assert(
    run.production.status === FINAL_STATUS,
    `status=${run.production.status}`
  );

  for (const [id, artifact] of PIPELINE) {
    const state = agentState(run, id);

    assert(
      state.status === "completed" &&
      state.started_at !== null &&
      state.completed_at !== null &&
      state.error === null,
      `Agent ${id} : ${state.status}`
    );

    assert(run[artifact], `${artifact}.json attendu`);
  }

  assertAssets(run);
  assertVoice(run);
  assertAssembly(run);
  assertQuality(run);

  assert(
    run.research.agent === "research" &&
    run.research.validation.valid &&
    run.script.agent === "script" &&
    run.script.claim_coverage_validation.valid &&
    run.visual.agent === "visual_director" &&
    run.visual.validation.valid &&
    run.visual.script_mapping_validation.valid &&
    run.visual.factual_grounding_validation.valid,
    "gates persistés invalides"
  );

  assert(
    run.stdout.includes(
      "RESULTAT : PASS — RESEARCH -> SCRIPT -> VISUAL DIRECTOR -> ASSET -> VOICE -> ASSEMBLY -> QUALITY"
    ) &&
    run.stdout.includes("Agents 1-7 : EXECUTES") &&
    run.stdout.includes("Vidéo finale : NON RENDUE"),
    "bandeau final inattendu"
  );
}

function assertFail(run, { failedAgent, error, artifacts }) {
  assertCommon(run);

  assert(
    run.status === 1,
    `code de sortie ${run.status} (1 attendu)\n${run.stdout}`
  );

  assert(
    run.production.status === "failed",
    `status=${run.production.status}`
  );

  const state = agentState(run, failedAgent);

  assert(
    state.status === "failed" && error.test(state.error ?? ""),
    `Agent ${failedAgent} : ${state.status} — ${state.error}`
  );

  assert(
    run.stderr.includes("RESULTAT : FAIL — PIPELINE ARRETE"),
    "bandeau d'échec absent"
  );

  // Attente historique R5/R6, conservée telle quelle pour les
  // scénarios qui la déclarent.
  if (artifacts) {
    for (const name of ["research", "script", "visual"]) {
      const expected = artifacts.includes(name);

      assert(
        Boolean(run[name]) === expected,
        `${name}.json ${expected ? "attendu" : "inattendu"}`
      );
    }
  }

  // Amont : completed avec artefact. Agent en échec : aucun artefact.
  // Aval : jamais démarré, aucun artefact.
  const failedIndex = PIPELINE.findIndex(
    ([id]) => id === failedAgent
  );

  assert(failedIndex !== -1, `agent inconnu : ${failedAgent}`);

  PIPELINE.forEach(([id, artifact], index) => {
    const agent = agentState(run, id);

    if (index < failedIndex) {
      assert(
        agent.status === "completed" && run[artifact] !== null,
        `Agent ${id} : completed avec ${artifact}.json attendu (${agent.status})`
      );

      return;
    }

    assert(
      run[artifact] === null,
      `${artifact}.json ne doit pas exister`
    );

    if (index > failedIndex) {
      assert(
        agent.status === "pending" &&
        agent.started_at === null &&
        agent.completed_at === null,
        `Agent ${id} : ne doit pas démarrer (${agent.status})`
      );
    }
  });
}

function coverageSegments(run) {
  return run.script.claim_coverage_validation.segments;
}

function groundingShots(run) {
  return run.visual.factual_grounding_validation.shots;
}

const cases = [
  {
    name: "happy (scénario par défaut, variable absente)",
    fixtures: true,
    check(run) {
      assertPass(run);

      assert(
        coverageSegments(run).length === 2 &&
        coverageSegments(run).every(
          segment => segment.covered && !segment.repaired
        ),
        "aucun repair Script attendu"
      );

      assert(
        groundingShots(run).length === 5 &&
        groundingShots(run).every(
          shot => shot.grounded && !shot.repaired
        ),
        "aucun repair Visual attendu"
      );

      assert(
        !/https?:\/\//i.test(JSON.stringify(run.research.data)),
        "research.json contient une URL"
      );
    }
  },
  {
    name: "happy (scénario explicite)",
    fixtures: true,
    scenario: "happy",
    check: assertPass
  },
  {
    name: "script-coverage-repair",
    fixtures: true,
    scenario: "script-coverage-repair",
    check(run) {
      assertPass(run);

      const [first, second] = coverageSegments(run);

      assert(
        first.repaired === true &&
        first.covered === true &&
        first.initial_undeclared_claims.length === 1 &&
        first.initial_undeclared_claims[0].text ===
          "L'eau y est rare." &&
        first.undeclared_claims.length === 0 &&
        first.repair_usage?.model ===
          "fixture:repair-script-claim-coverage",
        "segment 0 : FAIL → repair → revalidation attendus"
      );

      assert(
        second.repaired === false && second.covered === true,
        "segment 1 : aucun repair attendu"
      );

      assert(
        !run.script.data.sections[0].segments[0].voiceover
          .includes("L'eau y est rare."),
        "le voiceover persisté contient encore l'affirmation rejetée"
      );

      assert(
        groundingShots(run).every(shot => !shot.repaired),
        "aucun repair Visual attendu"
      );
    }
  },
  {
    name: "visual-grounding-repair",
    fixtures: true,
    scenario: "visual-grounding-repair",
    check(run) {
      assertPass(run);

      const shots = groundingShots(run);
      const first = shots[0];

      assert(
        first.repaired === true &&
        first.grounded === true &&
        first.initial_unsupported_visual_claims.length === 3 &&
        first.unsupported_visual_claims.length === 0 &&
        first.repair_usage?.model ===
          "fixture:repair-visual-factual-grounding",
        "shot 0 : FAIL → repair → re-grounding attendus"
      );

      assert(
        shots.slice(1).every(
          shot => shot.grounded && !shot.repaired
        ),
        "seul le shot 0 doit être réparé"
      );

      const persisted =
        run.visual.data.sections[0].segments[0].shots[0];

      assert(
        persisted.visual_description ===
          "Vue aérienne d'une région aride australienne." &&
        persisted.asset_query ===
          "Australian arid region aerial",
        "visual.json ne contient pas le shot réparé"
      );

      assert(
        !/Outback|ocre|ochre/i.test(
          JSON.stringify(run.visual.data)
        ),
        "visual.json contient encore un détail non couvert"
      );

      assert(
        coverageSegments(run).every(segment => !segment.repaired),
        "aucun repair Script attendu"
      );
    }
  },
  {
    name: "script-coverage-unrepairable (le gate bloque)",
    fixtures: true,
    scenario: "script-coverage-unrepairable",
    check(run) {
      assertFail(run, {
        failedAgent: "script",
        error:
          /Voiceover Claim Coverage Gate.*non déclarées après réparation/,
        artifacts: ["research"]
      });

      assert(
        agentState(run, "visual_director").status === "pending",
        "Visual Director ne doit pas démarrer"
      );
    }
  },
  {
    name: "visual-grounding-unrepairable (le gate bloque)",
    fixtures: true,
    scenario: "visual-grounding-unrepairable",
    check(run) {
      assertFail(run, {
        failedAgent: "visual_director",
        error:
          /Visual Factual Grounding Gate.*non couvertes après réparation/,
        artifacts: ["research", "script"]
      });
    }
  },
  {
    name: "malformed-json (fixture cassée, sans API)",
    fixtures: true,
    scenario: "malformed-json",
    check(run) {
      assertFail(run, {
        failedAgent: "research",
        error: /^Research Agent : aucun objet JSON détecté/,
        artifacts: []
      });
    }
  },
  {
    name: "scénario inconnu → FAIL CLOSED",
    fixtures: true,
    scenario: "scenario-inconnu",
    check(run) {
      assertFail(run, {
        failedAgent: "research",
        error:
          /^ANTHROPIC_FIXTURES=1 — ANTHROPIC_FIXTURE_SCENARIO="scenario-inconnu" inconnu/,
        artifacts: []
      });
    }
  },
  {
    name: "titre non canonique → FAIL CLOSED",
    fixtures: true,
    extraArgs: ["--title=Un autre sujet"],
    check(run) {
      assertFail(run, {
        failedAgent: "research",
        error:
          /^ANTHROPIC_FIXTURES=1 — fixture "research" : sujet ou consigne hors du jeu de données canonique/,
        artifacts: []
      });
    }
  },
  {
    name: "fixtures désactivées + NO_API=1 → coupe-circuit",
    fixtures: false,
    check(run) {
      assertFail(run, {
        failedAgent: "research",
        error: /^NO_API=1 — appel Anthropic interdit/,
        artifacts: []
      });
    }
  },

  // Fautes injectées à la relecture disque : l'agent qui relit
  // l'artefact altéré doit échouer, et rien en aval ne doit démarrer.
  {
    name: "faute : visual.json altéré à la relecture → Asset échoue, Voice ne démarre pas",
    fixtures: true,
    fault: "asset-source-duplicate-order",
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Asset Agent : manifeste rejeté par le Asset Gate\..*asset_id dupliqué s01-g01-sh01/
      });
    }
  },
  {
    name: "faute : script.json altéré à la relecture → Voice échoue, Assembly ne démarre pas",
    fixtures: true,
    fault: "voice-source-empty-voiceover",
    check(run) {
      assertFail(run, {
        failedAgent: "voice",
        error:
          /^Voice Agent : script source invalide\..*voiceover manquant/
      });
    }
  },
  {
    name: "faute : voice.json altéré (+1 s) → Assembly échoue, Quality ne démarre pas",
    fixtures: true,
    fault: "assembly-source-duration-drift",
    check(run) {
      assertFail(run, {
        failedAgent: "assembly",
        error:
          /^Assembly Agent : plan rejeté par le Assembly Gate\..*fenêtre vidéo 0s–20s différente de la fenêtre narration 0s–21s/
      });
    }
  },
  {
    name: "faute : assets.json altéré (asset manquant) → Assembly échoue, Quality ne démarre pas",
    fixtures: true,
    fault: "assembly-source-missing-asset",
    check(run) {
      assertFail(run, {
        failedAgent: "assembly",
        error:
          /^Assembly Agent : plan rejeté par le Assembly Gate\..*fenêtre vidéo 20s–32s différente de la fenêtre narration 20s–40s/
      });
    }
  },
  {
    name: "faute : titre divergent dans visual.json → Quality échoue",
    fixtures: true,
    fault: "quality-title-divergence",
    check(run) {
      assertFail(run, {
        failedAgent: "quality",
        error:
          /^Quality Agent : audit rejeté\..*\[titles\] visual\.json: title différent de script\.json/
      });
    }
  },
  {
    name: "faute : narration altérée dans voice.json → Quality échoue",
    fixtures: true,
    fault: "quality-narration-text",
    check(run) {
      assertFail(run, {
        failedAgent: "quality",
        error:
          /^Quality Agent : audit rejeté\..*\[script_voice_mapping\] narration_units\[0\]: text différent du voiceover source/
      });
    }
  },
  {
    name: "faute : verdict persisté en échec dans script.json → Quality échoue",
    fixtures: true,
    fault: "quality-persisted-verdict",
    check(run) {
      assertFail(run, {
        failedAgent: "quality",
        error:
          /^Quality Agent : audit rejeté\..*\[persisted_verdicts\] script\.json: claim_coverage_validation n'est pas un PASS persisté/
      });
    }
  },
  {
    name: "faute : trou dans assembly.json → Quality échoue",
    fixtures: true,
    fault: "quality-assembly-gap",
    check(run) {
      assertFail(run, {
        failedAgent: "quality",
        error:
          /^Quality Agent : audit rejeté\..*\[structure\] assembly\.json: video_track\[1\]: trou entre 8s et 9s/
      });
    }
  },

  // ----------------------------------------------------------------
  // Couche média locale : le pipeline reçoit --media-dir vers de faux
  // médias fabriqués par le test (tmp/r9-media-*).
  // ----------------------------------------------------------------
  {
    name: "médias locaux : pipeline 1→7, assets et voix rattachés et inspectés",
    fixtures: true,
    media: true,
    check(run) {
      assertPass(run);

      const asset = run.assets.data.assets[0];

      assert(
        asset.media.path === "assets/s01-g01-sh01.mp4" &&
        asset.media.kind === "video" &&
        asset.media.duration_seconds === 8 &&
        /^[0-9a-f]{64}$/.test(asset.media.sha256) &&
        run.assets.data.assets[1].media.kind === "image",
        `asset résolu inattendu : ${JSON.stringify(asset.media)}`
      );

      const unit = run.voice.data.narration_units[1];

      // Estimation du script et durée mesurée restent distinctes.
      assert(
        unit.estimated_seconds === 20 &&
        unit.audio.path === "voice/s02-g01.mp3" &&
        unit.audio.duration_seconds === 21.5,
        `unité synthétisée inattendue : ${JSON.stringify(unit)}`
      );

      assert(
        run.assembly.data.audio_track[1].duration_seconds === 20 &&
        run.assembly.data.audio_track[1].audio.duration_seconds ===
          21.5 &&
        run.assembly.data.video_track[0].media.path ===
          asset.media.path,
        "assembly.json : références média inattendues"
      );

      assert(
        isDeepStrictEqual(run.quality.data.media, {
          scope: "local_media",
          final_video: "not_rendered",
          assets_inspected: 5,
          narration_units_inspected: 2,
          estimated_narration_seconds: 40,
          measured_narration_seconds: 41.5
        }),
        `quality.json : media ${JSON.stringify(run.quality.data.media)}`
      );

      assert(
        run.quality.data.warnings.includes(
          "5 média(s) sous la résolution cible 3840x2160"
        ) &&
        run.quality.data.warnings.includes(
          "s02-g01: durée audio mesurée 21.5s, estimée 20s (écart +1.5s)"
        ),
        `quality.json : warnings ${JSON.stringify(run.quality.data.warnings)}`
      );

      // Aucun chemin absolu ni dossier de la machine dans les artefacts.
      for (const [, artifact] of PIPELINE) {
        assert(
          !JSON.stringify(run[artifact]).includes(run.mediaDir),
          `${artifact}.json contient le chemin absolu du dossier média`
        );
      }
    }
  },
  {
    name: "médias locaux + visual-grounding-repair : le plan réparé est rattaché",
    fixtures: true,
    scenario: "visual-grounding-repair",
    media: true,
    check: assertPass
  },
  {
    name: "médias locaux : fichier d'asset absent → Asset échoue (tout ou rien)",
    fixtures: true,
    media(directory) {
      fs.rmSync(
        path.join(directory, "assets", "s01-g01-sh02.png")
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Asset Agent : média local manquant pour s01-g01-sh02\./
      });
    }
  },
  {
    name: "médias locaux : fichier d'asset corrompu → Asset échoue",
    fixtures: true,
    media(directory) {
      fs.truncateSync(
        path.join(directory, "assets", "s02-g01-sh01.mp4"),
        600
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Local Media : assets\/s02-g01-sh01\.mp4 — Media Inspector : fichier illisible par ffprobe/
      });
    }
  },
  {
    name: "médias locaux : fichier d'asset vide → Asset échoue",
    fixtures: true,
    media(directory) {
      fs.writeFileSync(
        path.join(directory, "assets", "s01-g01-sh01.mp4"),
        ""
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Local Media : fichier média vide \(assets\/s01-g01-sh01\.mp4\)/
      });
    }
  },
  {
    name: "médias locaux : audio fourni pour un asset visuel → Asset échoue",
    fixtures: true,
    media(directory) {
      fs.copyFileSync(
        path.join(directory, "voice", "s01-g01.wav"),
        path.join(directory, "assets", "s01-g01-sh01.mp4")
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Local Media : mauvais type de média \(assets\/s01-g01-sh01\.mp4\) : contenu audio, video attendu/
      });
    }
  },
  {
    name: "médias locaux : image fournie pour un asset stock_video → Asset échoue",
    fixtures: true,
    media(directory) {
      fs.rmSync(
        path.join(directory, "assets", "s01-g01-sh01.mp4")
      );
      fs.copyFileSync(
        path.join(directory, "assets", "s01-g01-sh02.png"),
        path.join(directory, "assets", "s01-g01-sh01.png")
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Asset Agent : manifeste rejeté par le Asset Gate\..*mauvais type de média — image fourni pour un asset stock_video/
      });
    }
  },
  {
    name: "médias locaux : vidéo plus courte que le besoin → Asset échoue",
    fixtures: true,
    media(directory) {
      generateVideo(
        path.join(directory, "assets", "s02-g01-sh01.mp4"),
        { seconds: 9 }
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Asset Agent : manifeste rejeté par le Asset Gate\..*média plus court \(9s\) que la durée nécessaire \(12s\)/
      });
    }
  },
  {
    name: "médias locaux : fichier sans asset correspondant → Asset échoue",
    fixtures: true,
    media(directory) {
      fs.copyFileSync(
        path.join(directory, "assets", "s01-g01-sh01.mp4"),
        path.join(directory, "assets", "s09-g01-sh01.mp4")
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Asset Agent : fichier média sans asset correspondant — s09-g01-sh01\./
      });
    }
  },
  {
    name: "médias locaux : fichier audio absent → Voice échoue, Assembly ne démarre pas",
    fixtures: true,
    media(directory) {
      fs.rmSync(path.join(directory, "voice", "s02-g01.mp3"));
    },
    check(run) {
      assertFail(run, {
        failedAgent: "voice",
        error: /^Voice Agent : audio local manquant pour s02-g01\./
      });
    }
  },
  {
    name: "médias locaux : vidéo fournie comme voix → Voice échoue",
    fixtures: true,
    media(directory) {
      fs.copyFileSync(
        path.join(directory, "assets", "s01-g01-sh01.mp4"),
        path.join(directory, "voice", "s01-g01.wav")
      );
    },
    check(run) {
      assertFail(run, {
        failedAgent: "voice",
        error:
          /^Local Media : mauvais type de média \(voice\/s01-g01\.wav\) : contenu video, audio attendu/
      });
    }
  },
  {
    name: "médias locaux : dossier média inexistant → Asset échoue",
    fixtures: true,
    mediaDirArgument: path.join(ROOT, "tmp", "r9-media-absent"),
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error: /^Local Media : dossier média introuvable/
      });
    }
  },
  {
    name: "médias locaux : URL à la place d'un dossier → Asset échoue",
    fixtures: true,
    mediaDirArgument: "https://exemple.invalid/medias",
    check(run) {
      assertFail(run, {
        failedAgent: "asset",
        error:
          /^Local Media : le dossier média doit être un chemin local, pas une URL/
      });
    }
  },

  // Média altéré APRÈS son inspection : détecté avant l'étape aval.
  {
    name: "faute média : asset modifié après inspection → Assembly échoue, Quality ne démarre pas",
    fixtures: true,
    media: true,
    fault: "media-asset-modified-before-assembly",
    check(run) {
      assertFail(run, {
        failedAgent: "assembly",
        error:
          /^Assembly Agent : plan rejeté par le Source Mapping Gate\..*vérification disque des médias en échec — assets\[0\]: média modifié depuis l'inspection \(assets\/s01-g01-sh01\.mp4/
      });
    }
  },
  {
    name: "faute média : audio supprimé après inspection → Assembly échoue, Quality ne démarre pas",
    fixtures: true,
    media: true,
    fault: "media-voice-deleted-before-assembly",
    check(run) {
      assertFail(run, {
        failedAgent: "assembly",
        error:
          /^Assembly Agent : plan rejeté par le Source Mapping Gate\..*narration_units\[0\]: Local Media : fichier média absent \(voice\/s01-g01\.wav\)/
      });
    }
  },
  {
    name: "faute média : asset supprimé après le montage → Quality échoue",
    fixtures: true,
    media: true,
    fault: "media-asset-deleted-before-quality",
    check(run) {
      assertFail(run, {
        failedAgent: "quality",
        error:
          /^Quality Agent : audit rejeté\..*\[media_files\] assets\[4\]: Local Media : fichier média absent \(assets\/s02-g01-sh02\.mp4\)/
      });
    }
  },
  {
    name: "faute média : audio modifié après le montage → Quality échoue",
    fixtures: true,
    media: true,
    fault: "media-voice-modified-before-quality",
    check(run) {
      assertFail(run, {
        failedAgent: "quality",
        error:
          /^Quality Agent : audit rejeté\..*\[media_files\] narration_units\[1\]: média modifié depuis l'inspection \(voice\/s02-g01\.mp3/
      });
    }
  },
  {
    name: "faute média : empreinte falsifiée dans assets.json → Assembly échoue",
    fixtures: true,
    media: true,
    fault: "media-manifest-sha-tampered",
    check(run) {
      assertFail(run, {
        failedAgent: "assembly",
        error:
          /^Assembly Agent : plan rejeté par le Source Mapping Gate\..*assets\[0\]: média modifié depuis l'inspection \(assets\/s01-g01-sh01\.mp4 — sha256\)/
      });
    }
  },
  {
    name: "faute média : référence en traversal dans assets.json → Assembly échoue",
    fixtures: true,
    media: true,
    fault: "media-manifest-path-traversal",
    check(run) {
      assertFail(run, {
        failedAgent: "assembly",
        error:
          /^Assembly Agent : manifeste d'assets source invalide\..*path ne doit contenir ni remontée ni segment vide/
      });
    }
  }
];

console.log("========================================");
console.log(" PIPELINE LOCAL FIXTURES — SMOKE (ZERO API)");
console.log("========================================");

try {
  for (const testCase of cases) {
    let run = null;

    try {
      run = runPipeline(testCase);

      // Recontrôle indépendant des médias référencés, pour les
      // assertions sur les productions réussies.
      if (run.mediaDir && run.status === 0) {
        run.mediaVerification = await verifyLocalMedia({
          mediaDir: run.mediaDir,
          assets: run.assets?.data,
          voice: run.voice?.data
        });
      }

      testCase.check(run);

      passed += 1;

      console.log(`PASS — ${testCase.name}`);
    } catch (error) {
      failed += 1;

      console.error(`FAIL — ${testCase.name}`);
      console.error(`       ${error?.message ?? error}`);
    }

    if (run) {
      console.log(
        `       projects/${run.productionId} — ` +
        `exit=${run.status} — ` +
        `status=${run.production?.status} — ` +
        `garde réseau : ${run.blockedAttempts} tentative(s) bloquée(s)`
      );
    }
  }
} finally {
  // Le smoke ne supprime que le dossier de faux médias qu'il a créé.
  if (mediaFixtureRoot !== null) {
    removeMediaFixtureRoot(mediaFixtureRoot);
  }
}

console.log("");
console.log("Productions créées par cette exécution :");

for (const name of createdProductions) {
  console.log(`  projects/${name}`);
}

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API Anthropic réelle utilisée : NON");
console.log("Agents 1-7 exécutés sur les scénarios valides : OUI");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — pipeline local fixtures"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — pipeline local complet Agents 1→7 prouvé sans API"
);

process.exit(0);
