// Injecteur de fautes — infrastructure de TEST uniquement.
//
// Usage (par scripts/fixture-pipeline-smoke.js seulement) :
//   PIPELINE_FAULT=<faute> node --import ./scripts/pipeline-fault-injector.js ...
//
// Aucun fichier de production n'importe ce module. Préchargé, il altère
// EN MÉMOIRE ce que l'orchestrateur relit depuis le disque pour un
// artefact précis, à une lecture précise. L'artefact sur le disque n'est
// jamais modifié. Il sert à prouver que chaque agent aval revalide ce
// qu'il relit et bloque la suite du pipeline.
//
// Les fautes média altèrent en plus, au même instant, un FAUX média du
// dossier de fixtures du test (tmp/r9-media-* uniquement), pour prouver
// qu'un média modifié ou supprimé après son inspection est détecté avant
// l'étape aval.
//
// Sans PIPELINE_FAULT connu, le chargement échoue : aucune activation
// implicite.

import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

// file : artefact visé ; read : numéro de la lecture altérée, dans
// l'ordre des relectures de src/orchestrator/mvp.js.
const FAULTS = {
  // visual.json relu pour Asset.
  "asset-source-duplicate-order": {
    file: "visual.json",
    read: 1,
    tamper(envelope) {
      envelope.data.sections[0].segments[0].shots[1].order = 1;
    }
  },

  // script.json relu pour Voice (1re lecture : Visual Director).
  "voice-source-empty-voiceover": {
    file: "script.json",
    read: 2,
    tamper(envelope) {
      envelope.data.sections[0].segments[0].voiceover = "";
    }
  },

  // voice.json relu pour Assembly.
  "assembly-source-duration-drift": {
    file: "voice.json",
    read: 1,
    tamper(envelope) {
      envelope.data.narration_units[0].estimated_seconds += 1;
      envelope.data.summary.total_estimated_seconds += 1;
    }
  },

  // assets.json relu pour Assembly.
  "assembly-source-missing-asset": {
    file: "assets.json",
    read: 1,
    tamper(envelope) {
      const removed = envelope.data.assets.pop();

      envelope.data.summary.total_assets -= 1;
      envelope.data.summary.total_duration_seconds -=
        removed.duration_seconds;
      envelope.data.summary.by_type[removed.asset_type] -= 1;
    }
  },

  // visual.json relu pour Quality (1re lecture : Asset).
  "quality-title-divergence": {
    file: "visual.json",
    read: 2,
    tamper(envelope) {
      envelope.data.title = "Un titre divergent";
    }
  },

  // voice.json relu pour Quality (1re lecture : Assembly).
  "quality-narration-text": {
    file: "voice.json",
    read: 2,
    tamper(envelope) {
      envelope.data.narration_units[0].text += " Phrase ajoutée.";
    }
  },

  // script.json relu pour Quality (3e lecture).
  "quality-persisted-verdict": {
    file: "script.json",
    read: 3,
    tamper(envelope) {
      envelope.claim_coverage_validation.valid = false;
    }
  },

  // assembly.json relu pour Quality.
  "quality-assembly-gap": {
    file: "assembly.json",
    read: 1,
    tamper(envelope) {
      const clip = envelope.data.video_track[1];

      clip.start_seconds += 1;
      clip.end_seconds += 1;
    }
  },

  // --- Fautes média (pipeline lancé avec --media-dir) ---------------
  //
  // alterMedia modifie ou supprime un FAUX média du dossier de fixtures
  // du test, après son inspection et juste avant l'étape aval qui doit
  // le recontrôler. Refusé hors de tmp/r9-media-*.

  // assets.json relu pour Assembly : l'asset a déjà été inspecté.
  "media-asset-modified-before-assembly": {
    file: "assets.json",
    read: 1,
    alterMedia(mediaRoot) {
      fs.appendFileSync(
        path.join(mediaRoot, "assets", "s01-g01-sh01.mp4"),
        "altération après inspection"
      );
    }
  },

  // voice.json relu pour Assembly : l'audio a déjà été inspecté.
  "media-voice-deleted-before-assembly": {
    file: "voice.json",
    read: 1,
    alterMedia(mediaRoot) {
      fs.rmSync(path.join(mediaRoot, "voice", "s01-g01.wav"));
    }
  },

  // assembly.json relu pour Quality : Assembly a déjà validé le média.
  "media-asset-deleted-before-quality": {
    file: "assembly.json",
    read: 1,
    alterMedia(mediaRoot) {
      fs.rmSync(
        path.join(mediaRoot, "assets", "s02-g01-sh02.mp4")
      );
    }
  },

  "media-voice-modified-before-quality": {
    file: "assembly.json",
    read: 1,
    alterMedia(mediaRoot) {
      fs.appendFileSync(
        path.join(mediaRoot, "voice", "s02-g01.mp3"),
        "altération après inspection"
      );
    }
  },

  // assets.json relu pour Assembly : empreinte enregistrée falsifiée.
  "media-manifest-sha-tampered": {
    file: "assets.json",
    read: 1,
    tamper(envelope) {
      envelope.data.assets[0].media.sha256 = "0".repeat(64);
    }
  },

  // assets.json relu pour Assembly : référence sortant du dossier média.
  "media-manifest-path-traversal": {
    file: "assets.json",
    read: 1,
    tamper(envelope) {
      envelope.data.assets[0].media.path =
        "assets/../../outside.mp4";
    }
  }
};

// Dossier média visé par alterMedia : uniquement un dossier de fixtures
// tmp/r9-media-* du dépôt, jamais un dossier de médias réels.
function resolveFixtureMediaRoot() {
  const prefix = "--media-dir=";

  const argument = process.argv.find(
    value => value.startsWith(prefix)
  );

  if (!argument) {
    throw new Error(
      "pipeline-fault-injector — cette faute exige --media-dir."
    );
  }

  const mediaRoot = fs.realpathSync(
    path.resolve(argument.slice(prefix.length))
  );

  const allowed = path.join(
    fs.realpathSync(path.join(process.cwd(), "tmp")),
    "r9-media-"
  );

  if (!mediaRoot.startsWith(allowed)) {
    throw new Error(
      `pipeline-fault-injector — altération refusée hors de tmp/r9-media-* (${mediaRoot}).`
    );
  }

  return mediaRoot;
}

const faultName = process.env.PIPELINE_FAULT;

if (!Object.hasOwn(FAULTS, faultName ?? "")) {
  throw new Error(
    `pipeline-fault-injector — PIPELINE_FAULT="${faultName}" inconnu. ` +
    `Valeurs admises : ${Object.keys(FAULTS).join(", ")}.`
  );
}

const fault = FAULTS[faultName];
const originalReadFileSync = fs.readFileSync;

let reads = 0;
let injections = 0;

function isProductionArtifact(file) {
  return (
    typeof file === "string" &&
    path.basename(file) === fault.file &&
    path.basename(path.dirname(path.dirname(file))) === "projects"
  );
}

fs.readFileSync = function readFileSyncWithFault(file, ...rest) {
  const content = originalReadFileSync.call(fs, file, ...rest);

  if (!isProductionArtifact(file)) {
    return content;
  }

  reads += 1;

  if (reads !== fault.read) {
    return content;
  }

  injections += 1;

  if (fault.alterMedia) {
    fault.alterMedia(resolveFixtureMediaRoot());
  }

  if (!fault.tamper) {
    return content;
  }

  const envelope = JSON.parse(content);

  fault.tamper(envelope);

  return JSON.stringify(envelope, null, 2) + "\n";
};

syncBuiltinESMExports();

process.on("exit", () => {
  fs.writeSync(
    2,
    `[pipeline-fault-injector] faute ${faultName} — injections : ${injections}\n`
  );
});
