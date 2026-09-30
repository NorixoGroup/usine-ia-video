import {
  validateVisualDirectorDossier
} from "../src/utils/validate-visual-director.js";

const validFixture = {
  title:
    "Pourquoi 95 % de l'Australie est presque vide ?",

  sections: [
    {
      title:
        "Le désert rouge : un intérieur hostile",

      segments: [
        {
          script_segment_index: 0,
          estimated_seconds: 20,

          shots: [
            {
              order: 1,
              duration_seconds: 8,
              visual_description:
                "Vue aérienne large de l'intérieur aride australien.",
              asset_query:
                "Australian outback aerial arid landscape",
              asset_type: "stock_video",
              requires_exact_location: false,
              research_fact_refs: [0]
            },

            {
              order: 2,
              duration_seconds: 7,
              visual_description:
                "Carte de l'Australie mettant en évidence les zones arides.",
              asset_query:
                "Australia arid regions map",
              asset_type: "map",
              requires_exact_location: false,
              research_fact_refs: [0]
            },

            {
              order: 3,
              duration_seconds: 5,
              visual_description:
                "Plan rapproché d'un paysage sec et rouge.",
              asset_query:
                "Australian red desert dry landscape",
              asset_type: "stock_video",
              requires_exact_location: false,
              research_fact_refs: [0]
            }
          ]
        }
      ]
    }
  ]
};

const invalidFixture =
  structuredClone(validFixture);

invalidFixture.sections[0]
  .segments[0]
  .shots[0]
  .duration_seconds = 0;

invalidFixture.sections[0]
  .segments[0]
  .shots[1]
  .asset_type = "unknown";

console.log(
  "=== FIXTURE VALIDE ==="
);

const valid =
  validateVisualDirectorDossier(
    validFixture
  );

console.log(
  "Valid :",
  valid.valid
);

console.log(
  "Errors :",
  valid.errors
);

console.log("");

console.log(
  "=== FIXTURE INVALIDE ==="
);

const invalid =
  validateVisualDirectorDossier(
    invalidFixture
  );

console.log(
  "Valid :",
  invalid.valid
);

console.log(
  "Errors :",
  invalid.errors
);

const pass =
  valid.valid === true &&
  valid.errors.length === 0 &&
  invalid.valid === false &&
  invalid.errors.length >= 2;

console.log("");
console.log(
  pass
    ? "RESULTAT GLOBAL : PASS — contrat Visual Director protégé"
    : "RESULTAT GLOBAL : FAIL — validator Visual Director"
);

process.exit(pass ? 0 : 1);
