// Smoke R28.4 — Classification narrative de la frontière (baseline v1.0.1,
// 4.4), zéro API. Vérifie la version publique et le registre v0 figé, les
// tests obligatoires par entrée (section 9), le corpus factuel, les
// invariants I1, I3, I4, I5, I7, I11, I12, la traçabilité, l'échec fermé, le
// déterminisme, l'idempotence, et des mutations avec témoin (copies hors
// dépôt, reproductibles depuis ce smoke).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-classification-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepStrictEqual, throws } from "node:assert/strict";

import {
  CLASSIFICATION_DECISION,
  CLASSIFICATION_STATUS,
  COVERAGE_CLASSIFICATION_LANGUAGE,
  COVERAGE_CLASSIFICATION_RULES_VERSION,
  REGISTRY_ENTRY_STATES,
  REGISTRY_FAMILIES,
  classifyCoverageUnit,
  coverageClassificationVersion,
  matchRegistryEntries
} from "../src/utils/coverage-classification.js";
import { normalizeCoverageText } from "../src/utils/coverage-normalization.js";
import {
  coverageProtectionVersion,
  extractResearchEntities,
  protectCoverageUnit
} from "../src/utils/coverage-protection.js";
import {
  coverageUnitSplitterVersion,
  splitCoverageUnits
} from "../src/utils/coverage-unit-splitter.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

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

// Version publique écrite en clair : elle fige le contenu du registre v0.
const V1 =
  "coverage-classification.v1+registry.8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37";
const REGISTRY_SHA256 = "8a48563e9b8b1a78bb8c070c6e8525972767f5c950d9b9c1eaefe8dfda559e37";
const NORMALIZATION = "coverage-normalization.v1";

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));

const REGISTRY_TEXT = fs.readFileSync(new URL("../config/coverage/classification-registry.v0.json", import.meta.url), "utf8");
const REGISTRY = JSON.parse(REGISTRY_TEXT);
const NO_ENTITIES = extractResearchEntities({ keyFacts: [], ruleVersion: "research-entities.v1" });
const SYDNEY = extractResearchEntities({ keyFacts: ["La ville de Sydney grandit."], ruleVersion: "research-entities.v1" });

// Chaîne amont réelle pour une unité construite à la main.
const unitOf = text => ({ id: "u1", rank: 1, type: "phrase", start: 0, end: text.length, text });
function inputs(text, entities = NO_ENTITIES) {
  const unit = unitOf(text);
  return {
    unit,
    normalization: normalizeCoverageText(text, NORMALIZATION),
    protection: protectCoverageUnit({ unit, version: coverageProtectionVersion(), entities })
  };
}
const classify = (text, entities, module = { classifyCoverageUnit }, version = V1) =>
  module.classifyCoverageUnit({ ...inputs(text, entities), version });

// Fragments qui ajoutent chacun un signal de Protection (section 9).
const SIGNAL_FRAGMENTS = [
  ["digit", " 3"], ["quantity_word", " deux"], ["vague_quantifier", " beaucoup"],
  ["comparative", " plus"], ["structural_punctuation", " :"], ["direct_quotation", " «"],
  ["typographic_proper_noun", " Uluru"], ["research_entity", " sydney"],
  ["attribution_marker", " selon"], ["temporal_expression", " hier"]
];
const withBeforeTerminal = (text, fragment) => {
  const match = text.match(/[.!?…]+$/);
  return match ? `${text.slice(0, match.index)}${fragment}${match[0]}` : `${text}${fragment}`;
};

// Corpus factuel de non-régression : aucune unité ne doit être exclue.
const FACTUAL_CORPUS = [
  "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.",
  "La population australienne est fortement concentrée dans les grandes zones urbaines et côtières.",
  "D'après les éléments disponibles, qui restent à vérifier, une grande partie du territoire australien serait aride.",
  "L'eau y est rare.",
  "Ces conditions expliquent pourquoi ces régions restent peu peuplées.",
  "Les précipitations y sont très faibles.",
  "Le bassin couvre environ un million de kilomètres carrés.",
  "Sans lui, l’intérieur serait inhabitable.",
  "Ce n’est pas un hasard.",
  "Mais avant cela, un détour.",
  "Le sol est pauvre.",
  "La côte est humide.",
  "Le centre reste vide.",
  "Les villes bordent la mer.",
  "Le désert avance.",
  "La terre est rouge.",
  "Les rivières disparaissent l’été.",
  "Les températures montent vite.",
  "Le vent sèche les plaines.",
  "La végétation est clairsemée.",
  "Imaginez une région où la pluie ne tombe presque jamais.",
  "Et pourtant, la région était fertile.",
  "Regardez la carte du centre du pays.",
  "Continuons vers la côte ouest du pays.",
  "Passons au climat de la région centrale."
];

await test("version publique : règles v1 + empreinte SHA-256 du registre", () => {
  deepStrictEqual(COVERAGE_CLASSIFICATION_RULES_VERSION, "coverage-classification.v1");
  deepStrictEqual(COVERAGE_CLASSIFICATION_LANGUAGE, "fr");
  deepStrictEqual(coverageClassificationVersion(), V1);
  deepStrictEqual(sha256(JSON.stringify(REGISTRY)), REGISTRY_SHA256);
  deepStrictEqual(V1, `coverage-classification.v1+registry.${REGISTRY_SHA256}`);
  const result = classify("Le désert avance.");
  deepStrictEqual([result.version, result.registry_version, result.registry_sha256], [V1, "v0", REGISTRY_SHA256]);
});

await test("registre v0 : formes génériques héritées seulement, triées, bornées (I11)", () => {
  deepStrictEqual(Object.keys(REGISTRY), ["registry", "version", "language", "slot_max_bound", "entries"]);
  deepStrictEqual([REGISTRY.registry, REGISTRY.version, REGISTRY.language, REGISTRY.slot_max_bound], ["coverage-classification-registry", "v0", "fr", 3]);
  deepStrictEqual(REGISTRY.entries.length, 26);
  const families = {};
  for (const entry of REGISTRY.entries) families[entry.family] = (families[entry.family] ?? 0) + 1;
  deepStrictEqual(families, { engagement: 12, question: 1, transition: 13 });
  REGISTRY.entries.forEach((entry, index) => {
    if (index > 0 && !(REGISTRY.entries[index - 1].id < entry.id)) throw new Error(`ordre : ${entry.id}`);
    deepStrictEqual([entry.state, entry.origin], ["admitted", "inherited"]);
    for (const part of entry.pattern) if (part.slot && !(part.slot.max >= 1 && part.slot.max <= 3)) throw new Error(`borne : ${entry.id}`);
    if (entry.counter_examples.length < 3) throw new Error(`contre-exemples : ${entry.id}`);
  });
  deepStrictEqual([...REGISTRY_ENTRY_STATES], ["observed", "candidate", "admitted", "suspended", "retired"]);
  deepStrictEqual([...REGISTRY_FAMILIES], ["question", "engagement", "transition"]);
});

await test("registre v0 : aucune forme propre à 842035, aucune forme protégée retenue", () => {
  const fixedForms = REGISTRY.entries
    .filter(entry => entry.pattern.every(part => part.word))
    .map(entry => entry.pattern.map(part => part.word).join(" "));
  for (const form of ["ou plutot son absence", "mais avant cela un detour", "avant cela un detour", "tout change ici", "allons plus loin"]) {
    if (fixedForms.includes(form)) throw new Error(`forme interdite : ${form}`);
  }
});

await test("exemple de la baseline (section 11) : u1 à u4 analysées (u1 absente du v0, u2 protégée)", () => {
  const text = "Mais avant cela, un détour. Le bassin couvre environ un million de kilomètres carrés. Ce n’est pas un hasard. Sans lui, l’intérieur serait inhabitable.";
  const units = splitCoverageUnits({ voiceover: text, version: coverageUnitSplitterVersion(), language: "fr" }).units;
  const results = units.map(unit => classifyCoverageUnit({
    unit,
    normalization: normalizeCoverageText(unit.text, NORMALIZATION),
    protection: protectCoverageUnit({ unit, version: coverageProtectionVersion(), entities: NO_ENTITIES }),
    version: V1
  }));
  deepStrictEqual(results.map(item => item.decision), ["ELIGIBLE", "ELIGIBLE", "ELIGIBLE", "ELIGIBLE"]);
  deepStrictEqual(results.map(item => item.reason), [null, "unité protégée", null, null]);
  deepStrictEqual(results.map(item => item.unit_id), ["u1", "u2", "u3", "u4"]);
});

for (const entry of REGISTRY.entries) {
  await test(`entrée ${entry.id} : positifs exclus et non protégés (I12), contre-exemples, signaux, proposition`, () => {
    for (const positive of entry.positives) {
      const { protection } = inputs(positive);
      if (protection.protected) throw new Error(`positif protégé (I12) : ${positive}`);
      const result = classify(positive);
      deepStrictEqual([result.decision, result.entry_id, result.entry_family], ["EXCLUDED", entry.id, entry.family], positive);
      for (const [signal, fragment] of SIGNAL_FRAGMENTS) {
        const text = withBeforeTerminal(positive, fragment);
        const entities = signal === "research_entity" ? SYDNEY : NO_ENTITIES;
        const withSignal = classify(text, entities);
        const signals = inputs(text, entities).protection.signals.map(item => item.signal);
        if (!signals.includes(signal)) throw new Error(`signal ${signal} absent de « ${text} »`);
        deepStrictEqual([withSignal.decision, withSignal.reason], ["ELIGIBLE", "unité protégée"], text);
      }
      const followed = withBeforeTerminal(positive, ", et la terre est sèche");
      deepStrictEqual(classify(followed).decision, "ELIGIBLE", followed);
    }
    for (const counter of entry.counter_examples) {
      deepStrictEqual(classify(counter).decision, "ELIGIBLE", counter);
    }
  });
}

await test("corpus factuel : aucune exclusion", () => {
  for (const text of FACTUAL_CORPUS) {
    const result = classify(text);
    if (result.decision !== "ELIGIBLE" || result.status !== "OK") throw new Error(`exclusion : ${text}`);
  }
});

await test("I1, I3 : une unité protégée est toujours ELIGIBLE ; seules ELIGIBLE et EXCLUDED existent", () => {
  deepStrictEqual(Object.values(CLASSIFICATION_DECISION), ["ELIGIBLE", "EXCLUDED"]);
  const texts = [...FACTUAL_CORPUS, ...REGISTRY.entries.flatMap(entry => [...entry.positives, ...entry.counter_examples])];
  for (const text of texts) {
    const { protection } = inputs(text);
    const result = classify(text);
    if (!["ELIGIBLE", "EXCLUDED"].includes(result.decision)) throw new Error(`décision inconnue : ${result.decision}`);
    if (protection.protected && result.decision !== "ELIGIBLE") throw new Error(`unité protégée exclue : ${text}`);
  }
});

await test("I7 : l'ordre des entrées est sans effet (toutes permutations testées)", () => {
  const words = ["pourquoi", "donc"];
  const entries = [
    { id: "b.second", state: "admitted", terminal: ["?"], pattern: [{ slot: { min: 1, max: 3 } }] },
    { id: "a.first", state: "admitted", terminal: null, pattern: [{ word: "pourquoi" }, { slot: { min: 0, max: 1 } }] },
    { id: "c.third", state: "candidate", terminal: null, pattern: [{ slot: { min: 1, max: 3 } }] },
    { id: "d.fourth", state: "admitted", terminal: ["."], pattern: [{ slot: { min: 1, max: 3 } }] }
  ];
  const permutations = list => list.length <= 1 ? [list] : list.flatMap((item, index) =>
    permutations([...list.slice(0, index), ...list.slice(index + 1)]).map(rest => [item, ...rest]));
  for (const order of permutations(entries)) {
    deepStrictEqual(matchRegistryEntries({ words, terminal: "?", entries: order }), ["a.first", "b.second"]);
  }
  // Registre v0 réel : « Voyons cela ? » est reconnue par deux entrées ; la
  // plus petite est retenue, quel que soit l’ordre d’évaluation.
  const both = classify("Voyons cela ?");
  deepStrictEqual([both.decision, both.entry_id, both.entry_family], ["EXCLUDED", "engagement.voyons", "engagement"]);
  const words2 = inputs("Voyons cela ?").normalization.words.map(word => word.normalized);
  deepStrictEqual(matchRegistryEntries({ words: words2, terminal: "?", entries: [...REGISTRY.entries].reverse() }), ["engagement.voyons", "question.short"]);
});

// Copie isolée hors dépôt : module et registre au contenu donné (null =
// absent), avec une mutation textuelle facultative du module.
async function isolatedClassification(prefix, registryText, mutation = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(root, "config", "coverage"), { recursive: true });
  let source = fs.readFileSync(new URL("../src/utils/coverage-classification.js", import.meta.url), "utf8");
  if (mutation) {
    if (source.split(mutation.from).length !== 2) throw new Error(`mutation non applicable : ${mutation.from}`);
    source = source.replace(mutation.from, mutation.to);
  }
  fs.writeFileSync(path.join(root, "src", "utils", "coverage-classification.js"), source);
  if (registryText !== null) fs.writeFileSync(path.join(root, "config", "coverage", "classification-registry.v0.json"), registryText);
  const module = await import(new URL(`file://${path.join(root, "src", "utils", "coverage-classification.js")}`));
  return { root, module };
}
const cleanup = root => fs.rmSync(root, { recursive: true, force: true });
const registryWith = change => JSON.stringify(change(structuredClone(REGISTRY)), null, 2);

await test("I4 : registre vide → aucune exclusion (copie hors dépôt)", async () => {
  const { root, module } = await isolatedClassification("r28-4-empty-", registryWith(registry => ({ ...registry, entries: [] })));
  try {
    const version = module.coverageClassificationVersion();
    if (!version || version === V1) throw new Error("version du registre vide attendue");
    for (const entry of REGISTRY.entries) {
      for (const positive of entry.positives) {
        const result = classify(positive, NO_ENTITIES, module, version);
        deepStrictEqual([result.status, result.decision], ["OK", "ELIGIBLE"], positive);
      }
    }
  } finally {
    cleanup(root);
  }
});

await test("I5 : une entrée ajoutée ne touche jamais une unité protégée ni ne retire une exclusion", async () => {
  const augmented = registryWith(registry => ({
    ...registry,
    entries: [...registry.entries, {
      id: "transition.zz-allons-plus-loin", state: "admitted", origin: "inherited", family: "transition",
      pattern: [{ word: "allons" }, { word: "plus" }, { word: "loin" }], terminal: null,
      positives: ["Allons plus loin."],
      counter_examples: ["Allons plus loin vers le centre.", "Allons plus loin dans le désert rouge.", "Allons plus loin sur la côte est."]
    }]
  }));
  const { root, module } = await isolatedClassification("r28-4-monotony-", augmented);
  try {
    const version = module.coverageClassificationVersion();
    const protectedResult = classify("Allons plus loin.", NO_ENTITIES, module, version);
    deepStrictEqual([protectedResult.decision, protectedResult.reason], ["ELIGIBLE", "unité protégée"]);
    for (const entry of REGISTRY.entries) {
      for (const positive of entry.positives) deepStrictEqual(classify(positive, NO_ENTITIES, module, version).decision, "EXCLUDED", positive);
    }
    for (const text of FACTUAL_CORPUS) deepStrictEqual(classify(text, NO_ENTITIES, module, version).decision, "ELIGIBLE", text);
  } finally {
    cleanup(root);
  }
});

await test("déterminisme et idempotence : mêmes entrées → même sortie, deux classements identiques", () => {
  const texts = [...FACTUAL_CORPUS, ...REGISTRY.entries.flatMap(entry => entry.positives)];
  const first = texts.map(text => JSON.stringify(classify(text)));
  classify("Autre texte : 12 villes.");
  for (let round = 0; round < 3; round += 1) deepStrictEqual(texts.map(text => JSON.stringify(classify(text))), first);
  for (const text of texts) {
    const input = { ...inputs(text), version: V1 };
    deepStrictEqual(plain(classifyCoverageUnit(input)), plain(classifyCoverageUnit(input)));
  }
});

await test("traçabilité : versions et empreintes amont reprises exactement, divergence détectée", () => {
  const { unit, normalization, protection } = inputs("La ville de Sydney grandit.", SYDNEY);
  const result = classifyCoverageUnit({ unit, normalization, protection, version: V1 });
  const expected = {
    normalization_version: normalization.version,
    protection_version: protection.version,
    entities_rule_version: protection.entities_rule_version,
    entities_fingerprint: protection.entities_fingerprint
  };
  deepStrictEqual(plain(result.upstream), expected);
  deepStrictEqual(Object.keys(result), ["version", "registry_version", "registry_sha256", "upstream", "unit_id", "status", "reason", "decision", "entry_id", "entry_family"]);
  deepStrictEqual([result.version, result.registry_sha256, result.unit_id], [V1, REGISTRY_SHA256, "u1"]);
  throws(() => deepStrictEqual(plain(result.upstream), { ...expected, entities_fingerprint: NO_ENTITIES.fingerprint }));
  throws(() => deepStrictEqual(result.registry_sha256, "0".repeat(64)));
});

await test("refus explicite : version absente ou divergente → DEGRADED, ELIGIBLE", () => {
  for (const version of [undefined, null, "", "coverage-classification.v1", `${V1}x`, `coverage-classification.v1+registry.${"0".repeat(64)}`]) {
    const result = classifyCoverageUnit({ ...inputs("Pourquoi ?"), version });
    deepStrictEqual([result.status, result.decision, result.entry_id], ["DEGRADED", "ELIGIBLE", null]);
    if (!result.reason.startsWith("version inconnue")) throw new Error(result.reason);
  }
});

await test("refus explicite : protection absente ou incohérente → DEGRADED, ELIGIBLE", () => {
  const base = inputs("Pourquoi ?");
  const variants = [
    undefined,
    null,
    { ...base.protection, unit_id: "u2" },
    { ...base.protection, protected: true },
    { ...base.protection, status: "DEGRADED", protected: false },
    { ...base.protection, signals: undefined },
    { ...base.protection, status: "INCONNU" }
  ];
  for (const protection of variants) {
    const result = classifyCoverageUnit({ ...base, protection, version: V1 });
    deepStrictEqual([result.status, result.decision, result.reason], ["DEGRADED", "ELIGIBLE", "protection absente ou incohérente"]);
  }
});

await test("refus explicite : normalisation absente ou incohérente → DEGRADED, ELIGIBLE", () => {
  const base = inputs("Pourquoi donc ?");
  const words = base.normalization.words;
  const variants = [
    undefined,
    { ...base.normalization, version: "coverage-normalization.v2" },
    { ...base.normalization, words: [{ ...words[0], original: "Comment" }, words[1]] },
    { ...base.normalization, words: [words[1], words[0]] },
    { ...base.normalization, words: [{ ...words[0], normalized: "Pourquoi" }, words[1]] },
    { ...base.normalization, words: [{ ...words[0], end: 999 }, words[1]] }
  ];
  for (const normalization of variants) {
    const result = classifyCoverageUnit({ ...base, normalization, version: V1 });
    deepStrictEqual([result.status, result.decision, result.reason], ["DEGRADED", "ELIGIBLE", "normalisation absente ou incohérente"]);
  }
});

await test("refus explicite : unité invalide → exception", () => {
  for (const unit of [undefined, null, {}, { id: "x1", text: "Pourquoi ?" }, { id: "u1", text: "" }]) {
    throws(() => classifyCoverageUnit({ unit, normalization: null, protection: null, version: V1 }), /Coverage Classification : unité invalide/);
  }
});

for (const [name, content] of [
  ["registre absent", null],
  ["JSON invalide", '{ "registry": "coverage-classification-registry", "entries": ['],
  ["registre non trié", registryWith(registry => ({ ...registry, entries: [...registry.entries].reverse() }))],
  ["borne d'emplacement > 3 (I11)", registryWith(registry => {
    registry.entries.find(entry => entry.id === "question.short").pattern[0].slot.max = 4;
    return registry;
  })],
  ["état d'entrée inconnu", registryWith(registry => { registry.entries[0].state = "active"; return registry; })],
  ["moins de trois contre-exemples", registryWith(registry => { registry.entries[0].counter_examples.pop(); return registry; })],
  ["identifiant dupliqué", registryWith(registry => { registry.entries[1].id = registry.entries[0].id; return registry; })]
]) {
  await test(`échec fermé : ${name} → version nulle, DEGRADED, aucune exclusion (copie hors dépôt)`, async () => {
    const { root, module } = await isolatedClassification("r28-4-registry-", content);
    try {
      deepStrictEqual(module.coverageClassificationVersion(), null);
      const result = classify("Pourquoi ?", NO_ENTITIES, module, V1);
      deepStrictEqual(
        [result.status, result.decision, result.reason, result.version, result.registry_sha256],
        ["DEGRADED", "ELIGIBLE", "registre indisponible", null, null]
      );
    } finally {
      cleanup(root);
    }
  });
}

await test("échec fermé : registre modifié → empreinte différente, ancienne version refusée (copie hors dépôt)", async () => {
  const modified = registryWith(registry => { registry.entries[0].positives = ["Découvrons-la."]; return registry; });
  const { root, module } = await isolatedClassification("r28-4-modified-", modified);
  try {
    const version = module.coverageClassificationVersion();
    deepStrictEqual(version, `coverage-classification.v1+registry.${sha256(JSON.stringify(JSON.parse(modified)))}`);
    if (version === V1) throw new Error("empreinte inchangée");
    const refused = classify("Pourquoi ?", NO_ENTITIES, module, V1);
    deepStrictEqual([refused.status, refused.decision], ["DEGRADED", "ELIGIBLE"]);
    if (!refused.reason.startsWith("version inconnue")) throw new Error(refused.reason);
  } finally {
    cleanup(root);
  }
});

// Comportements de référence vérifiés sur une copie témoin puis sur chaque
// mutant ; un mutant doit en faire échouer au moins un.
function behaviourFailures(module, version) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(label);
  };
  const decide = (text, overrides = {}) => {
    try {
      const result = module.classifyCoverageUnit({ ...inputs(text), version, ...overrides });
      return [result.status, result.decision, result.entry_id];
    } catch (error) {
      return ["EXCEPTION", error.message];
    }
  };
  const base = inputs("Imaginez la scène.");
  check("question courte exclue", decide("Pourquoi ?"), ["OK", "EXCLUDED", "question.short"]);
  check("plus petit identifiant retenu (I7)", decide("Voyons cela ?"), ["OK", "EXCLUDED", "engagement.voyons"]);
  check("ponctuation finale exigée", decide("Pourquoi donc."), ["OK", "ELIGIBLE", null]);
  check("unité complète exigée", decide("Et pourtant, la terre est sèche."), ["OK", "ELIGIBLE", null]);
  check("défaut ELIGIBLE", decide("Le désert avance."), ["OK", "ELIGIBLE", null]);
  check("version divergente refusée", decide("Pourquoi ?", { version: `${version}x` }), ["DEGRADED", "ELIGIBLE", null]);
  check(
    "unité protégée jamais exclue",
    decide("Imaginez la scène.", { protection: { ...base.protection, protected: true, signals: [{ signal: "digit", matches: [] }] } }),
    ["OK", "ELIGIBLE", null]
  );
  const question = inputs("Pourquoi ?");
  check(
    "protection incohérente : aucune exclusion",
    decide("Pourquoi ?", { protection: { ...question.protection, unit_id: "u2" } }),
    ["DEGRADED", "ELIGIBLE", null]
  );
  return failures;
}

const MUTATIONS = [
  ["protection ignorée", { from: "if (protection.protected) {", to: "if (false) {" }],
  ["ponctuation finale ignorée", { from: "entry.terminal === null || entry.terminal.includes(terminal)", to: "true" }],
  ["correspondance partielle acceptée", { from: "if (partIndex === pattern.length) return wordIndex === words.length;", to: "if (partIndex === pattern.length) return true;" }],
  ["version non vérifiée", { from: "if (version !== REGISTRY.version) {", to: "if (false) {" }],
  ["plus grand identifiant retenu", { from: "entryId: matches[0]", to: "entryId: matches.at(-1)" }],
  ["tri des correspondances supprimé", { from: ".map(entry => entry.id)\n    .sort();", to: ".map(entry => entry.id).reverse();" }],
  ["dégradé qui exclut", { from: "    decision: CLASSIFICATION_DECISION.ELIGIBLE\n  });\n\n// Classe", to: "    decision: CLASSIFICATION_DECISION.EXCLUDED\n  });\n\n// Classe" }],
  ["cohérence de protection non vérifiée", { from: "if (!coherentProtection(unit, protection)) {", to: "if (false) {" }]
];

await test("mutations : témoin valide, chaque mutant détecté (copies hors dépôt)", async () => {
  const control = await isolatedClassification("r28-4-control-", REGISTRY_TEXT);
  try {
    deepStrictEqual(control.module.coverageClassificationVersion(), V1);
    deepStrictEqual(behaviourFailures(control.module, V1), [], "témoin");
  } finally {
    cleanup(control.root);
  }
  for (const [name, mutation] of MUTATIONS) {
    const mutant = await isolatedClassification("r28-4-mutant-", REGISTRY_TEXT, mutation);
    try {
      const version = mutant.module.coverageClassificationVersion();
      if (behaviourFailures(mutant.module, version ?? V1).length === 0) throw new Error(`mutant non détecté : ${name}`);
    } finally {
      cleanup(mutant.root);
    }
  }
  // Borne d'emplacement (I11) : le témoin refuse un registre à borne 4, le mutant l'accepterait.
  const bound4 = registryWith(registry => {
    registry.entries.find(entry => entry.id === "question.short").pattern[0].slot.max = 4;
    return registry;
  });
  const controlBound = await isolatedClassification("r28-4-control-bound-", bound4);
  const mutantBound = await isolatedClassification("r28-4-mutant-bound-", bound4, { from: "slot.max <= bound;", to: "true;" });
  try {
    deepStrictEqual(controlBound.module.coverageClassificationVersion(), null);
    if (mutantBound.module.coverageClassificationVersion() === null) throw new Error("mutant de borne non détecté");
  } finally {
    cleanup(controlBound.root);
    cleanup(mutantBound.root);
  }
});

await test("indépendance : aucun import d'un autre composant, aucune lecture du Research, des claims ou des verdicts", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-classification.js", import.meta.url), "utf8");
  deepStrictEqual(source.split("\n").filter(line => line.startsWith("import ")), [
    'import crypto from "node:crypto";',
    'import fs from "node:fs";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n").toLowerCase();
  for (const forbidden of ["research", "key_fact", "keyfacts", "claim", "verdict", "judge", "juge", "repair", "prompt", "normalizecoveragetext", "protectcoverageunit", "splitcoverageunits", "extractresearchentities"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
});

await test("sortie immuable", () => {
  const result = classify("Pourquoi ?");
  if (!Object.isFrozen(result) || !Object.isFrozen(result.upstream)) throw new Error("sortie modifiable");
});

await test("aucune dépendance à la plateforme dans le module (hors commentaires)", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-classification.js", import.meta.url), "utf8")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["normalize(", "Intl", "localeCompare", "toLowerCase", "toUpperCase", "toLocale", "\\p{", "/u", "\\s"]) {
    if (source.includes(forbidden)) throw new Error(`usage interdit : ${forbidden}`);
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-classification-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
