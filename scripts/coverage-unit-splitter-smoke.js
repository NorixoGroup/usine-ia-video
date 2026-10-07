// Smoke R28.2 — découpeur d'unités de la frontière (baseline v1.0.1, 4.1),
// zéro API. Vérifie la version publique, la liste d'abréviations figée, la
// partition exacte (I14), les types fermés sans chevauchement (I19), le
// déterminisme (I18), la localité, l'idempotence, les règles v1 et l'échec
// fermé (section 7).
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/coverage-unit-splitter-smoke.js

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepStrictEqual, throws } from "node:assert/strict";

import {
  COVERAGE_UNIT_SPLITTER_LANGUAGE,
  COVERAGE_UNIT_SPLITTER_RULES_VERSION,
  COVERAGE_UNIT_TYPES,
  SPLIT_STATUS,
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

// Liste d'abréviations et version publique, écrites en clair : elles ne sont
// pas lues depuis le module. Toute modification des données fait échouer.
const EXPECTED_ABBREVIATIONS = [
  "Cie", "Dr", "Ets", "Gal", "J.-C", "Jr", "M", "MM", "Me", "Mgr", "Mlle",
  "Mlles", "Mme", "Mmes", "Pr", "Sr", "St", "Ste", "al", "apr", "av", "cf",
  "chap", "env", "etc", "ex", "fig", "no", "nos", "p", "pp", "s", "éd"
];
const V1 =
  "coverage-unit-splitter.v1+abbreviations.2dc95275e3bbde63712b8b1830dad856aeae1769e769ab1a0acfecc79cbd83c5";

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const split = voiceover => splitCoverageUnits({ voiceover, version: V1, language: "fr" });
const shape = voiceover => split(voiceover).units.map(item => [item.type, item.text]);
const plain = value => JSON.parse(JSON.stringify(value));

function assertPartition(voiceover, result) {
  let position = 0;
  result.units.forEach((item, index) => {
    if (item.start !== position) throw new Error(`trou ou chevauchement en ${position} : ${JSON.stringify(voiceover)}`);
    if (item.end <= item.start) throw new Error(`unité vide : ${JSON.stringify(voiceover)}`);
    if (item.text !== voiceover.slice(item.start, item.end)) throw new Error(`texte inexact : ${JSON.stringify(item)}`);
    if (!COVERAGE_UNIT_TYPES.includes(item.type)) throw new Error(`type hors liste : ${item.type}`);
    if (item.id !== `u${index + 1}` || item.rank !== index + 1) throw new Error(`identifiant incohérent : ${item.id}`);
    position = item.end;
  });
  if (position !== voiceover.length) throw new Error(`partition incomplète : ${JSON.stringify(voiceover)}`);
  if (result.units.map(item => item.text).join("") !== voiceover) throw new Error("concaténation différente du texte");
}

// Corpus de référence : sortie attendue figée pour la version v1.
const CASES = [
  {
    name: "exemple de la baseline (section 11)",
    text: "Mais avant cela, un détour. Le bassin couvre environ un million de kilomètres carrés. Ce n’est pas un hasard. Sans lui, l’intérieur serait inhabitable.",
    units: [
      ["phrase", "Mais avant cela, un détour. "],
      ["phrase", "Le bassin couvre environ un million de kilomètres carrés. "],
      ["phrase", "Ce n’est pas un hasard. "],
      ["phrase", "Sans lui, l’intérieur serait inhabitable."]
    ]
  },
  {
    name: "pas de coupure avant une minuscule",
    text: "Il était 3 h. et demie. Puis… rien. Enfin.",
    units: [["phrase", "Il était 3 h. et demie. "], ["phrase", "Puis… rien. "], ["phrase", "Enfin."]]
  },
  {
    name: "abréviations de la liste et initiales",
    text: "M. Dupont arrive. Vers 300 av. J.-C. les tribus vivaient ici. J. K. Rowling écrit. Fin.",
    units: [
      ["phrase", "M. Dupont arrive. "],
      ["phrase", "Vers 300 av. J.-C. les tribus vivaient ici. "],
      ["phrase", "J. K. Rowling écrit. "],
      ["phrase", "Fin."]
    ]
  },
  {
    name: "abréviation en fin de phrase : fusion sûre",
    text: "Des lézards, des serpents, etc. Le désert vit.",
    units: [["phrase", "Des lézards, des serpents, etc. Le désert vit."]]
  },
  {
    name: "nombres décimaux et sigles sans espace",
    text: "La valeur passe de 7.7 à 3.14 millions. Le site www.exemple.fr existe. Oui.",
    units: [
      ["phrase", "La valeur passe de 7.7 à 3.14 millions. "],
      ["phrase", "Le site www.exemple.fr existe. "],
      ["phrase", "Oui."]
    ]
  },
  {
    name: "ponctuations combinées et points de suspension",
    text: "Vraiment ?! Oui... Non !!! Peut-être…",
    units: [["phrase", "Vraiment ?! "], ["phrase", "Oui... "], ["phrase", "Non !!! "], ["phrase", "Peut-être…"]]
  },
  {
    name: "espaces insécables et retours à la ligne",
    text: "Pourquoi ? Parce que ! Ensuite.\nLa suite.",
    units: [["phrase", "Pourquoi ? "], ["phrase", "Parce que ! "], ["phrase", "Ensuite.\n"], ["phrase", "La suite."]]
  },
  {
    name: "citation multi-phrases : une seule unité de type citation",
    text: "Il a dit : « Ça suffit. Partons. » Puis il est parti.",
    units: [["citation", "Il a dit : « Ça suffit. Partons. » "], ["phrase", "Puis il est parti."]]
  },
  {
    name: "fin de phrase juste avant le guillemet fermant",
    text: "« Partons. » Il part. “Vite ! Encore ?” Oui. \"Non. Jamais.\" Fin.",
    units: [
      ["citation", "« Partons. » "],
      ["phrase", "Il part. "],
      ["citation", "“Vite ! Encore ?” "],
      ["phrase", "Oui. "],
      ["citation", "\"Non. Jamais.\" "],
      ["phrase", "Fin."]
    ]
  },
  {
    name: "parenthèse multi-phrases",
    text: "Le bassin (voir plus loin. C’est vaste.) couvre tout. Ensuite vient la côte.",
    units: [["parenthèse", "Le bassin (voir plus loin. C’est vaste.) couvre tout. "], ["phrase", "Ensuite vient la côte."]]
  },
  {
    name: "guillemets ou parenthèses sans fin de phrase interne : type phrase",
    text: "Le mot « désert » vient du latin (desertum). Oui.",
    units: [["phrase", "Le mot « désert » vient du latin (desertum). "], ["phrase", "Oui."]]
  },
  {
    name: "premier type rencontré si citation et parenthèse",
    text: "Il cite (une note. Deux.) puis « Un. Deux. » ici. Fin.",
    units: [["parenthèse", "Il cite (une note. Deux.) puis « Un. Deux. » ici. "], ["phrase", "Fin."]]
  },
  {
    name: "fin après le signe fermant",
    text: "Il a dit « partons ». Puis il est parti.",
    units: [["phrase", "Il a dit « partons ». "], ["phrase", "Puis il est parti."]]
  },
  {
    name: "région jamais fermée : fusion sûre jusqu'à la fin",
    text: "Le bassin couvre tout. (Une note sans fin. Encore. Et encore.",
    units: [["phrase", "Le bassin couvre tout. "], ["parenthèse", "(Une note sans fin. Encore. Et encore."]]
  },
  {
    name: "titre non ponctué : fusion avec l'unité suivante",
    text: "Chapitre un\nLe bassin couvre tout. Fin.",
    units: [["phrase", "Chapitre un\nLe bassin couvre tout. "], ["phrase", "Fin."]]
  },
  {
    name: "espaces en tête et en fin : rattachés aux unités voisines",
    text: "  Un. Deux.  ",
    units: [["phrase", "  Un. "], ["phrase", "Deux.  "]]
  },
  {
    name: "texte sans fin de phrase : une seule unité",
    text: "Une phrase sans point final",
    units: [["phrase", "Une phrase sans point final"]]
  }
];

// Générateur pseudo-aléatoire déterministe (LCG), indépendant de la plateforme.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const FUZZ_ALPHABET = [
  "a", "b", "é", "œ", "A", "É", "Œ", "M", "J", "7", " ", " ", " ", " ", " ", "\n",
  ".", ".", "!", "?", "…", ",", ";", ":", "-", "'", "’", "«", "»", "“", "”", "\"", "(", ")", "[", "]",
  "etc", "av", "J.-C", "Mme", "😀", "́"
];

function fuzzTexts(count, seed) {
  const next = generator(seed);
  const texts = [];
  for (let index = 0; index < count; index += 1) {
    const length = 1 + (next() % 40);
    let text = "";
    for (let position = 0; position < length; position += 1) text += FUZZ_ALPHABET[next() % FUZZ_ALPHABET.length];
    texts.push(text);
  }
  return texts;
}

await test("version publique : règles v1 + empreinte du contenu des abréviations", () => {
  deepStrictEqual(COVERAGE_UNIT_SPLITTER_RULES_VERSION, "coverage-unit-splitter.v1");
  deepStrictEqual(COVERAGE_UNIT_SPLITTER_LANGUAGE, "fr");
  deepStrictEqual(coverageUnitSplitterVersion(), V1);
  const canonical = JSON.stringify({ language: "fr", abbreviations: EXPECTED_ABBREVIATIONS });
  deepStrictEqual(V1, `coverage-unit-splitter.v1+abbreviations.${sha256(canonical)}`);
  deepStrictEqual(split("Un. Deux.").version, V1);
});

await test("liste d'abréviations figée (contenu, ordre, langue)", () => {
  const data = JSON.parse(fs.readFileSync(new URL("../config/coverage/abbreviations.fr.json", import.meta.url), "utf8"));
  deepStrictEqual(data, { language: "fr", abbreviations: EXPECTED_ABBREVIATIONS });
});

await test("types d'unités : liste fermée (I19)", () => {
  deepStrictEqual([...COVERAGE_UNIT_TYPES], ["phrase", "citation", "parenthèse"]);
  if (!Object.isFrozen(COVERAGE_UNIT_TYPES)) throw new Error("liste modifiable");
});

for (const item of CASES) {
  await test(`règle v1 — ${item.name}`, () => {
    const result = split(item.text);
    deepStrictEqual(result.status, SPLIT_STATUS.OK);
    deepStrictEqual(shape(item.text), item.units);
    assertPartition(item.text, result);
  });
}

await test("positions et identifiants figés sur l'exemple de la baseline", () => {
  const text = CASES[0].text;
  deepStrictEqual(
    plain(split(text).units.map(({ id, rank, start, end }) => ({ id, rank, start, end }))),
    [
      { id: "u1", rank: 1, start: 0, end: 28 },
      { id: "u2", rank: 2, start: 28, end: 86 },
      { id: "u3", rank: 3, start: 86, end: 110 },
      { id: "u4", rank: 4, start: 110, end: 151 }
    ]
  );
});

await test("empreinte : SHA-256 du voiceover exact", () => {
  for (const item of CASES) deepStrictEqual(split(item.text).voiceover_sha256, sha256(item.text));
  if (split("Un. Deux.").voiceover_sha256 === split("Un. Deux. ").voiceover_sha256) {
    throw new Error("empreinte insensible à un espace");
  }
});

await test("partition exacte (I14) sur 20 000 textes pseudo-aléatoires", () => {
  for (const text of fuzzTexts(20000, 2810)) {
    const result = split(text);
    if (result.status === SPLIT_STATUS.FAILED) {
      if (!/^[\s  ]*$/.test(text)) throw new Error(`échec inattendu : ${JSON.stringify(text)}`);
      continue;
    }
    deepStrictEqual(result.status, SPLIT_STATUS.OK, JSON.stringify(text));
    assertPartition(text, result);
  }
});

await test("partition exacte (I14) avec chaque caractère de U+0000 à U+10FFFF", () => {
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    const text = `Un${character}. Deux ${character}trois.`;
    const result = split(text);
    if (result.status !== SPLIT_STATUS.OK) throw new Error(`U+${codePoint.toString(16)} : ${result.status}`);
    assertPartition(text, result);
  }
});

await test("déterminisme : mêmes entrées → mêmes sorties, indépendamment de l'historique", () => {
  const texts = [...CASES.map(item => item.text), ...fuzzTexts(2000, 77)];
  const first = texts.map(text => JSON.stringify(split(text)));
  split("Autre texte. Sans lien.");
  for (let round = 0; round < 3; round += 1) {
    deepStrictEqual(texts.map(text => JSON.stringify(split(text))), first);
  }
});

await test("idempotence : redécouper une unité redonne cette seule unité, de même type", () => {
  const texts = [...CASES.map(item => item.text), ...fuzzTexts(20000, 4242)];
  for (const text of texts) {
    const result = split(text);
    if (result.status !== SPLIT_STATUS.OK) continue;
    for (const item of result.units) {
      const again = split(item.text);
      if (again.units.length !== 1 || again.units[0].type !== item.type || again.units[0].text !== item.text) {
        throw new Error(`non idempotent : ${JSON.stringify(item.text)} → ${JSON.stringify(again.units)}`);
      }
    }
  }
});

await test("localité : découper A + B redonne les unités de A puis celles de B", () => {
  const sentences = CASES.filter(item => !item.name.includes("jamais fermée") && !item.name.includes("espaces en tête") && !item.name.includes("sans fin de phrase"))
    .map(item => item.text);
  for (const a of sentences) {
    for (const b of sentences) {
      const joined = `${a} ${b}`;
      const expected = [...shape(`${a} `), ...shape(b)];
      deepStrictEqual(shape(joined), expected, `${a} | ${b}`);
    }
  }
});

await test("échec fermé : texte vide ou blanc → échec qualifié, aucune unité", () => {
  for (const text of ["", " ", "\n\t", "  "]) {
    const result = split(text);
    deepStrictEqual(result.status, SPLIT_STATUS.FAILED);
    deepStrictEqual(result.reason, "texte vide");
    deepStrictEqual(plain(result.units), []);
  }
});

await test("échec fermé : version ou langue inconnue → dégradé sûr, une seule unité", () => {
  const text = "Un. Deux. Trois.";
  for (const version of [undefined, null, "", "coverage-unit-splitter.v1", `${V1}x`, "coverage-unit-splitter.v2+abbreviations.0"]) {
    const result = splitCoverageUnits({ voiceover: text, version, language: "fr" });
    deepStrictEqual(result.status, SPLIT_STATUS.DEGRADED);
    if (!result.reason.startsWith("version inconnue")) throw new Error(result.reason);
    deepStrictEqual(plain(result.units), [{ id: "u1", rank: 1, type: "phrase", start: 0, end: text.length, text }]);
  }
  for (const language of [undefined, "en", "FR"]) {
    const result = splitCoverageUnits({ voiceover: text, version: V1, language });
    deepStrictEqual(result.status, SPLIT_STATUS.DEGRADED);
    if (!result.reason.startsWith("langue inconnue")) throw new Error(result.reason);
    deepStrictEqual(result.units.length, 1);
  }
});

await test("échec fermé : données d'abréviations invalides → version nulle, dégradé sûr (copie hors dépôt)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "r28-2-splitter-"));
  try {
    fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "config", "coverage"), { recursive: true });
    fs.copyFileSync(new URL("../src/utils/coverage-unit-splitter.js", import.meta.url), path.join(root, "src", "utils", "coverage-unit-splitter.js"));
    fs.writeFileSync(
      path.join(root, "config", "coverage", "abbreviations.fr.json"),
      JSON.stringify({ language: "fr", abbreviations: ["etc", "av"] })
    );
    const copy = await import(new URL(`file://${path.join(root, "src", "utils", "coverage-unit-splitter.js")}`));
    deepStrictEqual(copy.coverageUnitSplitterVersion(), null);
    const result = copy.splitCoverageUnits({ voiceover: "Un. Deux.", version: V1, language: "fr" });
    deepStrictEqual(result.status, "DEGRADED");
    deepStrictEqual(result.reason, "données d'abréviations indisponibles");
    deepStrictEqual(result.units.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Copie isolée du module (hors dépôt) avec un fichier d'abréviations absent
// (content === null) ou au contenu brut donné ; le dépôt n'est jamais touché.
async function isolatedSplitter(prefix, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(root, "config", "coverage"), { recursive: true });
  fs.copyFileSync(new URL("../src/utils/coverage-unit-splitter.js", import.meta.url), path.join(root, "src", "utils", "coverage-unit-splitter.js"));
  if (content !== null) fs.writeFileSync(path.join(root, "config", "coverage", "abbreviations.fr.json"), content);
  const module = await import(new URL(`file://${path.join(root, "src", "utils", "coverage-unit-splitter.js")}`));
  return { root, module };
}

function assertSafeDegradation(module) {
  const text = "Un. Deux. Trois.";
  deepStrictEqual(module.coverageUnitSplitterVersion(), null);
  const result = module.splitCoverageUnits({ voiceover: text, version: V1, language: "fr" });
  deepStrictEqual(result.status, "DEGRADED");
  deepStrictEqual(result.reason, "données d'abréviations indisponibles");
  deepStrictEqual(result.version, null);
  deepStrictEqual(plain(result.units), [{ id: "u1", rank: 1, type: "phrase", start: 0, end: text.length, text }]);
  // Le texte vide reste un échec qualifié, même sans configuration.
  deepStrictEqual(module.splitCoverageUnits({ voiceover: "", version: V1, language: "fr" }).status, "FAILED");
}

await test("échec fermé : configuration absente → version nulle, dégradé sûr (copie hors dépôt)", async () => {
  const { root, module } = await isolatedSplitter("r28-2a-missing-", null);
  try {
    if (fs.existsSync(path.join(root, "config", "coverage", "abbreviations.fr.json"))) throw new Error("fichier présent");
    assertSafeDegradation(module);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test("échec fermé : JSON invalide → version nulle, dégradé sûr (copie hors dépôt)", async () => {
  const { root, module } = await isolatedSplitter("r28-2a-invalid-json-", '{ "language": "fr", "abbreviations": [');
  try {
    assertSafeDegradation(module);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test("entrée non textuelle : refusée", () => {
  for (const voiceover of [undefined, null, 42, {}, ["Un."]]) {
    throws(() => splitCoverageUnits({ voiceover, version: V1, language: "fr" }), /Coverage Unit Splitter : voiceover invalide/);
  }
});

await test("sortie immuable", () => {
  const result = split(CASES[0].text);
  if (!Object.isFrozen(result) || !Object.isFrozen(result.units) || !result.units.every(Object.isFrozen)) {
    throw new Error("sortie modifiable");
  }
});

await test("aucune dépendance à la plateforme dans le module (hors commentaires)", () => {
  const source = fs.readFileSync(new URL("../src/utils/coverage-unit-splitter.js", import.meta.url), "utf8")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
  for (const forbidden of ["normalize(", "Intl", "localeCompare", "toLowerCase", "toUpperCase", "toLocale", "\\p{", "/u", "\\s"]) {
    if (source.includes(forbidden)) throw new Error(`usage interdit : ${forbidden}`);
  }
});

const networkAttempts = networkGuard.attempts().length;

console.log(`\ncoverage-unit-splitter-smoke — ${passed} PASS, ${failed} FAIL, réseau ${networkAttempts}`);
process.exit(failed === 0 && networkAttempts === 0 ? 0 : 1);
