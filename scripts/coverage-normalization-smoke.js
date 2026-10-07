// Smoke R28.1 — normalisation partagée de la frontière (baseline v1.0.1, 4.2),
// zéro API. Vérifie la stabilité de la version publique : mêmes entrées,
// mêmes sorties, mêmes positions, même ordre, même découpage en mots et
// formes d'origine conservées, sans dépendance à la plateforme.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-normalization-smoke.js

import fs from "node:fs";
import { deepStrictEqual, throws } from "node:assert/strict";

import {
  COVERAGE_NORMALIZATION_VERSION,
  normalizeCoverageText
} from "../src/utils/coverage-normalization.js";

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

// Version publique écrite en clair : elle n'est pas lue depuis le module.
const V1 = "coverage-normalization.v1";
const normalize = text => normalizeCoverageText(text, V1);
const tokens = text => normalize(text).words.map(item => item.normalized);

// Table fermée attendue pour v1, écrite indépendamment du module. Le balayage
// exhaustif ci-dessous la compare caractère par caractère à tout l'espace
// Unicode : tout ajout, retrait ou remplacement fait échouer le smoke.
const EXPECTED_TABLE = new Map();
const expect = (folded, characters) => {
  for (const character of characters) EXPECTED_TABLE.set(character, folded);
};
for (const letter of "abcdefghijklmnopqrstuvwxyz") expect(letter, letter + letter.toUpperCase());
for (const digit of "0123456789") expect(digit, digit);
expect("a", "àáâãäåÀÁÂÃÄÅ");
expect("c", "çÇ");
expect("e", "èéêëÈÉÊË");
expect("i", "ìíîïÌÍÎÏ");
expect("n", "ñÑ");
expect("o", "òóôõöÒÓÔÕÖ");
expect("u", "ùúûüÙÚÛÜ");
expect("y", "ýÿÝŸ");
expect("ae", "æÆ");
expect("oe", "œŒ");

const MAX_CODE_POINT = 0x10ffff;
const isCombiningMark = codePoint => codePoint >= 0x0300 && codePoint <= 0x036f;
const TOKEN_ALPHABET = /^[a-z0-9]+$/;
const plain = result => JSON.parse(JSON.stringify(result));

// Entrée de référence et sortie attendue, figées pour la version v1.
const REFERENCE =
  "Mais avant cela, un détour : l’Australie couvre 7,7 millions de km² — c'est-à-dire « Œuvre » ?";

const REFERENCE_WORDS = [
  { normalized: "mais", original: "Mais", start: 0, end: 4 },
  { normalized: "avant", original: "avant", start: 5, end: 10 },
  { normalized: "cela", original: "cela", start: 11, end: 15 },
  { normalized: "un", original: "un", start: 17, end: 19 },
  { normalized: "detour", original: "détour", start: 20, end: 26 },
  { normalized: "l", original: "l", start: 29, end: 30 },
  { normalized: "australie", original: "Australie", start: 31, end: 40 },
  { normalized: "couvre", original: "couvre", start: 41, end: 47 },
  { normalized: "7", original: "7", start: 48, end: 49 },
  { normalized: "7", original: "7", start: 50, end: 51 },
  { normalized: "millions", original: "millions", start: 52, end: 60 },
  { normalized: "de", original: "de", start: 61, end: 63 },
  { normalized: "km", original: "km", start: 64, end: 66 },
  { normalized: "c", original: "c", start: 70, end: 71 },
  { normalized: "est", original: "est", start: 72, end: 75 },
  { normalized: "a", original: "à", start: 76, end: 77 },
  { normalized: "dire", original: "dire", start: 78, end: 82 },
  { normalized: "oeuvre", original: "Œuvre", start: 85, end: 90 }
];

await test("version publique : coverage-normalization.v1", () => {
  deepStrictEqual(COVERAGE_NORMALIZATION_VERSION, "coverage-normalization.v1");
  deepStrictEqual(normalize(REFERENCE).version, "coverage-normalization.v1");
  deepStrictEqual(normalize("").version, "coverage-normalization.v1");
});

await test("sortie de référence figée : découpage, ordre, positions et formes d'origine", () => {
  deepStrictEqual(plain(normalize(REFERENCE).words), REFERENCE_WORDS);
});

await test("déterminisme : mêmes entrées → mêmes sorties (1 000 répétitions)", () => {
  const first = JSON.stringify(normalize(REFERENCE));
  for (let index = 0; index < 1000; index += 1) {
    deepStrictEqual(JSON.stringify(normalize(REFERENCE)), first);
  }
});

await test("déterminisme : indépendant de l'historique des appels", () => {
  const before = JSON.stringify(normalize(REFERENCE));
  normalize("Autre texte, ÉLÈVE et cœur.");
  normalize("");
  deepStrictEqual(JSON.stringify(normalize(REFERENCE)), before);
});

await test("positions : text.slice(start, end) === forme d'origine, ordre croissant sans chevauchement", () => {
  const samples = [
    REFERENCE,
    "Le bassin couvre environ un million de kilomètres carrés.",
    "été à l'ouest",
    "  Æther… ŒUVRE!!  "
  ];
  for (const text of samples) {
    let previousEnd = 0;
    for (const item of normalize(text).words) {
      deepStrictEqual(text.slice(item.start, item.end), item.original);
      if (item.start < previousEnd || item.end <= item.start) {
        throw new Error(`positions incohérentes pour « ${item.original} » dans « ${text} »`);
      }
      previousEnd = item.end;
    }
  }
});

await test("accents, majuscules et ligatures : table fermée", () => {
  deepStrictEqual(tokens("ÉLÈVE Ça Où Île Noël Ÿ"), ["eleve", "ca", "ou", "ile", "noel", "y"]);
  deepStrictEqual(tokens("cœur Œuvre æther Æ"), ["coeur", "oeuvre", "aether", "ae"]);
});

await test("apostrophes droite et typographique : séparateurs", () => {
  deepStrictEqual(tokens("l'Australie l’Australie"), ["l", "australie", "l", "australie"]);
});

await test("espaces insécables et traits d'union : séparateurs", () => {
  deepStrictEqual(tokens("95 % du territoire"), ["95", "du", "territoire"]);
  deepStrictEqual(tokens("c'est-à-dire semi-aride"), ["c", "est", "a", "dire", "semi", "aride"]);
});

await test("diacritiques combinants : ignorés dans le mot, conservés dans la forme d'origine", () => {
  const text = "été café";
  deepStrictEqual(plain(normalize(text).words), [
    { normalized: "ete", original: "été", start: 0, end: 5 },
    { normalized: "cafe", original: "café", start: 6, end: 11 }
  ]);
});

await test("caractères hors table : séparateurs", () => {
  deepStrictEqual(tokens("Straße 😀test ²"), ["stra", "e", "test"]);
});

await test("texte vide ou sans mot : liste vide", () => {
  deepStrictEqual(plain(normalize("").words), []);
  deepStrictEqual(plain(normalize("  , ; ! … « » ").words), []);
});

await test("entrée invalide : refusée", () => {
  for (const value of [undefined, null, 42, {}, ["texte"]]) {
    throws(() => normalize(value), /Coverage Normalization : texte invalide/);
  }
});

await test("sortie immuable", () => {
  const result = normalize(REFERENCE);
  if (!Object.isFrozen(result) || !Object.isFrozen(result.words) || !result.words.every(Object.isFrozen)) {
    throw new Error("sortie modifiable");
  }
});

await test("contrat 4.2 : version d'entrée divergente ou absente → refus explicite", () => {
  for (const version of [undefined, null, "", "coverage-normalization.v2", "coverage-normalization.v0", "COVERAGE-NORMALIZATION.V1", " coverage-normalization.v1", 1, {}]) {
    throws(
      () => normalizeCoverageText("texte", version),
      /Coverage Normalization : version .* refusée — version disponible coverage-normalization\.v1 \(verrou de versions\)\./
    );
  }
  // La version est contrôlée avant le texte : un refus de version n'est jamais masqué.
  throws(() => normalizeCoverageText(null, "coverage-normalization.v2"), /version .* refusée/);
  deepStrictEqual(normalizeCoverageText("texte", V1).version, V1);
});

await test("table fermée figée : balayage exhaustif de U+0000 à U+10FFFF", () => {
  const seen = new Set();
  for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    const words = normalize(character).words;
    const expected = EXPECTED_TABLE.get(character);

    if (expected === undefined) {
      if (words.length !== 0) {
        throw new Error(`U+${codePoint.toString(16).toUpperCase()} hors table produit un mot (${words[0].normalized})`);
      }
      continue;
    }
    if (words.length !== 1 || words[0].normalized !== expected || words[0].original !== character) {
      throw new Error(`U+${codePoint.toString(16).toUpperCase()} : attendu « ${expected} », obtenu ${JSON.stringify(words)}`);
    }
    seen.add(character);
  }
  deepStrictEqual(seen.size, EXPECTED_TABLE.size);
  deepStrictEqual(EXPECTED_TABLE.size, 120);
});

await test("invariant : jetons dans [a-z0-9] et tout caractère hors table sépare, exhaustif", () => {
  for (const [character, folded] of EXPECTED_TABLE) {
    const words = normalize(`a${character}b`).words;
    if (words.length !== 1 || words[0].normalized !== `a${folded}b` || !TOKEN_ALPHABET.test(words[0].normalized)) {
      throw new Error(`caractère de table « ${character} » : ${JSON.stringify(words)}`);
    }
  }
  for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (EXPECTED_TABLE.has(character)) continue;
    const text = `a${character}b`;
    const words = normalize(text).words;
    const expected = isCombiningMark(codePoint) ? ["ab"] : ["a", "b"];
    if (
      words.length !== expected.length ||
      words.some((item, index) => item.normalized !== expected[index] || !TOKEN_ALPHABET.test(item.normalized)) ||
      words.some(item => text.slice(item.start, item.end) !== item.original)
    ) {
      throw new Error(`U+${codePoint.toString(16).toUpperCase()} dans « a…b » : ${JSON.stringify(words)}`);
    }
  }
});

await test("aucune dépendance à la plateforme dans le module (hors commentaires)", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-normalization.js", import.meta.url), "utf8")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["normalize(", "Intl", "localeCompare", "toLowerCase", "toUpperCase", "toLocale", "\\p{", "/u"]) {
    if (source.includes(forbidden)) throw new Error(`usage interdit : ${forbidden}`);
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-normalization-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
