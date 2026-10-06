// Smoke R25.7C — cohérence du protocole de couverture (claim_id), zéro API.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/claim-coverage-protocol-smoke.js
//
// DELETE ne référence aucun key_fact : claim_id est facultatif et ignoré.
// DECLARE exige un claim_id connu ; sinon échec fermé. La même règle vaut
// pour le juge (validateClaimBatchResponse) et la réparation déterministe.

import {
  validateClaimBatchResponse,
  coverageOperationClaimId
} from "../src/utils/validate-script-claim-coverage.js";
import { repairVoiceoverClaimCoverage } from "../src/utils/repair-script-claim-coverage.js";
import {
  classifyRepairOutcome,
  REPAIR_STATUS,
  COVERAGE_STATUS,
  CLAIM_COVERAGE_REPAIR_OUTCOME
} from "../src/utils/classify-script-claim-coverage-repair-outcome.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error("FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

function expectThrow(fn, pattern) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert(error, "une erreur était attendue");
  assert(pattern.test(error.message), `erreur inattendue : ${error.message}`);
}

const VOICEOVER = "L'Australie compte 3,6 habitants au kilomètre carré. Elle est la plus vide du monde.";
const SENTENCE = "Elle est la plus vide du monde.";
const ITEM = {
  id: "s1-g1",
  voiceover: VOICEOVER,
  claims: [{ claim_id: "s1-g1-c1", text: "L'Australie compte 3,6 habitants au kilomètre carré." }]
};
const KEY_FACT = "La densité de population de l'Australie était de 3,6 personnes par km² en juin 2025.";

// Fixtures de réponses fournisseur : chaque variante est une citation
// non-littérale que le contrat prompt interdit et que le validateur rejette
// fail-closed avant toute réparation.
const QUOTATION_VOICEOVER = "Quatre contraintes qui expliquent pourquoi l'Australie, sixième plus grand pays de la planète, demeure l'un des plus vides.";
const QUOTATION_ITEM = {
  id: "s1-g6",
  voiceover: QUOTATION_VOICEOVER,
  claims: [{ claim_id: "s1-g6-c1", text: "L'Australie est peu peuplée." }]
};

function providerQuotation(sentence) {
  return validateClaimBatchResponse({
    results: [{
      id: "s1-g6",
      covered: false,
      unsupported: [{ sentence, segment_id: "s1-g6", claim_id: "", action: "DELETE" }]
    }]
  }, [QUOTATION_ITEM]);
}

function judge(entry) {
  return validateClaimBatchResponse({
    results: [{ id: "s1-g1", covered: false, unsupported: [{ sentence: SENTENCE, segment_id: "s1-g1", ...entry }] }]
  }, [ITEM]);
}

function repair(entry) {
  return repairVoiceoverClaimCoverage({
    voiceover: VOICEOVER,
    claims: ITEM.claims,
    unsupported: [{ sentence: SENTENCE, ...entry }],
    approvedFacts: [{ claim_id: "s1-g1-c1", key_fact: KEY_FACT }]
  });
}

const CASES = [
  ["DELETE avec claim_id vide", { action: "DELETE", claim_id: "" }, "pass"],
  ["DELETE sans claim_id", { action: "DELETE" }, "pass"],
  ["DELETE avec claim_id inconnu (ignoré)", { action: "DELETE", claim_id: "s9-g9-c9" }, "pass"],
  ["DECLARE sans claim_id", { action: "DECLARE" }, "fail"],
  ["DECLARE avec claim_id inconnu", { action: "DECLARE", claim_id: "s9-g9-c9" }, "fail"],
  ["DECLARE avec claim_id valide", { action: "DECLARE", claim_id: "s1-g1-c1" }, "pass"]
];

console.log("--- 1. Juge (validateClaimBatchResponse) ---");

for (const [name, entry, expected] of CASES) {
  test(`juge : ${name} → ${expected.toUpperCase()}`, () => {
    if (expected === "fail") {
      expectThrow(() => judge(entry), /s1-g1\.unsupported\[0\]\.claim_id inconnu/);
      return;
    }
    const [result] = judge(entry);
    const operation = result.unsupported[0];
    assert(result.covered === false && operation.sentence === SENTENCE && operation.action === entry.action, JSON.stringify(result));
    // DELETE : claim_id ignoré (recopié tel quel, jamais vérifié) ; DECLARE : claim_id connu.
    assert(operation.claim_id === (entry.action === "DELETE" ? (entry.claim_id ?? null) : "s1-g1-c1"), `claim_id inattendu : ${operation.claim_id}`);
  });
}

console.log("--- 2. Réparation déterministe (même règle) ---");

for (const [name, entry, expected] of CASES) {
  test(`réparation : ${name} → ${expected.toUpperCase()}`, () => {
    if (expected === "fail") {
      const result = repair(entry);
      assert(result.status === REPAIR_STATUS.HARD_FAILURE, JSON.stringify(result));
      assert(/unsupported\[0\]\.claim_id inconnu/.test(result.reason), result.reason);
      return;
    }
    const result = repair(entry);
    if (entry.action === "DELETE") {
      assert(result.voiceover === "L'Australie compte 3,6 habitants au kilomètre carré.", result.voiceover);
      assert(result.operations[0].claim_id === (entry.claim_id ?? null), "claim_id DELETE modifié");
    } else {
      assert(result.voiceover === `L'Australie compte 3,6 habitants au kilomètre carré. ${KEY_FACT}`, result.voiceover);
      assert(result.operations[0].claim_id === "s1-g1-c1", "claim_id DECLARE perdu");
    }
  });
}

console.log("--- 3. Fail-closed et déterminisme ---");

for (const [name, sentence] of [
  ["clause partielle", "L'Australie, sixième plus grand pays de la planète, demeure l'un des plus vides."],
  ["changement de casse", "Quatre contraintes qui expliquent pourquoi L'Australie, sixième plus grand pays de la planète, demeure l'un des plus vides."],
  ["préfixe retiré", "Contraintes qui expliquent pourquoi l'Australie, sixième plus grand pays de la planète, demeure l'un des plus vides."],
  ["suffixe retiré", "Quatre contraintes qui expliquent pourquoi l'Australie, sixième plus grand pays de la planète."],
  ["phrase réécrite", "Les contraintes expliquent que l'Australie demeure l'un des pays les plus vides."]
]) {
  test(`fixture fournisseur : ${name} → FAIL`, () => {
    expectThrow(() => providerQuotation(sentence), /s1-g6\.unsupported\[0\]\.sentence absente du voiceover/);
  });
}

test("action inconnue : juge refusé, réparation HARD_FAILURE", () => {
  expectThrow(() => judge({ action: "REWRITE", claim_id: "s1-g1-c1" }), /action invalide/);
  const result = repair({ action: "REWRITE", claim_id: "s1-g1-c1" });
  assert(result.status === REPAIR_STATUS.HARD_FAILURE, JSON.stringify(result));
  assert(result.reason.includes("action invalide"), result.reason);
});

test("règle unique : coverageOperationClaimId est pure et identique pour juge et réparation", () => {
  const ids = new Set(["s1-g1-c1"]);
  for (const [, entry] of CASES) {
    const first = coverageOperationClaimId(entry, ids);
    assert(first === coverageOperationClaimId(entry, ids), "non déterministe");
    const judged = (() => { try { return judge(entry)[0].unsupported[0].claim_id; } catch { return undefined; } })();
    const repaired = (() => { try { return repair(entry).operations[0].claim_id; } catch { return undefined; } })();
    assert(judged === first && repaired === first, `${JSON.stringify(entry)} : ${judged} / ${repaired} / ${first}`);
  }
});

test("mêmes entrées → sorties identiques (deux exécutions)", () => {
  for (const [, entry, expected] of CASES) {
    if (expected === "fail") continue;
    assert(JSON.stringify(judge(entry)) === JSON.stringify(judge(entry)), "juge non déterministe");
    assert(JSON.stringify(repair(entry)) === JSON.stringify(repair(entry)), "réparation non déterministe");
  }
});

test("plan complet : deux phrases non couvertes sont toutes deux conservées", () => {
  const item = {
    id: "s9-g1",
    voiceover: "Fait approuvé. Fait non couvert un. Fait non couvert deux.",
    claims: [{ claim_id: "s9-g1-c1", text: "Fait approuvé." }]
  };
  const unsupported = ["Fait non couvert un.", "Fait non couvert deux."];
  const [result] = validateClaimBatchResponse({
    results: [{
      id: item.id,
      covered: false,
      unsupported: unsupported.map(sentence => ({
        sentence,
        segment_id: item.id,
        claim_id: "",
        action: "DELETE"
      }))
    }]
  }, [item]);
  assert(result.unsupported.length === 2, JSON.stringify(result));
  assert(result.unsupported.map(entry => entry.sentence).join("|") === unsupported.join("|"), JSON.stringify(result));
});

test("plan complet : trois phrases non couvertes, sans doublon ni phrase supportée", () => {
  const item = {
    id: "s9-g2",
    voiceover: "Fait approuvé. Bruit un. Fait approuvé encore. Bruit deux. Bruit trois.",
    claims: [{ claim_id: "s9-g2-c1", text: "Fait approuvé." }]
  };
  const unsupported = ["Bruit un.", "Bruit deux.", "Bruit trois."];
  const [result] = validateClaimBatchResponse({
    results: [{
      id: item.id,
      covered: false,
      unsupported: unsupported.map(sentence => ({
        sentence,
        segment_id: item.id,
        claim_id: "",
        action: "DELETE"
      }))
    }]
  }, [item]);
  assert(result.unsupported.length === 3, JSON.stringify(result));
  assert(!result.unsupported.some(entry => entry.sentence === "Fait approuvé."), JSON.stringify(result));
  assert(new Set(result.unsupported.map(entry => entry.sentence)).size === 3, JSON.stringify(result));
});

test("plan minimal : DELETE dupliqué refusé fail-closed", () => {
  const item = {
    id: "s9-g3",
    voiceover: "Fait approuvé. Bruit unique.",
    claims: [{ claim_id: "s9-g3-c1", text: "Fait approuvé." }]
  };
  expectThrow(() => validateClaimBatchResponse({
    results: [{
      id: item.id,
      covered: false,
      unsupported: ["Bruit unique.", "Bruit unique."].map(sentence => ({
        sentence,
        segment_id: item.id,
        claim_id: "",
        action: "DELETE"
      }))
    }]
  }, [item]), /sentence dupliquée/);
});

console.log("--- 4. Coordinateur déterministe des issues de réparation ---");

test("CANDIDATE + PASS → REPAIRED", () => {
  assert(
    classifyRepairOutcome({ repairStatus: REPAIR_STATUS.CANDIDATE, coverageStatus: COVERAGE_STATUS.PASS }) ===
      CLAIM_COVERAGE_REPAIR_OUTCOME.REPAIRED,
    "issue inattendue"
  );
});

test("CANDIDATE + FAIL → IRREPARABLE_UNCOVERED", () => {
  assert(
    classifyRepairOutcome({ repairStatus: REPAIR_STATUS.CANDIDATE, coverageStatus: COVERAGE_STATUS.FAIL }) ===
      CLAIM_COVERAGE_REPAIR_OUTCOME.IRREPARABLE_UNCOVERED,
    "issue inattendue"
  );
});

test("EMPTY_CANDIDATE → IRREPARABLE_EMPTY", () => {
  assert(
    classifyRepairOutcome({ repairStatus: REPAIR_STATUS.EMPTY_CANDIDATE }) ===
      CLAIM_COVERAGE_REPAIR_OUTCOME.IRREPARABLE_EMPTY,
    "issue inattendue"
  );
});

test("HARD_FAILURE → HARD_FAILURE", () => {
  assert(
    classifyRepairOutcome({ repairStatus: REPAIR_STATUS.HARD_FAILURE }) ===
      CLAIM_COVERAGE_REPAIR_OUTCOME.HARD_FAILURE,
    "issue inattendue"
  );
});

test("réparation malformée → HARD_FAILURE structuré puis coordinateur", () => {
  const result = repair({ action: "DECLARE", claim_id: "s9-g9-c9" });
  assert(result.status === REPAIR_STATUS.HARD_FAILURE, JSON.stringify(result));
  assert(result.reason.includes("claim_id inconnu"), result.reason);
  assert(
    classifyRepairOutcome({ repairStatus: result.status }) ===
      CLAIM_COVERAGE_REPAIR_OUTCOME.HARD_FAILURE,
    "le coordinateur doit être l'unique propriétaire de l'issue finale"
  );
});

test("réparation HARD_FAILURE ne lance aucune exception de protocole", () => {
  let threw = false;
  let result;
  try {
    result = repair({ action: "REWRITE", claim_id: "s1-g1-c1" });
  } catch {
    threw = true;
  }
  assert(!threw, "la réparation ne doit pas lever une exception de protocole");
  assert(result.status === REPAIR_STATUS.HARD_FAILURE, JSON.stringify(result));
});

test("coordinateur pur : mêmes entrées → même sortie", () => {
  const input = { repairStatus: REPAIR_STATUS.CANDIDATE, coverageStatus: COVERAGE_STATUS.FAIL };
  assert(
    classifyRepairOutcome(input) === classifyRepairOutcome(structuredClone(input)),
    "coordinateur non déterministe"
  );
});

test("réparation : suppression totale → EMPTY_CANDIDATE sans exception", () => {
  const result = repairVoiceoverClaimCoverage({
    voiceover: "Affirmation non soutenue.",
    claims: ITEM.claims,
    unsupported: [{ sentence: "Affirmation non soutenue.", segment_id: "s1-g1", claim_id: "", action: "DELETE" }],
    approvedFacts: []
  });
  assert(result.status === REPAIR_STATUS.EMPTY_CANDIDATE, JSON.stringify(result));
  assert(result.diagnostics.candidate_length === 0, JSON.stringify(result));
});

const attempts = networkGuard.attempts().length;

console.log(`claim-coverage-protocol-smoke — ${passed} OK, ${failed} échec(s), tentatives réseau bloquées : ${attempts}`);
process.exit(failed === 0 && attempts === 0 ? 0 : 1);
