// Smoke des contradictions internes (R20.4, phase F) — zéro API, zéro réseau.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/fact-contradictions-smoke.js
//
// Prouve :
// - les paires suspectes du code (faits entre eux et faits face aux autres
//   champs du dossier que lit le Script), sur une réplique du 03/10 ;
// - les cas certains tranchés par le code ;
// - que le juge ne peut déclarer « compatible » qu'avec une dimension de la
//   liste fermée et des citations retrouvées mot pour mot (code souverain) ;
// - la pause « contradiction à revoir » (faits HIGH, mode block), l'ordre
//   des pauses et le lien avec le titre (Q-F8).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { networkGuard } from "./fixture-network-guard.js";
import { buildTruthReport, renderTruthMarkdown, validateTruthReport } from "../src/agents/truth.js";
import { configureCallGuard, resetCallGuard } from "../src/services/call-guard.js";
import {
  buildContradictionJudgeInput,
  certainFindings,
  comparedFacts,
  contradictionJudgeInputSha256,
  evaluateContradictions,
  findCandidates,
  loadContradictionsConfig,
  noteTexts,
  runContradictionJudge,
  sameConditionConflicts,
  validateContradictionJudgeResponse
} from "../src/utils/fact-contradictions.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("CONTRADICTIONS INTERNES — SMOKE (ZERO API, ZERO RÉSEAU)");

const src = url => ({ title: "t", url, publisher: "p", source_type: "secondary", supports_claim: "c" });
const fact = (claim, importance = "high", url = "https://www.bom.gov.au/x") => ({ claim, importance, verification_status: "verified", sources: [src(url)] });

// Réplique des textes du dossier réel du 03/10 (faits et notes concernés).
const REAL = {
  topic: "Australie",
  executive_summary: "L'Australie est l'un des pays les moins densément peuplés.",
  key_facts: [
    fact("L'Australie a une densité de population d'environ 3,5 habitants par km², l'une des plus faibles au monde"),
    fact("Environ 85 à 90 % de la population australienne vit dans des zones urbaines côtières, dont 80 % à moins de 50 km de la côte"),
    fact("70 % du territoire australien est soumis à un climat aride ou semi-aride"),
    fact("Les déserts australiens couvrent environ 1,37 million de km², soit 18 % de la superficie totale du pays"),
    fact("Les cinq principales villes côtières (Sydney, Melbourne, Brisbane, Adélaïde et Perth) regroupent 60 % de la population australienne", "medium")
  ],
  sections: [{ title: "Un continent vide", purpose: "Présenter les chiffres.", facts_needed: ["Densité de 3,5 hab/km² vs moyennes mondiales", "85-90% de la population à moins de 50 km des côtes"] }],
  claims_requiring_sources: [
    "Pourcentage exact de la population vivant à moins de 25 km vs 50 km de la côte (sources donnent 80% à 25 km et 85% à 50 km)",
    "Pourcentage exact de territoire désertique vs aride/semi-aride (18% déserts confirmé, 70% aride/semi-aride confirmé, mais 35% considéré comme désert selon une autre source)"
  ],
  uncertainties: ["La définition exacte de l'Outback varie selon les sources"]
};

const candidateFor = (result, a, notePath) => {
  const note = result.notes.find(item => item.path === notePath);
  return result.candidates.find(item => item.a === a && item.b === (note?.id ?? notePath));
};

// ---------------------------------------------------------------------

await test("configuration contradictions : chargée strictement, toute erreur refusée", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../config/research.json", import.meta.url), "utf8")).contradictions;
  const variant = mutate => { const copy = structuredClone(base); mutate(copy); return { contradictions: copy }; };
  const cases = [
    [variant(c => { c.inconnue = 1; }), /clé inconnue : inconnue/],
    [variant(c => { c.note_fields.push("key_facts"); }), /note_fields/],
    [variant(c => { c.min_shared_words = 0; }), /min_shared_words/],
    [variant(c => { c.min_word_length = 1; }), /min_word_length/],
    [variant(c => { c.compatibility_dimensions = []; }), /compatibility_dimensions/],
    [{}, /contradictions absente/]
  ];
  for (const [config, pattern] of cases) {
    let message = "";
    try { loadContradictionsConfig(config); } catch (error) { message = error.message; }
    assert(pattern.test(message), `${pattern} : « ${message} »`);
  }
});

await test("textes comparés : champs du dossier lus par le Script, aplatis avec leur chemin", () => {
  const paths = noteTexts(REAL).map(note => note.path);
  for (const expected of ["executive_summary", "sections[0].title", "sections[0].facts_needed[1]", "claims_requiring_sources[0]", "uncertainties[0]"]) {
    assert(paths.includes(expected), `${expected} absent : ${paths.join(", ")}`);
  }
  assert(!paths.some(item => item.startsWith("key_facts")), "les faits ne sont pas des notes");
});

await test("paires suspectes sur la réplique du 03/10 : 25 km contre 50 km, désert 18/35/70 %, section 85-90 %", () => {
  const result = findCandidates({ research: REAL });
  const km = candidateFor(result, "f2", "claims_requiring_sources[0]");
  assert(km && km.differing_figures.some(item => item.includes("50 km / 25 km")), JSON.stringify(km));
  const desert = candidateFor(result, "f3", "claims_requiring_sources[1]");
  assert(desert && desert.differing_figures.some(item => item.includes("35%")), JSON.stringify(desert));
  assert(candidateFor(result, "f2", "sections[0].facts_needed[1]"), "section 85-90 % non repérée");
  // Mots du sujet (présents dans la moitié des faits) : ne suffisent pas à rapprocher.
  assert(!result.candidates.some(item => item.a === "f1" && item.b === "f3"), "faits sans rapport rapprochés");
});

await test("faits comparés (Q-F4) : les faits rejetés par les preuves sont exclus, les non vérifiables inclus", () => {
  const evidence = { checked: true, facts: REAL.key_facts.map((_, index) => ({ index, editorial_status: index === 1 ? "rejected" : index === 2 ? "unverifiable" : "supported" })) };
  const ids = comparedFacts(REAL, evidence).map(item => item.id);
  assert(ids.join() === "f1,f3,f4,f5", ids.join());
  assert(!findCandidates({ research: REAL, factEvidence: evidence }).candidates.some(item => item.a === "f2" || item.b === "f2"), "fait rejeté comparé");
});

await test("cas certain tranché par le code : part supérieure à 100 %, aucun juge nécessaire", () => {
  const findings = certainFindings(comparedFacts({ key_facts: [fact("La région compte 120 % de la population")] }));
  assert(findings.length === 1 && findings[0].verdict === "contradiction" && findings[0].origin === "code", JSON.stringify(findings));
});

// Réponse du juge simulée : une entrée par paire suspecte.
function judgeFor(result, decide = () => ({})) {
  const texts = new Map([...result.facts.map(item => [item.id, item.text]), ...result.notes.map(item => [item.id, item.text])]);
  return {
    pairs: result.candidates.map(candidate => ({
      candidate: candidate.id,
      a: candidate.a,
      b: candidate.b,
      verdict: "contradiction",
      dimension: "",
      category: "chiffres",
      quote_a: texts.get(candidate.a).slice(0, 30),
      quote_b: texts.get(candidate.b).slice(0, 30),
      explanation: "Explication du modèle.",
      ...decide(candidate, texts)
    }))
  };
}

await test("code souverain : « compatible » exige une dimension fermée et des citations retrouvées ; sinon non résolue", () => {
  const dated = {
    key_facts: [fact("La population australienne atteint 26,6 millions d'habitants en 2023"), fact("La population australienne atteint 28,5 millions d'habitants en 2026")]
  };
  const result = findCandidates({ research: dated });
  assert(result.candidates.length === 1, `${result.candidates.length} paires`);
  const evaluate = decision => evaluateContradictions({ research: dated, judge: judgeFor(result, () => decision) }).findings[0];
  const ok = evaluate({ verdict: "compatible", dimension: "date", quote_a: "26,6 millions d'habitants en 2023", quote_b: "28,5 millions d'habitants en 2026" });
  assert(ok.verdict === "compatible" && ok.dimension === "date", JSON.stringify(ok));
  const sameYear = evaluate({ verdict: "compatible", dimension: "date", quote_a: "26,6 millions", quote_b: "28,5 millions" });
  assert(sameYear.verdict === "unresolved" && sameYear.reasons.some(reason => reason.includes("deux années différentes")), JSON.stringify(sameYear.reasons));
  const outside = evaluate({ verdict: "compatible", dimension: "tonalité", quote_a: "en 2023", quote_b: "en 2026" });
  assert(outside.verdict === "unresolved" && outside.reasons.some(reason => reason.includes("hors de la liste fermée")), JSON.stringify(outside.reasons));
  const invented = evaluate({ verdict: "compatible", dimension: "portée", quote_a: "population urbaine", quote_b: "population totale" });
  assert(invented.verdict === "unresolved" && invented.reasons.some(reason => reason.includes("citation du premier texte introuvable")), JSON.stringify(invented.reasons));
  assert(evaluate({ verdict: "contradiction" }).verdict === "contradiction", "contradiction du juge");
  const unjudged = evaluateContradictions({ research: dated, skipReason: "production historique, aucun appel" });
  assert(unjudged.findings[0].verdict === "unresolved" && unjudged.judged === false && unjudged.findings[0].reasons.at(-1) === "Non jugée — production historique, aucun appel.", JSON.stringify(unjudged.findings[0].reasons));
});

await test("cas certain « même condition, autre valeur » : contradiction établie par le code, même si le juge dit compatible", () => {
  const result = findCandidates({ research: REAL });
  const km = candidateFor(result, "f2", "claims_requiring_sources[0]");
  const section = candidateFor(result, "f2", "sections[0].facts_needed[1]");
  const judge = judgeFor(result, () => ({ verdict: "compatible", dimension: "définition", quote_a: "dont 80 % à moins de 50 km", quote_b: "à moins de" }));
  const evaluated = evaluateContradictions({ research: REAL, judge });
  for (const candidate of [km, section]) {
    const finding = evaluated.findings.find(item => item.candidate === candidate.id);
    assert(finding.verdict === "contradiction" && finding.reasons.some(reason => reason.startsWith("Contradiction certaine établie par le code (même condition, autre valeur)")), `${candidate.id} : ${finding.verdict}`);
    assert(finding.reasons.some(reason => reason.startsWith("Compatibilité proposée par le juge écartée par le code")), "décision du juge non tracée");
  }
  // Sans juge (production historique) : la contradiction certaine est quand même établie.
  const unjudged = evaluateContradictions({ research: REAL, skipReason: "production historique, aucun appel" });
  assert(unjudged.findings.find(item => item.candidate === km.id).verdict === "contradiction", "cas certain sans juge");
  // Aucune autre paire de la réplique n'est concernée.
  const certain = result.candidates.filter(candidate => sameConditionConflicts(result.facts.concat(result.notes).find(item => item.id === candidate.a).text, result.facts.concat(result.notes).find(item => item.id === candidate.b).text).length > 0);
  assert(certain.map(item => item.id).sort().join() === [km.id, section.id].sort().join(), certain.map(item => item.id).join());
  // Même condition et même valeur : pas de contradiction ; conditions différentes : pas de cas certain.
  assert(sameConditionConflicts("80 % à moins de 50 km", "environ 80 % à moins de 50 km").length === 0, "même valeur");
  assert(sameConditionConflicts("80 % à moins de 25 km", "85 % à moins de 50 km").length === 0, "conditions différentes");
  assert(sameConditionConflicts("80 % à moins de 50 km", "85 % à moins de 50 km").length === 1, "cas certain manqué");
});

await test("dimension « unité » : refusée si les deux citations utilisent la même unité, acceptée sinon", () => {
  const sameUnit = { key_facts: [fact("La population côtière atteint 85 % du total national"), fact("La population côtière atteint 90 % du total national")] };
  const sameUnitResult = findCandidates({ research: sameUnit });
  assert(sameUnitResult.candidates.length === 1, `${sameUnitResult.candidates.length} paires`);
  const refused = evaluateContradictions({ research: sameUnit, judge: judgeFor(sameUnitResult, () => ({ verdict: "compatible", dimension: "unité", quote_a: "85 % du total", quote_b: "90 % du total" })) }).findings[0];
  assert(refused.verdict === "unresolved" && refused.reasons.some(reason => reason.includes("dimension « unité » refusée : les deux citations utilisent la même unité (%)")), JSON.stringify(refused.reasons));
  const differentUnits = { key_facts: [fact("La surface des déserts australiens atteint 1 371 000 km²"), fact("La surface des déserts australiens atteint 18 % du territoire et 1 000 000 km²")] };
  const differentResult = findCandidates({ research: differentUnits });
  assert(differentResult.candidates.length === 1, `${differentResult.candidates.length} paires`);
  const accepted = evaluateContradictions({ research: differentUnits, judge: judgeFor(differentResult, () => ({ verdict: "compatible", dimension: "unité", quote_a: "1 371 000 km²", quote_b: "18 % du territoire" })) }).findings[0];
  assert(accepted.verdict === "compatible" && accepted.dimension === "unité", JSON.stringify(accepted.reasons));
});

await test("contradictions signalées librement par le juge : retenues si citées mot pour mot, sinon non résolues", () => {
  const dossier = { key_facts: [fact("Les pluies viennent de la mousson du nord"), fact("Le nord ne reçoit aucune pluie de mousson")] };
  const discovery = quotes => evaluateContradictions({ research: dossier, judge: { pairs: [{ candidate: "", a: "f1", b: "f2", verdict: "contradiction", dimension: "", category: "causalités", ...quotes, explanation: "Causes opposées." }] } });
  const found = discovery({ quote_a: "pluies viennent de la mousson", quote_b: "aucune pluie de mousson" });
  assert(found.findings[0].verdict === "contradiction" && found.findings[0].origin === "judge" && found.contested_facts.join() === "0,1", JSON.stringify(found.findings[0]));
  const invented = discovery({ quote_a: "texte inventé", quote_b: "aucune pluie de mousson" });
  assert(invented.findings[0].verdict === "unresolved", invented.findings[0].verdict);
});

await test("réponse du juge : contrôle strict (paire oubliée, paire inconnue, textes, verdict, catégorie)", () => {
  const result = findCandidates({ research: REAL });
  const input = buildContradictionJudgeInput(result);
  const good = judgeFor(result);
  assert(validateContradictionJudgeResponse(good, input).length === 0, validateContradictionJudgeResponse(good, input).join());
  const cases = [
    [{}, /pairs: \[\]/],
    [{ pairs: good.pairs.slice(1) }, /réponse attendue exactement une fois/],
    [{ pairs: [...good.pairs, { ...good.pairs[0], candidate: "c99" }] }, /paire inconnue c99/],
    [{ pairs: good.pairs.map((pair, index) => index === 0 ? { ...pair, b: "n999" } : pair) }, /textes a et b invalides/],
    [{ pairs: good.pairs.map((pair, index) => index === 0 ? { ...pair, verdict: "peut-être" } : pair) }, /verdict invalide/],
    [{ pairs: good.pairs.map((pair, index) => index === 0 ? { ...pair, category: "style" } : pair) }, /category invalide/]
  ];
  for (const [response, pattern] of cases) assert(pattern.test(validateContradictionJudgeResponse(response, input).join(" ; ")), String(pattern));
  assert(contradictionJudgeInputSha256(input) === contradictionJudgeInputSha256(structuredClone(input)), "empreinte stable");
});

async function withStubbedSdk(responses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-contradictions-judge-"));
  const original = Anthropic.Messages.prototype.create;
  const saved = { ack: process.env.PIPELINE_REAL_CALLS_ACK, noApi: process.env.NO_API, key: process.env.ANTHROPIC_API_KEY };
  const requests = [];

  Anthropic.Messages.prototype.create = async function (request) {
    requests.push(request);
    return { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "smoke", content: [{ type: "text", text: responses[requests.length - 1] }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn" };
  };
  process.env.PIPELINE_REAL_CALLS_ACK = "1";
  delete process.env.NO_API;
  process.env.ANTHROPIC_API_KEY ??= `sk-ant-smoke-${"x".repeat(60)}`;
  configureCallGuard({ productionDir: dir, cap: 2 });

  try {
    return { result: await fn(), requests };
  } catch (error) {
    return { error, requests };
  } finally {
    resetCallGuard();
    Anthropic.Messages.prototype.create = original;
    process.env.NO_API = saved.noApi;
    if (saved.ack === undefined) delete process.env.PIPELINE_REAL_CALLS_ACK; else process.env.PIPELINE_REAL_CALLS_ACK = saved.ack;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await test("juge des contradictions : via le garde des appels, une seule réparation, puis échec explicite", async () => {
  const result = findCandidates({ research: REAL });
  const input = buildContradictionJudgeInput(result);
  const good = JSON.stringify(judgeFor(result));
  const ok = await withStubbedSdk([good], () => runContradictionJudge(input));
  assert(!ok.error && ok.result.attempts === 1 && ok.requests[0].system.startsWith("Tu es le juge des contradictions de la chaîne YouTube"), ok.error?.message ?? "un appel");
  const repaired = await withStubbedSdk(["pas du JSON", good], () => runContradictionJudge(input));
  assert(!repaired.error && repaired.result.attempts === 2 && repaired.requests[1].messages[0].content.startsWith("RÉPARATION"), repaired.error?.message ?? "réparation");
  const broken = await withStubbedSdk(["pas du JSON", "{}"], () => runContradictionJudge(input));
  assert(/réponse invalide après réparation/.test(broken.error?.message ?? "") && broken.requests.length === 2, broken.error?.message ?? "échec");
});

await test("Truth Report : pause « contradiction à revoir » (HIGH, block), rien en report, fait MEDIUM seul non bloquant", () => {
  const result = findCandidates({ research: REAL });
  const contradictions = evaluateContradictions({ research: REAL, judge: judgeFor(result) });
  const block = buildTruthReport({ research: REAL, title: "Australie", contradictionEnforcement: "block", contradictions });
  assert(block.stop.stopped && block.stop.kind === "contradiction_review" && block.stop.actions.length === 3, JSON.stringify(block.stop.kind));
  assert(validateTruthReport(block, REAL).valid, validateTruthReport(block, REAL).errors.join());
  const md = renderTruthMarkdown(block);
  assert(md.includes("Pause — contradiction à revoir") && md.includes("dossier claims_requiring_sources[0]") && md.includes("Faits contestés :"), "Markdown");
  const report = buildTruthReport({ research: REAL, title: "Australie", contradictionEnforcement: "report", contradictions });
  assert(report.stop.stopped === false && report.contradictions.status === "contradictions", "mode rapport");
  const mediumOnly = { key_facts: [fact("Les villes regroupent 60 % de la population urbaine", "medium"), fact("Les villes regroupent 70 % de la population urbaine", "medium")] };
  const medium = buildTruthReport({ research: mediumOnly, title: "x", contradictionEnforcement: "block", contradictions: evaluateContradictions({ research: mediumOnly, judge: judgeFor(findCandidates({ research: mediumOnly })) }) });
  assert(medium.stop.stopped === false && medium.contradictions.counts.contradiction === 1, "fait MEDIUM bloquant");
});

await test("ordre des pauses : hiérarchie > preuves > contradictions > titre", () => {
  const contradictions = evaluateContradictions({ research: REAL, judge: judgeFor(findCandidates({ research: REAL })) });
  const evidence = { checked: true, skip_reason: null, counts: {}, offline_checks: [], facts: REAL.key_facts.map((_, index) => ({ index, editorial_status: index === 0 ? "rejected" : "supported", technical_status: "all_read", sources: [], elements: [], quote: null, reasons: ["r"] })) };
  const both = buildTruthReport({ research: REAL, title: "Pourquoi 95 % ?", evidenceEnforcement: "block", factEvidence: evidence, contradictionEnforcement: "block", contradictions, titleEnforcement: "block" });
  assert(both.stop.kind === "evidence_review", both.stop.kind);
  const noEvidence = buildTruthReport({ research: REAL, title: "Pourquoi 95 % ?", contradictionEnforcement: "block", contradictions, titleEnforcement: "block" });
  assert(noEvidence.stop.kind === "contradiction_review" && noEvidence.title.verdict === "not_demonstrated", noEvidence.stop.kind);
});

await test("Q-F8 : un fait contesté ne soutient plus le titre, seulement lorsque les contradictions ont été jugées", () => {
  const dossier = { key_facts: [fact("Environ 85 % de la population vit sur les côtes"), fact("Environ 60 % de la population vit sur les côtes")] };
  const title = "Pourquoi 85 % des Australiens vivent sur les côtes ?";
  const judged = evaluateContradictions({ research: dossier, judge: judgeFor(findCandidates({ research: dossier })) });
  assert(judged.contested_facts.join() === "0,1", judged.contested_facts.join());
  const contested = buildTruthReport({ research: dossier, title, contradictions: judged });
  const figure = contested.title.assertions.find(item => item.kind === "exact_figure");
  assert(figure.status === "not_supported" && figure.reasons.some(reason => reason.includes("contesté")), JSON.stringify(figure.reasons));
  const historical = buildTruthReport({ research: dossier, title, contradictions: evaluateContradictions({ research: dossier, skipReason: "production historique, aucun appel" }) });
  assert(historical.title.assertions.find(item => item.kind === "exact_figure").status === "supported", "production historique : définition du fait validé modifiée");
});

await test("déterminisme : mêmes entrées, mêmes octets", () => {
  const judge = judgeFor(findCandidates({ research: REAL }));
  const a = buildTruthReport({ research: REAL, title: "x", contradictionEnforcement: "block", contradictions: evaluateContradictions({ research: REAL, judge }) });
  const b = buildTruthReport({ research: REAL, title: "x", contradictionEnforcement: "block", contradictions: evaluateContradictions({ research: REAL, judge }) });
  assert(JSON.stringify(a) === JSON.stringify(b) && renderTruthMarkdown(a) === renderTruthMarkdown(b), "non déterministe");
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
