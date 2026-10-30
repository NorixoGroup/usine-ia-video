import fs from "node:fs";
import { execSync } from "node:child_process";

console.log("========================================");
console.log(" USINE IA VIDEO — ENVIRONMENT CHECK");
console.log("========================================");
console.log("");

let errors = 0;

function ok(label, value = "") {
  console.log(`✓ ${label}${value ? ` — ${value}` : ""}`);
}

function fail(label, value = "") {
  console.log(`✗ ${label}${value ? ` — ${value}` : ""}`);
  errors++;
}

function commandVersion(command) {
  try {
    return execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const nodeVersion = process.version;
ok("Node.js", nodeVersion);

const ffmpegVersion = commandVersion("ffmpeg -version | head -1");
ffmpegVersion ? ok("FFmpeg", ffmpegVersion) : fail("FFmpeg", "introuvable");

const gitVersion = commandVersion("git --version");
gitVersion ? ok("Git", gitVersion) : fail("Git", "introuvable");

console.log("");
console.log("--- Structure ---");

const requiredDirs = [
  "config",
  "projects",
  "scripts",
  "src",
  "src/agents",
  "src/orchestrator",
  "src/services",
  "src/utils",
  "tmp",
  "output",
];

for (const dir of requiredDirs) {
  fs.existsSync(dir) ? ok(dir) : fail(dir, "dossier manquant");
}

console.log("");
console.log("--- Configuration locale ---");

// En conteneur (Docker), la configuration est injectée via les variables
// d'environnement du processus : il n'y a alors aucun .env.local, ce qui est
// normal et ne doit pas être signalé comme une erreur. En développement
// local, .env.local reste lu exactement comme avant (aucune régression).
const hasEnvLocal = fs.existsSync(".env.local");

if (hasEnvLocal) {
  ok(".env.local", "présent");
} else {
  ok(".env.local", "absent — variables lues depuis l'environnement (normal en conteneur)");
}

function readEnvFile(path) {
  if (!fs.existsSync(path)) return {};

  const env = {};

  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();

    env[key] = value;
  }

  return env;
}

// process.env en base, .env.local en complément/surcharge quand présent :
// mêmes valeurs qu'avant en local (où .env.local porte déjà tout), et
// fonctionnel en conteneur (où seules les variables d'environnement existent).
const env = { ...process.env, ...readEnvFile(".env.local") };

env.ANTHROPIC_API_KEY?.length >= 50
  ? ok("ANTHROPIC_API_KEY", "configurée")
  : fail("ANTHROPIC_API_KEY", "absente ou invalide");

env.ELEVENLABS_API_KEY?.length >= 40
  ? ok("ELEVENLABS_API_KEY", "configurée")
  : fail("ELEVENLABS_API_KEY", "absente ou invalide");

env.PEXELS_API_KEY
  ? ok("PEXELS_API_KEY", "configurée")
  : ok("PEXELS_API_KEY", "non configurée — accepté");

env.GOOGLE_API_KEY
  ? ok("GOOGLE_API_KEY", "configurée")
  : ok("GOOGLE_API_KEY", "non configurée — accepté");

console.log("");
console.log("========================================");

if (errors === 0) {
  console.log(" RESULTAT : PASS");
  console.log(" Environnement prêt.");
  console.log("========================================");
  process.exit(0);
}

console.log(` RESULTAT : FAIL — ${errors} erreur(s)`);
console.log("========================================");
process.exit(1);
