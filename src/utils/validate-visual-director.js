function isNonEmptyString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function isFinitePositiveNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

export function validateVisualDirectorDossier(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object") {
    return {
      valid: false,
      errors: [
        "Visual Director dossier absent ou invalide"
      ],
      warnings
    };
  }

  if (!isNonEmptyString(data.title)) {
    errors.push("title manquant");
  }

  if (
    !Array.isArray(data.sections) ||
    data.sections.length === 0
  ) {
    errors.push(
      "sections doit être un tableau non vide"
    );

    return {
      valid: false,
      errors,
      warnings
    };
  }

  data.sections.forEach(
    (section, sectionIndex) => {
      const sectionLabel =
        `sections[${sectionIndex}]`;

      if (!isNonEmptyString(section?.title)) {
        errors.push(
          `${sectionLabel}: title manquant`
        );
      }

      if (
        !Array.isArray(section?.segments) ||
        section.segments.length === 0
      ) {
        errors.push(
          `${sectionLabel}: segments doit être un tableau non vide`
        );
        return;
      }

      section.segments.forEach(
        (segment, segmentIndex) => {
          const segmentLabel =
            `${sectionLabel}.segments[${segmentIndex}]`;

          if (
            !Number.isInteger(
              segment?.script_segment_index
            ) ||
            segment.script_segment_index < 0
          ) {
            errors.push(
              `${segmentLabel}: script_segment_index invalide`
            );
          }

          if (
            !isFinitePositiveNumber(
              segment?.estimated_seconds
            )
          ) {
            errors.push(
              `${segmentLabel}: estimated_seconds invalide`
            );
          }

          if (
            !Array.isArray(segment?.shots) ||
            segment.shots.length === 0
          ) {
            errors.push(
              `${segmentLabel}: shots doit être un tableau non vide`
            );
            return;
          }

          let totalShotSeconds = 0;

          segment.shots.forEach(
            (shot, shotIndex) => {
              const shotLabel =
                `${segmentLabel}.shots[${shotIndex}]`;

              if (
                !Number.isInteger(shot?.order) ||
                shot.order < 1
              ) {
                errors.push(
                  `${shotLabel}: order invalide`
                );
              }

              if (
                !isFinitePositiveNumber(
                  shot?.duration_seconds
                )
              ) {
                errors.push(
                  `${shotLabel}: duration_seconds invalide`
                );
              } else {
                totalShotSeconds +=
                  shot.duration_seconds;
              }

              if (
                !isNonEmptyString(
                  shot?.visual_description
                )
              ) {
                errors.push(
                  `${shotLabel}: visual_description manquant`
                );
              }

              if (
                !isNonEmptyString(
                  shot?.asset_query
                )
              ) {
                errors.push(
                  `${shotLabel}: asset_query manquant`
                );
              }

              const allowedTypes = [
                "stock_video",
                "map",
                "graphic",
                "archive",
                "generated"
              ];

              if (
                !allowedTypes.includes(
                  shot?.asset_type
                )
              ) {
                errors.push(
                  `${shotLabel}: asset_type invalide`
                );
              }

              if (
                typeof shot?.requires_exact_location !==
                "boolean"
              ) {
                errors.push(
                  `${shotLabel}: requires_exact_location doit être booléen`
                );
              }

              if (
                !Array.isArray(
                  shot?.research_fact_refs
                )
              ) {
                errors.push(
                  `${shotLabel}: research_fact_refs doit être un tableau`
                );
              } else if (
                shot.research_fact_refs.some(
                  ref =>
                    !Number.isInteger(ref) ||
                    ref < 0
                )
              ) {
                errors.push(
                  `${shotLabel}: research_fact_refs invalide`
                );
              }
            }
          );

          if (
            isFinitePositiveNumber(
              segment?.estimated_seconds
            ) &&
            Math.abs(
              totalShotSeconds -
              segment.estimated_seconds
            ) > 1
          ) {
            errors.push(
              `${segmentLabel}: durée totale des shots (${totalShotSeconds}s) ` +
              `différente de estimated_seconds (${segment.estimated_seconds}s)`
            );
          }
        }
      );
    }
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
