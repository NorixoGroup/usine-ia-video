import { createMessage, extractText } from "../services/anthropic.js";
import { assertRealCallBudget, getCallGuardStatus, discardCachedResponse } from "../services/call-guard.js";
import { classifyVoiceover } from "./factual-boundary.js";

export const MAX_CLAIMS_PER_BATCH = 24;
export const MAX_BATCH_ESTIMATED_CHARS = 9000;
export const CLAIM_COVERAGE_PROTOCOL = "claim-coverage.v2-deterministic-repair";

// Coûts fixes du JSON envoyé au juge. Ils font partie du contrat de
// planification : aucun tokenizer ni estimateur du modèle n'intervient.
const CLAIM_JSON_OVERHEAD_CHARS = 72;

// R25.7D — borne de sortie, déterministe. La réponse du juge recopie chaque
// phrase signalée (citation exacte) avec segment_id, claim_id et action, en
// JSON indenté. Pire cas : chaque phrase du voiceover est signalée. Constantes
// mesurées sur la production 842035 (appel 42) : ≈ 169 caractères de structure
// par entrée, 3,17 à 3,21 caractères par token ; arrondies prudemment.
export const MAX_OUTPUT_TOKENS = 2000;
export const OUTPUT_TOKEN_BUDGET = 1400;
const OUTPUT_ENTRY_OVERHEAD_CHARS = 170;
const OUTPUT_ITEM_OVERHEAD_CHARS = 80;
const OUTPUT_CHARS_PER_TOKEN = 3;

// Découpage fixe en phrases (fin . ! ? …, ou reste final).
export function countSentences(text) {
  return (text.match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? []).filter(part => part.trim()).length || 1;
}

function estimateItemOutputTokens({ voiceover }) {
  return Math.ceil(
    (voiceover.length + countSentences(voiceover) * OUTPUT_ENTRY_OVERHEAD_CHARS + OUTPUT_ITEM_OVERHEAD_CHARS) /
    OUTPUT_CHARS_PER_TOKEN
  );
}

// Ce contrat est identique pour le juge initial et les rechecks : seul le
// nombre d'items varie. Les résultats ne peuvent donc pas diverger sur une
// frontière factuelle ou un format de sortie différent.
const SYSTEM_PROMPT = `
Tu es un auditeur de couverture factuelle. Protocole : claim-coverage.v2-deterministic-repair.

Pour chaque élément, compare le voiceover avec ses claims factuels déclarés.
Signale chaque phrase factuelle vérifiable du voiceover non couverte par ces
claims. Tu ne vérifies pas la vérité, ne recherches rien, n'utilises aucune
connaissance extérieure et ne réécris jamais le texte. Les claims fournis
forment la seule frontière factuelle. Une reformulation équivalente est
couverte; une quantité, date, attribution, causalité, propriété ou conséquence
supplémentaire ne l'est pas.

Pour chaque phrase non couverte, retourne sa citation exacte, l'id exact du
segment et l'action fermée conseillée : DELETE, ou DECLARE seulement avec un
claim_id reçu qui désigne le key_fact approuvé qui remplacera exactement la
phrase. Pour DELETE, claim_id n'est pas requis (laisse-le vide). Ne retourne ni paraphrase, ni prose de remplacement, ni fait nouveau.

Chaque id reçu doit apparaître une seule fois, sans ajout, omission ni
réordonnancement. Réponds uniquement avec ce JSON :
{
  "results": [{
    "id": "",
    "covered": true,
    "unsupported": [{
      "sentence": "",
      "segment_id": "",
      "claim_id": "",
      "action": "DELETE"
    }]
  }]
}
covered=true exige unsupported=[]; covered=false exige au moins un objet.
`.trim();

function fail(message) { throw new Error(`Voiceover Claim Coverage : ${message}`); }
function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} doit être un entier positif.`);
}

function normalizeClaim(claim, id, index) {
  if (!claim || typeof claim.text !== "string" || !claim.text.trim()) fail(`${id}.claims[${index}].text invalide.`);
  return { claim_id: `${id}-c${index + 1}`, text: claim.text.trim(), research_fact_ref: claim.research_fact_ref };
}

// R25.7D : les phrases non factuelles par construction (questions,
// interpellations, transitions pures ; voir factual-boundary.js) sont retirées
// du voiceover d'un item de couverture. Un segment sans phrase restante
// contourne le juge (bypassed).
function normalizeItems(script) {
  if (!script || !Array.isArray(script.sections)) fail("Script sections absent ou invalide.");
  const items = [];
  const bypassed = [];
  const order = [];
  script.sections.forEach((section, sectionIndex) => {
    if (!Array.isArray(section?.segments)) fail(`sections[${sectionIndex}].segments invalide.`);
    section.segments.forEach((segment, segmentIndex) => {
      if (typeof segment?.voiceover !== "string" || !segment.voiceover.trim()) fail(`sections[${sectionIndex}].segments[${segmentIndex}].voiceover invalide.`);
      if (!Array.isArray(segment.claims)) fail(`sections[${sectionIndex}].segments[${segmentIndex}].claims invalide.`);
      const id = `s${sectionIndex + 1}-g${segmentIndex + 1}`;
      const claims = segment.claims.map((claim, claimIndex) => normalizeClaim(claim, id, claimIndex));
      if (claims.length > MAX_CLAIMS_PER_BATCH) fail(`${id}: ${claims.length} claims dépasse MAX_CLAIMS_PER_BATCH=${MAX_CLAIMS_PER_BATCH}.`);
      const label = `sections[${sectionIndex}].segments[${segmentIndex}]`;
      const boundary = classifyVoiceover(segment.voiceover);
      const voiceover = boundary.factual_voiceover;
      order.push(label);
      if (!voiceover) {
        bypassed.push({ id, label, claims, factual_boundary: boundary });
        return;
      }
      const estimated_chars = estimateItemChars({ voiceover, claims });
      const estimated_output_tokens = estimateItemOutputTokens({ voiceover });
      items.push({ id, label, voiceover, claims, estimated_chars, estimated_output_tokens, factual_boundary: boundary });
    });
  });
  return { items, bypassed, order };
}

function estimateItemChars({ voiceover, claims }) {
  return voiceover.length +
    claims.reduce(
      (total, claim) => total + CLAIM_JSON_OVERHEAD_CHARS + claim.text.length,
      0
    );
}

function summarizeBatch(items) {
  return {
    items,
    claim_count: items.reduce((total, item) => total + item.claims.length, 0),
    estimated_chars: items.reduce((total, item) => total + item.estimated_chars, 0),
    estimated_output_tokens: items.reduce((total, item) => total + item.estimated_output_tokens, 0)
  };
}

function batchItems(items) {
  const batches = []; let batch = []; let claimCount = 0;
  let estimatedChars = 0;
  let outputTokens = 0;

  for (const item of items) {
    const itemChars = item.estimated_chars;
    if (itemChars > MAX_BATCH_ESTIMATED_CHARS) {
      fail(`${item.id}: ${itemChars} caractères estimés dépasse MAX_BATCH_ESTIMATED_CHARS=${MAX_BATCH_ESTIMATED_CHARS}.`);
    }
    const itemOutput = item.estimated_output_tokens;
    if (itemOutput > OUTPUT_TOKEN_BUDGET) {
      fail(`${item.id}: ${itemOutput} tokens de sortie estimés (pire cas) dépasse OUTPUT_TOKEN_BUDGET=${OUTPUT_TOKEN_BUDGET}.`);
    }

    if (
      batch.length &&
      (
        claimCount + item.claims.length > MAX_CLAIMS_PER_BATCH ||
        estimatedChars + itemChars > MAX_BATCH_ESTIMATED_CHARS ||
        outputTokens + itemOutput > OUTPUT_TOKEN_BUDGET
      )
    ) {
      batches.push(summarizeBatch(batch));
      batch = [];
      claimCount = 0;
      estimatedChars = 0;
      outputTokens = 0;
    }

    batch.push(item);
    claimCount += item.claims.length;
    estimatedChars += itemChars;
    outputTokens += itemOutput;
  }
  if (batch.length) batches.push(summarizeBatch(batch));
  return batches;
}

export function planClaimValidationBatches(script) {
  const { items, bypassed, order } = normalizeItems(script);
  return { items, bypassed, order, batches: batchItems(items) };
}

function estimateFromPlan({ items, batches, bypassed = [] }) {
  const claimCount = items.reduce((total, item) => total + item.claims.length, 0);
  return {
    bypassed_count: bypassed.length,
    claim_count: claimCount,
    batch_size: MAX_CLAIMS_PER_BATCH,
    max_batch_estimated_chars: MAX_BATCH_ESTIMATED_CHARS,
    item_count: items.length,
    batch_count: batches.length,
    batch_estimated_chars: batches.map(batch => batch.estimated_chars),
    output_token_budget: OUTPUT_TOKEN_BUDGET,
    batch_estimated_output_tokens: batches.map(batch => batch.estimated_output_tokens),
    validation_calls_max: batches.length
  };
}

// Estimation pure : exactement le même planificateur que l'exécution, sans
// réserver ni consommer un appel.
export function estimateClaimValidationCalls({ script }) {
  return estimateFromPlan(planClaimValidationBatches(script));
}

function parseJson(text) {
  if (!text?.trim()) throw new Error("réponse Anthropic vide.");
  const raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return JSON.parse(fence[1].trim());
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf("{"); const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error("aucun JSON détecté.");
}

// Règle unique du protocole de couverture pour claim_id, partagée par le juge
// et la réparation. DELETE : claim_id ignoré — jamais vérifié ni utilisé, recopié
// tel quel s'il est une chaîne, null sinon. DECLARE : le claim_id s'il est
// connu, undefined sinon (l'appelant échoue fermé).
export function coverageOperationClaimId(entry, claimIds) {
  if (entry.action === "DELETE") return typeof entry.claim_id === "string" ? entry.claim_id : null;
  return typeof entry.claim_id === "string" && claimIds.has(entry.claim_id) ? entry.claim_id : undefined;
}

function validateUnsupported(item, unsupported) {
  if (!Array.isArray(unsupported)) fail(`${item.id}.unsupported doit être un tableau.`);
  const claimIds = new Set(item.claims.map(claim => claim.claim_id));
  const sentences = new Set();
  return unsupported.map((entry, index) => {
    if (!entry || typeof entry.sentence !== "string" || !entry.sentence.trim()) fail(`${item.id}.unsupported[${index}].sentence invalide.`);
    const sentence = entry.sentence.trim();
    if (!item.voiceover.includes(sentence)) fail(`${item.id}.unsupported[${index}].sentence absente du voiceover.`);
    if (sentences.has(sentence)) fail(`${item.id}.unsupported[${index}].sentence dupliquée.`);
    sentences.add(sentence);
    if (entry.segment_id !== item.id) fail(`${item.id}.unsupported[${index}].segment_id invalide.`);
    if (entry.action !== "DELETE" && entry.action !== "DECLARE") fail(`${item.id}.unsupported[${index}].action invalide.`);
    // R25.7C : DELETE ne référence aucun key_fact ; son claim_id est ignoré.
    // DECLARE exige un claim_id connu (fail-closed).
    const claimId = coverageOperationClaimId(entry, claimIds);
    if (claimId === undefined) fail(`${item.id}.unsupported[${index}].claim_id inconnu.`);
    return { sentence, segment_id: entry.segment_id, claim_id: claimId, action: entry.action };
  });
}

export function validateClaimBatchResponse(data, expected) {
  if (!data || typeof data !== "object" || !Array.isArray(data.results)) fail("réponse batch invalide : results absent.");
  if (data.results.length !== expected.length) fail("réponse batch incomplète ou avec résultats en trop.");
  const byId = new Map(expected.map(item => [item.id, item])); const seen = new Set();
  return data.results.map((result, index) => {
    if (!result || typeof result.id !== "string") fail(`résultat batch[${index}].id invalide.`);
    const item = byId.get(result.id); if (!item) fail(`résultat batch inconnu (${result.id}).`);
    if (seen.has(result.id)) fail(`résultat batch dupliqué (${result.id}).`); seen.add(result.id);
    if (typeof result.covered !== "boolean") fail(`${result.id}.covered doit être booléen.`);
    const unsupported = validateUnsupported(item, result.unsupported);
    if (result.covered && unsupported.length) fail(`${result.id}: covered=true avec unsupported.`);
    if (!result.covered && !unsupported.length) fail(`${result.id}: covered=false sans unsupported.`);
    return { id: result.id, covered: result.covered, unsupported };
  });
}

function coveragePayload(items) {
  return { protocol: CLAIM_COVERAGE_PROTOCOL, items: items.map(({ id, voiceover, claims }) => ({ id, voiceover, claims })) };
}

async function validateBatch(batch) {
  const { response, meta, request_sha256: requestHash } = await createMessage({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `ELEMENTS A CONTROLER :\n\n${JSON.stringify(coveragePayload(batch), null, 2)}` }],
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: 0
  });
  // R25.7D : une réponse tronquée ou rejetée n'est jamais rejouée par le cache
  // lors d'une reprise (même règle que les chapitres, R23-D).
  try {
    if (meta.stop_reason === "max_tokens") fail("réponse batch tronquée — stop_reason=max_tokens.");
    let data; try { data = parseJson(extractText(response)); } catch (error) { fail(`JSON batch invalide. ${error.message}`); }
    return { results: validateClaimBatchResponse(data, batch).map(result => ({ ...result, usage: meta })), usage: meta };
  } catch (error) {
    discardCachedResponse(requestHash);
    throw error;
  }
}

function oneItem({ voiceover, claims, id = "s1-g1" }) {
  if (typeof voiceover !== "string" || !voiceover.trim()) fail("voiceover absent ou invalide.");
  if (!Array.isArray(claims)) fail("claims doit être un tableau.");
  const normalized = claims.map((claim, index) => normalizeClaim(claim, id, index));
  const boundary = classifyVoiceover(voiceover);
  return { id, label: id, voiceover: boundary.factual_voiceover, claims: normalized, factual_boundary: boundary };
}

export async function validateVoiceoverClaimCoverage({ voiceover, claims, id = "s1-g1" }) {
  const item = oneItem({ voiceover, claims, id });
  // R25.7D : aucune phrase restante après la frontière → rien à soumettre au juge.
  if (!item.voiceover) return { valid: true, covered: true, unsupported: [], undeclared_claims: [], usage: null, bypassed: true };
  const judged = await validateBatch([item]); const result = judged.results[0];
  return {
    valid: result.covered,
    covered: result.covered,
    unsupported: result.unsupported,
    undeclared_claims: result.unsupported.map(item => ({ text: item.sentence, reason: item.action })),
    usage: result.usage
  };
}

export async function validateScriptClaimCoverage(script) {
  const plan = planClaimValidationBatches(script);
  const { items, batches } = plan;
  const estimate = { ...estimateFromPlan(plan), repair_calls_max: 0, recheck_calls_max: items.length, repair_and_recheck_calls_max: items.length, total_calls_max: batches.length + items.length };
  if (getCallGuardStatus().configured) assertRealCallBudget({ calls: estimate.batch_count, label: "validation batchée des claims" });
  const errors = []; const byLabel = new Map(); const usage = [];
  // R25.7D : segments sans phrase restante après la frontière, couverts sans appel au juge.
  for (const item of plan.bypassed) {
    byLabel.set(item.label, { label: item.label, id: item.id, claims: item.claims, covered: true, unsupported: [], undeclared_claims: [], usage: null, bypassed: true });
  }
  for (const batch of batches) {
    const judged = await validateBatch(batch.items); const byId = new Map(judged.results.map(result => [result.id, result]));
    for (const item of batch.items) {
      const result = byId.get(item.id);
      const undeclared = result.unsupported.map(entry => ({ text: entry.sentence, reason: entry.action }));
      byLabel.set(item.label, { label: item.label, id: item.id, claims: item.claims, covered: result.covered, unsupported: result.unsupported, undeclared_claims: undeclared, usage: result.usage });
      usage.push({ label: item.label, ...judged.usage });
      if (!result.covered) for (const unsupported of result.unsupported) errors.push(`${item.label}: affirmation factuelle non déclarée — ${unsupported.sentence}`);
    }
  }
  const segments = plan.order.map(label => byLabel.get(label));
  return { valid: errors.length === 0, errors, warnings: [], segments, usage, estimate };
}
