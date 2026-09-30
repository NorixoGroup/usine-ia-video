import fs from "node:fs";
import path from "node:path";

export function writeJsonArtifact(
  productionDir,
  filename,
  data
) {
  if (!productionDir) {
    throw new Error(
      "Artifact Writer : productionDir obligatoire."
    );
  }

  if (!filename) {
    throw new Error(
      "Artifact Writer : filename obligatoire."
    );
  }

  const target = path.join(
    productionDir,
    filename
  );

  fs.writeFileSync(
    target,
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );

  return target;
}

export function readJsonArtifact(
  productionDir,
  filename
) {
  if (!productionDir) {
    throw new Error(
      "Artifact Reader : productionDir obligatoire."
    );
  }

  if (!filename) {
    throw new Error(
      "Artifact Reader : filename obligatoire."
    );
  }

  const target = path.join(
    productionDir,
    filename
  );

  return JSON.parse(
    fs.readFileSync(target, "utf8")
  );
}
