import { isDeepStrictEqual } from "node:util";

import { SOURCE_POLICY, evaluateSourcePolicy } from "../utils/source-policy.js";

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
// rapport : les écarts sont signalés, jamais bloquants. Le dossier
// Research est transmis à l'identique dans research_dossier : la requête du
// Script, et donc son cache, ne change pas.

export const TRUTH_SCHEMA = "truth.v1";

const NOT_EVALUATED = "not_evaluated";
const RETAINED = "retained";

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function buildTruthReport({ research, title, policy = SOURCE_POLICY }) {
  const keyFacts = Array.isArray(research?.key_facts) ? research.key_facts : [];
  const sources = new Map();

  const facts = keyFacts.map((fact, index) => {
    const factSources = (Array.isArray(fact?.sources) ? fact.sources : []).map(source => {
      const url = source?.url ?? null;
      const domain = domainOf(url);

      if (url) {
        if (!sources.has(url)) {
          sources.set(url, { url, domain, publisher: source?.publisher ?? null, tier: null, facts: [] });
        }

        sources.get(url).facts.push(index);
      }

      return { url, domain, publisher: source?.publisher ?? null, tier: null };
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

  return {
    schema: TRUTH_SCHEMA,
    title: { text: title ?? null, verdict: NOT_EVALUATED },
    thesis: { text: research?.central_question ?? null, verdict: NOT_EVALUATED },
    facts,
    rejected_count: 0,
    sources: [...sources.values()],
    contradictions: { status: NOT_EVALUATED, items: [] },
    policy_checks: evaluateSourcePolicy(research, policy),
    stop: { stopped: false, reasons: [] },
    alternative_titles: [],
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

  if (truth.rejected_count !== (truth.facts ?? []).filter(fact => fact?.truth_status === "rejected").length) {
    errors.push("rejected_count incohérent");
  }

  return { valid: errors.length === 0, errors };
}

const LABELS = {
  not_evaluated: "non encore contrôlé",
  compliant: "conforme",
  warning: "avertissement",
  non_compliant: "non conforme",
  retained: "retenu",
  rejected: "rejeté"
};

const label = value => LABELS[value] ?? value ?? "—";

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
  lines.push(`- Titre : ${truth.title.text ?? "—"}`);
  lines.push(`- Verdict : ${label(truth.title.verdict)} (validation du titre : phase à venir)`);
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
    lines.push(`${fact.index + 1}. ${fact.claim} — importance ${fact.importance ?? "—"}, ${fact.verification_status ?? "—"} — sources : ${domains}`);
  }

  lines.push("");
  lines.push(`## Faits rejetés (${rejected.length})`);
  lines.push("");
  lines.push(rejected.length === 0 ? "Aucun fait rejeté : aucune règle de rejet n'est encore appliquée." : rejected.map(fact => `${fact.index + 1}. ${fact.claim}`).join("\n"));
  lines.push("");
  lines.push("## Hiérarchie des sources");
  lines.push("");
  lines.push("Rang des sources : non encore contrôlé (hiérarchie des sources : phase à venir).");
  lines.push("");
  lines.push(`Politique des sources : ${label(truth.policy_checks.status)} (rapport seulement, aucun arrêt dans cette phase).`);
  lines.push("");

  for (const check of truth.policy_checks.checks ?? []) {
    const facts = check.facts.length > 0 ? ` — faits ${check.facts.map(index => index + 1).join(", ")}` : "";
    lines.push(`- ${check.rule} : ${label(check.status)} — ${check.detail}${facts}`);
  }

  lines.push("");

  for (const source of truth.sources) {
    lines.push(`- ${source.domain ?? "—"} (${source.publisher ?? "éditeur inconnu"}) — faits ${source.facts.map(index => index + 1).join(", ")} — ${source.url}`);
  }

  lines.push("");
  lines.push("## Contradictions détectées");
  lines.push("");
  lines.push(`Contrôle : ${label(truth.contradictions.status)} (phase contradictions à venir).`);
  lines.push("");
  lines.push("## Raisons d'un éventuel arrêt");
  lines.push("");
  lines.push(truth.stop.stopped ? truth.stop.reasons.map(reason => `- ${reason}`).join("\n") : "Aucun arrêt : la production peut continuer vers le Script.");
  lines.push("");
  lines.push("## Titres alternatifs");
  lines.push("");
  lines.push(truth.alternative_titles.length === 0 ? "Aucune proposition (proposées uniquement lorsque le titre est refusé)." : truth.alternative_titles.map(item => `- ${item}`).join("\n"));
  lines.push("");

  return lines.join("\n");
}
