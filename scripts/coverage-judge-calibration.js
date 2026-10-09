// R29.6 — outil de calibration du juge de couverture (jetable, hors pipeline de
// production). Il n'est importé par aucun agent, aucun module de src/ ni aucun
// smoke ; il n'est jamais lancé automatiquement. Il ne lit jamais .env.local :
// en mode réel, la clé arrive par l'environnement du processus (lancement
// manuel avec `node --env-file=.env.local …`).
//
// Trois sous-commandes :
//
//   build     construit le corpus (lecture seule d'une production désignée)
//   run       exécute UNE étape du corpus et écrit son rapport
//   finalize  fusionne les étapes et écrit le rapport final et le JSON complet
//
// Exemples (simulation, aucun appel réel) :
//   node scripts/coverage-judge-calibration.js build --production-dir=<dossier> \
//     --segments=s1-g1,s1-g2 --count-b=10 --count-c=10 --out=<corpus.json>
//   node scripts/coverage-judge-calibration.js run --corpus=<corpus.json> --stage=1 \
//     --out=<dossier-sortie> --simulate=mixed
//   node scripts/coverage-judge-calibration.js finalize --out=<dossier-sortie>
//
// Relecture « utilisable » des DECLARE (R29.6b) : `finalize` écrit un modèle
// R29.6-relecture-modele.json ; après l'avoir renseigné (usable: true, false
// ou null), relancer avec --review=<fichier> écrit des rapports distincts
// (suffixe -relu, ou --tag=<suffixe>), sans rien écraser.
//
// Mode réel (manuel, après accord explicite) :
//   PIPELINE_REAL_CALLS_ACK=1 node --env-file=.env.local scripts/coverage-judge-calibration.js run \
//     --corpus=<corpus.json> --stage=1 --out=<dossier-sortie> --real --cap=24 \
//     --price-in=3 --price-out=15
//
// Les étapes 2 et 3 exigent le rapport complet de l'étape précédente, produit
// dans le même dossier de sortie, pour le même corpus et le même mode.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertValidCorpus, buildCorpus, entriesForStage, naturalEntries } from "./calibration/corpus.js";
import { SIMULATION_MODES, runCalibration, simulatedJudgeTransport } from "./calibration/runner.js";
import { REVIEW_VERSION, computeMetrics, evaluateCriteria, normalizeReviews } from "./calibration/metrics.js";
import { buildResultsDocument, renderReport } from "./calibration/report.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_OUTPUT_PARENTS = [path.join(ROOT, "projects"), path.join(ROOT, "src")];
const HARD_CEILING = 500;

class UsageError extends Error {}

const fail = message => { throw new UsageError(message); };

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(token);
    if (!match) fail(`argument inattendu : ${token}`);
    args[match[1]] = match[2] ?? true;
  }
  return args;
}

const need = (args, name) => {
  if (typeof args[name] !== "string" || args[name] === "") fail(`--${name}=<valeur> est obligatoire.`);
  return args[name];
};

const readJson = (file, label) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fail(`${label} illisible (${file}) : ${error.message}`);
  }
};

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

function outputDir(args) {
  const out = path.resolve(need(args, "out"));
  for (const parent of FORBIDDEN_OUTPUT_PARENTS) {
    if (isInside(out, parent)) fail(`--out ne peut pas être dans ${parent} (aucune écriture dans une production ou dans le code).`);
  }
  return out;
}

function pricesOf(args) {
  if (args["price-in"] === undefined && args["price-out"] === undefined) return null;
  const input = Number(args["price-in"]);
  const output = Number(args["price-out"]);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) fail("--price-in et --price-out doivent être deux nombres positifs ($ par million de tokens).");
  return { input_per_mtok: input, output_per_mtok: output };
}

const budgetOf = args => {
  if (args["budget-usd"] === undefined) return null;
  const value = Number(args["budget-usd"]);
  if (!Number.isFinite(value) || value <= 0) fail("--budget-usd doit être un nombre positif.");
  return value;
};

function head() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// build

function scriptOf(json) {
  return [json, json?.data, json?.script, json?.data?.script].find(candidate => Array.isArray(candidate?.sections)) ?? null;
}

function researchOf(json) {
  return json?.data?.research_dossier ?? json?.research_dossier ?? null;
}

function build(args) {
  const productionDir = path.resolve(need(args, "production-dir"));
  const out = path.resolve(need(args, "out"));
  if (fs.existsSync(out)) fail(`--out existe déjà : ${out} (aucun écrasement).`);
  for (const parent of FORBIDDEN_OUTPUT_PARENTS) {
    if (isInside(out, parent)) fail(`--out ne peut pas être dans ${parent}.`);
  }
  if (!fs.existsSync(productionDir) || !fs.statSync(productionDir).isDirectory()) fail(`dossier de production introuvable : ${productionDir}`);

  const script = scriptOf(readJson(path.join(productionDir, "script.json"), "script.json"));
  if (!script) fail("script.json : aucune liste « sections » trouvée.");
  const research = researchOf(readJson(path.join(productionDir, "truth.json"), "truth.json"));
  if (!research) fail("truth.json : research_dossier introuvable.");

  const segmentIds = need(args, "segments").split(",").map(value => value.trim()).filter(Boolean);
  const naturals = naturalEntries({ script, research, productionId: path.basename(productionDir), segmentIds });
  const manualEntries = args["manual-witnesses"] ? readJson(path.resolve(need(args, "manual-witnesses")), "témoins manuels") : [];
  if (!Array.isArray(manualEntries)) fail("--manual-witnesses : un tableau d'entrées est attendu.");

  const corpus = buildCorpus({
    naturals,
    countB: args["count-b"] === undefined ? 10 : Number(args["count-b"]),
    countC: args["count-c"] === undefined ? 10 : Number(args["count-c"]),
    manualEntries
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`, { flag: "wx" });
  console.log(`Corpus écrit : ${out}`);
  console.log(`  effectifs A/B/C : ${corpus.counts.A}/${corpus.counts.B}/${corpus.counts.C} — empreinte ${corpus.corpus_sha256}`);
}

// ---------------------------------------------------------------------------
// run

function previousStage(out, stage, corpus, mode) {
  const docs = [];
  for (let previous = 1; previous < stage; previous += 1) {
    const file = path.join(out, `stage-${previous}.json`);
    if (!fs.existsSync(file)) fail(`l'étape ${stage} exige le rapport de l'étape ${previous} (${file} absent).`);
    const doc = readJson(file, `stage-${previous}.json`);
    if (doc.corpus?.corpus_sha256 !== corpus.corpus_sha256) fail(`stage-${previous}.json : corpus différent.`);
    if (doc.identity?.mode !== mode) fail(`stage-${previous}.json : mode « ${doc.identity?.mode} » différent de « ${mode} ».`);
    if (doc.halted) fail(`stage-${previous}.json : l'étape ${previous} s'est arrêtée (${doc.halted.reason}) ; reprendre l'étape avant de continuer.`);
    docs.push(doc);
  }
  return docs;
}

async function run(args) {
  const corpusFile = path.resolve(need(args, "corpus"));
  const corpus = assertValidCorpus(readJson(corpusFile, "corpus"));
  const stage = Number(args.stage);
  if (![1, 2, 3].includes(stage)) fail("--stage doit valoir 1, 2 ou 3.");

  const real = args.real === true;
  const simulate = typeof args.simulate === "string" ? args.simulate : null;
  if (real === (simulate !== null)) fail("choisir exactement un mode : --simulate=<covered|mixed|declare> ou --real.");
  if (simulate !== null && !SIMULATION_MODES.includes(simulate)) fail(`--simulate : mode inconnu « ${simulate} » (${SIMULATION_MODES.join(", ")}).`);
  const mode = real ? "real" : "simulation";

  const out = outputDir(args);
  const stageDir = path.join(out, `stage-${stage}`);
  if (fs.existsSync(stageDir) || fs.existsSync(path.join(out, `stage-${stage}.json`))) fail(`l'étape ${stage} existe déjà dans ${out} (aucun écrasement).`);
  const previous = previousStage(out, stage, corpus, mode);

  const entries = entriesForStage(corpus, stage);
  if (entries.length === 0) fail(`l'étape ${stage} ne contient aucune entrée.`);

  const prices = pricesOf(args);
  let cap;
  if (real) {
    if (process.env.NO_API === "1") fail("NO_API=1 : le mode réel est interdit par le coupe-circuit local.");
    if (process.env.PIPELINE_REAL_CALLS_ACK !== "1") fail("PIPELINE_REAL_CALLS_ACK=1 est obligatoire (accusé explicite) pour le mode réel.");
    cap = Number(args.cap);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > HARD_CEILING) fail(`--cap=<N> est obligatoire en mode réel (entier de 1 à ${HARD_CEILING}).`);
  } else {
    cap = args.cap === undefined ? entries.length * 12 : Number(args.cap);
    if (!Number.isSafeInteger(cap) || cap < 1) fail("--cap invalide.");
  }

  let transport;
  let budget;
  let guard = null;
  fs.mkdirSync(stageDir, { recursive: true });

  if (real) {
    // Les services de production ne sont chargés qu'ici, après toutes les
    // vérifications ci-dessus.
    guard = await import("../src/services/call-guard.js");
    const anthropic = await import("../src/services/anthropic.js");
    const guardDir = path.join(stageDir, "guard");
    fs.mkdirSync(guardDir, { recursive: true });
    guard.configureCallGuard({ productionDir: guardDir, cap });
    const probe = anthropic.previewMessageCost({ system: "x", messages: [{ role: "user", content: "x" }] });
    if (!probe.applicable) fail(`mode réel inapplicable (${probe.reason}) : aucun appel réel ne serait fait.`);
    transport = anthropic.createMessage;
    budget = { status: guard.getCallGuardStatus, probe: anthropic.previewMessageCost };

    const worst = prices ? ` ; pire cas ${(cap * ((16000 / 3) * prices.input_per_mtok + 2000 * prices.output_per_mtok) / 1e6).toFixed(2)} $` : "";
    console.error(`Calibration RÉELLE — étape ${stage} : ${entries.length} entrée(s), plafond ${cap} appel(s)${worst}.`);
  } else {
    transport = simulatedJudgeTransport({ mode: simulate });
  }

  const startedAt = new Date().toISOString();
  const outcome = await runCalibration({ entries, transport, cap, budget, stabilityRun: stage === 3 });
  const finishedAt = new Date().toISOString();
  const guardStatus = guard ? guard.getCallGuardStatus() : null;

  const firstGate = outcome.records.find(record => record.gate?.lock_sha256)?.gate ?? null;
  const identity = {
    mode,
    simulation_mode: simulate,
    stages: Array.from({ length: stage }, (_, index) => index + 1),
    stage,
    head: head(),
    lock_sha256: firstGate?.lock_sha256 ?? null,
    protocol_id: firstGate?.protocol_id ?? null,
    cap,
    tool_calls: outcome.tool_calls,
    guard_calls_used: guardStatus?.used ?? null,
    guard_cache_hits: guardStatus?.cache_hits ?? null,
    isolation_ok: true,
    prices,
    budget_usd: budgetOf(args),
    started_at: startedAt,
    finished_at: finishedAt
  };

  const cumulative = [...previous.flatMap(doc => doc.records), ...outcome.records];
  const metrics = computeMetrics(cumulative, { prices });
  const criteria = evaluateCriteria(metrics, { cap, toolCalls: outcome.tool_calls, isolationOk: true, budgetUsd: identity.budget_usd });
  const document = buildResultsDocument({ identity, corpus, halted: outcome.halted, records: outcome.records, metrics, criteria });

  fs.writeFileSync(path.join(out, `stage-${stage}.json`), `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(path.join(out, `stage-${stage}-report.md`), renderReport({
    title: `R29.6 — calibration du juge, étape ${stage}`,
    identity,
    corpus,
    metrics,
    criteria,
    halted: outcome.halted
  }), { flag: "wx" });

  console.log(`Étape ${stage} (${mode}) : ${outcome.records.length}/${entries.length} entrée(s), ${outcome.tool_calls} appel(s) du transport.`);
  console.log(`  rapport : ${path.join(out, `stage-${stage}-report.md`)}`);
  if (outcome.halted) {
    console.error(`ARRÊT : ${outcome.halted.reason} sur ${outcome.halted.entry_id}.`);
    process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// finalize

function finalize(args) {
  const out = outputDir(args);
  const docs = [1, 2, 3]
    .map(stage => ({ stage, file: path.join(out, `stage-${stage}.json`) }))
    .filter(item => fs.existsSync(item.file))
    .map(item => ({ ...item, doc: readJson(item.file, `stage-${item.stage}.json`) }));

  for (const required of [1, 2]) {
    if (!docs.some(item => item.stage === required)) fail(`stage-${required}.json absent : étapes 1 et 2 obligatoires pour finaliser.`);
  }
  const [first] = docs;
  for (const { stage, doc } of docs) {
    if (doc.corpus.corpus_sha256 !== first.doc.corpus.corpus_sha256) fail(`stage-${stage}.json : corpus différent.`);
    if (doc.identity.mode !== first.doc.identity.mode) fail(`stage-${stage}.json : mode différent.`);
    if (doc.halted) fail(`stage-${stage}.json : étape interrompue (${doc.halted.reason}).`);
  }

  const prices = pricesOf(args) ?? first.doc.identity.prices ?? null;
  const budgetUsd = budgetOf(args) ?? first.doc.identity.budget_usd ?? null;
  const records = docs.flatMap(item => item.doc.records);

  // Relecture « utilisable » : document produit par un finalize précédent, rempli à la main.
  let reviews = [];
  if (args.review !== undefined) {
    const reviewDoc = readJson(path.resolve(need(args, "review")), "relecture");
    if (reviewDoc?.corpus_sha256 !== undefined && reviewDoc.corpus_sha256 !== first.doc.corpus.corpus_sha256) fail("relecture : corpus différent.");
    const normalized = normalizeReviews(reviewDoc);
    if (normalized.issues.length > 0) fail(`relecture invalide — ${normalized.issues.slice(0, 5).join(" ; ")}`);
    reviews = normalized.reviews;
  }
  const metrics = computeMetrics(records, { prices, reviews });
  if (metrics.declare_review.issues.length > 0) fail(`relecture invalide — ${metrics.declare_review.issues.slice(0, 5).join(" ; ")}`);
  const tag = typeof args.tag === "string" ? args.tag : args.review !== undefined ? "-relu" : "";
  const cap = docs.reduce((sum, item) => sum + item.doc.identity.cap, 0);
  const toolCalls = docs.reduce((sum, item) => sum + item.doc.identity.tool_calls, 0);
  const within = docs.every(item => item.doc.identity.tool_calls <= item.doc.identity.cap);
  const isolationOk = docs.every(item => item.doc.identity.isolation_ok === true);
  const criteria = evaluateCriteria(metrics, { cap: within ? cap : 0, toolCalls: within ? toolCalls : 1, isolationOk, budgetUsd });

  const last = docs.at(-1).doc.identity;
  const identity = {
    ...last,
    stages: docs.map(item => item.stage),
    cap,
    tool_calls: toolCalls,
    isolation_ok: isolationOk,
    prices,
    budget_usd: budgetUsd,
    started_at: first.doc.identity.started_at,
    finished_at: last.finished_at
  };

  const corpus = { version: first.doc.corpus.version, corpus_sha256: first.doc.corpus.corpus_sha256, counts: first.doc.corpus.counts };
  const document = buildResultsDocument({ identity, corpus, halted: null, records, metrics, criteria });
  fs.writeFileSync(path.join(out, `R29.6-donnees${tag}.json`), `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
  fs.writeFileSync(path.join(out, `R29.6-rapport-calibration${tag}.md`), renderReport({
    title: "R29.6 — rapport de calibration du juge",
    identity,
    corpus,
    metrics,
    criteria,
    halted: null
  }), { flag: "wx" });

  // Modèle de relecture : un élément par DECLARE, `usable` à renseigner à la main.
  if (args.review === undefined && metrics.declare_review.items.length > 0) {
    const template = {
      version: REVIEW_VERSION,
      corpus_sha256: corpus.corpus_sha256,
      consigne: "Renseigner « usable » : true si le texte du claim remplacerait fidèlement l'unité, false sinon (hors sujet, faux, doublon), null si non relu.",
      items: metrics.declare_review.items.map(item => ({
        review_id: item.review_id,
        kind: item.kind,
        original_text: item.original_text,
        claim_text: item.claim_text,
        key_fact_text: item.key_fact_text,
        flags: item.flags,
        usable: null,
        note: ""
      }))
    };
    fs.writeFileSync(path.join(out, "R29.6-relecture-modele.json"), `${JSON.stringify(template, null, 2)}\n`, { flag: "wx" });
    console.log(`Relecture     : ${path.join(out, "R29.6-relecture-modele.json")}`);
  }

  console.log(`Rapport final : ${path.join(out, `R29.6-rapport-calibration${tag}.md`)}`);
  console.log(`Données       : ${path.join(out, `R29.6-donnees${tag}.json`)}`);
  console.log(criteria.map(item => `  ${item.id} ${item.status}`).join("\n"));
}

// ---------------------------------------------------------------------------

const COMMANDS = { build, run, finalize };

async function main(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) fail("sous-commande attendue : build, run ou finalize (voir l'en-tête du fichier).");
  await COMMANDS[command](parseArgs(rest));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`Calibration : ${error instanceof UsageError ? error.message : `erreur inattendue — ${error?.stack ?? error}`}`);
  process.exitCode = 1;
}

