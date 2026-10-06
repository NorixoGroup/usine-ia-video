// Smoke R26 : convergence bornée, sans fournisseur ni mutation de production.
import {
  assertCoverageFixpointBudget,
  convergeCoverageRepair,
  MAX_COVERAGE_FIXPOINT_ITERATIONS
} from "../src/agents/script.js";

import {
  REPAIR_STATUS,
  CLAIM_COVERAGE_REPAIR_OUTCOME
} from "../src/utils/classify-script-claim-coverage-repair-outcome.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  throw new Error("NO_API=1 et fixture-network-guard sont obligatoires.");
}

let passed = 0;
let failed = 0;

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}\n       ${error.message}`);
  }
}

const CLAIMS = [{ claim_id: "s1-g1-c1", text: "Fait approuvé." }];
const INITIAL_COVERAGE = {
  id: "s1-g1",
  claims: CLAIMS,
  covered: false,
  unsupported: [{ sentence: "Bruit un.", action: "DELETE", claim_id: "" }]
};

function candidateRepair(map) {
  return ({ voiceover }) => ({
    status: REPAIR_STATUS.CANDIDATE,
    voiceover: map.get(voiceover) ?? voiceover,
    operations: [{ sentence: "Bruit.", action: "DELETE", claim_id: "" }],
    diagnostics: { operation_count: 1, candidate_length: (map.get(voiceover) ?? voiceover).length },
    usage: null
  });
}

function coverage({ covered, unsupported = [] }) {
  return { covered, unsupported, undeclared_claims: unsupported, usage: null };
}

await test("PASS avant la limite : deux repairs, puis REPAIRED", async () => {
  const candidates = new Map([
    ["origine", "candidat-1"],
    ["candidat-1", "candidat-2"]
  ]);
  const rechecked = [];
  let repairCalls = 0;
  const baseRepair = candidateRepair(candidates);
  const result = await convergeCoverageRepair({
    voiceover: "origine",
    claims: CLAIMS,
    initialCoverage: INITIAL_COVERAGE,
    approvedFacts: [],
    id: "s1-g1",
    repair: input => {
      repairCalls += 1;
      assert(input.claims === CLAIMS, "les claims initiaux doivent rester visibles à chaque tour");
      return baseRepair(input);
    },
    recheck: async ({ voiceover }) => {
      rechecked.push(voiceover);
      return voiceover === "candidat-2"
        ? coverage({ covered: true })
        : coverage({ covered: false, unsupported: [{ sentence: "Bruit deux.", action: "DELETE", claim_id: "" }] });
    }
  });
  assert(result.outcome === CLAIM_COVERAGE_REPAIR_OUTCOME.REPAIRED, JSON.stringify(result));
  assert(result.iterations === 2, JSON.stringify(result));
  assert(rechecked.join("|") === "candidat-1|candidat-2", JSON.stringify(rechecked));
  assert(repairCalls === 2, `repairCalls=${repairCalls}`);
});

await test("hash candidat répété : arrêt sans recheck supplémentaire", async () => {
  let rechecks = 0;
  const result = await convergeCoverageRepair({
    voiceover: "origine",
    claims: CLAIMS,
    initialCoverage: INITIAL_COVERAGE,
    approvedFacts: [],
    id: "s1-g1",
    repair: candidateRepair(new Map([["origine", "origine"]])),
    recheck: async () => {
      rechecks += 1;
      return coverage({ covered: true });
    }
  });
  assert(result.outcome === CLAIM_COVERAGE_REPAIR_OUTCOME.IRREPARABLE_UNCOVERED, JSON.stringify(result));
  assert(result.terminal_reason === "CANDIDATE_HASH_CYCLE", JSON.stringify(result));
  assert(rechecks === 0, `rechecks=${rechecks}`);
});

await test("limite défensive : dix rechecks maximum, puis IRREPARABLE_UNCOVERED", async () => {
  let rechecks = 0;
  const result = await convergeCoverageRepair({
    voiceover: "origine",
    claims: CLAIMS,
    initialCoverage: INITIAL_COVERAGE,
    approvedFacts: [],
    id: "s1-g1",
    repair: ({ voiceover }) => ({
      status: REPAIR_STATUS.CANDIDATE,
      voiceover: `${voiceover}-nouveau`,
      operations: [{ sentence: "Bruit.", action: "DELETE", claim_id: "" }],
      diagnostics: {},
      usage: null
    }),
    recheck: async () => {
      rechecks += 1;
      return coverage({ covered: false, unsupported: [{ sentence: "Reste.", action: "DELETE", claim_id: "" }] });
    }
  });
  assert(result.outcome === CLAIM_COVERAGE_REPAIR_OUTCOME.IRREPARABLE_UNCOVERED, JSON.stringify(result));
  assert(result.terminal_reason === "MAX_ITERATIONS", JSON.stringify(result));
  assert(rechecks === MAX_COVERAGE_FIXPOINT_ITERATIONS, `rechecks=${rechecks}`);
});

await test("reprise dans une itération : mêmes candidats, cache réutilisé", async () => {
  const candidates = new Map([["origine", "candidat-1"], ["candidat-1", "candidat-2"]]);
  const cache = new Map();
  let providerCalls = 0;
  const recheck = async ({ voiceover }) => {
    if (cache.has(voiceover)) return cache.get(voiceover);
    providerCalls += 1;
    const result = voiceover === "candidat-2"
      ? coverage({ covered: true })
      : coverage({ covered: false, unsupported: [{ sentence: "Bruit deux.", action: "DELETE", claim_id: "" }] });
    cache.set(voiceover, result);
    return result;
  };
  const input = {
    voiceover: "origine",
    claims: CLAIMS,
    initialCoverage: INITIAL_COVERAGE,
    approvedFacts: [],
    id: "s1-g1",
    repair: candidateRepair(candidates),
    recheck
  };
  const first = await convergeCoverageRepair(input);
  const second = await convergeCoverageRepair(input);
  assert(first.outcome === second.outcome, "outcome de reprise différent");
  assert(JSON.stringify(first.candidate_hashes) === JSON.stringify(second.candidate_hashes), "hashes de reprise différents");
  assert(providerCalls === 2, `appels fournisseur=${providerCalls}`);
});

await test("budget insuffisant : arrêt avant tout recheck", async () => {
  let providerCalls = 0;
  let rejected = false;
  try {
    assertCoverageFixpointBudget({
      uncoveredSegmentCount: 1,
      preflight: () => { throw new Error("budget insuffisant"); }
    });
  } catch (error) {
    rejected = error.message === "budget insuffisant";
  }
  assert(rejected, "le préflight devait refuser");
  assert(providerCalls === 0, `appels fournisseur=${providerCalls}`);
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`claim-coverage-fixpoint-smoke — ${passed} PASS, ${failed} FAIL, réseau 0`);
process.exit(failed === 0 ? 0 : 1);
