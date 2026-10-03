// Smoke du Truth Report (R20.4, squelette) — fonctions pures, zéro API, zéro réseau.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/truth-report-smoke.js

import { isDeepStrictEqual } from "node:util";

import { networkGuard } from "./fixture-network-guard.js";
import { runResearchAgent } from "../src/agents/research.js";
import { CANONICAL_PROMPT, CANONICAL_TITLE } from "../src/fixtures/anthropic-dataset.js";
import {
  TRUTH_SCHEMA,
  buildTruthReport,
  renderTruthMarkdown,
  validateTruthReport
} from "../src/agents/truth.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("TRUTH REPORT — SMOKE (ZERO API)");

process.env.ANTHROPIC_FIXTURES = "1";
const research = (await runResearchAgent({ title: CANONICAL_TITLE, prompt: CANONICAL_PROMPT, testMode: true })).data;
delete process.env.ANTHROPIC_FIXTURES;

const truth = buildTruthReport({ research, title: CANONICAL_TITLE });

await test("construction : tous les faits retenus à leur indice d'origine, contrôles à venir non évalués", () => {
  assert(truth.schema === TRUTH_SCHEMA, truth.schema);
  assert(truth.facts.length === research.key_facts.length && research.key_facts.length > 0, "faits");
  truth.facts.forEach((fact, index) => {
    assert(fact.index === index && fact.truth_status === "retained", `facts[${index}]`);
    assert(fact.claim === research.key_facts[index].claim, `claim ${index}`);
  });
  assert(truth.rejected_count === 0 && truth.stop.stopped === false && truth.alternative_titles.length === 0, "squelette");
  for (const verdict of [truth.title.verdict, truth.thesis.verdict, truth.contradictions.status]) {
    assert(verdict === "not_evaluated", verdict);
  }
  // C1 (E1) : la politique des sources est évaluée en mode rapport. Le
  // dossier minimal des fixtures (0 source) est non conforme, sans arrêt.
  assert(truth.policy_checks.mode === "report" && truth.policy_checks.status === "non_compliant", JSON.stringify(truth.policy_checks));
  assert(truth.title.text === CANONICAL_TITLE && truth.thesis.text === research.central_question, "titre / thèse");
  assert(truth.sources.every(source => source.tier === null && source.facts.length > 0), "sources");
});

await test("dossier transmis au Script strictement identique au dossier Research (requête et cache inchangés)", () => {
  assert(isDeepStrictEqual(truth.research_dossier, research), "dossier différent");
  assert(JSON.stringify(truth.research_dossier) === JSON.stringify(research), "sérialisation différente");
  assert(truth.research_dossier !== research, "copie attendue, pas une référence partagée");
});

await test("déterminisme : deux calculs donnent les mêmes octets, sans horodatage", () => {
  const again = buildTruthReport({ research, title: CANONICAL_TITLE });
  assert(JSON.stringify(again) === JSON.stringify(truth), "non déterministe");
  assert(renderTruthMarkdown(again) === renderTruthMarkdown(truth), "Markdown non déterministe");
  assert(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(JSON.stringify(truth)), "horodatage présent");
});

await test("contrat : valide, puis refus d'un dossier altéré, d'un indice manquant ou décalé", () => {
  assert(validateTruthReport(truth, research).valid, JSON.stringify(validateTruthReport(truth, research).errors));
  const altered = structuredClone(truth);
  altered.research_dossier.key_facts[0].claim = "fait modifié";
  assert(/research_dossier différent/.test(validateTruthReport(altered, research).errors.join()), "dossier altéré accepté");
  const missing = structuredClone(truth);
  missing.facts.pop();
  assert(/ne couvre pas exactement/.test(validateTruthReport(missing, research).errors.join()), "fait manquant accepté");
  const shifted = structuredClone(truth);
  shifted.facts[0].index = 5;
  assert(/indice 5 au lieu de 0/.test(validateTruthReport(shifted, research).errors.join()), "indice décalé accepté");
  assert(!validateTruthReport(null, research).valid, "absent accepté");
});

await test("Markdown : toutes les rubriques de relecture, contrôles à venir signalés", () => {
  const md = renderTruthMarkdown(truth);
  for (const heading of ["## Verdict du titre", "## Verdict de la thèse", "## Faits retenus", "## Faits rejetés", "## Hiérarchie des sources", "## Contradictions détectées", "## Raisons d'un éventuel arrêt", "## Titres alternatifs"]) {
    assert(md.includes(heading), heading);
  }
  assert(md.includes(CANONICAL_TITLE) && (md.match(/non encore contrôlé/g) ?? []).length >= 3, "mentions");
  assert(md.includes(`## Faits retenus (${research.key_facts.length})`) && md.includes("## Faits rejetés (0)"), "comptes");
  assert(md.includes("Politique des sources : non conforme (rapport seulement") && md.includes("- minimum_sources : non conforme — 0 source(s) distincte(s), minimum 5"), "politique des sources");
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
