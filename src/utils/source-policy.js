import fs from "node:fs";

import { validateSource } from "./validate-research.js";

// Politique des sources (R20.4, phase C1) — source unique de vérité.
//
// Seul lecteur de config/research.json → source_policy. Elle définit les
// types de sources autorisés et préférés, les règles obligatoires et les
// limites. Elle alimente :
// - le gate Research (validate-research.js) : types autorisés et règle
//   « verified exige une source » ;
// - le prompt Research : renderSourcePolicyPrompt ;
// - le Truth Report : evaluateSourcePolicy, en mode rapport (aucun arrêt).
//
// Une clé inconnue, absente ou mal typée fait échouer le chargement :
// aucune règle n'est ignorée silencieusement.

const BOOLEAN_KEYS = [
  "require_sources_for_key_facts",
  "allow_unsourced_claims",
  "mark_unverified_claims"
];

const INTEGER_KEYS = [
  "minimum_sources",
  "target_sources",
  "maximum_sources",
  "max_sources_per_fact"
];

const KNOWN_KEYS = new Set([
  "allowed_source_types",
  "preferred_source_types",
  "source_types",
  ...BOOLEAN_KEYS,
  ...INTEGER_KEYS
]);

const TYPE_KEYS = new Set(["label", "plural_label", "examples"]);

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;

function isStringList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

export function validateSourcePolicyConfig(policy) {
  const errors = [];

  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["source_policy absente ou invalide"];
  }

  for (const key of Object.keys(policy)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`clé inconnue : ${key}`);
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof policy[key] !== "boolean") errors.push(`${key} doit être un booléen`);
  }

  for (const key of INTEGER_KEYS) {
    if (!Number.isInteger(policy[key]) || policy[key] < 1) errors.push(`${key} doit être un entier ≥ 1`);
  }

  if (errors.length === 0
    && !(policy.minimum_sources <= policy.target_sources && policy.target_sources <= policy.maximum_sources)) {
    errors.push("minimum_sources ≤ target_sources ≤ maximum_sources attendu");
  }

  if (!isStringList(policy.allowed_source_types)) {
    errors.push("allowed_source_types doit être une liste non vide de types distincts");
  }

  if (!isStringList(policy.preferred_source_types)) {
    errors.push("preferred_source_types doit être une liste non vide de types distincts");
  } else if (Array.isArray(policy.allowed_source_types)) {
    for (const type of policy.preferred_source_types) {
      if (!policy.allowed_source_types.includes(type)) errors.push(`type préféré non autorisé : ${type}`);
    }
  }

  const types = policy.source_types;

  if (!types || typeof types !== "object" || Array.isArray(types)) {
    errors.push("source_types doit être un objet");
  } else {
    for (const type of Object.keys(types)) {
      if (!(policy.allowed_source_types ?? []).includes(type)) errors.push(`source_types.${type} : type non autorisé`);
    }

    for (const type of policy.allowed_source_types ?? []) {
      const entry = types[type];

      if (!entry || typeof entry !== "object") {
        errors.push(`source_types.${type} manquant`);
        continue;
      }

      for (const key of Object.keys(entry)) {
        if (!TYPE_KEYS.has(key)) errors.push(`source_types.${type} : clé inconnue ${key}`);
      }

      for (const key of ["label", "plural_label"]) {
        if (!isNonEmptyString(entry[key])) errors.push(`source_types.${type}.${key} manquant`);
      }

      if (entry.examples !== undefined && !isNonEmptyString(entry.examples)) {
        errors.push(`source_types.${type}.examples invalide`);
      }
    }
  }

  return errors;
}

export function loadSourcePolicy(config) {
  const policy = config?.source_policy;
  const errors = validateSourcePolicyConfig(policy);

  if (errors.length > 0) {
    throw new Error(`config/research.json → source_policy invalide : ${errors.join(" ; ")}`);
  }

  return Object.freeze(structuredClone(policy));
}

export const SOURCE_POLICY = loadSourcePolicy(
  JSON.parse(fs.readFileSync(new URL("../../config/research.json", import.meta.url), "utf8"))
);

// Règles du prompt Research, rendues depuis la politique. Chaque clé
// correspond à une balise {{POLICY_<CLÉ>}} seule sur sa ligne ; une règle
// désactivée retire la ligne. Avec la configuration actuelle, le texte est
// strictement le texte historique (empreinte de la requête inchangée).
export function renderSourcePolicyPrompt(policy = SOURCE_POLICY) {
  const labels = types => types.map(type => policy.source_types[type].label);
  const join = items => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ou ${items.at(-1)}`;
  const preferred = policy.preferred_source_types;
  const fallback = policy.allowed_source_types.filter(type => !preferred.includes(type));
  const examples = preferred.map(type => policy.source_types[type].examples).filter(Boolean).join(" ; ");
  const preferredLabel = preferred.map(type => policy.source_types[type].plural_label).join(" et ");
  const perFact = policy.max_sources_per_fact;

  return {
    VERIFIED: policy.require_sources_for_key_facts
      ? ["- Un fait ne peut avoir verification_status=\"verified\" que s'il possède au moins une source exploitable."]
      : [],
    PREFERRED: [`- Privilégie les ${preferredLabel}${examples ? ` : ${examples}` : ""}.`],
    UNVERIFIED: policy.mark_unverified_claims
      ? ["- Si aucune source fiable n'est disponible, utilise needs_verification ou uncertain."]
      : [],
    FALLBACK: fallback.map(type =>
      `- Les ${policy.source_types[type].plural_label} sont acceptables lorsqu'une ${join(labels(preferred))} pertinente n'est pas disponible.`
    ),
    UNSOURCED: policy.allow_unsourced_claims
      ? []
      : ["- Les chiffres, pourcentages, dates et affirmations centrales doivent être sourcés."],
    PER_FACT: [`- Chaque key_fact contient au maximum ${perFact} source${perFact > 1 ? "s" : ""}, en conservant les sources les plus solides et directement pertinentes.`]
  };
}

export function applySourcePolicyPrompt(template, policy = SOURCE_POLICY) {
  const rules = renderSourcePolicyPrompt(policy);
  const output = template.replace(/^\{\{POLICY_([A-Z_]+)\}\}\n/gm, (_, key) => {
    if (!(key in rules)) throw new Error(`Prompt Research : balise de politique inconnue {{POLICY_${key}}}`);
    return rules[key].map(line => `${line}\n`).join("");
  });

  if (/\{\{POLICY_/.test(output)) throw new Error("Prompt Research : balise de politique non résolue.");

  return output;
}

// Évaluation d'un dossier Research (mode rapport, E1) : chaque règle reçoit
// compliant, warning ou non_compliant, avec les faits concernés. Aucune
// règle n'arrête la production dans cette phase.
const COMPLIANT = "compliant";
const WARNING = "warning";
const NON_COMPLIANT = "non_compliant";

function worst(statuses) {
  if (statuses.includes(NON_COMPLIANT)) return NON_COMPLIANT;
  if (statuses.includes(WARNING)) return WARNING;
  return COMPLIANT;
}

export function evaluateSourcePolicy(dossier, policy = SOURCE_POLICY) {
  const facts = Array.isArray(dossier?.key_facts) ? dossier.key_facts : [];
  const typeCounts = {};
  const distinct = new Set();
  const disallowed = [];
  const overLimit = [];
  const verifiedUnsourced = [];
  const unsourced = [];

  facts.forEach((fact, index) => {
    const sources = Array.isArray(fact?.sources) ? fact.sources : [];
    const usable = sources.filter(source => validateSource(source, policy).length === 0);

    for (const source of sources) {
      const type = source?.source_type ?? "absent";
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      if (!policy.allowed_source_types.includes(source?.source_type)) disallowed.push(index);
    }

    for (const source of usable) distinct.add(source.url.trim());
    if (sources.length > policy.max_sources_per_fact) overLimit.push(index);

    if (usable.length === 0) {
      unsourced.push(index);
      if (fact?.verification_status === "verified") verifiedUnsourced.push(index);
    }
  });

  const unique = list => [...new Set(list)];
  const count = distinct.size;
  const preferredCount = policy.preferred_source_types.reduce((sum, type) => sum + (typeCounts[type] ?? 0), 0);
  const totalSources = Object.values(typeCounts).reduce((sum, value) => sum + value, 0);

  const checks = [
    {
      rule: "allowed_source_types",
      status: disallowed.length === 0 ? COMPLIANT : NON_COMPLIANT,
      detail: `types autorisés : ${policy.allowed_source_types.join(", ")}`,
      facts: unique(disallowed)
    },
    {
      rule: "preferred_source_types",
      status: totalSources === 0 || preferredCount > 0 ? COMPLIANT : WARNING,
      detail: `${preferredCount} source(s) sur ${totalSources} de type ${policy.preferred_source_types.join(", ")}`,
      facts: []
    },
    ...(policy.require_sources_for_key_facts ? [{
      rule: "require_sources_for_key_facts",
      status: verifiedUnsourced.length === 0 ? COMPLIANT : NON_COMPLIANT,
      detail: "un fait verified exige au moins une source exploitable",
      facts: verifiedUnsourced
    }] : []),
    ...(policy.mark_unverified_claims ? [{
      rule: "mark_unverified_claims",
      status: verifiedUnsourced.length === 0 ? COMPLIANT : NON_COMPLIANT,
      detail: "un fait sans source exploitable est marqué needs_verification ou uncertain",
      facts: verifiedUnsourced
    }] : []),
    ...(policy.allow_unsourced_claims ? [] : [{
      rule: "allow_unsourced_claims",
      status: unsourced.length === 0 ? COMPLIANT : WARNING,
      detail: `${unsourced.length} fait(s) sans source exploitable`,
      facts: unsourced
    }]),
    {
      rule: "minimum_sources",
      status: count >= policy.minimum_sources ? COMPLIANT : NON_COMPLIANT,
      detail: `${count} source(s) distincte(s), minimum ${policy.minimum_sources}`,
      facts: []
    },
    {
      rule: "target_sources",
      status: count >= policy.target_sources ? COMPLIANT : WARNING,
      detail: `${count} source(s) distincte(s), cible ${policy.target_sources}`,
      facts: []
    },
    {
      rule: "maximum_sources",
      status: count <= policy.maximum_sources ? COMPLIANT : NON_COMPLIANT,
      detail: `${count} source(s) distincte(s), maximum ${policy.maximum_sources}`,
      facts: []
    },
    {
      rule: "max_sources_per_fact",
      status: overLimit.length === 0 ? COMPLIANT : NON_COMPLIANT,
      detail: `au maximum ${policy.max_sources_per_fact} source(s) par fait`,
      facts: overLimit
    }
  ];

  return {
    mode: "report",
    status: worst(checks.map(check => check.status)),
    distinct_sources: count,
    source_types: typeCounts,
    checks
  };
}
