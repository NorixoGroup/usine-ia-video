import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  writeJsonArtifact,
  readJsonArtifact
} from "../src/orchestrator/artifacts.js";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "usine-ia-video-artifacts-")
);

const fixture = {
  agent: "research",
  mode: "test",
  data: {
    topic: "fixture",
    key_facts: []
  },
  validation: {
    valid: true,
    errors: [],
    warnings: []
  }
};

try {
  const target = writeJsonArtifact(
    tempDir,
    "research.json",
    fixture
  );

  if (!fs.existsSync(target)) {
    throw new Error(
      "research.json non créé."
    );
  }

  const loaded = readJsonArtifact(
    tempDir,
    "research.json"
  );

  if (
    loaded.agent !== "research" ||
    loaded.data?.topic !== "fixture"
  ) {
    throw new Error(
      "Artefact relu différent de l'artefact écrit."
    );
  }

  console.log(
    "PASS — écriture/lecture artefact JSON"
  );

  console.log(
    "PASS — enveloppe Research conservée"
  );

  console.log(
    "PASS — dossier transmissible via loaded.data"
  );

  console.log(
    "RESULTAT GLOBAL : PASS — contrat artefacts opérationnel"
  );
} finally {
  fs.rmSync(
    tempDir,
    {
      recursive: true,
      force: true
    }
  );
}
