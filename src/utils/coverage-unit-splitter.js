// R28.2 — découpeur d'unités de la frontière factuelle (baseline v1.0.1,
// contrat 4.1). Il partitionne un voiceover en unités identifiées, typées et
// exactes. Il ne décide ni de la factualité, ni de la protection, ni de la
// narration.
//
// Garanties :
//   - partition exacte (I14) : la concaténation des unités redonne le texte ;
//     l'espace qui suit une coupure appartient à l'unité qui précède ;
//   - exactitude : text === voiceover.slice(start, end) ;
//   - types fermés (I19) : phrase, citation, parenthèse ; aucun chevauchement ;
//   - déterminisme (I18) : classes de caractères en listes fermées, aucun
//     recours à ICU, Intl, normalize(), toLowerCase() ni localeCompare() ;
//   - localité : une coupure ne dépend que de son voisinage immédiat, sauf à
//     l'intérieur d'une citation ou d'une parenthèse ;
//   - idempotence : redécouper une unité redonne cette seule unité.
//
// Règles v1 :
//   1. fins de phrase : . ! ? … ; une suite de ces signes (« ?! », « ... »)
//      forme une seule fin ;
//   2. une coupure exige un espace après la fin, puis un caractère qui n'est
//      pas une minuscule (pas de coupure avant une minuscule) ; sans espace,
//      aucune coupure (nombres décimaux, sigles) ;
//   3. un point seul après une abréviation de la liste fermée, ou après une
//      initiale majuscule, ne coupe pas ;
//   4. aucune coupure à l'intérieur de guillemets (« », “ ”, ") ou de
//      parenthèses ; une fin juste avant le signe fermant coupe après lui ;
//   5. une unité contenant des guillemets ou des parenthèses qui renferment
//      au moins une fin de phrase prend le type citation ou parenthèse (le
//      premier rencontré) ; sinon, elle est de type phrase.
//
// Échec fermé (section 7) : version ou langue inconnue, données
// d'abréviations indisponibles, partition violée → dégradé sûr, une seule
// unité couvrant tout le texte ; texte vide → échec qualifié.
//
// Version : règles v1 et empreinte du contenu de la liste d'abréviations.
// Toute modification des règles exige un nouveau numéro de règles.

import crypto from "node:crypto";
import fs from "node:fs";

export const COVERAGE_UNIT_SPLITTER_RULES_VERSION = "coverage-unit-splitter.v1";
export const COVERAGE_UNIT_SPLITTER_LANGUAGE = "fr";
export const COVERAGE_UNIT_TYPES = Object.freeze(["phrase", "citation", "parenthèse"]);

export const SPLIT_STATUS = Object.freeze({
  OK: "OK",
  DEGRADED: "DEGRADED",
  FAILED: "FAILED"
});

const ABBREVIATIONS_FILE = new URL("../../config/coverage/abbreviations.fr.json", import.meta.url);

const TERMINATORS = new Set([".", "!", "?", "…"]);
const WHITESPACE = new Set([
  " ", "\t", "\n", "\r", "\f", "\v",
  " ", " ", " ", " ", " ", " "
]);
const LOWERCASE = new Set(
  "abcdefghijklmnopqrstuvwxyzàáâãäåçèéêëìíîïñòóôõöùúûüýÿæœ"
);
const UPPERCASE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝŸÆŒ"
);
// Signe ouvrant → signe fermant et type. Le guillemet droit ferme lui-même.
const REGIONS = new Map([
  ["«", { closer: "»", type: "citation" }],
  ["“", { closer: "”", type: "citation" }],
  ["\"", { closer: "\"", type: "citation" }],
  ["(", { closer: ")", type: "parenthèse" }]
]);
// Caractères qui précèdent un mot sans en faire partie.
const WORD_OPENERS = new Set(["«", "“", "\"", "(", "["]);

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function loadAbbreviations() {
  try {
    const data = JSON.parse(fs.readFileSync(ABBREVIATIONS_FILE, "utf8"));
    const list = data?.abbreviations;

    if (
      data?.language !== COVERAGE_UNIT_SPLITTER_LANGUAGE ||
      !Array.isArray(list) || list.length === 0 ||
      !list.every(item =>
        typeof item === "string" && item.length > 0 &&
        ![...item].some(character => WHITESPACE.has(character) || TERMINATORS.has(character) && character !== ".")
      ) ||
      new Set(list).size !== list.length ||
      list.some((item, index) => index > 0 && !(list[index - 1] < item))
    ) {
      return null;
    }

    const canonical = JSON.stringify({ language: data.language, abbreviations: list });

    return {
      set: new Set(list),
      version: `${COVERAGE_UNIT_SPLITTER_RULES_VERSION}+abbreviations.${sha256(canonical)}`
    };
  } catch {
    return null;
  }
}

const ABBREVIATIONS = loadAbbreviations();

// Version disponible, dérivée des règles et du contenu des abréviations ;
// null si les données sont indisponibles (tout découpage est alors dégradé).
export function coverageUnitSplitterVersion() {
  return ABBREVIATIONS?.version ?? null;
}

function previousWord(text, dotIndex) {
  let start = dotIndex;
  while (start > 0 && !WHITESPACE.has(text[start - 1]) && !WORD_OPENERS.has(text[start - 1])) start -= 1;
  return text.slice(start, dotIndex);
}

function isAbbreviation(text, dotIndex) {
  const word = previousWord(text, dotIndex);
  return ABBREVIATIONS.set.has(word) || (word.length === 1 && UPPERCASE.has(word));
}

// Position de fin de l'unité si une coupure est valide en `position`, sinon -1.
function cutEnd(text, position) {
  if (position >= text.length || !WHITESPACE.has(text[position])) return -1;
  let next = position;
  while (next < text.length && WHITESPACE.has(text[next])) next += 1;
  if (next >= text.length || LOWERCASE.has(text[next])) return -1;
  return next;
}

function lastNonWhitespace(text, from, to) {
  for (let index = to - 1; index >= from; index -= 1) {
    if (!WHITESPACE.has(text[index])) return text[index];
  }
  return null;
}

function cutPoints(text) {
  const cuts = [];
  const regions = [];
  const stack = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const top = stack.at(-1);

    if (top && character === top.closer) {
      stack.pop();
      if (top.terminated) regions.push({ start: top.start, type: top.type });
      if (stack.length === 0 && TERMINATORS.has(lastNonWhitespace(text, top.start + 1, index))) {
        const end = cutEnd(text, index + 1);
        if (end !== -1) cuts.push(end);
      }
      continue;
    }

    if (REGIONS.has(character)) {
      const { closer, type } = REGIONS.get(character);
      stack.push({ start: index, closer, type, terminated: false });
      continue;
    }

    if (!TERMINATORS.has(character)) continue;

    if (stack.length > 0) {
      for (const region of stack) region.terminated = true;
      continue;
    }

    let runEnd = index;
    while (runEnd < text.length && TERMINATORS.has(text[runEnd])) runEnd += 1;
    const singleDot = runEnd === index + 1 && character === ".";

    if (!singleDot || !isAbbreviation(text, index)) {
      const end = cutEnd(text, runEnd);
      if (end !== -1) cuts.push(end);
    }
    index = runEnd - 1;
  }

  // Une région jamais fermée s'étend jusqu'à la fin du texte (fusion sûre).
  for (const region of stack) {
    if (region.terminated) regions.push({ start: region.start, type: region.type });
  }

  return { cuts, regions: regions.sort((a, b) => a.start - b.start) };
}

function freezeResult(fields) {
  return Object.freeze({ ...fields, units: Object.freeze(fields.units.map(unit => Object.freeze(unit))) });
}

function unit(text, rank, start, end, type) {
  return { id: `u${rank}`, rank, type, start, end, text: text.slice(start, end) };
}

function degraded(text, digest, reason) {
  return freezeResult({
    version: coverageUnitSplitterVersion(),
    language: COVERAGE_UNIT_SPLITTER_LANGUAGE,
    voiceover_sha256: digest,
    status: SPLIT_STATUS.DEGRADED,
    reason,
    units: [unit(text, 1, 0, text.length, "phrase")]
  });
}

function isPartition(text, units) {
  let position = 0;
  for (const item of units) {
    if (
      item.start !== position || item.end <= item.start ||
      item.text !== text.slice(item.start, item.end) ||
      !COVERAGE_UNIT_TYPES.includes(item.type) ||
      [...item.text].every(character => WHITESPACE.has(character))
    ) return false;
    position = item.end;
  }
  return position === text.length;
}

// Découpe un voiceover. L'identifiant d'une unité est son rang (u1, u2…) lié
// à l'empreinte voiceover_sha256 du texte exact.
export function splitCoverageUnits({ voiceover, version, language }) {
  if (typeof voiceover !== "string") {
    throw new Error("Coverage Unit Splitter : voiceover invalide (chaîne attendue).");
  }

  const digest = sha256(voiceover);

  if ([...voiceover].every(character => WHITESPACE.has(character))) {
    return freezeResult({
      version: coverageUnitSplitterVersion(),
      language: COVERAGE_UNIT_SPLITTER_LANGUAGE,
      voiceover_sha256: digest,
      status: SPLIT_STATUS.FAILED,
      reason: "texte vide",
      units: []
    });
  }

  if (!ABBREVIATIONS) return degraded(voiceover, digest, "données d'abréviations indisponibles");
  if (version !== ABBREVIATIONS.version) {
    return degraded(voiceover, digest, `version inconnue (${String(version)})`);
  }
  if (language !== COVERAGE_UNIT_SPLITTER_LANGUAGE) {
    return degraded(voiceover, digest, `langue inconnue (${String(language)})`);
  }

  const { cuts, regions } = cutPoints(voiceover);
  const bounds = [0, ...cuts, voiceover.length];
  const units = [];

  for (let index = 0; index < bounds.length - 1; index += 1) {
    const start = bounds[index];
    const end = bounds[index + 1];
    const region = regions.find(item => item.start >= start && item.start < end);
    units.push(unit(voiceover, index + 1, start, end, region ? region.type : "phrase"));
  }

  if (!isPartition(voiceover, units)) return degraded(voiceover, digest, "partition violée");

  return freezeResult({
    version: ABBREVIATIONS.version,
    language: COVERAGE_UNIT_SPLITTER_LANGUAGE,
    voiceover_sha256: digest,
    status: SPLIT_STATUS.OK,
    reason: null,
    units
  });
}
