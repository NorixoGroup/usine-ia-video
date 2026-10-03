// Smoke dédié à l'invariant Fact ↔ Evidence (R20.4, phase E) — zéro API,
// zéro réseau, aucun fichier.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/fact-evidence-invariant-smoke.js
//
// Invariant : un fait vérifié disposant d'au moins une preuve lue ne termine
// JAMAIS avec l'état « not_checked ». Il finit toujours supported,
// partially_supported, rejected ou unverifiable.
//
// Le smoke échoue immédiatement si l'état réapparaît :
// 1. balayage combinatoire de toutes les situations connues (statuts
//    techniques, éléments trouvés ou absents, extraits, juge, suspension) ;
// 2. garde statique : le code source ne peut produire « not_checked » que
//    dans les deux branches où aucune preuve n'a été lue ;
// 3. garde d'exécution : l'évaluation elle-même lève une erreur si
//    l'invariant est violé.

import fs from "node:fs";

import { networkGuard } from "./fixture-network-guard.js";
import {
  TECHNICAL_STATUSES,
  buildEvidenceJudgeItems,
  evaluateFactEvidence
} from "../src/utils/fact-evidence.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");

let passed = 0;
let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS — ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL — ${name}\n       ${error.message}`); }
}

console.log("FACT ↔ EVIDENCE — INVARIANT not_checked (ZERO API, ZERO RÉSEAU)");

const ALLOWED_WHEN_READ = new Set(["supported", "partially_supported", "rejected", "unverifiable"]);
const filler = "Phrase documentaire de remplissage sans rapport avec le sujet. ".repeat(5);

// Textes de preuve simulés (en mémoire, aucune lecture réseau ni disque).
const TEXTS = {
  matching: `Les régions intérieures australiennes comptent 2 % de la population. ${filler}`,
  other_figure: `Les régions intérieures australiennes comptent 5 % de la population. ${filler}`,
  english: `Australia is a dry continent with very little rainfall inland. ${"Plain English filler sentence. ".repeat(10)}`
};

const CLAIMS = {
  figure: "Les régions intérieures australiennes comptent 2 % de la population",
  no_figure: "Les régions intérieures australiennes sont peu peuplées",
  quote: "Le rapport parle de « régions intérieures australiennes »",
  french_only: "Les courants océaniques froids empêchent les pluies de pénétrer"
};

const JUDGE_CASES = ["none", "supported_good_quote", "supported_bad_quote", "partially_supported", "not_supported"];
const SKIP_CASES = [null, "hiérarchie des sources à résoudre d'abord"];
const READ_STATUSES = TECHNICAL_STATUSES.filter(status => status !== "fetched");

function scenario({ claim, textKey, secondStatus, judge, skipReason, verification, importance }) {
  const urlA = "https://www.bom.gov.au/a";
  const urlB = "https://www.bom.gov.au/b";
  const research = {
    key_facts: [{
      claim,
      importance,
      verification_status: verification,
      sources: [
        { title: "t", url: urlA, publisher: "p", source_type: "secondary", supports_claim: "c" },
        ...(secondStatus ? [{ title: "t", url: urlB, publisher: "p", source_type: "secondary", supports_claim: "c" }] : [])
      ]
    }]
  };
  const evidence = {
    schema: "evidence.v1",
    sources: [
      { url: urlA, technical_status: "fetched", fetched_at: "2026-10-03T12:00:00.000Z", text_sha256: "0".repeat(64), http_status: 200 },
      ...(secondStatus ? [{ url: urlB, technical_status: secondStatus, fetched_at: "2026-10-03T12:00:00.000Z", text_sha256: secondStatus === "fetched" ? "1".repeat(64) : null, http_status: 200 }] : [])
    ]
  };
  const texts = new Map([[urlA, TEXTS[textKey]], ...(secondStatus === "fetched" ? [[urlB, TEXTS[textKey]]] : [])]);
  const items = buildEvidenceJudgeItems({ research, evidence, texts });
  const excerpt = items[0]?.excerpts[0];
  const judgements = new Map();

  if (judge !== "none" && items.length > 0) {
    judgements.set("f1", {
      id: "f1",
      status: judge === "supported_good_quote" || judge === "supported_bad_quote" ? "supported" : judge,
      source: judge === "not_supported" ? "" : (excerpt?.id ?? "f1-s1-e1"),
      quote: judge === "not_supported" ? "" : judge === "supported_bad_quote" ? "une phrase qui n'existe pas dans la preuve" : (excerpt?.text ?? "x"),
      explanation: "Explication."
    });
  }

  return { research, evidence, texts, judgements, skipReason };
}

await test("balayage combinatoire : aucun fait vérifié avec preuve lue ne termine « not_checked »", () => {
  let cases = 0;
  let read = 0;

  for (const [claimKey, claim] of Object.entries(CLAIMS)) {
    for (const textKey of Object.keys(TEXTS)) {
      for (const secondStatus of [null, "fetched", ...READ_STATUSES]) {
        for (const judge of JUDGE_CASES) {
          for (const skipReason of SKIP_CASES) {
            for (const verification of ["verified", "needs_verification"]) {
              for (const importance of ["high", "medium"]) {
                const input = scenario({ claim, textKey, secondStatus, judge, skipReason, verification, importance });
                const result = evaluateFactEvidence(input);
                const fact = result.facts[0];
                cases += 1;

                if (verification === "verified") {
                  read += 1;
                  assert(ALLOWED_WHEN_READ.has(fact.editorial_status), `${claimKey}/${textKey}/${secondStatus}/${judge}/${skipReason}/${importance} : ${fact.editorial_status}`);
                  assert(fact.reasons.length > 0, `${claimKey}/${textKey}/${secondStatus}/${judge} : statut sans justification`);
                } else {
                  assert(fact.editorial_status === "not_checked", `fait non vérifié contrôlé : ${fact.editorial_status}`);
                }
              }
            }
          }
        }
      }
    }
  }

  assert(cases >= 2000 && read >= 1000, `${cases} cas, dont ${read} avec preuve lue`);
  console.log(`       ${cases} situations évaluées, dont ${read} faits vérifiés avec preuve lue`);
});

await test("garde statique : « not_checked » n'est produit que dans les deux branches sans preuve lue", () => {
  const source = fs.readFileSync(new URL("../src/utils/fact-evidence.js", import.meta.url), "utf8");
  const producers = [...source.matchAll(/editorial_status:\s*"not_checked"/g)];
  assert(producers.length === 2, `${producers.length} endroit(s) produisent not_checked : un nouvel endroit doit être justifié et testé`);
  const before = producers.map(match => source.slice(Math.max(0, match.index - 400), match.index));
  assert(before[0].includes("if (!controlled.has(index))"), "1re branche : fait non vérifié attendu");
  assert(before[1].includes("if (!evidence)"), "2e branche : aucune preuve lue attendue");
  assert(source.includes("invariant violé"), "garde d'exécution absente");
});

await test("statuts lisibles mais non lus : un fait vérifié sans preuve lue reste not_checked (production historique)", () => {
  const result = evaluateFactEvidence({ research: scenario({ claim: CLAIMS.figure, textKey: "matching", secondStatus: null, judge: "none", skipReason: null, verification: "verified", importance: "high" }).research, skipReason: "production historique, aucun accès réseau" });
  assert(result.checked === false && result.facts[0].editorial_status === "not_checked" && result.facts[0].technical_status === "not_fetched", result.facts[0].editorial_status);
});

assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
