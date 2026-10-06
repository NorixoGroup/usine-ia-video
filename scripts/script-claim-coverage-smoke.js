// Smoke du contrat fermé : fixture locale pour le juge, réparation 100 % code.
import { networkGuard } from "./fixture-network-guard.js";
import { validateVoiceoverClaimCoverage } from "../src/utils/validate-script-claim-coverage.js";
import { repairVoiceoverClaimCoverage } from "../src/utils/repair-script-claim-coverage.js";
import { REPAIR_STATUS } from "../src/utils/classify-script-claim-coverage-repair-outcome.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");
process.env.ANTHROPIC_FIXTURES = "1";

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

const claim = "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.";
const original = `${claim} L'eau y est rare.`;
const claimRecord = [{ claim_id: "s1-g1-c1", text: claim }];

await test("juge : retourne une citation exacte et une action fermée", async () => {
  const result = await validateVoiceoverClaimCoverage({ voiceover: original, claims: [{ text: claim }], id: "s1-g1" });
  assert(!result.covered && result.unsupported.length === 1, JSON.stringify(result));
  assert(result.unsupported[0].sentence === "L'eau y est rare.", JSON.stringify(result));
  assert(result.unsupported[0].segment_id === "s1-g1", JSON.stringify(result));
  assert(result.unsupported[0].claim_id === "s1-g1-c1" && result.unsupported[0].action === "DELETE", JSON.stringify(result));
});

await test("DELETE : enlève seulement la citation exacte sans appel fournisseur", () => {
  const repaired = repairVoiceoverClaimCoverage({
    voiceover: original,
    claims: claimRecord,
    unsupported: [{ sentence: "L'eau y est rare.", segment_id: "s1-g1", claim_id: "s1-g1-c1", action: "DELETE" }],
    approvedFacts: [{ claim_id: "s1-g1-c1", key_fact: claim }]
  });
  assert(repaired.voiceover === claim, repaired.voiceover);
  assert(repaired.usage === null && repaired.operations.length === 1, JSON.stringify(repaired));
});

await test("DECLARE : remplace textuellement par le key_fact approuvé", () => {
  const repaired = repairVoiceoverClaimCoverage({
    voiceover: "Une formulation non soutenue.",
    claims: claimRecord,
    unsupported: [{ sentence: "Une formulation non soutenue.", segment_id: "s1-g1", claim_id: "s1-g1-c1", action: "DECLARE" }],
    approvedFacts: [{ claim_id: "s1-g1-c1", key_fact: claim }]
  });
  assert(repaired.voiceover === claim, repaired.voiceover);
});

await test("fail-closed : phrase absente ou claim inconnu devient HARD_FAILURE", () => {
  let failures = 0;
  for (const unsupported of [
    [{ sentence: "Absente.", segment_id: "s1-g1", claim_id: "s1-g1-c1", action: "DELETE" }],
    // R25.7C : DELETE ignore claim_id ; seul DECLARE exige un claim_id connu.
    [{ sentence: "L'eau y est rare.", segment_id: "s1-g1", claim_id: "inconnu", action: "DECLARE" }]
  ]) {
    const result = repairVoiceoverClaimCoverage({ voiceover: original, claims: claimRecord, unsupported, approvedFacts: [{ claim_id: "s1-g1-c1", key_fact: claim }] });
    if (result.status === REPAIR_STATUS.HARD_FAILURE && result.reason) failures += 1;
  }
  assert(failures === 2, `hard failures=${failures}`);
});

await test("deux DELETE à ellipses s'appliquent avant la normalisation finale", () => {
  const voiceover = "Premier... fragment. Entre les deux. Second... fragment.";
  const repaired = repairVoiceoverClaimCoverage({
    voiceover,
    claims: claimRecord,
    unsupported: [
      { sentence: "Premier... fragment.", segment_id: "s1-g1", claim_id: "", action: "DELETE" },
      { sentence: "Second... fragment.", segment_id: "s1-g1", claim_id: "", action: "DELETE" }
    ],
    approvedFacts: []
  });
  assert(repaired.voiceover === "Entre les deux.", repaired.voiceover);
});

await test("DELETE + DECLARE + DELETE normalise une seule fois après toutes les opérations", () => {
  const voiceover = "Avant... après. À supprimer. À déclarer. Fin... ici.";
  const repaired = repairVoiceoverClaimCoverage({
    voiceover,
    claims: claimRecord,
    unsupported: [
      { sentence: "À supprimer.", segment_id: "s1-g1", claim_id: "", action: "DELETE" },
      { sentence: "À déclarer.", segment_id: "s1-g1", claim_id: "s1-g1-c1", action: "DECLARE" },
      { sentence: "Fin... ici.", segment_id: "s1-g1", claim_id: "", action: "DELETE" }
    ],
    approvedFacts: [{ claim_id: "s1-g1-c1", key_fact: "Fait approuvé." }]
  });
  assert(repaired.voiceover === "Avant. . . après. Fait approuvé.", repaired.voiceover);
});

await test("fail-closed : une citation répétée devient HARD_FAILURE", () => {
  const result = repairVoiceoverClaimCoverage({
    voiceover: "Réponse. Réponse.",
    claims: claimRecord,
    unsupported: [{ sentence: "Réponse.", segment_id: "s1-g1", claim_id: "", action: "DELETE" }],
    approvedFacts: []
  });
  assert(result.status === REPAIR_STATUS.HARD_FAILURE, JSON.stringify(result));
  assert(result.reason.includes("phrase introuvable ou ambiguë"), result.reason);
});

await test("fail-closed : une citation absente devient HARD_FAILURE", () => {
  const result = repairVoiceoverClaimCoverage({
    voiceover: "Présente.",
    claims: claimRecord,
    unsupported: [{ sentence: "Absente.", segment_id: "s1-g1", claim_id: "", action: "DELETE" }],
    approvedFacts: []
  });
  assert(result.status === REPAIR_STATUS.HARD_FAILURE, JSON.stringify(result));
  assert(result.reason.includes("phrase introuvable ou ambiguë"), result.reason);
});

await test("ponctuation ordinaire : comportement de normalisation préservé", () => {
  const repaired = repairVoiceoverClaimCoverage({
    voiceover: "Une phrase.  Une autre !",
    claims: claimRecord,
    unsupported: [{ sentence: "Une autre !", segment_id: "s1-g1", claim_id: "", action: "DELETE" }],
    approvedFacts: []
  });
  assert(repaired.voiceover === "Une phrase.", repaired.voiceover);
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
delete process.env.ANTHROPIC_FIXTURES;
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
