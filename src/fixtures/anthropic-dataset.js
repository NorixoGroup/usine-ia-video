import { isDeepStrictEqual } from "node:util";

// Jeu de données canonique du Fixture Engine.
//
// Table FERMÉE : toute entrée absente de ce fichier est rejetée.
// Le scénario ne modifie que ce qu'émettent les générateurs
// (research, script, visual-director). Les juges et les repairs sont
// des fonctions pures de leur entrée.

export const SCENARIOS = [
  "happy",
  "script-coverage-repair",
  "script-coverage-unrepairable",
  "visual-grounding-repair",
  "visual-grounding-unrepairable",
  "malformed-json"
];

export const CANONICAL_TITLE =
  "Pourquoi 95 % de l'Australie est presque vide ?";

export const CANONICAL_PROMPT =
  "Documentaire géographique factuel destiné à la chaîne Les Découvertes du Nomade.";

const CLAIM_ARID =
  "Une grande partie du territoire australien est constituée de régions arides ou semi-arides.";

const CLAIM_POPULATION =
  "La population australienne est fortement concentrée dans les grandes zones urbaines et côtières.";

// ------------------------------------------------------------------
// Research — mode test : aucun fait vérifié, aucune source, aucune URL.
// ------------------------------------------------------------------

const RESEARCH = {
  topic: CANONICAL_TITLE,
  central_question:
    "Comment le territoire australien et la répartition de sa population s'articulent-ils ?",
  executive_summary:
    "Dossier minimal de test technique. Aucune recherche web n'a été effectuée : les deux faits retenus restent à vérifier.",
  key_facts: [
    {
      claim: CLAIM_ARID,
      importance: "high",
      verification_status: "needs_verification",
      sources: []
    },
    {
      claim: CLAIM_POPULATION,
      importance: "high",
      verification_status: "needs_verification",
      sources: []
    }
  ],
  story_angles: [
    {
      angle: "Un territoire immense face à une population concentrée",
      why_it_matters:
        "Ce contraste est la question centrale du documentaire."
    }
  ],
  sections: [
    {
      title: "L'intérieur aride",
      purpose: "Présenter les caractéristiques climatiques du territoire.",
      facts_needed: [
        "Part du territoire classée aride ou semi-aride"
      ]
    },
    {
      title: "Une population concentrée",
      purpose: "Présenter la répartition de la population.",
      facts_needed: [
        "Répartition de la population entre zones urbaines, côtières et intérieures"
      ]
    }
  ],
  visual_opportunities: [
    {
      subject: "Répartition de la population australienne",
      suggested_visual: "Carte de l'Australie"
    }
  ],
  claims_requiring_sources: [
    CLAIM_ARID,
    CLAIM_POPULATION
  ],
  uncertainties: [
    "Aucun des faits du dossier n'a été vérifié auprès d'une source."
  ],
  research_gaps: [
    "Sources primaires à identifier pour chaque fait."
  ]
};

// JSON volontairement tronqué : simule une réponse modèle cassée.
const MALFORMED_RESEARCH_TEXT =
  '{\n  "topic": "' + CANONICAL_TITLE + '",\n  "key_facts": [';

// ------------------------------------------------------------------
// Script
// ------------------------------------------------------------------

const VOICEOVER_ARID =
  "D'après les éléments disponibles, qui restent à vérifier, une grande partie du territoire australien serait constituée de régions arides ou semi-arides.";

const VOICEOVER_POPULATION =
  "Selon ces mêmes éléments, encore à confirmer, la population australienne serait fortement concentrée dans les grandes zones urbaines et côtières.";

const UNDECLARED_WATER = {
  text: "L'eau y est rare.",
  reason:
    "Caractéristique environnementale supplémentaire absente des claims déclarés."
};

const UNDECLARED_CAUSALITY = {
  text:
    "Ces conditions expliquent pourquoi ces régions restent peu peuplées.",
  reason:
    "Relation causale supplémentaire absente des claims déclarés."
};

const UNDECLARED_RAINFALL = {
  text:
    "Les précipitations y sont inférieures à 250 millimètres par an.",
  reason:
    "Quantité supplémentaire absente des claims déclarés."
};

const UNDECLARED_RAINFALL_RESIDUAL = {
  text: "Les précipitations y sont très faibles.",
  reason:
    "Caractéristique climatique supplémentaire absente des claims déclarés."
};

const SCRIPT_VOICEOVER_ARID_BY_SCENARIO = {
  "script-coverage-repair":
    `${VOICEOVER_ARID} ${UNDECLARED_WATER.text}`,
  "script-coverage-unrepairable":
    `${VOICEOVER_ARID} ${UNDECLARED_RAINFALL.text}`
};

function buildScript(voiceoverArid) {
  return {
    title: CANONICAL_TITLE,
    hook:
      "Un territoire immense, et une population qui semble se tenir ailleurs.",
    thesis:
      "Le documentaire met en regard le territoire australien et la répartition de sa population.",
    estimated_duration_minutes: 27,
    sections: [
      {
        title: "L'intérieur aride",
        purpose:
          "Présenter les caractéristiques climatiques du territoire.",
        segments: [
          {
            voiceover: voiceoverArid,
            estimated_seconds: 20,
            research_fact_refs: [0],
            contains_unverified_claim: true,
            claims: [
              {
                text: CLAIM_ARID,
                research_fact_ref: 0,
                is_unverified: true
              }
            ]
          }
        ]
      },
      {
        title: "Une population concentrée",
        purpose: "Présenter la répartition de la population.",
        segments: [
          {
            voiceover: VOICEOVER_POPULATION,
            estimated_seconds: 20,
            research_fact_refs: [1],
            contains_unverified_claim: true,
            claims: [
              {
                text: CLAIM_POPULATION,
                research_fact_ref: 1,
                is_unverified: true
              }
            ]
          }
        ]
      }
    ],
    conclusion:
      "Ces deux éléments, qui restent à vérifier, structurent la suite de l'enquête."
  };
}

// Script tel qu'il est persisté dans script.json une fois les gates passés.
const PIPELINE_SCRIPT = buildScript(VOICEOVER_ARID);

// Script utilisé par scripts/visual-director-agent-smoke.js.
const SMOKE_VISUAL_DIRECTOR_SCRIPT = {
  title: CANONICAL_TITLE,
  hook:
    "Un continent immense, mais une population très concentrée.",
  thesis:
    "Le contraste entre l'immensité du territoire et la concentration de la population.",
  estimated_duration_minutes: 27,
  sections: [
    {
      title: "L'intérieur aride",
      purpose:
        "Présenter les caractéristiques climatiques du territoire.",
      segments: [
        {
          voiceover: CLAIM_ARID,
          estimated_seconds: 20,
          research_fact_refs: [0],
          contains_unverified_claim: false,
          claims: [
            {
              text: CLAIM_ARID,
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

// ------------------------------------------------------------------
// Voiceover Claim Coverage — juge + repair
// ------------------------------------------------------------------

const COVERAGE_TABLE = [
  {
    voiceover: VOICEOVER_ARID,
    claims: [CLAIM_ARID],
    undeclared: []
  },
  {
    voiceover: VOICEOVER_POPULATION,
    claims: [CLAIM_POPULATION],
    undeclared: []
  },
  {
    voiceover: `${VOICEOVER_ARID} ${UNDECLARED_WATER.text}`,
    claims: [CLAIM_ARID],
    undeclared: [UNDECLARED_WATER],
    repaired: VOICEOVER_ARID
  },
  {
    voiceover: `${VOICEOVER_ARID} ${UNDECLARED_RAINFALL.text}`,
    claims: [CLAIM_ARID],
    undeclared: [UNDECLARED_RAINFALL],
    // Réparation volontairement insuffisante.
    repaired:
      `${VOICEOVER_ARID} ${UNDECLARED_RAINFALL_RESIDUAL.text}`
  },
  {
    voiceover:
      `${VOICEOVER_ARID} ${UNDECLARED_RAINFALL_RESIDUAL.text}`,
    claims: [CLAIM_ARID],
    undeclared: [UNDECLARED_RAINFALL_RESIDUAL]
  },

  // Entrées de scripts/script-claim-coverage-smoke.js.
  {
    voiceover: CLAIM_ARID,
    claims: [CLAIM_ARID],
    undeclared: []
  },
  {
    voiceover: CLAIM_POPULATION,
    claims: [CLAIM_POPULATION],
    undeclared: []
  },
  {
    voiceover: `${CLAIM_ARID} ${UNDECLARED_WATER.text}`,
    claims: [CLAIM_ARID],
    undeclared: [UNDECLARED_WATER],
    repaired: CLAIM_ARID
  },
  {
    voiceover: `${CLAIM_ARID} ${UNDECLARED_CAUSALITY.text}`,
    claims: [CLAIM_ARID],
    undeclared: [UNDECLARED_CAUSALITY],
    repaired: CLAIM_ARID
  }
];

// ------------------------------------------------------------------
// Visual Director
// ------------------------------------------------------------------

const SHOT_ARID_CLEAN = {
  visual_description:
    "Vue aérienne d'une région aride australienne.",
  asset_query: "Australian arid region aerial"
};

// Shot contaminé et rejets observés lors du smoke réel R4D.
const SHOT_ARID_OUTBACK = {
  visual_description:
    "Vue aérienne du désert australien avec des tons rouges et ocres caractéristiques de l'Outback.",
  asset_query: "Australian Outback red ochre desert aerial"
};

const SHOT_ARID_VEGETATION = {
  visual_description:
    "Paysage semi-aride australien avec végétation clairsemée sous un ciel dégagé.",
  asset_query:
    "Australian semi-arid landscape sparse vegetation clear sky"
};

const SHOT_ARID_VEGETATION_RESIDUAL = {
  visual_description:
    "Paysage semi-aride australien avec végétation clairsemée.",
  asset_query: "Australian semi-arid landscape sparse vegetation"
};

const SHOT_ARID_MAP = {
  visual_description:
    "Carte de l'Australie mettant en évidence les régions arides et semi-arides.",
  asset_query: "Australia arid semi-arid regions map"
};

const SHOT_ATMOSPHERIC = {
  visual_description:
    "Plan atmosphérique abstrait de transition, sans lieu identifiable.",
  asset_query: "abstract atmospheric transition background"
};

const SHOT_POPULATION_MAP = {
  visual_description:
    "Carte de l'Australie montrant la concentration de la population dans les grandes zones urbaines et côtières.",
  asset_query: "Australia population concentration urban coastal map"
};

const SHOT_POPULATION_URBAN = {
  visual_description:
    "Vue générique d'une grande zone urbaine côtière australienne.",
  asset_query: "Australian coastal urban area"
};

const VISUAL_ARID_SHOT_BY_SCENARIO = {
  "visual-grounding-repair": SHOT_ARID_OUTBACK,
  "visual-grounding-unrepairable": SHOT_ARID_VEGETATION
};

function buildShot(order, durationSeconds, texts, assetType, refs) {
  return {
    order,
    duration_seconds: durationSeconds,
    visual_description: texts.visual_description,
    asset_query: texts.asset_query,
    asset_type: assetType,
    requires_exact_location: false,
    research_fact_refs: refs
  };
}

function buildAridSegment(scenario) {
  const firstShot =
    VISUAL_ARID_SHOT_BY_SCENARIO[scenario] ?? SHOT_ARID_CLEAN;

  return {
    script_segment_index: 0,
    estimated_seconds: 20,
    shots: [
      buildShot(1, 8, firstShot, "stock_video", [0]),
      buildShot(2, 7, SHOT_ARID_MAP, "map", [0]),
      buildShot(3, 5, SHOT_ATMOSPHERIC, "generated", [])
    ]
  };
}

function buildPopulationSegment() {
  return {
    script_segment_index: 0,
    estimated_seconds: 20,
    shots: [
      buildShot(1, 12, SHOT_POPULATION_MAP, "map", [1]),
      buildShot(2, 8, SHOT_POPULATION_URBAN, "stock_video", [1])
    ]
  };
}

const VISUAL_PLAN_TABLE = [
  {
    script: PIPELINE_SCRIPT,
    build: scenario => ({
      title: CANONICAL_TITLE,
      sections: [
        {
          title: "L'intérieur aride",
          segments: [buildAridSegment(scenario)]
        },
        {
          title: "Une population concentrée",
          segments: [buildPopulationSegment()]
        }
      ]
    })
  },
  {
    script: SMOKE_VISUAL_DIRECTOR_SCRIPT,
    build: scenario => ({
      title: CANONICAL_TITLE,
      sections: [
        {
          title: "L'intérieur aride",
          segments: [buildAridSegment(scenario)]
        }
      ]
    })
  }
];

// ------------------------------------------------------------------
// Visual Factual Grounding — juge + repair
// ------------------------------------------------------------------

const GROUNDING_TABLE = [
  {
    shot: SHOT_ARID_CLEAN,
    claims: [CLAIM_ARID],
    unsupported: []
  },
  {
    shot: SHOT_ARID_MAP,
    claims: [CLAIM_ARID],
    unsupported: []
  },
  {
    shot: SHOT_ATMOSPHERIC,
    claims: [],
    unsupported: []
  },
  {
    shot: SHOT_POPULATION_MAP,
    claims: [CLAIM_POPULATION],
    unsupported: []
  },
  {
    shot: SHOT_POPULATION_URBAN,
    claims: [CLAIM_POPULATION],
    unsupported: []
  },
  {
    shot: SHOT_ARID_OUTBACK,
    claims: [CLAIM_ARID],
    unsupported: [
      {
        text: "tons rouges et ocres",
        field: "visual_description",
        reason:
          "Couleur présentée comme caractéristique d'un lieu, absente du claim autorisé."
      },
      {
        text: "caractéristiques de l'Outback",
        field: "visual_description",
        reason:
          "Nom géographique plus précis, absent du claim autorisé."
      },
      {
        text: "Outback red ochre desert",
        field: "asset_query",
        reason:
          "Lieu, couleur et type de paysage absents du claim autorisé."
      }
    ],
    repaired: SHOT_ARID_CLEAN
  },
  {
    shot: SHOT_ARID_VEGETATION,
    claims: [CLAIM_ARID],
    unsupported: [
      {
        text: "végétation clairsemée",
        field: "visual_description",
        reason:
          "Type de végétation absent du claim autorisé."
      },
      {
        text: "ciel dégagé",
        field: "visual_description",
        reason:
          "Caractéristique météorologique absente du claim autorisé."
      },
      {
        text: "sparse vegetation clear sky",
        field: "asset_query",
        reason:
          "Végétation et météo absentes du claim autorisé."
      }
    ],
    // Réparation volontairement insuffisante.
    repaired: SHOT_ARID_VEGETATION_RESIDUAL
  },
  {
    shot: SHOT_ARID_VEGETATION_RESIDUAL,
    claims: [CLAIM_ARID],
    unsupported: [
      {
        text: "végétation clairsemée",
        field: "visual_description",
        reason:
          "Type de végétation absent du claim autorisé."
      },
      {
        text: "sparse vegetation",
        field: "asset_query",
        reason:
          "Type de végétation absent du claim autorisé."
      }
    ]
  }
];

// ------------------------------------------------------------------
// Lecture stricte des messages utilisateur réels
// ------------------------------------------------------------------

function fail(fixtureId, message) {
  throw new Error(
    `ANTHROPIC_FIXTURES=1 — fixture "${fixtureId}" : ${message}`
  );
}

function matchOrFail(fixtureId, userMessage, pattern) {
  const match = userMessage.match(pattern);

  if (!match) {
    fail(
      fixtureId,
      "message utilisateur non conforme au gabarit attendu."
    );
  }

  return match;
}

function parseJsonOrFail(fixtureId, text, label) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(
      fixtureId,
      `${label} illisible dans le message utilisateur.`
    );
  }
}

function json(value) {
  return {
    text: JSON.stringify(value, null, 2),
    json: true
  };
}

// ------------------------------------------------------------------
// Résolveurs
// ------------------------------------------------------------------

function resolveResearch(fixtureId, scenario, userMessage) {
  const [, title, prompt] = matchOrFail(
    fixtureId,
    userMessage,
    /^TEST TECHNIQUE UNIQUEMENT\.\n\nSujet : (.*)\n\nConsigne : (.*)\n\nRetourne une version MINIMALE du JSON demandé :\n/
  );

  if (title !== CANONICAL_TITLE || prompt !== CANONICAL_PROMPT) {
    fail(
      fixtureId,
      "sujet ou consigne hors du jeu de données canonique."
    );
  }

  if (scenario === "malformed-json") {
    return {
      text: MALFORMED_RESEARCH_TEXT,
      json: false
    };
  }

  return json(RESEARCH);
}

function resolveScript(fixtureId, scenario, userMessage) {
  const [, title, researchText] = matchOrFail(
    fixtureId,
    userMessage,
    /^TEST TECHNIQUE UNIQUEMENT\.\n\nTitre :\n(.*)\n\n[\s\S]*?\nDOSSIER RESEARCH :\n([\s\S]+)$/
  );

  const research = parseJsonOrFail(
    fixtureId,
    researchText,
    "dossier Research"
  );

  if (
    title !== CANONICAL_TITLE ||
    !isDeepStrictEqual(research, RESEARCH)
  ) {
    fail(
      fixtureId,
      "titre ou dossier Research hors du jeu de données canonique."
    );
  }

  return json(
    buildScript(
      SCRIPT_VOICEOVER_ARID_BY_SCENARIO[scenario] ??
      VOICEOVER_ARID
    )
  );
}

function resolveVisualDirector(fixtureId, scenario, userMessage) {
  const [, scriptText] = matchOrFail(
    fixtureId,
    userMessage,
    /^SCRIPT SOURCE VALIDE :\n\n([\s\S]+?)\n\nConstruis le plan visuel complet correspondant\.\n/
  );

  const script = parseJsonOrFail(
    fixtureId,
    scriptText,
    "script source"
  );

  const entry = VISUAL_PLAN_TABLE.find(
    candidate => isDeepStrictEqual(candidate.script, script)
  );

  if (!entry) {
    fail(
      fixtureId,
      "script source hors du jeu de données canonique."
    );
  }

  return json(entry.build(scenario));
}

function findCoverageEntry(fixtureId, voiceover, claims) {
  const entry = COVERAGE_TABLE.find(
    candidate =>
      candidate.voiceover === voiceover &&
      isDeepStrictEqual(candidate.claims, claims)
  );

  if (!entry) {
    fail(
      fixtureId,
      "voiceover/claims hors du jeu de données canonique."
    );
  }

  return entry;
}

function resolveCoverageJudge(fixtureId, scenario, userMessage) {
  const [, voiceover, claimsText] = matchOrFail(
    fixtureId,
    userMessage,
    /^VOICEOVER :\n\n([\s\S]+?)\n\nCLAIMS FACTUELS DECLARES :\n\n([\s\S]+?)\n\nDétermine si TOUTES /
  );

  const entry = findCoverageEntry(
    fixtureId,
    voiceover,
    parseJsonOrFail(fixtureId, claimsText, "claims")
  );

  return json({
    covered: entry.undeclared.length === 0,
    undeclared_claims: entry.undeclared
  });
}

function resolveCoverageRepair(fixtureId, scenario, userMessage) {
  const [, voiceover, claimsText, rejectedText] = matchOrFail(
    fixtureId,
    userMessage,
    /^VOICEOVER ORIGINAL :\n\n([\s\S]+?)\n\nCLAIMS FACTUELS AUTORISES :\n\n([\s\S]+?)\n\nAFFIRMATIONS FACTUELLES NON DECLAREES A ELIMINER :\n\n([\s\S]+?)\n\nRéécris uniquement le voiceover\.\n/
  );

  const entry = findCoverageEntry(
    fixtureId,
    voiceover,
    parseJsonOrFail(fixtureId, claimsText, "claims")
  );

  const rejected = parseJsonOrFail(
    fixtureId,
    rejectedText,
    "affirmations non déclarées"
  );

  if (
    typeof entry.repaired !== "string" ||
    !isDeepStrictEqual(rejected, entry.undeclared)
  ) {
    fail(
      fixtureId,
      "demande de réparation hors du jeu de données canonique."
    );
  }

  return json({
    voiceover: entry.repaired
  });
}

function findGroundingEntry(
  fixtureId,
  visualDescription,
  assetQuery,
  claims
) {
  const entry = GROUNDING_TABLE.find(
    candidate =>
      candidate.shot.visual_description === visualDescription &&
      candidate.shot.asset_query === assetQuery &&
      isDeepStrictEqual(candidate.claims, claims)
  );

  if (!entry) {
    fail(
      fixtureId,
      "shot/claims hors du jeu de données canonique."
    );
  }

  return entry;
}

function resolveGroundingJudge(fixtureId, scenario, userMessage) {
  const [, visualDescription, assetQuery, claimsText] = matchOrFail(
    fixtureId,
    userMessage,
    /^VISUAL DESCRIPTION :\n\n([\s\S]+?)\n\nASSET QUERY :\n\n([\s\S]+?)\n\nCLAIMS FACTUELS AUTORISES :\n\n([\s\S]+?)\n\nVérifie strictement /
  );

  const entry = findGroundingEntry(
    fixtureId,
    visualDescription,
    assetQuery,
    parseJsonOrFail(fixtureId, claimsText, "claims")
  );

  return json({
    grounded: entry.unsupported.length === 0,
    unsupported_visual_claims: entry.unsupported
  });
}

function resolveGroundingRepair(fixtureId, scenario, userMessage) {
  const [, shotText, claimsText, unsupportedText] = matchOrFail(
    fixtureId,
    userMessage,
    /^SHOT ORIGINAL :\n\n([\s\S]+?)\n\nCLAIMS FACTUELS AUTORISES :\n\n([\s\S]+?)\n\nAFFIRMATIONS VISUELLES NON SUPPORTEES :\n\n([\s\S]+?)\n\nRépare uniquement visual_description et asset_query\.\n/
  );

  const shot = parseJsonOrFail(fixtureId, shotText, "shot");

  const entry = findGroundingEntry(
    fixtureId,
    shot?.visual_description,
    shot?.asset_query,
    parseJsonOrFail(fixtureId, claimsText, "claims")
  );

  const unsupported = parseJsonOrFail(
    fixtureId,
    unsupportedText,
    "affirmations non supportées"
  );

  if (
    !entry.repaired ||
    !isDeepStrictEqual(unsupported, entry.unsupported)
  ) {
    fail(
      fixtureId,
      "demande de réparation hors du jeu de données canonique."
    );
  }

  return json({
    visual_description: entry.repaired.visual_description,
    asset_query: entry.repaired.asset_query
  });
}

const RESOLVERS = {
  "research": resolveResearch,
  "script": resolveScript,
  "visual-director": resolveVisualDirector,
  "validate-script-claim-coverage": resolveCoverageJudge,
  "validate-visual-factual-grounding": resolveGroundingJudge,
  "repair-script-claim-coverage": resolveCoverageRepair,
  "repair-visual-factual-grounding": resolveGroundingRepair
};

export function resolveFixtureText({
  fixtureId,
  scenario,
  userMessage
}) {
  if (!Object.hasOwn(RESOLVERS, fixtureId)) {
    fail(fixtureId, "aucun jeu de données pour ce fixture_id.");
  }

  if (!SCENARIOS.includes(scenario)) {
    fail(fixtureId, `scénario inconnu "${scenario}".`);
  }

  return RESOLVERS[fixtureId](fixtureId, scenario, userMessage);
}
