// R28.11 — contrôle du verrou de couverture persisté, à la reprise (baseline
// v1.0.3, sections 7 et 8). Le verrou complet (11 éléments, JUDGE_LOCK_KEYS)
// est enregistré dans les métadonnées Script (script.json,
// claim_coverage_validation.lock) lors du premier passage ; à la reprise, il
// est relu et comparé strictement au verrou courant.
//
// Fonction pure : aucune écriture, aucun appel, aucun état, aucune horloge.
// Ne lève jamais. Échec fermé, jamais de migration ni de repli :
//
//   aucun verrou enregistré                    → LOCK_MISSING
//   verrou incomplet, superflu ou mal formé    → LOCK_INVALID
//   empreinte différente                       → LOCK_SHA_MISMATCH
//   une version ou un contenu différent        → LOCK_MISMATCH (catégorie =
//                                                élément divergent, premier
//                                                dans l'ordre de la section 8)
//
// Ordre des contrôles : présence, forme du verrou enregistré, cohérence de son
// empreinte (verrou, puis segments), puis comparaison élément par élément au
// verrou courant, puis empreinte courante.

import { JUDGE_LOCK_KEYS, judgeLockSha256 } from "./coverage-judge-v2.js";

export const COVERAGE_LOCK_CHECK_VERSION = "coverage-lock-persistence.v1";

export const LOCK_CHECK_STATUS = Object.freeze({ OK: "OK", REFUSED: "REFUSED" });

export const LOCK_REFUSAL = Object.freeze({
  LOCK_MISSING: "LOCK_MISSING",
  LOCK_INVALID: "LOCK_INVALID",
  LOCK_SHA_MISMATCH: "LOCK_SHA_MISMATCH",
  LOCK_MISMATCH: "LOCK_MISMATCH"
});

const HEX64 = /^[0-9a-f]{64}$/;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validElement = value => typeof value === "string" && value !== "";

const outcome = (status, code = null, category = null, detail = null) =>
  Object.freeze({ version: COVERAGE_LOCK_CHECK_VERSION, status, code, category, detail });

const refused = (code, category, detail) => outcome(LOCK_CHECK_STATUS.REFUSED, code, category, detail);

// Première anomalie de forme d'un verrou : élément absent, vide ou non chaîne,
// puis élément superflu. Renvoie [catégorie, détail] ou null.
function shapeIssue(lock) {
  if (!isObject(lock)) return ["LOCK", "verrou absent ou illisible"];
  for (const key of JUDGE_LOCK_KEYS) {
    if (!validElement(lock[key])) return [key, `élément ${key} absent ou invalide`];
  }
  const extra = Object.keys(lock).find(key => !JUDGE_LOCK_KEYS.includes(key));
  if (extra !== undefined) return [extra, `élément ${extra} inconnu`];
  return null;
}

// coverage : claim_coverage_validation du script.json réutilisé.
// currentLock : verrou construit à partir des versions et des données courantes.
export function checkPersistedCoverageLock(input) {
  try {
    const { coverage, currentLock } = input ?? {};

    if (!isObject(coverage) || coverage.lock === undefined || coverage.lock === null) {
      return refused(LOCK_REFUSAL.LOCK_MISSING, "LOCK", "aucun verrou de couverture enregistré dans script.json");
    }

    const stored = coverage.lock;
    const storedIssue = shapeIssue(stored);
    if (storedIssue) return refused(LOCK_REFUSAL.LOCK_INVALID, storedIssue[0], `verrou enregistré : ${storedIssue[1]}`);
    if (typeof coverage.lock_sha256 !== "string" || !HEX64.test(coverage.lock_sha256)) {
      return refused(LOCK_REFUSAL.LOCK_INVALID, "lock_sha256", "empreinte enregistrée absente ou invalide");
    }
    if (!Array.isArray(coverage.segments)) {
      return refused(LOCK_REFUSAL.LOCK_INVALID, "segments", "segments enregistrés absents");
    }
    const currentIssue = shapeIssue(currentLock);
    if (currentIssue) return refused(LOCK_REFUSAL.LOCK_INVALID, "CURRENT_LOCK", `verrou courant : ${currentIssue[1]}`);

    if (judgeLockSha256(stored) !== coverage.lock_sha256) {
      return refused(LOCK_REFUSAL.LOCK_SHA_MISMATCH, "STORED_LOCK", "l'empreinte enregistrée ne correspond pas au verrou enregistré");
    }
    const strayIndex = coverage.segments.findIndex(segment => !isObject(segment) || segment.lock_sha256 !== coverage.lock_sha256);
    if (strayIndex !== -1) {
      return refused(LOCK_REFUSAL.LOCK_SHA_MISMATCH, "SEGMENT", `segments[${strayIndex}] : empreinte différente de celle du verrou`);
    }

    const divergent = JUDGE_LOCK_KEYS.find(key => stored[key] !== currentLock[key]);
    if (divergent !== undefined) {
      return refused(LOCK_REFUSAL.LOCK_MISMATCH, divergent, `élément ${divergent} : enregistré ${stored[divergent]}, courant ${currentLock[divergent]}`);
    }
    if (judgeLockSha256(currentLock) !== coverage.lock_sha256) {
      return refused(LOCK_REFUSAL.LOCK_SHA_MISMATCH, "CURRENT_LOCK", "l'empreinte enregistrée diffère de celle du verrou courant");
    }

    return outcome(LOCK_CHECK_STATUS.OK);
  } catch (error) {
    return refused(LOCK_REFUSAL.LOCK_INVALID, "UNEXPECTED", String(error?.message ?? error).slice(0, 200));
  }
}
