import {
  validateVisualDirectorDossier
} from "../utils/validate-visual-director.js";

import {
  ASSET_STATUS,
  ASSET_STATUS_RESOLVED_LOCAL,
  buildAssetId,
  summarizeAssets,
  validateAssetManifest,
  validateAssetManifestMapping
} from "../utils/validate-asset-manifest.js";

// Asset Agent — manifeste déterministe des BESOINS en assets.
//
// Aucun modèle, aucun fournisseur, aucun réseau : le plan visuel validé
// est transformé shot par shot, sans réécriture. Les assets ne sont ni
// recherchés, ni choisis, ni téléchargés ici.
//
// Lorsque la couche média fournit des relevés d'inspection de fichiers
// locaux (localMedia, par asset_id), chaque asset est rattaché à son
// fichier : tout ou rien. L'agent ne lit lui-même aucun fichier.

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function attachLocalMedia(assets, localMedia) {
  if (!isPlainObject(localMedia)) {
    throw new Error(
      "Asset Agent : relevés de médias locaux invalides."
    );
  }

  const assetIds = assets.map(asset => asset.asset_id);

  const missing = assetIds.filter(
    id => !Object.hasOwn(localMedia, id)
  );

  if (missing.length > 0) {
    throw new Error(
      "Asset Agent : média local manquant pour " +
      missing.join(", ") +
      "."
    );
  }

  const unexpected = Object.keys(localMedia).filter(
    id => !assetIds.includes(id)
  );

  if (unexpected.length > 0) {
    throw new Error(
      "Asset Agent : fichier média sans asset correspondant — " +
      unexpected.join(", ") +
      "."
    );
  }

  for (const asset of assets) {
    asset.status = ASSET_STATUS_RESOLVED_LOCAL;
    asset.media = structuredClone(localMedia[asset.asset_id]);
  }
}

function buildManifest(visual, localMedia) {
  const assets = [];

  visual.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      for (const shot of segment.shots) {
        assets.push({
          asset_id: buildAssetId(
            sectionIndex,
            segmentIndex,
            shot.order
          ),
          section_index: sectionIndex,
          segment_index: segmentIndex,
          shot_order: shot.order,
          asset_type: shot.asset_type,
          duration_seconds: shot.duration_seconds,
          visual_description: shot.visual_description,
          asset_query: shot.asset_query,
          requires_exact_location:
            shot.requires_exact_location,
          research_fact_refs: [...shot.research_fact_refs],
          status: ASSET_STATUS
        });
      }
    });
  });

  if (localMedia !== undefined) {
    attachLocalMedia(assets, localMedia);
  }

  return {
    title: visual.title,
    assets,
    summary: summarizeAssets(assets)
  };
}

export async function runAssetAgent({
  visual,
  testMode = false,
  localMedia
}) {
  const visualValidation =
    validateVisualDirectorDossier(visual);

  if (!visualValidation.valid) {
    throw new Error(
      "Asset Agent : plan visuel source invalide. " +
      visualValidation.errors.join(" | ")
    );
  }

  const data = buildManifest(visual, localMedia);

  const validation = validateAssetManifest(data);

  if (!validation.valid) {
    throw new Error(
      "Asset Agent : manifeste rejeté par le Asset Gate. " +
      validation.errors.join(" | ")
    );
  }

  const visualMappingValidation =
    validateAssetManifestMapping(data, visual);

  if (!visualMappingValidation.valid) {
    throw new Error(
      "Asset Agent : manifeste rejeté par le Visual Mapping Gate. " +
      visualMappingValidation.errors.join(" | ")
    );
  }

  return {
    agent: "asset",
    mode: testMode ? "test" : "full",
    data,
    validation,
    visual_mapping_validation: visualMappingValidation,
    usage: null
  };
}
