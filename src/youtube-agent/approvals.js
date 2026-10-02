// Approbations humaines liées à l'empreinte exacte d'une action.
// Une approbation ne vaut que pour (chaîne, moteur, action, sujet, contenu) :
// elle ne peut pas être réutilisée pour une autre action ni après expiration.
// Le contrat enregistre l'approbateur déclaré ; l'authentification du
// humain relève de l'interface qui produit l'approbation.

import crypto from "node:crypto";

export const APPROVAL_SCHEMA = "youtube-agent.approval.v1";
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

export function actionHash({ channel_id, engine, action, subject_id, content_sha256 = null }) {
  for (const [name, value] of Object.entries({ channel_id, engine, action, subject_id })) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Action invalide : ${name}`);
  }

  return sha256Hex(canonical({ channel_id, engine, action, subject_id, content_sha256 }));
}

export function createApproval({ action, approver = "human", decision = "approved", now = new Date(), ttl_ms = DEFAULT_APPROVAL_TTL_MS }) {
  if (!Number.isInteger(ttl_ms) || ttl_ms <= 0 || ttl_ms > MAX_APPROVAL_TTL_MS) throw new Error("Durée d'approbation invalide");

  return {
    schema: APPROVAL_SCHEMA,
    action_hash: actionHash(action),
    approver,
    decision,
    approved_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl_ms).toISOString()
  };
}

// Retourne { ok: true } ou { ok: false, reason }.
export function verifyApproval(approval, action, { now = new Date() } = {}) {
  if (!approval || typeof approval !== "object") return { ok: false, reason: "approval_missing" };
  if (approval.schema !== APPROVAL_SCHEMA) return { ok: false, reason: "approval_schema" };
  if (approval.approver !== "human") return { ok: false, reason: "approver_not_human" };
  if (approval.decision !== "approved") return { ok: false, reason: "not_approved" };

  let expected;

  try {
    expected = actionHash(action);
  } catch {
    return { ok: false, reason: "action_invalid" };
  }

  if (approval.action_hash !== expected) return { ok: false, reason: "action_mismatch" };

  const expires = Date.parse(approval.expires_at);

  if (!Number.isFinite(expires) || expires <= now.getTime()) return { ok: false, reason: "approval_expired" };

  return { ok: true };
}
