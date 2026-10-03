// Smoke de la validation du titre (R20.4, phase A) — zéro API, zéro réseau.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/title-validation-smoke.js
//
// Prouve :
// - la décomposition du titre en affirmations typées ;
// - le contrôle déterministe des chiffres (le code décide seul) ;
// - que le juge modèle ne peut jamais contourner le code ;
// - les justifications de chaque verdict ;
// - le contrôle des titres alternatifs ;
// - le juge passe par le garde des appels (réparation bornée à 1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { networkGuard } from "./fixture-network-guard.js";
import { buildTruthReport, renderTruthMarkdown, validateTruthReport } from "../src/agents/truth.js";
import { configureCallGuard, resetCallGuard } from "../src/services/call-guard.js";
import { evaluateSourceHierarchy } from "../src/utils/source-policy.js";
import {
  TITLE_VALIDATION,
  decomposeTitle,
  evaluateTitle,
  extractFigures,
  loadTitleValidationConfig,
  runTitleJudge,
  validateJudgeResponse,
  validatedFacts
} from "../src/utils/title-validation.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("TITLE VALIDATION — SMOKE (ZERO API)");

const TITLE = "Pourquoi 95 % de l'Australie est presque vide ?";

// Réplique du dossier réel du 03/10 : textes des faits et URL des sources.
const src = url => ({ title: "t", url, publisher: "p", source_type: "secondary", supports_claim: "c" });
const U = {
  universalis: "https://www.universalis.fr/donnees-pays/indicateur/densite/australie/",
  larousse: "https://www.larousse.fr/encyclopedie/divers/Australie_population/187017",
  superprof: "https://www.superprof.com.au/blog/australia-population-distribution/",
  australia: "https://www.australia-australie.com/articles/les-visages-de-laustralie-de-linterieur-loutback/",
  wikiClimat: "https://fr.wikipedia.org/wiki/Climat_de_l'Australie",
  science: "https://scienceinsights.org/is-australia-dry-facts-about-its-arid-climate/",
  wikiDesert: "https://fr.wikipedia.org/wiki/D%C3%A9sert_australien",
  voyage: "https://australie-voyage.fr/culture-et-sport-en-australie/geographie-et-demographie-australie/",
  natgeo: "https://www.nationalgeographic.com/environment/article/partner-content-australia-water-problem",
  school: "https://www.laburnumps.vic.edu.au/uploaded_files/media/arid_climate_zone_of_australia_1.pdf"
};
const fact = (claim, importance, urls) => ({ claim, importance, verification_status: "verified", sources: urls.map(src) });
const REAL = {
  topic: TITLE,
  central_question: "Quels facteurs expliquent la concentration de la population australienne sur les côtes ?",
  key_facts: [
    fact("L'Australie a une densité de population d'environ 3,5 habitants par km², l'une des plus faibles au monde", "high", [U.universalis, U.larousse]),
    fact("Environ 85 à 90 % de la population australienne vit dans des zones urbaines côtières, dont 80 % à moins de 50 km de la côte", "high", [U.superprof, U.larousse]),
    fact("70 % du territoire australien est soumis à un climat aride ou semi-aride", "high", [U.australia]),
    fact("Plus de 80 % de la superficie australienne reçoit moins de 600 mm de pluie par an, et environ la moitié reçoit moins de 300 mm", "high", [U.wikiClimat, U.science]),
    fact("Les déserts australiens couvrent environ 1,37 million de km², soit 18 % de la superficie totale du pays", "high", [U.wikiDesert]),
    fact("L'Australie est le continent habité le plus sec de la planète, avec une pluviométrie moyenne d'environ 466 mm par an", "high", [U.science]),
    fact("Les cinq principales villes côtières (Sydney, Melbourne, Brisbane, Adélaïde et Perth) regroupent 60 % de la population australienne", "medium", [U.larousse]),
    fact("Le Territoire du Nord, qui représente 18 % de la superficie totale, n'abrite que 250 000 habitants", "medium", [U.voyage]),
    fact("Les courants océaniques froids à l'ouest et la Grande Cordillère australienne à l'est empêchent les pluies de pénétrer à l'intérieur", "high", [U.natgeo]),
    fact("Les températures dans l'Outback peuvent atteindre plus de 40°C en été avec des écarts jour-nuit de 15 à 20°C", "medium", [U.school])
  ],
  uncertainties: [],
  claims_requiring_sources: []
};
const HIERARCHY = evaluateSourceHierarchy(REAL);
const FACTS = validatedFacts(REAL, HIERARCHY);

// Juge simulé : chaque affirmation reçoit le statut et les faits donnés.
function judgeFor(title, { status = "supported", facts = [0, 1], alternatives = [], overrides = {} } = {}) {
  return {
    assertions: decomposeTitle(title).map(assertion => ({
      id: assertion.id,
      status: overrides[assertion.kind]?.status ?? status,
      facts: overrides[assertion.kind]?.facts ?? facts,
      explanation: `Explication du modèle pour ${assertion.kind}.`
    })),
    alternative_titles: alternatives
  };
}

// ---------------------------------------------------------------------

await test("décomposition : affirmations typées (chiffre exact, approximation, journalistique, causalité, généralisation, hypothèse)", () => {
  const kinds = title => decomposeTitle(title).map(item => `${item.kind}:${item.text}`).join(" | ");
  assert(kinds(TITLE) === `main_claim:${TITLE} | exact_figure:95 % | approximation:presque | journalistic:vide | causality:pourquoi`, kinds(TITLE));
  assert(kinds("Environ 90 % des Australiens vivent sur la côte").includes("approximation:90 %"), "chiffre approximatif");
  assert(kinds("Tous les Australiens vivent sur la côte").includes("generalization:tous"), "généralisation");
  assert(kinds("Et si l'Outback pourrait revivre ?").includes("hypothesis:et si") && kinds("Et si l'Outback pourrait revivre ?").includes("hypothesis:pourrait"), "hypothèse");
  assert(kinds("L'Australie en 1788").includes("exact_figure:1788"), "date");
  assert(decomposeTitle(TITLE).every((item, index) => item.id === `a${index + 1}`), "identifiants");
});

await test("chiffres : valeurs, fourchettes, milliers et décimales", () => {
  const figures = extractFigures("Environ 85 à 90 % de la population, dont 80 % ; 250 000 habitants ; 1,37 million ; entre 6 et 8 sections");
  const text = figures.map(item => `${item.text}=${item.low}-${item.high}${item.percent ? "%" : ""}`).join(" | ");
  assert(text === "85 à 90 %=85-90% | 80 %=80-80% | 250 000=250000-250000 | 1,37=1.37-1.37 | entre 6 et 8=6-8", text);
});

await test("dossier réel du 03/10, sans juge : non démontré, « 95 % » absent des faits validés, chiffres proches cités", () => {
  const result = evaluateTitle({ title: TITLE, research: REAL, hierarchy: HIERARCHY, skipReason: "production historique, aucun appel" });
  assert(result.verdict === "not_demonstrated" && result.judged === false, result.verdict);
  assert(FACTS.filter(item => item.validated).map(item => item.index + 1).join() === "1,2,7", "faits validés");
  const reasons = result.reasons.join("\n");
  assert(reasons.includes("Chiffre « 95 % » absent des faits validés (faits vérifiés, sources de rang ≤ 2)."), reasons);
  assert(reasons.includes("Chiffres proches dans les faits validés : 85 à 90 % (fait 2), 80 % (fait 2), 60 % (fait 7)."), reasons);
  assert(reasons.includes("Causalité « pourquoi » : sens non jugé — production historique, aucun appel."), reasons);
});

await test("chiffre présent seulement dans un fait non validé (rang > 2) : refusé, avec la raison", () => {
  const title = "Pourquoi 70 % de l'Australie est aride ?";
  const result = evaluateTitle({ title, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(title, { facts: [2] }) });
  const figure = result.assertions.find(item => item.kind === "exact_figure");
  assert(figure.status === "not_supported" && result.verdict === "not_demonstrated", figure.status);
  assert(figure.reasons.some(reason => reason.includes("Il figure seulement dans des faits non validés : fait 3")), figure.reasons.join(" | "));
});

await test("le juge ne contourne jamais le code : « 95 % » reste non soutenu même si le modèle le valide", () => {
  const result = evaluateTitle({ title: TITLE, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(TITLE, { status: "supported", facts: [1] }) });
  assert(result.assertions.find(item => item.kind === "exact_figure").status === "not_supported", "chiffre validé par le modèle");
  assert(result.verdict === "not_demonstrated", result.verdict);
});

await test("causalité soutenue seulement par un fait de rang > 2 : abaissée par le code, raison explicite", () => {
  const title = "Pourquoi l'intérieur de l'Australie reçoit si peu de pluie ?";
  const result = evaluateTitle({ title, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(title, { facts: [8] }) });
  const causality = result.assertions.find(item => item.kind === "causality");
  assert(causality.status === "not_supported" && result.verdict === "not_demonstrated", causality.status);
  assert(causality.reasons.some(reason => reason.includes("soutenue uniquement par des faits non validés")), causality.reasons.join(" | "));
  assert(causality.reasons.some(reason => reason.includes("fait 9 (verified, meilleur rang 3) écarté(s)")), causality.reasons.join(" | "));
});

await test("titre démontré (fourchette 85 à 90 %) et titre partiellement démontré", () => {
  const title = "Pourquoi 88 % des Australiens vivent près des côtes ?";
  const demonstrated = evaluateTitle({ title, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(title, { facts: [1] }) });
  assert(demonstrated.verdict === "demonstrated" && demonstrated.reasons.length > 0, `${demonstrated.verdict} ${demonstrated.reasons.join(" | ")}`);
  assert(demonstrated.alternatives.accepted.length === 0, "alternatives proposées pour un titre démontré");
  const partial = evaluateTitle({ title, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(title, { facts: [1], overrides: { causality: { status: "partially_supported", facts: [1] } } }) });
  assert(partial.verdict === "partially_demonstrated", partial.verdict);
  assert(partial.reasons.length > 0 && partial.reasons.every(reason => reason.includes("causality") || reason.includes("Causalité")), partial.reasons.join(" | "));
});

await test("généralisation non démontrée : non soutenue, justifiée", () => {
  const title = "Tous les Australiens vivent sur la côte";
  const result = evaluateTitle({ title, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(title, { facts: [1], overrides: { generalization: { status: "not_supported", facts: [] } } }) });
  const generalization = result.assertions.find(item => item.kind === "generalization");
  assert(generalization.status === "not_supported" && result.verdict === "not_demonstrated", generalization.status);
  assert(result.reasons.some(reason => reason.startsWith("Généralisation « tous »")), result.reasons.join(" | "));
});

await test("titres alternatifs : vérifiés par le code, chiffres inventés et faits non validés écartés, nombre plafonné", () => {
  const alternatives = [
    { title: "Pourquoi 85 % des Australiens vivent-ils sur la côte ?", facts: [1], explanation: "Fait 2." },
    { title: "Pourquoi 95 % de l'Australie est désertique ?", facts: [1], explanation: "Chiffre inventé." },
    { title: "Pourquoi 70 % de l'Australie est aride ?", facts: [2], explanation: "Fait non validé." },
    { title: "Pourquoi l'Australie est si peu peuplée ?", facts: [], explanation: "Aucun fait." },
    { title: "Pourquoi l'Australie compte 3,5 habitants par km² ?", facts: [0], explanation: "Fait 1." },
    { title: "Pourquoi 60 % des Australiens vivent dans cinq villes ?", facts: [6], explanation: "Fait 7." },
    { title: "Pourquoi les Australiens vivent-ils en ville ?", facts: [1], explanation: "Fait 2, quatrième proposition valide." }
  ];
  const result = evaluateTitle({ title: TITLE, research: REAL, hierarchy: HIERARCHY, judge: judgeFor(TITLE, { facts: [1], alternatives }) });
  assert(result.alternatives.accepted.map(item => item.title).join(" | ") === [alternatives[0], alternatives[4], alternatives[5]].map(item => item.title).join(" | "), result.alternatives.accepted.map(item => item.title).join(" | "));
  const rejected = Object.fromEntries(result.alternatives.rejected.map(item => [item.title, item.reasons.join(" ; ")]));
  assert(rejected[alternatives[1].title].includes("chiffre « 95 % » absent des faits validés cités"), "chiffre inventé accepté");
  assert(rejected[alternatives[2].title].includes("fait 3 non validé"), "fait non validé accepté");
  assert(rejected[alternatives[3].title].includes("aucun fait cité"), "sans fait accepté");
  assert(result.alternatives.accepted.length === TITLE_VALIDATION.alternative_titles_count, "plafond");
});

await test("réponse du juge : contrôle strict (affirmations manquantes, statut, faits inexistants, explication)", () => {
  const context = { assertions: decomposeTitle(TITLE), facts: FACTS };
  const good = judgeFor(TITLE);
  assert(validateJudgeResponse(good, context).length === 0, validateJudgeResponse(good, context).join());
  const cases = [
    [null, /objet attendu/],
    [{ ...good, assertions: good.assertions.slice(1) }, /exactement une fois/],
    [{ ...good, assertions: good.assertions.map((item, index) => index === 0 ? { ...item, status: "vrai" } : item) }, /status invalide/],
    [{ ...good, assertions: good.assertions.map((item, index) => index === 0 ? { ...item, facts: [42] } : item) }, /facts invalide/],
    [{ ...good, assertions: good.assertions.map((item, index) => index === 0 ? { ...item, explanation: " " } : item) }, /explanation manquante/],
    [{ ...good, alternative_titles: [{ title: "x", facts: [99], explanation: "y" }] }, /alternative_titles\[0\] : facts invalide/]
  ];
  for (const [response, pattern] of cases) assert(pattern.test(validateJudgeResponse(response, context).join(" ; ")), String(pattern));
});

await test("configuration title_validation : chargée strictement, toute erreur refusée", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../config/research.json", import.meta.url), "utf8")).title_validation;
  const variant = mutate => { const copy = structuredClone(base); mutate(copy); return { title_validation: copy }; };
  const cases = [
    [variant(c => { c.inconnue = 1; }), /clé inconnue : inconnue/],
    [variant(c => { c.alternative_titles_count = 0; }), /alternative_titles_count/],
    [variant(c => { c.approximate_figure_tolerance = 2; }), /approximate_figure_tolerance/],
    [variant(c => { c.approximation_window_words = 0; }), /approximation_window_words/],
    [variant(c => { c.markers.rumeur = ["on dit"]; }), /type inconnu rumeur/],
    [variant(c => { c.markers.causality = []; }), /markers.causality doit être une liste/],
    [variant(c => { c.markers.causality.push("pourquoi"); }), /doublon/],
    [variant(c => { c.markers.causality.push("Grâce À"); }), /minuscules/],
    [{}, /title_validation absente/]
  ];
  for (const [config, pattern] of cases) {
    let message = "";
    try { loadTitleValidationConfig(config); } catch (error) { message = error.message; }
    assert(pattern.test(message), `${pattern} : « ${message} »`);
  }
});

// Juge réel simulé : le SDK est remplacé par un bouchon local, le garde des
// appels compte et journalise ; aucune sortie réseau.
async function withStubbedSdk(responses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-validation-smoke-"));
  const original = Anthropic.Messages.prototype.create;
  const saved = { ack: process.env.PIPELINE_REAL_CALLS_ACK, noApi: process.env.NO_API, key: process.env.ANTHROPIC_API_KEY };
  const requests = [];

  Anthropic.Messages.prototype.create = async function (request) {
    requests.push(request);
    const text = responses[requests.length - 1];
    return { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "smoke", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" };
  };
  process.env.PIPELINE_REAL_CALLS_ACK = "1";
  delete process.env.NO_API;
  process.env.ANTHROPIC_API_KEY ??= `sk-ant-smoke-${"x".repeat(60)}`;
  configureCallGuard({ productionDir: dir, cap: 2 });

  try {
    return { result: await fn(), requests, calls: JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8")).entries };
  } catch (error) {
    return { error, requests, calls: fs.existsSync(path.join(dir, "calls.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8")).entries : [] };
  } finally {
    resetCallGuard();
    Anthropic.Messages.prototype.create = original;
    process.env.NO_API = saved.noApi;
    if (saved.ack === undefined) delete process.env.PIPELINE_REAL_CALLS_ACK; else process.env.PIPELINE_REAL_CALLS_ACK = saved.ack;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const judgeInput = { title: TITLE, assertions: decomposeTitle(TITLE), facts: FACTS, research: REAL };

await test("juge : un appel via le garde (journal et plafond), réponse valide acceptée", async () => {
  const run = await withStubbedSdk([JSON.stringify(judgeFor(TITLE))], () => runTitleJudge(judgeInput));
  assert(!run.error && run.result.attempts === 1 && run.requests.length === 1, run.error?.message ?? "tentatives");
  assert(run.calls.length === 1 && run.requests[0].temperature === 0, "journal du garde");
  assert(run.requests[0].system.startsWith("Tu es le juge du titre de la chaîne YouTube"), "prompt");
});

await test("juge : une seule réparation, puis échec explicite (au plus 2 appels)", async () => {
  const repaired = await withStubbedSdk(["pas du JSON", JSON.stringify(judgeFor(TITLE))], () => runTitleJudge(judgeInput));
  assert(!repaired.error && repaired.result.attempts === 2 && repaired.requests[1].messages[0].content.startsWith("RÉPARATION"), repaired.error?.message ?? "réparation");
  const broken = await withStubbedSdk(["pas du JSON", "{}"], () => runTitleJudge(judgeInput));
  assert(/réponse invalide après réparation/.test(broken.error?.message ?? "") && broken.requests.length === 2, broken.error?.message ?? "échec attendu");
});

await test("Truth Report : pause « titre à revoir » en block (justifications, alternatives, actions), signalé en report", () => {
  const judge = judgeFor(TITLE, { facts: [1], alternatives: [{ title: "Pourquoi 85 % des Australiens vivent-ils sur la côte ?", facts: [1], explanation: "Fait 2." }] });
  const block = buildTruthReport({ research: REAL, title: TITLE, titleEnforcement: "block", titleJudge: judge });
  assert(block.stop.stopped && block.stop.kind === "title_review" && block.stop.actions.length === 3, JSON.stringify(block.stop));
  assert(block.rejected_count === 0 && block.alternative_titles[0].title.startsWith("Pourquoi 85 %"), "alternatives");
  assert(validateTruthReport(block, REAL).valid, validateTruthReport(block, REAL).errors.join());
  const md = renderTruthMarkdown(block);
  for (const text of ["- Verdict : **non démontré**", "Chiffre « 95 % » absent des faits validés", "Pause — titre à revoir", "Actions possibles :", "**Pourquoi 85 % des Australiens vivent-ils sur la côte ?**"]) {
    assert(md.includes(text), text);
  }
  const report = buildTruthReport({ research: REAL, title: TITLE, titleEnforcement: "report", titleJudge: judge });
  assert(report.stop.stopped === false && report.title.verdict === "not_demonstrated", "mode rapport");
  // La pause de la hiérarchie (phase B) reste prioritaire.
  const both = buildTruthReport({ research: REAL, title: TITLE, enforcement: "block", titleEnforcement: "block", titleJudge: judge });
  assert(both.stop.kind === "rejected", both.stop.kind);
  // Contrat : un verdict sans justification est refusé.
  const forged = structuredClone(block);
  forged.title.reasons = [];
  assert(/verdict sans justification/.test(validateTruthReport(forged, REAL).errors.join()), "verdict sans justification accepté");
});

await test("déterminisme : mêmes entrées, mêmes octets", () => {
  const judge = judgeFor(TITLE, { facts: [1] });
  const a = buildTruthReport({ research: REAL, title: TITLE, titleEnforcement: "block", titleJudge: judge });
  const b = buildTruthReport({ research: REAL, title: TITLE, titleEnforcement: "block", titleJudge: judge });
  assert(JSON.stringify(a) === JSON.stringify(b) && renderTruthMarkdown(a) === renderTruthMarkdown(b), "non déterministe");
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
