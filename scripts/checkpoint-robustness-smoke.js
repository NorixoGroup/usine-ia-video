// Smoke R23-D — robustesse avant première production, zéro API.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/checkpoint-robustness-smoke.js
//
// 1. Limite de sortie sûre des chapitres : déterministe, calculée avant
//    chaque génération, sous le seuil de streaming du SDK.
// 2. Une réponse invalide (tronquée, JSON invalide, structure, validations,
//    grounding) ne devient jamais un checkpoint ; elle est écartée du cache ;
//    la reprise réutilise les checkpoints valides et refait seulement le reste.
// Le SDK est mocké en mémoire (garde réelle, journal et cache réels, clé
// factice) ; le garde réseau bloque toute sortie.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { createMessage } from "../src/services/anthropic.js";
import {
  CACHE_DIR,
  JOURNAL_FILE,
  configureCallGuard,
  resetCallGuard,
  discardCachedResponse
} from "../src/services/call-guard.js";
import {
  runScriptAgent,
  chapterPlan,
  chapterOutputBudget,
  SAFE_OUTPUT_CEILING
} from "../src/agents/script.js";
import { runVisualDirector } from "../src/agents/visual-director.js";
import { runResearchAgent } from "../src/agents/research.js";
import { CANONICAL_TITLE, CANONICAL_PROMPT } from "../src/fixtures/anthropic-dataset.js";
import { coverageUnitSplitterVersion, splitCoverageUnits } from "../src/utils/coverage-unit-splitter.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau (node --import ./scripts/fixture-network-guard.js).");
  process.exit(1);
}

delete process.env.ANTHROPIC_API_KEY;

const DUMMY_KEY = "x".repeat(60);
const SHORT = { name: "short", target: 4, min: 3, max: 5, sections: { min: 3, max: 4 } };
const STANDARD = { name: "standard", target: 27, min: 25, max: 30, sections: { min: 6, max: 8 } };

let passed = 0;
let failed = 0;
const tempDirs = [];

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

async function expectReject(fn, pattern) {
  let error = null;

  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "une erreur était attendue, aucune n'a été levée");
  assert(pattern.test(error.message), `erreur inattendue : ${error.message}`);

  return error;
}

async function withEnv(overrides, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-robustness-"));
  tempDirs.push(directory);
  return directory;
}

const REAL_ENV = { ANTHROPIC_FIXTURES: undefined, NO_API: undefined, PIPELINE_REAL_CALLS_ACK: "1", ANTHROPIC_API_KEY: DUMMY_KEY };

// --- Faux Claude ---------------------------------------------------------------------
// Comportements réglables par `faults` (consommés une fois quand `once`).

const text = (value, stopReason = "end_turn") => ({
  id: "msg_mock",
  model: "mock-model",
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  usage: { input_tokens: 10, output_tokens: 20 },
  stop_reason: stopReason
});

function makeHandler({ research, faults }) {
  const facts = research.key_facts.map((fact, index) => ({ fact, index }));
  const fact = n => facts[n % facts.length];

  return request => {
    const system = String(request.system ?? "");
    const user = String(request.messages[0].content);

    if (system.startsWith("Tu es le Script Agent")) {
      const [, i, total] = /Rédige le chapitre (\d+)\/(\d+)/.exec(user).map(Number);
      const seconds = Number(/environ (\d+) secondes/.exec(user)[1]);
      const fault = faults.chapter?.[i];

      if (fault === "truncate") { delete faults.chapter[i]; return text("{\"title\": \"tronq", "max_tokens"); }
      if (fault === "json") { delete faults.chapter[i]; return text("pas du JSON"); }

      const segments = Array.from({ length: 4 }, (_, j) => {
        const { fact: f, index } = fact(i * 4 + j);
        const ref = fault === "badref" && j === 0 ? research.key_facts.length + 5 : index;
        const claim = `Chapitre ${i}, fait ${index}.`;

        return {
          voiceover: `${claim}${fault === "uncovered" && j === 1 ? " NONCOUVERT" : ""}`,
          estimated_seconds: seconds / 4,
          research_fact_refs: [ref],
          contains_unverified_claim: f.verification_status !== "verified",
          claims: [{ text: claim, research_fact_ref: ref, is_unverified: f.verification_status !== "verified" }]
        };
      });

      if (fault === "badref") delete faults.chapter[i];
      if (fault === "uncovered") delete faults.chapter[i];

      return text({ title: `Chapitre ${i}`, purpose: `Objectif ${i}/${total}`, ...(i === 1 ? { thesis: "Thèse factuelle." } : {}), segments });
    }

    // R28.10 : juge de couverture v2 (identifiants d'unités), un segment par appel.
    if (system.startsWith("Tu es un auditeur de couverture factuelle") && user.startsWith("SEGMENT A AUDITER :\n\n")) {
      const payload = JSON.parse(user.slice("SEGMENT A AUDITER :\n\n".length));
      const units = splitCoverageUnits({ voiceover: payload.voiceover, version: coverageUnitSplitterVersion(), language: "fr" }).units;
      const textOf = id => units.find(unit => unit.id === id)?.text ?? "";
      return text({
        protocol_id: payload.protocol_id,
        voiceover_sha256: payload.voiceover_sha256,
        lock_sha256: payload.lock_sha256,
        segment_id: payload.segment_id,
        results: payload.designated_unit_ids.map(unit_id => textOf(unit_id).includes("NONCOUVERT")
          ? { unit_id, verdict: "UNCOVERED", operations: [{ action: "DELETE" }] }
          : { unit_id, verdict: "COVERED", operations: [] })
      });
    }

    if (system.startsWith("Tu es un auditeur de couverture factuelle")) {
      const payload = JSON.parse(user.replace(/^ELEMENTS A CONTROLER :\n\n/, ""));
      return text({ results: payload.items.map(item => ({
        id: item.id,
        covered: !item.voiceover.includes("NONCOUVERT"),
        unsupported: item.voiceover.includes("NONCOUVERT")
          ? [{ sentence: "NONCOUVERT", segment_id: item.id, claim_id: item.claims[0].claim_id, action: "DELETE" }]
          : []
      })) });
    }

    if (system.startsWith("Tu es le Visual Director") && system.includes("MODE LOT")) {
      const [, i, total] = /lot visuel (\d+)\/(\d+)/.exec(user).map(Number);
      const batch = JSON.parse(user.split("SEGMENTS SOURCE DU LOT :\n")[1]);
      const fault = faults.batch?.[i];
      let entries = batch.map((item, k) => ({
        section_index: item.section_index,
        script_segment_index: item.script_segment_index,
        estimated_seconds: item.estimated_seconds,
        shots: [1, 2].map(order => ({
          order,
          duration_seconds: item.estimated_seconds / 2,
          visual_description: `Plan ${order} du segment ${item.section_index}.${item.script_segment_index}${(fault === "ungrounded" || fault === "repairable") && k === 0 && order === 1 ? " INVENTÉ" : ""}`,
          asset_query: "desert landscape",
          asset_type: "stock_video",
          requires_exact_location: false,
          research_fact_refs: item.research_fact_refs
        }))
      }));

      if (fault === "missing") entries = entries.slice(1);
      if (fault === "missing" || fault === "ungrounded") delete faults.batch[i];
      if (fault === "repairable") delete faults.batch[i];

      return text({ segments: entries });
    }

    if (system.startsWith("Tu es un validateur strict de grounding factuel")) {
      const bad = user.includes("INVENTÉ");
      return text({ grounded: !bad, unsupported_visual_claims: bad ? [{ field: "visual_description", text: "INVENTÉ", reason: "absent des claims" }] : [] });
    }

    if (system.startsWith("Tu es un réparateur strict de grounding factuel")) {
      const shot = JSON.parse(/SHOT ORIGINAL :\n\n([\s\S]+?)\n\nCLAIMS FACTUELS AUTORISES/.exec(user)[1]);
      const keep = faults.unrepairable === true;
      return text({ visual_description: keep ? shot.visual_description : shot.visual_description.replace(" INVENTÉ", " (réparé)"), asset_query: shot.asset_query });
    }

    throw new Error(`appel inattendu : ${system.slice(0, 60)}`);
  };
}

// Garde réelle sur un dossier de production, SDK mocké. Chaque appel compte.
async function withGuard(directory, handler, fn) {
  return withEnv(REAL_ENV, async () => {
    const calls = [];

    Anthropic.Messages.prototype.create = async function (request) {
      calls.push(request);
      return handler(request);
    };

    try {
      configureCallGuard({ productionDir: directory, cap: 400 });
      return await fn(calls);
    } finally {
      resetCallGuard();
      Anthropic.Messages.prototype.create = networkGuard.sdkMessagesCreate;
    }
  });
}

const listJson = directory => fs.existsSync(directory) ? fs.readdirSync(directory).filter(f => f.endsWith(".json")).sort() : [];
const rejectedCount = directory => fs.existsSync(path.join(directory, "rejected"))
  ? fs.readdirSync(path.join(directory, "rejected"), { recursive: true }).filter(f => String(f).endsWith(".json")).length
  : 0;
const isChapter = request => String(request.system).startsWith("Tu es le Script Agent");
const isBatch = request => String(request.system).includes("MODE LOT");
const isGrounding = request => String(request.system).startsWith("Tu es un validateur strict de grounding factuel");

// Dossier Research valide (moteur de fixtures, sans réseau ni garde).
const research = await withEnv({ ANTHROPIC_FIXTURES: "1" }, async () =>
  (await runResearchAgent({ title: CANONICAL_TITLE, prompt: CANONICAL_PROMPT, testMode: true })).data
);

const scriptRun = (directory, faults = {}) => withGuard(directory, makeHandler({ research, faults }), async calls => ({
  calls,
  result: await runScriptAgent({ research, title: CANONICAL_TITLE, durationProfile: SHORT, productionDir: directory })
}));

console.log("--- 1. Limite de sortie sûre des chapitres ---");

await test("plan déterministe : standard 27 min → 7 chapitres, limite 13 128 tokens (≤ 16 000) ; court → 3 chapitres", async () => {
  const standard = chapterPlan(STANDARD);
  assert(standard.total === 7 && standard.expectedSeconds === 231 && standard.maxTokens === 13128, JSON.stringify(standard));
  assert(JSON.stringify(chapterPlan(STANDARD)) === JSON.stringify(standard), "non déterministe");
  const short = chapterPlan(SHORT);
  assert(short.total === 3 && short.maxTokens === chapterOutputBudget(80) && short.maxTokens >= 5000, JSON.stringify(short));
  assert(SAFE_OUTPUT_CEILING < 21333, "plafond au-dessus du seuil de streaming du SDK");
});

await test("documentaire trop long pour 12 chapitres : refus avant tout appel ; 50 min → 12 chapitres sous le plafond", async () => {
  await expectReject(async () => chapterPlan({ name: "x", target: 60, min: 55, max: 65, sections: { min: 6, max: 12 } }), /trop longue.*Aucun appel/);
  const long = chapterPlan({ name: "x", target: 50, min: 45, max: 55, sections: { min: 6, max: 12 } });
  assert(long.total === 12 && long.maxTokens <= SAFE_OUTPUT_CEILING, JSON.stringify(long));
});

await test("chaque chapitre est demandé avec la limite calculée (et non plus 5 000 fixes)", async () => {
  const directory = makeDir();
  const { calls } = await scriptRun(directory);
  const chapters = calls.filter(isChapter);
  assert(chapters.length === 3 && chapters.every(c => c.max_tokens === chapterPlan(SHORT).maxTokens), chapters.map(c => c.max_tokens).join());
});

console.log("--- 2. Réponse invalide : jamais de checkpoint, reprise correcte (script) ---");

await test("nominal : 3 checkpoints avec empreinte ; reprise sans aucun nouvel appel", async () => {
  const directory = makeDir();
  const first = await scriptRun(directory);
  const segments = path.join(directory, "script-segments");
  assert(listJson(segments).length === 3, listJson(segments).join());
  assert(listJson(segments).every(f => /^[0-9a-f]{64}$/.test(JSON.parse(fs.readFileSync(path.join(segments, f), "utf8")).request_sha256)), "empreinte absente");
  assert(first.result.script_generation.generated_segments === 3, "génération");
  const second = await scriptRun(directory);
  assert(second.calls.length === 0 && second.result.script_generation.reused_segments === 3, `${second.calls.length} appels`);
});

for (const [fault, pattern] of [["truncate", /tronqué — stop_reason=max_tokens/], ["json", /chapitre 2\/3 invalide/], ["badref", /chapitre 2\/3 invalide.*hors limites/]]) {
  await test(`chapitre ${fault === "truncate" ? "tronqué" : fault === "json" ? "en JSON invalide" : "avec une référence Research invalide"} : aucun checkpoint, réponse écartée du cache, reprise refait seulement le chapitre`, async () => {
    const directory = makeDir();
    await expectReject(() => scriptRun(directory, { chapter: { 2: fault } }), pattern);
    const segments = path.join(directory, "script-segments");
    assert(listJson(segments).join() === "segment-001.json", listJson(segments).join());
    assert(rejectedCount(path.join(directory, CACHE_DIR)) === 1, "réponse rejetée encore en cache");
    const before = fs.readFileSync(path.join(segments, "segment-001.json"), "utf8");
    const resume = await scriptRun(directory);
    assert(resume.calls.filter(isChapter).length === 2, `${resume.calls.filter(isChapter).length} chapitres régénérés`);
    assert(fs.readFileSync(path.join(segments, "segment-001.json"), "utf8") === before, "checkpoint valide modifié");
    assert(listJson(segments).length === 3 && resume.result.script_generation.reused_segments === 1, "reprise");
  });
}

await test("gate du script complet : phrase non couverte supprimée déterministement, tous checkpoints conservés", async () => {
  const directory = makeDir();
  const first = await scriptRun(directory, { chapter: { 2: "uncovered" } });
  const segments = path.join(directory, "script-segments");
  assert(listJson(segments).join() === "segment-001.json,segment-002.json,segment-003.json", listJson(segments).join());
  assert(!first.result.data.sections[1].segments.some(s => s.voiceover.includes("NONCOUVERT")), "phrase non couverte conservée");
  const resume = await scriptRun(directory);
  assert(resume.calls.length === 0 && resume.result.script_generation.reused_segments === 3, `${resume.calls.length} appels`);
});

console.log("--- 3. Réponse invalide : jamais de checkpoint, reprise correcte (storyboard) ---");

const script = (await scriptRun(makeDir())).result.data;
const visualRun = (directory, faults = {}) => withGuard(directory, makeHandler({ research, faults }), async calls => ({
  calls,
  result: await runVisualDirector({ script, durationProfile: SHORT, productionDir: directory, batchSize: 4 })
}));

await test("nominal : 3 lots ancrés avant écriture ; aucun grounding refait après l'assemblage ; reprise sans appel", async () => {
  const directory = makeDir();
  const first = await visualRun(directory);
  const batches = path.join(directory, "visual-batches");
  const files = listJson(batches);
  assert(files.length === 3, files.join());
  const shots = script.sections.reduce((n, s) => n + s.segments.length, 0) * 2;
  assert(first.calls.filter(isGrounding).length === shots, `${first.calls.filter(isGrounding).length} contrôles pour ${shots} plans`);
  assert(first.result.factual_grounding_validation.valid && first.result.factual_grounding_validation.shots.length === shots, "rapport de grounding");
  assert(files.every(f => JSON.parse(fs.readFileSync(path.join(batches, f), "utf8")).factual_grounding.shots.every(s => s.grounded)), "grounding absent du checkpoint");
  const second = await visualRun(directory);
  assert(second.calls.length === 0, `${second.calls.length} appels à la reprise`);
  assert(JSON.stringify(second.result.data) === JSON.stringify(first.result.data), "plan différent à la reprise");
});

await test("lot structurellement invalide (segment manquant) : aucun checkpoint, réponse écartée, reprise refait ce lot seul", async () => {
  const directory = makeDir();
  await expectReject(() => visualRun(directory, { batch: { 2: "missing" } }), /lot 2\/3 rejeté/);
  const batches = path.join(directory, "visual-batches");
  assert(listJson(batches).join() === "batch-001.json", listJson(batches).join());
  assert(rejectedCount(path.join(directory, CACHE_DIR)) === 1, "réponse rejetée encore en cache");
  const resume = await visualRun(directory);
  assert(resume.calls.filter(isBatch).length === 2 && resume.result.storyboard_generation.reused_batches === 1, `${resume.calls.filter(isBatch).length} lots`);
});

await test("plan non ancrable dans le lot 2 : aucun checkpoint pour ce lot, lot 1 conservé, reprise correcte", async () => {
  const directory = makeDir();
  await expectReject(() => visualRun(directory, { batch: { 2: "ungrounded" }, unrepairable: true }), /lot 2\/3 rejeté par le Visual Factual Grounding Gate/);
  const batches = path.join(directory, "visual-batches");
  assert(listJson(batches).join() === "batch-001.json", listJson(batches).join());
  const resume = await visualRun(directory);
  assert(resume.calls.filter(isBatch).length === 2 && resume.result.factual_grounding_validation.valid, "reprise");
});

await test("plan réparé : le checkpoint garde la version réparée et le rapport la réparation", async () => {
  const directory = makeDir();
  const run = await visualRun(directory, { batch: { 1: "repairable" } });
  const shot = run.result.data.sections[0].segments[0].shots[0];
  assert(shot.visual_description.includes("(réparé)") && !shot.visual_description.includes("INVENTÉ"), shot.visual_description);
  assert(run.result.factual_grounding_validation.shots[0].repaired === true, "réparation absente du rapport");
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, "visual-batches", "batch-001.json"), "utf8"));
  assert(checkpoint.segments[0].shots[0].visual_description.includes("(réparé)"), "checkpoint non réparé");
});

await test("checkpoint antérieur à R23-D (sans grounding) : ancré à la lecture puis complété, sans régénérer le lot", async () => {
  const directory = makeDir();
  await visualRun(directory);
  const file = path.join(directory, "visual-batches", "batch-002.json");
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  delete legacy.factual_grounding;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  const resume = await visualRun(directory);
  assert(resume.calls.filter(isBatch).length === 0, "lot régénéré");
  assert(JSON.parse(fs.readFileSync(file, "utf8")).factual_grounding.shots.length === legacy.segments.reduce((n, s) => n + s.shots.length, 0), "grounding non complété");
});

console.log("--- 4. Cache et empreinte ---");

await test("createMessage renvoie l'empreinte (appel réel et réponse en cache) ; discardCachedResponse déplace sans toucher au journal", async () => {
  const directory = makeDir();
  await withGuard(directory, () => text("ok"), async calls => {
    const ask = () => createMessage({ system: "Système de test", messages: [{ role: "user", content: "question" }], maxTokens: 10, temperature: 0 });
    const real = await ask();
    const cached = await ask();
    assert(/^[0-9a-f]{64}$/.test(real.request_sha256) && cached.request_sha256 === real.request_sha256 && calls.length === 1, "empreinte");
    const journal = fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8");
    const moved = discardCachedResponse(real.request_sha256);
    assert(moved && fs.existsSync(path.join(directory, moved)) && !fs.existsSync(path.join(directory, CACHE_DIR, `${real.request_sha256}.json`)), "non déplacé");
    assert(fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8") === journal, "journal modifié");
    assert(discardCachedResponse("pas-une-empreinte") === null && discardCachedResponse(real.request_sha256) === null, "effet inattendu");
    await ask();
    assert(calls.length === 2, "la reprise n'a pas refait l'appel");
  });
  assert(discardCachedResponse("a".repeat(64)) === null, "effet sans garde");
});

for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });

const attempts = networkGuard.attempts().length;

console.log(`checkpoint-robustness-smoke — ${passed} OK, ${failed} échec(s), tentatives réseau bloquées : ${attempts}`);
process.exit(failed === 0 && attempts === 0 ? 0 : 1);
