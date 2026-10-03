// Smoke Fact ↔ Evidence (R20.4, phase E) — zéro API, zéro réseau.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/fact-evidence-smoke.js
//
// Prouve :
// - la lecture locale des pages et l'enregistrement des preuves (URL finale,
//   SHA-256, date UTC, HTTP, Content-Type, longueur), sans réseau réel ;
// - la séparation stricte du statut technique et du statut éditorial ;
// - le contrôle déterministe des chiffres, dates, quantités et citations ;
// - que le juge ne contourne jamais le code ;
// - les reprises sans réseau (textes relus et vérifiés par empreinte).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { networkGuard } from "./fixture-network-guard.js";
import { configureCallGuard, resetCallGuard } from "../src/services/call-guard.js";
import {
  EVIDENCE_FIXTURE_DIR_ENV,
  FACT_EVIDENCE,
  buildEvidenceJudgeItems,
  collectEvidence,
  evaluateFactEvidence,
  evidenceConfirmed,
  evidenceJudgeInputSha256,
  factElements,
  findElement,
  htmlToText,
  judgeBatches,
  loadEvidenceTexts,
  loadFactEvidenceConfig,
  offlineChecks,
  readEvidencePage,
  runEvidenceJudgeBatch,
  validateEvidenceArtifact,
  validateEvidenceJudgeResponse
} from "../src/utils/fact-evidence.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("FACT ↔ EVIDENCE — SMOKE (ZERO API, ZERO RÉSEAU)");

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
const filler = "Texte de remplissage documentaire sans chiffre particulier. ".repeat(6);
const html = body => `<!doctype html><html><head><title>t</title><style>.x{}</style><script>var tracking = 1;</script></head><body>${body}<p>${filler}</p></body></html>`;

// Pages simulées (aucune sortie réseau) : statut, type, corps.
const PAGES = {
  "https://www.larousse.fr/australie": { status: 200, content_type: "text/html; charset=utf-8", body: html("<h1>Australie : population</h1><p>La densité atteint 3 hab./km². Près de 90 % de la population est urbaine et vit sur les bandes littorales.</p>") },
  "https://www.superprof.com.au/blog/distribution": { status: 200, content_type: "text/html", body: html("<p>About 85 % of Australians live near the coast. Environ 80 % vivent à moins de 25 km de la côte.</p>") },
  "https://www.universalis.fr/densite": { status: 200, content_type: "text/html", final_url: "https://www.universalis.fr/densite/australie", body: html("<p>La densité de l'Australie a atteint 3,57 hab./km² en 2025. Les déserts couvrent 1 371 000 km², soit 18 % du pays.</p>") },
  "https://www.bom.gov.au/climate": { status: 200, content_type: "text/html", body: html("<p>Les vents d'ouest et la Cordillère australienne bloquent l'humidité : l'intérieur reste sec. Le rapport indique « le continent habité le plus sec de la planète ».</p>") },
  "https://www.abs.gov.au/forbidden": { status: 403, content_type: "text/html", body: "Forbidden" },
  "https://www.abs.gov.au/report.pdf": { status: 200, content_type: "application/pdf", body: "%PDF-1.7" },
  "https://app.example.org/spa": { status: 200, content_type: "text/html", body: "<html><body><div id=\"root\"></div><script src=\"/app.js\"></script></body></html>" },
  "https://www.example.org/data.json": { status: 200, content_type: "application/json", body: "{}" },
  "https://www.example.org/huge": { status: 200, content_type: "text/html", body: "x".repeat(FACT_EVIDENCE.max_bytes + 1) },
  "https://www.example.org/slow": { timeout: true }
};

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-evidence-pages-"));
for (const [url, page] of Object.entries(PAGES)) fs.writeFileSync(path.join(fixtureDir, `${sha256(url)}.json`), JSON.stringify(page));
process.env[EVIDENCE_FIXTURE_DIR_ENV] = fixtureDir;

const source = (url, supports = "Confirme le fait") => ({ title: "t", url, publisher: "p", source_type: "secondary", supports_claim: supports });
const fact = (claim, urls, extra = {}) => ({ claim, importance: "high", verification_status: "verified", sources: urls.map(url => typeof url === "string" ? source(url) : source(url[0], url[1])), ...extra });

const DOSSIER = {
  topic: "Australie",
  key_facts: [
    fact("L'Australie a une densité de population d'environ 3,5 habitants par km²", ["https://www.universalis.fr/densite", "https://www.larousse.fr/australie"]),
    fact("Environ 80 % de la population vit à moins de 50 km de la côte", ["https://www.superprof.com.au/blog/distribution"]),
    fact("Les déserts australiens couvrent environ 1,37 million de km², soit 18 % du pays", ["https://www.universalis.fr/densite"]),
    fact("L'Australie est « le continent habité le plus sec de la planète »", ["https://www.bom.gov.au/climate"]),
    fact("La population australienne atteint 27 millions d'habitants", ["https://www.abs.gov.au/forbidden", "https://www.abs.gov.au/report.pdf"]),
    fact("Les régions intérieures comptent 2 % de la population", ["https://www.larousse.fr/australie", "https://www.abs.gov.au/forbidden"]),
    fact("Fait à vérifier", ["https://www.larousse.fr/australie"], { verification_status: "needs_verification" })
  ]
};

const productionDir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-evidence-production-"));
const FIXED_NOW = () => new Date("2026-10-03T12:00:00.000Z");
let evidence;
let texts;

// ---------------------------------------------------------------------

await test("configuration fact_evidence : chargée strictement, toute erreur refusée", () => {
  const base = JSON.parse(fs.readFileSync(new URL("../config/research.json", import.meta.url), "utf8")).fact_evidence;
  const variant = mutate => { const copy = structuredClone(base); mutate(copy); return { fact_evidence: copy }; };
  const cases = [
    [variant(c => { c.inconnue = 1; }), /clé inconnue : inconnue/],
    [variant(c => { c.fetch_timeout_ms = 10; }), /fetch_timeout_ms/],
    [variant(c => { c.max_bytes = 1; }), /max_bytes/],
    [variant(c => { c.user_agent = ""; }), /user_agent/],
    [variant(c => { c.accepted_content_types = ["html"]; }), /accepted_content_types/],
    [variant(c => { c.judge_batch_size = 0; }), /judge_batch_size/],
    [{}, /fact_evidence absente/]
  ];
  for (const [config, pattern] of cases) {
    let message = "";
    try { loadFactEvidenceConfig(config); } catch (error) { message = error.message; }
    assert(pattern.test(message), `${pattern} : « ${message} »`);
  }
  assert(FACT_EVIDENCE.max_bytes === 2000000, "plafond de 2 Mo par page");
});

await test("extraction du texte HTML : scripts et styles retirés, entités décodées", () => {
  const text = htmlToText("<html><head><style>p{}</style><script>var x = '95 %';</script></head><body><h1>Titre &amp; co</h1><p>Environ 80&nbsp;% &laquo;vivent&raquo; ici.</p><!-- 95 % --></body></html>");
  assert(text === "Titre & co\nEnviron 80 % «vivent» ici.", JSON.stringify(text));
});

await test("statut technique de chaque lecture : page lue, HTTP, délai, PDF, JavaScript, type, taille", async () => {
  const expected = {
    "https://www.larousse.fr/australie": "fetched",
    "https://www.abs.gov.au/forbidden": "http_error",
    "https://www.abs.gov.au/report.pdf": "pdf",
    "https://app.example.org/spa": "javascript_required",
    "https://www.example.org/data.json": "unsupported_type",
    "https://www.example.org/huge": "too_large",
    "https://www.example.org/slow": "timeout",
    "https://www.example.org/absente": "network_error"
  };
  for (const [url, status] of Object.entries(expected)) {
    const { record, text } = await readEvidencePage(url, { now: FIXED_NOW });
    assert(record.technical_status === status, `${url} : ${record.technical_status} au lieu de ${status}`);
    assert((text !== null) === (status === "fetched"), `${url} : texte`);
  }
  const { record } = await readEvidencePage("https://www.abs.gov.au/forbidden", { now: FIXED_NOW });
  assert(record.http_status === 403 && record.detail === "HTTP 403", JSON.stringify(record));
});

await test("enregistrement de chaque preuve : URL finale, SHA-256, date UTC, HTTP, Content-Type, longueur", async () => {
  evidence = await collectEvidence({ research: DOSSIER, productionDir, now: FIXED_NOW });
  assert(validateEvidenceArtifact(evidence, DOSSIER).length === 0, validateEvidenceArtifact(evidence, DOSSIER).join());
  const record = evidence.sources.find(item => item.url === "https://www.universalis.fr/densite");
  assert(record.final_url === "https://www.universalis.fr/densite/australie" && record.http_status === 200, JSON.stringify(record));
  assert(record.fetched_at === "2026-10-03T12:00:00.000Z" && /^[0-9a-f]{64}$/.test(record.text_sha256) && record.text_length > 0, JSON.stringify(record));
  assert(record.content_type === "text/html", record.content_type);
  const file = path.join(productionDir, "evidence", `${record.text_sha256}.txt`);
  assert(fs.existsSync(file) && sha256(fs.readFileSync(file, "utf8")) === record.text_sha256, "texte enregistré");
  // Seuls les faits verified sont lus (Q-E4), chaque URL une seule fois.
  assert(evidence.sources.length === 6, `${evidence.sources.length} URL`);
});

await test("reprise sans réseau : textes relus et vérifiés ; texte modifié ou absent → échec explicite", () => {
  texts = loadEvidenceTexts({ evidence, productionDir });
  assert(texts.size === 4, `${texts.size} textes`);
  const record = evidence.sources.find(item => item.technical_status === "fetched");
  const file = path.join(productionDir, "evidence", `${record.text_sha256}.txt`);
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, `${original} altéré`);
  let message = "";
  try { loadEvidenceTexts({ evidence, productionDir }); } catch (error) { message = error.message; }
  assert(/empreinte différente/.test(message), message);
  fs.rmSync(file);
  try { loadEvidenceTexts({ evidence, productionDir }); message = ""; } catch (error) { message = error.message; }
  assert(/texte enregistré absent/.test(message), message);
  fs.writeFileSync(file, original);
});

await test("NO_API=1 sans jeu de pages : aucune lecture réseau, statut network_disabled", async () => {
  delete process.env[EVIDENCE_FIXTURE_DIR_ENV];
  const { record } = await readEvidencePage("https://www.larousse.fr/australie", { now: FIXED_NOW });
  process.env[EVIDENCE_FIXTURE_DIR_ENV] = fixtureDir;
  assert(record.technical_status === "network_disabled", record.technical_status);
});

await test("éléments contrôlés : chiffres avec unité et échelle, fourchettes, approximations, citations", () => {
  const elements = text => factElements(text).map(item => `${item.kind}:${item.text}:${item.figure ? `${item.figure.low}-${item.figure.high}${item.unit ? item.unit : ""}${item.approximate ? "~" : ""}` : ""}`).join(" | ");
  assert(elements("Environ 80 % vivent à moins de 50 km") === "figure:80 %:80-80%~ | figure:50 km:50-50km~", elements("Environ 80 % vivent à moins de 50 km"));
  assert(elements("couvrent environ 1,37 million de km²") === "figure:1,37 million de km²:1370000-1370000km²~", elements("couvrent environ 1,37 million de km²"));
  assert(elements("Le fait date de 1788") === "date:1788:1788-1788", elements("Le fait date de 1788"));
  assert(elements("Il est « le continent habité le plus sec »").startsWith("quote:le continent habité le plus sec"), elements("Il est « le continent habité le plus sec »"));
  const text = texts.get("https://www.universalis.fr/densite");
  assert(findElement(factElements("environ 1,37 million de km²")[0], text)?.found === "1 371 000", "échelle et milliers");
  assert(findElement(factElements("couvrent 2 millions de km²")[0], text) === null, "chiffre absent trouvé");
});

await test("contrôles hors réseau : provenance et cohérence interne (le cas 50 km / 25 km)", () => {
  const dossier = { key_facts: [fact("Environ 80 % vivent à moins de 50 km de la côte", [["https://www.superprof.com.au/blog/distribution", "Confirme qu'environ 80% des Australiens vivent à moins de 25 km de la côte"]])] };
  const checks = offlineChecks(dossier, { searchUrls: new Set(["https://autre.example.org/"]) });
  const consistency = checks.find(check => check.check === "internal_consistency");
  assert(consistency && consistency.reason === "chiffre « 50 km » du fait absent de ce que ses sources déclarent confirmer (elles déclarent « 25 km »)", JSON.stringify(checks));
  assert(checks.find(check => check.check === "provenance").status === "warning", "provenance");
  assert(offlineChecks(dossier, { searchUrls: null }).every(check => check.check !== "provenance"), "provenance sans journal de recherche");
});

// Juge simulé : statut, extrait et citation donnés par fait.
function judgementsFor(items, decisions) {
  return new Map(items.map(item => {
    const decision = decisions[item.id] ?? { status: "supported" };
    const excerpt = item.excerpts[0];
    return [item.id, {
      id: item.id,
      status: decision.status,
      source: decision.status === "not_supported" ? "" : (decision.source ?? excerpt?.id ?? ""),
      quote: decision.status === "not_supported" ? "" : (decision.quote ?? excerpt?.text ?? ""),
      explanation: decision.explanation ?? "Explication du modèle."
    }];
  }));
}

await test("statuts éditorial et technique séparés ; le code rejette un chiffre absent même si le juge le valide", () => {
  const items = buildEvidenceJudgeItems({ research: DOSSIER, evidence, texts });
  const result = evaluateFactEvidence({ research: DOSSIER, evidence, texts, judgements: judgementsFor(items, {}) });
  const byFact = result.facts.map(item => `${item.editorial_status}/${item.technical_status}`).join(" | ");
  assert(byFact === "supported/all_read | rejected/all_read | supported/all_read | supported/all_read | unverifiable/unreadable | unverifiable/partially_read | not_checked/all_read", byFact);
  const rejected = result.facts[1];
  assert(rejected.reasons.some(reason => reason === "Chiffre « 50 km » absent de la preuve https://www.superprof.com.au/blog/distribution."), rejected.reasons.join(" | "));
  const unreadable = result.facts[4];
  assert(unreadable.reasons.some(reason => reason.includes("erreur HTTP (HTTP 403)")) && unreadable.reasons.some(reason => reason.includes("PDF non lu")), unreadable.reasons.join(" | "));
  const partial = result.facts[5];
  assert(partial.reasons.some(reason => reason.includes("l'élément manquant ne peut pas être exclu")), partial.reasons.join(" | "));
  assert(result.counts.supported === 3 && result.counts.rejected === 1 && result.counts.unverifiable === 2 && result.counts.not_checked === 1, JSON.stringify(result.counts));
});

await test("juge : statut partiel, rejet, et citation introuvable → non vérifiable (jamais supported)", () => {
  const items = buildEvidenceJudgeItems({ research: DOSSIER, evidence, texts });
  const result = evaluateFactEvidence({ research: DOSSIER, evidence, texts, judgements: judgementsFor(items, {
    f1: { status: "partially_supported" },
    f3: { status: "not_supported" },
    f4: { status: "supported", quote: "le continent le plus humide du monde" }
  }) });
  assert(result.facts[0].editorial_status === "partially_supported", result.facts[0].editorial_status);
  assert(result.facts[2].editorial_status === "rejected", result.facts[2].editorial_status);
  assert(result.facts[3].editorial_status === "unverifiable" && result.facts[3].reasons.some(reason => reason.includes("citation du juge est introuvable")), result.facts[3].reasons.join(" | "));
  assert(result.facts[0].quote?.text && result.facts[0].quote.source === "https://www.universalis.fr/densite", JSON.stringify(result.facts[0].quote));
});

await test("production historique : aucune preuve lue, statut not_checked et technique not_fetched", () => {
  const result = evaluateFactEvidence({ research: DOSSIER, skipReason: "production historique, aucun accès réseau" });
  assert(result.checked === false && result.facts.every(item => item.editorial_status === "not_checked"), JSON.stringify(result.counts));
  assert(result.facts[0].technical_status === "not_fetched" && result.facts[0].reasons[0] === "preuves non lues — production historique, aucun accès réseau", result.facts[0].reasons[0]);
  assert(evidenceConfirmed(result, 0) === true, "historique : définition des phases A et B conservée");
  const checked = evaluateFactEvidence({ research: DOSSIER, evidence, texts, judgements: judgementsFor(buildEvidenceJudgeItems({ research: DOSSIER, evidence, texts }), {}) });
  assert(evidenceConfirmed(checked, 0) === true && evidenceConfirmed(checked, 1) === false && evidenceConfirmed(checked, 4) === false, "Q-E5");
});

await test("lots du juge et contrôle strict de sa réponse", () => {
  const items = buildEvidenceJudgeItems({ research: DOSSIER, evidence, texts });
  assert(items.length === 6 && judgeBatches(items, { judge_batch_size: 4 }).map(batch => batch.length).join() === "4,2", "lots");
  assert(items[0].excerpts.length > 0 && items[0].excerpts.every(excerpt => excerpt.id.startsWith("f1-s") && excerpt.text.length <= FACT_EVIDENCE.excerpt_chars), "extraits");
  assert(items[4].excerpts.length === 0, "extraits d'une preuve illisible");
  const batch = items.slice(0, 2);
  const good = { facts: [...judgementsFor(batch, {}).values()] };
  assert(validateEvidenceJudgeResponse(good, batch).length === 0, validateEvidenceJudgeResponse(good, batch).join());
  const cases = [
    [{}, /facts: \[\]/],
    [{ facts: good.facts.slice(1) }, /exactement une fois/],
    [{ facts: good.facts.map((item, index) => index === 0 ? { ...item, status: "vrai" } : item) }, /status invalide/],
    [{ facts: good.facts.map((item, index) => index === 0 ? { ...item, source: "f9-s1-e1" } : item) }, /source inconnue/],
    [{ facts: good.facts.map((item, index) => index === 0 ? { ...item, quote: "" } : item) }, /quote manquante/]
  ];
  for (const [response, pattern] of cases) assert(pattern.test(validateEvidenceJudgeResponse(response, batch).join(" ; ")), String(pattern));
  assert(evidenceJudgeInputSha256(batch) === evidenceJudgeInputSha256(structuredClone(batch)), "empreinte stable");
});

async function withStubbedSdk(responses, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-evidence-judge-"));
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

await test("juge des preuves : via le garde des appels, une seule réparation, puis échec explicite", async () => {
  const batch = buildEvidenceJudgeItems({ research: DOSSIER, evidence, texts }).slice(0, 2);
  const good = JSON.stringify({ facts: [...judgementsFor(batch, {}).values()] });
  const ok = await withStubbedSdk([good], () => runEvidenceJudgeBatch(batch));
  assert(!ok.error && ok.result.attempts === 1 && ok.requests[0].system.startsWith("Tu es le juge des preuves de la chaîne YouTube"), ok.error?.message ?? "un appel");
  assert(ok.requests[0].temperature === 0 && ok.requests[0].messages[0].content.includes("DONNÉES :\n"), "requête");
  const repaired = await withStubbedSdk(["pas du JSON", good], () => runEvidenceJudgeBatch(batch));
  assert(!repaired.error && repaired.result.attempts === 2 && repaired.requests[1].messages[0].content.startsWith("RÉPARATION"), repaired.error?.message ?? "réparation");
  const broken = await withStubbedSdk(["pas du JSON", "{}"], () => runEvidenceJudgeBatch(batch));
  assert(/réponse invalide après réparation/.test(broken.error?.message ?? "") && broken.requests.length === 2, broken.error?.message ?? "échec");
});

// ---------------------------------------------------------------------
// Corrections après le premier test réel (exposants, fourchettes, état
// « non contrôlé »).
// ---------------------------------------------------------------------

await test("exposants d'unité : km<sup>2</sup>, km 2, km2, km^2, km², m³ reconnus après normalisation ; un « 2 » ordinaire ignoré", () => {
  const surface = factElements("Les déserts couvrent environ 1,37 million de km², soit 18 % du pays")[0];
  assert(surface.unit === "km²" && surface.figure.low === 1370000, JSON.stringify(surface));
  for (const text of [htmlToText("<p>près de 1 371 000 km<sup>2</sup> soit 18 %</p>"), "près de 1 371 000 km 2 , soit 18 %", "1 371 000 km2", "1 371 000 km^2", "1 371 000 km²"]) {
    assert(findElement(surface, text), `non reconnu : ${text}`);
  }
  for (const text of ["1 371 000 km", "1 371 000 km 2016", "1 371 000 m²"]) {
    assert(!findElement(surface, text), `reconnu à tort : ${text}`);
  }
  assert(htmlToText("<p>3 m<sup>3</sup> et 4 km<sup> 2 </sup></p>") === "3 m³ et 4 km²", htmlToText("<p>3 m<sup>3</sup> et 4 km<sup> 2 </sup></p>"));
  assert(findElement(factElements("un volume de 3 m³")[0], htmlToText("<p>soit 3 m<sup>3</sup> d'eau</p>")), "m³");
});

await test("fourchettes strictes : les deux bornes exactes sont exigées, même avec « environ » ; tolérance conservée pour une valeur unique", () => {
  const range = factElements("Environ 85 à 90 % de la population vit sur les côtes")[0];
  assert(range.figure.low === 85 && range.figure.high === 90 && range.approximate === true, JSON.stringify(range));
  assert(!findElement(range, "80 % des Australiens, et 90 % de population urbaine"), "une seule borne a suffi");
  assert(!findElement(range, "84 % puis 90 %"), "borne approchée acceptée");
  assert(findElement(range, "85 % vivent sur la côte ; 90 % sont urbains"), "deux bornes exactes refusées");
  assert(findElement(range, "entre 85 et 90 % de la population"), "même fourchette refusée");
  assert(findElement(factElements("environ 3,5 habitants par km²")[0], "3,57 hab./km²"), "valeur unique approximative refusée");
});

await test("preuve lue sans extrait exploitable (fait en français, page en anglais) : unverifiable, jamais not_checked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-evidence-noexcerpt-"));
  const dossier = { key_facts: [fact("Les courants océaniques froids empêchent les pluies de pénétrer à l'intérieur", ["https://www.bom.gov.au/climate-en"])] };
  const text = `Australia is a dry continent. ${filler}`.replace(/Texte de remplissage documentaire sans chiffre particulier\. /g, "Plain English filler sentence about something else entirely. ");
  const sha = sha256(text);
  fs.mkdirSync(path.join(dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(dir, "evidence", `${sha}.txt`), text);
  const localEvidence = { schema: "evidence.v1", sources: [{ url: "https://www.bom.gov.au/climate-en", final_url: "https://www.bom.gov.au/climate-en", fetched_at: "2026-10-03T12:00:00.000Z", http_status: 200, content_type: "text/html", text_sha256: sha, text_length: text.length, technical_status: "fetched", detail: null }] };
  const localTexts = loadEvidenceTexts({ evidence: localEvidence, productionDir: dir });
  const items = buildEvidenceJudgeItems({ research: dossier, evidence: localEvidence, texts: localTexts });
  assert(items[0].excerpts.length === 0, "extrait trouvé");
  const result = evaluateFactEvidence({ research: dossier, evidence: localEvidence, texts: localTexts });
  assert(result.facts[0].editorial_status === "unverifiable" && result.facts[0].technical_status === "all_read", result.facts[0].editorial_status);
  assert(result.facts[0].reasons.includes("Aucun extrait exploitable dans la preuve lue : le soutien ne peut pas être établi."), result.facts[0].reasons.join(" | "));
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("juge suspendu (hiérarchie à résoudre d'abord) : unverifiable avec la raison, jamais not_checked", () => {
  const result = evaluateFactEvidence({ research: DOSSIER, evidence, texts, skipReason: "hiérarchie des sources à résoudre d'abord" });
  const fourth = result.facts[3];
  assert(fourth.editorial_status === "unverifiable" && fourth.reasons.includes("Jugement suspendu — hiérarchie des sources à résoudre d'abord."), `${fourth.editorial_status} ${fourth.reasons.join(" | ")}`);
  assert(result.facts.filter(item => item.editorial_status === "not_checked").map(item => item.index).join() === "6", "seul le fait non vérifié reste not_checked");
});

fs.rmSync(fixtureDir, { recursive: true, force: true });
fs.rmSync(productionDir, { recursive: true, force: true });

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
