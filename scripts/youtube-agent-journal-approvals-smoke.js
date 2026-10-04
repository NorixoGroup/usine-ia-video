// Smoke du journal (ajout seul, sans secret) et des approbations liées à l'action.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-journal-approvals-smoke.js

import fs from "node:fs";

import { actionHash, createApproval, verifyApproval, sha256Hex, MAX_APPROVAL_TTL_MS } from "../src/youtube-agent/approvals.js";
import { appendJournal, readJournal } from "../src/youtube-agent/journal.js";
import { partitionFile } from "../src/youtube-agent/paths.js";
import { tmpRoot, cleanup, check, throwsWith, done } from "./youtube-agent-test-helpers.js";

const root = tmpRoot("journal");
const now = new Date("2026-06-01T10:00:00Z");
const base = { channel_id: "nomade", engine: "comments", action: "comment:approve", subject_id: "ref1", content_sha256: sha256Hex("texte") };

check("empreinte d'action : stable, sensible à chaque champ", () => {
  if (actionHash(base) !== actionHash({ ...base })) throw new Error("instable");
  for (const k of Object.keys(base)) if (actionHash({ ...base, [k]: "autre" }) === actionHash(base)) throw new Error(`insensible à ${k}`);
  throwsWith(() => actionHash({ ...base, subject_id: "" }), "subject_id");
});

check("approbation valable pour l'action exacte seulement", () => {
  const a = createApproval({ action: base, now });
  if (!verifyApproval(a, base, { now }).ok) throw new Error("rejet à tort");
  if (verifyApproval(a, { ...base, content_sha256: sha256Hex("autre texte") }, { now }).reason !== "action_mismatch") throw new Error("autre contenu");
  if (verifyApproval(a, { ...base, engine: "publishing" }, { now }).reason !== "action_mismatch") throw new Error("autre moteur");
});

check("expiration, approbateur, décision, schéma, absence", () => {
  const a = createApproval({ action: base, now, ttl_ms: 60_000 });
  if (verifyApproval(a, base, { now: new Date(now.getTime() + 61_000) }).reason !== "approval_expired") throw new Error("expiration");
  if (verifyApproval({ ...a, approver: "agent" }, base, { now }).reason !== "approver_not_human") throw new Error("approbateur");
  if (verifyApproval({ ...a, decision: "rejected" }, base, { now }).reason !== "not_approved") throw new Error("décision");
  if (verifyApproval({ ...a, schema: "x" }, base, { now }).reason !== "approval_schema") throw new Error("schéma");
  if (verifyApproval(null, base, { now }).reason !== "approval_missing") throw new Error("absence");
  if (verifyApproval({ ...a, action_hash: "0".repeat(64) }, base, { now }).reason !== "action_mismatch") throw new Error("hash forgé");
});

check("durée d'approbation bornée", () => {
  throwsWith(() => createApproval({ action: base, now, ttl_ms: MAX_APPROVAL_TTL_MS + 1 }), "Durée");
  throwsWith(() => createApproval({ action: base, now, ttl_ms: 0 }), "Durée");
});

check("journal : ajout seul, lignes précédentes inchangées", () => {
  appendJournal({ root, channelId: "nomade", now, entry: { type: "note", engine: "agent", outcome: "a" } });
  const file = partitionFile(root, "nomade", "journal", "journal.jsonl");
  const first = fs.readFileSync(file, "utf8");
  appendJournal({ root, channelId: "nomade", now, entry: { type: "note", engine: "agent", outcome: "b" } });
  const second = fs.readFileSync(file, "utf8");
  if (!second.startsWith(first) || readJournal({ root, channelId: "nomade" }).length !== 2) throw new Error("non append-only");
});

check("journal : champs libres, imbriqués et valeurs ressemblant à un secret refusés, rien d'écrit", () => {
  const file = partitionFile(root, "nomade", "journal", "journal.jsonl");
  const before = fs.readFileSync(file, "utf8");
  throwsWith(() => appendJournal({ root, channelId: "nomade", entry: { type: "note", token: "x" } }), "refusé");
  throwsWith(() => appendJournal({ root, channelId: "nomade", entry: { type: "note", detail: { a: 1 } } }), "invalide");
  throwsWith(() => appendJournal({ root, channelId: "nomade", entry: { type: "note", detail: "Bearer abcdefghijklmnop" } }), "secret");
  throwsWith(() => appendJournal({ root, channelId: "nomade", entry: { type: "note", detail: "sk-" + "a".repeat(30) } }), "secret");
  throwsWith(() => appendJournal({ root, channelId: "nomade", entry: { type: "Bad Type" } }), "type");
  throwsWith(() => appendJournal({ root, channelId: "nomade", entry: { type: "note", detail: "x".repeat(501) } }), "invalide");
  if (fs.readFileSync(file, "utf8") !== before) throw new Error("écriture malgré refus");
});

cleanup(root);
done("youtube-agent-journal-approvals-smoke");
