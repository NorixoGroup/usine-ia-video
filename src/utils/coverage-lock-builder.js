// R29.4 — construction du verrou de couverture COURANT (baseline v1.0.3,
// section 8). Seul constructeur du verrou : la porte de couverture, l'agent
// Script (enregistrement dans script.json) et l'orchestrateur (contrôle à la
// reprise) l'utilisent tous trois.
//
// Il rassemble les versions courantes des composants (découpeur,
// normalisation, protection, classification, juge, réparation), la politique
// du coordinateur, la langue et la baseline. Il se place donc AU-DESSUS des
// composants : le contrat du verrou (coverage-lock.js) reste, lui, une feuille
// sans dépendance que les composants importent.
//
// Pur et déterministe : aucune écriture, aucun réseau, aucune horloge.

import { COVERAGE_NORMALIZATION_VERSION } from "./coverage-normalization.js";
import { coverageUnitSplitterVersion } from "./coverage-unit-splitter.js";
import { coverageProtectionVersion, extractResearchEntities, RESEARCH_ENTITY_RULE_VERSION } from "./coverage-protection.js";
import { coverageClassificationVersion } from "./coverage-classification.js";
import { coverageJudgeV2Version } from "./coverage-judge-v2.js";
import { COVERAGE_REPAIR_VERSION } from "./coverage-repair.js";
import { COVERAGE_JUDGE_EXECUTOR_VERSION, EXECUTOR_LIMITS } from "./coverage-judge-executor.js";
import { COVERAGE_DELETE_APPLIER_VERSION } from "./coverage-delete-applier.js";
import { COVERAGE_COORDINATOR_VERSION } from "./coverage-coordinator.js";
import { ARCHITECTURE_BASELINE_VERSION, coordinatorLockElement, executorLockElement } from "./coverage-lock.js";

// Politique versionnée du coordinateur (élément 10 du verrou).
export const SCRIPT_COVERAGE_POLICY = Object.freeze({
  version: "coverage-coordinator-policy.v1",
  max_rounds: 10,
  max_total_judge_calls: 12
});

const LANGUAGE = "fr";

function freezeAll(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeAll(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Liste d'entités Research : sortie de la règle d'extraction de Protection,
// appliquée aux key_facts du dossier.
export function researchEntitiesOf(research) {
  const keyFacts = Array.isArray(research?.key_facts)
    ? research.key_facts.map(fact => fact?.claim).filter(claim => typeof claim === "string")
    : [];
  return extractResearchEntities({ keyFacts, ruleVersion: RESEARCH_ENTITY_RULE_VERSION });
}

// Verrou complet (section 8), reconstruit à partir des versions courantes.
export function buildCoverageLock({ entities, policy = SCRIPT_COVERAGE_POLICY }) {
  return freezeAll({
    splitter: coverageUnitSplitterVersion(),
    normalization: COVERAGE_NORMALIZATION_VERSION,
    protection: coverageProtectionVersion(),
    entities_rule_version: entities?.rule_version ?? null,
    entities_fingerprint: entities?.fingerprint ?? null,
    classification: coverageClassificationVersion(),
    judge: coverageJudgeV2Version(),
    repair: COVERAGE_REPAIR_VERSION,
    applier: COVERAGE_DELETE_APPLIER_VERSION,
    coordinator: coordinatorLockElement({ policy, coordinatorVersion: COVERAGE_COORDINATOR_VERSION }),
    executor: executorLockElement({ executorVersion: COVERAGE_JUDGE_EXECUTOR_VERSION, limits: EXECUTOR_LIMITS }),
    language: LANGUAGE,
    baseline: ARCHITECTURE_BASELINE_VERSION
  });
}

// Verrou courant d'un dossier Research : entités extraites, politique par défaut.
export function currentCoverageLock(research, policy = SCRIPT_COVERAGE_POLICY) {
  return buildCoverageLock({ entities: researchEntitiesOf(research), policy });
}
