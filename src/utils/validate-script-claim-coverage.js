import {
  createMessage,
  extractText
} from "../services/anthropic.js";

const SYSTEM_PROMPT = `
Tu es un auditeur de couverture factuelle.

Ta seule mission est de comparer :

1. un texte de voix-off ;
2. la liste des claims factuels déclarés pour ce texte.

Tu dois détecter toute affirmation factuelle vérifiable présente dans
la voix-off mais absente des claims déclarés.

IMPORTANT :

Tu ne vérifies PAS si les affirmations sont vraies.
Tu ne fais AUCUNE recherche externe.
Tu n'utilises AUCUNE connaissance extérieure pour compléter le texte.
Tu ne réécris PAS le voiceover.
Tu ne proposes PAS de nouveaux faits.

Tu analyses uniquement la couverture entre le voiceover fourni
et les claims fournis.

Une affirmation factuelle est une proposition qui pourrait en principe
être vérifiée ou réfutée à partir d'une source.

Doivent notamment être considérés comme factuels :

- nombres, quantités, pourcentages et mesures ;
- dates, périodes et évolutions historiques ;
- lieux ou caractéristiques géographiques ;
- caractéristiques climatiques ou environnementales ;
- caractéristiques démographiques ;
- noms ou rôles attribués à des institutions ;
- attribution d'une information à une institution ou une source ;
- relations causales présentées comme réelles ;
- descriptions d'un état du monde présenté comme réel.

Ne doivent PAS être considérés seuls comme des faits à déclarer :

- transitions narratives ;
- annonces de structure ;
- questions rhétoriques ;
- formulations servant uniquement à introduire la suite ;
- commentaires narratifs sans information vérifiable autonome.

Un claim déclaré peut couvrir une reformulation équivalente du même fait.
N'exige pas une correspondance mot pour mot.

En revanche, un claim ne couvre PAS automatiquement :

- une nouvelle quantité ;
- une nouvelle date ;
- une nouvelle attribution ;
- une nouvelle causalité ;
- une nouvelle propriété ;
- une nouvelle conséquence factuelle ;
- une deuxième affirmation autonome simplement parce qu'elle apparaît
  dans la même phrase.

Exemple :

Voiceover :
"Ces régions sont arides, ce qui explique pourquoi elles restent
très peu peuplées."

Claim :
"Ces régions sont arides."

La causalité "l'aridité explique le faible peuplement" constitue
une affirmation factuelle supplémentaire non couverte.

Réponds UNIQUEMENT avec un JSON valide.

Structure obligatoire :

{
  "covered": true,
  "undeclared_claims": [
    {
      "text": "",
      "reason": ""
    }
  ]
}

RÈGLES DE SORTIE :

- covered=true uniquement s'il n'existe aucune affirmation factuelle
  non couverte.
- Si covered=true, undeclared_claims doit être [].
- Si covered=false, undeclared_claims doit contenir chaque affirmation
  factuelle non couverte identifiable.
- Ne retourne aucun Markdown.
- Aucun texte avant ou après le JSON.
`.trim();

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error(
      "Voiceover Claim Coverage : réponse Anthropic vide."
    );
  }

  const raw = text.trim();

  const jsonFence = raw.match(
    /```json\s*([\s\S]*?)```/i
  );

  if (jsonFence?.[1]) {
    return JSON.parse(jsonFence[1].trim());
  }

  const genericFence = raw.match(
    /```\s*([\s\S]*?)```/
  );

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
    return JSON.parse(
      raw.slice(firstBrace, lastBrace + 1)
    );
  }

  throw new Error(
    "Voiceover Claim Coverage : aucun JSON détecté."
  );
}

function validateJudgeResponse(data) {
  if (!data || typeof data !== "object") {
    throw new Error(
      "Voiceover Claim Coverage : verdict invalide."
    );
  }

  if (typeof data.covered !== "boolean") {
    throw new Error(
      "Voiceover Claim Coverage : covered doit être booléen."
    );
  }

  if (!Array.isArray(data.undeclared_claims)) {
    throw new Error(
      "Voiceover Claim Coverage : undeclared_claims doit être un tableau."
    );
  }

  for (
    let index = 0;
    index < data.undeclared_claims.length;
    index += 1
  ) {
    const claim = data.undeclared_claims[index];

    if (
      !claim ||
      typeof claim.text !== "string" ||
      claim.text.trim().length === 0
    ) {
      throw new Error(
        `Voiceover Claim Coverage : undeclared_claims[${index}].text invalide.`
      );
    }

    if (
      typeof claim.reason !== "string" ||
      claim.reason.trim().length === 0
    ) {
      throw new Error(
        `Voiceover Claim Coverage : undeclared_claims[${index}].reason invalide.`
      );
    }
  }

  if (
    data.covered === true &&
    data.undeclared_claims.length !== 0
  ) {
    throw new Error(
      "Voiceover Claim Coverage : verdict incohérent — covered=true avec claims non déclarés."
    );
  }

  if (
    data.covered === false &&
    data.undeclared_claims.length === 0
  ) {
    throw new Error(
      "Voiceover Claim Coverage : verdict incohérent — covered=false sans claim non déclaré."
    );
  }

  return data;
}

export async function validateVoiceoverClaimCoverage({
  voiceover,
  claims
}) {
  if (
    typeof voiceover !== "string" ||
    voiceover.trim().length === 0
  ) {
    throw new Error(
      "Voiceover Claim Coverage : voiceover absent ou invalide."
    );
  }

  if (!Array.isArray(claims)) {
    throw new Error(
      "Voiceover Claim Coverage : claims doit être un tableau."
    );
  }

  const declaredClaims = claims.map((claim, index) => {
    if (
      !claim ||
      typeof claim.text !== "string" ||
      claim.text.trim().length === 0
    ) {
      throw new Error(
        `Voiceover Claim Coverage : claims[${index}].text invalide.`
      );
    }

    return claim.text.trim();
  });

  const userPrompt = `
VOICEOVER :

${voiceover}

CLAIMS FACTUELS DECLARES :

${JSON.stringify(declaredClaims, null, 2)}

Détermine si TOUTES les affirmations factuelles vérifiables présentes
dans le voiceover sont couvertes par ces claims.

Rappel :
une reformulation sémantiquement équivalente est couverte ;
un fait supplémentaire, une attribution, un nombre, une date,
une propriété ou une causalité supplémentaire ne l'est pas.
`.trim();

  const { response, meta } = await createMessage({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt
      }
    ],
    maxTokens: 1000,
    temperature: 0
  });

  if (meta.stop_reason === "max_tokens") {
    throw new Error(
      "Voiceover Claim Coverage : réponse tronquée — stop_reason=max_tokens."
    );
  }

  const text = extractText(response);

  let data;

  try {
    data = parseJson(text);
  } catch (error) {
    throw new Error(
      "Voiceover Claim Coverage : JSON invalide. " +
      error.message
    );
  }

  const verdict = validateJudgeResponse(data);

  return {
    valid: verdict.covered === true,
    covered: verdict.covered,
    undeclared_claims: verdict.undeclared_claims,
    usage: meta
  };
}

export async function validateScriptClaimCoverage(script) {
  if (!script || !Array.isArray(script.sections)) {
    throw new Error(
      "Voiceover Claim Coverage : Script sections absent ou invalide."
    );
  }

  const errors = [];
  const segments = [];
  const usage = [];

  for (
    let sectionIndex = 0;
    sectionIndex < script.sections.length;
    sectionIndex += 1
  ) {
    const section = script.sections[sectionIndex];

    if (!Array.isArray(section?.segments)) {
      throw new Error(
        `Voiceover Claim Coverage : sections[${sectionIndex}].segments invalide.`
      );
    }

    for (
      let segmentIndex = 0;
      segmentIndex < section.segments.length;
      segmentIndex += 1
    ) {
      const segment = section.segments[segmentIndex];

      const label =
        `sections[${sectionIndex}].segments[${segmentIndex}]`;

      const result =
        await validateVoiceoverClaimCoverage({
          voiceover: segment?.voiceover,
          claims: Array.isArray(segment?.claims)
            ? segment.claims
            : []
        });

      segments.push({
        label,
        covered: result.covered,
        undeclared_claims:
          result.undeclared_claims
      });

      usage.push({
        label,
        ...result.usage
      });

      if (!result.covered) {
        for (const claim of result.undeclared_claims) {
          errors.push(
            `${label}: affirmation factuelle non déclarée — ${claim.text}`
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    segments,
    usage
  };
}
