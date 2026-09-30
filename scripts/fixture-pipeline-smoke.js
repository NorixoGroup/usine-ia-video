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

function runPipeline({ fixtures, scenario, fault, extraArgs = [] }) {
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
    ...PIPELINE.map(([, artifact]) => `${artifact}.json`)
  ];

  assert(
    run.files.every(file => allowedFiles.includes(file)),
    `fichiers inattendus dans la production : ${run.files}`
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

  assert(
    assets.data.assets.length === groundingShots(run).length &&
    assets.data.assets.every(
      asset => asset.status === "unresolved"
    ),
    "assets.json : un asset unresolved par shot attendu"
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

  assert(
    voice.data.narration_units.length ===
      coverageSegments(run).length &&
    voice.data.narration_units.every(
      unit => unit.status === "unsynthesized"
    ),
    "voice.json : une unité unsynthesized par segment attendue"
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
    production.target.video
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

  assert(
    quality.data.verdict === "pass" &&
    quality.data.title === run.script.data.title &&
    quality.data.checks.length === QUALITY_CHECK_IDS.length &&
    quality.data.checks.every(
      check => check.valid === true && check.errors.length === 0
    ),
    "quality.json : verdict pass sur tous les contrôles attendu"
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
  assert(
    quality.mode === "test" &&
    quality.data.warnings.length === 1 &&
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
    run.stdout.includes("Agents 1-7 : EXECUTES"),
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
  }
];

console.log("========================================");
console.log(" PIPELINE LOCAL FIXTURES — SMOKE (ZERO API)");
console.log("========================================");

for (const testCase of cases) {
  let run = null;

  try {
    run = runPipeline(testCase);
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
