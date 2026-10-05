// Smoke R25.7D — frontière factuelle étroite avant la couverture, zéro API.
// Seules les questions, interpellations et transitions pures sont exclues ;
// toute assertion sur le monde reste soumise au juge.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/factual-boundary-smoke.js

import {
  classifySentence,
  classifyVoiceover,
  splitSentences
} from "../src/utils/factual-boundary.js";
import {
  planClaimValidationBatches,
  estimateClaimValidationCalls,
  validateVoiceoverClaimCoverage
} from "../src/utils/validate-script-claim-coverage.js";

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const expectClass = (sentence, factual, rule) => {
  const result = classifySentence(sentence);
  assert(result.factual === factual && result.rule === rule, `${sentence} → ${JSON.stringify(result)}`);
};

console.log("--- 1. Frontière étroite : exclusions certaines seulement ---");

await test("question exclue", () => {
  expectClass("Alors pourquoi ce vide ?", false, "question");
  expectClass("Comment l'Australie est-elle devenue si concentrée ?", false, "question");
});

await test("ouverture d'interpellation exclue", () => {
  expectClass("Imaginez un pays grand comme l'Europe.", false, "engagement");
  expectClass("Partons maintenant vers l'intérieur.", false, "engagement");
});

await test("transition pure exclue (phrase fermée)", () => {
  expectClass("Tout change ici.", false, "transition");
  expectClass("Ou plutôt, son absence.", false, "transition");
  expectClass("Mais avant cela, un détour.", false, "transition");
});

await test("toute assertion sur le monde reste analysée, même sans chiffre, unité, nom propre ni ancre", () => {
  for (const sentence of [
    "L'eau y est rare.",
    "Ces conditions expliquent pourquoi ces régions restent peu peuplées.",
    "L'intérieur australien n'est pas un désert uniforme et mort.",
    "Une concentration littorale transforme ce continent en un anneau humain.",
    "Et pourtant, l'eau y est rare.",
    "Voici une région aride.",
    "Elle est la plus vide du monde.",
    "Les précipitations y sont très faibles."
  ]) expectClass(sentence, true, "assertion");
});

await test("une transition longue ou une question chiffrée reste analysée", () => {
  expectClass("Et pourtant, la population se concentre presque entièrement sur les côtes du sud-est.", true, "assertion");
  expectClass("Pourquoi 95 % du territoire est-il presque vide ?", true, "digit");
});

await test("découpage : phrases exactes, sous-chaînes du voiceover, ordre conservé", () => {
  const voiceover = "Imaginez un pays immense. L'Australie compte 3,6 habitants par km². Pourquoi ? Tout change ici.";
  const sentences = splitSentences(voiceover);
  assert(sentences.join("|") === "Imaginez un pays immense.|L'Australie compte 3,6 habitants par km².|Pourquoi ?|Tout change ici.", sentences.join("|"));
  assert(sentences.every(sentence => voiceover.includes(sentence)), "phrase non exacte");
  const classified = classifyVoiceover(voiceover);
  assert(classified.factual_voiceover === "L'Australie compte 3,6 habitants par km².", classified.factual_voiceover);
  const untouched = "L'eau y est rare.  Les précipitations y sont très faibles.";
  assert(classifyVoiceover(untouched).factual_voiceover === untouched, "voiceover modifié alors qu'aucune phrase n'est exclue");
});

console.log("--- 2. Déterminisme et planificateur ---");

const CLAIM = [{ text: "Le Murray-Darling Basin couvre environ un million de kilomètres carrés dans le sud-est de l'Australie." }];

const script = {
  sections: [{
    segments: [
      { voiceover: "Imaginez un pays immense. Tout change ici. Pourquoi ?", claims: [{ text: "L'Australie compte 3,6 habitants par km²." }] },
      { voiceover: "Partons. L'Australie compte 3,6 habitants par km². Ou plutôt, son absence.", claims: [{ text: "L'Australie compte 3,6 habitants par km²." }] },
      { voiceover: "Le Murray-Darling Basin couvre environ un million de kilomètres carrés.", claims: CLAIM }
    ]
  }]
};

await test("même entrée → mêmes items classés (deux exécutions, copie profonde)", () => {
  const first = planClaimValidationBatches(script);
  const second = planClaimValidationBatches(structuredClone(script));
  assert(JSON.stringify(first) === JSON.stringify(second), "plan non déterministe");
  assert(JSON.stringify(classifyVoiceover(script.sections[0].segments[1].voiceover)) === JSON.stringify(classifyVoiceover(script.sections[0].segments[1].voiceover)), "classement non déterministe");
});

await test("le planificateur reçoit moins d'items et moins de texte qu'avant", () => {
  const plan = planClaimValidationBatches(script);
  assert(plan.items.length === 2 && plan.bypassed.length === 1 && plan.bypassed[0].label === "sections[0].segments[0]", JSON.stringify({ items: plan.items.length, bypassed: plan.bypassed }));
  assert(plan.items[0].voiceover === "L'Australie compte 3,6 habitants par km².", plan.items[0].voiceover);
  const full = script.sections[0].segments.reduce((n, s) => n + s.voiceover.length, 0);
  const sent = plan.items.reduce((n, item) => n + item.voiceover.length, 0);
  assert(sent < full, `${sent} ≥ ${full}`);
  const estimate = estimateClaimValidationCalls({ script });
  assert(estimate.item_count === 2 && estimate.bypassed_count === 1, JSON.stringify(estimate));
  assert(JSON.stringify(plan.order) === JSON.stringify(["sections[0].segments[0]", "sections[0].segments[1]", "sections[0].segments[2]"]), "ordre source perdu");
});

await test("recheck d'un voiceover sans phrase factuelle : couvert sans appel au juge", async () => {
  const result = await validateVoiceoverClaimCoverage({ voiceover: "Imaginez un pays immense. Tout change ici.", claims: [{ text: "L'Australie compte 3,6 habitants par km²." }] });
  assert(result.covered === true && result.bypassed === true && result.usage === null, JSON.stringify(result));
});

const attempts = networkGuard.attempts().length;

console.log(`factual-boundary-smoke — ${passed} OK, ${failed} échec(s), tentatives réseau bloquées : ${attempts}`);
process.exit(failed === 0 && attempts === 0 ? 0 : 1);
