import {
  STANDARD_DURATION_RANGE,
  usableDurationRange
} from "./duration-profile.js";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export const SEGMENT_ROLE_HOOK = "hook";
export const SEGMENT_ROLE_CONCLUSION = "conclusion";

const SEGMENT_ROLES = [SEGMENT_ROLE_HOOK, SEGMENT_ROLE_CONCLUSION];

// Cadre narré (R14B) : le hook est le premier segment du script et la
// conclusion le dernier, tous deux de vrais segments avec leurs claims.
// Les champs historiques hook et conclusion en sont la copie exacte.
//
// Vérifié quand le script porte au moins un role, ou quand l'appelant
// l'exige (requireNarratedFrame). Un script historique, sans role, reste
// valide tel quel.
function validateNarratedFrame(data, errors, required) {
  const segments = [];

  data.sections.forEach((section, sectionIndex) => {
    (Array.isArray(section?.segments) ? section.segments : []).forEach(
      (segment, segmentIndex) => {
        segments.push({
          segment,
          label: `sections[${sectionIndex}].segments[${segmentIndex}]`
        });
      }
    );
  });

  const hasRole = segments.some(
    ({ segment }) => segment?.role !== undefined
  );

  if (!required && !hasRole) {
    return;
  }

  for (const { segment, label } of segments) {
    if (
      segment?.role !== undefined &&
      !SEGMENT_ROLES.includes(segment.role)
    ) {
      errors.push(
        `${label}: role invalide (admis : ${SEGMENT_ROLES.join(", ")})`
      );
    }
  }

  if (segments.length < 2) {
    errors.push(
      "cadre narré : au moins deux segments (hook et conclusion) sont requis"
    );

    return;
  }

  const frame = [
    [SEGMENT_ROLE_HOOK, segments[0], data.hook, "premier"],
    [
      SEGMENT_ROLE_CONCLUSION,
      segments[segments.length - 1],
      data.conclusion,
      "dernier"
    ]
  ];

  for (const [role, entry, field, position] of frame) {
    const holders = segments.filter(
      ({ segment }) => segment?.role === role
    );

    if (holders.length !== 1 || holders[0] !== entry) {
      errors.push(
        `cadre narré : le ${role} doit être le ${position} segment du ` +
        `script, et le seul de role "${role}"`
      );

      continue;
    }

    if (
      typeof entry.segment.voiceover !== "string" ||
      typeof field !== "string" ||
      entry.segment.voiceover.trim() !== field.trim()
    ) {
      errors.push(
        `${entry.label}: le voiceover doit être identique au champ ${role}`
      );
    }

    if (
      !Array.isArray(entry.segment.claims) ||
      entry.segment.claims.length === 0
    ) {
      errors.push(
        `${entry.label}: le segment ${role} doit porter au moins un claim`
      );
    }
  }
}

// Vrai si au moins un segment du script porte un role hook/conclusion.
export function scriptHasFrameRoles(data) {
  return (Array.isArray(data?.sections) ? data.sections : []).some(
    section =>
      (Array.isArray(section?.segments) ? section.segments : []).some(
        segment => segment?.role !== undefined
      )
  );
}

// Dérive les champs hook et conclusion de leurs segments (après une
// éventuelle réparation du voiceover). À n'appeler qu'une fois le cadre
// validé : le hook est le premier segment, la conclusion le dernier.
export function syncNarratedFrameFields(data) {
  const first = data.sections[0].segments[0];
  const lastSection = data.sections[data.sections.length - 1];
  const last = lastSection.segments[lastSection.segments.length - 1];

  data.hook = first.voiceover;
  data.conclusion = last.voiceover;

  return data;
}

// options.durationRange : plage {min, max} de la production (défaut :
// 25-30, comportement historique). options.requireNarratedFrame : exige
// le cadre narré même si le script ne porte aucun role.
export function validateScriptDossier(data, options = {}) {
  const durationRange =
    usableDurationRange(options.durationRange) ?? STANDARD_DURATION_RANGE;

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
    data.estimated_duration_minutes < durationRange.min ||
    data.estimated_duration_minutes > durationRange.max
  ) {
    errors.push(
      "estimated_duration_minutes doit être compris entre " +
      `${durationRange.min} et ${durationRange.max}`
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

  validateNarratedFrame(data, errors, options.requireNarratedFrame === true);

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
