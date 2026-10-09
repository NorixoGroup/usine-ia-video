import {
  runVisualDirector
} from "../src/agents/visual-director.js";

// Sous NO_API=1 aucun appel réel n'est possible : le diagnostic s'exécute sur
// les fixtures locales (R5). Sans NO_API, il garde son usage historique et
// appelle l'API réelle.
if (process.env.NO_API === "1") {
  process.env.ANTHROPIC_FIXTURES ??= "1";
}

const script = {
  title:
    "Pourquoi 95 % de l'Australie est presque vide ?",

  hook:
    "Un continent immense, mais une population très concentrée.",

  thesis:
    "Le contraste entre l'immensité du territoire et la concentration de la population.",

  estimated_duration_minutes: 27,

  sections: [
    {
      title:
        "L'intérieur aride",

      purpose:
        "Présenter les caractéristiques climatiques du territoire.",

      segments: [
        {
          voiceover:
            "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.",

          estimated_seconds: 20,

          research_fact_refs: [0],

          contains_unverified_claim:
            false,

          claims: [
            {
              text:
                "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.",

              research_fact_ref: 0,

              is_unverified: false
            }
          ]
        }
      ]
    }
  ],

  conclusion:
    "L'immensité du territoire contraste avec la concentration de sa population."
};

try {
  const result =
    await runVisualDirector({
      script,
      testMode: true
    });

  console.log("");
  console.log(
    "Visual Gate :",
    result.validation?.valid
      ? "PASS"
      : "FAIL"
  );

  console.log(
    "Script Mapping Gate :",
    result
      .script_mapping_validation
      ?.valid
      ? "PASS"
      : "FAIL"
  );

  console.log("");

  const segment =
    result.data
      .sections[0]
      .segments[0];

  console.log(
    "Shots :",
    segment.shots.length
  );

  console.log(
    "Durée segment :",
    segment.estimated_seconds
  );

  const total =
    segment.shots.reduce(
      (sum, shot) =>
        sum +
        shot.duration_seconds,
      0
    );

  console.log(
    "Durée shots :",
    total
  );

  console.log("");

  for (
    const shot of
    segment.shots
  ) {
    console.log(
      `SHOT ${shot.order} — ${shot.duration_seconds}s`
    );

    console.log(
      "Type :",
      shot.asset_type
    );

    console.log(
      "Description :",
      shot.visual_description
    );

    console.log(
      "Query :",
      shot.asset_query
    );

    console.log(
      "Refs :",
      JSON.stringify(
        shot.research_fact_refs
      )
    );

    console.log("");
  }

  console.log(
    "Modèle :",
    result.usage?.model
  );

  console.log(
    "Tokens entrée :",
    result.usage?.input_tokens
  );

  console.log(
    "Tokens sortie :",
    result.usage?.output_tokens
  );

  console.log(
    "Durée API :",
    result.usage?.duration_ms,
    "ms"
  );

  const pass =
    result.validation?.valid ===
      true &&
    result
      .script_mapping_validation
      ?.valid === true &&
    segment.shots.length >= 1 &&
    total ===
      segment.estimated_seconds;

  console.log("");

  console.log(
    pass
      ? "RESULTAT GLOBAL : PASS — Visual Director isolé opérationnel"
      : "RESULTAT GLOBAL : FAIL — NE PAS BRANCHER"
  );

  process.exit(
    pass ? 0 : 1
  );
} catch (error) {
  console.error("");
  console.error(
    "RESULTAT GLOBAL : FAIL — Visual Director bloqué"
  );

  console.error(
    error.message
  );

  console.error("");
  console.error(
    "DECISION : NE PAS BRANCHER — diagnostic nécessaire"
  );

  process.exit(1);
}
