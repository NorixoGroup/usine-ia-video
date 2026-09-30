// Smoke de la durée réelle finale : ffprobe est la vérité, zéro réseau.
import { networkGuard } from "./fixture-network-guard.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectMediaFile } from "../src/media/probe.js";
import {
  validateActualRenderedDuration
} from "../src/utils/validate-quality-report.js";

if (process.env.NO_API !== "1") throw new Error("NO_API=1 obligatoire.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "r15-duration-"));
const target = { min: 0.03, max: 0.04 }; // 1.8–2.4 s : smoke rapide.
let passed = 0; let failed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) { try { await fn(); passed++; console.log(`PASS — ${name}`); } catch (error) { failed++; console.error(`FAIL — ${name}\n       ${error.message}`); } }
function make(name, seconds) {
  const file = path.join(root, name);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=30", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
}
async function duration(file) {
  try { return (await inspectMediaFile(file)).duration_seconds; } catch { return null; }
}
function valid(actual, declared = actual) {
  return validateActualRenderedDuration({ actualDurationSeconds: actual, declaredDurationSeconds: declared, targetDurationMinutes: target });
}
try {
  const conforming = await duration(make("conforme.mp4", 2));
  const short = await duration(make("court.mp4", 1));
  const long = await duration(make("long.mp4", 3));
  await test("A. MP4 mesuré conforme → PASS", () => assert(valid(conforming).length === 0, JSON.stringify(valid(conforming))));
  await test("B. durée réelle trop courte → FAIL", () => assert(valid(short).some(e => /hors de la cible/.test(e)), JSON.stringify(valid(short))));
  await test("C. durée réelle trop longue → FAIL", () => assert(valid(long).some(e => /hors de la cible/.test(e)), JSON.stringify(valid(long))));
  await test("D. JSON déclaré correct mais MP4 incorrect → FAIL", () => assert(valid(short, conforming).some(e => /durée déclarée/.test(e)), JSON.stringify(valid(short, conforming))));
  await test("E. MP4 absent → FAIL", async () => assert(valid(await duration(path.join(root, "absent.mp4"))).some(e => /non mesurable/.test(e)), "absence acceptée"));
  fs.writeFileSync(path.join(root, "illisible.mp4"), "pas un mp4");
  await test("F. MP4 non probeable → FAIL", async () => assert(valid(await duration(path.join(root, "illisible.mp4"))).some(e => /non mesurable/.test(e)), "illisible accepté"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
assert(networkGuard.attempts().length === 0, `NETWORK ATTEMPTS = ${networkGuard.attempts().length}`);
console.log(`NETWORK ATTEMPTS = 0\nTests : ${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
