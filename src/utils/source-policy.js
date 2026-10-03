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
// - le Truth Report : evaluateSourcePolicy, en mode rapport (aucun arrêt),
//   et la hiérarchie des sources (phase B) : classifySource, effectiveRank,
//   evaluateSourceHierarchy.
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
  "source_tiers",
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

  errors.push(...validateSourceTiersConfig(policy.source_tiers));

  return errors;
}

// Hiérarchie des sources (phase B). Rangs 1 à 6 ; un domaine qu'aucune
// règle ne reconnaît est « unknown » (revue humaine), jamais un rang deviné.
export const TIERS = [1, 2, 3, 4, 5, 6];

const TIER_KEYS = new Set([
  "minimum_rank_for_high_facts",
  "categories",
  "path_rules",
  "domain_exceptions",
  "excluded_suffixes",
  "suffix_rules",
  "prefix_rules"
]);

const isDomain = value => typeof value === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value);

function validateSourceTiersConfig(tiers) {
  const errors = [];
  const fail = message => errors.push(`source_tiers : ${message}`);

  if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) {
    return ["source_tiers absent ou invalide"];
  }

  for (const key of Object.keys(tiers)) {
    if (!TIER_KEYS.has(key)) fail(`clé inconnue ${key}`);
  }

  if (!TIERS.includes(tiers.minimum_rank_for_high_facts)) fail("minimum_rank_for_high_facts doit être un rang de 1 à 6");

  const categories = tiers.categories;

  if (!categories || typeof categories !== "object" || Array.isArray(categories) || Object.keys(categories).length === 0) {
    fail("categories doit être un objet non vide");
    return errors;
  }

  for (const [id, entry] of Object.entries(categories)) {
    if (!/^[a-z_]+$/.test(id)) fail(`catégorie ${id} : identifiant invalide`);
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["tier", "label"].includes(key))) fail(`catégorie ${id} : clés attendues tier et label`);
    if (!TIERS.includes(entry?.tier)) fail(`catégorie ${id} : tier doit être un rang de 1 à 6`);
    if (!isNonEmptyString(entry?.label)) fail(`catégorie ${id} : label manquant`);
  }

  const knownCategory = (category, where) => {
    if (!Object.hasOwn(categories, category)) fail(`${where} : catégorie inconnue ${category}`);
  };

  const checkList = (key, field, validate) => {
    const list = tiers[key];

    if (!Array.isArray(list)) {
      fail(`${key} doit être une liste`);
      return;
    }

    const seen = new Set();

    list.forEach((rule, index) => {
      const where = `${key}[${index}]`;

      if (!rule || typeof rule !== "object" || Object.keys(rule).sort().join() !== [field, "category"].sort().join()) {
        fail(`${where} : clés attendues ${field} et category`);
        return;
      }

      if (!validate(rule[field])) fail(`${where} : ${field} invalide`);
      if (seen.has(rule[field])) fail(`${where} : doublon ${rule[field]}`);
      seen.add(rule[field]);
      knownCategory(rule.category, where);
    });
  };

  checkList("path_rules", "contains", value => typeof value === "string" && /^[a-z0-9-]{3,}$/.test(value));
  checkList("suffix_rules", "suffix", value => typeof value === "string" && /^(\.[a-z0-9-]+)+$/.test(value));
  checkList("prefix_rules", "prefix", value => typeof value === "string" && /^[a-z0-9-]+\.$/.test(value));

  const exceptions = tiers.domain_exceptions;

  if (!exceptions || typeof exceptions !== "object" || Array.isArray(exceptions)) {
    fail("domain_exceptions doit être un objet");
  } else {
    for (const [domain, category] of Object.entries(exceptions)) {
      if (!isDomain(domain) || domain.startsWith("www.")) fail(`domain_exceptions : domaine invalide ${domain}`);
      knownCategory(category, `domain_exceptions.${domain}`);
    }
  }

  if (!Array.isArray(tiers.excluded_suffixes)
    || !tiers.excluded_suffixes.every(value => typeof value === "string" && /^(\.[a-z0-9-]+)+$/.test(value))
    || new Set(tiers.excluded_suffixes).size !== tiers.excluded_suffixes.length) {
    fail("excluded_suffixes doit être une liste de suffixes distincts");
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

// ---------------------------------------------------------------------
// Hiérarchie des sources (phase B)
// ---------------------------------------------------------------------

const UNKNOWN = "unknown";

function hostOf(url) {
  try {
    const parsed = new URL(String(url).trim());

    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) return null;

    return { host: parsed.hostname.toLowerCase().replace(/^www\./, ""), path: decodeURIComponent(parsed.pathname).toLowerCase() };
  } catch {
    return null;
  }
}

const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// Classe une source d'après son URL, sans modèle ni réseau. Ordre : contenu
// sponsorisé (chemin), exceptions par domaine, suffixes exclus, suffixes
// généraux, préfixes ; la première règle qui correspond l'emporte. Sinon :
// « unknown ». signals est réservé à la future évaluation de la qualité
// des preuves (toujours vide dans cette phase).
export function classifySource(url, policy = SOURCE_POLICY) {
  const tiers = policy.source_tiers;
  const parsed = hostOf(url);

  if (!parsed) {
    return { domain: null, tier: null, category: "invalid_url", matched_rule: "URL invalide", signals: [] };
  }

  const { host, path } = parsed;
  const result = (category, rule) => ({
    domain: host,
    tier: tiers.categories[category].tier,
    category,
    matched_rule: rule,
    signals: []
  });

  const pathRule = tiers.path_rules.find(rule => path.includes(rule.contains));
  if (pathRule) return result(pathRule.category, `chemin contient « ${pathRule.contains} »`);

  const exception = Object.keys(tiers.domain_exceptions)
    .filter(domain => matchesDomain(host, domain))
    .sort((a, b) => b.length - a.length)[0];
  if (exception) return result(tiers.domain_exceptions[exception], `exception ${exception}`);

  const excluded = tiers.excluded_suffixes.find(suffix => host.endsWith(suffix));
  if (excluded) {
    return { domain: host, tier: UNKNOWN, category: UNKNOWN, matched_rule: `suffixe exclu ${excluded}`, signals: [] };
  }

  const suffix = tiers.suffix_rules
    .filter(rule => host.endsWith(rule.suffix))
    .sort((a, b) => b.suffix.length - a.suffix.length)[0];
  if (suffix) return result(suffix.category, `suffixe ${suffix.suffix}`);

  const prefix = tiers.prefix_rules.find(rule => host.startsWith(rule.prefix));
  if (prefix) return result(prefix.category, `préfixe ${prefix.prefix}`);

  return { domain: host, tier: UNKNOWN, category: UNKNOWN, matched_rule: "aucune règle", signals: [] };
}

// Fonction unique lue par les gates : ils ne lisent jamais tier
// directement. Aujourd'hui, le rang effectif est le rang de la source ;
// une future pondération de la qualité des preuves ne modifiera que cette
// fonction. Renvoie un rang de 1 à 6, ou null (unknown ou URL invalide).
export function effectiveRank(classification) {
  return TIERS.includes(classification?.tier) ? classification.tier : null;
}

export const REVIEW_ACTION =
  "Ajouter le domaine à source_policy.source_tiers.domain_exceptions (config/research.json) avec sa catégorie, " +
  "puis relancer la reprise : le Truth Report est recalculé sans appel.";

// Règle Q-B2 : chaque fait HIGH verified possède au moins une source de
// rang effectif ≤ minimum_rank_for_high_facts. Sinon : revue humaine si une
// de ses sources est « unknown » (ce n'est pas un rejet), non conforme
// sinon. Le mode (block ou report) est décidé par l'appelant.
export function evaluateSourceHierarchy(dossier, policy = SOURCE_POLICY) {
  const minimum = policy.source_tiers.minimum_rank_for_high_facts;
  const facts = Array.isArray(dossier?.key_facts) ? dossier.key_facts : [];
  const distribution = Object.fromEntries([...TIERS.map(tier => [`tier_${tier}`, 0]), [UNKNOWN, 0], ["invalid_url", 0]]);
  const review = [];
  const violations = [];

  const evaluatedFacts = facts.map((fact, index) => {
    const classifications = (Array.isArray(fact?.sources) ? fact.sources : []).map(source => classifySource(source?.url, policy));

    const effective = classifications.map(effectiveRank);

    classifications.forEach((item, position) => {
      distribution[effective[position] !== null ? `tier_${effective[position]}` : item.category] += 1;
    });

    const ranks = effective.filter(rank => rank !== null);
    const bestRank = ranks.length > 0 ? Math.min(...ranks) : null;
    const unknownDomains = [...new Set(classifications.filter(item => item.category === UNKNOWN).map(item => item.domain))];
    const governed = fact?.importance === "high" && fact?.verification_status === "verified";
    let status = "not_applicable";

    if (governed) {
      if (bestRank !== null && bestRank <= minimum) {
        status = "compliant";
      } else if (unknownDomains.length > 0) {
        status = "review_required";
        review.push({
          fact: index,
          claim: fact?.claim ?? null,
          domains: unknownDomains,
          reason: `fait HIGH vérifié sans source de rang ≤ ${minimum} ; domaine(s) non reconnu(s) par la hiérarchie`,
          action: REVIEW_ACTION
        });
      } else {
        status = "non_compliant";
        violations.push({
          fact: index,
          claim: fact?.claim ?? null,
          best_rank: bestRank,
          reason: `fait HIGH vérifié sans source de rang ≤ ${minimum} (meilleur rang : ${bestRank ?? "aucun"})`
        });
      }
    }

    return { index, best_rank: bestRank, status };
  });

  return {
    minimum_rank_for_high_facts: minimum,
    status: violations.length > 0 ? "non_compliant" : review.length > 0 ? "review_required" : "compliant",
    distribution,
    facts: evaluatedFacts,
    review,
    violations
  };
}
