// Réducteur pur du protocole de réparation de couverture. Il ne lit ni
// checkpoint, ni cache, ni fournisseur : il classe uniquement deux constats.

export const REPAIR_STATUS = Object.freeze({
  CANDIDATE: "CANDIDATE",
  EMPTY_CANDIDATE: "EMPTY_CANDIDATE",
  HARD_FAILURE: "HARD_FAILURE"
});

export const COVERAGE_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL"
});

export const CLAIM_COVERAGE_REPAIR_OUTCOME = Object.freeze({
  REPAIRED: "REPAIRED",
  IRREPARABLE_EMPTY: "IRREPARABLE_EMPTY",
  IRREPARABLE_UNCOVERED: "IRREPARABLE_UNCOVERED",
  HARD_FAILURE: "HARD_FAILURE"
});

function fail(message) {
  throw new Error(`Claim Coverage Repair Outcome : ${message}`);
}

// Réduction fermée : EMPTY ne peut pas être recontrôlé, CANDIDATE doit l'être,
// HARD_FAILURE conserve le comportement fail-closed des opérations malformées.
export function classifyRepairOutcome({ repairStatus, coverageStatus = null }) {
  if (repairStatus === REPAIR_STATUS.HARD_FAILURE) {
    if (coverageStatus !== null) fail("HARD_FAILURE ne peut pas avoir de coverageStatus.");
    return CLAIM_COVERAGE_REPAIR_OUTCOME.HARD_FAILURE;
  }

  if (repairStatus === REPAIR_STATUS.EMPTY_CANDIDATE) {
    if (coverageStatus !== null) fail("EMPTY_CANDIDATE ne peut pas être recontrôlé.");
    return CLAIM_COVERAGE_REPAIR_OUTCOME.IRREPARABLE_EMPTY;
  }

  if (repairStatus === REPAIR_STATUS.CANDIDATE) {
    if (coverageStatus === COVERAGE_STATUS.PASS) {
      return CLAIM_COVERAGE_REPAIR_OUTCOME.REPAIRED;
    }
    if (coverageStatus === COVERAGE_STATUS.FAIL) {
      return CLAIM_COVERAGE_REPAIR_OUTCOME.IRREPARABLE_UNCOVERED;
    }
    fail("CANDIDATE exige coverageStatus PASS ou FAIL.");
  }

  fail(`repairStatus invalide (${repairStatus ?? "absent"}).`);
}
