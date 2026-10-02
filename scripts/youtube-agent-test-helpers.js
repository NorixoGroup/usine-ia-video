// Aides communes aux smokes du YouTube Agent. Aucun réseau, aucune API.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

export function tmpRoot(label = "ya") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `youtube-agent-${label}-`));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`  ECHEC : ${name}\n    ${error.message}`);
  }
}

export function throwsWith(fn, fragment) {
  let error = null;

  try {
    fn();
  } catch (e) {
    error = e;
  }

  if (!error) throw new Error(`exception attendue (${fragment})`);

  if (fragment && !String(error.message).includes(fragment)) {
    throw new Error(`message inattendu : « ${error.message} » (attendu : ${fragment})`);
  }
}

export function done(title) {
  const guard = globalThis.__fixtureNetworkGuard?.attempts().length ?? "n/a";

  console.log(`${title} — ${passed} vérifications OK, ${failed} échec(s), tentatives réseau bloquées : ${guard}`);

  if (failed > 0) process.exit(1);
}

export function makeProduction(root, id, overrides = {}) {
  const dir = path.join(root, "projects", id);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "production.json"),
    JSON.stringify({
      id,
      created_at: "2026-01-01T00:00:00.000Z",
      status: "dry_run_pass",
      mode: "test",
      input: { title: "Titre fixture" },
      agents: [{ id: "research", status: "completed" }, { id: "script", status: "completed" }],
      ...overrides
    })
  );

  return dir;
}

export const PROD_A = "prod-2026-01-01T10-00-00-000Z-aaaaaa";
export const PROD_B = "prod-2026-01-02T10-00-00-000Z-bbbbbb";
export const PROD_C = "prod-2026-01-03T10-00-00-000Z-cccccc";
