// Fake provider strictement local, réservé aux smokes et à l'opt-in fixture.
// Il produit des bytes WAV probeables sans réseau ni secret.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function createFixtureNarrationProvider() {
  return {
    kind: "fixture:narration",
    async generate({ unitId, estimatedSeconds }) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "narration-provider-fixture-")
      );
      const file = path.join(directory, `${unitId}.wav`);

      try {
        execFileSync(
          "ffmpeg",
          [
            "-nostdin", "-v", "error", "-y", "-fflags", "+bitexact",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
            "-t", String(Math.max(0.1, Math.min(estimatedSeconds, 1))),
            "-c:a", "pcm_s16le", "-map_metadata", "-1", file
          ],
          { stdio: ["ignore", "ignore", "pipe"] }
        );

        return { bytes: fs.readFileSync(file), extension: ".wav" };
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  };
}

export function createFixtureNarrationCallGuard({ cap = Infinity } = {}) {
  let used = 0;

  return {
    preflight({ calls }) {
      if (!Number.isSafeInteger(calls) || calls < 0 || used + calls > cap) {
        throw new Error("Fixture Narration Guard : budget insuffisant.");
      }
    },
    begin(request) {
      used += 1;
      return request;
    },
    succeed() {},
    fail() {},
    status() {
      return { used, cap };
    }
  };
}
