// Smoke R28.10B — porte de couverture sur le VRAI garde d'appels (baseline
// v1.0.3, contrat 4.8), zéro API. La porte utilise son transport et son
// retrait de cache de production (createMessage, discardCachedResponse) ; seul
// le SDK Anthropic est remplacé en mémoire, avec une clé factice, dans un
// dossier de production temporaire. Le délai de l'exécuteur (120 s) est
// réellement déclenché, sur une horloge simulée (node:test mock.timers).
//
// Couvre les défauts de l'audit R28.10A : D1 (régénération), D2 (TIMEOUT et
// relance), D3 (retrait impossible), D4 (vrai cache, vrai retrait, réponse
// tardive, rejeu), D5 (retrait par segment), D6 (refus du garde), D7 (verrou
// et protocole jamais perdus), D10, D11, D13, D14 ; avec mutations témoins.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/script-coverage-guard-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

import Anthropic from "@anthropic-ai/sdk";

import { runScriptCoverageGate } from "../src/utils/script-coverage-gate.js";
import { SCRIPT_COVERAGE_POLICY, buildCoverageLock, researchEntitiesOf } from "../src/utils/coverage-lock-builder.js";
import { coordinateCoverage } from "../src/utils/coverage-coordinator.js";
import { EXECUTOR_LIMITS } from "../src/utils/coverage-judge-executor.js";
import { boundaryProtocolIdFromLock, coordinatorLockElement, lockSha256 } from "../src/utils/coverage-lock.js";
import { CACHE_DIR, JOURNAL_FILE, configureCallGuard, getCallGuardStatus, resetCallGuard, setCacheBypass } from "../src/services/call-guard.js";
import { previewMessageCost } from "../src/services/anthropic.js";
import { estimateCoverageBudget } from "../src/utils/coverage-budget-preflight.js";
import { protocolOutcomeError } from "../src/orchestrator/resume.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

delete process.env.ANTHROPIC_API_KEY;

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

const HEADER = "SEGMENT A AUDITER :\n\n";
const HEX64 = /^[0-9a-f]{64}$/;
const DUMMY_KEY = "x".repeat(60);
const REAL_ENV = { ANTHROPIC_FIXTURES: undefined, ANTHROPIC_FIXTURE_SCENARIO: undefined, NO_API: undefined, PIPELINE_REAL_CALLS_ACK: "1", ANTHROPIC_API_KEY: DUMMY_KEY };

const RESEARCH = Object.freeze({ key_facts: [{ claim: "Le désert avance vite dans le centre." }, { claim: "La ville de Sydney grandit." }] });
const segmentOf = voiceover => ({ voiceover, claims: [{ text: "Le désert avance vite dans le centre." }] });
const scriptOf = voiceovers => ({ sections: [{ segments: voiceovers.map(segmentOf) }] });
const V = ["Le désert avance vite. La côte reste humide.", "Les pluies sont rares. Le vent souffle fort.", "La terre est rouge. Les rivières disparaissent l’été."];
const LOCK = buildCoverageLock({ entities: researchEntitiesOf(RESEARCH) });

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const tempDirs = [];
const makeDir = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "script-coverage-guard-"));
  tempDirs.push(directory);
  return directory;
};

// Réponse du juge simulée : toutes les unités désignées couvertes ; `alter`
// permet de rendre la réponse invalide (rejet par le juge).
function judgeReply(request, { alter = data => data, empty = false } = {}) {
  const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
  const data = alter({
    protocol_id: payload.protocol_id,
    voiceover_sha256: payload.voiceover_sha256,
    lock_sha256: payload.lock_sha256,
    segment_id: payload.segment_id,
    results: payload.designated_unit_ids.map(unit_id => ({ unit_id, verdict: "COVERED", operations: [] }))
  });
  return {
    id: "msg_mock",
    model: "mock-model",
    content: empty ? [] : [{ type: "text", text: JSON.stringify(data) }],
    usage: { input_tokens: 3, output_tokens: 20 },
    stop_reason: "end_turn"
  };
}

// SDK remplacé en mémoire ; `handler(request, n)` renvoie la réponse (ou une
// promesse contrôlée par le test).
function mockSdk(handler) {
  const calls = [];
  Anthropic.Messages.prototype.create = function (request) {
    calls.push(request);
    return handler(request, calls.length);
  };
  return calls;
}

const restoreSdk = () => {
  Anthropic.Messages.prototype.create = networkGuard.sdkMessagesCreate;
};

// Exécute fn avec le vrai garde d'appels configuré sur un dossier neuf (ou
// fourni), le SDK remplacé.
async function withGuard({ cap = 20, handler = request => judgeReply(request), directory = makeDir(), configure = true } = {}, fn) {
  return withEnv(REAL_ENV, async () => {
    const calls = mockSdk(handler);
    try {
      if (configure) configureCallGuard({ productionDir: directory, cap });
      return await fn({ directory, calls });
    } finally {
      resetCallGuard();
      restoreSdk();
    }
  });
}

const journalOf = directory => JSON.parse(fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8")).entries;
const activeCache = directory => fs.existsSync(path.join(directory, CACHE_DIR))
  ? fs.readdirSync(path.join(directory, CACHE_DIR)).filter(name => name.endsWith(".json")).sort()
  : [];
const rejectedCache = directory => {
  const root = path.join(directory, CACHE_DIR, "rejected");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs.readdirSync(root, { recursive: true }).filter(name => String(name).endsWith(".json")).map(name => path.basename(String(name))).sort();
};
const gate = (script, options = {}) => runScriptCoverageGate({ script, research: RESEARCH, ...options });
const flush = async (times = 20) => {
  for (let index = 0; index < times; index += 1) await new Promise(resolve => setImmediate(resolve));
};
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Fait avancer l'horloge simulée de l'exécuteur jusqu'à ce que `promise` soit
// réglée (au plus `maxTicks` délais de 120 s).
async function drive(promise, { maxTicks = 40, onTick = () => {} } = {}) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let tick = 1; tick <= maxTicks && !settled; tick += 1) {
    await flush();
    if (settled) break;
    mock.timers.tick(EXECUTOR_LIMITS.timeout_ms);
    await flush();
    await onTick(tick);
  }
  await flush();
  return promise;
}

// ---------------------------------------------------------------------------
console.log("--- 1. Vrai garde d'appels, vrai cache ---");

await test("D4 — câblage de production : PASS, un appel réel par segment, réponses en cache, journal clos (succeeded)", async () => {
  await withGuard({}, async ({ directory, calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, calls.length, activeCache(directory).length], ["PASS", 3, 3]);
    deepStrictEqual(journalOf(directory).map(entry => entry.status), ["succeeded", "succeeded", "succeeded"]);
    deepStrictEqual([result.discarded_request_sha256s.length, result.discard_failed_request_sha256s.length], [0, 0]);
  });
});

await test("D4 — reprise (I25) : réponses acceptées rejouées depuis le vrai cache, aucun nouvel appel, résultat identique", async () => {
  const directory = makeDir();
  const first = await withGuard({ directory }, () => gate(scriptOf(V)));
  await withGuard({ directory }, async ({ calls }) => {
    const second = await gate(scriptOf(V));
    // budget_preflight observe l'état du cache (3 appels requis, puis 0) ; tout le reste est identique.
    const { budget_preflight: firstBudget, ...firstRest } = first;
    const { budget_preflight: secondBudget, ...secondRest } = second;
    deepStrictEqual([calls.length, JSON.stringify(secondRest) === JSON.stringify(firstRest)], [0, true]);
    deepStrictEqual([firstBudget.required, firstBudget.segments_cached_round_1, secondBudget.required, secondBudget.segments_cached_round_1], [3, 0, 0, 3]);
    deepStrictEqual(journalOf(directory).slice(3).map(entry => entry.status), ["cache_hit", "cache_hit", "cache_hit"]);
  });
});

const INVALID = { alter: data => ({ ...data, protocol_id: "0".repeat(64) }) };

await test("D4 — réponse rejetée par le juge : retirée du vrai cache vers call-cache/rejected/ par discardCachedResponse", async () => {
  await withGuard({ handler: request => judgeReply(request, INVALID) }, async ({ directory, calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, result.failure.reason, calls.length], ["NOT_PASS", "JUDGE_NOT_JUDGED", 1]);
    const hash = journalOf(directory)[0].request_sha256;
    deepStrictEqual([[...result.discarded_request_sha256s], activeCache(directory), rejectedCache(directory)], [[hash], [], [`${hash}.json`]]);
  });
});

await test("D4 — réponse rejetée jamais rejouée : la reprise repart vers le SDK, pas vers le cache", async () => {
  const directory = makeDir();
  await withGuard({ directory, handler: request => judgeReply(request, INVALID) }, () => gate(scriptOf(V)));
  await withGuard({ directory }, async ({ calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, calls.length], ["PASS", 3]);
    if (journalOf(directory).some(entry => entry.status === "cache_hit")) throw new Error("réponse rejetée rejouée");
  });
});

await test("D4 — réponse rejetée par l'exécuteur (vide) : retirée du vrai cache, jamais rejouée", async () => {
  const directory = makeDir();
  await withGuard({ directory, handler: request => judgeReply(request, { empty: true }) }, async () => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, result.failure.category, activeCache(directory).length, rejectedCache(directory).length], ["NOT_PASS", "EMPTY_RESPONSE", 0, 1]);
  });
  await withGuard({ directory }, async ({ calls }) => deepStrictEqual([(await gate(scriptOf(V))).status, calls.length], ["PASS", 3]));
});

// D3 : le dossier call-cache/rejected est remplacé par un fichier ; le vrai
// discardCachedResponse échoue.
function blockRejectedDirectory(directory) {
  fs.mkdirSync(path.join(directory, CACHE_DIR), { recursive: true });
  fs.writeFileSync(path.join(directory, CACHE_DIR, "rejected"), "bloque");
}

await test("D3 — retrait réel impossible : NOT_PASS CACHE_DISCARD_FAILED, empreinte listée, signal explicite", async () => {
  const directory = makeDir();
  blockRejectedDirectory(directory);
  await withGuard({ directory, handler: request => judgeReply(request, INVALID) }, async () => {
    const result = await gate(scriptOf(V));
    const hash = journalOf(directory)[0].request_sha256;
    deepStrictEqual([result.status, result.failure.reason, result.failure.category, [...result.discard_failed_request_sha256s], result.discarded_request_sha256s.length], ["NOT_PASS", "CACHE_DISCARD_FAILED", "JUDGE_NOT_JUDGED", [hash], 0]);
    if (!result.failure.detail.includes(hash)) throw new Error("empreinte absente du détail");
  });
});

await test("D3 — retrait impossible : aucune reprise silencieuse, la reprise retombe sur CACHE_DISCARD_FAILED", async () => {
  const directory = makeDir();
  blockRejectedDirectory(directory);
  await withGuard({ directory, handler: request => judgeReply(request, INVALID) }, () => gate(scriptOf(V)));
  await withGuard({ directory }, async () => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, result.failure.reason], ["NOT_PASS", "CACHE_DISCARD_FAILED"]);
  });
});

await test("D3 — retrait impossible sur un segment PASS : jamais de PASS (I20)", async () => {
  let n = 0;
  const result = await gate(scriptOf(V.slice(0, 1)), {
    transport: async request => ({ request_sha256: String(++n).repeat(64), meta: { output_tokens: 20, stop_reason: "end_turn" }, response: judgeReply(request) }),
    coordinate: async input => {
      await input.transport({ ...(await firstRequest(input)), system: "autre requête" }).catch(() => {});
      return coordinateCoverage(input);
    },
    discard: () => { throw new Error("disque en lecture seule"); }
  });
  deepStrictEqual([result.status, result.failure.reason, result.failure.category, result.final_voiceovers.length], ["NOT_PASS", "CACHE_DISCARD_FAILED", null, 0]);
});

// Requête du juge pour un segment, capturée sans appel réel.
async function firstRequest(input) {
  let captured = null;
  const policy = { ...input.policy, max_total_judge_calls: 1 };
  // R29.5 : le verrou porte l'empreinte des bornes de la politique.
  const lock = { ...input.lock, coordinator: coordinatorLockElement({ policy, coordinatorVersion: "coverage-coordinator.v1" }) };
  await coordinateCoverage({ ...input, lock, transport: async request => { captured = request; throw new Error("capture"); }, policy });
  return captured;
}

await test("D5 — retrait au fil des segments : les réponses rejetées d'un segment sont retirées avant le segment suivant", async () => {
  const log = [];
  let n = 0;
  const result = await gate(scriptOf(V.slice(0, 2)), {
    transport: async request => ({ request_sha256: String(++n).repeat(64).slice(0, 64), meta: { output_tokens: 20, stop_reason: "end_turn" }, response: judgeReply(request) }),
    coordinate: async input => {
      log.push(`début ${input.segment.segment_id}`);
      if (input.segment.segment_id === "s1-g1") await input.transport({ ...(await firstRequest(input)), system: "autre requête" });
      return coordinateCoverage(input);
    },
    discard: hash => log.push(`retrait ${hash.slice(0, 1)}`)
  });
  deepStrictEqual([result.status, log], ["PASS", ["début s1-g1", "retrait 1", "début s1-g2"]]);
});

// ---------------------------------------------------------------------------
console.log("--- 2. TIMEOUT réel de l'exécuteur, relance, réponse tardive (horloge simulée) ---");

mock.timers.enable({ apis: ["setTimeout"] });

await test("D2 — TIMEOUT réel puis réponse pendant la relance : PASS, un seul appel réel, aucun « double appel »", async () => {
  const pending = deferred();
  await withGuard({ handler: request => pending.promise.then(() => judgeReply(request)) }, async ({ directory, calls }) => {
    const result = await drive(gate(scriptOf(V.slice(0, 1))), {
      onTick: tick => { if (tick === 1) pending.resolve(); }
    });
    deepStrictEqual([result.status, calls.length, result.segments[0].rounds], ["PASS", 1, 1]);
    deepStrictEqual(journalOf(directory).map(entry => entry.status), ["succeeded"]);
  });
});

await test("D2 — TIMEOUT persistant : NOT_PASS JUDGE_TIMEOUT (jamais JUDGE_BUDGET_EXHAUSTED), un seul appel réel", async () => {
  const pending = deferred();
  await withGuard({ handler: request => pending.promise.then(() => judgeReply(request)) }, async ({ directory, calls }) => {
    const result = await drive(gate(scriptOf(V.slice(0, 1))));
    deepStrictEqual([result.status, result.failure.reason, result.failure.category, calls.length], ["NOT_PASS", "JUDGE_TIMEOUT", "TIMEOUT", 1]);
    deepStrictEqual(journalOf(directory).map(entry => entry.status), ["started"]);
    pending.resolve();
    await flush();
  });
});

await test("D2 — budget non consommé par des relances refusées : aucune erreur « Double appel » remontée au juge", async () => {
  const pending = deferred();
  const seen = [];
  await withGuard({ handler: request => pending.promise.then(() => judgeReply(request)) }, async () => {
    const result = await drive(gate(scriptOf(V.slice(0, 1)), {
      coordinate: async input => coordinateCoverage({
        ...input,
        transport: request => input.transport(request).catch(error => { seen.push(error.message); throw error; })
      })
    }));
    deepStrictEqual([result.failure.reason, seen.filter(message => /Double appel/.test(message)).length], ["JUDGE_TIMEOUT", 0]);
    pending.resolve();
    await flush();
  });
});

await test("D4 — réponse tardive après la porte : mise en cache, journal clos (succeeded), servie à la reprise sans nouvel appel", async () => {
  const directory = makeDir();
  const pending = deferred();
  await withGuard({ directory, handler: request => pending.promise.then(() => judgeReply(request)) }, async () => {
    const result = await drive(gate(scriptOf(V.slice(0, 1))));
    deepStrictEqual(result.failure.reason, "JUDGE_TIMEOUT");
    pending.resolve();
    await flush();
    deepStrictEqual([journalOf(directory).map(entry => entry.status), activeCache(directory).length], [["succeeded"], 1]);
  });
  await withGuard({ directory }, async ({ calls }) => {
    const result = await gate(scriptOf(V.slice(0, 1)));
    deepStrictEqual([result.status, calls.length, journalOf(directory).at(-1).status], ["PASS", 0, "cache_hit"]);
  });
});

await test("D2 — TIMEOUT puis réponse invalide tardive pendant la relance : rejetée, retirée du cache", async () => {
  const pending = deferred();
  await withGuard({ handler: request => pending.promise.then(() => judgeReply(request, INVALID)) }, async ({ directory, calls }) => {
    const result = await drive(gate(scriptOf(V.slice(0, 1))), { onTick: tick => { if (tick === 1) pending.resolve(); } });
    deepStrictEqual([result.status, result.failure.reason, calls.length, activeCache(directory).length, rejectedCache(directory).length], ["NOT_PASS", "JUDGE_NOT_JUDGED", 1, 0, 1]);
  });
});

mock.timers.reset();

// ---------------------------------------------------------------------------
console.log("--- 3. Refus du garde d'appels (D6) ---");

// Le juge déclare non couverte la 2e unité du segment s1-g2 (« Le vent souffle fort. ») : une ronde 2 est nécessaire.
function judgeDeletingSecondUnit(request) {
  const payload = JSON.parse(request.messages[0].content.slice(HEADER.length));
  const delete2 = payload.segment_id === "s1-g2" && payload.designated_unit_ids.includes("u2");
  const reply = judgeReply(request);
  if (!delete2) return reply;
  const data = JSON.parse(reply.content[0].text);
  data.results = data.results.map(item => (item.unit_id === "u2" ? { unit_id: "u2", verdict: "UNCOVERED", operations: [{ action: "DELETE" }] } : item));
  return { ...reply, content: [{ type: "text", text: JSON.stringify(data) }] };
}

await test("D6 — plafond atteint EN COURS DE ROUTE (ronde 2, après un préflight réussi) : NOT_PASS JUDGE_CALL_REFUSED avec la vraie cause", async () => {
  await withGuard({ cap: 2, handler: judgeDeletingSecondUnit }, async ({ calls }) => {
    const result = await gate(scriptOf(V.slice(0, 2)));
    deepStrictEqual([result.status, result.failure.segment_id, result.failure.reason, result.failure.category, calls.length], ["NOT_PASS", "s1-g2", "JUDGE_CALL_REFUSED", "CALL_REFUSED", 2]);
    deepStrictEqual([result.budget_preflight.required, result.budget_preflight.remaining], [2, 2]);
    if (!/Plafond/.test(result.failure.detail)) throw new Error(result.failure.detail);
  });
});

await test("D6 — NO_API : NOT_PASS JUDGE_CALL_REFUSED, aucun appel", async () => {
  await withGuard({}, async ({ calls }) => withEnv({ NO_API: "1" }, async () => {
    const result = await gate(scriptOf(V.slice(0, 1)));
    deepStrictEqual([result.failure.reason, calls.length, /NO_API/.test(result.failure.detail)], ["JUDGE_CALL_REFUSED", 0, true]);
  }));
});

await test("D6 — garde non configuré : NOT_PASS JUDGE_CALL_REFUSED (autorisation absente), aucun appel", async () => {
  await withGuard({ configure: false }, async ({ calls }) => {
    const result = await gate(scriptOf(V.slice(0, 1)));
    deepStrictEqual([result.failure.reason, calls.length, /non autorisé/.test(result.failure.detail)], ["JUDGE_CALL_REFUSED", 0, true]);
  });
});

await test("D6 — panne réelle du transport (SDK en erreur) : reste une panne transport, jamais un refus", async () => {
  await withGuard({ handler: () => Promise.reject(new Error("HTTP 500")) }, async ({ calls }) => {
    const result = await gate(scriptOf(V.slice(0, 1)));
    deepStrictEqual([result.failure.reason, result.failure.category, calls.length], ["JUDGE_BUDGET_EXHAUSTED", "TRANSPORT_ERROR", SCRIPT_COVERAGE_POLICY.max_total_judge_calls]);
  });
});

// ---------------------------------------------------------------------------
console.log("--- 3b. Préflight du budget (R29.3), vrai garde et vrai cache ---");

const treeOf = directory => fs.existsSync(directory)
  ? fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()
    .map(file => [path.relative(directory, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")])
  : [];

await test("R29.3 — plafond insuffisant : NOT_PASS BUDGET_INSUFFICIENT avant tout appel, détail chiffré, aucun segment évalué", async () => {
  await withGuard({ cap: 2 }, async ({ directory, calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, result.failure.reason, result.failure.category, result.failure.segment_id, calls.length, result.segments.length], ["NOT_PASS", "BUDGET_INSUFFICIENT", "PREFLIGHT", null, 0, 0]);
    deepStrictEqual([result.budget_preflight.required, result.budget_preflight.remaining, result.budget_preflight.cap, result.budget_preflight.used, result.budget_preflight.maximum], [3, 2, 2, 0, 36]);
    for (const part of ["minimum 3 appel(s) requis", "2 restant(s)", "plafond 2", "déjà utilisés 0", "maximum théorique 36"]) {
      if (!result.failure.detail.includes(part)) throw new Error(`détail : ${result.failure.detail}`);
    }
    deepStrictEqual([result.final_voiceovers.length, activeCache(directory).length, fs.existsSync(path.join(directory, JOURNAL_FILE))], [0, 0, false]);
    deepStrictEqual([result.lock_sha256, result.protocol_id].every(value => /^[0-9a-f]{64}$/.test(value)), true);
  });
});

await test("R29.3 — plafond égal au minimum exact : le préflight passe et le Script est PASS", async () => {
  await withGuard({ cap: 3 }, async ({ calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, calls.length, result.budget_preflight.required, result.budget_preflight.remaining], ["PASS", 3, 3, 3]);
  });
});

await test("R29.3 — compteur de l'invocation pris en compte : le budget déjà consommé réduit le restant", async () => {
  await withGuard({ cap: 4 }, async ({ calls }) => {
    const first = await gate(scriptOf(V.slice(0, 2)));
    const second = await gate(scriptOf([V[2], "La nuit est calme 4 fois.", "Il pleut 3 jours."]));
    deepStrictEqual([first.status, getCallGuardStatus().used, calls.length], ["PASS", 2, 2]);
    deepStrictEqual([second.status, second.failure.reason, second.budget_preflight.required, second.budget_preflight.remaining, second.budget_preflight.used], ["NOT_PASS", "BUDGET_INSUFFICIENT", 3, 2, 2]);
  });
});

await test("R29.3 — AUCUN FAUX REFUS À LA REPRISE : tout est en cache, un plafond de 1 suffit, 0 appel", async () => {
  const directory = makeDir();
  await withGuard({ directory, cap: 20 }, () => gate(scriptOf(V)));
  await withGuard({ directory, cap: 1 }, async ({ calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, calls.length, result.budget_preflight.required, result.budget_preflight.segments_cached_round_1, result.budget_preflight.maximum], ["PASS", 0, 0, 3, 36]);
  });
});

await test("R29.3 — reprise partielle : seul le segment absent du cache est compté", async () => {
  const directory = makeDir();
  await withGuard({ directory, cap: 20 }, () => gate(scriptOf(V.slice(0, 2))));
  await withGuard({ directory, cap: 1 }, async ({ calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, calls.length, result.budget_preflight.required, result.budget_preflight.segments_cached_round_1], ["PASS", 1, 1, 2]);
  });
});

await test("R29.3 — régénération (cacheBypass) : le cache n'est pas lu, tout est compté", async () => {
  const directory = makeDir();
  await withGuard({ directory, cap: 20 }, () => gate(scriptOf(V)));
  await withGuard({ directory, cap: 2 }, async ({ calls }) => {
    setCacheBypass(true);
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.failure.reason, result.budget_preflight.required, result.budget_preflight.segments_cached_round_1, calls.length], ["BUDGET_INSUFFICIENT", 3, 0, 0]);
  });
});

await test("R29.3 — cache invalide : BUDGET_PROBE_FAILED (CACHE_INVALID), jamais pris pour une absence, 0 appel", async () => {
  const directory = makeDir();
  await withGuard({ directory, cap: 20 }, () => gate(scriptOf(V)));
  const hash = journalOf(directory)[1].request_sha256;
  fs.writeFileSync(path.join(directory, CACHE_DIR, `${hash}.json`), "{ pas du json");
  await withGuard({ directory, cap: 20 }, async ({ calls }) => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.status, result.failure.reason, result.failure.category, result.failure.segment_id, calls.length], ["NOT_PASS", "BUDGET_PROBE_FAILED", "CACHE_INVALID", "s1-g2", 0]);
    if (!result.failure.detail.includes(hash.slice(0, 12))) throw new Error(result.failure.detail);
  });
});

await test("R29.3 — la sonde est strictement en lecture seule : arbre du dossier, journal et compteurs inchangés", async () => {
  const directory = makeDir();
  await withGuard({ directory, cap: 20 }, () => gate(scriptOf(V.slice(0, 2))));
  await withGuard({ directory, cap: 20 }, async ({ calls }) => {
    const before = [treeOf(directory), getCallGuardStatus()];
    const lock = buildCoverageLock({ entities: researchEntitiesOf(RESEARCH) });
    const segments = V.map((voiceover, index) => ({ segment_id: `s1-g${index + 1}`, voiceover, claims: [{ text: "Le désert avance vite dans le centre." }] }));
    const estimate = await estimateCoverageBudget({ segments, entities: researchEntitiesOf(RESEARCH), lock, policy: SCRIPT_COVERAGE_POLICY, probe: previewMessageCost });
    deepStrictEqual([estimate.status, estimate.min_new_calls, estimate.segments_cached_round_1], ["OK", 1, 2]);
    deepStrictEqual([treeOf(directory), getCallGuardStatus(), calls.length], [...before, 0]);
  });
});

await test("R29.3 — fixtures avec garde configuré : coût nul, aucun refus quel que soit le plafond", async () => {
  await withGuard({ cap: 1 }, async () => withEnv({ ANTHROPIC_FIXTURES: "1" }, async () => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.budget_preflight, result.failure?.reason?.startsWith("BUDGET_") ?? false], [null, false]);
  }));
});

await test("R29.3 — garde non configuré ou NO_API : préflight sans objet, les appels suivent leur chemin actuel", async () => {
  await withGuard({ configure: false }, async () => {
    const result = await gate(scriptOf(V.slice(0, 1)));
    deepStrictEqual([result.budget_preflight, result.failure.reason], [null, "JUDGE_CALL_REFUSED"]);
  });
  await withGuard({}, async () => withEnv({ NO_API: "1" }, async () => {
    const result = await gate(scriptOf(V.slice(0, 1)));
    deepStrictEqual([result.budget_preflight, result.failure.reason], [null, "JUDGE_CALL_REFUSED"]);
  }));
});

await test("R29.3 — transport injecté sans budget fourni : préflight inactif (son coût est inconnu)", async () => {
  await withGuard({ cap: 1 }, async () => {
    const result = await gate(scriptOf(V), { transport: async request => ({ request_sha256: "a".repeat(64), meta: { output_tokens: 20, stop_reason: "end_turn" }, response: judgeReply(request) }), discard: () => {} });
    deepStrictEqual([result.budget_preflight, result.status], [null, "PASS"]);
  });
});

await test("R29.3 — le préflight ne change ni le verrou ni le protocole ni les métadonnées de segment", async () => {
  const lock = buildCoverageLock({ entities: researchEntitiesOf(RESEARCH) });
  await withGuard({ cap: 20 }, async () => {
    const result = await gate(scriptOf(V));
    deepStrictEqual([result.lock_sha256, result.protocol_id], [lockSha256(lock), boundaryProtocolIdFromLock(lock)]);
    deepStrictEqual(Object.keys(result.segments[0]), ["status", "covered", "undeclared_claims", "protocol_id", "lock_sha256", "voiceover_sha256", "rounds", "repair_count"]);
  });
});

await test("R29.3 — déterministe : mêmes entrées et même état, mêmes octets", async () => {
  const directory = makeDir();
  const outputs = [];
  for (let round = 0; round < 3; round += 1) {
    await withGuard({ directory, cap: 2 }, async () => { outputs.push(JSON.stringify(await gate(scriptOf(V)))); });
  }
  deepStrictEqual(new Set(outputs).size, 1);
});

// ---------------------------------------------------------------------------
console.log("--- 4. Verrou, protocole, erreurs inattendues (D7, D13, D14) ---");

const LOCK_SHA = lockSha256(LOCK);
const PROTOCOL = boundaryProtocolIdFromLock(LOCK);

await test("D7 — NOT_PASS avant tout jugement : verrou et protocole présents (Script et segment)", async () => {
  const result = await gate({ sections: [{ segments: [{ claims: [] }] }] }, { transport: async () => { throw new Error("jamais"); } });
  deepStrictEqual([result.status, result.failure.reason, result.lock_sha256, result.protocol_id, result.segments[0].lock_sha256, result.segments[0].protocol_id], ["NOT_PASS", "INPUT_INVALID", LOCK_SHA, PROTOCOL, LOCK_SHA, PROTOCOL]);
});

await test("D7 — NO_SEGMENT et UNEXPECTED : verrou et protocole présents", async () => {
  for (const options of [{ script: { sections: [] } }, { script: scriptOf(V.slice(0, 1)), coordinate: async () => { throw new Error("panne"); } }]) {
    const result = await gate(options.script, options);
    deepStrictEqual([result.lock_sha256, result.protocol_id], [LOCK_SHA, PROTOCOL]);
  }
});

await test("D13 — UNEXPECTED garde le message de l'erreur, expurgé", async () => {
  await withEnv({ ANTHROPIC_API_KEY: DUMMY_KEY }, async () => {
    const result = await gate(scriptOf(V.slice(0, 1)), { coordinate: async () => { throw new Error(`panne ${DUMMY_KEY} sk-ant-abcdef123456`); } });
    deepStrictEqual([result.failure.reason, result.failure.detail], ["UNEXPECTED", "panne [REDACTED] [REDACTED]"]);
  });
});

for (const [name, output] of [
  ["sans historique", { script_status: "PASS", segment_status: { status: "PASS" }, final_voiceover: "x", rounds: 1 }],
  ["PASS sans voiceover final", { script_status: "PASS", segment_status: { status: "PASS" }, history: [], rounds: 1 }],
  ["historique non tableau", { script_status: "PASS", segment_status: { status: "PASS" }, history: {}, final_voiceover: "x", rounds: 1 }]
]) {
  await test(`D14 — coordinateur incohérent (${name}) : NOT_PASS UNEXPECTED, aucune exception`, async () => {
    const result = await gate(scriptOf(V.slice(0, 1)), { coordinate: async () => output });
    deepStrictEqual([result.status, result.failure.reason], ["NOT_PASS", "UNEXPECTED"]);
  });
}

await test("D14 — script ou Research de forme inattendue : la porte ne lève jamais", async () => {
  for (const [script, research] of [[{ sections: "x" }, RESEARCH], [{ sections: [{ segments: "x" }] }, RESEARCH], [scriptOf(V.slice(0, 1)), { key_facts: "x" }]]) {
    const result = await runScriptCoverageGate({ script, research, transport: async () => { throw new Error("jamais"); } });
    deepStrictEqual(result.status, "NOT_PASS");
  }
});

// ---------------------------------------------------------------------------
console.log("--- 5. Orchestrateur et Script (D1, D10, D11) ---");

await test("D1 — protocolOutcomeError : message qualifié (statut, segment, raison) et protocol_outcome attaché", () => {
  const outcome = { status: "NOT_PASS", segment_id: "s2-g1", reason: "CACHE_DISCARD_FAILED" };
  const error = protocolOutcomeError(outcome);
  deepStrictEqual([error.message, error.protocol_outcome], ["Script Agent : NOT_PASS (s2-g1, CACHE_DISCARD_FAILED).", outcome]);
});

const MVP = fs.readFileSync(new URL("../src/orchestrator/mvp.js", import.meta.url), "utf8");

await test("D1 — --regenerate : un protocol_outcome lève dans le try de runAgent, avant toute promotion (même rollback qu'un rejet)", () => {
  const body = MVP.slice(MVP.indexOf("async function runAgent"), MVP.indexOf("return candidate;", MVP.indexOf("async function runAgent")));
  const tryStart = body.indexOf("  try {\n    candidate = await run();");
  const check = body.indexOf("if (candidate?.protocol_outcome)");
  const raise = body.indexOf("throw protocolOutcomeError(candidate.protocol_outcome);");
  const catchStart = body.indexOf("} catch (error) {");
  const rollback = body.indexOf("rollbackRegenerationCache(");
  const promote = body.indexOf('history.outcome = "promoted";');
  const archive = body.indexOf("archiveRegeneratedArtifacts(");
  if (!(tryStart >= 0 && tryStart < check && check < raise && raise < catchStart && catchStart < rollback && rollback < promote && promote < archive)) {
    throw new Error(`ordre inattendu ${[tryStart, check, raise, catchStart, rollback, promote, archive]}`);
  }
});

await test("D1 — production ordinaire : même erreur qualifiée qu'en régénération", () => {
  if (!MVP.includes("if (scriptResult.protocol_outcome) {\n        throw protocolOutcomeError(scriptResult.protocol_outcome);")) throw new Error("chemin ordinaire différent");
});

const SCRIPT_SOURCE = fs.readFileSync(new URL("../src/agents/script.js", import.meta.url), "utf8");

await test("D10 — la revalidation après couverture ne correspond à aucune gate de quarantaine", () => {
  const gates = JSON.parse(SCRIPT_SOURCE.match(/const ATTRIBUTABLE_GATES = (\[[^\]]*\]);/)[1]);
  const start = SCRIPT_SOURCE.indexOf("dossier rejeté par la revalidation du cadre");
  const message = SCRIPT_SOURCE.slice(start, SCRIPT_SOURCE.indexOf("finalValidation.errors.join", start));
  if (start < 0 || gates.some(name => message.includes(name))) throw new Error(`libellé attribuable : ${message}`);
});

await test("D11 — script.js : chaque nom importé est utilisé", () => {
  const imports = [...SCRIPT_SOURCE.matchAll(/^import \{([^}]*)\} from/gm)].flatMap(match => match[1].split(",").map(name => name.trim()).filter(Boolean));
  const body = SCRIPT_SOURCE.replace(/^import \{[^}]*\} from [^;]*;/gm, "");
  const unused = imports.filter(name => !new RegExp(`\\b${name}\\b`).test(body));
  deepStrictEqual(unused, []);
});

// ---------------------------------------------------------------------------
console.log("--- 6. Mutations (copies hors dépôt, vrai garde) ---");

async function isolatedGate(replacements = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r28-10b-mutant-"));
  tempDirs.push(root);
  let source = fs.readFileSync(new URL("../src/utils/script-coverage-gate.js", import.meta.url), "utf8");
  source = source.replace(/from "\.\.\/services\/([^"]+)"/g, (_, file) => `from ${JSON.stringify(new URL(`../src/services/${file}`, import.meta.url).href)}`);
  source = source.replace(/from "\.\/([^"]+)"/g, (_, file) => `from ${JSON.stringify(new URL(`../src/utils/${file}`, import.meta.url).href)}`);
  for (const { from, to } of replacements) {
    if (source.split(from).length !== 2) throw new Error(`mutation non applicable : ${from.slice(0, 60)}`);
    source = source.replace(from, to);
  }
  const file = path.join(root, "script-coverage-gate.js");
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

// Comportements surveillés : relance TIMEOUT, retrait impossible, refus.
async function guardFailures(module) {
  const failures = [];
  const check = (label, actual, expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label); };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = deferred();
    await withGuard({ handler: request => pending.promise.then(() => judgeReply(request)) }, async ({ calls }) => {
      const result = await drive(module.runScriptCoverageGate({ script: scriptOf(V.slice(0, 1)), research: RESEARCH }), { onTick: tick => { if (tick === 1) pending.resolve(); } });
      check("relance après TIMEOUT", [result.status, calls.length], ["PASS", 1]);
    });
    const late = deferred();
    await withGuard({ handler: request => late.promise.then(() => judgeReply(request)) }, async () => {
      const result = await drive(module.runScriptCoverageGate({ script: scriptOf(V.slice(0, 1)), research: RESEARCH }));
      check("TIMEOUT qualifié", result.failure?.reason, "JUDGE_TIMEOUT");
      late.resolve();
      await flush();
    });
  } finally {
    mock.timers.reset();
  }
  const blocked = makeDir();
  blockRejectedDirectory(blocked);
  await withGuard({ directory: blocked, handler: request => judgeReply(request, INVALID) }, async () => {
    const result = await module.runScriptCoverageGate({ script: scriptOf(V), research: RESEARCH });
    check("retrait impossible signalé", [result.status, result.failure?.reason], ["NOT_PASS", "CACHE_DISCARD_FAILED"]);
  });
  await withGuard({ cap: 2, handler: judgeDeletingSecondUnit }, async () => {
    const result = await module.runScriptCoverageGate({ script: scriptOf(V.slice(0, 2)), research: RESEARCH });
    check("refus qualifié", result.failure?.reason, "JUDGE_CALL_REFUSED");
  });
  await withGuard({ cap: 2 }, async ({ calls }) => {
    const result = await module.runScriptCoverageGate({ script: scriptOf(V), research: RESEARCH });
    check("préflight : plafond insuffisant refusé avant tout appel", [result.failure?.reason, calls.length], ["BUDGET_INSUFFICIENT", 0]);
  });
  const resumeDirectory = makeDir();
  await withGuard({ directory: resumeDirectory, cap: 20 }, () => module.runScriptCoverageGate({ script: scriptOf(V), research: RESEARCH }));
  await withGuard({ directory: resumeDirectory, cap: 1 }, async ({ calls }) => {
    const result = await module.runScriptCoverageGate({ script: scriptOf(V), research: RESEARCH });
    check("préflight : reprise en cache jamais refusée", [result.status, calls.length], ["PASS", 0]);
  });
  return failures;
}

const GUARD_MUTATIONS = [
  ["préflight désactivé", [{ from: "    if (!failure && activeBudget) {", to: "    if (false) {" }]],
  ["préflight bloquant sur le maximum au lieu du minimum", [{ from: "evaluateCoverageBudget({ estimate, status: activeBudget.status() })", to: "evaluateCoverageBudget({ estimate: { ...estimate, min_new_calls: estimate.max_new_calls }, status: activeBudget.status() })" }]],
  ["appel en cours non réutilisé (relance refusée en « double appel »)", [{ from: "    if (pending) return pending;\n", to: "" }]],
  ["TIMEOUT non requalifié", [{ from: "    reason = SCRIPT_COVERAGE_GATE_REASON.JUDGE_TIMEOUT;", to: "    void 0;" }]],
  ["retrait impossible ignoré", [{ from: "    discardFailed.push(...removal.skipped);", to: "    void removal.skipped;" }, { from: "    return removal.skipped.length === 0;", to: "    return true;" }]],
  ["refus du garde non qualifié", [{ from: "        if (error?.call_refused === true) refused.push(errorDetail(error));", to: "        void error;" }]]
];

await test("mutations : témoin (porte non mutée, copie hors dépôt) sans aucun écart", async () => {
  deepStrictEqual(await guardFailures(await isolatedGate()), []);
});

for (const [name, replacements] of GUARD_MUTATIONS) {
  await test(`mutation détectée : ${name}`, async () => {
    const failures = await guardFailures(await isolatedGate(replacements));
    if (failures.length === 0) throw new Error("mutant non détecté");
    console.log(`       témoin : ${failures.join(", ")}`);
  });
}

await test("aucune tentative réseau réelle", () => deepStrictEqual(networkGuard.attempts().length, 0));

for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });

const networkAttempts = networkGuard.attempts().length;

console.log(`\nscript-coverage-guard-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
