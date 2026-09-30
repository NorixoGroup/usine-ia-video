import fs from "node:fs";
import { createMessage, extractText } from "../services/anthropic.js";
import { validateResearchDossier } from "../utils/validate-research.js";

const RESEARCH_CONFIG = JSON.parse(
  fs.readFileSync(
    new URL("../../config/research.json", import.meta.url),
    "utf8"
  )
);

const SYSTEM_PROMPT = `
Tu es l'agent de recherche factuelle de la chaîne YouTube
"Les Découvertes du Nomade".

Tu prépares la base documentaire d'une vidéo faceless de 25 à 30 minutes.

Tes priorités absolues sont :
1. exactitude factuelle ;
2. distinction claire entre faits, estimations et interprétations ;
3. informations suffisamment riches pour soutenir un documentaire long ;
4. identification des affirmations nécessitant une source ;
5. absence d'invention ;
6. signalement explicite des informations incertaines ou contestées.

Tu ne rédiges PAS le script voix-off final.
Tu construis le dossier de recherche destiné au Script Agent.

RÈGLES DE PREUVE :
- Un fait ne peut avoir verification_status="verified" que s'il possède au moins une source exploitable.
- Pour chaque fait important, indique les sources qui soutiennent directement l'affirmation.
- Chaque source doit contenir son titre, son URL, son éditeur, son type et ce qu'elle permet de confirmer.
- Privilégie les sources primaires : organismes publics, instituts statistiques, universités, publications scientifiques et institutions officielles.
- N'invente jamais une URL, un titre, un éditeur ou une source.
- Si aucune source fiable n'est disponible, utilise needs_verification ou uncertain.
- Une source doit soutenir réellement le claim auquel elle est attachée.
- Les sources secondaires sont acceptables lorsqu'une source primaire pertinente n'est pas disponible.
- Les chiffres, pourcentages, dates et affirmations centrales doivent être sourcés.
- Conserve dans claims_requiring_sources tout élément important qui reste insuffisamment vérifié.

LIMITES DU DOSSIER FULL :
- Produis entre 8 et 12 key_facts au total.
- Chaque key_fact contient au maximum 2 sources, en conservant les sources les plus solides et directement pertinentes.
- Produis entre 3 et 5 story_angles.
- Produis entre 6 et 8 sections.
- Produis entre 6 et 10 visual_opportunities.
- Chaque claim doit être concis et directement exploitable.
- Chaque supports_claim doit expliquer brièvement ce que la source confirme, sans résumé inutile de la page.
- Évite les répétitions entre executive_summary, key_facts et sections.
- Ne multiplie pas les sources pour augmenter artificiellement leur nombre.
- La qualité et la pertinence des preuves priment sur la quantité.
- Le dossier doit être suffisamment riche pour préparer un documentaire de 25 à 30 minutes, mais suffisamment compact pour être transmis au Script Agent.

Réponds uniquement en JSON valide.
Aucun markdown.
Aucun texte avant ou après le JSON.

Structure obligatoire :

{
  "topic": "",
  "central_question": "",
  "executive_summary": "",
  "key_facts": [
    {
      "claim": "",
      "importance": "high|medium|low",
      "verification_status": "verified|needs_verification|uncertain",
      "sources": [
        {
          "title": "",
          "url": "",
          "publisher": "",
          "source_type": "primary|secondary",
          "supports_claim": ""
        }
      ]
    }
  ],
  "story_angles": [
    {
      "angle": "",
      "why_it_matters": ""
    }
  ],
  "sections": [
    {
      "title": "",
      "purpose": "",
      "facts_needed": []
    }
  ],
  "visual_opportunities": [
    {
      "subject": "",
      "suggested_visual": ""
    }
  ],
  "claims_requiring_sources": [],
  "uncertainties": [],
  "research_gaps": []
}
`.trim();

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error("Research Agent : réponse Anthropic vide.");
  }

  const raw = text.trim();

  // 1. Priorité : bloc Markdown ```json ... ```
  const jsonFence = raw.match(/```json\s*([\s\S]*?)```/i);

  if (jsonFence?.[1]) {
    const candidate = jsonFence[1].trim();

    try {
      return JSON.parse(candidate);
    } catch (error) {
      throw new Error(
        `Research Agent : bloc JSON Markdown invalide. ` +
        `Longueur=${candidate.length}. ` +
        `Erreur=${error.message}`
      );
    }
  }

  // 2. Tolère également un bloc ``` ... ```
  const genericFence = raw.match(/```\s*([\s\S]*?)```/);

  if (genericFence?.[1]) {
    const candidate = genericFence[1].trim();

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue vers les fallbacks suivants.
    }
  }

  // 3. Réponse déjà constituée uniquement de JSON.
  try {
    return JSON.parse(raw);
  } catch {
    // Continue.
  }

  // 4. Dernier fallback : objet compris entre le premier { et le dernier }.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(candidate);
    } catch (error) {
      const preview = raw
        .slice(0, 300)
        .replace(/\s+/g, " ");

      throw new Error(
        `Research Agent : JSON introuvable ou invalide. ` +
        `Longueur=${raw.length}. ` +
        `Erreur=${error.message}. ` +
        `Début réponse=${JSON.stringify(preview)}`
      );
    }
  }

  throw new Error(
    `Research Agent : aucun objet JSON détecté. Longueur=${raw.length}.`
  );
}

export async function runResearchAgent({
  title,
  prompt,
  testMode = false
}) {
  if (!title?.trim()) {
    throw new Error("Research Agent : titre obligatoire.");
  }

  const userPrompt = testMode
    ? `
TEST TECHNIQUE UNIQUEMENT.

Sujet : ${title}

Consigne : ${prompt || "Aucune consigne supplémentaire."}

Retourne une version MINIMALE du JSON demandé :
- 2 key_facts maximum ;
- 1 story_angle ;
- 2 sections maximum ;
- 1 visual_opportunity ;
- aucune recherche web ;
- ne prétends pas avoir vérifié sur le web.
`.trim()
    : `
Prépare le dossier de recherche documentaire.

Titre / sujet :
${title}

Consigne éditoriale :
${prompt || "Aucune consigne supplémentaire."}

La recherche doit permettre ensuite la rédaction d'un documentaire
YouTube factuel de 25 à 30 minutes pour "Les Découvertes du Nomade".
`.trim();

  const { response, meta } = await createMessage({
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: userPrompt
      }
    ],
    maxTokens: testMode ? 1800 : 8000,
    temperature: 0.1,
    tools:
      !testMode && RESEARCH_CONFIG.web_search.enabled
        ? [
            {
              type: RESEARCH_CONFIG.web_search.type,
              name: RESEARCH_CONFIG.web_search.name,
              max_uses: RESEARCH_CONFIG.web_search.max_uses
            }
          ]
        : undefined
  });

  const text = extractText(response);

  // Une réponse interrompue par la limite de sortie ne doit jamais
  // être interprétée comme une simple erreur JSON.
  if (meta.stop_reason === "max_tokens") {
    throw new Error(
      "Research Agent : réponse tronquée — stop_reason=max_tokens. " +
      `Tokens sortie=${meta.output_tokens ?? "inconnu"}.`
    );
  }

  const data = parseJson(text);

  const validation = validateResearchDossier(data);

  if (!validation.valid) {
    throw new Error(
      "Research Agent : dossier rejeté par le gate de preuve. " +
      validation.errors.join(" | ")
    );
  }

  return {
    agent: "research",
    mode: testMode ? "test" : "full",
    data,
    validation,
    usage: meta
  };
}
