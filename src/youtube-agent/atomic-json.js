// Écritures locales atomiques : fichier temporaire + fsync + rename, verrou exclusif.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readJson(file, fallback = null) {
  let raw;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }

  return JSON.parse(raw);
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);

  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmp, file);
}

// Verrou exclusif (wx) autour d'une section critique synchrone.
export function withFileLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const lock = `${file}.lock`;
  const started = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // verrou libéré entre-temps
      }

      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`Verrou indisponible : ${path.basename(file)}`);
      }

      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// Suppression d'un fichier sous verrou ; retourne false s'il n'existait pas.
export function removeFile(file) {
  return withFileLock(file, () => {
    try {
      fs.unlinkSync(file);

      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;

      throw error;
    }
  });
}

// Bail exclusif longue durée (inter-processus) pour une opération asynchrone,
// par exemple une synchronisation : contrairement à withFileLock, il n'attend
// pas. Retourne une fonction de libération, ou null si le bail est déjà pris.
// Un bail plus ancien que staleMs (processus interrompu) est repris.
export function acquireLease(file, staleMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);

      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      try {
        if (Date.now() - fs.statSync(file).mtimeMs <= staleMs) return null;
        fs.rmSync(file, { force: true });
      } catch {
        // bail libéré entre-temps : nouvelle tentative
      }
    }
  }

  return null;
}

// Ajout seul d'une ligne JSON (journal, mémoire historique).
export function appendJsonl(file, record) {
  const line = `${JSON.stringify(record)}\n`;

  return withFileLock(file, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const fd = fs.openSync(file, "a", 0o600);

    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
}

export function readJsonl(file, { maxLines = 1000 } = {}) {
  let raw;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const lines = raw.split("\n").filter(Boolean);

  return lines.slice(-maxLines).map(line => JSON.parse(line));
}
