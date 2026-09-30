function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidHttpUrl(value) {
  if (!isNonEmptyString(value)) return false;

  const trimmed = value.trim();

  // Une source doit contenir une URL brute, jamais du Markdown.
  if (
    trimmed.includes("[") ||
    trimmed.includes("]") ||
    trimmed.includes("(") ||
    trimmed.includes(")") ||
    /\s/.test(trimmed)
  ) {
    return false;
  }

  try {
    const url = new URL(trimmed);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function validateSource(source) {
  const errors = [];

  if (!source || typeof source !== "object") {
    return ["source absente ou invalide"];
  }

  if (!isNonEmptyString(source.title)) {
    errors.push("title manquant");
  }

  if (!isValidHttpUrl(source.url)) {
    errors.push("url absente ou invalide");
  }

  if (!isNonEmptyString(source.publisher)) {
    errors.push("publisher manquant");
  }

  if (!["primary", "secondary"].includes(source.source_type)) {
    errors.push("source_type invalide");
  }

  if (!isNonEmptyString(source.supports_claim)) {
    errors.push("supports_claim manquant");
  }

  return errors;
}

export function validateResearchDossier(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Dossier research absent ou invalide"],
      warnings
    };
  }

  if (!Array.isArray(data.key_facts)) {
    errors.push("key_facts doit être un tableau");

    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.key_facts.forEach((fact, factIndex) => {
    const label = `key_facts[${factIndex}]`;

    if (!isNonEmptyString(fact?.claim)) {
      errors.push(`${label}: claim manquant`);
    }

    if (
      !["verified", "needs_verification", "uncertain"].includes(
        fact?.verification_status
      )
    ) {
      errors.push(`${label}: verification_status invalide`);
    }

    const sources = Array.isArray(fact?.sources)
      ? fact.sources
      : [];

    sources.forEach((source, sourceIndex) => {
      const sourceErrors = validateSource(source);

      for (const error of sourceErrors) {
        errors.push(
          `${label}.sources[${sourceIndex}]: ${error}`
        );
      }
    });

    if (
      fact?.verification_status === "verified" &&
      sources.length === 0
    ) {
      errors.push(
        `${label}: VERIFIED interdit sans source`
      );
    }

    if (
      fact?.verification_status === "verified" &&
      sources.length > 0
    ) {
      const hasUsableSource = sources.some(
        (source) => validateSource(source).length === 0
      );

      if (!hasUsableSource) {
        errors.push(
          `${label}: VERIFIED sans source exploitable`
        );
      }
    }

    if (
      fact?.importance === "high" &&
      fact?.verification_status !== "verified"
    ) {
      warnings.push(
        `${label}: fait HIGH non vérifié`
      );
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
