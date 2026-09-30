// Profils de durée (R14A).
//
// Source de vérité : config/pipeline.json.
// - "standard" : profil historique, dérivé des clés video.target_duration_minutes,
//   minimum_duration_minutes, maximum_duration_minutes et video.script_sections.
//   C'est le comportement par défaut, strictement identique à l'existant.
// - autres profils (ex. "short", jalon 3-5 min) : video.duration_profiles.<nom>.
//
// Ce module est pur : aucune I/O, aucun accès à l'environnement.

export const DEFAULT_DURATION_PROFILE = "standard";

// Valeurs historiques, utilisées quand aucun profil n'est fourni à un
// validateur ou à un agent (smokes, appels directs). Le smoke R14 vérifie
// qu'elles restent identiques au profil "standard" de la configuration.
export const STANDARD_DURATION_RANGE = Object.freeze({
  min: 25,
  max: 30
});

export const STANDARD_SCRIPT_SECTIONS = Object.freeze({
  min: 6,
  max: 8
});

export const STANDARD_DURATION_PROFILE = Object.freeze({
  name: DEFAULT_DURATION_PROFILE,
  target: 27,
  min: STANDARD_DURATION_RANGE.min,
  max: STANDARD_DURATION_RANGE.max,
  sections: STANDARD_SCRIPT_SECTIONS
});

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildProfile(name, raw) {
  const profile = {
    name,
    target: raw?.target_duration_minutes,
    min: raw?.minimum_duration_minutes,
    max: raw?.maximum_duration_minutes,
    sections: {
      min: raw?.script_sections?.minimum,
      max: raw?.script_sections?.maximum
    }
  };

  const valid =
    isPositiveNumber(profile.min) &&
    isPositiveNumber(profile.max) &&
    isPositiveNumber(profile.target) &&
    profile.min <= profile.target &&
    profile.target <= profile.max &&
    Number.isInteger(profile.sections.min) &&
    Number.isInteger(profile.sections.max) &&
    profile.sections.min >= 1 &&
    profile.sections.min <= profile.sections.max;

  if (!valid) {
    throw new Error(
      `Profil de durée "${name}" invalide dans config/pipeline.json : ` +
      "0 < minimum <= cible <= maximum et sections 1 <= minimum <= maximum attendus."
    );
  }

  return profile;
}

// Noms de profils disponibles, "standard" toujours en premier.
export function listDurationProfileNames(videoConfig) {
  return [
    DEFAULT_DURATION_PROFILE,
    ...Object.keys(videoConfig?.duration_profiles ?? {}).filter(
      name => name !== DEFAULT_DURATION_PROFILE
    )
  ];
}

export function resolveDurationProfile(
  videoConfig,
  name = DEFAULT_DURATION_PROFILE
) {
  if (typeof name !== "string" || name === "") {
    throw new Error("Profil de durée : nom obligatoire.");
  }

  const available = listDurationProfileNames(videoConfig);

  if (!available.includes(name)) {
    throw new Error(
      `Profil de durée inconnu "${name}". ` +
      `Valeurs admises : ${available.join(", ")}.`
    );
  }

  return buildProfile(
    name,
    name === DEFAULT_DURATION_PROFILE
      ? videoConfig
      : videoConfig.duration_profiles[name]
  );
}

// Plage {min, max} exploitable, ou undefined. Sert à transmettre la
// plage d'une production à un validateur sans jamais lever.
export function usableDurationRange(range) {
  return isPositiveNumber(range?.min) &&
    isPositiveNumber(range?.max) &&
    range.min <= range.max
    ? { min: range.min, max: range.max }
    : undefined;
}

// "25 à 30 minutes" : libellé utilisé dans les prompts.
export function formatDurationLabel(range = STANDARD_DURATION_RANGE) {
  return `${range.min} à ${range.max} minutes`;
}

// "6 à 8" : libellé du nombre de sections dans les prompts.
export function formatSectionsLabel(sections = STANDARD_SCRIPT_SECTIONS) {
  return `${sections.min} à ${sections.max}`;
}

// Profil tel qu'attendu par les agents : le profil standard si absent.
export function agentDurationProfile(profile) {
  return profile ?? STANDARD_DURATION_PROFILE;
}
