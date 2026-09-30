import {
  validateAssetManifest
} from "../utils/validate-asset-manifest.js";

import {
  buildUnitId,
  validateVoiceManifest
} from "../utils/validate-voice-manifest.js";

import {
  ASSEMBLY_STATUS,
  roundTime,
  validateOutputSpec,
  validateAssemblyPlan,
  validateAssemblySourceMapping
} from "../utils/validate-assembly-plan.js";

// Assembly Agent — plan de montage déterministe.
//
// Aucun rendu, aucun FFmpeg, aucun fichier média : les manifestes
// d'assets et de narration validés sont posés sur une timeline à deux
// pistes. Aucune durée n'est corrigée : un écart entre l'image et la
// narration d'un segment fait échouer le Assembly Gate.

function buildTrack(items, toEntry) {
  const track = [];
  let cursor = 0;

  for (const item of items) {
    const entry = toEntry(item);
    const end = roundTime(cursor + entry.duration_seconds);

    track.push({
      ...entry.ids,
      start_seconds: cursor,
      end_seconds: end,
      duration_seconds: entry.duration_seconds
    });

    cursor = end;
  }

  return track;
}

function buildPlan(assets, voice, target) {
  const videoTrack = buildTrack(
    assets.assets,
    asset => ({
      ids: {
        asset_id: asset.asset_id,
        unit_id: buildUnitId(
          asset.section_index,
          asset.segment_index
        )
      },
      duration_seconds: asset.duration_seconds
    })
  );

  const audioTrack = buildTrack(
    voice.narration_units,
    unit => ({
      ids: {
        unit_id: unit.unit_id
      },
      duration_seconds: unit.estimated_seconds
    })
  );

  return {
    title: assets.title,
    output: {
      width: target.width,
      height: target.height,
      fps: target.fps,
      aspect_ratio: target.aspect_ratio
    },
    video_track: videoTrack,
    audio_track: audioTrack,
    summary: {
      total_clips: videoTrack.length,
      total_units: audioTrack.length,
      total_duration_seconds: videoTrack.at(-1).end_seconds
    },
    status: ASSEMBLY_STATUS
  };
}

export async function runAssemblyAgent({
  assets,
  voice,
  target,
  testMode = false
}) {
  const assetsValidation = validateAssetManifest(assets);

  if (!assetsValidation.valid) {
    throw new Error(
      "Assembly Agent : manifeste d'assets source invalide. " +
      assetsValidation.errors.join(" | ")
    );
  }

  const voiceValidation = validateVoiceManifest(voice);

  if (!voiceValidation.valid) {
    throw new Error(
      "Assembly Agent : manifeste voice source invalide. " +
      voiceValidation.errors.join(" | ")
    );
  }

  const targetErrors = validateOutputSpec(
    target,
    "cible de production"
  );

  if (targetErrors.length > 0) {
    throw new Error(
      "Assembly Agent : spécification de sortie invalide. " +
      targetErrors.join(" | ")
    );
  }

  const data = buildPlan(assets, voice, target);

  const validation = validateAssemblyPlan(data);

  if (!validation.valid) {
    throw new Error(
      "Assembly Agent : plan rejeté par le Assembly Gate. " +
      validation.errors.join(" | ")
    );
  }

  const sourceMappingValidation =
    validateAssemblySourceMapping(
      data,
      assets,
      voice,
      target
    );

  if (!sourceMappingValidation.valid) {
    throw new Error(
      "Assembly Agent : plan rejeté par le Source Mapping Gate. " +
      sourceMappingValidation.errors.join(" | ")
    );
  }

  return {
    agent: "assembly",
    mode: testMode ? "test" : "full",
    data,
    validation,
    source_mapping_validation: sourceMappingValidation,
    usage: null
  };
}
