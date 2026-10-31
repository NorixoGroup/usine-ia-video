// Sélection d'une unité de narration unique (mode pilote --narration-unit).
// Fonction pure : aucune I/O, aucun accès à l'environnement. Extraite de
// src/orchestrator/mvp.js pour être testée isolément, sans déclencher le
// CLI (le module mvp.js exécute des effets de bord dès son import).

export function selectNarrationUnits(plan, unitId) {
  if (!unitId) {
    return plan;
  }

  const selected = plan.filter((unit) => unit.unitId === unitId);

  if (selected.length === 0) {
    throw new Error(
      `Orchestrateur : --narration-unit "${unitId}" introuvable dans le plan de narration.`
    );
  }

  return selected;
}
