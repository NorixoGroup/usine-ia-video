function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateScriptClaims(script, research) {
  const errors = [];
  const warnings = [];
  const claims = [];

  if (!script || !Array.isArray(script.sections)) {
    return {
      valid: false,
      errors: ["Script sections absent ou invalide"],
      warnings,
      claims
    };
  }

  if (!research || !Array.isArray(research.key_facts)) {
    return {
      valid: false,
      errors: ["Research key_facts absent ou invalide"],
      warnings,
      claims
    };
  }

  script.sections.forEach((section, sectionIndex) => {
    if (!Array.isArray(section?.segments)) {
      errors.push(
        `sections[${sectionIndex}]: segments absent ou invalide`
      );
      return;
    }

    section.segments.forEach((segment, segmentIndex) => {
      const segmentLabel =
        `sections[${sectionIndex}].segments[${segmentIndex}]`;

      if (!Array.isArray(segment?.claims) || segment.claims.length === 0) {
        errors.push(
          `${segmentLabel}: claims doit être un tableau non vide`
        );
        return;
      }

      segment.claims.forEach((claim, claimIndex) => {
        const label =
          `${segmentLabel}.claims[${claimIndex}]`;

        if (!isNonEmptyString(claim?.text)) {
          errors.push(`${label}: text manquant`);
          return;
        }

        if (
          !Number.isInteger(claim?.research_fact_ref) ||
          claim.research_fact_ref < 0 ||
          claim.research_fact_ref >= research.key_facts.length
        ) {
          errors.push(
            `${label}: research_fact_ref invalide ou hors limites`
          );

          claims.push({
            label,
            valid: false,
            reason: "INVALID_RESEARCH_REFERENCE"
          });

          return;
        }

        const fact =
          research.key_facts[claim.research_fact_ref];

        if (
          fact.verification_status !== "verified" &&
          claim?.is_unverified !== true
        ) {
          errors.push(
            `${label}: fait non vérifié utilisé sans is_unverified=true`
          );
        }

        if (typeof claim?.is_unverified !== "boolean") {
          errors.push(
            `${label}: is_unverified doit être booléen`
          );
        }

        claims.push({
          label,
          valid:
            fact.verification_status === "verified" ||
            claim?.is_unverified === true,
          research_fact_ref: claim.research_fact_ref,
          verification_status: fact.verification_status
        });
      });
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    claims
  };
}
