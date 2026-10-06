// Réparation déterministe de couverture. Le modèle ne rédige jamais de prose :
// il désigne une phrase exacte et une opération fermée, appliquée ici.

import { coverageOperationClaimId } from "./validate-script-claim-coverage.js";
import { REPAIR_STATUS } from "./classify-script-claim-coverage-repair-outcome.js";
export const CLAIM_COVERAGE_REPAIR_PROTOCOL =
  "claim-coverage-repair.v2-deterministic";

class RepairFailure extends Error {
  constructor(reason) {
    super(reason);
    this.name = "RepairFailure";
  }
}

function fail(reason) {
  throw new RepairFailure(reason);
}

function hardFailure(reason, operations = []) {
  return {
    status: REPAIR_STATUS.HARD_FAILURE,
    reason,
    operations,
    diagnostics: {
      operation_count: operations.length,
      candidate_length: null
    },
    protocol: CLAIM_COVERAGE_REPAIR_PROTOCOL,
    usage: null
  };
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;

  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function normalizeVoiceover(text) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([.!?])(?=[^\s])/g, "$1 ")
    .trim();
}

function normalizeClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0) {
    fail("claims doit être un tableau non vide.");
  }

  const ids = new Set();

  return claims.map((claim, index) => {
    if (!claim || typeof claim.claim_id !== "string" || !claim.claim_id.trim()) {
      fail(`claims[${index}].claim_id invalide.`);
    }
    if (ids.has(claim.claim_id)) fail(`claims[${index}].claim_id dupliqué.`);
    ids.add(claim.claim_id);

    if (typeof claim.text !== "string" || !claim.text.trim()) {
      fail(`claims[${index}].text invalide.`);
    }

    return { claim_id: claim.claim_id, text: claim.text.trim() };
  });
}

function normalizeUnsupported(unsupported, claimIds) {
  if (!Array.isArray(unsupported) || unsupported.length === 0) {
    fail("unsupported doit être un tableau non vide.");
  }

  const sentences = new Set();

  return unsupported.map((item, index) => {
    if (!item || typeof item.sentence !== "string" || !item.sentence.trim()) {
      fail(`unsupported[${index}].sentence invalide.`);
    }
    const sentence = item.sentence.trim();
    if (sentences.has(sentence)) fail(`unsupported[${index}].sentence dupliquée.`);
    sentences.add(sentence);

    if (item.action !== "DELETE" && item.action !== "DECLARE") {
      fail(`unsupported[${index}].action invalide.`);
    }
    // R25.7C : même règle que le juge — claim_id ignoré pour DELETE, exigé
    // et connu pour DECLARE.
    const claimId = coverageOperationClaimId(item, claimIds);
    if (claimId === undefined) {
      fail(`unsupported[${index}].claim_id inconnu.`);
    }

    return { sentence, claim_id: claimId, action: item.action };
  });
}

function approvedFactMap(approvedFacts, claimIds) {
  if (!Array.isArray(approvedFacts)) fail("approvedFacts doit être un tableau.");

  const facts = new Map();
  for (const [index, item] of approvedFacts.entries()) {
    if (!item || typeof item.claim_id !== "string" || !claimIds.has(item.claim_id)) {
      fail(`approvedFacts[${index}].claim_id invalide.`);
    }
    if (typeof item.key_fact !== "string" || !item.key_fact.trim()) {
      fail(`approvedFacts[${index}].key_fact invalide.`);
    }
    if (facts.has(item.claim_id)) fail(`approvedFacts[${index}].claim_id dupliqué.`);
    facts.set(item.claim_id, item.key_fact.trim());
  }
  return facts;
}

export function repairVoiceoverClaimCoverage({
  voiceover,
  claims,
  unsupported,
  approvedFacts
}) {
  let operations = [];

  try {
    if (typeof voiceover !== "string" || !voiceover.trim()) {
      fail("voiceover absent ou invalide.");
    }

    const normalizedClaims = normalizeClaims(claims);
    const claimIds = new Set(normalizedClaims.map(claim => claim.claim_id));
    operations = normalizeUnsupported(unsupported, claimIds);
    const facts = approvedFactMap(approvedFacts, claimIds);
    let repaired = voiceover.trim();

    for (const operation of operations) {
      // Sans offset dans le contrat fermé, une phrase répétée est ambiguë :
      // on échoue fermé au lieu de supprimer ou remplacer la mauvaise occurrence.
      if (countOccurrences(repaired, operation.sentence) !== 1) {
        fail(`phrase introuvable ou ambiguë : ${operation.sentence}`);
      }

      const replacement = operation.action === "DECLARE"
        ? facts.get(operation.claim_id)
        : "";

      if (operation.action === "DECLARE" && !replacement) {
        fail(`key_fact approuvé absent pour ${operation.claim_id}.`);
      }

      repaired = repaired.replace(operation.sentence, replacement ?? "");
    }

    // Les citations fournies par le juge sont des sous-chaînes exactes du
    // voiceover d'origine. Toute normalisation intermédiaire pourrait les
    // transformer avant l'opération suivante (notamment "..." -> ". . .").
    // On applique donc toutes les opérations fermées, puis normalise une fois.
    repaired = normalizeVoiceover(repaired);

    if (!repaired) {
      return {
        status: REPAIR_STATUS.EMPTY_CANDIDATE,
        operations,
        diagnostics: {
          operation_count: operations.length,
          candidate_length: 0
        },
        protocol: CLAIM_COVERAGE_REPAIR_PROTOCOL,
        usage: null
      };
    }

    return {
      status: REPAIR_STATUS.CANDIDATE,
      voiceover: repaired,
      operations,
      diagnostics: {
        operation_count: operations.length,
        candidate_length: repaired.length
      },
      protocol: CLAIM_COVERAGE_REPAIR_PROTOCOL,
      usage: null
    };
  } catch (error) {
    if (error instanceof RepairFailure) {
      return hardFailure(error.message, operations);
    }
    throw error;
  }
}
