function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateScriptDossier(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: ["Script absent ou invalide"],
      warnings
    };
  }

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  if (!isNonEmptyString(data.hook)) {
    errors.push("hook manquant");
  }

  if (!isNonEmptyString(data.thesis)) {
    errors.push("thesis manquante");
  }

  if (!isFiniteNumber(data.estimated_duration_minutes)) {
    errors.push("estimated_duration_minutes invalide");
  } else if (
    data.estimated_duration_minutes < 25 ||
    data.estimated_duration_minutes > 30
  ) {
    errors.push(
      "estimated_duration_minutes doit être compris entre 25 et 30"
    );
  }

  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    errors.push("sections doit être un tableau non vide");

    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.sections.forEach((section, sectionIndex) => {
    const label = `sections[${sectionIndex}]`;

    if (!isNonEmptyString(section?.title)) {
      errors.push(`${label}: title manquant`);
    }

    if (!isNonEmptyString(section?.purpose)) {
      errors.push(`${label}: purpose manquant`);
    }

    if (!Array.isArray(section?.segments) || section.segments.length === 0) {
      errors.push(`${label}: segments doit être un tableau non vide`);
      return;
    }

    section.segments.forEach((segment, segmentIndex) => {
      const segmentLabel =
        `${label}.segments[${segmentIndex}]`;

      if (!isNonEmptyString(segment?.voiceover)) {
        errors.push(`${segmentLabel}: voiceover manquant`);
      }

      if (
        !isFiniteNumber(segment?.estimated_seconds) ||
        segment.estimated_seconds <= 0
      ) {
        errors.push(
          `${segmentLabel}: estimated_seconds invalide`
        );
      }

      if (!Array.isArray(segment?.research_fact_refs)) {
        errors.push(
          `${segmentLabel}: research_fact_refs doit être un tableau`
        );
      }

      if (
        Array.isArray(segment?.research_fact_refs) &&
        segment.research_fact_refs.some(
          ref => !Number.isInteger(ref) || ref < 0
        )
      ) {
        errors.push(
          `${segmentLabel}: research_fact_refs contient une référence invalide`
        );
      }

      if (
        typeof segment?.contains_unverified_claim !== "boolean"
      ) {
        errors.push(
          `${segmentLabel}: contains_unverified_claim doit être booléen`
        );
      }

      if (segment?.contains_unverified_claim === true) {
        warnings.push(
          `${segmentLabel}: contient une affirmation non vérifiée`
        );
      }
    });
  });

  if (!isNonEmptyString(data.conclusion)) {
    errors.push("conclusion manquante");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
