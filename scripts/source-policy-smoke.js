// Smoke de la politique des sources (R20.4, phase C1) — zéro API, zéro réseau.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/source-policy-smoke.js
//
// Prouve que C1 ne change aucun comportement :
// - le prompt Research rendu depuis source_policy a exactement les
//   empreintes d'avant C1 (requête et cache inchangés) ;
// - le gate Research rend exactement les mêmes décisions que le validateur
//   d'avant C1 (copie figée ci-dessous) sur un corpus de dossiers ;
// - la politique est chargée strictement et évaluée en mode rapport.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import Anthropic from "@anthropic-ai/sdk";

import { networkGuard } from "./fixture-network-guard.js";
import { runResearchAgent } from "../src/agents/research.js";
import { buildTruthReport, renderTruthMarkdown } from "../src/agents/truth.js";
import { CANONICAL_PROMPT, CANONICAL_TITLE } from "../src/fixtures/anthropic-dataset.js";
import { configureCallGuard, requestSha256, resetCallGuard } from "../src/services/call-guard.js";
import { resolveDurationProfile } from "../src/utils/duration-profile.js";
import {
  SOURCE_POLICY,
  applySourcePolicyPrompt,
  evaluateSourcePolicy,
  loadSourcePolicy,
  renderSourcePolicyPrompt,
  validateSourcePolicyConfig
} from "../src/utils/source-policy.js";
import { validateResearchDossier } from "../src/utils/validate-research.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("SOURCE POLICY — SMOKE (ZERO API)");

// ---------------------------------------------------------------------
// Validateur Research d'avant C1, copie figée (référence d'équivalence).
// Ne pas modifier : c'est le comportement à conserver.
// ---------------------------------------------------------------------
function legacyIsNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function legacyIsValidHttpUrl(value) {
  if (!legacyIsNonEmptyString(value)) return false;

  const trimmed = value.trim();

  // Une source doit contenir une URL brute, jamais du Markdown.
  if (
    trimmed.includes("[") ||
    trimmed.includes("]") ||
    trimmed.includes("(") ||
    trimmed.includes(")") ||
    /\s/.test(trimmed)
  ) {
    return false;
  }

  try {
    const url = new URL(trimmed);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function legacyValidateSource(source) {
  const errors = [];

  if (!source || typeof source !== "object") {
    return ["source absente ou invalide"];
  }

  if (!legacyIsNonEmptyString(source.title)) {
    errors.push("title manquant");
  }

  if (!legacyIsValidHttpUrl(source.url)) {
    errors.push("url absente ou invalide");
  }

  if (!legacyIsNonEmptyString(source.publisher)) {
    errors.push("publisher manquant");
  }

  if (!["primary", "secondary"].includes(source.source_type)) {
    errors.push("source_type invalide");
  }

  if (!legacyIsNonEmptyString(source.supports_claim)) {
    errors.push("supports_claim manquant");
  }

  return errors;
}

function legacyValidateResearchDossier(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Dossier research absent ou invalide"],
      warnings
    };
  }

  if (!Array.isArray(data.key_facts)) {
    errors.push("key_facts doit être un tableau");

    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.key_facts.forEach((fact, factIndex) => {
    const label = `key_facts[${factIndex}]`;

    if (!legacyIsNonEmptyString(fact?.claim)) {
      errors.push(`${label}: claim manquant`);
    }

    if (
      !["verified", "needs_verification", "uncertain"].includes(
        fact?.verification_status
      )
    ) {
      errors.push(`${label}: verification_status invalide`);
    }

    const sources = Array.isArray(fact?.sources)
      ? fact.sources
      : [];

    sources.forEach((source, sourceIndex) => {
      const sourceErrors = legacyValidateSource(source);

      for (const error of sourceErrors) {
        errors.push(
          `${label}.sources[${sourceIndex}]: ${error}`
        );
      }
    });

    if (
      fact?.verification_status === "verified" &&
      sources.length === 0
    ) {
      errors.push(
        `${label}: VERIFIED interdit sans source`
      );
    }

    if (
      fact?.verification_status === "verified" &&
      sources.length > 0
    ) {
      const hasUsableSource = sources.some(
        (source) => legacyValidateSource(source).length === 0
      );

      if (!hasUsableSource) {
        errors.push(
          `${label}: VERIFIED sans source exploitable`
        );
      }
    }

    if (
      fact?.importance === "high" &&
      fact?.verification_status !== "verified"
    ) {
      warnings.push(
        `${label}: fait HIGH non vérifié`
      );
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

// ---------------------------------------------------------------------
// Références capturées sur le code d'avant C1 (03/10/2026).
// ---------------------------------------------------------------------

const REAL_TITLE = "Pourquoi 95 % de l'Australie est presque vide ?";
const REAL_PROMPT = "Documentaire géographique factuel destiné à la chaîne Les Découvertes du Nomade.";

const GOLDEN = {
  "standard-full": { system: "b9c55cca590937d7375c802c221ede35268a9cb04cff37df0a71e784fda52ce8", request: "520164e702e54eb85cfd3383a6c1b9be06a0eed9dfe60e4d437f3abc70c20784" },
  "standard-test": { system: "b9c55cca590937d7375c802c221ede35268a9cb04cff37df0a71e784fda52ce8", request: "c694e5be8aeb3e8adad96898cf2509a400229fb58bf4a5336b2f8cce3ba9f6c1" },
  // Empreinte de l'appel Research réel de la production du 03/10.
  "short-full": { system: "f96a8e3572efb846d468174872915fa2bb779c224a43e13c4977b31a25ee3fd3", request: "27ec2e44d64bea5fe7a562d051aa82dbc0f626326c4eacb23f627f980ab6915e" },
  "short-test": { system: "f96a8e3572efb846d468174872915fa2bb779c224a43e13c4977b31a25ee3fd3", request: "dd39699170495fded1bea33dc58657e9ad066af605daf4263a3a1dc172f246cb" }
};

const LEGACY_RULE_LINES = [
  "- Un fait ne peut avoir verification_status=\"verified\" que s'il possède au moins une source exploitable.",
  "- Privilégie les sources primaires : organismes publics, instituts statistiques, universités, publications scientifiques et institutions officielles.",
  "- Si aucune source fiable n'est disponible, utilise needs_verification ou uncertain.",
  "- Les sources secondaires sont acceptables lorsqu'une source primaire pertinente n'est pas disponible.",
  "- Les chiffres, pourcentages, dates et affirmations centrales doivent être sourcés.",
  "- Chaque key_fact contient au maximum 2 sources, en conservant les sources les plus solides et directement pertinentes."
];

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
const pipelineConfig = JSON.parse(fs.readFileSync(new URL("../config/pipeline.json", import.meta.url), "utf8"));
const researchConfig = JSON.parse(fs.readFileSync(new URL("../config/research.json", import.meta.url), "utf8"));

process.env.ANTHROPIC_FIXTURES = "1";
const fixtureDossier = (await runResearchAgent({ title: CANONICAL_TITLE, prompt: CANONICAL_PROMPT, testMode: true })).data;
delete process.env.ANTHROPIC_FIXTURES;

// Capture la requête Research sans appel : create est remplacé par un
// bouchon local qui renvoie le dossier des fixtures.
async function captureResearchRequest(profileName, testMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "source-policy-smoke-"));
  const original = Anthropic.Messages.prototype.create;
  const savedEnv = { ack: process.env.PIPELINE_REAL_CALLS_ACK, noApi: process.env.NO_API, key: process.env.ANTHROPIC_API_KEY };
  let captured = null;

  Anthropic.Messages.prototype.create = async function (request) {
    captured = request;
    return { id: "msg_smoke", type: "message", role: "assistant", model: "smoke", content: [{ type: "text", text: JSON.stringify(fixtureDossier) }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
  };
  process.env.PIPELINE_REAL_CALLS_ACK = "1";
  delete process.env.NO_API;
  process.env.ANTHROPIC_API_KEY ??= `sk-ant-smoke-${"x".repeat(60)}`;
  configureCallGuard({ productionDir: dir, cap: 1 });

  try {
    await runResearchAgent({ title: REAL_TITLE, prompt: REAL_PROMPT, testMode, durationProfile: resolveDurationProfile(pipelineConfig.video, profileName) });
  } finally {
    resetCallGuard();
    Anthropic.Messages.prototype.create = original;
    process.env.NO_API = savedEnv.noApi;
    if (savedEnv.ack === undefined) delete process.env.PIPELINE_REAL_CALLS_ACK; else process.env.PIPELINE_REAL_CALLS_ACK = savedEnv.ack;
    if (savedEnv.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnv.key;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return captured;
}

// ---------------------------------------------------------------------
// Corpus d'équivalence du gate Research.
// ---------------------------------------------------------------------

const goodSource = (n, type = "secondary") => ({
  title: `Source ${n}`,
  url: `https://example-${n}.org/page`,
  publisher: `Éditeur ${n}`,
  source_type: type,
  supports_claim: `Confirme le fait ${n}`
});

const SOURCE_VARIANTS = {
  none: [],
  primary: [goodSource(1, "primary")],
  secondary: [goodSource(2)],
  two: [goodSource(3, "primary"), goodSource(4)],
  three: [goodSource(5), goodSource(6), goodSource(7)],
  tertiary: [{ ...goodSource(8), source_type: "tertiary" }],
  missing_type: [{ ...goodSource(9), source_type: undefined }],
  markdown_url: [{ ...goodSource(10), url: "[lien](https://example.org)" }],
  spaced_url: [{ ...goodSource(11), url: "https://example.org/a b" }],
  ftp_url: [{ ...goodSource(12), url: "ftp://example.org/file" }],
  no_title: [{ ...goodSource(13), title: "  " }],
  no_publisher: [{ ...goodSource(14), publisher: null }],
  no_support: [{ ...goodSource(15), supports_claim: "" }],
  mixed: [{ ...goodSource(16), url: "pas une url" }, goodSource(17, "primary")],
  all_bad: [{ ...goodSource(18), url: "" }, { ...goodSource(19), source_type: "blog" }],
  null_source: [null],
  string_source: ["https://example.org"]
};

const STATUSES = ["verified", "needs_verification", "uncertain", "confirmed", undefined];
const IMPORTANCES = ["high", "medium", "low", undefined];

function buildCorpus() {
  const corpus = [
    { name: "dossier canonique des fixtures", data: fixtureDossier },
    { name: "null", data: null },
    { name: "chaîne", data: "dossier" },
    { name: "key_facts absent", data: {} },
    { name: "key_facts objet", data: { key_facts: {} } },
    { name: "key_facts vide", data: { key_facts: [] } }
  ];

  for (const [variant, sources] of Object.entries(SOURCE_VARIANTS)) {
    for (const status of STATUSES) {
      for (const importance of IMPORTANCES) {
        corpus.push({
          name: `${variant}/${status}/${importance}`,
          data: { key_facts: [{ claim: "Un fait", verification_status: status, importance, sources: structuredClone(sources) }] }
        });
      }
    }
  }

  corpus.push({ name: "claim vide", data: { key_facts: [{ claim: "", verification_status: "verified", sources: SOURCE_VARIANTS.primary }] } });
  corpus.push({ name: "sources non tableau", data: { key_facts: [{ claim: "x", verification_status: "verified", importance: "high", sources: "https://example.org" }] } });
  corpus.push({ name: "fait null", data: { key_facts: [null] } });

  // Réplique de structure du dossier réel du 03/10 : 10 faits verified,
  // 13 sources secondaires dont 10 distinctes, au plus 2 par fait.
  const perFact = [2, 2, 1, 2, 1, 1, 1, 1, 1, 1];
  const importance = ["high", "high", "high", "high", "high", "high", "medium", "medium", "high", "medium"];
  let n = 0;
  const realLike = {
    ...structuredClone(fixtureDossier),
    key_facts: perFact.map((count, index) => ({
      claim: `Fait ${index + 1}`,
      importance: importance[index],
      verification_status: "verified",
      sources: Array.from({ length: count }, () => {
        n += 1;
        return goodSource(n <= 10 ? n : n - 10);
      })
    }))
  };
  corpus.push({ name: "réplique du dossier réel du 03/10", data: realLike });

  return corpus;
}

const corpus = buildCorpus();
const realLike = corpus.at(-1).data;

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

await test("prompt Research : empreintes du system et de la requête identiques à avant C1 (4 profils/modes)", async () => {
  for (const [key, golden] of Object.entries(GOLDEN)) {
    const [profile, mode] = key.split("-");
    const request = await captureResearchRequest(profile, mode === "test");
    assert(request, `${key} : aucune requête capturée`);
    assert(sha256(request.system) === golden.system, `${key} : system modifié`);
    assert(requestSha256(request) === golden.request, `${key} : requête modifiée (le cache ne serait plus trouvé)`);
  }
});

await test("prompt Research : chaque règle historique est rendue depuis la politique, aucune balise restante", async () => {
  const request = await captureResearchRequest("standard", true);
  for (const line of LEGACY_RULE_LINES) assert(request.system.split("\n").includes(line), `ligne absente : ${line}`);
  assert(!/\{\{/.test(request.system), "balise non résolue");
  const source = fs.readFileSync(new URL("../src/agents/research.js", import.meta.url), "utf8");
  for (const line of LEGACY_RULE_LINES) assert(!source.includes(line), `règle encore recopiée dans research.js : ${line}`);
});

await test("prompt Research : le texte suit la politique (règles désactivables, limite par fait)", () => {
  const variant = { ...structuredClone(SOURCE_POLICY), allow_unsourced_claims: true, mark_unverified_claims: false, max_sources_per_fact: 3 };
  const rendered = applySourcePolicyPrompt("A\n{{POLICY_UNSOURCED}}\n{{POLICY_UNVERIFIED}}\n{{POLICY_PER_FACT}}\nB", loadSourcePolicy({ source_policy: variant }));
  assert(rendered === "A\n- Chaque key_fact contient au maximum 3 sources, en conservant les sources les plus solides et directement pertinentes.\nB", rendered);
  let refused = false;
  try { applySourcePolicyPrompt("{{POLICY_INCONNUE}}\n"); } catch (error) { refused = /inconnue/.test(error.message); }
  assert(refused, "balise inconnue acceptée");
  assert(Object.keys(renderSourcePolicyPrompt()).length === 6, "règles rendues");
});

await test(`gate Research : décisions identiques à l'ancien validateur sur ${corpus.length} dossiers`, () => {
  let invalid = 0;
  for (const item of corpus) {
    const before = legacyValidateResearchDossier(structuredClone(item.data));
    const after = validateResearchDossier(structuredClone(item.data));
    assert(isDeepStrictEqual(before, after), `${item.name} : ${JSON.stringify(before)} ≠ ${JSON.stringify(after)}`);
    if (!before.valid) invalid += 1;
  }
  // Le corpus couvre les deux issues, sinon l'équivalence ne prouverait rien.
  assert(invalid > 50 && corpus.length - invalid > 50, `corpus déséquilibré : ${invalid} refus sur ${corpus.length}`);
  assert(validateResearchDossier(fixtureDossier).valid && validateResearchDossier(realLike).valid, "dossiers existants refusés");
});

await test("configuration : chargée strictement, toute erreur refusée explicitement", () => {
  assert(validateSourcePolicyConfig(researchConfig.source_policy).length === 0, "configuration actuelle refusée");
  assert(Object.isFrozen(SOURCE_POLICY) && !("research_limits" in researchConfig), "research_limits doit être rattaché à source_policy");
  const base = researchConfig.source_policy;
  const cases = [
    [{ ...base, prefer_primary_sources: true }, /clé inconnue : prefer_primary_sources/],
    [{ ...base, minimum_sources: "5" }, /minimum_sources doit être un entier/],
    [{ ...base, max_sources_per_fact: 0 }, /max_sources_per_fact doit être un entier/],
    [{ ...base, minimum_sources: 20 }, /minimum_sources ≤ target_sources/],
    [{ ...base, mark_unverified_claims: "oui" }, /mark_unverified_claims doit être un booléen/],
    [{ ...base, preferred_source_types: ["tertiary"] }, /type préféré non autorisé/],
    [{ ...base, allowed_source_types: [] }, /allowed_source_types doit être une liste/],
    [{ ...base, source_types: { primary: base.source_types.primary } }, /source_types.secondary manquant/],
    [{ ...base, source_types: { ...base.source_types, primary: { label: "x" } } }, /source_types.primary.plural_label manquant/],
    [null, /source_policy absente/]
  ];
  for (const [policy, pattern] of cases) {
    let message = "";
    try { loadSourcePolicy({ source_policy: policy }); } catch (error) { message = error.message; }
    assert(pattern.test(message), `${pattern} : « ${message} »`);
  }
});

await test("évaluation : réplique du dossier réel du 03/10 (10 sources, toutes secondaires)", () => {
  const report = evaluateSourcePolicy(realLike);
  const byRule = Object.fromEntries(report.checks.map(check => [check.rule, check.status]));
  assert(report.mode === "report" && report.distinct_sources === 10, JSON.stringify(report));
  assert(byRule.minimum_sources === "compliant" && byRule.target_sources === "compliant" && byRule.maximum_sources === "compliant", "limites");
  assert(byRule.require_sources_for_key_facts === "compliant" && byRule.max_sources_per_fact === "compliant", "règles obligatoires");
  assert(byRule.preferred_source_types === "warning" && report.status === "warning", "préférence pour les primaires");
});

await test("évaluation : chaque règle détecte son écart, avec les faits concernés", () => {
  const facts = [
    { claim: "a", verification_status: "verified", sources: [] },
    { claim: "b", verification_status: "needs_verification", sources: SOURCE_VARIANTS.three },
    { claim: "c", verification_status: "verified", sources: SOURCE_VARIANTS.tertiary }
  ];
  const report = evaluateSourcePolicy({ key_facts: facts });
  const get = rule => report.checks.find(check => check.rule === rule);
  assert(get("require_sources_for_key_facts").status === "non_compliant" && isDeepStrictEqual(get("require_sources_for_key_facts").facts, [0, 2]), "verified sans source");
  assert(get("allowed_source_types").status === "non_compliant" && isDeepStrictEqual(get("allowed_source_types").facts, [2]), "type interdit");
  assert(get("max_sources_per_fact").status === "non_compliant" && isDeepStrictEqual(get("max_sources_per_fact").facts, [1]), "limite par fait");
  assert(get("allow_unsourced_claims").status === "warning" && isDeepStrictEqual(get("allow_unsourced_claims").facts, [0, 2]), "faits non sourcés");
  assert(get("minimum_sources").status === "non_compliant" && report.status === "non_compliant", "minimum");
  const many = { key_facts: Array.from({ length: 16 }, (_, index) => ({ claim: `${index}`, verification_status: "verified", sources: [goodSource(100 + index, "primary")] })) };
  const big = evaluateSourcePolicy(many);
  assert(big.checks.find(check => check.rule === "maximum_sources").status === "non_compliant", "maximum");
  assert(big.checks.find(check => check.rule === "preferred_source_types").status === "compliant", "primaires");
});

await test("Truth Report (E1) : la politique est rapportée, jamais bloquante ; dossier transmis inchangé", () => {
  const truth = buildTruthReport({ research: fixtureDossier, title: CANONICAL_TITLE });
  assert(truth.policy_checks.status === "non_compliant" && truth.stop.stopped === false && truth.rejected_count === 0, "arrêt ou rejet");
  assert(truth.facts.every(fact => fact.truth_status === "retained"), "fait rejeté");
  assert(isDeepStrictEqual(truth.research_dossier, fixtureDossier), "dossier modifié");
  assert(renderTruthMarkdown(truth).includes("Politique des sources : non conforme (rapport seulement"), "Markdown");
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
