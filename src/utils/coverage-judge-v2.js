// R28.6 — juge de couverture v2, par identifiants d'unités (baseline v1.0.1,
// contrat 4.5, option B ; sections 7 et 8 ; invariants I8, I16, I17, I22,
// I23). Aucun appelant à ce stade.
//
// Un lot = un segment complet (I23). Le juge reçoit la sortie de la frontière
// composée (R28.5), le verrou complet et les claims du segment. Il ne relit
// pas le voiceover d'ailleurs et ne recalcule ni normalisation, ni unités, ni
// protection, ni classification : le voiceover transmis au modèle est la
// concaténation exacte des unités (I21), contrôlée contre voiceover_sha256
// (I8). Il ne répare jamais : il propose seulement une opération fermée.
//
// Requête : protocol_id, voiceover_sha256, lock_sha256, identifiant du
// segment, voiceover complet transmis une seule fois, liste numérotée de
// toutes les unités (identifiant et type, sans position ni texte),
// identifiants désignés (exactement les unités analysées par la frontière,
// I22) et claims avec claim_id.
//
// Réponse attendue : protocol_id, voiceover_sha256, lock_sha256 et segment_id
// identiques ; un résultat par identifiant désigné (unit_id, verdict,
// operations). Aucune citation ni texte : tout champ hors schéma rejette la
// réponse entière.
//
// Échecs qualifiés (jamais de faux PASS) :
//   INPUT_REFUSED  avant tout appel : composant absent, verrou incomplet ou
//                  divergent, empreintes, frontière ou désignation
//                  incohérentes ;
//   OUT_OF_BOUNDS  avant tout appel : segment hors bornes d'entrée ou de
//                  sortie dans le pire cas ; il n'est jamais découpé ;
//   NOT_JUDGED     après l'appel : réponse tronquée, illisible ou hors
//                  protocole, ou appel en échec. Le juge SIGNALE le rejet
//                  (request_sha256) ; il ne touche jamais au cache.
// Un segment sans unité désignée est couvert sans appel.

import crypto from "node:crypto";

import { extractText } from "../services/anthropic.js";
import { ARCHITECTURE_BASELINE_VERSION, BOUNDARY_LOCK_KEYS, COMPOSITE_COVERAGE_BOUNDARY_VERSION, boundaryProtocolIdFromLock, invalidLockElements, lockSha256 } from "./coverage-lock.js";

export const COVERAGE_JUDGE_V2_PROTOCOL = "coverage-judge.v2-unit-ids";
export const COVERAGE_JUDGE_V2_RULES_VERSION = "coverage-judge.v2";

export const JUDGE_STATUS = Object.freeze({
  JUDGED: "JUDGED",
  NO_DESIGNATED_UNITS: "NO_DESIGNATED_UNITS",
  FAILED: "FAILED"
});

export const JUDGE_FAILURE = Object.freeze({
  INPUT_REFUSED: "INPUT_REFUSED",
  OUT_OF_BOUNDS: "OUT_OF_BOUNDS",
  NOT_JUDGED: "NOT_JUDGED"
});

export const JUDGE_VERDICT = Object.freeze({ COVERED: "COVERED", UNCOVERED: "UNCOVERED" });

// Bornes (section 8, élément 8), fixées avant tout appel. Sortie dans le pire
// cas : chaque unité désignée non couverte avec DECLARE et un claim_id.
export const JUDGE_BOUNDS = Object.freeze({
  max_tokens: 2000,
  output_token_budget: 1400,
  output_envelope_chars: 340,
  output_entry_chars: 140,
  output_chars_per_token: 3,
  max_input_chars: 12000,
  max_claims: 24
});

const SYSTEM_PROMPT = `
Tu es un auditeur de couverture factuelle. Protocole : coverage-judge.v2-unit-ids.

Tu reçois UN segment : son voiceover complet, la liste numérotée de toutes ses
unités dans l'ordre du voiceover (u1 est la première unité du voiceover, u2 la
suivante, etc., avec leur type), les identifiants désignés et les claims
factuels déclarés du segment, chacun avec son claim_id.

Pour CHAQUE identifiant de designated_unit_ids, et seulement pour eux, dis si
l'unité est couverte par les claims. Les autres unités servent uniquement de
contexte. Tu ne vérifies pas la vérité, ne recherches rien, n'utilises aucune
connaissance extérieure et ne réécris jamais le texte. Une reformulation
équivalente est couverte ; une quantité, date, attribution, causalité,
propriété ou conséquence supplémentaire ne l'est pas. Une unité sans
affirmation factuelle vérifiable est couverte.

Pour une unité non couverte, propose exactement une opération fermée :
DELETE (supprimer l'unité), ou DECLARE avec le claim_id reçu dont le texte
remplacera exactement l'unité.

INTERDITS : citer ou recopier du texte, donner une position, inventer un
identifiant, omettre ou répéter un identifiant désigné, ajouter un champ,
produire de la prose ou un texte de réparation.

Recopie protocol_id, voiceover_sha256, lock_sha256 et segment_id à l'identique.
Réponds uniquement avec ce JSON :
{
  "protocol_id": "",
  "voiceover_sha256": "",
  "lock_sha256": "",
  "segment_id": "",
  "results": [
    { "unit_id": "u1", "verdict": "COVERED", "operations": [] },
    { "unit_id": "u2", "verdict": "UNCOVERED", "operations": [{ "action": "DELETE" }] },
    { "unit_id": "u3", "verdict": "UNCOVERED", "operations": [{ "action": "DECLARE", "claim_id": "" }] }
  ]
}
`.trim();

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const SEGMENT_ID = /^s[1-9][0-9]*-g[1-9][0-9]*$/;
const REQUEST_HEADER = "SEGMENT A AUDITER :\n\n";

// Version (section 8, éléments 7 et 8) : empreinte du prompt, du format et
// des bornes.
export const COVERAGE_JUDGE_V2_VERSION =
  `${COVERAGE_JUDGE_V2_RULES_VERSION}+prompt.${sha256(JSON.stringify({
    protocol: COVERAGE_JUDGE_V2_PROTOCOL,
    prompt: SYSTEM_PROMPT,
    bounds: JUDGE_BOUNDS
  }))}`;

export function coverageJudgeV2Version() {
  return COVERAGE_JUDGE_V2_VERSION;
}

function freezeDeep(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

function outcome(context, fields) {
  return freezeDeep({
    version: COVERAGE_JUDGE_V2_VERSION,
    protocol: COVERAGE_JUDGE_V2_PROTOCOL,
    protocol_id: context.protocolId ?? null,
    voiceover_sha256: context.voiceoverSha256 ?? null,
    lock_sha256: context.lockSha256 ?? null,
    segment_id: context.segmentId ?? null,
    designated_unit_ids: context.designated ?? [],
    bounds: context.bounds ?? null,
    status: fields.status,
    failure: fields.failure ?? null,
    request_sha256: fields.requestSha256 ?? null,
    usage: fields.usage ?? null,
    results: fields.results ?? []
  });
}

const failure = (context, category, reason, extra = {}) =>
  outcome(context, { status: JUDGE_STATUS.FAILED, failure: { category, reason }, ...extra });

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Contrôles de l'entrée, avant tout appel. Renvoie une raison ou null.
function inputIssue({ boundary, lock, claims, segmentId, send }) {
  if (typeof send !== "function") return "composant absent : transport";
  if (!SEGMENT_ID.test(segmentId ?? "")) return "segment_id invalide";
  if (!lock || typeof lock !== "object") return "verrou absent";
  const missing = invalidLockElements(lock);
  if (missing.length > 0) return `verrou incomplet : ${missing.join(", ")}`;
  if (lock.judge !== COVERAGE_JUDGE_V2_VERSION) return "version divergente : judge";
  if (lock.baseline !== ARCHITECTURE_BASELINE_VERSION) return "version divergente : baseline";

  if (!boundary || typeof boundary !== "object") return "composant absent : frontière";
  if (boundary.status === "FAILED") return `frontière en échec (${boundary.reason ?? "sans raison"})`;
  if (!HEX64.test(boundary.protocol_id ?? "")) return "protocol_id absent ou invalide";
  if (boundary.version !== COMPOSITE_COVERAGE_BOUNDARY_VERSION || boundary.versions?.composite !== COMPOSITE_COVERAGE_BOUNDARY_VERSION) {
    return "version divergente : composite";
  }

  const versions = boundary.versions ?? {};
  for (const key of ["splitter", "normalization", "protection", "classification", "entities_rule_version", "language"]) {
    if (versions[key] !== lock[key]) return `version divergente : ${key}`;
  }
  if (!Array.isArray(boundary.lock_divergences) || boundary.lock_divergences.length > 0) {
    return `incohérence de verrou dans la frontière : ${(boundary.lock_divergences ?? []).map(item => item.element).join(", ") || "divergences illisibles"}`;
  }
  for (const key of BOUNDARY_LOCK_KEYS) {
    if (boundary.lock?.[key] !== lock[key]) return `incohérence de verrou dans la frontière : ${key}`;
  }
  const fingerprints = boundary.fingerprints ?? {};
  if (fingerprints.entities_fingerprint !== lock.entities_fingerprint) return "empreinte divergente : entities_fingerprint";

  // R28.6A — le protocol_id reçu doit être exactement celui du verrou validé.
  const expectedProtocolId = boundaryProtocolIdFromLock(lock);
  if (boundary.protocol_id !== expectedProtocolId) {
    return `protocol_id divergent : reçu ${boundary.protocol_id}, recalculé depuis le verrou ${expectedProtocolId}`;
  }

  const units = boundary.units;
  if (!Array.isArray(units) || units.length === 0) return "unités absentes";
  const ids = units.map(item => item?.unit?.id);
  if (new Set(ids).size !== ids.length) return "unités : identifiant dupliqué";
  if (!ids.every((id, index) => id === `u${index + 1}` && units[index].unit_id === id)) return "unités inconnues ou désordonnées";

  const voiceover = units.map(item => item.unit.text).join("");
  const voiceoverSha256 = sha256(voiceover);
  if (
    boundary.voiceover_sha256 !== voiceoverSha256 ||
    fingerprints.voiceover_sha256 !== voiceoverSha256 ||
    boundary.splitter?.voiceover_sha256 !== voiceoverSha256
  ) return "empreinte divergente : voiceover_sha256";

  const designated = boundary.analysed_unit_ids;
  if (!Array.isArray(designated)) return "analysed_unit_ids absents";
  if (new Set(designated).size !== designated.length) return "analysed_unit_ids : identifiant dupliqué";
  if (designated.some(id => !ids.includes(id))) return "analysed_unit_ids : unité inconnue";
  const expected = units.filter(item => item.state !== "excluded").map(item => item.unit_id);
  if (designated.some(id => !expected.includes(id))) return "analysed_unit_ids : unité exclue désignée";
  if (!sameJson(designated, expected)) return "analysed_unit_ids incomplets ou désordonnés";

  if (!Array.isArray(claims)) return "claims absents";
  if (!claims.every(claim => claim && typeof claim.text === "string" && claim.text.trim())) return "claims invalides";
  // Le nombre de claims est une borne : son dépassement est OUT_OF_BOUNDS.
  return null;
}

function buildRequest({ boundary, claims, segmentId, lockSha256 }) {
  const units = boundary.units.map(item => item.unit);
  const voiceover = units.map(unit => unit.text).join("");
  const designated = [...boundary.analysed_unit_ids];
  const numberedClaims = claims.map((claim, index) => ({ claim_id: `${segmentId}-c${index + 1}`, text: claim.text.trim() }));
  const payload = {
    protocol: COVERAGE_JUDGE_V2_PROTOCOL,
    protocol_id: boundary.protocol_id,
    voiceover_sha256: boundary.voiceover_sha256,
    lock_sha256: lockSha256,
    segment_id: segmentId,
    voiceover,
    units: units.map(unit => ({ unit_id: unit.id, type: unit.type })),
    designated_unit_ids: designated,
    claims: numberedClaims
  };
  const content = `${REQUEST_HEADER}${JSON.stringify(payload, null, 2)}`;
  return { content, designated, claimIds: new Set(numberedClaims.map(claim => claim.claim_id)) };
}

function estimateBounds({ content, designated, claims }) {
  return {
    estimated_input_chars: SYSTEM_PROMPT.length + content.length,
    estimated_output_tokens: Math.ceil(
      (JUDGE_BOUNDS.output_envelope_chars + designated.length * JUDGE_BOUNDS.output_entry_chars) /
      JUDGE_BOUNDS.output_chars_per_token
    ),
    claim_count: claims.length
  };
}

function boundsIssue(bounds) {
  if (bounds.claim_count > JUDGE_BOUNDS.max_claims) return `claims : ${bounds.claim_count} > ${JUDGE_BOUNDS.max_claims}`;
  if (bounds.estimated_input_chars > JUDGE_BOUNDS.max_input_chars) {
    return `entrée : ${bounds.estimated_input_chars} caractères > ${JUDGE_BOUNDS.max_input_chars}`;
  }
  if (bounds.estimated_output_tokens > JUDGE_BOUNDS.output_token_budget) {
    return `sortie dans le pire cas : ${bounds.estimated_output_tokens} tokens > ${JUDGE_BOUNDS.output_token_budget}`;
  }
  return null;
}

function parseJson(text) {
  if (!text?.trim()) throw new Error("réponse vide");
  const raw = text.trim();
  const fence = raw.match(/```(?:json)?\n?([^]*?)```/);
  return JSON.parse(fence ? fence[1].trim() : raw);
}

const keysExactly = (value, keys) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  sameJson(Object.keys(value).sort(), [...keys].sort());

// Validation déterministe de la réponse. Renvoie { results } ou { reason }.
export function validateJudgeV2Response(data, { protocolId, voiceoverSha256, lockSha256, segmentId, designated, claimIds }) {
  if (!keysExactly(data, ["protocol_id", "voiceover_sha256", "lock_sha256", "segment_id", "results"])) return { reason: "enveloppe hors schéma" };
  if (data.protocol_id !== protocolId) return { reason: "protocol_id différent" };
  if (data.voiceover_sha256 !== voiceoverSha256) return { reason: "voiceover_sha256 différent" };
  if (data.lock_sha256 !== lockSha256) return { reason: "lock_sha256 différent" };
  if (data.segment_id !== segmentId) return { reason: "segment_id différent" };
  if (!Array.isArray(data.results)) return { reason: "results absent" };

  const byId = new Map();
  for (const [index, result] of data.results.entries()) {
    if (!keysExactly(result, ["unit_id", "verdict", "operations"])) return { reason: `résultat ${index + 1} hors schéma` };
    if (typeof result.unit_id !== "string") return { reason: `résultat ${index + 1} sans unit_id` };
    if (!designated.includes(result.unit_id)) return { reason: `unité inconnue ou non désignée : ${result.unit_id}` };
    if (byId.has(result.unit_id)) return { reason: `unité dupliquée : ${result.unit_id}` };
    if (!Array.isArray(result.operations)) return { reason: `${result.unit_id} : operations absent` };

    let operation = null;
    if (result.verdict === JUDGE_VERDICT.COVERED) {
      if (result.operations.length !== 0) return { reason: `${result.unit_id} : COVERED avec opération` };
    } else if (result.verdict === JUDGE_VERDICT.UNCOVERED) {
      if (result.operations.length !== 1) return { reason: `${result.unit_id} : UNCOVERED exige exactement une opération` };
      const op = result.operations[0];
      if (op?.action === "DELETE") {
        // R25.7C : claim_id ignoré pour DELETE.
        if (!keysExactly(op, ["action"]) && !keysExactly(op, ["action", "claim_id"])) return { reason: `${result.unit_id} : opération hors schéma` };
        operation = { action: "DELETE", claim_id: null };
      } else if (op?.action === "DECLARE") {
        if (!keysExactly(op, ["action", "claim_id"])) return { reason: `${result.unit_id} : opération hors schéma` };
        if (!claimIds.has(op.claim_id)) return { reason: `${result.unit_id} : claim_id inconnu` };
        operation = { action: "DECLARE", claim_id: op.claim_id };
      } else {
        return { reason: `${result.unit_id} : action invalide` };
      }
    } else {
      return { reason: `${result.unit_id} : verdict invalide` };
    }
    byId.set(result.unit_id, { unit_id: result.unit_id, verdict: result.verdict, operation });
  }

  const missing = designated.filter(id => !byId.has(id));
  if (missing.length > 0) return { reason: `unité absente : ${missing.join(", ")}` };
  // Résultats rangés dans l'ordre des identifiants désignés.
  return { results: designated.map(id => byId.get(id)) };
}

// Juge un segment. `lock` : verrou complet (COVERAGE_LOCK_KEYS) ; `send` :
// transport obligatoire, fourni par l'exécuteur (createMessage en
// production, transport simulé dans les tests). Sans transport : refus.
export async function judgeSegmentCoverageV2({ boundary, lock, claims, segmentId, send }) {
  const context = { segmentId: SEGMENT_ID.test(segmentId ?? "") ? segmentId : null };

  const issue = inputIssue({ boundary, lock, claims, segmentId, send });
  if (issue) return failure(context, JUDGE_FAILURE.INPUT_REFUSED, issue);

  context.protocolId = boundary.protocol_id;
  context.voiceoverSha256 = boundary.voiceover_sha256;
  context.lockSha256 = lockSha256(lock);

  const request = buildRequest({ boundary, claims, segmentId, lockSha256: context.lockSha256 });
  context.designated = request.designated;
  context.bounds = estimateBounds({ content: request.content, designated: request.designated, claims });

  if (request.designated.length === 0) {
    return outcome(context, { status: JUDGE_STATUS.NO_DESIGNATED_UNITS });
  }

  const outOfBounds = boundsIssue(context.bounds);
  if (outOfBounds) return failure(context, JUDGE_FAILURE.OUT_OF_BOUNDS, `segment hors bornes du juge — ${outOfBounds}`);

  let reply;
  try {
    reply = await send({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: request.content }],
      maxTokens: JUDGE_BOUNDS.max_tokens,
      temperature: 0
    });
  } catch (error) {
    return failure(context, JUDGE_FAILURE.NOT_JUDGED, `appel en échec — ${String(error?.message ?? error)}`);
  }

  const requestSha256 = typeof reply?.request_sha256 === "string" ? reply.request_sha256 : null;
  const usage = reply?.meta ?? null;
  const reject = reason => failure(context, JUDGE_FAILURE.NOT_JUDGED, reason, { requestSha256, usage });

  if (usage?.stop_reason === "max_tokens") return reject("réponse tronquée — stop_reason=max_tokens");

  let data;
  try {
    data = parseJson(extractText(reply?.response));
  } catch (error) {
    return reject(`JSON illisible — ${String(error?.message ?? error)}`);
  }

  const validated = validateJudgeV2Response(data, {
    protocolId: context.protocolId,
    voiceoverSha256: context.voiceoverSha256,
    lockSha256: context.lockSha256,
    segmentId,
    designated: request.designated,
    claimIds: request.claimIds
  });
  if (validated.reason) return reject(validated.reason);

  return outcome(context, { status: JUDGE_STATUS.JUDGED, requestSha256, usage, results: validated.results });
}
