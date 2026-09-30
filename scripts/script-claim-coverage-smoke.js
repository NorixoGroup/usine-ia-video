import {
  validateVoiceoverClaimCoverage
} from "../src/utils/validate-script-claim-coverage.js";

import {
  repairVoiceoverClaimCoverage
} from "../src/utils/repair-script-claim-coverage.js";

const cases = [
  {
    name: "fait supplémentaire caché",
    voiceover:
      "Une grande partie du territoire australien est constituée de régions arides ou semi-arides. L'eau y est rare.",
    claims: [
      {
        text:
          "Une grande partie du territoire australien est constituée de régions arides ou semi-arides."
      }
    ]
  },

  {
    name: "causalité cachée",
    voiceover:
      "Une grande partie du territoire australien est constituée de régions arides ou semi-arides. Ces conditions expliquent pourquoi ces régions restent peu peuplées.",
    claims: [
      {
        text:
          "Une grande partie du territoire australien est constituée de régions arides ou semi-arides."
      }
    ]
  },

  {
    name: "fait déjà correctement couvert",
    voiceover:
      "La population australienne est fortement concentrée dans les grandes zones urbaines et côtières.",
    claims: [
      {
        text:
          "La population australienne est fortement concentrée dans les grandes zones urbaines et côtières."
      }
    ],
    alreadyCovered: true
  }
];

let failed = false;

for (const test of cases) {
  console.log("");
  console.log("========================================");
  console.log("CAS :", test.name);
  console.log("========================================");

  const before =
    await validateVoiceoverClaimCoverage({
      voiceover: test.voiceover,
      claims: test.claims
    });

  console.log(
    "Coverage initial :",
    before.covered ? "PASS" : "BLOQUE"
  );

  console.log(
    "Undeclared initial :",
    before.undeclared_claims.length
  );

  if (test.alreadyCovered) {
    if (
      before.covered !== true ||
      before.undeclared_claims.length !== 0
    ) {
      console.error(
        "FAIL — un voiceover correctement couvert a été rejeté."
      );
      failed = true;
    } else {
      console.log(
        "PASS — voiceover déjà couvert accepté sans réparation."
      );
    }

    continue;
  }

  if (
    before.covered !== false ||
    before.undeclared_claims.length === 0
  ) {
    console.error(
      "FAIL — le Coverage Gate n'a pas détecté la régression."
    );
    failed = true;
    continue;
  }

  const repaired =
    await repairVoiceoverClaimCoverage({
      voiceover: test.voiceover,
      claims: test.claims,
      undeclaredClaims:
        before.undeclared_claims
    });

  const after =
    await validateVoiceoverClaimCoverage({
      voiceover: repaired.voiceover,
      claims: test.claims
    });

  console.log("");
  console.log("Voiceover réparé :");
  console.log(repaired.voiceover);

  console.log("");
  console.log(
    "Coverage final :",
    after.covered ? "PASS" : "BLOQUE"
  );

  console.log(
    "Undeclared final :",
    after.undeclared_claims.length
  );

  if (
    after.covered !== true ||
    after.undeclared_claims.length !== 0
  ) {
    console.error(
      "FAIL — Auto-Repair insuffisant."
    );
    failed = true;
  } else {
    console.log(
      "PASS — détection + réparation + revalidation."
    );
  }
}

console.log("");
console.log("========================================");

if (failed) {
  console.error(
    "RESULTAT GLOBAL : FAIL — régression Claim Coverage"
  );
  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — Claim Coverage + Auto-Repair protégés"
);

process.exit(0);
