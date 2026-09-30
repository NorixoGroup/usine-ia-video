import {
  createMessage,
  extractText
} from "../services/anthropic.js";

import {
  validateScriptDossier
} from "../utils/validate-script.js";

import {
  validateVisualDirectorDossier
} from "../utils/validate-visual-director.js";

import {
  validateVisualFactualGrounding
} from "../utils/validate-visual-factual-grounding.js";

import {
  repairVisualFactualGrounding
} from "../utils/repair-visual-factual-grounding.js";

const SYSTEM_PROMPT = `
Tu es le Visual Director de la chaîne YouTube
"Les Découvertes du Nomade".

Tu transformes un script documentaire VALIDÉ en plan visuel
structuré destiné aux étapes suivantes de production.

Tu ne réécris PAS le script.

Tu décides comment illustrer visuellement chaque segment de voix-off.

RÈGLES ABSOLUES :

1. Le script fourni est ta seule base narrative et factuelle.

2. Tu ne fais aucune recherche web.

3. Tu n'inventes aucun fait, chiffre, lieu, événement,
   personne, institution ou détail absent du script.

4. Tu ne modifies jamais le voiceover.

5. Tu dois conserver exactement l'organisation du script :
   sections puis segments.

6. Chaque segment du script doit avoir une entrée correspondante
   dans ton plan visuel.

7. script_segment_index est l'index du segment à l'intérieur
   de sa section, en commençant à 0.

8. estimated_seconds doit être exactement la durée
   estimated_seconds du segment source.

9. Un segment peut et doit être découpé en plusieurs shots
   lorsque sa durée le nécessite.

10. Un shot représente une intention visuelle exploitable.

11. Chaque shot doit posséder :
    - order ;
    - duration_seconds ;
    - visual_description ;
    - asset_query ;
    - asset_type ;
    - requires_exact_location ;
    - research_fact_refs.

12. La somme des duration_seconds des shots d'un segment
    doit être égale à estimated_seconds du segment.

13. Les shots doivent être ordonnés à partir de 1.

14. Évite autant que possible les plans inutilement longs.
    Pour un documentaire faceless dynamique, privilégie généralement
    plusieurs plans courts plutôt qu'un seul plan couvrant tout
    un long segment.

15. visual_description décrit ce que le spectateur devrait voir.

16. asset_query est une requête concise et exploitable
    ultérieurement par un Asset Agent.

17. asset_query ne doit PAS inventer un lieu précis
    absent du script.

18. asset_query peut être en anglais lorsqu'une formulation anglaise
    facilite la recherche future de stock footage.

19. asset_type doit être exactement l'une de ces valeurs :

    "stock_video"
    "map"
    "graphic"
    "archive"
    "generated"

20. Utilise "stock_video" pour des images réelles génériques
    pouvant être recherchées dans une banque vidéo.

21. Utilise "map" lorsqu'une carte est la représentation
    la plus pertinente.

22. Utilise "graphic" pour une visualisation, un schéma,
    un chiffre ou une explication graphique.

23. Utilise "archive" uniquement lorsqu'un contenu historique
    ou documentaire d'archive est réellement justifié par le script.

24. Utilise "generated" lorsqu'un visuel généré est pertinent
    et qu'un plan réel n'est pas nécessaire.

25. requires_exact_location doit être true seulement lorsqu'il est
    important que le média montre réellement le lieu précis
    mentionné ou nécessaire dans le script.

26. Ne prétends jamais qu'une vidéo générique représente
    un lieu précis si cela n'est pas vérifié.

27. research_fact_refs doit uniquement reprendre des références
    présentes dans research_fact_refs du segment source.

28. N'ajoute jamais une research_fact_ref absente
    du segment source.

29. Si un shot est purement narratif ou atmosphérique et n'illustre
    directement aucun fait particulier, research_fact_refs peut
    être [].

30. Un visuel ne doit jamais introduire une affirmation factuelle
    nouvelle absente du script.

31. Le plan visuel doit être suffisamment précis pour que
    l'étape suivante puisse rechercher ou produire les assets
    sans devoir réinterpréter toute la narration.

32. Tu ne télécharges aucun asset.

33. Tu ne choisis aucune URL.

34. Tu ne prétends jamais qu'un asset existe.

35. Ta mission s'arrête à la création du PLAN VISUEL.

Réponds UNIQUEMENT avec un JSON valide.

Aucun Markdown.
Aucun texte avant ou après le JSON.

Structure obligatoire :

{
  "title": "",
  "sections": [
    {
      "title": "",
      "segments": [
        {
          "script_segment_index": 0,
          "estimated_seconds": 0,
          "shots": [
            {
              "order": 1,
              "duration_seconds": 0,
              "visual_description": "",
              "asset_query": "",
              "asset_type": "stock_video",
              "requires_exact_location": false,
              "research_fact_refs": []
            }
          ]
        }
      ]
    }
  ]
}
`.trim();

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error(
      "Visual Director : réponse Anthropic vide."
    );
  }

  const raw = text.trim();

  const jsonFence =
    raw.match(/```json\s*([\s\S]*?)```/i);

  if (jsonFence?.[1]) {
    return JSON.parse(
      jsonFence[1].trim()
    );
  }

  const genericFence =
    raw.match(/```\s*([\s\S]*?)```/);

  if (genericFence?.[1]) {
    try {
      return JSON.parse(
        genericFence[1].trim()
      );
    } catch {
      // Continue.
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Continue.
  }

  const firstBrace =
    raw.indexOf("{");

  const lastBrace =
    raw.lastIndexOf("}");

  if (
    firstBrace !== -1 &&
    lastBrace > firstBrace
  ) {
    try {
      return JSON.parse(
        raw.slice(
          firstBrace,
          lastBrace + 1
        )
      );
    } catch (error) {
      throw new Error(
        "Visual Director : JSON invalide. " +
        error.message
      );
    }
  }

  throw new Error(
    "Visual Director : aucun objet JSON détecté."
  );
}

function validateScriptMapping(
  visualPlan,
  script
) {
  const errors = [];

  if (
    visualPlan.sections.length !==
    script.sections.length
  ) {
    errors.push(
      "nombre de sections différent du script"
    );

    return errors;
  }

  script.sections.forEach(
    (scriptSection, sectionIndex) => {
      const visualSection =
        visualPlan.sections[sectionIndex];

      if (!visualSection) {
        errors.push(
          `sections[${sectionIndex}] absente`
        );
        return;
      }

      if (
        visualSection.segments.length !==
        scriptSection.segments.length
      ) {
        errors.push(
          `sections[${sectionIndex}]: nombre de segments différent du script`
        );

        return;
      }

      scriptSection.segments.forEach(
        (scriptSegment, segmentIndex) => {
          const visualSegment =
            visualSection.segments[
              segmentIndex
            ];

          const label =
            `sections[${sectionIndex}].segments[${segmentIndex}]`;

          if (
            visualSegment.script_segment_index !==
            segmentIndex
          ) {
            errors.push(
              `${label}: script_segment_index ne correspond pas au script`
            );
          }

          if (
            visualSegment.estimated_seconds !==
            scriptSegment.estimated_seconds
          ) {
            errors.push(
              `${label}: estimated_seconds différent du script`
            );
          }

          const allowedRefs =
            new Set(
              scriptSegment
                .research_fact_refs ?? []
            );

          for (
            const shot of
            visualSegment.shots ?? []
          ) {
            for (
              const ref of
              shot.research_fact_refs ?? []
            ) {
              if (!allowedRefs.has(ref)) {
                errors.push(
                  `${label}: shot utilise research_fact_ref ${ref} absent du segment source`
                );
              }
            }
          }
        }
      );
    }
  );

  return errors;
}

export async function runVisualDirector({
  script,
  testMode = false
}) {
  const scriptValidation =
    validateScriptDossier(script);

  if (!scriptValidation.valid) {
    throw new Error(
      "Visual Director : Script source invalide. " +
      scriptValidation.errors.join(" | ")
    );
  }

  const userPrompt = `
SCRIPT SOURCE VALIDE :

${JSON.stringify(script, null, 2)}

Construis le plan visuel complet correspondant.

Ne modifie aucune information du script.

Chaque segment source doit être représenté.

Respecte exactement ses estimated_seconds.

N'utilise dans les shots que les research_fact_refs
déjà présentes dans le segment source.
`.trim();

  const {
    response,
    meta
  } = await createMessage({
    system: SYSTEM_PROMPT,

    messages: [
      {
        role: "user",
        content: userPrompt
      }
    ],

    maxTokens:
      testMode ? 3500 : 12000,

    temperature: 0.2
  });

  if (
    meta.stop_reason ===
    "max_tokens"
  ) {
    throw new Error(
      "Visual Director : réponse tronquée — stop_reason=max_tokens. " +
      `Tokens sortie=${meta.output_tokens ?? "inconnu"}.`
    );
  }

  const text =
    extractText(response);

  const data =
    parseJson(text);

  const validation =
    validateVisualDirectorDossier(
      data
    );

  if (!validation.valid) {
    throw new Error(
      "Visual Director : dossier rejeté par le Visual Gate. " +
      validation.errors.join(" | ")
    );
  }

  const mappingErrors =
    validateScriptMapping(
      data,
      script
    );

  if (mappingErrors.length > 0) {
    throw new Error(
      "Visual Director : mapping Script invalide. " +
      mappingErrors.join(" | ")
    );
  }

  const factualGroundingValidation = {
    valid: true,
    errors: [],
    shots: []
  };

  for (
    let sectionIndex = 0;
    sectionIndex < data.sections.length;
    sectionIndex += 1
  ) {
    const visualSection = data.sections[sectionIndex];
    const scriptSection = script.sections[sectionIndex];

    for (
      let segmentIndex = 0;
      segmentIndex < visualSection.segments.length;
      segmentIndex += 1
    ) {
      const visualSegment =
        visualSection.segments[segmentIndex];

      const scriptSegment =
        scriptSection.segments[segmentIndex];

      for (
        let shotIndex = 0;
        shotIndex < visualSegment.shots.length;
        shotIndex += 1
      ) {
        const shot =
          visualSegment.shots[shotIndex];

        const label =
          `sections[${sectionIndex}].segments[${segmentIndex}].shots[${shotIndex}]`;

        const shotRefs =
          new Set(
            shot.research_fact_refs ?? []
          );

        const claims =
          (scriptSegment.claims ?? [])
            .filter(
              claim =>
                shotRefs.has(
                  claim.research_fact_ref
                )
            )
            .map(claim => claim.text)
            .filter(
              text =>
                typeof text === "string" &&
                text.trim().length > 0
            );

        const initialGrounding =
          await validateVisualFactualGrounding({
            visualDescription:
              shot.visual_description,
            assetQuery:
              shot.asset_query,
            claims
          });

        let finalGrounding = initialGrounding;
        let repair = null;

        if (!initialGrounding.grounded) {
          repair =
            await repairVisualFactualGrounding({
              shot,
              claims,
              unsupportedVisualClaims:
                initialGrounding
                  .unsupported_visual_claims
            });

          shot.visual_description =
            repair.visual_description;

          shot.asset_query =
            repair.asset_query;

          finalGrounding =
            await validateVisualFactualGrounding({
              visualDescription:
                shot.visual_description,
              assetQuery:
                shot.asset_query,
              claims
            });
        }

        factualGroundingValidation.shots.push({
          label,
          grounded: finalGrounding.grounded,
          repaired: repair !== null,
          initial_unsupported_visual_claims:
            initialGrounding
              .unsupported_visual_claims,
          unsupported_visual_claims:
            finalGrounding
              .unsupported_visual_claims,
          initial_usage:
            initialGrounding.usage,
          repair_usage:
            repair?.usage ?? null,
          usage:
            finalGrounding.usage
        });

        if (!finalGrounding.grounded) {
          factualGroundingValidation.valid = false;

          const unsupported =
            finalGrounding
              .unsupported_visual_claims
              .map(
                item =>
                  `[${item.field}] ${item.text}` +
                  (
                    item.reason
                      ? ` — ${item.reason}`
                      : ""
                  )
              )
              .join(" || ");

          factualGroundingValidation.errors.push(
            `${label}: affirmations visuelles factuelles non couvertes après réparation` +
            (
              unsupported
                ? ` — ${unsupported}`
                : ""
            )
          );
        }
      }
    }
  }

  if (!factualGroundingValidation.valid) {
    throw new Error(
      "Visual Director : dossier rejeté par le Visual Factual Grounding Gate. " +
      factualGroundingValidation.errors.join(" | ")
    );
  }

  return {
    agent: "visual_director",
    mode:
      testMode ? "test" : "full",
    data,
    validation,
    script_mapping_validation: {
      valid: true,
      errors: []
    },
    factual_grounding_validation:
      factualGroundingValidation,
    usage: meta
  };
}
