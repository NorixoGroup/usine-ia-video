import {
  validateScriptDossier
} from "../utils/validate-script.js";

import {
  VOICE_STATUS,
  VOICE_STATUS_SYNTHESIZED_LOCAL,
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
//
// Lorsque la couche média fournit des relevés d'inspection de fichiers
// audio locaux (localAudio, par unit_id), chaque unité est rattachée à
// son fichier : tout ou rien. L'agent ne lit lui-même aucun fichier et
// ne synthétise rien. estimated_seconds reste l'estimation du script ;
// la durée mesurée est dans audio.duration_seconds.

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function attachLocalAudio(narrationUnits, localAudio) {
  if (!isPlainObject(localAudio)) {
    throw new Error(
      "Voice Agent : relevés d'audio locaux invalides."
    );
  }

  const unitIds = narrationUnits.map(unit => unit.unit_id);

  const missing = unitIds.filter(
    id => !Object.hasOwn(localAudio, id)
  );

  if (missing.length > 0) {
    throw new Error(
      "Voice Agent : audio local manquant pour " +
      missing.join(", ") +
      "."
    );
  }

  const unexpected = Object.keys(localAudio).filter(
    id => !unitIds.includes(id)
  );

  if (unexpected.length > 0) {
    throw new Error(
      "Voice Agent : fichier audio sans unité correspondante — " +
      unexpected.join(", ") +
      "."
    );
  }

  for (const unit of narrationUnits) {
    unit.status = VOICE_STATUS_SYNTHESIZED_LOCAL;
    unit.audio = structuredClone(localAudio[unit.unit_id]);
  }
}

function buildManifest(script, localAudio) {
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

  if (localAudio !== undefined) {
    attachLocalAudio(narrationUnits, localAudio);
  }

  return {
    title: script.title,
    narration_units: narrationUnits,
    summary: summarizeNarration(narrationUnits)
  };
}

export async function runVoiceAgent({
  script,
  testMode = false,
  localAudio
}) {
  const scriptValidation = validateScriptDossier(script);

  if (!scriptValidation.valid) {
    throw new Error(
      "Voice Agent : script source invalide. " +
      scriptValidation.errors.join(" | ")
    );
  }

  const data = buildManifest(script, localAudio);

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
