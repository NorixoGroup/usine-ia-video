import {
  createMessage,
  extractText
} from "../services/anthropic.js";

import {
  assertRealCallBudget,
  getCallGuardStatus
} from "../services/call-guard.js";

// Un batch est borné par le nombre de claims déclarés, pas par une taille
// de texte implicite. Une unité (un segment et ses claims) ne peut pas être
// découpée : le juge doit voir son voiceover et tous ses claims ensemble.
export const MAX_CLAIMS_PER_BATCH = 24;

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

const BATCH_SYSTEM_PROMPT = `
Tu es un auditeur de couverture factuelle batché.

Chaque élément reçu contient un id stable, un voiceover et ses claims
factuels déclarés. Contrôle chaque élément indépendamment, sans inventer,
supprimer, fusionner ni réordonner les éléments ou les claims.

Réponds uniquement avec un JSON valide :
{
  "results": [
    {
      "id": "",
      "covered": true,
      "undeclared_claims": []
    }
  ]
}

Chaque id reçu doit apparaître exactement une fois dans results. Aucun id
inconnu ou dupliqué n'est admis. covered=true exige undeclared_claims=[] ;
covered=false exige au moins une affirmation non déclarée avec text et reason.
`.trim();

function fail(message) {
  throw new Error(`Voiceover Claim Coverage : ${message}`);
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} doit être un entier positif.`);
  }
}

// Estimation pure et sérialisable : elle ne touche ni au garde ni au réseau.
export function estimateClaimValidationCalls({ claimCount, batchSize = MAX_CLAIMS_PER_BATCH }) {
  assertPositiveInteger(batchSize, "batchSize");

  if (!Number.isSafeInteger(claimCount) || claimCount < 0) {
    fail("claimCount doit être un entier positif ou nul.");
  }

  return {
    claim_count: claimCount,
    batch_size: batchSize,
    batch_count: Math.ceil(claimCount / batchSize),
    // Une validation batchée par batch ; les réparations éventuelles sont
    // comptées ailleurs, par unité, car elles ne sont pas batchables.
    validation_calls_max: Math.ceil(claimCount / batchSize)
  };
}

function normalizeItems(script) {
  if (!script || !Array.isArray(script.sections)) {
    fail("Script sections absent ou invalide.");
  }

  const items = [];

  script.sections.forEach((section, sectionIndex) => {
    if (!Array.isArray(section?.segments)) {
      fail(`sections[${sectionIndex}].segments invalide.`);
    }

    section.segments.forEach((segment, segmentIndex) => {
      if (typeof segment?.voiceover !== "string" || !segment.voiceover.trim()) {
        fail(`sections[${sectionIndex}].segments[${segmentIndex}].voiceover invalide.`);
      }
      if (!Array.isArray(segment.claims)) {
        fail(`sections[${sectionIndex}].segments[${segmentIndex}].claims invalide.`);
      }

      const id = `s${sectionIndex + 1}-g${segmentIndex + 1}`;
      const claims = segment.claims.map((claim, claimIndex) => {
        if (typeof claim?.text !== "string" || !claim.text.trim()) {
          fail(`${id}.claims[${claimIndex}].text invalide.`);
        }
        return { claim_id: `${id}-c${claimIndex + 1}`, text: claim.text.trim() };
      });

      if (claims.length > MAX_CLAIMS_PER_BATCH) {
        fail(`${id}: ${claims.length} claims dépasse MAX_CLAIMS_PER_BATCH=${MAX_CLAIMS_PER_BATCH}.`);
      }

      items.push({
        id,
        label: `sections[${sectionIndex}].segments[${segmentIndex}]`,
        voiceover: segment.voiceover,
        claims
      });
    });
  });

  return items;
}

function batchItems(items) {
  const batches = [];
  let batch = [];
  let count = 0;

  for (const item of items) {
    if (batch.length > 0 && count + item.claims.length > MAX_CLAIMS_PER_BATCH) {
      batches.push(batch);
      batch = [];
      count = 0;
    }
    batch.push(item);
    count += item.claims.length;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function validateClaimBatchResponse(data, expected) {
  if (!data || typeof data !== "object" || !Array.isArray(data.results)) {
    fail("réponse batch invalide : results absent.");
  }
  if (data.results.length !== expected.length) {
    fail("réponse batch incomplète ou avec résultats en trop.");
  }

  const expectedIds = new Set(expected.map(item => item.id));
  const seen = new Set();

  return data.results.map((result, index) => {
    if (!result || typeof result.id !== "string") {
      fail(`résultat batch[${index}].id invalide.`);
    }
    if (!expectedIds.has(result.id)) fail(`résultat batch inconnu (${result.id}).`);
    if (seen.has(result.id)) fail(`résultat batch dupliqué (${result.id}).`);
    seen.add(result.id);
    return { id: result.id, ...validateJudgeResponse(result) };
  });
}

async function validateBatch(batch) {
  const { response, meta } = await createMessage({
    system: BATCH_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `ELEMENTS A CONTROLER :\n\n${JSON.stringify(batch.map(({ id, voiceover, claims }) => ({ id, voiceover, claims })), null, 2)}`
    }],
    maxTokens: 2000,
    temperature: 0
  });

  if (meta.stop_reason === "max_tokens") fail("réponse batch tronquée — stop_reason=max_tokens.");

  let data;
  try {
    data = parseJson(extractText(response));
  } catch (error) {
    fail(`JSON batch invalide. ${error.message}`);
  }

  return {
    results: validateClaimBatchResponse(data, batch).map(result => ({
      ...result,
      usage: meta
    })),
    usage: meta
  };
}

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
  const items = normalizeItems(script);
  const batches = batchItems(items);
  const claimCount = items.reduce((total, item) => total + item.claims.length, 0);
  const estimate = {
    ...estimateClaimValidationCalls({ claimCount }),
    item_count: items.length,
    batch_count: batches.length,
    // Chaque item peut, au pire, demander une réparation puis un contrôle
    // final. L'appelant qui active ces réparations peut réserver ce total.
    repair_and_recheck_calls_max: items.length * 2,
    total_calls_max: batches.length + items.length * 2
  };

  // En mode complet, le garde est déjà configuré avant l'agent Script.
  // En mode fixture/local il est absent : l'estimation reste observable mais
  // ne consomme rien et ne requiert aucune autorisation.
  // Seuls les lots sont réservés : les réparations éventuelles restent
  // bornées appel par appel par le garde, et reprises depuis le cache.
  if (getCallGuardStatus().configured) {
    assertRealCallBudget({
      calls: estimate.batch_count,
      label: "validation batchée des claims"
    });
  }

  const errors = [];
  const segments = [];
  const usage = [];

  for (const batch of batches) {
    const judged = await validateBatch(batch);
    const byId = new Map(judged.results.map(result => [result.id, result]));

    // Remappage dans l'ordre source, jamais dans l'ordre renvoyé par le juge.
    for (const item of batch) {
      const result = byId.get(item.id);
      segments.push({
        label: item.label,
        covered: result.covered,
        undeclared_claims: result.undeclared_claims,
        usage: result.usage
      });
      usage.push({ label: item.label, ...judged.usage });
      if (!result.covered) {
        for (const claim of result.undeclared_claims) {
          errors.push(`${item.label}: affirmation factuelle non déclarée — ${claim.text}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    segments,
    usage,
    estimate
  };
}
