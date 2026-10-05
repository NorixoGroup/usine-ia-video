// R25.7D — frontière factuelle étroite, appliquée avant la couverture.
//
// Seules les phrases NON FACTUELLES PAR CONSTRUCTION sont retirées de
// l'analyse : questions, interpellations du spectateur, transitions pures.
// Toute autre phrase reste soumise au juge de couverture, même sans chiffre,
// unité, nom propre ni ancre Research (causalité, qualité, comparaison,
// description, histoire, géographie, climat, population). Règles
// structurelles fermées, sans modèle ni probabilité. Les phrases retenues
// sont des sous-chaînes exactes du voiceover.
//
// Règles, dans cet ordre (la première qui s'applique décide) :
//   1. chiffre présent                                   → ANALYSÉE (digit)
//   2. question (se termine par « ? »)                   → EXCLUE (question)
//   3. ouverture d'interpellation (liste fermée)         → EXCLUE (engagement)
//   4. transition pure : phrase complète (liste fermée)  → EXCLUE (transition)
//   5. sinon                                             → ANALYSÉE (assertion)

export const FACTUAL_BOUNDARY_PROTOCOL = "factual-boundary.v1-narrow";

// Premier mot de la phrase (minuscules, sans accents).
const ENGAGEMENT_OPENERS = new Set([
  "imaginez", "imaginons", "partons", "regardez", "regardons", "voyons",
  "suivons", "plongeons", "embarquons", "decouvrons", "ecoutez", "visualisez"
]);

// Phrases de transition complètes, fermées et non factuelles par construction.
// Un simple préfixe n'est pas suffisant : « Et pourtant, l'eau est rare » et
// « Voici une région aride » restent des assertions et doivent atteindre le
// juge. Les exemples avec complément sont donc volontairement explicites.
const PURE_TRANSITIONS = new Set([
  "ou plutot",
  "ou plutot son absence",
  "mais avant cela",
  "mais avant cela un detour",
  "avant cela",
  "avant cela un detour",
  "tout change ici",
  "et pourtant",
  "mais ce n est pas tout",
  "ce n est pas tout",
  "et ce n est pas tout",
  "place a",
  "mais alors",
  "et ensuite",
  "revenons",
  "passons",
  "continuons",
  "allons plus loin"
]);

const fold = text => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = text => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

// Découpage fixe en phrases (fin . ! ? …, ou reste final), sous-chaînes exactes.
export function splitSentences(text) {
  return (String(text ?? "").match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [])
    .map(part => part.trim())
    .filter(Boolean);
}

export function classifySentence(sentence) {
  const tokens = words(sentence);
  const opening = tokens.join(" ");

  if (/\d/.test(sentence)) return { sentence, factual: true, rule: "digit" };
  if (/\?\s*$/.test(sentence)) return { sentence, factual: false, rule: "question" };
  if (ENGAGEMENT_OPENERS.has(tokens[0])) return { sentence, factual: false, rule: "engagement" };
  if (PURE_TRANSITIONS.has(opening)) return { sentence, factual: false, rule: "transition" };

  return { sentence, factual: true, rule: "assertion" };
}

// Classement complet d'un voiceover. factual_voiceover : le voiceover
// inchangé si aucune phrase n'est exclue ; sinon les phrases analysées, dans
// l'ordre, jointes par une espace ("" si aucune).
export function classifyVoiceover(voiceover) {
  const text = String(voiceover ?? "").trim();
  const sentences = splitSentences(text).map(sentence => classifySentence(sentence));
  const kept = sentences.filter(item => item.factual);

  return {
    protocol: FACTUAL_BOUNDARY_PROTOCOL,
    sentences,
    factual_voiceover: kept.length === sentences.length ? text : kept.map(item => item.sentence).join(" ")
  };
}
