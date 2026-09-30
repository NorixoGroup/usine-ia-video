import {
  createMessage,
  extractText
} from "../services/anthropic.js";

import {
  validateResearchDossier
} from "../utils/validate-research.js";

import {
  validateScriptDossier,
  scriptHasFrameRoles,
  syncNarratedFrameFields
} from "../utils/validate-script.js";

import {
  agentDurationProfile,
  formatDurationLabel,
  formatSectionsLabel
} from "../utils/duration-profile.js";

import {
  validateScriptClaims
} from "../utils/validate-script-claims.js";

import {
  validateScriptClaimCoverage,
  validateVoiceoverClaimCoverage
} from "../utils/validate-script-claim-coverage.js";

import {
  repairVoiceoverClaimCoverage
} from "../utils/repair-script-claim-coverage.js";

const SYSTEM_PROMPT = `
Tu es le Script Agent de la chaîne YouTube
"Les Découvertes du Nomade".

Tu transformes un dossier de recherche VALIDÉ en script voix-off
pour un documentaire faceless YouTube de {{DUREE}}.

RÈGLES ABSOLUES :

1. Le dossier Research fourni est ta seule base factuelle.
2. Tu ne fais aucune recherche web.
3. Tu n'inventes aucun chiffre, date, lieu, citation ou fait.
4. Tu ne transformes jamais une hypothèse ou une incertitude en fait établi.
5. Tu privilégies les key_facts ayant verification_status="verified".
6. Si un élément non vérifié est nécessaire à la narration, il doit être
   explicitement présenté comme incertain et
   contains_unverified_claim doit être true.
7. Chaque segment doit indiquer les index des key_facts utilisés dans
   research_fact_refs.
8. Les index de research_fact_refs sont basés sur key_facts :
   premier fait = 0, deuxième fait = 1, etc.
9. N'ajoute aucune référence vers un fait qui ne soutient pas réellement
   le texte du segment.
10. Chaque segment doit contenir un tableau claims qui décompose les
    affirmations factuelles présentes dans le voiceover.
11. Chaque claim doit être atomique : une seule affirmation factuelle.
12. Chaque claim doit pointer vers exactement un key_fact avec
    research_fact_ref.
13. is_unverified doit être false lorsque le key_fact référencé est verified.
14. Si le key_fact référencé n'est pas verified, is_unverified doit être true
    et le voiceover doit clairement présenter l'affirmation comme incertaine.
15. N'introduis dans le voiceover aucune affirmation factuelle qui ne soit
    représentée dans claims et soutenue par le Research.

16. Un key_fact constitue une FRONTIÈRE FACTUELLE.
    Tu peux le reformuler ou le paraphraser sans en changer le sens,
    mais tu ne peux pas l'enrichir avec une information qui n'y figure pas.

17. Sont notamment interdits lorsqu'ils ne figurent pas explicitement dans
    le key_fact référencé :
    - un chiffre, une quantité, une proportion ou une comparaison ;
    - une date, une période ou une évolution historique ;
    - un lieu, une ville, une région ou un nom géographique ;
    - le nom d'une institution, d'une organisation ou d'une source ;
    - une caractéristique climatique, physique, économique ou sociale ;
    - une cause, une conséquence ou une relation explicative ;
    - une généralisation ou une conclusion factuelle supplémentaire ;
    - tout détail présenté comme vrai simplement parce qu'il paraît plausible.

18. Un claim ne doit jamais servir de prétexte pour introduire dans le
    voiceover plusieurs faits voisins absents du key_fact qui le soutient.

19. Avant de finaliser chaque segment, vérifie mentalement chaque phrase
    du voiceover :
    - si elle affirme quelque chose de vérifiable sur le monde réel,
      cette affirmation doit apparaître dans claims ;
    - le claim correspondant doit être soutenu par son key_fact ;
    - si aucun key_fact ne soutient cette affirmation, supprime-la du
      voiceover au lieu de l'inventer ou de la compléter.

20. Les formulations narratives, transitions et questions rhétoriques sont
    autorisées uniquement lorsqu'elles n'ajoutent aucune information
    factuelle nouvelle.

21. La fluidité documentaire ne justifie jamais l'ajout d'un fait absent
    du Research. En cas de conflit entre richesse narrative et fidélité
    factuelle, privilégie toujours la fidélité au Research.

22. Le texte doit être naturel à l'oral, fluide, précis et documentaire.
23. Évite le remplissage artificiel et les répétitions.
24. Le hook doit créer de la curiosité sans clickbait trompeur.
25. La narration complète doit viser {{DUREE}}.
26. Le script sera ensuite transmis au Visual Director et au Voice Agent.

Réponds uniquement avec un JSON valide.
Aucun Markdown.
Aucun texte avant ou après le JSON.

Structure obligatoire :

{
  "title": "",
  "hook": "",
  "thesis": "",
  "estimated_duration_minutes": {{CIBLE}},
  "sections": [
    {
      "title": "",
      "purpose": "",
      "segments": [
        {
          "voiceover": "",
          "estimated_seconds": 0,
          "research_fact_refs": [],
          "contains_unverified_claim": false,
          "claims": [
            {
              "text": "",
              "research_fact_ref": 0,
              "is_unverified": false
            }
          ]
        }
      ]
    }
  ],
  "conclusion": ""
}

CONSIGNES DE STRUCTURE :

- {{SECTIONS}} sections.
- Plusieurs segments par section lorsque nécessaire.
- Chaque segment doit rester suffisamment court pour être exploitable
  ensuite par le Visual Director.
- Chaque segment doit contenir au moins un claim factuel.
- Tous les faits exprimés dans le voiceover doivent être couverts par claims.
- Les research_fact_refs du segment doivent correspondre aux faits réellement
  utilisés par ses claims.
- La progression narrative doit être logique :
  hook -> problème -> explications -> approfondissement -> conclusion.
- estimated_seconds doit représenter raisonnablement la durée du texte
  prononcé.
`.trim();

// Règles ajoutées au prompt système quand le cadre narré est demandé
// (R14B). Sans cadre narré, le prompt historique est inchangé.
const FRAME_RULES = `
CADRE NARRÉ (obligatoire pour ce script) :

A. Le hook est le PREMIER segment de la PREMIÈRE section.
   Ce segment porte "role": "hook".
B. La conclusion est le DERNIER segment de la DERNIÈRE section.
   Ce segment porte "role": "conclusion".
C. Le champ "hook" du script reprend EXACTEMENT le voiceover du segment hook.
   Le champ "conclusion" reprend EXACTEMENT le voiceover du segment conclusion.
D. Le hook et la conclusion sont de vrais segments, narrés puis illustrés :
   ils ont estimated_seconds, research_fact_refs, contains_unverified_claim
   et claims, et obéissent à toutes les règles de fidélité factuelle
   ci-dessus (aucune affirmation hors claims).
E. Aucun autre segment ne porte de role.
F. Le hook et la conclusion s'appuient chacun sur au moins un key_fact.
`.trim();

const FRAME_REMINDER =
  'CADRE NARRÉ : le hook est le premier segment de la première section ' +
  '(role "hook") et la conclusion le dernier segment de la dernière ' +
  'section (role "conclusion"). Chacun porte ses claims ; les champs ' +
  "hook et conclusion reprennent exactement leur voiceover.";

// Adapte le prompt au profil de durée et au cadre narré. Avec le profil
// standard et sans cadre narré, le résultat est strictement le prompt
// historique (25 à 30 minutes, 27, 6 à 8 sections).
function buildSystemPrompt(profile, narratedFrame) {
  const prompt = SYSTEM_PROMPT
    .replaceAll("{{DUREE}}", formatDurationLabel(profile))
    .replaceAll("{{CIBLE}}", String(profile.target))
    .replaceAll("{{SECTIONS}}", formatSectionsLabel(profile.sections));

  return narratedFrame ? `${prompt}\n\n${FRAME_RULES}` : prompt;
}

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error("Script Agent : réponse Anthropic vide.");
  }

  const raw = text.trim();

  const jsonFence = raw.match(/```json\s*([\s\S]*?)```/i);

  if (jsonFence?.[1]) {
    try {
      return JSON.parse(jsonFence[1].trim());
    } catch (error) {
      throw new Error(
        "Script Agent : bloc JSON Markdown invalide. " +
        error.message
      );
    }
  }

  const genericFence = raw.match(/```\s*([\s\S]*?)```/);

  if (genericFence?.[1]) {
    try {
      return JSON.parse(genericFence[1].trim());
    } catch {
      // Continue.
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Continue.
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(
        raw.slice(firstBrace, lastBrace + 1)
      );
    } catch (error) {
      throw new Error(
        "Script Agent : JSON invalide. " +
        error.message
      );
    }
  }

  throw new Error(
    "Script Agent : aucun objet JSON détecté."
  );
}

function validateResearchReferences(script, research) {
  const errors = [];
  const maxIndex = research.key_facts.length - 1;

  script.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      for (const ref of segment.research_fact_refs ?? []) {
        if (ref > maxIndex) {
          errors.push(
            `sections[${sectionIndex}].segments[${segmentIndex}]: ` +
            `research_fact_ref ${ref} hors limites`
          );
          continue;
        }

        const fact = research.key_facts[ref];

        if (
          fact.verification_status !== "verified" &&
          segment.contains_unverified_claim !== true
        ) {
          errors.push(
            `sections[${sectionIndex}].segments[${segmentIndex}]: ` +
            `fait ${ref} non vérifié utilisé sans signalement`
          );
        }
      }
    });
  });

  return errors;
}

async function validateGeneratedScript(data, research, options = {}) {
  const validation = validateScriptDossier(data, options);

  if (!validation.valid) {
    throw new Error(
      "Script Agent : dossier rejeté par le Script Gate. " +
      validation.errors.join(" | ")
    );
  }

  const referenceErrors =
    validateResearchReferences(data, research);

  if (referenceErrors.length > 0) {
    throw new Error(
      "Script Agent : références Research invalides. " +
      referenceErrors.join(" | ")
    );
  }

  const claimValidation =
    validateScriptClaims(data, research);

  if (!claimValidation.valid) {
    throw new Error(
      "Script Agent : dossier rejeté par le Claim Gate. " +
      claimValidation.errors.join(" | ")
    );
  }

  const claimCoverageValidation = {
    valid: true,
    errors: [],
    segments: [],
    estimate: null
  };

  // Le premier contrôle couvre tous les segments par batches déterministes.
  // Les seules requêtes unitaires restantes sont les réparations et leur
  // recontrôle, déjà incluses dans le budget maximal estimé par le batcher.
  const initialBatchCoverage = await validateScriptClaimCoverage(data);
  claimCoverageValidation.estimate = initialBatchCoverage.estimate;
  const initialByLabel = new Map(
    initialBatchCoverage.segments.map(item => [item.label, item])
  );

  for (
    let sectionIndex = 0;
    sectionIndex < data.sections.length;
    sectionIndex += 1
  ) {
    const section = data.sections[sectionIndex];

    for (
      let segmentIndex = 0;
      segmentIndex < section.segments.length;
      segmentIndex += 1
    ) {
      const segment = section.segments[segmentIndex];

      const label =
        `sections[${sectionIndex}].segments[${segmentIndex}]`;

      const initialCoverage = initialByLabel.get(label);

      if (!initialCoverage) {
        throw new Error(
          `Script Agent : résultat batch absent pour ${label}.`
        );
      }

      let finalCoverage = initialCoverage;
      let repair = null;

      if (!initialCoverage.covered) {
        repair =
          await repairVoiceoverClaimCoverage({
            voiceover: segment.voiceover,
            claims: segment.claims,
            undeclaredClaims:
              initialCoverage.undeclared_claims
          });

        segment.voiceover = repair.voiceover;

        finalCoverage =
          await validateVoiceoverClaimCoverage({
            voiceover: segment.voiceover,
            claims: segment.claims
          });
      }

      claimCoverageValidation.segments.push({
        label,
        covered: finalCoverage.covered,
        repaired: repair !== null,
        initial_undeclared_claims:
          initialCoverage.undeclared_claims,
        undeclared_claims:
          finalCoverage.undeclared_claims,
        initial_usage: initialCoverage.usage,
        repair_usage: repair?.usage ?? null,
        usage: finalCoverage.usage
      });

      if (!finalCoverage.covered) {
        claimCoverageValidation.valid = false;

        const undeclared =
          finalCoverage.undeclared_claims
            .map(item => item.text)
            .join(" || ");

        claimCoverageValidation.errors.push(
          `${label}: affirmations factuelles non déclarées après réparation` +
          (undeclared ? ` — ${undeclared}` : "")
        );
      }
    }
  }

  if (!claimCoverageValidation.valid) {
    throw new Error(
      "Script Agent : dossier rejeté par le Voiceover Claim Coverage Gate. " +
      claimCoverageValidation.errors.join(" | ")
    );
  }

  // Cadre narré : hook et conclusion sont dérivés de leurs segments, qui
  // ont pu être réparés par le gate de couverture ci-dessus. Le script
  // final est revalidé.
  let finalValidation = validation;

  if (options.requireNarratedFrame || scriptHasFrameRoles(data)) {
    syncNarratedFrameFields(data);

    finalValidation = validateScriptDossier(data, options);

    if (!finalValidation.valid) {
      throw new Error(
        "Script Agent : dossier rejeté par le Script Gate après " +
        "réparation. " +
        finalValidation.errors.join(" | ")
      );
    }
  }

  return {
    validation: finalValidation,
    research_reference_validation: {
      valid: true,
      errors: []
    },
    claim_validation: claimValidation,
    claim_coverage_validation: claimCoverageValidation
  };
}

export async function runScriptAgent({
  research,
  title,
  testMode = false,
  durationProfile,
  narratedFrame = false
}) {
  const profile = agentDurationProfile(durationProfile);
  const validationOptions = {
    durationRange: { min: profile.min, max: profile.max },
    requireNarratedFrame: narratedFrame === true
  };

  const researchValidation =
    validateResearchDossier(research);

  if (!researchValidation.valid) {
    throw new Error(
      "Script Agent : dossier Research invalide. " +
      researchValidation.errors.join(" | ")
    );
  }

  const userPrompt = testMode
    ? `
TEST TECHNIQUE UNIQUEMENT.

Titre :
${title || research.topic}

À partir du dossier Research fourni ci-dessous, retourne un script
JSON MINIMAL permettant de tester le contrat technique.

Pour ce test uniquement :
- 2 sections ;
- ${narratedFrame ? "1 segment par section, hors hook et conclusion" : "1 segment par section"} ;
- estimated_duration_minutes doit rester entre ${profile.min} et ${profile.max} ;
- n'invente aucun fait.
${narratedFrame ? `\n${FRAME_REMINDER}\n` : ""}
DOSSIER RESEARCH :
${JSON.stringify(research)}
`.trim()
    : `
Rédige le script voix-off documentaire complet.

Titre :
${title || research.topic}

Le documentaire final doit durer entre ${profile.min} et ${profile.max} minutes.
${narratedFrame ? `\n${FRAME_REMINDER}\n` : ""}
Utilise exclusivement le dossier Research suivant.

DOSSIER RESEARCH :
${JSON.stringify(research)}
`.trim();

  const { response, meta } = await createMessage({
    system: buildSystemPrompt(profile, narratedFrame === true),
    messages: [
      {
        role: "user",
        content: userPrompt
      }
    ],
    maxTokens: testMode ? 2200 : 12000,
    temperature: 0.2
  });

  const text = extractText(response);

  if (meta.stop_reason === "max_tokens") {
    throw new Error(
      "Script Agent : réponse tronquée — stop_reason=max_tokens. " +
      `Tokens sortie=${meta.output_tokens ?? "inconnu"}.`
    );
  }

  const data = parseJson(text);

  const gateResult =
    await validateGeneratedScript(data, research, validationOptions);

  return {
    agent: "script",
    mode: testMode ? "test" : "full",
    data,
    ...gateResult,
    usage: meta
  };
}
