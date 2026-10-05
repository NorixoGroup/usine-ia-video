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
      expectThrow(() => repair(entry), /unsupported\[0\]\.claim_id inconnu/);
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

test("action inconnue toujours refusée (juge et réparation)", () => {
  expectThrow(() => judge({ action: "REWRITE", claim_id: "s1-g1-c1" }), /action invalide/);
  expectThrow(() => repair({ action: "REWRITE", claim_id: "s1-g1-c1" }), /action invalide/);
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

const attempts = networkGuard.attempts().length;

console.log(`claim-coverage-protocol-smoke — ${passed} OK, ${failed} échec(s), tentatives réseau bloquées : ${attempts}`);
process.exit(failed === 0 && attempts === 0 ? 0 : 1);
