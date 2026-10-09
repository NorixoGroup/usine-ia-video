// Smoke R29.6 — outil de calibration du juge (corpus, exécution, métriques,
// rapport, CLI), entièrement en fixtures : aucun appel réel, aucune lecture de
// .env.local, createMessage n'est jamais lancé. Le transport est toujours
// simulé ou scripté ; les sous-processus tournent avec NO_API=1 et le garde
// réseau.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-judge-calibration-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deepStrictEqual, notDeepStrictEqual } from "node:assert/strict";

import {
  CALIBRATION_CORPUS_VERSION, DEFAULT_STAGE_PLAN, PARAPHRASE_CONNECTORS, UNSUPPORTED_SENTENCES,
  assertValidCorpus, buildCorpus, corpusIssues, entriesForStage, naturalEntries, paraphraseWitness, stableJson, unsupportedWitness
} from "./calibration/corpus.js";
import { cappedTransport, runCalibration, simulatedJudgeTransport, SIMULATION_MODES } from "./calibration/runner.js";
import * as metricsModule from "./calibration/metrics.js";
import { CRITERIA_THRESHOLDS, computeMetrics, evaluateCriteria, mean, percentile } from "./calibration/metrics.js";
import { buildResultsDocument, renderReport } from "./calibration/report.js";
import { buildCoverageLock, researchEntitiesOf } from "../src/utils/coverage-lock-builder.js";
import { composeCoverageBoundary } from "../src/utils/composite-coverage-boundary.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

delete process.env.ANTHROPIC_API_KEY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");
const CLI = path.join(ROOT, "scripts", "coverage-judge-calibration.js");
const LIB = path.join(ROOT, "scripts", "calibration");

let passed = 0;
let failed = 0;

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

const eq = deepStrictEqual;
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const tempDirs = [];
const tempDir = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `r29-6-${prefix}-`));
  tempDirs.push(dir);
  return dir;
};
const read = file => fs.readFileSync(file, "utf8");
const throwsWith = (fn, pattern) => {
  try {
    fn();
  } catch (error) {
    if (!pattern.test(error.message)) throw new Error(`message inattendu : ${error.message}`);
    return;
  }
  throw new Error("aucune erreur levée");
};

// ---------------------------------------------------------------------------
// Données de test : un script de 20 segments et son dossier Research.

const FACTS = Array.from({ length: 20 }, (_, index) => ({
  claim: `Le site numéro ${index + 1} couvre ${index + 11} hectares dans la vallée.`
}));
const SCRIPT = {
  sections: [0, 1].map(section => ({
    segments: FACTS.slice(section * 10, section * 10 + 10).map((fact, index) => ({
      voiceover: `Regardez bien cette scène. ${fact.claim} Le guide ${section * 10 + index + 1} confirme ce point.`,
      claims: [{ text: fact.claim }, { text: `Le guide ${section * 10 + index + 1} confirme ce point.` }]
    }))
  }))
};
const RESEARCH = { key_facts: FACTS };
const ids = (count, offset = 0) => Array.from({ length: count }, (_, index) => `s${Math.floor((index + offset) / 10) + 1}-g${((index + offset) % 10) + 1}`);
const NATURALS_20 = naturalEntries({ script: SCRIPT, research: RESEARCH, productionId: "prod-test", segmentIds: ids(20) });
const CORPUS_FULL = buildCorpus({ naturals: NATURALS_20, countB: 10, countC: 10 });
const NATURALS_3 = naturalEntries({ script: SCRIPT, research: RESEARCH, productionId: "prod-test", segmentIds: ["s1-g1", "s1-g2", "s2-g1"] });
const CORPUS_SMALL = buildCorpus({ naturals: NATURALS_3, countB: 6, countC: 4 });

// ---------------------------------------------------------------------------
console.log("--- 1. Corpus ---");

await test("constantes : version, banque de phrases non soutenues, accroches, plan d'étapes", () => {
  eq(CALIBRATION_CORPUS_VERSION, "judge-calibration-corpus.v1");
  eq(UNSUPPORTED_SENTENCES.map(item => item.id), ["causalite", "consequence", "propriete", "quantite", "date", "attribution"]);
  eq(PARAPHRASE_CONNECTORS.length, 3);
  eq(clone(DEFAULT_STAGE_PLAN), { pilot: { A: 3, B: 3, C: 2 }, stability: { A: 4, B: 3, C: 3 } });
  if (!Object.isFrozen(UNSUPPORTED_SENTENCES) || !Object.isFrozen(DEFAULT_STAGE_PLAN)) throw new Error("constantes modifiables");
});

await test("stableJson : indépendant de l'ordre des clés", () => {
  eq(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] }), stableJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  notDeepStrictEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
});

await test("entrées A : copie fidèle des segments désignés, dans l'ordre demandé", () => {
  eq(NATURALS_3.map(entry => entry.id), ["A-001", "A-002", "A-003"]);
  eq(NATURALS_3.map(entry => entry.origin), [
    { production_id: "prod-test", segment_id: "s1-g1" },
    { production_id: "prod-test", segment_id: "s1-g2" },
    { production_id: "prod-test", segment_id: "s2-g1" }
  ]);
  eq(NATURALS_3[0].segment.voiceover, SCRIPT.sections[0].segments[0].voiceover);
  eq(NATURALS_3[2].segment.claims, SCRIPT.sections[1].segments[0].claims);
  eq(NATURALS_3[0].research.key_facts.length, 20);
  eq(NATURALS_3.every(entry => entry.kind === "A" && entry.expect === null), true);
});

for (const [name, change, pattern] of [
  ["segment introuvable", { segmentIds: ["s9-g9"] }, /introuvable/],
  ["aucun segment désigné", { segmentIds: [] }, /aucun segment/],
  ["segment désigné en double", { segmentIds: ["s1-g1", "s1-g1"] }, /double/],
  ["identifiant de production absent", { productionId: "" }, /production/]
]) {
  await test(`entrées A refusées — ${name}`, () => {
    throwsWith(() => naturalEntries({ script: SCRIPT, research: RESEARCH, productionId: "p", segmentIds: ["s1-g1"], ...change }), pattern);
  });
}

await test("entrées A refusées — claims absents, claim sans texte, voiceover vide", () => {
  const bad = patch => ({ sections: [{ segments: [{ voiceover: "Une phrase. ", claims: [{ text: "x" }], ...patch }] }] });
  throwsWith(() => naturalEntries({ script: bad({ claims: [] }), research: RESEARCH, productionId: "p", segmentIds: ["s1-g1"] }), /claims/);
  throwsWith(() => naturalEntries({ script: bad({ claims: [{ text: "  " }] }), research: RESEARCH, productionId: "p", segmentIds: ["s1-g1"] }), /sans texte/);
  throwsWith(() => naturalEntries({ script: bad({ voiceover: "  " }), research: RESEARCH, productionId: "p", segmentIds: ["s1-g1"] }), /voiceover/);
});

await test("témoin B : phrase non soutenue ajoutée en fin de segment, début de l'ajout enregistré", () => {
  const base = NATURALS_3[0];
  const witness = unsupportedWitness(base, 0);
  const original = base.segment.voiceover.trimEnd();
  eq(witness.kind, "B");
  eq(witness.id, "B-001");
  eq(witness.origin, { ...base.origin, base_id: "A-001" });
  eq(witness.segment.voiceover, original + UNSUPPORTED_SENTENCES[0].text);
  eq(witness.segment.claims, base.segment.claims);
  eq(witness.expect, { injected_start: original.length + 1, sentence_id: "causalite" });
});

await test("témoin B : chacune des 6 phrases donne au moins une unité désignée à partir de l'ajout", () => {
  const entities = researchEntitiesOf(RESEARCH);
  const lock = buildCoverageLock({ entities });
  for (let index = 0; index < UNSUPPORTED_SENTENCES.length; index += 1) {
    const witness = unsupportedWitness(NATURALS_3[0], index);
    const boundary = composeCoverageBoundary({ voiceover: witness.segment.voiceover, lock, entities });
    const designated = new Set(boundary.analysed_unit_ids);
    const injected = boundary.units.map(item => item.unit).filter(unit => unit.start >= witness.expect.injected_start && designated.has(unit.id));
    if (injected.length === 0) throw new Error(`${UNSUPPORTED_SENTENCES[index].id} : aucune unité injectée désignée`);
    eq(boundary.units.map(item => item.unit.text).join(""), witness.segment.voiceover);
  }
});

await test("témoin B : la banque tourne après six témoins ; base C refusée ; ponctuation finale exigée", () => {
  eq(unsupportedWitness(NATURALS_3[0], 6).expect.sentence_id, "causalite");
  eq(unsupportedWitness(NATURALS_3[0], 7).expect.sentence_id, "consequence");
  throwsWith(() => unsupportedWitness(paraphraseWitness(NATURALS_3[0], 0), 0), /entrée A/);
  const noPunctuation = { ...NATURALS_3[0], segment: { ...NATURALS_3[0].segment, voiceover: "Une phrase sans point" } };
  throwsWith(() => unsupportedWitness(noPunctuation, 0), /ponctuation/);
});

await test("témoin C : claims du segment dans l'ordre inverse, précédés d'une accroche non factuelle", () => {
  const base = NATURALS_3[0];
  const witness = paraphraseWitness(base, 1);
  eq(witness.kind, "C");
  eq(witness.id, "C-002");
  eq(witness.segment.voiceover, `${PARAPHRASE_CONNECTORS[1]} ${base.segment.claims[1].text} ${base.segment.claims[0].text}`);
  eq(witness.expect, { all_covered: true, connector_id: 1 });
  eq(witness.segment.claims, base.segment.claims);
});

await test("corpus complet : 20 A, 10 B, 10 C — déterministe, octet pour octet", () => {
  eq(CORPUS_FULL.counts, { A: 20, B: 10, C: 10 });
  eq(CORPUS_FULL.version, CALIBRATION_CORPUS_VERSION);
  const again = buildCorpus({ naturals: naturalEntries({ script: SCRIPT, research: RESEARCH, productionId: "prod-test", segmentIds: ids(20) }), countB: 10, countC: 10 });
  eq(JSON.stringify(again), JSON.stringify(CORPUS_FULL));
  eq(again.corpus_sha256, CORPUS_FULL.corpus_sha256);
  eq(new Set(CORPUS_FULL.entries.map(entry => entry.id)).size, 40);
  eq(CORPUS_FULL.entries.slice(20, 30).map(entry => entry.origin.base_id), Array.from({ length: 10 }, (_, index) => `A-${String(index + 1).padStart(3, "0")}`));
});

await test("plan d'étapes du protocole : pilote 3 A + 3 B + 2 C (8), reste 32, stabilité 4 A + 3 B + 3 C (10)", () => {
  const stage1 = entriesForStage(CORPUS_FULL, 1);
  const stage2 = entriesForStage(CORPUS_FULL, 2);
  const stage3 = entriesForStage(CORPUS_FULL, 3);
  const kinds = entries => ({ A: entries.filter(entry => entry.kind === "A").length, B: entries.filter(entry => entry.kind === "B").length, C: entries.filter(entry => entry.kind === "C").length });
  eq([stage1.length, stage2.length, stage3.length], [8, 32, 10]);
  eq(kinds(stage1), { A: 3, B: 3, C: 2 });
  eq(kinds(stage2), { A: 17, B: 7, C: 8 });
  eq(kinds(stage3), { A: 4, B: 3, C: 3 });
  eq(stage3.every(entry => entry.stage === 1 || entry.stage === 2), true);
  eq(new Set([...stage1, ...stage2].map(entry => entry.id)).size, 40);
});

await test("buildCorpus : refus (aucune entrée A, effectifs invalides, entrée non A)", () => {
  throwsWith(() => buildCorpus({ naturals: [] }), /au moins une entrée A/);
  throwsWith(() => buildCorpus({ naturals: NATURALS_3, countB: -1 }), /effectifs/);
  throwsWith(() => buildCorpus({ naturals: [paraphraseWitness(NATURALS_3[0], 0)] }), /au moins une entrée A/);
});

await test("témoins manuels : un C écrit à la main est accepté, validé et marqué", () => {
  const corpus = buildCorpus({
    naturals: NATURALS_3,
    countB: 0,
    countC: 0,
    manualEntries: [{ kind: "C", research: RESEARCH, segment: { voiceover: "Regardez bien. Le site numéro 1 occupe onze hectares dans la vallée.", claims: [{ text: FACTS[0].claim }] } }]
  });
  eq(corpus.counts, { A: 3, B: 0, C: 1 });
  const manual = corpus.entries.at(-1);
  eq([manual.id, manual.origin, manual.expect], ["C-M001", { manual: true }, { all_covered: true }]);
  eq(corpusIssues(corpus), []);
  throwsWith(() => buildCorpus({ naturals: NATURALS_3, manualEntries: [{ kind: "A", segment: { voiceover: "x.", claims: [{ text: "x" }] } }] }), /kind B ou C/);
  throwsWith(() => buildCorpus({ naturals: NATURALS_3, manualEntries: [{ kind: "B", research: RESEARCH, segment: { voiceover: "Regardez bien. Ça change tout.", claims: [{ text: "x" }] } }] }), /injected_start/);
});

await test("corpusIssues : corpus valide, puis chaque falsification est détectée", () => {
  eq(corpusIssues(CORPUS_SMALL), []);
  eq(assertValidCorpus(CORPUS_SMALL), CORPUS_SMALL);
  const tamper = change => { const copy = clone(CORPUS_SMALL); change(copy); return corpusIssues(copy); };
  const has = (issues, pattern) => issues.some(issue => pattern.test(issue));
  if (!has(tamper(copy => { copy.entries[0].segment.voiceover += " x"; }), /corpus_sha256/)) throw new Error("contenu modifié non détecté");
  if (!has(tamper(copy => { copy.version = "autre"; }), /version/)) throw new Error("version non contrôlée");
  if (!has(tamper(copy => { copy.entries[1].id = copy.entries[0].id; }), /double/)) throw new Error("doublon non détecté");
  if (!has(tamper(copy => { copy.entries[0].stage = 3; }), /étape/)) throw new Error("étape invalide non détectée");
  if (!has(tamper(copy => { copy.entries[0].kind = "Z"; }), /sorte/)) throw new Error("sorte inconnue non détectée");
  if (!has(tamper(copy => { delete copy.entries.find(entry => entry.kind === "B").expect.injected_start; }), /injected_start/)) throw new Error("B sans début non détecté");
  if (!has(tamper(copy => { copy.entries[0].segment.claims = []; }), /claims/)) throw new Error("claims vides non détectés");
  if (!has(tamper(copy => { copy.counts.A = 99; }), /effectifs|corpus_sha256/)) throw new Error("effectifs non contrôlés");
  eq(corpusIssues(null), ["corpus illisible"]);
  throwsWith(() => assertValidCorpus({ ...CORPUS_SMALL, corpus_sha256: "0".repeat(64) }), /invalide/);
  throwsWith(() => entriesForStage(CORPUS_SMALL, 4), /étape inconnue/);
});

// ---------------------------------------------------------------------------
console.log("--- 2. Exécution (transport simulé ou scripté, porte de production) ---");

const HEADER = "SEGMENT A AUDITER :\n\n";
const payloadOf = request => JSON.parse(request.messages[0].content.slice(HEADER.length));

// Transport scripté : `decide(payload)` renvoie les résultats du juge.
function scripted(decide, { usage = {} } = {}) {
  return async request => {
    const payload = payloadOf(request);
    const text = JSON.stringify({
      protocol_id: payload.protocol_id,
      voiceover_sha256: payload.voiceover_sha256,
      lock_sha256: payload.lock_sha256,
      segment_id: payload.segment_id,
      results: decide(payload)
    });
    return {
      request_sha256: sha(JSON.stringify(request)),
      meta: { model: "scripte", input_tokens: 1000, output_tokens: 200, stop_reason: "end_turn", duration_ms: 10, ...usage },
      response: { content: [{ type: "text", text }] }
    };
  };
}
const allCovered = payload => payload.designated_unit_ids.map(unitId => ({ unit_id: unitId, verdict: "COVERED", operations: [] }));

await test("transport simulé : modes connus, mode inconnu et requête illisible refusés", async () => {
  eq([...SIMULATION_MODES], ["covered", "mixed", "declare"]);
  throwsWith(() => simulatedJudgeTransport({ mode: "reel" }), /mode inconnu/);
  let message = "";
  try { await simulatedJudgeTransport()({ system: "s", messages: [{ role: "user", content: "pas un segment" }] }); } catch (error) { message = error.message; }
  if (!/illisible/.test(message)) throw new Error("requête illisible acceptée");
});

await test("exécution (covered) : toutes les entrées PASS, un appel chacune, condensé complet et JSON simple", async () => {
  const entries = entriesForStage(CORPUS_SMALL, 1);
  const seen = [];
  const outcome = await runCalibration({ entries, transport: simulatedJudgeTransport({ mode: "covered" }), cap: 100, onRecord: record => seen.push(record.entry_id) });
  eq(outcome.halted, null);
  eq(outcome.records.length, entries.length);
  eq(seen, entries.map(entry => entry.id));
  eq(outcome.tool_calls, entries.length);
  for (const record of outcome.records) {
    eq([record.version, record.result.status, record.result.rounds, record.result.judge_calls], ["judge-calibration-record.v1", "PASS", 1, 1]);
    eq(record.rounds[0].judgment.status, "JUDGED");
    eq(record.rounds[0].judgment.usage.model, "simulation");
    eq(record.units_round1.map(unit => unit.text).join(""), entries.find(entry => entry.id === record.entry_id).segment.voiceover);
    eq(record.gate.status, "PASS");
    if (Object.isFrozen(record) || Object.isFrozen(record.rounds)) throw new Error("condensé gelé : pas du JSON simple");
    eq(JSON.parse(JSON.stringify(record)), record);
  }
  eq(new Set(outcome.records.map(record => record.gate.lock_sha256)).size, 1);
});

await test("exécution (mixed) : réparations et rondes multiples, entièrement déterministe", async () => {
  const entries = entriesForStage(CORPUS_SMALL, 1);
  const run = () => runCalibration({ entries, transport: simulatedJudgeTransport({ mode: "mixed" }), cap: 200, now: () => 0 });
  const first = await run();
  const second = await run();
  eq(JSON.stringify(first.records), JSON.stringify(second.records));
  eq(first.records.some(record => record.result.rounds > 1), true);
  eq(first.records.some(record => record.rounds.some(round => round.delete?.deleted_unit_ids.length > 0)), true);
});

await test("exécution (declare) : DECLARE refusé par la réparation, le segment est NOT_PASS REPAIR_REFUSED", async () => {
  const outcome = await runCalibration({ entries: entriesForStage(CORPUS_SMALL, 1).slice(0, 2), transport: simulatedJudgeTransport({ mode: "declare" }), cap: 20 });
  for (const record of outcome.records) {
    eq([record.result.status, record.result.reason], ["NOT_PASS", "REPAIR_REFUSED"]);
    eq(record.rounds[0].repair.refusal.code, "DECLARE_NOT_SUPPORTED");
    eq(record.rounds[0].judgment.verdicts[0].action, "DECLARE");
  }
  const metrics = computeMetrics(outcome.records);
  eq([metrics.verdicts.segments_blocked_by_declare, metrics.verdicts.declare_share_of_uncovered], [2, 1]);
});

await test("exécution : un témoin B dont l'unité injectée est jugée UNCOVERED est détecté puis réparé", async () => {
  const witness = unsupportedWitness(NATURALS_3[0], 0);
  const corpusEntry = { ...witness, stage: 1, stability: false };
  const transport = scripted(payload => {
    const entities = researchEntitiesOf(RESEARCH);
    const lock = buildCoverageLock({ entities });
    const boundary = composeCoverageBoundary({ voiceover: payload.voiceover, lock, entities });
    return payload.designated_unit_ids.map(unitId => {
      const unit = boundary.units.find(item => item.unit_id === unitId).unit;
      return unit.start >= witness.expect.injected_start && payload.voiceover.length === witness.segment.voiceover.length
        ? { unit_id: unitId, verdict: "UNCOVERED", operations: [{ action: "DELETE" }] }
        : { unit_id: unitId, verdict: "COVERED", operations: [] };
    });
  });
  const outcome = await runCalibration({ entries: [corpusEntry], transport, cap: 10 });
  const [record] = outcome.records;
  eq([record.result.status, record.result.rounds, record.result.judge_calls], ["PASS", 2, 2]);
  eq(record.rounds[0].delete.deleted_unit_ids.length > 0, true);
  const metrics = computeMetrics(outcome.records);
  eq([metrics.witnesses.B.injected_units, metrics.witnesses.B.detected, metrics.witnesses.B.recall, metrics.witnesses.B.original_false_uncovered], [1, 1, 1, 0]);
});

await test("plafond de l'outil : l'appel suivant est refusé, le lot s'arrête (JUDGE_CALL_REFUSED), jamais plus d'appels que le plafond", async () => {
  const entries = entriesForStage(CORPUS_SMALL, 1);
  const outcome = await runCalibration({ entries, transport: simulatedJudgeTransport({ mode: "covered" }), cap: 3 });
  eq(outcome.tool_calls, 3);
  eq(outcome.halted.reason, "JUDGE_CALL_REFUSED");
  eq(outcome.records.length, 4);
  eq(outcome.records.slice(0, 3).every(record => record.result.status === "PASS"), true);
  eq(outcome.halted.entry_id, entries[3].id);
});

await test("cappedTransport : compte chaque invocation, refus marqué call_refused, paramètres contrôlés", async () => {
  const transport = cappedTransport({ transport: async () => "ok", cap: 2 });
  eq([await transport({}), await transport({}), transport.invocations()], ["ok", "ok", 2]);
  let refusal = null;
  try { await transport({}); } catch (error) { refusal = error; }
  eq([refusal?.call_refused, transport.invocations()], [true, 2]);
  throwsWith(() => cappedTransport({ transport: null, cap: 1 }), /transport obligatoire/);
  throwsWith(() => cappedTransport({ transport: async () => {}, cap: 0 }), /plafond/);
});

await test("arrêt sur budget insuffisant, sonde en échec ou retrait de cache impossible ; sinon on continue", async () => {
  const entries = entriesForStage(CORPUS_SMALL, 1).slice(0, 3);
  for (const reason of ["BUDGET_INSUFFICIENT", "BUDGET_PROBE_FAILED", "CACHE_DISCARD_FAILED"]) {
    let calls = 0;
    const gate = async () => { calls += 1; return { status: "NOT_PASS", failure: { reason, category: "X", detail: "d" }, lock_sha256: null, protocol_id: null, budget_preflight: null, segments: [] }; };
    const outcome = await runCalibration({ entries, transport: async () => {}, cap: 5, gate });
    eq([calls, outcome.halted.reason, outcome.records.length], [1, reason, 1]);
  }
  let calls = 0;
  const gate = async () => { calls += 1; return { status: "NOT_PASS", failure: { reason: "NOT_JUDGED", category: null, detail: null }, lock_sha256: null, protocol_id: null, budget_preflight: null, segments: [] }; };
  const outcome = await runCalibration({ entries, transport: async () => {}, cap: 5, gate });
  eq([calls, outcome.halted, outcome.records.length, outcome.records[0].result], [3, null, 3, null]);
});

await test("la porte reçoit une entrée à la fois, un script d'un segment, avec le budget fourni et jamais de transport par défaut", async () => {
  const received = [];
  const budget = { status: () => ({}), probe: () => ({}) };
  const gate = async input => {
    received.push(input);
    return { status: "PASS", failure: null, lock_sha256: "l", protocol_id: "p", budget_preflight: null, segments: [] };
  };
  const entries = entriesForStage(CORPUS_SMALL, 1).slice(0, 2);
  await runCalibration({ entries, transport: async () => {}, cap: 5, gate, budget });
  eq(received.length, 2);
  eq(received[0].script, { sections: [{ segments: [{ voiceover: entries[0].segment.voiceover, claims: entries[0].segment.claims }] }] });
  eq(received[0].research, entries[0].research);
  eq(received.every(input => input.budget === budget && typeof input.transport === "function" && typeof input.coordinate === "function"), true);
  let message = "";
  try { await runCalibration({ entries, cap: 5 }); } catch (error) { message = error.message; }
  if (!/transport obligatoire/.test(message)) throw new Error("exécution sans transport acceptée");
  try { await runCalibration({ transport: async () => {}, cap: 5 }); message = ""; } catch (error) { message = error.message; }
  if (!/entrées obligatoires/.test(message)) throw new Error("exécution sans entrées acceptée");
});

await test("passe de stabilité : les condensés sont marqués stability_run", async () => {
  const outcome = await runCalibration({ entries: entriesForStage(CORPUS_SMALL, 3).slice(0, 2), transport: simulatedJudgeTransport(), cap: 10, stabilityRun: true });
  eq(outcome.records.every(record => record.stability_run === true), true);
});

// ---------------------------------------------------------------------------
console.log("--- 3. Métriques (calcul pur sur des résultats fabriqués) ---");

const U = (id, start, end, text) => ({ unit_id: id, type: "phrase", state: "analysed", start, end, text });
const V = (...items) => items.map(([unit_id, verdict, action = null, claim_id = null]) => ({ unit_id, verdict, action, claim_id }));
const USAGE = (input = 1000, output = 300, extra = {}) => ({ model: "m", input_tokens: input, output_tokens: output, stop_reason: "end_turn", duration_ms: 1200, ...extra });
const J = (verdicts, usage = USAGE()) => ({ status: "JUDGED", failure: null, request_sha256: "r", usage, verdicts });
const round = (n, judgment, extra = {}) => ({ round: n, boundary_status: "OK", designated: 2, judgment, repair: null, delete: null, ...extra });
const RESULT = (status, rounds, calls, reason = null) => ({ status, reason, category: null, unit_ids: [], rounds, judge_calls: calls, final_chars: 10, final_voiceover_sha256: "f" });
const REC = (entry_id, kind, result, rounds, extra = {}) => ({
  version: "judge-calibration-record.v1", entry_id, kind, stage: 1, stability_run: false,
  expect: kind === "B" ? { injected_start: 50, sentence_id: "x" } : null,
  initial: { voiceover_chars: 90, claims: 2 }, gate: { status: result?.status ?? "NOT_PASS", failure: null, lock_sha256: "l", protocol_id: "p", budget_preflight: null },
  result, units_round1: [U("u1", 0, 50, "Premier."), U("u2", 50, 90, "Second.")], rounds, wall_ms: 10, ...extra
});

const FIXTURE_RECORDS = [
  REC("A-001", "A", RESULT("PASS", 1, 1), [round(1, J(V(["u1", "COVERED"], ["u2", "COVERED"])))]),
  REC("A-002", "A", RESULT("NOT_PASS", 1, 1, "REPAIR_REFUSED"), [round(1, J(V(["u1", "COVERED"], ["u2", "UNCOVERED", "DECLARE", "s1-g1-c1"]), USAGE(1200, 400)),
    { repair: { status: "INPUT_REFUSED", refusal: { code: "DECLARE_NOT_SUPPORTED", unit_id: "u2" }, repaired_unit_ids: [] } })]),
  REC("B-001", "B", RESULT("PASS", 2, 2), [
    round(1, J(V(["u1", "COVERED"], ["u2", "UNCOVERED", "DELETE"]))),
    round(2, J(V(["u1", "COVERED"]), USAGE(900, 250, { duration_ms: 0 })))
  ]),
  REC("B-002", "B", RESULT("PASS", 1, 1), [round(1, J(V(["u1", "COVERED"], ["u2", "COVERED"])))]),
  REC("B-003", "B", RESULT("NOT_PASS", 2, 2, "JUDGE_NOT_JUDGED"), [
    round(1, J(V(["u1", "UNCOVERED", "DELETE"], ["u2", "UNCOVERED", "DELETE"]))),
    round(2, { status: "FAILED", failure: { category: "NOT_JUDGED", reason: "JSON illisible — fin inattendue" }, request_sha256: "r", usage: USAGE(800, 2000, { stop_reason: "max_tokens", duration_ms: 5000 }), verdicts: [] })
  ]),
  REC("C-001", "C", RESULT("PASS", 2, 2), [
    round(1, J(V(["u1", "COVERED"], ["u2", "COVERED"], ["u3", "UNCOVERED", "DELETE"]))),
    round(2, J(V(["u1", "COVERED"], ["u2", "COVERED"])))
  ]),
  REC("A-003", "A", RESULT("NOT_PASS", 1, 1, "JUDGE_NOT_JUDGED"), [
    round(1, { status: "FAILED", failure: { category: "NOT_JUDGED", reason: "appel en échec — exécuteur : TIMEOUT" }, request_sha256: null, usage: null, verdicts: [] })
  ]),
  REC("A-004", "A", RESULT("NOT_PASS", 1, 1, "REPAIR_REFUSED"), [round(1, J(V(["u1", "UNCOVERED", "DELETE"], ["u2", "COVERED"])),
    { repair: { status: "INPUT_REFUSED", refusal: { code: "PROTECTED_UNIT", unit_id: "u1" }, repaired_unit_ids: [] } })]),
  REC("C-002", "C", null, [], { gate: { status: "NOT_PASS", failure: { reason: "BUDGET_INSUFFICIENT", category: "PREFLIGHT", detail: "d" }, lock_sha256: "l", protocol_id: "p", budget_preflight: null } }),
  REC("A-001", "A", RESULT("PASS", 1, 1), [round(1, J(V(["u1", "COVERED"], ["u2", "UNCOVERED", "DELETE"])))], { stability_run: true }),
  REC("B-001", "B", RESULT("PASS", 1, 1), [round(1, J(V(["u1", "COVERED"], ["u2", "UNCOVERED", "DELETE"])))], { stability_run: true })
];
FIXTURE_RECORDS[5].units_round1.push(U("u3", 90, 120, "Troisième."));
const PRICES = { input_per_mtok: 3, output_per_mtok: 15 };

// Contrôles chiffrés des métriques ; renvoie les libellés qui échouent (vide si
// tout est conforme). Sert aussi de détecteur pour les mutants de la partie 5.
function metricsFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => {
    const same = typeof expected === "number" && typeof actual === "number"
      ? Math.abs(actual - expected) < 1e-9
      : JSON.stringify(actual) === JSON.stringify(expected);
    if (!same) failures.push(label);
  };
  check("percentile p50 de 1..7", module.percentile([7, 1, 3, 2, 5, 4, 6], 50), 4);
  check("percentile p90 de 1..10", module.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  check("percentile p100", module.percentile([3, 9, 1], 100), 9);
  check("percentile vide", module.percentile([], 50), null);
  check("moyenne", module.mean([1, 2, 6]), 3);
  check("moyenne vide", module.mean([]), null);

  const m = module.computeMetrics(clone(FIXTURE_RECORDS), { prices: PRICES });
  check("segments : total, exécutés, non exécutés", [m.segments.total, m.segments.run, m.segments.not_run], [9, 8, 1]);
  check("segments : PASS et NOT_PASS", [m.segments.pass, m.segments.not_pass], [4, 4]);
  check("segments : taux PASS", m.segments.pass_rate, 0.5);
  check("segments : PASS à la ronde 1", [m.segments.pass_round1, m.segments.pass_round1_rate], [2, 0.25]);
  check("segments : par sorte", m.segments.by_kind, { A: { run: 4, pass: 1, pass_rate: 0.25 }, B: { run: 3, pass: 2, pass_rate: 2 / 3 }, C: { run: 1, pass: 1, pass_rate: 1 } });
  check("segments : raisons de NOT_PASS", m.segments.not_pass_reasons, { BUDGET_INSUFFICIENT: 1, JUDGE_NOT_JUDGED: 2, REPAIR_REFUSED: 2 });
  check("rondes : distribution", m.segments.rounds, { count: 8, mean: 1.375, p50: 1, p90: 2, max: 2 });
  check("appels par segment : distribution", m.segments.calls_per_segment, { count: 8, mean: 1.375, p50: 1, p90: 2, max: 2 });
  check("appels : jugements, réponses, acceptés, rejetés", [m.calls.judgments, m.calls.replied, m.calls.accepted, m.calls.rejected], [13, 12, 11, 1]);
  check("appels : taux d'acceptation", m.calls.accepted_rate, 11 / 12);
  check("appels : cache, max_tokens, hors bornes, TIMEOUT", [m.calls.cache_hits, m.calls.max_tokens_stops, m.calls.out_of_bounds, m.calls.timeouts], [1, 1, 0, 1]);
  check("appels : appels du coordinateur", m.calls.coordinator_judge_calls, 13);
  check("appels : motifs de rejet", m.calls.rejection_reasons, { "JSON illisible — fin inattendue": 1 });
  check("appels : stop_reason", m.calls.stop_reasons, { end_turn: 11, max_tokens: 1 });
  check("appels : modèles", m.calls.models, ["m"]);
  check("appels : tokens d'entrée (facturés)", m.calls.input_tokens, { count: 11, mean: 1000, p50: 1000, p90: 1000, max: 1200 });
  check("usage : tokens", [m.usage.input_tokens, m.usage.output_tokens], [11000, 5100]);
  check("usage : coût", m.usage.cost_usd, 0.1095);
  check("usage : sans prix, pas de coût", module.computeMetrics(clone(FIXTURE_RECORDS)).usage.cost_usd, null);
  check("verdicts : effectifs", [m.verdicts.units_judged, m.verdicts.covered, m.verdicts.uncovered], [18, 12, 6]);
  check("verdicts : opérations", [m.verdicts.delete_operations, m.verdicts.declare_operations], [5, 1]);
  check("verdicts : part de DECLARE", m.verdicts.declare_share_of_uncovered, 1 / 6);
  check("verdicts : segments avec DECLARE et bloqués", [m.verdicts.segments_with_declare, m.verdicts.segments_blocked_by_declare, m.verdicts.segments_blocked_by_declare_rate], [1, 1, 1 / 8]);
  check("témoins B", m.witnesses.B, { entries: 3, evaluable: 3, injected_units: 3, detected: 2, recall: 2 / 3, original_units: 3, original_false_uncovered: 1 });
  check("témoins C", m.witnesses.C, { entries: 2, evaluable: 1, units: 3, covered: 2, covered_rate: 2 / 3, false_uncovered: 1 });
  check("stabilité", m.stability, { pairs: 2, comparable_pairs: 2, units: 4, agreeing_units: 3, agreement: 0.75, identical_entries: 1 });
  check("à relire", m.review.map(item => [item.entry_id, item.unit_id, item.action]), [["A-002", "u2", "DECLARE"], ["B-003", "u1", "DELETE"], ["C-001", "u3", "DELETE"], ["A-004", "u1", "DELETE"]]);

  const ok = module.evaluateCriteria(m, { cap: 100, toolCalls: 13, isolationOk: true, budgetUsd: 1 });
  check("critères : identifiants", ok.map(item => item.id), ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]);
  check("critères : résultats", ok.map(item => item.status), ["FAIL", "FAIL", "PASS", "FAIL", "FAIL", "FAIL", "PASS", "PASS"]);
  const onlyTimeouts = { ...m, calls: { ...m.calls, max_tokens_stops: 0, out_of_bounds: 0, timeouts: 1 } };
  check("critère C2 : TIMEOUT seul", module.evaluateCriteria(onlyTimeouts)[1].status, "FAIL");
  check("critère C2 : aucun incident", module.evaluateCriteria({ ...onlyTimeouts, calls: { ...onlyTimeouts.calls, timeouts: 0 } })[1].status, "PASS");
  return failures;
}

await test("métriques sur des résultats fabriqués : tous les agrégats (segments, appels, verdicts, témoins, stabilité, coût, relecture)", () => {
  eq(metricsFailures(metricsModule), []);
});

await test("métriques : entrée vide ou absente — aucun calcul impossible, tout à null ou 0", () => {
  for (const input of [[], undefined]) {
    const m = computeMetrics(input);
    eq([m.segments.total, m.segments.pass_rate, m.calls.accepted_rate, m.verdicts.declare_share_of_uncovered, m.witnesses.B.recall, m.witnesses.C.covered_rate, m.stability.agreement, m.usage.cost_usd], [0, null, null, null, null, null, null, null]);
    eq(evaluateCriteria(m).map(item => item.status), Array(8).fill("NOT_EVALUABLE"));
  }
});

await test("critères : seuils par défaut, seuils personnalisés, plafond dépassé, isolation, budget", () => {
  eq(clone(CRITERIA_THRESHOLDS), { accepted_first_try: 0.98, witness_b_recall: 0.9, witness_c_covered: 0.9, stability: 0.95, mean_calls_per_segment: 2, max_rounds: 4 });
  const base = {
    calls: { accepted_rate: 1, max_tokens_stops: 0, out_of_bounds: 0, timeouts: 0 },
    segments: { calls_per_segment: { mean: 1.2 }, rounds: { max: 2 } },
    witnesses: { B: { recall: 0.9 }, C: { covered_rate: 0.9 } },
    stability: { agreement: 0.95 },
    usage: { cost_usd: 1 }
  };
  const statuses = options => evaluateCriteria(base, options).map(item => item.status);
  eq(statuses({ cap: 10, toolCalls: 10, isolationOk: true, budgetUsd: 1 }), Array(8).fill("PASS"));
  eq(statuses({ cap: 10, toolCalls: 11, isolationOk: true, budgetUsd: 1 })[2], "FAIL");
  eq(statuses({ cap: 10, toolCalls: 10, isolationOk: false, budgetUsd: 1 })[2], "FAIL");
  eq(statuses({})[2], "NOT_EVALUABLE");
  eq(statuses({ budgetUsd: 0.99 })[7], "FAIL");
  eq(statuses({})[7], "NOT_EVALUABLE");
  const strict = { ...CRITERIA_THRESHOLDS, witness_b_recall: 0.95, max_rounds: 1 };
  const strictStatuses = evaluateCriteria(base, { thresholds: strict }).map(item => item.status);
  eq([strictStatuses[3], strictStatuses[6]], ["FAIL", "FAIL"]);
  const disturbed = { ...base, calls: { ...base.calls, timeouts: 1 } };
  eq(evaluateCriteria(disturbed)[1].status, "FAIL");
});

await test("calculs purs : percentile et moyenne exportés", () => {
  eq([percentile([5, 1, 3], 50), percentile([5, 1, 3], 100), mean([2, 4])], [3, 5, 3]);
});

// ---------------------------------------------------------------------------
console.log("--- 4. Rapport Markdown et JSON complet ---");

const metricsOfFixture = computeMetrics(clone(FIXTURE_RECORDS), { prices: PRICES });
const criteriaOfFixture = evaluateCriteria(metricsOfFixture, { cap: 100, toolCalls: 13, isolationOk: true, budgetUsd: 1 });
const IDENTITY = { mode: "real", stages: [1, 2, 3], head: "ffb5f84", lock_sha256: "l".repeat(64), protocol_id: "p".repeat(64), cap: 100, tool_calls: 13 };
const CORPUS_SUMMARY = { version: CORPUS_SMALL.version, corpus_sha256: CORPUS_SMALL.corpus_sha256, counts: CORPUS_SMALL.counts };
const render = (overrides = {}) => renderReport({ title: "Titre de test", identity: IDENTITY, corpus: CORPUS_SUMMARY, metrics: metricsOfFixture, criteria: criteriaOfFixture, halted: null, ...overrides });

await test("rapport : titre, neuf sections, huit critères, tables et valeurs clés", () => {
  const markdown = render();
  eq(markdown.startsWith("# Titre de test\n"), true);
  for (const heading of ["## 1. Identité de l'essai", "## 2. Verdict sur les critères", "## 3. Segments", "## 4. Appels, tokens, coût", "## 5. Verdicts et DECLARE", "## 6. Témoins", "## 7. Unités à relire", "## 8. Aide à la décision R29.7", "## 9. Limites"]) {
    if (!markdown.includes(heading)) throw new Error(`section absente : ${heading}`);
  }
  eq(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"].every(id => markdown.includes(`| ${id} |`)), true);
  for (const expected of ["ffb5f84", CORPUS_SUMMARY.corpus_sha256, "3 / 6 / 4", "0,1095 $", "16,7 %", "66,7 %", "75,0 %", "JSON illisible", "REPAIR_REFUSED"]) {
    if (!markdown.includes(expected)) throw new Error(`valeur absente : ${expected}`);
  }
  if (markdown.includes("SIMULATION")) throw new Error("bandeau de simulation en mode réel");
});

await test("rapport : bandeau de simulation, arrêt anticipé, aide R29.7 sans objet en simulation", () => {
  const markdown = render({ identity: { ...IDENTITY, mode: "simulation" }, halted: { entry_id: "B-002", reason: "BUDGET_INSUFFICIENT", detail: "minimum 3" } });
  for (const expected of ["SIMULATION", "Arrêt anticipé", "BUDGET_INSUFFICIENT sur B-002", "Sans objet en simulation"]) {
    if (!markdown.includes(expected)) throw new Error(`absent : ${expected}`);
  }
});

await test("rapport : orientation R29.7 — implémenter (≥ 10 %), retirer (≤ 2 %), zone intermédiaire, aucune mesure", () => {
  const withVerdicts = (share, blocked) => ({ ...metricsOfFixture, verdicts: { ...metricsOfFixture.verdicts, declare_share_of_uncovered: share, segments_blocked_by_declare_rate: blocked } });
  const orientation = metrics => render({ metrics }).match(/\*\*Orientation chiffrée : ([^*]+)\.\*\*|Aucun verdict UNCOVERED[^\n]*/)[0];
  if (!/implémenter DECLARE/.test(orientation(withVerdicts(0.2, 0)))) throw new Error("≥ 10 % non reconnu");
  if (!/implémenter DECLARE/.test(orientation(withVerdicts(0, 0.1)))) throw new Error("blocage ≥ 10 % non reconnu");
  if (!/retirer DECLARE/.test(orientation(withVerdicts(0.02, 0)))) throw new Error("≤ 2 % non reconnu");
  if (!/zone intermédiaire/.test(orientation(withVerdicts(0.05, 0.02)))) throw new Error("zone intermédiaire non reconnue");
  if (!/Aucun verdict UNCOVERED/.test(orientation(withVerdicts(null, null)))) throw new Error("absence de mesure non signalée");
});

await test("rapport : déterministe, barres verticales échappées, sans unité à relire", () => {
  eq(render(), render());
  const piped = { ...metricsOfFixture, review: [{ entry_id: "A-009", kind: "A", unit_id: "u1", action: "DELETE", claim_id: null, text: "a | b\nc" }] };
  if (!render({ metrics: piped }).includes("a \\| b c")) throw new Error("barre verticale non échappée");
  if (!render({ metrics: { ...metricsOfFixture, review: [] } }).includes("Aucune unité jugée UNCOVERED hors unités injectées.")) throw new Error("relecture vide non signalée");
});

await test("JSON complet : version, identité, corpus résumé, métriques, critères, tous les condensés", () => {
  const document = buildResultsDocument({ identity: IDENTITY, corpus: { ...CORPUS_SMALL }, halted: null, records: FIXTURE_RECORDS, metrics: metricsOfFixture, criteria: criteriaOfFixture });
  eq(Object.keys(document), ["version", "identity", "corpus", "halted", "metrics", "criteria", "records"]);
  eq(document.version, "judge-calibration-results.v1");
  eq(document.corpus, CORPUS_SUMMARY);
  eq(document.records.length, FIXTURE_RECORDS.length);
  eq(JSON.parse(JSON.stringify(document)), clone(document));
});

// ---------------------------------------------------------------------------
console.log("--- 5. CLI (sous-processus, NO_API=1, garde réseau) ---");

function cli(args, { env = { NO_API: "1" } } = {}) {
  const result = spawnSync(process.execPath, ["--import", GUARD, CLI, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8"
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}
const refused = (result, pattern) => {
  if (result.status !== 1) throw new Error(`code ${result.status} au lieu de 1 — ${result.err.slice(-200)}`);
  if (!pattern.test(result.err)) throw new Error(`message inattendu : ${result.err.slice(-250)}`);
};

const WORK = tempDir("cli");
const PRODUCTION = path.join(WORK, "prod-test");
fs.mkdirSync(PRODUCTION);
fs.writeFileSync(path.join(PRODUCTION, "script.json"), JSON.stringify(SCRIPT));
fs.writeFileSync(path.join(PRODUCTION, "truth.json"), JSON.stringify({ data: { research_dossier: RESEARCH } }));
const productionHashes = () => ["script.json", "truth.json"].map(name => sha(read(path.join(PRODUCTION, name))));
const productionBefore = productionHashes();
const CORPUS_FILE = path.join(WORK, "corpus.json");

await test("CLI build : corpus écrit, effectifs et empreinte annoncés, production désignée intacte", () => {
  const result = cli(["build", `--production-dir=${PRODUCTION}`, "--segments=s1-g1,s1-g2,s2-g1", "--count-b=6", "--count-c=4", `--out=${CORPUS_FILE}`]);
  eq(result.status, 0);
  const corpus = JSON.parse(read(CORPUS_FILE));
  eq(corpus.counts, { A: 3, B: 6, C: 4 });
  eq(corpus.corpus_sha256, CORPUS_SMALL.corpus_sha256 === corpus.corpus_sha256 ? CORPUS_SMALL.corpus_sha256 : corpus.corpus_sha256);
  eq(corpusIssues(corpus), []);
  if (!result.out.includes(corpus.corpus_sha256)) throw new Error("empreinte non annoncée");
  eq(entriesForStage(corpus, 1).length, 8);
  eq(productionHashes(), productionBefore);
});

await test("CLI build : même corpus que la construction en mémoire (production identique, identifiant de dossier compris)", () => {
  const corpus = JSON.parse(read(CORPUS_FILE));
  const expected = buildCorpus({ naturals: naturalEntries({ script: SCRIPT, research: RESEARCH, productionId: "prod-test", segmentIds: ["s1-g1", "s1-g2", "s2-g1"] }), countB: 6, countC: 4 });
  eq(corpus, JSON.parse(JSON.stringify(expected)));
});

await test("CLI build : refus (sortie existante, sortie dans src/ ou projects/, segment introuvable, dossier absent, sans sous-commande)", () => {
  refused(cli(["build", `--production-dir=${PRODUCTION}`, "--segments=s1-g1", `--out=${CORPUS_FILE}`]), /existe déjà/);
  refused(cli(["build", `--production-dir=${PRODUCTION}`, "--segments=s1-g1", `--out=${path.join(ROOT, "src", "corpus-interdit.json")}`]), /ne peut pas être dans/);
  refused(cli(["build", `--production-dir=${PRODUCTION}`, "--segments=s1-g1", `--out=${path.join(ROOT, "projects", "corpus-interdit.json")}`]), /ne peut pas être dans/);
  refused(cli(["build", `--production-dir=${PRODUCTION}`, "--segments=s9-g9", `--out=${path.join(WORK, "autre.json")}`]), /introuvable/);
  refused(cli(["build", `--production-dir=${path.join(WORK, "absent")}`, "--segments=s1-g1", `--out=${path.join(WORK, "autre.json")}`]), /introuvable/);
  refused(cli([]), /sous-commande attendue/);
  refused(cli(["build", "--segments=s1-g1"]), /--production-dir/);
  eq([fs.existsSync(path.join(ROOT, "src", "corpus-interdit.json")), fs.existsSync(path.join(ROOT, "projects", "corpus-interdit.json"))], [false, false]);
  eq(productionHashes(), productionBefore);
});

const OUT = path.join(WORK, "out");

await test("CLI run : un mode est obligatoire, un seul ; mode, étape, corpus et sortie contrôlés ; rien n'est créé", () => {
  const base = ["run", `--corpus=${CORPUS_FILE}`, "--stage=1", `--out=${OUT}`];
  refused(cli(base), /choisir exactement un mode/);
  refused(cli([...base, "--simulate=covered", "--real"]), /choisir exactement un mode/);
  refused(cli([...base, "--simulate=reel"]), /mode inconnu/);
  refused(cli(["run", `--corpus=${CORPUS_FILE}`, "--stage=4", `--out=${OUT}`, "--simulate=covered"]), /--stage/);
  refused(cli(["run", `--corpus=${path.join(WORK, "absent.json")}`, "--stage=1", `--out=${OUT}`, "--simulate=covered"]), /illisible/);
  refused(cli(["run", `--corpus=${CORPUS_FILE}`, "--stage=1", `--out=${path.join(ROOT, "projects", "sortie-interdite")}`, "--simulate=covered"]), /ne peut pas être dans/);
  refused(cli([...base.slice(0, 3), "--simulate=covered"]), /--out/);
  const tampered = clone(JSON.parse(read(CORPUS_FILE)));
  tampered.entries[0].segment.voiceover += " altéré";
  const tamperedFile = path.join(WORK, "altere.json");
  fs.writeFileSync(tamperedFile, JSON.stringify(tampered));
  refused(cli(["run", `--corpus=${tamperedFile}`, "--stage=1", `--out=${OUT}`, "--simulate=covered"]), /corpus_sha256/);
  eq([fs.existsSync(OUT), fs.existsSync(path.join(ROOT, "projects", "sortie-interdite"))], [false, false]);
});

await test("CLI run --real : refusé sous NO_API=1, sans accusé, sans plafond valide — avant tout chargement de service, rien n'est créé", () => {
  const base = ["run", `--corpus=${CORPUS_FILE}`, "--stage=1", `--out=${OUT}`, "--real"];
  refused(cli(base), /NO_API=1/);
  refused(cli(base, { env: {} }), /PIPELINE_REAL_CALLS_ACK=1/);
  refused(cli(base, { env: { PIPELINE_REAL_CALLS_ACK: "1" } }), /--cap/);
  refused(cli([...base, "--cap=0"], { env: { PIPELINE_REAL_CALLS_ACK: "1" } }), /--cap/);
  refused(cli([...base, "--cap=501"], { env: { PIPELINE_REAL_CALLS_ACK: "1" } }), /--cap/);
  refused(cli([...base, "--cap=abc"], { env: { PIPELINE_REAL_CALLS_ACK: "1" } }), /--cap/);
  eq(fs.existsSync(OUT), false);
});

await test("CLI run : les étapes 2 et 3 exigent l'étape précédente complète ; aucune réécriture", () => {
  const stage = (n, extra = []) => cli(["run", `--corpus=${CORPUS_FILE}`, `--stage=${n}`, `--out=${OUT}`, "--simulate=mixed", ...extra]);
  refused(stage(2), /exige le rapport de l'étape 1/);
  refused(stage(3), /exige le rapport de l'étape 1/);
  eq(fs.existsSync(OUT), false);

  const first = stage(1);
  eq(first.status, 0);
  if (!/Étape 1 \(simulation\) : 8\/8/.test(first.out)) throw new Error(first.out);
  refused(stage(1), /existe déjà/);
  refused(stage(3), /exige le rapport de l'étape 2/);

  const stage1File = path.join(OUT, "stage-1.json");
  const original = read(stage1File);
  const halted = JSON.parse(original);
  halted.halted = { entry_id: "B-001", reason: "BUDGET_INSUFFICIENT", detail: null };
  fs.writeFileSync(stage1File, JSON.stringify(halted));
  refused(stage(2), /s'est arrêtée/);
  const otherCorpus = JSON.parse(original);
  otherCorpus.corpus.corpus_sha256 = "0".repeat(64);
  fs.writeFileSync(stage1File, JSON.stringify(otherCorpus));
  refused(stage(2), /corpus différent/);
  const otherMode = JSON.parse(original);
  otherMode.identity.mode = "real";
  fs.writeFileSync(stage1File, JSON.stringify(otherMode));
  refused(stage(2), /mode « real » différent/);
  fs.writeFileSync(stage1File, original);
});

await test("CLI : simulation complète (étapes 1, 2, 3 puis rapport final) — fichiers, effectifs, bandeau, critères, déterminisme", () => {
  const stage = (n, out = OUT) => cli(["run", `--corpus=${CORPUS_FILE}`, `--stage=${n}`, `--out=${out}`, "--simulate=mixed", "--price-in=3", "--price-out=15", "--budget-usd=5"]);
  eq(stage(2).status, 0);
  eq(stage(3).status, 0);
  const final = cli(["finalize", `--out=${OUT}`, "--price-in=3", "--price-out=15", "--budget-usd=5"]);
  eq(final.status, 0);
  for (const name of ["stage-1.json", "stage-1-report.md", "stage-2.json", "stage-3.json", "R29.6-rapport-calibration.md", "R29.6-donnees.json"]) {
    if (!fs.existsSync(path.join(OUT, name))) throw new Error(`fichier absent : ${name}`);
  }
  const document = JSON.parse(read(path.join(OUT, "R29.6-donnees.json")));
  eq([document.version, document.identity.mode, document.identity.stages, document.corpus.counts], ["judge-calibration-results.v1", "simulation", [1, 2, 3], { A: 3, B: 6, C: 4 }]);
  eq(document.records.length, 8 + 5 + 9);
  eq(document.records.filter(record => record.stability_run).length, 9);
  eq(document.metrics.stability.pairs, 9);
  eq(document.criteria.map(item => item.id), ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"]);
  eq(document.criteria.find(item => item.id === "C3").status, "PASS");
  eq(document.criteria.find(item => item.id === "C8").status, "PASS");
  const markdown = read(path.join(OUT, "R29.6-rapport-calibration.md"));
  if (!markdown.includes("SIMULATION") || !markdown.includes("## 9. Limites")) throw new Error("rapport final incomplet");
  refused(cli(["finalize", `--out=${OUT}`]), /EEXIST|erreur inattendue/);

  const second = path.join(WORK, "out-bis");
  for (const n of [1, 2, 3]) eq(stage(n, second).status, 0);
  eq(cli(["finalize", `--out=${second}`]).status, 0);
  const again = JSON.parse(read(path.join(second, "R29.6-donnees.json")));
  eq(again.metrics, document.metrics);
  eq(again.records.map(({ wall_ms, ...rest }) => rest), document.records.map(({ wall_ms, ...rest }) => rest));
  eq(productionHashes(), productionBefore);
});

await test("CLI finalize : étapes 1 et 2 obligatoires, corpus et mode cohérents", () => {
  const empty = path.join(WORK, "vide");
  fs.mkdirSync(empty);
  refused(cli(["finalize", `--out=${empty}`]), /stage-1\.json absent/);
  const partial = path.join(WORK, "partiel");
  eq(cli(["run", `--corpus=${CORPUS_FILE}`, "--stage=1", `--out=${partial}`, "--simulate=covered"]).status, 0);
  refused(cli(["finalize", `--out=${partial}`]), /stage-2\.json absent/);
});

await test("CLI : aucun appel réel pendant tout le smoke (les sous-processus tournent sous le garde réseau, NO_API=1)", () => {
  const result = cli(["run", `--corpus=${CORPUS_FILE}`, "--stage=1", `--out=${path.join(WORK, "garde")}`, "--simulate=covered"]);
  eq(result.status, 0);
  if (!/tentatives bloquées : 0/.test(result.err)) throw new Error(result.err.slice(-200));
});

// ---------------------------------------------------------------------------
console.log("--- 6. Isolation : l'outil reste hors du pipeline de production ---");

const codeOf = file => read(file).split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
const importsOf = file => [...codeOf(file).matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map(match => match[1]);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const LIB_FILES = fs.readdirSync(LIB).map(name => path.join(LIB, name));

await test("modules purs : metrics.js et report.js n'importent rien ; corpus.js, runner.js n'importent que du calcul pur et la porte", () => {
  eq(importsOf(path.join(LIB, "metrics.js")), []);
  eq(importsOf(path.join(LIB, "report.js")), []);
  eq(importsOf(path.join(LIB, "corpus.js")).sort(), ["../../src/utils/composite-coverage-boundary.js", "../../src/utils/coverage-lock-builder.js", "node:crypto"]);
  eq(importsOf(path.join(LIB, "runner.js")).sort(), ["../../src/utils/coverage-lock-builder.js", "../../src/utils/coverage-coordinator.js", "../../src/utils/script-coverage-gate.js", "./corpus.js"].sort());
});

await test("CLI : imports statiques sans service ; services chargés seulement dans la branche réelle, après toutes les vérifications", () => {
  const staticImports = importsOf(CLI);
  eq(staticImports.some(name => /services\/|anthropic|call-guard/.test(name)), false);
  const source = read(CLI);
  const branch = source.indexOf("if (real) {\n    // Les services de production ne sont chargés qu'ici");
  if (branch === -1) throw new Error("branche réelle introuvable");
  const dynamic = [...source.matchAll(/import\("([^"]+)"\)/g)];
  eq(dynamic.map(match => match[1]), ["../src/services/call-guard.js", "../src/services/anthropic.js"]);
  eq(dynamic.every(match => match.index > branch), true);
  const checks = ["NO_API", "PIPELINE_REAL_CALLS_ACK", "--cap=<N>"].map(token => source.indexOf(token));
  eq(checks.every(position => position > -1 && position < branch), true);
});

await test("aucun appel : createMessage n'est jamais appelé ni passé au transport par un module de l'outil, hors branche réelle du CLI", () => {
  for (const file of LIB_FILES) {
    const code = codeOf(file);
    if (/createMessage/.test(code)) throw new Error(`${path.basename(file)} mentionne createMessage`);
    if (/anthropic|call-guard|ANTHROPIC/i.test(code)) throw new Error(`${path.basename(file)} référence le service`);
  }
  const cliCode = codeOf(CLI);
  eq((cliCode.match(/createMessage\s*\(/g) ?? []).length, 0);
  eq((cliCode.match(/createMessage/g) ?? []).length, 1);
});

await test("jamais de lecture de .env.local ni de la clé : aucun module de l'outil ne lit un fichier d'environnement ou ANTHROPIC_API_KEY", () => {
  for (const file of [...LIB_FILES, CLI]) {
    const code = codeOf(file).replace(/delete process\.env\.ANTHROPIC_API_KEY;/g, "");
    if (/\.env\.local|["'`]\.env/.test(code)) throw new Error(`${path.basename(file)} référence un fichier .env`);
    if (/ANTHROPIC_API_KEY/.test(code)) throw new Error(`${path.basename(file)} touche la clé`);
  }
});

await test("hors pipeline : rien dans src/ ni dans les autres scripts n'importe l'outil ; le CLI n'est pas un smoke", () => {
  for (const file of walk(path.join(ROOT, "src")).filter(name => name.endsWith(".js"))) {
    if (/calibration/i.test(read(file))) throw new Error(`${path.relative(ROOT, file)} référence la calibration`);
  }
  for (const file of fs.readdirSync(path.join(ROOT, "scripts")).filter(name => name.endsWith(".js"))) {
    if (file === "coverage-judge-calibration.js" || file === "coverage-judge-calibration-smoke.js") continue;
    if (/calibration\//.test(read(path.join(ROOT, "scripts", file))) || /coverage-judge-calibration/.test(read(path.join(ROOT, "scripts", file)))) {
      throw new Error(`scripts/${file} référence l'outil`);
    }
  }
  eq(/-smoke\.js$/.test(path.basename(CLI)), false);
  const packageJson = JSON.parse(read(path.join(ROOT, "package.json")));
  eq(JSON.stringify(packageJson.scripts).includes("calibration"), false);
});

await test("aucune écriture hors du dossier de sortie : le CLI refuse src/ et projects/, et n'écrit qu'avec le drapeau « wx »", () => {
  const source = read(CLI);
  eq(source.includes('FORBIDDEN_OUTPUT_PARENTS = [path.join(ROOT, "projects"), path.join(ROOT, "src")]'), true);
  const writes = [...source.matchAll(/fs\.writeFileSync\(/g)].length;
  const exclusive = [...source.matchAll(/\{ flag: "wx" \}/g)].length;
  eq(writes, exclusive);
});

// ---------------------------------------------------------------------------
console.log("--- 7. Mutations des métriques (copies hors dépôt) ---");

async function isolatedMetrics(replacements = []) {
  const root = tempDir("mutant");
  let source = read(path.join(LIB, "metrics.js"));
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from.slice(0, 70)}`);
    source = source.replace(from, to);
  }
  const file = path.join(root, "metrics.js");
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

const MUTATIONS = [
  ["percentile : rang par défaut au lieu de par excès", [{ from: "const rank = Math.ceil((p / 100) * sorted.length);", to: "const rank = Math.floor((p / 100) * sorted.length);" }]],
  ["moyenne : division par le nombre moins un", [{ from: "return values.reduce((sum, value) => sum + value, 0) / values.length;", to: "return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length - 1);" }]],
  ["part de DECLARE : dénominateur = COVERED", [{ from: "declare_share_of_uncovered: rate(declares.length, uncovered.length),", to: "declare_share_of_uncovered: rate(declares.length, verdictLists.length - uncovered.length)," }]],
  ["témoin B : unités d'origine comptées comme injectées", [{ from: "if (unit.start >= record.expect.injected_start) {", to: "if (unit.start >= 0) {" }]],
  ["stabilité : tout verdict réputé identique", [{ from: "if (other.get(item.unit_id) === item.verdict) agreeing += 1;", to: "agreeing += 1;" }]],
  ["coût : réponses du cache facturées", [{ from: "const billed = calls.filter(call => call.usage !== null && !call.cache_hit);", to: "const billed = calls.filter(call => call.usage !== null);" }]],
  ["critère C4 : comparaison inversée", [{ from: "verdictOf(metrics.witnesses.B.recall, metrics.witnesses.B.recall >= thresholds.witness_b_recall)", to: "verdictOf(metrics.witnesses.B.recall, metrics.witnesses.B.recall <= thresholds.witness_b_recall)" }]],
  ["taux d'acceptation : calculé sur tous les jugements", [{ from: "accepted_rate: rate(replied.filter(call => call.accepted).length, replied.length),", to: "accepted_rate: rate(replied.filter(call => call.accepted).length, calls.length)," }]],
  ["PASS à la ronde 1 : rondes ignorées", [{ from: "pass_round1: passed.filter(record => record.result.rounds === 1).length,", to: "pass_round1: passed.length," }]],
  ["relecture : unités injectées incluses", [{ from: "if (injected) continue;", to: "" }]],
  ["blocage par DECLARE : refus quelconque", [{ from: 'round.repair?.refusal?.code === "DECLARE_NOT_SUPPORTED"', to: "round.repair?.refusal" }]],
  ["critère C2 : TIMEOUT ignorés", [{ from: "metrics.calls.max_tokens_stops + metrics.calls.out_of_bounds + metrics.calls.timeouts", to: "metrics.calls.max_tokens_stops + metrics.calls.out_of_bounds" }]]
];

await test("mutations : témoin (copie non mutée, hors dépôt) sans aucun écart", async () => {
  eq(metricsFailures(await isolatedMetrics()), []);
});

for (const [name, replacements] of MUTATIONS) {
  await test(`mutation détectée : ${name}`, async () => {
    let failures;
    try {
      failures = metricsFailures(await isolatedMetrics(replacements));
    } catch (error) {
      failures = [`exception : ${error.message}`];
    }
    if (failures.length === 0) throw new Error("mutant non détecté");
    console.log(`       témoin : ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? ", …" : ""}`);
  });
}

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });

await test("aucune tentative réseau", () => eq(networkGuard.attempts().length, 0));

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-judge-calibration-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
