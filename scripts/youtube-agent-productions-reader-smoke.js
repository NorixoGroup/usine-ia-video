// Smoke du lecteur de productions — fixtures temporaires, lecture seule.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-productions-reader-smoke.js

import fs from "node:fs";
import path from "node:path";

import { listProductions, getProduction } from "../src/youtube-agent/productions-reader.js";
import { tmpRoot, cleanup, check, done, makeProduction, PROD_A, PROD_B, PROD_C } from "./youtube-agent-test-helpers.js";

const root = tmpRoot("reader");

check("racine sans projects/ → liste vide", () => {
  const r = listProductions({ root });
  if (r.total !== 0 || r.shown.length !== 0) throw new Error("non vide");
});

makeProduction(root, PROD_A);
makeProduction(root, PROD_B, { status: "failed", mode: "full" });
makeProduction(root, PROD_C, { mode: undefined });
fs.mkdirSync(path.join(root, "projects", "not-a-production"), { recursive: true });
fs.writeFileSync(path.join(root, "projects", "stray.txt"), "x");

check("identifiants invalides ignorés, tri du plus récent au plus ancien", () => {
  const r = listProductions({ root });
  if (r.total !== 3) throw new Error(`total ${r.total}`);
  if (r.shown.map(p => p.id).join() !== [PROD_C, PROD_B, PROD_A].join()) throw new Error("ordre");
});

check("mode absent → test ; statuts et agents exposés", () => {
  const r = listProductions({ root });
  const c = r.shown.find(p => p.id === PROD_C);
  const b = r.shown.find(p => p.id === PROD_B);
  if (c.mode !== "test" || b.mode !== "full" || b.status !== "failed") throw new Error("mode/statut");
  if (b.agents.length !== 7 || b.agents[0].status !== "completed" || b.agents[6].status !== "absent") throw new Error("agents");
});

check("limite respectée", () => {
  const r = listProductions({ root, limit: 1 });
  if (r.shown.length !== 1 || r.total !== 3) throw new Error("limite");
});

check("production.json corrompu → entrée illisible sans exception", () => {
  fs.writeFileSync(path.join(root, "projects", PROD_A, "production.json"), "{not json");
  const a = listProductions({ root }).shown.find(p => p.id === PROD_A);
  if (a.readable !== false) throw new Error("devrait être illisible");
});

check("verrou détecté, lien symbolique non suivi", () => {
  fs.writeFileSync(path.join(root, "projects", PROD_B, ".lock"), "1");
  if (!listProductions({ root }).shown.find(p => p.id === PROD_B).locked) throw new Error("verrou");
  const target = path.join(root, "outside.json");
  fs.writeFileSync(target, JSON.stringify({ status: "x" }));
  fs.rmSync(path.join(root, "projects", PROD_C, "production.json"));
  fs.symlinkSync(target, path.join(root, "projects", PROD_C, "production.json"));
  if (listProductions({ root }).shown.find(p => p.id === PROD_C).readable !== false) throw new Error("symlink suivi");
});

check("getProduction : identifiant invalide → null, jamais de lecture hors projects/", () => {
  if (getProduction({ root, productionId: "../../etc" }) !== null) throw new Error("accepté");
  if (getProduction({ root, productionId: PROD_B })?.id !== PROD_B) throw new Error("introuvable");
});

check("la lecture ne modifie rien", () => {
  const before = fs.readFileSync(path.join(root, "projects", PROD_B, "production.json"), "utf8");
  listProductions({ root });
  if (fs.readFileSync(path.join(root, "projects", PROD_B, "production.json"), "utf8") !== before) throw new Error("modifié");
});

cleanup(root);
done("youtube-agent-productions-reader-smoke");
