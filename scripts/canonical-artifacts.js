// Artefacts canoniques partagés par les smokes Voice, Assembly et
// Quality. Même contenu que le pipeline fixtures : sujet Australie,
// 2 sections, 2 segments, 5 shots, 40 secondes.
//
// Données de TEST uniquement : aucun fichier de production n'importe ce
// module.

import {
  validateResearchDossier
} from "../src/utils/validate-research.js";

import {
  validateScriptDossier
} from "../src/utils/validate-script.js";

import {
  validateScriptClaims
} from "../src/utils/validate-script-claims.js";

import {
  validateVisualDirectorDossier
} from "../src/utils/validate-visual-director.js";

import crypto from "node:crypto";

import {
  buildCoverageLock,
  researchEntitiesOf
} from "../src/utils/coverage-lock-builder.js";
import {
  boundaryProtocolIdFromLock,
  lockSha256 as lockShaOf
} from "../src/utils/coverage-lock.js";
import { runAssetAgent } from "../src/agents/asset.js";
import { runVoiceAgent } from "../src/agents/voice.js";
import { runAssemblyAgent } from "../src/agents/assembly.js";

export const CANONICAL_TITLE =
  "Pourquoi 95 % de l'Australie est presque vide ?";

const CLAIM_ARID =
  "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.";

const CLAIM_POPULATION =
  "La population australienne est fortement concentrée dans les grandes zones urbaines et côtières.";

export const VOICEOVER_ARID =
  "D'après les éléments disponibles, qui restent à vérifier, une grande partie du territoire australien serait constituée de régions arides ou semi-arides.";

export const VOICEOVER_POPULATION =
  "Selon ces mêmes éléments, encore à confirmer, la population australienne serait fortement concentrée dans les grandes zones urbaines et côtières.";

// Même forme que production.target dans src/orchestrator/mvp.js.
export function buildTarget() {
  return {
    platform: "youtube",
    language: "fr",
    content_type: "documentary",
    duration_minutes: {
      target: 27,
      min: 25,
      max: 30
    },
    video: {
      aspect_ratio: "16:9",
      width: 3840,
      height: 2160,
      fps: 30
    }
  };
}

export function buildResearch() {
  return {
    topic: CANONICAL_TITLE,
    central_question:
      "Comment le territoire australien et la répartition de sa population s'articulent-ils ?",
    executive_summary:
      "Dossier minimal de test technique. Aucune recherche web n'a été effectuée : les deux faits retenus restent à vérifier.",
    key_facts: [
      {
        claim: CLAIM_ARID,
        importance: "high",
        verification_status: "needs_verification",
        sources: []
      },
      {
        claim: CLAIM_POPULATION,
        importance: "high",
        verification_status: "needs_verification",
        sources: []
      }
    ],
    story_angles: [
      {
        angle: "Un territoire immense face à une population concentrée",
        why_it_matters:
          "Ce contraste est la question centrale du documentaire."
      }
    ],
    sections: [
      {
        title: "L'intérieur aride",
        purpose:
          "Présenter les caractéristiques climatiques du territoire.",
        facts_needed: [
          "Part du territoire classée aride ou semi-aride"
        ]
      },
      {
        title: "Une population concentrée",
        purpose: "Présenter la répartition de la population.",
        facts_needed: [
          "Répartition de la population entre zones urbaines, côtières et intérieures"
        ]
      }
    ],
    visual_opportunities: [
      {
        subject: "Répartition de la population australienne",
        suggested_visual: "Carte de l'Australie"
      }
    ],
    claims_requiring_sources: [CLAIM_ARID, CLAIM_POPULATION],
    uncertainties: [
      "Aucun des faits du dossier n'a été vérifié auprès d'une source."
    ],
    research_gaps: [
      "Sources primaires à identifier pour chaque fait."
    ]
  };
}

export function buildScript() {
  return {
    title: CANONICAL_TITLE,
    hook:
      "Un territoire immense, et une population qui semble se tenir ailleurs.",
    thesis:
      "Le documentaire met en regard le territoire australien et la répartition de sa population.",
    estimated_duration_minutes: 27,
    sections: [
      {
        title: "L'intérieur aride",
        purpose:
          "Présenter les caractéristiques climatiques du territoire.",
        segments: [
          {
            voiceover: VOICEOVER_ARID,
            estimated_seconds: 20,
            research_fact_refs: [0],
            contains_unverified_claim: true,
            claims: [
              {
                text: CLAIM_ARID,
                research_fact_ref: 0,
                is_unverified: true
              }
            ]
          }
        ]
      },
      {
        title: "Une population concentrée",
        purpose: "Présenter la répartition de la population.",
        segments: [
          {
            voiceover: VOICEOVER_POPULATION,
            estimated_seconds: 20,
            research_fact_refs: [1],
            contains_unverified_claim: true,
            claims: [
              {
                text: CLAIM_POPULATION,
                research_fact_ref: 1,
                is_unverified: true
              }
            ]
          }
        ]
      }
    ],
    conclusion:
      "Ces deux éléments, qui restent à vérifier, structurent la suite de l'enquête."
  };
}

function shot(order, durationSeconds, description, query, type, refs) {
  return {
    order,
    duration_seconds: durationSeconds,
    visual_description: description,
    asset_query: query,
    asset_type: type,
    requires_exact_location: false,
    research_fact_refs: refs
  };
}

export function buildVisual() {
  return {
    title: CANONICAL_TITLE,
    sections: [
      {
        title: "L'intérieur aride",
        segments: [
          {
            script_segment_index: 0,
            estimated_seconds: 20,
            shots: [
              shot(
                1,
                8,
                "Vue aérienne d'une région aride australienne.",
                "Australian arid region aerial",
                "stock_video",
                [0]
              ),
              shot(
                2,
                7,
                "Carte de l'Australie mettant en évidence les régions arides et semi-arides.",
                "Australia arid semi-arid regions map",
                "map",
                [0]
              ),
              shot(
                3,
                5,
                "Plan atmosphérique abstrait de transition, sans lieu identifiable.",
                "abstract atmospheric transition background",
                "generated",
                []
              )
            ]
          }
        ]
      },
      {
        title: "Une population concentrée",
        segments: [
          {
            script_segment_index: 0,
            estimated_seconds: 20,
            shots: [
              shot(
                1,
                12,
                "Carte de l'Australie montrant la concentration de la population dans les grandes zones urbaines et côtières.",
                "Australia population concentration urban coastal map",
                "map",
                [1]
              ),
              shot(
                2,
                8,
                "Vue générique d'une grande zone urbaine côtière australienne.",
                "Australian coastal urban area",
                "stock_video",
                [1]
              )
            ]
          }
        ]
      }
    ]
  };
}

function usage(fixtureId) {
  return {
    model: `fixture:${fixtureId}`,
    input_tokens: 1000,
    output_tokens: 100,
    stop_reason: "end_turn",
    duration_ms: 0
  };
}

function buildResearchEnvelope(mode) {
  const data = buildResearch();

  return {
    agent: "research",
    mode,
    data,
    validation: validateResearchDossier(data),
    usage: usage("research")
  };
}

function buildScriptEnvelope(mode) {
  const data = buildScript();
  const segments = [];

  // Métadonnées de couverture au format de production (R28.10 à R28.11) : un
  // segment PASS au premier tour, sous le verrou courant.
  const lock = buildCoverageLock({
    entities: researchEntitiesOf(buildResearch())
  });
  const lockSha256 = lockShaOf(lock);
  const protocolId = boundaryProtocolIdFromLock(lock);

  data.sections.forEach(section => {
    section.segments.forEach(segment => {
      segments.push({
        status: "PASS",
        covered: true,
        undeclared_claims: [],
        protocol_id: protocolId,
        lock_sha256: lockSha256,
        voiceover_sha256: crypto
          .createHash("sha256")
          .update(segment.voiceover, "utf8")
          .digest("hex"),
        rounds: 1,
        repair_count: 0
      });
    });
  });

  return {
    agent: "script",
    mode,
    data,
    validation: validateScriptDossier(data),
    research_reference_validation: {
      valid: true,
      errors: []
    },
    claim_validation: validateScriptClaims(data, buildResearch()),
    claim_coverage_validation: {
      valid: true,
      errors: [],
      status: "PASS",
      protocol_id: protocolId,
      lock_sha256: lockSha256,
      lock: { ...lock },
      segments
    },
    usage: usage("script")
  };
}

function buildVisualEnvelope(mode) {
  const data = buildVisual();
  const shots = [];

  data.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      segment.shots.forEach((item, shotIndex) => {
        shots.push({
          label:
            `sections[${sectionIndex}].segments[${segmentIndex}].shots[${shotIndex}]`,
          grounded: true,
          repaired: false,
          initial_unsupported_visual_claims: [],
          unsupported_visual_claims: [],
          initial_usage: usage("validate-visual-factual-grounding"),
          repair_usage: null,
          usage: usage("validate-visual-factual-grounding")
        });
      });
    });
  });

  return {
    agent: "visual_director",
    mode,
    data,
    validation: validateVisualDirectorDossier(data),
    script_mapping_validation: {
      valid: true,
      errors: []
    },
    factual_grounding_validation: {
      valid: true,
      errors: [],
      shots
    },
    usage: usage("visual-director")
  };
}

// Construit les six enveloppes telles que l'orchestrateur les persiste.
// Les agents 4 à 6, déterministes, sont réellement exécutés.
export async function buildArtifacts({ mode = "test" } = {}) {
  const testMode = mode === "test";

  const research = buildResearchEnvelope(mode);
  const script = buildScriptEnvelope(mode);
  const visual = buildVisualEnvelope(mode);

  const assets = await runAssetAgent({
    visual: visual.data,
    testMode
  });

  const voice = await runVoiceAgent({
    script: script.data,
    testMode
  });

  const assembly = await runAssemblyAgent({
    assets: assets.data,
    voice: voice.data,
    target: buildTarget().video,
    testMode
  });

  return {
    research,
    script,
    visual,
    assets,
    voice,
    assembly
  };
}
