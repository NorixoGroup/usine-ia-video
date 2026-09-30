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

function runPipeline({ fixtures, scenario, extraArgs = [] }) {
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

  const before = listProductions();

  const child = spawnSync(
    process.execPath,
    [
      "--import",
      GUARD,
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

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created,
    productionId,
    guardActive: guardLine !== null,
    blockedAttempts: guardLine ? Number(guardLine[1]) : null,
    production: productionId
      ? readArtifact(productionId, "production.json")
      : null,
    research: productionId
      ? readArtifact(productionId, "research.json")
      : null,
    script: productionId
      ? readArtifact(productionId, "script.json")
      : null,
    visual: productionId
      ? readArtifact(productionId, "visual.json")
      : null,
    assets: productionId
      ? readArtifact(productionId, "assets.json")
      : null
  };
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

  for (const id of ["voice", "assembly", "quality"]) {
    const state = agentState(run, id);

    assert(
      state.status === "pending" &&
      state.started_at === null &&
      state.completed_at === null,
      `Agent ${id} : ne doit pas être exécuté (${state.status})`
    );
  }

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

function assertPass(run) {
  assertCommon(run);

  assert(
    run.status === 0,
    `code de sortie ${run.status}\n${run.stdout}\n${run.stderr}`
  );

  assert(
    run.production.status === "research_script_visual_asset_pass",
    `status=${run.production.status}`
  );

  for (const id of ["research", "script", "visual_director", "asset"]) {
    assert(
      agentState(run, id).status === "completed",
      `Agent ${id} : ${agentState(run, id).status}`
    );
  }

  assert(
    run.research && run.script && run.visual && run.assets,
    "research.json / script.json / visual.json / assets.json attendus"
  );

  assertAssets(run);

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
      "RESULTAT : PASS — RESEARCH -> SCRIPT -> VISUAL DIRECTOR -> ASSET"
    ) &&
    run.stdout.includes("Agents 5-7 : NON EXECUTES"),
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

  for (const name of ["research", "script", "visual"]) {
    const expected = artifacts.includes(name);

    assert(
      Boolean(run[name]) === expected,
      `${name}.json ${expected ? "attendu" : "inattendu"}`
    );
  }

  const asset = agentState(run, "asset");

  assert(
    asset.status === "pending" &&
    asset.started_at === null &&
    run.assets === null,
    `Agent asset : ne doit pas démarrer (${asset.status})`
  );
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
console.log("Agents 5-7 exécutés : NON");

if (failed > 0) {
  console.error(
    "RESULTAT GLOBAL : FAIL — pipeline local fixtures"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — pipeline local Research → Script → Visual Director → Asset prouvé sans API"
);

process.exit(0);
