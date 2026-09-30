import {
  createMessage,
  extractText
} from "../services/anthropic.js";

const SYSTEM_PROMPT = `
Tu es un réparateur strict de grounding factuel
pour un shot de plan visuel documentaire.

Tu reçois :

1. le shot original ;
2. les claims factuels autorisés pour ce shot ;
3. les affirmations visuelles non supportées détectées
   par un validateur précédent.

TA MISSION :

Réécrire UNIQUEMENT :

- visual_description ;
- asset_query.

Le shot réparé doit rester strictement à l'intérieur
des claims factuels autorisés.

RÈGLES ABSOLUES :

1. Les claims autorisés constituent la frontière factuelle absolue.

2. Supprime ou généralise tout détail signalé comme non supporté.

3. N'ajoute aucun nouveau fait pour remplacer un fait supprimé.

4. N'utilise pas tes connaissances générales.

5. Ne fais aucune recherche web.

6. Ne modifie jamais :
   - order ;
   - duration_seconds ;
   - asset_type ;
   - requires_exact_location ;
   - research_fact_refs.

7. Si les claims autorisés sont vides,
   visual_description et asset_query doivent rester
   purement génériques et atmosphériques,
   sans détail factuel spécifique au sujet réel.

8. Une formulation moins précise est préférable
   à une formulation factuellement enrichie.

9. asset_query doit rester exploitable comme requête
   de recherche ou de génération d'asset,
   sans ajouter de détail non autorisé.

Réponds UNIQUEMENT avec un JSON valide.

Structure obligatoire :

{
  "visual_description": "",
  "asset_query": ""
}

Aucun Markdown.
Aucun texte avant ou après le JSON.
`.trim();

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error(
      "Visual Factual Grounding Repair : réponse Anthropic vide."
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
        "Visual Factual Grounding Repair : JSON invalide. " +
        error.message
      );
    }
  }

  throw new Error(
    "Visual Factual Grounding Repair : aucun JSON détecté."
  );
}

export async function repairVisualFactualGrounding({
  shot,
  claims,
  unsupportedVisualClaims
}) {
  if (!shot || typeof shot !== "object") {
    throw new Error(
      "Visual Factual Grounding Repair : shot invalide."
    );
  }

  if (
    typeof shot.visual_description !== "string" ||
    shot.visual_description.trim().length === 0
  ) {
    throw new Error(
      "Visual Factual Grounding Repair : visual_description invalide."
    );
  }

  if (
    typeof shot.asset_query !== "string" ||
    shot.asset_query.trim().length === 0
  ) {
    throw new Error(
      "Visual Factual Grounding Repair : asset_query invalide."
    );
  }

  if (!Array.isArray(claims)) {
    throw new Error(
      "Visual Factual Grounding Repair : claims doit être un tableau."
    );
  }

  if (!Array.isArray(unsupportedVisualClaims)) {
    throw new Error(
      "Visual Factual Grounding Repair : unsupportedVisualClaims doit être un tableau."
    );
  }

  const userPrompt = `
SHOT ORIGINAL :

${JSON.stringify(shot, null, 2)}

CLAIMS FACTUELS AUTORISES :

${JSON.stringify(claims, null, 2)}

AFFIRMATIONS VISUELLES NON SUPPORTEES :

${JSON.stringify(
  unsupportedVisualClaims,
  null,
  2
)}

Répare uniquement visual_description et asset_query.

N'ajoute aucun fait absent des claims autorisés.
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
      "Visual Factual Grounding Repair : réponse tronquée — stop_reason=max_tokens."
    );
  }

  const text =
    extractText(response);

  let data;

  try {
    data = parseJson(text);
  } catch (error) {
    throw new Error(
      "Visual Factual Grounding Repair : réponse invalide. " +
      error.message
    );
  }

  if (
    !data ||
    typeof data.visual_description !== "string" ||
    data.visual_description.trim().length === 0 ||
    typeof data.asset_query !== "string" ||
    data.asset_query.trim().length === 0
  ) {
    throw new Error(
      "Visual Factual Grounding Repair : contrat JSON invalide."
    );
  }

  return {
    visual_description:
      data.visual_description.trim(),

    asset_query:
      data.asset_query.trim(),

    usage: meta
  };
}
