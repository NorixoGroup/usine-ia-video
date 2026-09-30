import {
  createMessage,
  extractText
} from "../services/anthropic.js";

const SYSTEM_PROMPT = `
Tu es un réparateur strict de couverture factuelle pour une voix-off documentaire.

Tu reçois :

1. un voiceover ;
2. les claims factuels autorisés ;
3. les affirmations factuelles détectées comme non déclarées.

TA MISSION :

Réécrire le voiceover afin que toutes les affirmations factuelles qu'il contient
soient couvertes par les claims autorisés.

RÈGLE FONDAMENTALE :

Les claims fournis constituent la FRONTIÈRE FACTUELLE ABSOLUE.

Tu peux :

- conserver les faits déjà couverts ;
- reformuler un claim sans changer son sens ;
- supprimer une affirmation non couverte ;
- remplacer une formulation factuelle non couverte par une transition narrative
  qui n'ajoute aucun fait ;
- améliorer légèrement la fluidité après suppression.

Tu ne peux JAMAIS :

- inventer un nouveau fait ;
- ajouter un nouveau claim ;
- enrichir un claim avec une information absente ;
- introduire un chiffre, une date, un lieu, une institution ou une attribution
  qui n'apparaît pas dans les claims ;
- ajouter une cause, une conséquence ou une relation explicative absente des claims ;
- transformer une affirmation détectée comme non déclarée en fait autorisé simplement
  en la reformulant ;
- utiliser tes connaissances générales ;
- effectuer une recherche externe ;
- modifier les claims.

IMPORTANT :

Si une information factuelle n'est pas couverte par les claims, SUPPRIME-LA.

La qualité stylistique est secondaire par rapport à la fidélité factuelle.

Le voiceover réparé doit rester naturel à l'oral.

Réponds UNIQUEMENT avec un JSON valide.

Structure obligatoire :

{
  "voiceover": ""
}

Aucun Markdown.
Aucun texte avant ou après le JSON.
`.trim();

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error(
      "Script Claim Coverage Repair : réponse Anthropic vide."
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
    "Script Claim Coverage Repair : aucun JSON détecté."
  );
}

export async function repairVoiceoverClaimCoverage({
  voiceover,
  claims,
  undeclaredClaims
}) {
  if (
    typeof voiceover !== "string" ||
    voiceover.trim().length === 0
  ) {
    throw new Error(
      "Script Claim Coverage Repair : voiceover absent ou invalide."
    );
  }

  if (!Array.isArray(claims)) {
    throw new Error(
      "Script Claim Coverage Repair : claims doit être un tableau."
    );
  }

  if (
    !Array.isArray(undeclaredClaims) ||
    undeclaredClaims.length === 0
  ) {
    throw new Error(
      "Script Claim Coverage Repair : undeclaredClaims doit être un tableau non vide."
    );
  }

  const allowedClaims = claims.map((claim, index) => {
    if (
      !claim ||
      typeof claim.text !== "string" ||
      claim.text.trim().length === 0
    ) {
      throw new Error(
        `Script Claim Coverage Repair : claims[${index}].text invalide.`
      );
    }

    return claim.text.trim();
  });

  const rejectedClaims = undeclaredClaims.map(
    (claim, index) => {
      if (
        !claim ||
        typeof claim.text !== "string" ||
        claim.text.trim().length === 0
      ) {
        throw new Error(
          `Script Claim Coverage Repair : undeclaredClaims[${index}].text invalide.`
        );
      }

      return {
        text: claim.text.trim(),
        reason:
          typeof claim.reason === "string"
            ? claim.reason.trim()
            : ""
      };
    }
  );

  const userPrompt = `
VOICEOVER ORIGINAL :

${voiceover}

CLAIMS FACTUELS AUTORISES :

${JSON.stringify(allowedClaims, null, 2)}

AFFIRMATIONS FACTUELLES NON DECLAREES A ELIMINER :

${JSON.stringify(rejectedClaims, null, 2)}

Réécris uniquement le voiceover.

Toutes les informations factuelles du résultat doivent rester à
l'intérieur des claims autorisés.

N'ajoute aucun nouveau fait.
`.trim();

  const { response, meta } = await createMessage({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt
      }
    ],
    maxTokens: 1800,
    temperature: 0
  });

  if (meta.stop_reason === "max_tokens") {
    throw new Error(
      "Script Claim Coverage Repair : réponse tronquée — stop_reason=max_tokens."
    );
  }

  const text = extractText(response);

  let data;

  try {
    data = parseJson(text);
  } catch (error) {
    throw new Error(
      "Script Claim Coverage Repair : JSON invalide. " +
      error.message
    );
  }

  if (
    !data ||
    typeof data.voiceover !== "string" ||
    data.voiceover.trim().length === 0
  ) {
    throw new Error(
      "Script Claim Coverage Repair : voiceover réparé invalide."
    );
  }

  return {
    voiceover: data.voiceover.trim(),
    usage: meta
  };
}
