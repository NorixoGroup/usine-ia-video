// R28.1 — normalisation partagée de la frontière factuelle (baseline v1.0.1,
// contrat 4.2). Elle produit les mots normalisés d'un texte, chacun avec sa
// forme d'origine et ses positions exactes. Elle ne prend aucune décision.
//
// Déterminisme (I18) : la table des caractères est FERMÉE et écrite ici. Aucun
// recours à ICU, Intl, String.prototype.normalize(), toLowerCase(),
// localeCompare() ni à un comportement dépendant de la plateforme.
//
// Règles :
//   - un mot est une suite maximale de caractères de la table ;
//   - les diacritiques combinants (U+0300 à U+036F) sont ignorés : ils ne
//     coupent pas le mot et restent dans la forme d'origine ;
//   - tout autre caractère (espaces, insécables, apostrophes, traits d'union,
//     ponctuation, caractères hors table) sépare les mots ;
//   - positions en unités de code JavaScript : text.slice(start, end) === original.
//
// Toute modification de la table ou des règles exige une nouvelle version.

export const COVERAGE_NORMALIZATION_VERSION = "coverage-normalization.v1";

const FOLDED_GROUPS = [
  ["a", "àáâãäåÀÁÂÃÄÅ"],
  ["c", "çÇ"],
  ["e", "èéêëÈÉÊË"],
  ["i", "ìíîïÌÍÎÏ"],
  ["n", "ñÑ"],
  ["o", "òóôõöÒÓÔÕÖ"],
  ["u", "ùúûüÙÚÛÜ"],
  ["y", "ýÿÝŸ"],
  ["ae", "æÆ"],
  ["oe", "œŒ"]
];

const TABLE = new Map();

for (const letter of "abcdefghijklmnopqrstuvwxyz") TABLE.set(letter, letter);
for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
  TABLE.set(letter, String.fromCharCode(letter.charCodeAt(0) + 32));
}
for (const digit of "0123456789") TABLE.set(digit, digit);
for (const [folded, variants] of FOLDED_GROUPS) {
  for (const variant of variants) TABLE.set(variant, folded);
}

const isCombiningMark = code => code >= 0x0300 && code <= 0x036f;

function word(text, start, end, normalized) {
  return Object.freeze({ normalized, original: text.slice(start, end), start, end });
}

// Mots normalisés d'un texte, dans l'ordre du texte. Un texte vide ou sans
// caractère de la table donne une liste vide. Contrat 4.2 : l'appelant fournit
// la version attendue ; toute divergence est refusée explicitement (verrou de
// versions, section 8), jamais remplacée silencieusement.
export function normalizeCoverageText(text, version) {
  if (version !== COVERAGE_NORMALIZATION_VERSION) {
    throw new Error(
      `Coverage Normalization : version "${String(version)}" refusée — ` +
      `version disponible ${COVERAGE_NORMALIZATION_VERSION} (verrou de versions).`
    );
  }

  if (typeof text !== "string") {
    throw new Error("Coverage Normalization : texte invalide (chaîne attendue).");
  }

  const words = [];
  let start = -1;
  let normalized = "";

  for (let index = 0; index < text.length; index += 1) {
    const folded = TABLE.get(text[index]);

    if (folded !== undefined) {
      if (start === -1) start = index;
      normalized += folded;
      continue;
    }

    if (start !== -1 && isCombiningMark(text.charCodeAt(index))) continue;

    if (start !== -1) {
      words.push(word(text, start, index, normalized));
      start = -1;
      normalized = "";
    }
  }

  if (start !== -1) words.push(word(text, start, text.length, normalized));

  return Object.freeze({
    version: COVERAGE_NORMALIZATION_VERSION,
    words: Object.freeze(words)
  });
}
