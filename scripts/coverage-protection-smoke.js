// Smoke R28.3 — Protection de la frontière (baseline v1.0.1, 4.3), zéro API.
// Vérifie la version publique et les lexiques figés, les dix signaux, la
// règle d'extraction des entités Research et son empreinte, l'indépendance
// vis-à-vis du registre (I2), la monotonie (I5), l'échec fermé (I15,
// section 7) et le déterminisme (I18).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-protection-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepStrictEqual, throws } from "node:assert/strict";

import {
  COVERAGE_PROTECTION_LANGUAGE,
  COVERAGE_PROTECTION_RULES_VERSION,
  PROTECTION_SIGNALS,
  PROTECTION_STATUS,
  RESEARCH_ENTITY_RULE_VERSION,
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

// Version publique écrite en clair : elle fige le contenu des lexiques.
const V1 =
  "coverage-protection.v1+lexicons.2fceab4a226b21fbfcd2107e85752c827aae4eac5e4d5e0c3ec3c7573e598f24";
const RULE = "research-entities.v1";

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));

const KEY_FACTS = [
  "La population australienne est concentrée à Sydney, Melbourne et Brisbane.",
  "Le bassin du lac Eyre couvre environ un million de kilomètres carrés.",
  "Australie : la Grande Barrière de corail longe le Queensland.",
  "La Nouvelle-Galles du Sud est peuplée."
];
const ENTITIES = extractResearchEntities({ keyFacts: KEY_FACTS, ruleVersion: RULE });
const NO_ENTITIES = extractResearchEntities({ keyFacts: [], ruleVersion: RULE });

// Unité de découpeur construite à la main (texte seul).
const unitOf = (text, rank = 1) => ({ id: `u${rank}`, rank, type: "phrase", start: 0, end: text.length, text });
const protect = (text, entities = ENTITIES) => protectCoverageUnit({ unit: unitOf(text), version: V1, entities });
const signalsOf = (text, entities) => protect(text, entities).signals.map(item => item.signal);

// R28.3A — traçabilité : la sortie reprend exactement la règle et l’empreinte
// de la liste d’entités validée en entrée (null si aucune n’a été validée).
function assertTrace(result, entities) {
  deepStrictEqual(Object.keys(result).slice(0, 3), ["version", "entities_rule_version", "entities_fingerprint"]);
  deepStrictEqual(result.entities_rule_version, entities ? entities.rule_version : null);
  deepStrictEqual(result.entities_fingerprint, entities ? entities.fingerprint : null);
}

await test("version publique : règles v1 + empreinte du contenu des lexiques", () => {
  deepStrictEqual(COVERAGE_PROTECTION_RULES_VERSION, "coverage-protection.v1");
  deepStrictEqual(RESEARCH_ENTITY_RULE_VERSION, RULE);
  deepStrictEqual(COVERAGE_PROTECTION_LANGUAGE, "fr");
  deepStrictEqual(coverageProtectionVersion(), V1);
  const data = JSON.parse(fs.readFileSync(new URL("../config/coverage/protection-lexicons.fr.json", import.meta.url), "utf8"));
  deepStrictEqual(V1, `coverage-protection.v1+lexicons.${sha256(JSON.stringify(data))}`);
  deepStrictEqual(protect("Un texte.").version, V1);
});

await test("lexiques : cinq catégories, entrées triées, uniques, en mots normalisés", () => {
  const data = JSON.parse(fs.readFileSync(new URL("../config/coverage/protection-lexicons.fr.json", import.meta.url), "utf8"));
  deepStrictEqual(Object.keys(data), [
    "language", "quantity_words", "vague_quantifiers", "comparatives", "attribution_markers", "temporal_expressions"
  ]);
  deepStrictEqual(
    Object.fromEntries(Object.entries(data).filter(([key]) => key !== "language").map(([key, list]) => [key, list.length])),
    { quantity_words: 70, vague_quantifiers: 38, comparatives: 29, attribution_markers: 50, temporal_expressions: 38 }
  );
  for (const [key, list] of Object.entries(data)) {
    if (key === "language") continue;
    list.forEach((entry, index) => {
      if (!/^[a-z0-9]+( [a-z0-9]+)*$/.test(entry)) throw new Error(`${key} : entrée invalide « ${entry} »`);
      if (index > 0 && !(list[index - 1] < entry)) throw new Error(`${key} : ordre ou doublon en « ${entry} »`);
    });
  }
});

await test("signaux : liste fermée des dix signaux de la baseline", () => {
  deepStrictEqual([...PROTECTION_SIGNALS], [
    "digit", "quantity_word", "vague_quantifier", "comparative", "structural_punctuation",
    "direct_quotation", "typographic_proper_noun", "research_entity", "attribution_marker", "temporal_expression"
  ]);
  if (!Object.isFrozen(PROTECTION_SIGNALS)) throw new Error("liste modifiable");
});

await test("exemple de la baseline (section 11) : seule u2 est protégée", () => {
  const text = "Mais avant cela, un détour. Le bassin couvre environ un million de kilomètres carrés. Ce n’est pas un hasard. Sans lui, l’intérieur serait inhabitable.";
  const units = splitCoverageUnits({ voiceover: text, version: coverageUnitSplitterVersion(), language: "fr" }).units;
  const results = units.map(unit => protectCoverageUnit({ unit, version: V1, entities: NO_ENTITIES }));
  deepStrictEqual(results.map(item => item.protected), [false, true, false, false]);
  deepStrictEqual(results.map(item => item.unit_id), ["u1", "u2", "u3", "u4"]);
  for (const item of results) assertTrace(item, NO_ENTITIES);
  deepStrictEqual(results[1].signals.map(item => item.signal), ["quantity_word", "vague_quantifier"]);
  deepStrictEqual(results[1].signals.map(item => item.matches.map(entry => entry.text)), [["million"], ["environ"]]);
});

const SIGNAL_CASES = [
  ["chiffre", "La zone compte 3 villes.", ["digit"]],
  ["exposant", "La surface est en km².", ["digit"]],
  ["indice", "Le gaz CO₂ domine.", ["digit", "typographic_proper_noun"]],
  ["fraction", "Il en reste ½ aujourd’hui.", ["digit", "temporal_expression"]],
  ["quantité en lettres", "Il y a deux saisons.", ["quantity_word"]],
  ["ordinal", "C’est la première étape.", ["quantity_word"]],
  ["quantificateur vague", "Beaucoup partent vers les côtes.", ["vague_quantifier"]],
  ["comparatif", "La côte est plus humide.", ["comparative"]],
  ["superlatif", "C’est la meilleure période.", ["comparative"]],
  ["deux-points", "Le constat est simple : la terre est sèche.", ["structural_punctuation"]],
  ["point-virgule", "La terre est sèche ; le ciel est clair.", ["structural_punctuation"]],
  ["parenthèse", "La plaine (immense) s’étend.", ["structural_punctuation"]],
  ["citation directe", "On l’appelle « le cœur rouge ».", ["direct_quotation"]],
  ["guillemets droits", "On l’appelle \"le cœur rouge\".", ["direct_quotation"]],
  ["nom propre hors première position", "On rejoint ensuite Alice Springs.", ["typographic_proper_noun"]],
  ["nom propre après élision", "L’Australie paraît vide.", ["typographic_proper_noun"]],
  ["question avec nom propre : protégée", "Pourquoi l’Australie paraît-elle vide ?", ["typographic_proper_noun"]],
  ["entité Research en minuscules", "La ville de sydney grandit.", ["research_entity"]],
  ["entité Research multi-mots", "La grande barrière s’étend.", ["research_entity"]],
  ["marqueur d’attribution", "Selon les habitants, la terre change.", ["attribution_marker"]],
  ["marqueur d’attribution multi-mots", "D’après les habitants, la terre change.", ["attribution_marker"]],
  ["expression temporelle", "Le climat a changé depuis longtemps.", ["temporal_expression"]],
  ["expression temporelle multi-mots", "Au moyen âge, la côte était vide.", ["temporal_expression"]],
  ["première position non comptée", "Sydney grandit vite.", ["research_entity"]],
  ["aucun signal", "Le désert reste silencieux.", []],
  ["transition sans signal", "Mais avant cela, un détour.", []],
  ["interpellation sans signal", "Imaginez une plaine sans fin.", []],
  ["entité partielle non comptée", "Une grande plaine s’étend.", []]
];

for (const [name, text, expected] of SIGNAL_CASES) {
  await test(`signal — ${name}`, () => {
    const result = protect(text);
    deepStrictEqual(result.status, PROTECTION_STATUS.OK);
    assertTrace(result, ENTITIES);
    deepStrictEqual(result.signals.map(item => item.signal), expected);
    deepStrictEqual(result.protected, expected.length > 0);
    for (const item of result.signals) {
      for (const entry of item.matches) deepStrictEqual(text.slice(entry.start, entry.end), entry.text);
    }
  });
}

await test("extraction des entités : règle v1 figée (hors premier mot, virgule sépare, trait d’union joint)", () => {
  deepStrictEqual([...ENTITIES.entities], [
    "brisbane", "eyre", "grande barriere", "melbourne", "nouvelle galles", "queensland", "sud", "sydney"
  ]);
  deepStrictEqual(ENTITIES.rule_version, RULE);
  deepStrictEqual(ENTITIES.fingerprint, sha256(JSON.stringify({ rule_version: RULE, entities: [...ENTITIES.entities] })));
  deepStrictEqual(ENTITIES.fingerprint, "e55a0d68935aaf8196174079eb1f2a22573eff085a9b046b1c9d8d98bbbbbd49");
  deepStrictEqual([...NO_ENTITIES.entities], []);
});

await test("extraction des entités : déterministe, indépendante de l’ordre et des doublons", () => {
  const reversed = extractResearchEntities({ keyFacts: [...KEY_FACTS].reverse(), ruleVersion: RULE });
  const doubled = extractResearchEntities({ keyFacts: [...KEY_FACTS, ...KEY_FACTS], ruleVersion: RULE });
  deepStrictEqual(plain(reversed), plain(ENTITIES));
  deepStrictEqual(plain(doubled), plain(ENTITIES));
});

await test("extraction des entités : règle divergente refusée, entrée invalide refusée", () => {
  for (const ruleVersion of [undefined, "research-entities.v2", ""]) {
    throws(() => extractResearchEntities({ keyFacts: KEY_FACTS, ruleVersion }), /règle d'extraction .* refusée — règle disponible research-entities\.v1/);
  }
  for (const keyFacts of [undefined, "Sydney", [1], [null]]) {
    throws(() => extractResearchEntities({ keyFacts, ruleVersion: RULE }), /keyFacts invalide/);
  }
});

const UPPER_EXPECTED = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸÆŒ");
const DIGITS_EXPECTED = new Set("0123456789⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞");
const STRUCT_EXPECTED = new Set(":;()");
const QUOTES_EXPECTED = new Set("«»“”„\"‹›");

await test("classes de caractères figées : balayage exhaustif de U+0000 à U+10FFFF", () => {
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    const expected = [];
    if (DIGITS_EXPECTED.has(character)) expected.push("digit");
    if (STRUCT_EXPECTED.has(character)) expected.push("structural_punctuation");
    if (QUOTES_EXPECTED.has(character)) expected.push("direct_quotation");
    if (UPPER_EXPECTED.has(character)) expected.push("typographic_proper_noun");
    const got = signalsOf(`le ${character} mot`, NO_ENTITIES);
    if (got.join(",") !== expected.join(",")) {
      throw new Error(`U+${codePoint.toString(16).toUpperCase()} : attendu [${expected}], obtenu [${got}]`);
    }
  }
});

await test("déterminisme : mêmes entrées → mêmes signaux et positions, indépendamment de l’historique", () => {
  const texts = SIGNAL_CASES.map(([, text]) => text);
  const first = texts.map(text => JSON.stringify(protect(text)));
  protect("Autre texte : 12 Sydney.");
  for (let round = 0; round < 3; round += 1) deepStrictEqual(texts.map(text => JSON.stringify(protect(text))), first);
});

await test("échec fermé : version absente ou divergente → dégradé sûr, unité protégée", () => {
  for (const version of [undefined, null, "", "coverage-protection.v1", `${V1}x`, "coverage-protection.v2+lexicons.0"]) {
    const result = protectCoverageUnit({ unit: unitOf("Le désert reste silencieux."), version, entities: ENTITIES });
    deepStrictEqual(result.status, PROTECTION_STATUS.DEGRADED);
    deepStrictEqual(result.protected, true);
    if (!result.reason.startsWith("version inconnue")) throw new Error(result.reason);
    assertTrace(result, null);
  }
});

await test("échec fermé : entités absentes, falsifiées ou d’une autre règle → dégradé sûr, unité protégée", () => {
  const tampered = [
    undefined,
    null,
    {},
    { ...plain(ENTITIES), fingerprint: "0".repeat(64) },
    { ...plain(ENTITIES), entities: [...ENTITIES.entities, "uluru"] },
    { ...plain(ENTITIES), rule_version: "research-entities.v2" },
    { ...plain(ENTITIES), entities: [...ENTITIES.entities].reverse() }
  ];
  for (const entities of tampered) {
    const result = protectCoverageUnit({ unit: unitOf("Le désert reste silencieux."), version: V1, entities });
    deepStrictEqual(result.status, PROTECTION_STATUS.DEGRADED);
    deepStrictEqual(result.protected, true);
    deepStrictEqual(result.reason, "entités Research absentes ou invalides");
    assertTrace(result, null);
  }
});

await test("traçabilité (I9, I10) : règle et empreinte des entités reprises exactement, divergence détectée", () => {
  const text = "La ville de Sydney grandit.";
  const withEntities = protect(text, ENTITIES);
  const withoutEntities = protect(text, NO_ENTITIES);
  assertTrace(withEntities, ENTITIES);
  assertTrace(withoutEntities, NO_ENTITIES);
  deepStrictEqual(withEntities.entities_rule_version, "research-entities.v1");
  deepStrictEqual(withEntities.entities_fingerprint, "e55a0d68935aaf8196174079eb1f2a22573eff085a9b046b1c9d8d98bbbbbd49");
  if (withEntities.entities_fingerprint === withoutEntities.entities_fingerprint) throw new Error("empreintes confondues");
  // Une sortie confrontée à une autre liste d’entités doit échouer.
  throws(() => assertTrace(withEntities, NO_ENTITIES));
  throws(() => assertTrace(withoutEntities, ENTITIES));
  throws(() => assertTrace({ ...withEntities, entities_fingerprint: "0".repeat(64) }, ENTITIES));
  throws(() => assertTrace({ ...withEntities, entities_rule_version: "research-entities.v2" }, ENTITIES));
  throws(() => assertTrace({ ...withEntities, entities_fingerprint: undefined }, ENTITIES));
  // Le contexte de décision se reconstruit à partir de la seule sortie.
  deepStrictEqual(
    [withEntities.version, withEntities.entities_rule_version, withEntities.entities_fingerprint],
    [V1, ENTITIES.rule_version, ENTITIES.fingerprint]
  );
});

await test("unité invalide : refusée", () => {
  for (const unit of [undefined, null, {}, { text: "Un." }, { ...unitOf("Un."), id: "x1" }, { ...unitOf("Un."), end: 99 }, unitOf("")]) {
    throws(() => protectCoverageUnit({ unit, version: V1, entities: ENTITIES }), /Coverage Protection : unité invalide/);
  }
});

// Copie isolée hors dépôt : Protection, normalisation et lexiques au contenu
// donné (null = fichier absent). Le dépôt n'est jamais modifié.
async function isolatedProtection(prefix, lexicons, { normalizationVersion = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(root, "config", "coverage"), { recursive: true });
  fs.copyFileSync(new URL("../src/utils/coverage-protection.js", import.meta.url), path.join(root, "src", "utils", "coverage-protection.js"));
  let normalization = fs.readFileSync(new URL("../src/utils/coverage-normalization.js", import.meta.url), "utf8");
  if (normalizationVersion) {
    normalization = normalization.replace('"coverage-normalization.v1"', `"${normalizationVersion}"`);
  }
  fs.writeFileSync(path.join(root, "src", "utils", "coverage-normalization.js"), normalization);
  if (lexicons !== null) fs.writeFileSync(path.join(root, "config", "coverage", "protection-lexicons.fr.json"), lexicons);
  const module = await import(new URL(`file://${path.join(root, "src", "utils", "coverage-protection.js")}`));
  return { root, module };
}

const LEXICONS_TEXT = fs.readFileSync(new URL("../config/coverage/protection-lexicons.fr.json", import.meta.url), "utf8");

for (const [name, content, expectedReason] of [
  ["lexiques absents", null, "lexiques indisponibles"],
  ["JSON invalide", '{ "language": "fr", "quantity_words": [', "lexiques indisponibles"],
  ["lexiques non triés", JSON.stringify({ ...JSON.parse(LEXICONS_TEXT), comparatives: ["plus", "moins"] }), "lexiques indisponibles"],
  ["catégorie manquante", JSON.stringify({ ...JSON.parse(LEXICONS_TEXT), comparatives: undefined }), "lexiques indisponibles"]
]) {
  await test(`échec fermé : ${name} → version nulle, unité protégée (copie hors dépôt)`, async () => {
    const { root, module } = await isolatedProtection("r28-3-lexicons-", content);
    try {
      deepStrictEqual(module.coverageProtectionVersion(), null);
      const result = module.protectCoverageUnit({ unit: unitOf("Le désert reste silencieux."), version: V1, entities: ENTITIES });
      deepStrictEqual([result.status, result.protected, result.reason, result.version], ["DEGRADED", true, expectedReason, null]);
      assertTrace(result, null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

await test("échec fermé : normalisation d’une autre version → unité protégée (copie hors dépôt)", async () => {
  const { root, module } = await isolatedProtection("r28-3-normalization-", LEXICONS_TEXT, { normalizationVersion: "coverage-normalization.v2" });
  try {
    const result = module.protectCoverageUnit({ unit: unitOf("Le désert reste silencieux."), version: V1, entities: ENTITIES });
    deepStrictEqual([result.status, result.protected, result.reason], ["DEGRADED", true, "normalisation indisponible"]);
    assertTrace(result, ENTITIES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test("monotonie (I5) : lexiques et entités enrichis n’ôtent jamais un signal", async () => {
  const data = JSON.parse(LEXICONS_TEXT);
  data.vague_quantifiers = [...data.vague_quantifiers, "territoire"].sort();
  data.temporal_expressions = [...data.temporal_expressions, "saison"].sort();
  const { root, module } = await isolatedProtection("r28-3-monotony-", JSON.stringify(data));
  try {
    const richer = module.extractResearchEntities({ keyFacts: [...KEY_FACTS, "Le site d’Uluru attire."], ruleVersion: RULE });
    const version = module.coverageProtectionVersion();
    if (!version || version === V1) throw new Error("version enrichie attendue différente");
    const texts = [...SIGNAL_CASES.map(([, text]) => text), "Le territoire change à chaque saison près d’uluru."];
    for (const text of texts) {
      const base = protect(text);
      const more = module.protectCoverageUnit({ unit: unitOf(text), version, entities: richer });
      const baseSignals = base.signals.map(item => item.signal);
      const moreSignals = more.signals.map(item => item.signal);
      if (!baseSignals.every(signal => moreSignals.includes(signal))) throw new Error(`signal perdu : ${text}`);
      if (base.protected && !more.protected) throw new Error(`protection perdue : ${text}`);
    }
    const added = module.protectCoverageUnit({ unit: unitOf("Le territoire change à chaque saison près d’uluru."), version, entities: richer });
    deepStrictEqual(added.signals.map(item => item.signal), ["vague_quantifier", "research_entity", "temporal_expression"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test("indépendance (I2) : aucun import ni référence au registre, aux claims, au juge ou à la réparation", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-protection.js", import.meta.url), "utf8");
  const imports = source.split("\n").filter(line => line.startsWith("import "));
  deepStrictEqual(imports, [
    'import crypto from "node:crypto";',
    'import fs from "node:fs";',
    'import { normalizeCoverageText } from "./coverage-normalization.js";'
  ]);
  const code = source.split("\n").filter(line => !line.trim().startsWith("//")).join("\n").toLowerCase();
  for (const forbidden of ["registr", "registry", "claim", "verdict", "prompt", "judge", "juge", "repair", "répar", "narrat", "splitter", "decoupeur"]) {
    if (code.includes(forbidden)) throw new Error(`référence interdite : ${forbidden}`);
  }
});

await test("sortie immuable", () => {
  const result = protect("Selon les chercheurs, 3 villes : Sydney.");
  if (!Object.isFrozen(result) || !Object.isFrozen(result.signals) || !result.signals.every(item => Object.isFrozen(item) && Object.isFrozen(item.matches) && item.matches.every(Object.isFrozen))) {
    throw new Error("sortie modifiable");
  }
  if (!Object.isFrozen(ENTITIES) || !Object.isFrozen(ENTITIES.entities)) throw new Error("entités modifiables");
});

await test("aucune dépendance à la plateforme dans le module (hors commentaires)", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-protection.js", import.meta.url), "utf8")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["normalize(", "Intl", "localeCompare", "toLowerCase", "toUpperCase", "toLocale", "\\p{", "/u", "\\s"]) {
    if (source.includes(forbidden)) throw new Error(`usage interdit : ${forbidden}`);
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-protection-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
