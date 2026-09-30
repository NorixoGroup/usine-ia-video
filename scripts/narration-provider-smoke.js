// Smoke R16-A — frontière narration locale, fake provider, zéro réseau.
// Usage: NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/narration-provider-smoke.js

import fs from "node:fs";
import path from "node:path";

import { networkGuard } from "./fixture-network-guard.js";
import {
  createMediaFixtureRoot,
  generateAudio,
  removeMediaFixtureRoot
} from "./local-media-fixtures.js";
import { buildScript } from "./canonical-artifacts.js";
import { buildNarrationPlan, runVoiceAgent } from "../src/agents/voice.js";
import { ensureNarrationAudio } from "../src/services/narration-provider.js";

if (process.env.NO_API !== "1" || !networkGuard) {
  throw new Error("Smoke narration provider : NO_API=1 et Network Guard obligatoires.");
}

const root = createMediaFixtureRoot();
const plan = buildNarrationPlan(buildScript());
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`       ${error.message}`);
  }
}

async function expectReject(fn, expression) {
  let error;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, "échec attendu");
  assert(expression.test(error.message), `erreur inattendue : ${error.message}`);
}

function media(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function validBytes(name) {
  const file = path.join(root, `${name}.wav`);
  generateAudio(file, { seconds: 0.25 });
  return fs.readFileSync(file);
}

function writeValid(mediaDir, unitId, extension = ".wav") {
  generateAudio(path.join(mediaDir, "voice", `${unitId}${extension}`), {
    seconds: 0.25
  });
}

function guard(cap = Infinity) {
  const records = [];
  return {
    records,
    preflight({ calls }) {
      if (!Number.isSafeInteger(calls) || calls < 0 || calls > cap) {
        throw new Error("budget insuffisant");
      }
    },
    begin(request) { records.push({ status: "started", request }); return records.at(-1); },
    succeed(record, artifact) { record.status = "succeeded"; record.artifact = artifact; },
    fail(record, error) { record.status = "failed"; record.error = error.message; }
  };
}

function provider({ bytes = validBytes("provider-source"), extension = ".wav", fail = false } = {}) {
  const calls = [];
  return {
    kind: "fixture:narration",
    calls,
    async generate(request) {
      calls.push(request);
      if (fail) throw new Error("fixture provider failure");
      return { bytes, extension, path: "../../outside.wav" };
    }
  };
}

await test("CASE 1 — audio local valide : 0 provider call", async () => {
  const directory = media("reuse");
  for (const unit of plan) writeValid(directory, unit.unitId);
  const fake = provider();
  const calls = guard();
  const audio = await ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: calls });
  assert(fake.calls.length === 0, `calls=${fake.calls.length}`);
  assert(Object.keys(audio).length === plan.length, "audio complet attendu");
});

await test("CASE 2/3 — absent : génération canonique, puis reuse sans second call", async () => {
  const directory = media("absent-then-reuse");
  const fake = provider();
  const first = guard();
  const audio = await ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: first });
  assert(fake.calls.length === plan.length, `calls initiaux=${fake.calls.length}`);
  assert(Object.keys(audio).length === plan.length, "audio complet attendu");
  for (const unit of plan) assert(fs.existsSync(path.join(directory, "voice", `${unit.unitId}.wav`)), "nom canonique absent");
  const second = guard();
  await ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: second });
  assert(fake.calls.length === plan.length, "second run a régénéré");
  const voice = await runVoiceAgent({ script: buildScript(), testMode: true, localAudio: audio });
  assert(voice.validation.valid, "manifest Voice invalide");
});

await test("CASE 4 — ensemble partiel : seules les units manquantes sont générées", async () => {
  const directory = media("partial");
  writeValid(directory, plan[0].unitId);
  const fake = provider();
  await ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: guard() });
  assert(fake.calls.length === 1 && fake.calls[0].unitId === plan[1].unitId, "mauvaise sélection missing");
});

await test("CASE 5 — budget insuffisant : 0 provider call", async () => {
  const fake = provider();
  await expectReject(
    () => ensureNarrationAudio({ mediaDir: media("budget"), units: plan, provider: fake, callGuard: guard(1) }),
    /budget insuffisant/
  );
  assert(fake.calls.length === 0, "provider appelé malgré preflight refusé");
});

await test("CASE 6 — provider failure : fail closed, aucun fichier final", async () => {
  const directory = media("provider-failure");
  const fake = provider({ fail: true });
  await expectReject(
    () => ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: guard() }),
    /fixture provider failure/
  );
  assert(fs.readdirSync(path.join(directory, "voice")).length === 0, "fichier final inattendu");
});

await test("CASE 7 — audio malformed : temporaire nettoyé, fail closed", async () => {
  const directory = media("malformed");
  await expectReject(
    () => ensureNarrationAudio({ mediaDir: directory, units: plan, provider: provider({ bytes: Buffer.from("not-a-wav") }), callGuard: guard() }),
    /Local Media/
  );
  assert(fs.readdirSync(path.join(directory, "voice")).length === 0, "temporaire ou final résiduel");
});

await test("CASE 8 — duplicate local : fail closed avant provider", async () => {
  const directory = media("duplicate");
  writeValid(directory, plan[0].unitId, ".wav");
  writeValid(directory, plan[0].unitId, ".mp3");
  const fake = provider();
  await expectReject(
    () => ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: guard() }),
    /plusieurs fichiers/
  );
  assert(fake.calls.length === 0, "provider appelé malgré duplicate");
});

await test("CASE 9/10 — provider path ignoré, NO_API et réseau inchangés", async () => {
  const directory = media("path-safety");
  const fake = provider();
  await ensureNarrationAudio({ mediaDir: directory, units: plan, provider: fake, callGuard: guard() });
  assert(!fs.existsSync(path.join(root, "outside.wav")), "provider a imposé un chemin hors contrat");
  assert(networkGuard.attempts().length === 0, JSON.stringify(networkGuard.attempts()));
});

removeMediaFixtureRoot(root);
console.log(`RESULT — PASS=${passed} FAIL=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
