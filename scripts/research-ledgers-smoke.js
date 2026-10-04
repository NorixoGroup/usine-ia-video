// Smoke R24.1 — ledgers Research, zéro API / zéro réseau.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/research-ledgers-smoke.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { networkGuard } from "./fixture-network-guard.js";
import {
  CLAIMS_LEDGER_FILE,
  RESEARCH_LEDGER_DIRECTORY,
  SOURCES_LEDGER_FILE,
  buildResearchLedgers,
  persistResearchLedgers,
  projectResearchFromLedgers,
  validateResearchLedgers
} from "../src/agents/research-ledgers.js";
import { validateResearchDossier } from "../src/utils/validate-research.js";

if (process.env.NO_API !== "1") {
  throw new Error("Research Ledgers smoke : NO_API=1 obligatoire.");
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = path.join(ROOT, "projects");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");
const createdProductions = [];

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function dossier() {
  return {
    topic: "Pourquoi la population australienne est-elle concentrée ?",
    central_question: "Quels facteurs géographiques et historiques structurent cette concentration ?",
    executive_summary: "Dossier de compatibilité R24.1.",
    key_facts: [
      {
        claim: "La population se concentre dans certaines régions du continent.",
        importance: "high",
        verification_status: "verified",
        sources: [
          {
            title: "Population data",
            url: "https://www.abs.gov.au/statistics/people/population",
            publisher: "Australian Bureau of Statistics",
            source_type: "primary",
            supports_claim: "Présente la répartition démographique utilisée pour ce fait."
          },
          {
            title: "Regional population",
            url: "https://www.abs.gov.au/statistics/people/population/regional-population",
            publisher: "Australian Bureau of Statistics",
            source_type: "primary",
            supports_claim: "Décrit les populations régionales pertinentes."
          }
        ]
      },
      {
        claim: "Les contraintes géographiques influencent la répartition des habitants.",
        importance: "medium",
        verification_status: "needs_verification",
        sources: [
          {
            title: "Population data",
            url: "https://www.abs.gov.au/statistics/people/population",
            publisher: "Australian Bureau of Statistics",
            source_type: "primary",
            supports_claim: "Fournit le contexte démographique du fait."
          }
        ]
      }
    ],
    story_angles: [{
      angle: "Un continent vaste et une population concentrée",
      why_it_matters: "La concentration géographique structure le sujet."
    }],
    sections: [{
      title: "Répartition",
      purpose: "Présenter les contrastes de peuplement.",
      facts_needed: ["Densité et répartition"]
    }],
    visual_opportunities: [{
      subject: "Carte de densité de population",
      suggested_visual: "Carte thématique"
    }],
    claims_requiring_sources: [
      "Les contraintes géographiques influencent la répartition des habitants."
    ],
    uncertainties: ["Les mécanismes précis restent à documenter."],
    research_gaps: ["Ajouter des sources climatiques et historiques."]
  };
}

function runMvp(args, env = {}) {
  const before = new Set(fs.readdirSync(PROJECTS));
  const child = spawnSync(
    process.execPath,
    ["--import", GUARD, "src/orchestrator/mvp.js", ...args],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, NO_API: "1", ANTHROPIC_FIXTURES: "1", ...env },
      encoding: "utf8"
    }
  );
  const created = fs.readdirSync(PROJECTS).filter(name => !before.has(name));
  createdProductions.push(...created);

  return {
    ...child,
    created,
    productionId: child.stdout.match(/^Production : (\S+)$/m)?.[1] ?? null,
    attempts: Number(
      child.stderr.match(/tentatives bloquées : (\d+)/)?.[1] ?? "-1"
    )
  };
}

console.log("========================================");
console.log(" RESEARCH LEDGERS — SMOKE (ZERO API)");
console.log("========================================");

await test("IDs stables et sources partagées dédupliquées", () => {
  const first = buildResearchLedgers(dossier());
  const second = buildResearchLedgers(dossier());

  assert(isDeepStrictEqual(first, second), "ledgers non déterministes");
  assert(
    first.sources.sources.map(source => source.source_id).join(",") ===
      "src-000001,src-000002",
    JSON.stringify(first.sources.sources)
  );
  assert(
    first.claims.claims.map(claim => claim.claim_id).join(",") ===
      "clm-000001,clm-000002",
    JSON.stringify(first.claims.claims)
  );
  assert(
    first.claims.claims[0].source_refs[0].source_id ===
      first.claims.claims[1].source_refs[0].source_id,
    "source commune non dédupliquée"
  );
});

await test("projection reconstitue exactement research.json", () => {
  const input = dossier();
  const projected = projectResearchFromLedgers(buildResearchLedgers(input));

  assert(isDeepStrictEqual(projected, input), "projection différente du contrat existant");
  assert(validateResearchDossier(projected).valid, "projection Research invalide");
});

await test("ledger invalide fail-closed", () => {
  const ledgers = buildResearchLedgers(dossier());
  ledgers.claims.claims[0].source_refs[0].source_id = "src-999999";

  assert(
    validateResearchLedgers(ledgers).some(error => error.includes("source inconnue")),
    "référence inconnue acceptée"
  );
});

await test("persistance : deux fichiers internes, projection inchangée", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-ledgers-smoke-"));

  try {
    const ledgers = buildResearchLedgers(dossier());
    const paths = persistResearchLedgers({ productionDir: root, ledgers });

    assert(fs.existsSync(paths.sources), "sources.json absent");
    assert(fs.existsSync(paths.claims), "claims.json absent");
    assert(
      path.basename(paths.sources) === SOURCES_LEDGER_FILE &&
        path.basename(paths.claims) === CLAIMS_LEDGER_FILE &&
        path.basename(path.dirname(paths.sources)) === RESEARCH_LEDGER_DIRECTORY,
      "chemins de ledger inattendus"
    );
    assert(
      isDeepStrictEqual(
        projectResearchFromLedgers({
          sources: JSON.parse(fs.readFileSync(paths.sources, "utf8")),
          claims: JSON.parse(fs.readFileSync(paths.claims, "utf8"))
        }),
        dossier()
      ),
      "projection persistée différente"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test("orchestrateur : nouvelle production écrit les ledgers sans changer research.json", () => {
  const result = runMvp(["--research-script", "--stop-after=research"]);

  assert(result.status === 0, `exit ${result.status}: ${result.stderr}`);
  assert(result.attempts === 0, `réseau : ${result.attempts}`);
  assert(result.productionId && result.created.includes(result.productionId), "production absente");

  const productionDir = path.join(PROJECTS, result.productionId);
  const research = JSON.parse(fs.readFileSync(path.join(productionDir, "research.json"), "utf8"));
  const sources = JSON.parse(fs.readFileSync(path.join(productionDir, "research", "sources.json"), "utf8"));
  const claims = JSON.parse(fs.readFileSync(path.join(productionDir, "research", "claims.json"), "utf8"));

  assert(validateResearchDossier(research.data).valid, "research.json incompatible");
  assert(isDeepStrictEqual(projectResearchFromLedgers({ sources, claims }), research.data), "research.json n'est pas la projection des ledgers");
});

await test("production historique sans ledgers : reprise Research reste compatible", () => {
  const result = runMvp(["--research-script", "--stop-after=research"]);
  assert(result.status === 0 && result.productionId, `création : ${result.stderr}`);

  const productionDir = path.join(PROJECTS, result.productionId);
  fs.rmSync(path.join(productionDir, RESEARCH_LEDGER_DIRECTORY), {
    recursive: true,
    force: true
  });

  const resumed = runMvp([
    "--research-script",
    `--resume=${result.productionId}`,
    "--stop-after=truth"
  ]);

  assert(resumed.status === 0, `reprise : ${resumed.stderr}`);
  assert(resumed.attempts === 0, `réseau reprise : ${resumed.attempts}`);
  assert(!fs.existsSync(path.join(productionDir, RESEARCH_LEDGER_DIRECTORY)), "la reprise a exigé ou recréé les ledgers");
});

await test("garde réseau : 0 tentative", () => {
  assert(networkGuard.attempts().length === 0, networkGuard.attempts().join(", "));
});

for (const productionId of [...new Set(createdProductions)]) {
  fs.rmSync(path.join(PROJECTS, productionId), { recursive: true, force: true });
}

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);

if (failed > 0) {
  console.error("RESULTAT GLOBAL : FAIL — Research Ledgers");
  process.exit(1);
}

console.log("RESULTAT GLOBAL : PASS — Research Ledgers, zéro API, zéro réseau");
