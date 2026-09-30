import {
  QUALITY_VERDICT,
  auditPipelineArtifacts,
  measurePipelineArtifacts,
  validateQualityReport
} from "../utils/validate-quality-report.js";

// Quality Agent — dernier gate du pipeline.
//
// Il AUDITE les six artefacts persistés et ne répare rien : aucun
// modèle, aucune API, aucun juge rejoué. Un seul contrôle en échec fait
// échouer l'agent, et aucun rapport n'est alors produit.

export async function runQualityAgent({
  artifacts,
  target,
  testMode = false
}) {
  const mode = testMode ? "test" : "full";

  const { checks, warnings } = auditPipelineArtifacts({
    artifacts,
    target,
    mode
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
