import {
  validateScriptDossier
} from "../utils/validate-script.js";

import {
  VOICE_STATUS,
  buildUnitId,
  summarizeNarration,
  validateVoiceManifest,
  validateVoiceManifestMapping
} from "../utils/validate-voice-manifest.js";

// Voice Agent — manifeste déterministe de la narration à produire.
//
// Aucun modèle, aucun fournisseur, aucun fichier audio : chaque
// segment.voiceover du script validé devient une unité de narration,
// recopiée à l'identique. hook, thesis et conclusion ne sont pas narrés.

function buildManifest(script) {
  const narrationUnits = [];

  script.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      narrationUnits.push({
        unit_id: buildUnitId(sectionIndex, segmentIndex),
        section_index: sectionIndex,
        segment_index: segmentIndex,
        text: segment.voiceover,
        estimated_seconds: segment.estimated_seconds,
        status: VOICE_STATUS
      });
    });
  });

  return {
    title: script.title,
    narration_units: narrationUnits,
    summary: summarizeNarration(narrationUnits)
  };
}

export async function runVoiceAgent({
  script,
  testMode = false
}) {
  const scriptValidation = validateScriptDossier(script);

  if (!scriptValidation.valid) {
    throw new Error(
      "Voice Agent : script source invalide. " +
      scriptValidation.errors.join(" | ")
    );
  }

  const data = buildManifest(script);

  const validation = validateVoiceManifest(data);

  if (!validation.valid) {
    throw new Error(
      "Voice Agent : manifeste rejeté par le Voice Gate. " +
      validation.errors.join(" | ")
    );
  }

  const scriptMappingValidation =
    validateVoiceManifestMapping(data, script);

  if (!scriptMappingValidation.valid) {
    throw new Error(
      "Voice Agent : manifeste rejeté par le Script Mapping Gate. " +
      scriptMappingValidation.errors.join(" | ")
    );
  }

  return {
    agent: "voice",
    mode: testMode ? "test" : "full",
    data,
    validation,
    script_mapping_validation: scriptMappingValidation,
    usage: null
  };
}
