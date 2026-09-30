import {
  QUALITY_VERDICT,
  auditPipelineArtifacts,
  describeMediaScope,
  measurePipelineArtifacts,
  validateQualityReport
} from "../utils/validate-quality-report.js";

// Quality Agent — dernier gate du pipeline.
//
// Il AUDITE les six artefacts persistés et ne répare rien : aucun
// modèle, aucune API, aucun juge rejoué. Un seul contrôle en échec fait
// échouer l'agent, et aucun rapport n'est alors produit.
//
// Le rapport indique toujours son périmètre (bloc "media") :
// - "contracts_only" : seuls les contrats ont été audités ;
// - "local_media" : les médias locaux rattachés ont en plus été
//   recontrôlés sur disque par la couche média, qui remet son rapport
//   (mediaVerification). L'agent ne lit lui-même aucun fichier ;
// - "rendered_video" : un MP4 a en plus été réellement rendu, décrit
//   par l'artefact render.json, et recontrôlé sur disque par la couche
//   de rendu, qui remet son rapport (renderVerification).
// Dans les deux premiers cas, aucune vidéo finale n'est produite ni
// inspectée : final_video reste "not_rendered".

export async function runQualityAgent({
  artifacts,
  target,
  testMode = false,
  mediaVerification,
  renderVerification,
  scriptDurationRange
}) {
  const mode = testMode ? "test" : "full";

  const { scope, checks, warnings } = auditPipelineArtifacts({
    artifacts,
    target,
    mode,
    mediaVerification,
    renderVerification,
    scriptDurationRange
  });

  const failedChecks = checks.filter(check => !check.valid);

  if (failedChecks.length > 0) {
    throw new Error(
      "Quality Agent : audit rejeté. " +
      failedChecks
        .map(
          check =>
            `[${check.id}] ${check.errors.join(" | ")}`
        )
        .join(" || ")
    );
  }

  const data = {
    title: artifacts.script.data.title,
    verdict: QUALITY_VERDICT,
    checks,
    metrics: measurePipelineArtifacts(artifacts),
    media: describeMediaScope(artifacts, scope),
    warnings
  };

  const validation = validateQualityReport(data);

  if (!validation.valid) {
    throw new Error(
      "Quality Agent : rapport rejeté par le Quality Gate. " +
      validation.errors.join(" | ")
    );
  }

  return {
    agent: "quality",
    mode,
    data,
    validation,
    usage: null
  };
}
