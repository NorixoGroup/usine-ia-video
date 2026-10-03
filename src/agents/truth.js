import { isDeepStrictEqual } from "node:util";

import {
  SOURCE_POLICY,
  classifySource,
  evaluateSourceHierarchy,
  evaluateSourcePolicy
} from "../utils/source-policy.js";
import { TITLE_VERDICTS, evaluateTitle, kindLabel } from "../utils/title-validation.js";
import { EDITORIAL_STATUSES, EVIDENCE_REVIEW_ACTIONS, evaluateFactEvidence, technicalLabel } from "../utils/fact-evidence.js";

// Truth Report — référence des faits validés, entre Research et Script.
//
// Étape technique déterministe : aucun modèle, aucun réseau, aucun
// horodatage. truth.json est consommé par les agents suivants ;
// truth-report.md sert à la relecture humaine.
//
// Squelette (R20.4) : aucune règle de rejet. Tous les faits sont retenus à
// leur indice d'origine ; les contrôles à venir (rangs, titre,
// contradictions) sont marqués « not_evaluated ».
//
// Phase C1 : policy_checks évalue le dossier selon source_policy, en mode
// rapport : les écarts sont signalés, jamais bloquants.
//
// Phase B : chaque source reçoit son rang (classifySource) et
// source_hierarchy applique la règle « fait HIGH vérifié → au moins une
// source de rang ≤ 2 ». En enforcement "block" (nouvelles productions), un
// écart arrête la production : stop.kind "review_required" (domaine
// inconnu, pause en attente d'une décision humaine) ou "rejected". En
// "report" (productions historiques), il est seulement signalé. Le dossier
// Research est transmis à l'identique dans research_dossier : la requête du
// Script, et donc son cache, ne change pas.
//
// Phase A : la rubrique title est remplie par evaluateTitle (chiffres
// contrôlés par le code, sens jugé par le modèle quand titleJudge est
// fourni). En titleEnforcement "block", un titre non démontré met la
// production en pause (stop.kind "title_review"), avec ses justifications,
// les titres alternatifs vérifiés et les actions possibles. Une pause de la
// hiérarchie des sources reste prioritaire.
//
// Phase E : chaque fait reçoit evidence (statut éditorial et statut
// technique, distincts), calculé par evaluateFactEvidence à partir des
// preuves enregistrées. Un fait au statut éditorial « rejected » devient
// truth_status « rejected », à son indice d'origine ; research_dossier reste
// identique. En evidenceEnforcement "block", un fait HIGH rejeté met la
// production en pause (stop.kind "evidence_review"), un fait HIGH non
// vérifiable aussi (stop.kind "evidence_unverifiable"). Ordre de priorité
// des pauses : hiérarchie des sources, preuves, titre.

export const TRUTH_SCHEMA = "truth.v1";

const NOT_EVALUATED = "not_evaluated";
const RETAINED = "retained";
const REJECTED = "rejected";

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const ENFORCEMENT_MODES = ["report", "block"];

function rankOf(url, policy) {
  const { tier, category, matched_rule } = classifySource(url, policy);

  return { tier, category, matched_rule };
}

function buildStop(hierarchy, enforcement) {
  if (enforcement !== "block") return { stopped: false, reasons: [] };

  if (hierarchy.violations.length > 0) {
    return {
      stopped: true,
      kind: "rejected",
      reasons: hierarchy.violations.map(item => `Fait ${item.fact + 1} : ${item.reason}.`),
      review: hierarchy.review
    };
  }

  if (hierarchy.review.length > 0) {
    return {
      stopped: true,
      kind: "review_required",
      reasons: hierarchy.review.map(item => `Fait ${item.fact + 1} : ${item.reason} (${item.domains.join(", ")}).`),
      review: hierarchy.review
    };
  }

  return { stopped: false, reasons: [] };
}

export const TITLE_REVIEW_ACTIONS = [
  "Choisir un titre alternatif vérifié (ou un autre titre soutenu par les faits validés), puis lancer une nouvelle production avec ce titre : Research est refait (≈ 0,25 à 0,35 $).",
  "La production en pause est conservée : elle n'est ni rejetée ni en échec, et reste reprenable. Une reprise sans changement de titre recalcule le Truth Report sans appel (juge servi par le cache) et aboutit au même verdict.",
  "L'adoption d'un titre alternatif dans la production en cours relèvera de la phase d'adoption des titres (à venir)."
];

function buildEvidenceStop(factEvidence, keyFacts) {
  const high = factEvidence.facts.filter(fact => keyFacts[fact.index]?.importance === "high");
  const rejected = high.filter(fact => fact.editorial_status === "rejected");
  const unverifiable = high.filter(fact => fact.editorial_status === "unverifiable");
  const describe = fact => `Fait ${fact.index + 1} : ${fact.reasons.join(" ")}`;

  if (rejected.length > 0) {
    return { stopped: true, kind: "evidence_review", reasons: [...rejected, ...unverifiable].map(describe), review: [], actions: EVIDENCE_REVIEW_ACTIONS };
  }

  if (unverifiable.length > 0) {
    return { stopped: true, kind: "evidence_unverifiable", reasons: unverifiable.map(describe), review: [], actions: EVIDENCE_REVIEW_ACTIONS };
  }

  return { stopped: false, reasons: [] };
}

function buildTitleStop(titleCheck) {
  return {
    stopped: true,
    kind: "title_review",
    reasons: titleCheck.reasons,
    review: [],
    actions: TITLE_REVIEW_ACTIONS
  };
}

export function buildTruthReport({
  research,
  title,
  policy = SOURCE_POLICY,
  enforcement = "report",
  titleEnforcement = "report",
  titleJudge = null,
  titleSkipReason = null,
  evidenceEnforcement = "report",
  factEvidence = null
}) {
  if (!ENFORCEMENT_MODES.includes(enforcement)) {
    throw new Error(`Truth Report : enforcement invalide "${enforcement}".`);
  }

  if (!ENFORCEMENT_MODES.includes(titleEnforcement)) {
    throw new Error(`Truth Report : titleEnforcement invalide "${titleEnforcement}".`);
  }

  if (!ENFORCEMENT_MODES.includes(evidenceEnforcement)) {
    throw new Error(`Truth Report : evidenceEnforcement invalide "${evidenceEnforcement}".`);
  }

  const evidenceCheck = factEvidence ?? evaluateFactEvidence({ research, skipReason: "preuves non lues" });

  const keyFacts = Array.isArray(research?.key_facts) ? research.key_facts : [];
  const sources = new Map();

  const facts = keyFacts.map((fact, index) => {
    const factSources = (Array.isArray(fact?.sources) ? fact.sources : []).map(source => {
      const url = source?.url ?? null;
      const domain = domainOf(url);

      if (url) {
        if (!sources.has(url)) {
          sources.set(url, { url, domain, publisher: source?.publisher ?? null, ...rankOf(url, policy), facts: [] });
        }

        sources.get(url).facts.push(index);
      }

      return { url, domain, publisher: source?.publisher ?? null, ...rankOf(url, policy) };
    });

    return {
      index,
      claim: fact?.claim ?? null,
      importance: fact?.importance ?? null,
      verification_status: fact?.verification_status ?? null,
      truth_status: RETAINED,
      sources: factSources
    };
  });

  const hierarchy = evaluateSourceHierarchy(research, policy);

  facts.forEach((fact, index) => {
    const { editorial_status, technical_status, sources: evidenceSources, elements, quote, reasons } = evidenceCheck.facts[index];

    fact.best_rank = hierarchy.facts[index].best_rank;
    fact.hierarchy_status = hierarchy.facts[index].status;
    fact.evidence = { editorial_status, technical_status, sources: evidenceSources, elements, quote, reasons };

    if (editorial_status === "rejected") fact.truth_status = REJECTED;
  });

  const titleCheck = evaluateTitle({ title, research, hierarchy, factEvidence: evidenceCheck, judge: titleJudge, skipReason: titleSkipReason, policy });
  const hierarchyStop = buildStop(hierarchy, enforcement);
  const evidenceStop = evidenceEnforcement === "block" && evidenceCheck.checked
    ? buildEvidenceStop(evidenceCheck, keyFacts)
    : { stopped: false, reasons: [] };
  const stop = hierarchyStop.stopped
    ? hierarchyStop
    : evidenceStop.stopped
      ? evidenceStop
      : titleEnforcement === "block" && titleCheck.verdict === "not_demonstrated"
        ? buildTitleStop(titleCheck)
        : hierarchyStop;

  return {
    schema: TRUTH_SCHEMA,
    title: {
      text: titleCheck.text,
      verdict: titleCheck.verdict,
      enforcement: titleEnforcement,
      judged: titleCheck.judged,
      judge_skipped_reason: titleCheck.judge_skipped_reason,
      assertions: titleCheck.assertions,
      reasons: titleCheck.reasons,
      rejected_alternatives: titleCheck.alternatives.rejected
    },
    thesis: { text: research?.central_question ?? null, verdict: NOT_EVALUATED },
    facts,
    rejected_count: facts.filter(fact => fact.truth_status === REJECTED).length,
    sources: [...sources.values()],
    contradictions: { status: NOT_EVALUATED, items: [] },
    policy_checks: evaluateSourcePolicy(research, policy),
    source_hierarchy: { enforcement, ...hierarchy },
    fact_evidence: {
      enforcement: evidenceEnforcement,
      checked: evidenceCheck.checked,
      skip_reason: evidenceCheck.skip_reason,
      counts: evidenceCheck.counts,
      offline_checks: evidenceCheck.offline_checks
    },
    stop,
    alternative_titles: titleCheck.alternatives.accepted,
    research_dossier: structuredClone(research)
  };
}

// Contrat : le dossier transmis au Script est le dossier Research à
// l'identique, et chaque fait garde son indice d'origine.
export function validateTruthReport(truth, research) {
  const errors = [];

  if (!truth || typeof truth !== "object") {
    return { valid: false, errors: ["Truth Report absent ou invalide"] };
  }

  if (truth.schema !== TRUTH_SCHEMA) {
    errors.push(`schema attendu ${TRUTH_SCHEMA}`);
  }

  if (!isDeepStrictEqual(truth.research_dossier, research)) {
    errors.push("research_dossier différent du dossier Research");
  }

  const keyFacts = Array.isArray(research?.key_facts) ? research.key_facts : [];

  if (!Array.isArray(truth.facts) || truth.facts.length !== keyFacts.length) {
    errors.push("facts ne couvre pas exactement key_facts");
  } else {
    truth.facts.forEach((fact, index) => {
      if (fact?.index !== index) {
        errors.push(`facts[${index}] : indice ${fact?.index} au lieu de ${index}`);
      }

      if (![RETAINED, "rejected"].includes(fact?.truth_status)) {
        errors.push(`facts[${index}] : truth_status invalide`);
      }
    });
  }

  if (!ENFORCEMENT_MODES.includes(truth.source_hierarchy?.enforcement)) {
    errors.push("source_hierarchy.enforcement invalide");
  }

  const stopMode = {
    review_required: truth.source_hierarchy?.enforcement,
    rejected: truth.source_hierarchy?.enforcement,
    evidence_review: truth.fact_evidence?.enforcement,
    evidence_unverifiable: truth.fact_evidence?.enforcement,
    title_review: truth.title?.enforcement
  };

  if (truth.stop?.stopped && stopMode[truth.stop.kind] !== "block") {
    errors.push("arrêt impossible hors mode block");
  }

  if (!ENFORCEMENT_MODES.includes(truth.fact_evidence?.enforcement)) {
    errors.push("fact_evidence.enforcement invalide");
  }

  (truth.facts ?? []).forEach((fact, index) => {
    if (!EDITORIAL_STATUSES.includes(fact?.evidence?.editorial_status)) errors.push(`facts[${index}] : statut éditorial invalide`);
    if (typeof fact?.evidence?.technical_status !== "string") errors.push(`facts[${index}] : statut technique absent`);
    if ((fact?.truth_status === REJECTED) !== (fact?.evidence?.editorial_status === "rejected")) errors.push(`facts[${index}] : truth_status incohérent avec la preuve`);
    if (fact?.evidence?.editorial_status !== "not_checked" && !(fact?.evidence?.reasons?.length > 0)) errors.push(`facts[${index}] : statut de preuve sans justification`);
  });

  if (!TITLE_VERDICTS.includes(truth.title?.verdict)) {
    errors.push("title.verdict invalide");
  } else if (!Array.isArray(truth.title.reasons) || truth.title.reasons.length === 0 || !truth.title.reasons.every(reason => typeof reason === "string" && reason.trim())) {
    errors.push("title : verdict sans justification");
  }

  if (truth.stop?.kind === "title_review" && (truth.title?.enforcement !== "block" || truth.title?.verdict !== "not_demonstrated")) {
    errors.push("pause titre incohérente avec le verdict ou le mode");
  }

  if (truth.rejected_count !== (truth.facts ?? []).filter(fact => fact?.truth_status === "rejected").length) {
    errors.push("rejected_count incohérent");
  }

  return { valid: errors.length === 0, errors };
}

const LABELS = {
  not_evaluated: "non encore contrôlé",
  review_required: "revue requise",
  demonstrated: "démontré",
  partially_demonstrated: "partiellement démontré",
  not_demonstrated: "non démontré",
  supported: "soutenue",
  partially_supported: "partiellement soutenue",
  not_supported: "non soutenue",
  not_judged: "non jugée",
  rejected: "rejeté",
  unverifiable: "non vérifiable",
  not_checked: "non contrôlé",
  compliant: "conforme",
  warning: "avertissement",
  non_compliant: "non conforme",
  retained: "retenu",
  rejected: "rejeté"
};

const label = value => LABELS[value] ?? value ?? "—";

const TIER_LABELS = [
  ["tier_1", "Tier 1"], ["tier_2", "Tier 2"], ["tier_3", "Tier 3"], ["tier_4", "Tier 4"],
  ["tier_5", "Tier 5"], ["tier_6", "Tier 6"], ["unknown", "Unknown"], ["invalid_url", "URL invalide"]
];

function evidenceTechnical(fact) {
  const details = fact.evidence.sources.map(source => technicalLabel(source.technical_status));
  return details.length === 0 ? "aucune source" : [...new Set(details)].join(", ");
}

function rankLabel(source) {
  if (source.category === "unknown") return "Unknown — review required";
  if (source.category === "invalid_url") return "URL invalide";
  return `Tier ${source.tier} (${SOURCE_POLICY.source_tiers.categories[source.category]?.label ?? source.category})`;
}

export function renderTruthMarkdown(truth) {
  const retained = truth.facts.filter(fact => fact.truth_status === RETAINED);
  const rejected = truth.facts.filter(fact => fact.truth_status === "rejected");
  const lines = [];

  lines.push("# Truth Report");
  lines.push("");
  lines.push(`Schéma : \`${truth.schema}\`. Rapport déterministe, produit entre Research et Script.`);
  lines.push("");
  lines.push("## Verdict du titre");
  lines.push("");
  const titleMode = truth.title.enforcement === "block"
    ? "bloquant (nouvelle production)"
    : "rapport seulement";

  lines.push(`- Titre : ${truth.title.text ?? "—"}`);
  lines.push(`- Verdict : **${label(truth.title.verdict)}** — mode ${titleMode}${truth.title.judged ? ", sens jugé par le modèle et contrôlé par le code" : `, sens non jugé (${truth.title.judge_skipped_reason ?? "juge non appelé"})`}.`);
  lines.push("");
  lines.push("Justifications :");
  lines.push("");

  for (const reason of truth.title.reasons) {
    lines.push(`- ${reason}`);
  }

  lines.push("");
  lines.push("Affirmations du titre :");
  lines.push("");

  for (const assertion of truth.title.assertions) {
    const facts = assertion.facts.length > 0 ? ` — faits ${assertion.facts.map(index => index + 1).join(", ")}` : "";
    lines.push(`- ${kindLabel(assertion.kind)} « ${assertion.text} » : ${label(assertion.status)}${facts}`);
  }
  lines.push("");
  lines.push("## Verdict de la thèse");
  lines.push("");
  lines.push(`- Question centrale : ${truth.thesis.text ?? "—"}`);
  lines.push(`- Verdict : ${label(truth.thesis.verdict)}`);
  lines.push("");
  lines.push(`## Faits retenus (${retained.length})`);
  lines.push("");

  for (const fact of retained) {
    const domains = fact.sources.map(source => source.domain ?? "source sans URL").join(", ") || "aucune source";
    lines.push(`${fact.index + 1}. ${fact.claim} — importance ${fact.importance ?? "—"}, ${fact.verification_status ?? "—"} — sources : ${domains} — preuve : ${label(fact.evidence.editorial_status)} (${evidenceTechnical(fact)})`);
  }

  lines.push("");
  lines.push(`## Faits rejetés (${rejected.length})`);
  lines.push("");
  lines.push(rejected.length === 0
    ? (truth.fact_evidence.checked ? "Aucun fait rejeté par le contrôle des preuves." : "Aucun fait rejeté : les preuves n'ont pas été lues pour cette production.")
    : rejected.map(fact => `${fact.index + 1}. ${fact.claim} — ${fact.evidence.reasons.join(" ")}`).join("\n"));
  lines.push("");
  lines.push("## Hiérarchie des sources");
  lines.push("");
  const hierarchy = truth.source_hierarchy;
  const mode = hierarchy.enforcement === "block"
    ? "bloquant (nouvelle production)"
    : "rapport seulement (production historique)";

  lines.push(`Hiérarchie : ${label(hierarchy.status)} — mode ${mode}. Règle : chaque fait HIGH vérifié possède au moins une source de rang ≤ ${hierarchy.minimum_rank_for_high_facts}.`);
  lines.push("");
  lines.push(`Répartition : ${TIER_LABELS.map(([key, text]) => `${text} ${hierarchy.distribution[key]}`).join(", ")}.`);
  lines.push("");

  for (const item of hierarchy.violations) {
    lines.push(`- Fait ${item.fact + 1} non conforme : ${item.reason}.`);
  }

  for (const item of hierarchy.review) {
    for (const domain of item.domains) {
      lines.push(`- **Unknown — review required** : ${domain} (fait ${item.fact + 1}). Raison : ${item.reason}. Action : ${item.action}`);
    }
  }

  if (hierarchy.violations.length + hierarchy.review.length > 0) lines.push("");
  lines.push(`Politique des sources : ${label(truth.policy_checks.status)} (rapport seulement, aucun arrêt dans cette phase).`);
  lines.push("");

  for (const check of truth.policy_checks.checks ?? []) {
    const facts = check.facts.length > 0 ? ` — faits ${check.facts.map(index => index + 1).join(", ")}` : "";
    lines.push(`- ${check.rule} : ${label(check.status)} — ${check.detail}${facts}`);
  }

  lines.push("");

  lines.push("Sources :");
  lines.push("");

  for (const source of truth.sources) {
    lines.push(`- ${rankLabel(source)} — ${source.domain ?? "—"} (${source.publisher ?? "éditeur inconnu"}) — règle : ${source.matched_rule} — faits ${source.facts.map(index => index + 1).join(", ")} — ${source.url}`);
  }

  lines.push("");
  lines.push("## Preuves des faits (Fact ↔ Evidence)");
  lines.push("");
  const evidence = truth.fact_evidence;
  lines.push(evidence.checked
    ? `Preuves lues et enregistrées localement — mode ${evidence.enforcement === "block" ? "bloquant (nouvelle production)" : "rapport seulement"}. Statuts éditoriaux : ${EDITORIAL_STATUSES.map(status => `${label(status)} ${evidence.counts[status]}`).join(", ")}.`
    : `Preuves non lues : ${evidence.skip_reason ?? "—"}. Seuls les contrôles hors réseau sont présentés.`);
  lines.push("");

  for (const fact of truth.facts.filter(item => item.evidence.editorial_status !== "not_checked" || evidence.checked)) {
    if (fact.verification_status !== "verified") continue;
    lines.push(`- Fait ${fact.index + 1} — éditorial : **${label(fact.evidence.editorial_status)}** — technique : ${evidenceTechnical(fact)}`);
    for (const element of fact.evidence.elements) lines.push(`  - ${element.kind === "quote" ? "Citation" : element.kind === "date" ? "Date" : "Chiffre"} « ${element.text} » : ${element.status === "found" ? `trouvé — « ${element.excerpt} »` : "absent des preuves lues"}`);
    if (fact.evidence.quote) lines.push(`  - Passage cité : « ${fact.evidence.quote.text} » (${fact.evidence.quote.source})`);
    for (const reason of fact.evidence.reasons) lines.push(`  - ${reason}`);
  }

  if (evidence.offline_checks.length > 0) {
    lines.push("");
    lines.push("Contrôles hors réseau :");
    lines.push("");
    for (const check of evidence.offline_checks) lines.push(`- Fait ${check.fact + 1} — ${check.check === "provenance" ? "provenance" : "cohérence interne"} : ${check.status === "ok" ? "conforme" : "avertissement"} — ${check.reason}`);
  }

  lines.push("");
  lines.push("## Contradictions détectées");
  lines.push("");
  lines.push(`Contrôle : ${label(truth.contradictions.status)} (phase contradictions à venir).`);
  lines.push("");
  lines.push("## Raisons d'un éventuel arrêt");
  lines.push("");
  if (!truth.stop.stopped) {
    lines.push("Aucun arrêt : la production peut continuer vers le Script.");
  } else {
    lines.push(truth.stop.kind === "review_required"
      ? "Pause — revue requise : ce n'est ni un rejet ni un échec. La production reprendra après votre décision."
      : truth.stop.kind === "title_review"
        ? "Pause — titre à revoir : le titre n'est pas démontré par les faits validés. Ce n'est ni un rejet ni un échec."
        : truth.stop.kind === "evidence_review"
          ? "Pause — preuve à revoir : un fait HIGH n'est pas soutenu par sa preuve. La production est conservée et reste reprenable."
          : truth.stop.kind === "evidence_unverifiable"
            ? "Pause — revue requise : la preuve d'un fait HIGH est illisible. Ce n'est ni un rejet ni un échec."
            : "Arrêt : la hiérarchie des sources n'est pas respectée.");
    lines.push("");
    lines.push(truth.stop.reasons.map(reason => `- ${reason}`).join("\n"));

    if (truth.stop.review.length > 0) {
      lines.push("");
      lines.push(`Action attendue : ${truth.stop.review[0].action}`);
    }

    if (truth.stop.actions?.length > 0) {
      lines.push("");
      lines.push("Actions possibles :");
      lines.push("");
      truth.stop.actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
    }
  }
  lines.push("");
  lines.push("## Titres alternatifs");
  lines.push("");
  if (truth.alternative_titles.length === 0) {
    lines.push(truth.title.verdict === "not_demonstrated"
      ? (truth.title.judged ? "Aucun titre alternatif n'a passé les contrôles du code." : "Aucune proposition : le juge du titre n'a pas été appelé.")
      : "Aucune proposition (proposées uniquement lorsque le titre est non démontré).");
  } else {
    lines.push("Titres vérifiés par le code (chiffres présents dans les faits validés cités) :");
    lines.push("");

    for (const item of truth.alternative_titles) {
      lines.push(`- **${item.title}** — faits ${item.facts.map(index => index + 1).join(", ")} — ${item.explanation}`);
    }
  }

  if (truth.title.rejected_alternatives.length > 0) {
    lines.push("");
    lines.push("Propositions écartées par le code :");
    lines.push("");

    for (const item of truth.title.rejected_alternatives) {
      lines.push(`- ${item.title} — ${item.reasons.join(" ; ")}`);
    }
  }

  lines.push("");

  return lines.join("\n");
}
