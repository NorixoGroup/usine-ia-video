import {
  createMessage,
  extractText
} from "../services/anthropic.js";

const SYSTEM_PROMPT = `
Tu es un validateur strict de grounding factuel pour un plan visuel documentaire.

Tu reçois :

1. un shot visuel ;
2. les claims factuels autorisés pour ce shot.

TA MISSION :

Déterminer si visual_description et asset_query introduisent
une ou plusieurs affirmations factuelles qui ne sont PAS couvertes
par les claims autorisés.

RÈGLE FONDAMENTALE :

Les claims autorisés constituent la FRONTIÈRE FACTUELLE ABSOLUE.

Un visuel peut reformuler ou représenter un fait autorisé,
mais il ne doit pas l'enrichir avec des informations nouvelles.

Tu dois notamment détecter comme non couvert tout ajout factuel
concernant :

- un lieu ou nom géographique plus précis ;
- une ville, région ou site particulier ;
- une couleur présentée comme caractéristique d'un lieu ;
- un type précis de paysage absent des claims ;
- un type précis de végétation ;
- une caractéristique du sol ;
- une caractéristique météorologique ou climatique ;
- une saison ;
- une population ou présence humaine particulière ;
- une infrastructure ;
- un animal ;
- une activité économique ;
- une institution ;
- une époque ou période historique ;
- une cause ou conséquence ;
- une comparaison ;
- une quantité ou proportion ;
- tout autre détail vérifiable sur le monde réel absent des claims.

EXEMPLES :

Claim autorisé :
"Une grande partie du territoire australien est constituée de régions arides ou semi-arides."

Acceptable :
"Vue aérienne générique d'une région aride australienne."

Non acceptable :
"Vue aérienne du désert australien avec des tons rouges et ocres caractéristiques de l'Outback."

Pourquoi :
"Outback", "tons rouges et ocres" et leur caractère supposé caractéristique
ajoutent des informations absentes du claim.

Non acceptable :
"Paysage semi-aride australien avec végétation clairsemée sous un ciel dégagé."

Pourquoi :
"végétation clairsemée" et "ciel dégagé" ajoutent des caractéristiques
absentes du claim.

IMPORTANT :

- Ne vérifie PAS si le visuel est esthétiquement pertinent.
- Ne vérifie PAS si l'asset existe.
- Ne fais aucune recherche web.
- N'utilise pas tes connaissances générales pour autoriser un détail.
- Un détail plausible reste non autorisé s'il n'est pas couvert.
- Une simple formulation atmosphérique non factuelle peut être acceptée.
- Si aucun claim n'est fourni, le shot ne peut contenir aucun détail
  factuel spécifique au sujet réel.

Réponds UNIQUEMENT avec un JSON valide.

Structure obligatoire :

{
  "grounded": true,
  "unsupported_visual_claims": [
    {
      "text": "",
      "field": "visual_description",
      "reason": ""
    }
  ]
}

field doit être exactement :

"visual_description"
ou
"asset_query"

Si aucune affirmation non couverte n'est détectée :

{
  "grounded": true,
  "unsupported_visual_claims": []
}

Si au moins une affirmation non couverte est détectée :

{
  "grounded": false,
  "unsupported_visual_claims": [...]
}

Aucun Markdown.
Aucun texte avant ou après le JSON.
`.trim();

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error(
      "Visual Factual Grounding Gate : réponse Anthropic vide."
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
        "Visual Factual Grounding Gate : JSON invalide. " +
        error.message
      );
    }
  }

  throw new Error(
    "Visual Factual Grounding Gate : aucun JSON détecté."
  );
}

export async function validateVisualFactualGrounding({
  visualDescription,
  assetQuery,
  claims
}) {
  if (
    typeof visualDescription !== "string" ||
    visualDescription.trim().length === 0
  ) {
    throw new Error(
      "Visual Factual Grounding Gate : visualDescription invalide."
    );
  }

  if (
    typeof assetQuery !== "string" ||
    assetQuery.trim().length === 0
  ) {
    throw new Error(
      "Visual Factual Grounding Gate : assetQuery invalide."
    );
  }

  if (!Array.isArray(claims)) {
    throw new Error(
      "Visual Factual Grounding Gate : claims doit être un tableau."
    );
  }

  const allowedClaims =
    claims.map((claim, index) => {
      if (
        typeof claim !== "string" ||
        claim.trim().length === 0
      ) {
        throw new Error(
          `Visual Factual Grounding Gate : claims[${index}] invalide.`
        );
      }

      return claim.trim();
    });

  const userPrompt = `
VISUAL DESCRIPTION :

${visualDescription}

ASSET QUERY :

${assetQuery}

CLAIMS FACTUELS AUTORISES :

${JSON.stringify(allowedClaims, null, 2)}

Vérifie strictement si le shot reste à l'intérieur
de cette frontière factuelle.
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

    maxTokens: 1200,

    temperature: 0
  });

  if (
    meta.stop_reason ===
    "max_tokens"
  ) {
    throw new Error(
      "Visual Factual Grounding Gate : réponse tronquée — stop_reason=max_tokens."
    );
  }

  const text =
    extractText(response);

  let data;

  try {
    data = parseJson(text);
  } catch (error) {
    throw new Error(
      "Visual Factual Grounding Gate : réponse invalide. " +
      error.message
    );
  }

  if (
    !data ||
    typeof data.grounded !== "boolean" ||
    !Array.isArray(
      data.unsupported_visual_claims
    )
  ) {
    throw new Error(
      "Visual Factual Grounding Gate : contrat JSON invalide."
    );
  }

  for (
    let index = 0;
    index <
    data.unsupported_visual_claims.length;
    index += 1
  ) {
    const item =
      data.unsupported_visual_claims[index];

    if (
      !item ||
      typeof item.text !== "string" ||
      item.text.trim().length === 0
    ) {
      throw new Error(
        `Visual Factual Grounding Gate : unsupported_visual_claims[${index}].text invalide.`
      );
    }

    if (
      item.field !== "visual_description" &&
      item.field !== "asset_query"
    ) {
      throw new Error(
        `Visual Factual Grounding Gate : unsupported_visual_claims[${index}].field invalide.`
      );
    }

    if (
      typeof item.reason !== "string" ||
      item.reason.trim().length === 0
    ) {
      throw new Error(
        `Visual Factual Grounding Gate : unsupported_visual_claims[${index}].reason invalide.`
      );
    }
  }

  if (
    data.grounded &&
    data.unsupported_visual_claims.length > 0
  ) {
    throw new Error(
      "Visual Factual Grounding Gate : incohérence — grounded=true avec claims non supportés."
    );
  }

  if (
    !data.grounded &&
    data.unsupported_visual_claims.length === 0
  ) {
    throw new Error(
      "Visual Factual Grounding Gate : incohérence — grounded=false sans claim non supporté."
    );
  }

  return {
    grounded: data.grounded,

    unsupported_visual_claims:
      data.unsupported_visual_claims.map(
        item => ({
          text: item.text.trim(),
          field: item.field,
          reason: item.reason.trim()
        })
      ),

    usage: meta
  };
}
