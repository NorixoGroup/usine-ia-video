import {
  SCENARIOS,
  resolveFixtureText
} from "./anthropic-dataset.js";

const FIXTURE_MODE_ENV = "ANTHROPIC_FIXTURES";
const FIXTURE_SCENARIO_ENV = "ANTHROPIC_FIXTURE_SCENARIO";
const DEFAULT_SCENARIO = "happy";

// Phrase d'ouverture exacte de chaque SYSTEM_PROMPT réel
// (espaces et retours à la ligne normalisés).
const SIGNATURES = {
  "research":
    "Tu es l'agent de recherche factuelle de la chaîne YouTube \"Les Découvertes du Nomade\".",
  "script":
    "Tu es le Script Agent de la chaîne YouTube \"Les Découvertes du Nomade\".",
  "visual-director":
    "Tu es le Visual Director de la chaîne YouTube \"Les Découvertes du Nomade\".",
  "validate-script-claim-coverage":
    "Tu es un auditeur de couverture factuelle.",
  "validate-script-claim-coverage-batch":
    "Tu es un auditeur de couverture factuelle batché.",
  "validate-visual-factual-grounding":
    "Tu es un validateur strict de grounding factuel pour un plan visuel documentaire.",
  "repair-script-claim-coverage":
    "Tu es un réparateur strict de couverture factuelle pour une voix-off documentaire.",
  "repair-visual-factual-grounding":
    "Tu es un réparateur strict de grounding factuel pour un shot de plan visuel documentaire.",
  "judge-title":
    "Tu es le juge du titre de la chaîne YouTube \"Les Découvertes du Nomade\".",
  "judge-evidence":
    "Tu es le juge des preuves de la chaîne YouTube \"Les Découvertes du Nomade\"."
};

export const FIXTURE_IDS = Object.keys(SIGNATURES);

// Tokens synthétiques fixes.
const SYNTHETIC_USAGE = {
  "research": { input_tokens: 1100, output_tokens: 600 },
  "script": { input_tokens: 2400, output_tokens: 700 },
  "visual-director": { input_tokens: 2300, output_tokens: 800 },
  "validate-script-claim-coverage": { input_tokens: 1200, output_tokens: 60 },
  "validate-script-claim-coverage-batch": { input_tokens: 1400, output_tokens: 120 },
  "validate-visual-factual-grounding": { input_tokens: 1100, output_tokens: 80 },
  "repair-script-claim-coverage": { input_tokens: 1000, output_tokens: 90 },
  "repair-visual-factual-grounding": { input_tokens: 900, output_tokens: 70 },
  "judge-title": { input_tokens: 1300, output_tokens: 300 },
  "judge-evidence": { input_tokens: 1500, output_tokens: 400 }
};

const callLog = [];

function fixturesEnabled() {
  return process.env[FIXTURE_MODE_ENV] === "1";
}

function fail(message) {
  throw new Error(`${FIXTURE_MODE_ENV}=1 — ${message}`);
}

export function detectFixtureId(system) {
  if (typeof system !== "string") {
    fail("SYSTEM_PROMPT absent ou invalide.");
  }

  const normalized = system.replace(/\s+/g, " ").trim();

  const matches = FIXTURE_IDS.filter(
    id => normalized.includes(SIGNATURES[id])
  );

  if (matches.length === 0) {
    fail("aucun fixture_id reconnu pour ce SYSTEM_PROMPT.");
  }

  if (matches.length > 1) {
    fail(
      `SYSTEM_PROMPT ambigu — correspondances : ${matches.join(", ")}.`
    );
  }

  if (!normalized.startsWith(SIGNATURES[matches[0]])) {
    fail(
      `SYSTEM_PROMPT ambigu — la signature "${matches[0]}" n'ouvre pas le prompt.`
    );
  }

  return matches[0];
}

function resolveScenario() {
  const scenario =
    process.env[FIXTURE_SCENARIO_ENV] ?? DEFAULT_SCENARIO;

  if (!SCENARIOS.includes(scenario)) {
    fail(
      `${FIXTURE_SCENARIO_ENV}="${scenario}" inconnu. ` +
      `Valeurs admises : ${SCENARIOS.join(", ")}.`
    );
  }

  return scenario;
}

function extractUserMessage(fixtureId, messages) {
  if (
    !Array.isArray(messages) ||
    messages.length !== 1 ||
    messages[0]?.role !== "user" ||
    typeof messages[0]?.content !== "string" ||
    messages[0].content.trim().length === 0
  ) {
    fail(
      `fixture "${fixtureId}" : messages doit contenir exactement un message utilisateur texte.`
    );
  }

  return messages[0].content;
}

// Garantit « fixture valide OU exception » : le retour est toujours un
// objet { response, meta } complet, jamais une valeur vide qui laisserait
// createMessage poursuivre vers l'API.
export function buildFixtureResult(fixtureId, fixture) {
  if (!Object.hasOwn(SIGNATURES, fixtureId)) {
    fail(`fixture_id inconnu "${fixtureId}".`);
  }

  if (
    !fixture ||
    typeof fixture.text !== "string" ||
    fixture.text.trim().length === 0 ||
    typeof fixture.json !== "boolean"
  ) {
    fail(`fixture "${fixtureId}" mal formée.`);
  }

  if (fixture.json) {
    let parsed;

    try {
      parsed = JSON.parse(fixture.text);
    } catch {
      fail(`fixture "${fixtureId}" mal formée : JSON invalide.`);
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      fail(
        `fixture "${fixtureId}" mal formée : objet JSON attendu.`
      );
    }
  }

  const model = `fixture:${fixtureId}`;
  const usage = SYNTHETIC_USAGE[fixtureId];
  const stopReason = "end_turn";

  return {
    response: {
      id: `msg_fixture_${fixtureId}`,
      type: "message",
      role: "assistant",
      model,
      content: [
        {
          type: "text",
          text: fixture.text
        }
      ],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { ...usage }
    },
    meta: {
      model,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      stop_reason: stopReason,
      duration_ms: 0
    }
  };
}

export function getFixtureCallLog() {
  return callLog.map(entry => ({ ...entry }));
}

export function getAnthropicFixture({ system, messages, tools }) {
  if (!fixturesEnabled()) {
    return null;
  }

  const fixtureId = detectFixtureId(system);
  const scenario = resolveScenario();

  if (tools !== undefined) {
    fail(
      `fixture "${fixtureId}" : aucun outil n'est simulé en mode fixture.`
    );
  }

  const userMessage = extractUserMessage(fixtureId, messages);

  const result = buildFixtureResult(
    fixtureId,
    resolveFixtureText({
      fixtureId,
      scenario,
      userMessage
    })
  );

  callLog.push({
    fixture_id: fixtureId,
    scenario
  });

  return result;
}
