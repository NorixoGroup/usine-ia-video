import {
  createMessage,
  extractText
} from "../services/anthropic.js";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  validateResearchDossier
} from "../utils/validate-research.js";

import {
  validateScriptDossier,
  scriptHasFrameRoles,
  syncNarratedFrameFields
} from "../utils/validate-script.js";

import {
  agentDurationProfile,
  formatDurationLabel,
  formatSectionsLabel
} from "../utils/duration-profile.js";

import {
  validateScriptClaims
} from "../utils/validate-script-claims.js";

import {
  validateVoiceoverClaimCoverage
} from "../utils/validate-script-claim-coverage.js";

import {
  repairVoiceoverClaimCoverage
} from "../utils/repair-script-claim-coverage.js";

import {
  classifyRepairOutcome,
  REPAIR_STATUS,
  COVERAGE_STATUS
} from "../utils/classify-script-claim-coverage-repair-outcome.js";

import {
  discardCachedResponse
} from "../services/call-guard.js";

import {
  buildCoverageLock,
  researchEntitiesOf,
  runScriptCoverageGate
} from "../utils/script-coverage-gate.js";

const SYSTEM_PROMPT = `
Tu es le Script Agent de la chaîne YouTube
"Les Découvertes du Nomade".

Tu transformes un dossier de recherche VALIDÉ en script voix-off
pour un documentaire faceless YouTube de {{DUREE}}.

RÈGLES ABSOLUES :

1. Le dossier Research fourni est ta seule base factuelle.
2. Tu ne fais aucune recherche web.
3. Tu n'inventes aucun chiffre, date, lieu, citation ou fait.
4. Tu ne transformes jamais une hypothèse ou une incertitude en fait établi.
5. Tu privilégies les key_facts ayant verification_status="verified".
6. Si un élément non vérifié est nécessaire à la narration, il doit être
   explicitement présenté comme incertain et
   contains_unverified_claim doit être true.
7. Chaque segment doit indiquer les index des key_facts utilisés dans
   research_fact_refs.
8. Les index de research_fact_refs sont basés sur key_facts :
   premier fait = 0, deuxième fait = 1, etc.
9. N'ajoute aucune référence vers un fait qui ne soutient pas réellement
   le texte du segment.
10. Chaque segment doit contenir un tableau claims qui décompose les
    affirmations factuelles présentes dans le voiceover.
11. Chaque claim doit être atomique : une seule affirmation factuelle.
12. Chaque claim doit pointer vers exactement un key_fact avec
    research_fact_ref.
13. is_unverified doit être false lorsque le key_fact référencé est verified.
14. Si le key_fact référencé n'est pas verified, is_unverified doit être true
    et le voiceover doit clairement présenter l'affirmation comme incertaine.
15. N'introduis dans le voiceover aucune affirmation factuelle qui ne soit
    représentée dans claims et soutenue par le Research.

16. Un key_fact constitue une FRONTIÈRE FACTUELLE.
    Tu peux le reformuler ou le paraphraser sans en changer le sens,
    mais tu ne peux pas l'enrichir avec une information qui n'y figure pas.

17. Sont notamment interdits lorsqu'ils ne figurent pas explicitement dans
    le key_fact référencé :
    - un chiffre, une quantité, une proportion ou une comparaison ;
    - une date, une période ou une évolution historique ;
    - un lieu, une ville, une région ou un nom géographique ;
    - le nom d'une institution, d'une organisation ou d'une source ;
    - une caractéristique climatique, physique, économique ou sociale ;
    - une cause, une conséquence ou une relation explicative ;
    - une généralisation ou une conclusion factuelle supplémentaire ;
    - tout détail présenté comme vrai simplement parce qu'il paraît plausible.

18. Un claim ne doit jamais servir de prétexte pour introduire dans le
    voiceover plusieurs faits voisins absents du key_fact qui le soutient.

19. Avant de finaliser chaque segment, vérifie mentalement chaque phrase
    du voiceover :
    - si elle affirme quelque chose de vérifiable sur le monde réel,
      cette affirmation doit apparaître dans claims ;
    - le claim correspondant doit être soutenu par son key_fact ;
    - si aucun key_fact ne soutient cette affirmation, supprime-la du
      voiceover au lieu de l'inventer ou de la compléter.

20. Les formulations narratives, transitions et questions rhétoriques sont
    autorisées uniquement lorsqu'elles n'ajoutent aucune information
    factuelle nouvelle.

21. La fluidité documentaire ne justifie jamais l'ajout d'un fait absent
    du Research. En cas de conflit entre richesse narrative et fidélité
    factuelle, privilégie toujours la fidélité au Research.

22. Le texte doit être naturel à l'oral, fluide, précis et documentaire.
23. Évite le remplissage artificiel et les répétitions.
24. Le hook doit créer de la curiosité sans clickbait trompeur.
25. La narration complète doit viser {{DUREE}}.
26. Le script sera ensuite transmis au Visual Director et au Voice Agent.

Réponds uniquement avec un JSON valide.
Aucun Markdown.
Aucun texte avant ou après le JSON.

Structure obligatoire :

{
  "title": "",
  "hook": "",
  "thesis": "",
  "estimated_duration_minutes": {{CIBLE}},
  "sections": [
    {
      "title": "",
      "purpose": "",
      "segments": [
        {
          "voiceover": "",
          "estimated_seconds": 0,
          "research_fact_refs": [],
          "contains_unverified_claim": false,
          "claims": [
            {
              "text": "",
              "research_fact_ref": 0,
              "is_unverified": false
            }
          ]
        }
      ]
    }
  ],
  "conclusion": ""
}

CONSIGNES DE STRUCTURE :

- {{SECTIONS}} sections.
- Plusieurs segments par section lorsque nécessaire.
- Chaque segment doit rester suffisamment court pour être exploitable
  ensuite par le Visual Director.
- Chaque segment doit contenir au moins un claim factuel.
- Tous les faits exprimés dans le voiceover doivent être couverts par claims.
- Les research_fact_refs du segment doivent correspondre aux faits réellement
  utilisés par ses claims.
- La progression narrative doit être logique :
  hook -> problème -> explications -> approfondissement -> conclusion.
- estimated_seconds doit représenter raisonnablement la durée du texte
  prononcé.
`.trim();

// Garde purement défensive de convergence : ce n'est pas une règle éditoriale.
// Une couverture complète doit converger avant cette borne.
export const MAX_COVERAGE_FIXPOINT_ITERATIONS = 10;

// Règles ajoutées au prompt système quand le cadre narré est demandé
// (R14B). Sans cadre narré, le prompt historique est inchangé.
const FRAME_RULES = `
CADRE NARRÉ (obligatoire pour ce script) :

A. Le hook est le PREMIER segment de la PREMIÈRE section.
   Ce segment porte "role": "hook".
B. La conclusion est le DERNIER segment de la DERNIÈRE section.
   Ce segment porte "role": "conclusion".
C. Le champ "hook" du script reprend EXACTEMENT le voiceover du segment hook.
   Le champ "conclusion" reprend EXACTEMENT le voiceover du segment conclusion.
D. Le hook et la conclusion sont de vrais segments, narrés puis illustrés :
   ils ont estimated_seconds, research_fact_refs, contains_unverified_claim
   et claims, et obéissent à toutes les règles de fidélité factuelle
   ci-dessus (aucune affirmation hors claims).
E. Aucun autre segment ne porte de role.
F. Le hook et la conclusion s'appuient chacun sur au moins un key_fact.
`.trim();

const FRAME_REMINDER =
  'CADRE NARRÉ : le hook est le premier segment de la première section ' +
  '(role "hook") et la conclusion le dernier segment de la dernière ' +
  'section (role "conclusion"). Chacun porte ses claims ; les champs ' +
  "hook et conclusion reprennent exactement leur voiceover.";

// R23-A — un chapitre est suffisamment petit pour rester loin des limites de
// sortie du modèle. Le nombre est déterministe : 10/20/30/45 minutes donnent
// respectivement 3/5/8/12 checkpoints, avec un minimum de trois chapitres.
const SEGMENT_SCHEMA = "script-segment.v1";
const SEGMENT_DIRECTORY = "script-segments";
const CHAPTER_MINUTES = 4;
const MIN_CHAPTERS = 3;
const MAX_CHAPTERS = 12;
const MIN_SEGMENTS_PER_CHAPTER = 4;

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const stableJson = value => JSON.stringify(value);

function chapterCount(profile) {
  return Math.max(
    MIN_CHAPTERS,
    Math.min(MAX_CHAPTERS, Math.ceil(profile.target / CHAPTER_MINUTES))
  );
}

// R23-D — limite de sortie sûre, calculée de façon déterministe avant chaque
// chapitre à partir de sa durée visée. Mesure réelle (R22-B) : ~22,9 tokens
// de sortie par seconde de vidéo, structure JSON et claims compris.
// - OUTPUT_TOKENS_PER_SECOND : 1,5 × la mesure ;
// - CHAPTER_DURATION_HEADROOM : un chapitre peut dépasser sa cible de 50 % ;
// - CHAPTER_OUTPUT_OVERHEAD : titre, objectif, thèse et enveloppe JSON ;
// - SAFE_OUTPUT_CEILING : sous 21 333 tokens, seuil au-delà duquel le SDK
//   exige le streaming (requête de plus de 10 minutes) ;
// - CHAPTER_MIN_OUTPUT_TOKENS : l'ancienne limite reste un plancher.
const OUTPUT_TOKENS_PER_SECOND = 35;
const CHAPTER_DURATION_HEADROOM = 1.5;
const CHAPTER_OUTPUT_OVERHEAD = 1000;
const CHAPTER_MIN_OUTPUT_TOKENS = 5000;
export const SAFE_OUTPUT_CEILING = 16000;

export function chapterOutputBudget(expectedSeconds) {
  return Math.max(
    CHAPTER_MIN_OUTPUT_TOKENS,
    Math.ceil(expectedSeconds * CHAPTER_DURATION_HEADROOM * OUTPUT_TOKENS_PER_SECOND + CHAPTER_OUTPUT_OVERHEAD)
  );
}

const chapterSeconds = (profile, total) => Math.round((profile.target * 60) / total);

// Nombre de chapitres et limite de sortie, fixés avant le premier appel. Si la
// limite dépasse le plafond sûr, le documentaire est découpé en chapitres plus
// nombreux (déterministe) ; au-delà de MAX_CHAPTERS, refus avant tout appel.
export function chapterPlan(profile) {
  let total = chapterCount(profile);

  while (chapterOutputBudget(chapterSeconds(profile, total)) > SAFE_OUTPUT_CEILING && total < MAX_CHAPTERS) {
    total += 1;
  }

  const maxTokens = chapterOutputBudget(chapterSeconds(profile, total));

  if (maxTokens > SAFE_OUTPUT_CEILING) {
    throw new Error(
      `Script Agent : durée ${profile.target} min trop longue pour ${MAX_CHAPTERS} chapitres ` +
      `(limite de sortie ${maxTokens} > ${SAFE_OUTPUT_CEILING}). Aucun appel effectué.`
    );
  }

  return { total, maxTokens, expectedSeconds: chapterSeconds(profile, total) };
}

// R23-D — validations existantes appliquées à un chapitre seul, avant toute
// écriture de checkpoint : Script Gate (dossier minimal du chapitre),
// références Research et Claim Gate. Renvoie la liste des erreurs.
function chapterErrors({ chapter, index, research, profile }) {
  if (!validChapter(chapter)) return ["structure du chapitre invalide"];
  if (index === 0 && (typeof chapter.thesis !== "string" || !chapter.thesis.trim())) return ["thesis manquante"];

  const segments = chapter.segments;
  // Un chapitre isolé ne représente pas le script complet : le cadre narré
  // (hook/conclusion) est donc validé uniquement après l'assemblage de tous
  // les chapitres. Les autres contraintes de dossier restent contrôlées ici.
  const single = {
    sections: [{
      title: chapter.title,
      purpose: chapter.purpose,
      segments: segments.map(({ role, ...segment }) => segment)
    }]
  };
  const dossier = validateScriptDossier({
    title: chapter.title,
    hook: segments[0].voiceover,
    thesis: chapter.thesis ?? chapter.purpose,
    estimated_duration_minutes: profile.target,
    ...single,
    conclusion: segments.at(-1).voiceover
  }, { durationRange: { min: profile.min, max: profile.max } });
  const claims = validateScriptClaims(single, research);

  return [
    ...(dossier.valid ? [] : dossier.errors),
    ...validateResearchReferences(single, research),
    ...(claims.valid ? [] : claims.errors)
  ];
}

// R23-D — une réponse rejetée n'est jamais rejouée par le cache, et un
// checkpoint mis en cause est déplacé (jamais supprimé) dans rejected/.
function quarantineCheckpoint(directory, index) {
  const file = checkpointFile(directory, index);

  if (!fs.existsSync(file)) return;

  let hash = null;

  try {
    hash = JSON.parse(fs.readFileSync(file, "utf8")).request_sha256 ?? null;
  } catch {
    // checkpoint illisible : déplacé tel quel
  }

  const rejected = path.join(directory, "rejected", new Date().toISOString().replace(/[:.]/g, "-"));

  fs.mkdirSync(rejected, { recursive: true });
  fs.renameSync(file, path.join(rejected, path.basename(file)));
  discardCachedResponse(hash);
}

// Gates du script complet dont les erreurs désignent un chapitre (section).
// R28.10 : la couverture ne met jamais un chapitre en quarantaine (D1, I24) ;
// un NOT_PASS de couverture arrête l'étape Script sans toucher aux checkpoints.
const ATTRIBUTABLE_GATES = ["Script Gate", "références Research invalides", "Claim Gate"];

function blamedChapters(message, total) {
  if (!ATTRIBUTABLE_GATES.some(gate => message.includes(gate))) return [];

  return [...new Set([...message.matchAll(/sections\[(\d+)\]/g)].map(m => Number(m[1])))]
    .filter(index => index < total)
    .sort((a, b) => a - b);
}

function atomicJson(file, data) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;

  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
}

function checkpointFile(directory, index) {
  return path.join(directory, `segment-${String(index + 1).padStart(3, "0")}.json`);
}

function validChapter(value) {
  return value && typeof value === "object" &&
    typeof value.title === "string" && value.title.trim() &&
    typeof value.purpose === "string" && value.purpose.trim() &&
    Array.isArray(value.segments) &&
    value.segments.length >= MIN_SEGMENTS_PER_CHAPTER &&
    value.segments.every(segment =>
      segment && typeof segment.voiceover === "string" && segment.voiceover.trim() &&
      Number.isFinite(segment.estimated_seconds) && segment.estimated_seconds > 0 &&
      Array.isArray(segment.research_fact_refs) &&
      typeof segment.contains_unverified_claim === "boolean" &&
      Array.isArray(segment.claims) && segment.claims.length > 0
    );
}

// Les rôles hook/conclusion appartiennent au script assemblé, jamais à une
// réponse de chapitre. Le contenu du segment reste inchangé.
function withoutProviderNarrativeRoles(chapter) {
  if (!chapter || typeof chapter !== "object" || !Array.isArray(chapter.segments)) {
    return chapter;
  }

  return {
    ...chapter,
    segments: chapter.segments.map(segment => {
      if (!segment || typeof segment !== "object") return segment;
      const { role, ...content } = segment;
      return content;
    })
  };
}

function readCheckpoint({
  directory,
  index,
  planHash,
  total,
  previousContextHash,
  research,
  profile
}) {
  const file = checkpointFile(directory, index);

  if (!fs.existsSync(file)) return null;

  try {
    const checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));

    if (
      checkpoint?.schema !== SEGMENT_SCHEMA ||
      checkpoint.plan_sha256 !== planHash ||
      checkpoint.index !== index + 1 ||
      checkpoint.total !== total ||
      checkpoint.previous_context_sha256 !== previousContextHash ||
      !validChapter(checkpoint.chapter) ||
      chapterErrors({ chapter: checkpoint.chapter, index, research, profile }).length > 0 ||
      !checkpoint.usage || typeof checkpoint.usage !== "object"
    ) return null;

    return checkpoint;
  } catch {
    return null;
  }
}

function chapterContext(chapter) {
  const last = chapter.segments.at(-1);

  return {
    title: chapter.title,
    purpose: chapter.purpose,
    last_voiceover: last?.voiceover ?? ""
  };
}

function buildChapterPrompt({ research, title, profile, narratedFrame, index, total, previous }) {
  const expectedSeconds = Math.round((profile.target * 60) / total);
  const first = index === 0;
  const last = index === total - 1;

  return `
Rédige le chapitre ${index + 1}/${total} d'un documentaire voix-off.

Titre :
${title || research.topic}

Durée visée de ce chapitre : environ ${expectedSeconds} secondes.

Chaque chapitre est autonome mais doit rester cohérent avec le précédent.
Il contient obligatoirement : une introduction locale, un développement,
des transitions explicites et une conclusion locale qui prépare le chapitre suivant.
Ne répète pas les faits déjà exposés, sauf rappel strictement nécessaire.
Découpe-le en au moins ${MIN_SEGMENTS_PER_CHAPTER} segments courts, chacun
directement exploitable par le Visual Director (environ 20 à 75 secondes).

${first ? "C'est le premier chapitre : produis aussi un champ thesis factuel, soutenu par le dossier." : ""}
${last ? "C'est le dernier chapitre : termine par une conclusion locale qui clôt le documentaire sans introduire de nouveau fait." : ""}
${narratedFrame ? `${FRAME_REMINDER}\n` : ""}

Retourne uniquement ce JSON valide :
{
  "title": "",
  "purpose": "",
  ${first ? '"thesis": "",' : ""}
  "segments": [
    {
      "voiceover": "",
      "estimated_seconds": 0,
      "research_fact_refs": [],
      "contains_unverified_claim": false,
      "claims": [{ "text": "", "research_fact_ref": 0, "is_unverified": false }]
    }
  ]
}

RÈGLES FACTUELLES : le dossier Research est la seule source ; n'invente aucun fait ;
chaque affirmation factuelle du voiceover doit avoir un claim atomique ; chaque claim
doit référencer exactement un key_fact ; les faits non vérifiés sont explicitement
présentés comme incertains.

CONTRAT NON NÉGOCIABLE — À APPLIQUER À CHAQUE SEGMENT SANS EXCEPTION :
- claims doit contenir AU MOINS un objet : il ne doit jamais être [].
- Chaque claim doit provenir exclusivement d'un key_fact approuvé du dossier
  Research et pointer vers cet unique key_fact avec research_fact_ref.
- research_fact_refs et claims doivent rester cohérents : chaque référence du
  segment doit être réellement utilisée par au moins un claim, et chaque claim
  doit avoir sa référence présente dans research_fact_refs.
- Avant de répondre, vérifie chaque segment un par un. Si tu ne peux pas
  écrire au moins un claim soutenu par le Research, régénère ce segment avec
  un voiceover factuellement soutenu ; ne laisse jamais claims vide.

CONTEXTE DU CHAPITRE PRÉCÉDENT :
${previous ? JSON.stringify(previous) : "Aucun : ouverture du documentaire."}

DOSSIER FACTUEL AUTORISÉ — KEY_FACTS UNIQUEMENT :
${JSON.stringify(scriptFactualResearch(research))}
`.trim();
}

// Le Script Agent ne reçoit aucun objectif de recherche non résolu
// (facts_needed, gaps ou uncertainties). Seuls les key_facts issus du
// contrat Research peuvent être utilisés comme matériau factuel.
function scriptFactualResearch(research) {
  return {
    topic: research.topic,
    key_facts: research.key_facts.map((fact, index) => ({
      research_fact_ref: index,
      claim: fact.claim,
      importance: fact.importance,
      verification_status: fact.verification_status
    })),
    chapter_structure: research.sections.map(section => ({
      title: section.title,
      purpose: section.purpose
    }))
  };
}

// Adapte le prompt au profil de durée et au cadre narré. Avec le profil
// standard et sans cadre narré, le résultat est strictement le prompt
// historique (25 à 30 minutes, 27, 6 à 8 sections).
function buildSystemPrompt(profile, narratedFrame) {
  const prompt = SYSTEM_PROMPT
    .replaceAll("{{DUREE}}", formatDurationLabel(profile))
    .replaceAll("{{CIBLE}}", String(profile.target))
    .replaceAll("{{SECTIONS}}", formatSectionsLabel(profile.sections));

  return narratedFrame ? `${prompt}\n\n${FRAME_RULES}` : prompt;
}

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error("Script Agent : réponse Anthropic vide.");
  }

  const raw = text.trim();

  const jsonFence = raw.match(/```json\s*([\s\S]*?)```/i);

  if (jsonFence?.[1]) {
    try {
      return JSON.parse(jsonFence[1].trim());
    } catch (error) {
      throw new Error(
        "Script Agent : bloc JSON Markdown invalide. " +
        error.message
      );
    }
  }

  const genericFence = raw.match(/```\s*([\s\S]*?)```/);

  if (genericFence?.[1]) {
    try {
      return JSON.parse(genericFence[1].trim());
    } catch {
      // Continue.
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Continue.
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(
        raw.slice(firstBrace, lastBrace + 1)
      );
    } catch (error) {
      throw new Error(
        "Script Agent : JSON invalide. " +
        error.message
      );
    }
  }

  throw new Error(
    "Script Agent : aucun objet JSON détecté."
  );
}

function validateResearchReferences(script, research) {
  const errors = [];
  const maxIndex = research.key_facts.length - 1;

  script.sections.forEach((section, sectionIndex) => {
    section.segments.forEach((segment, segmentIndex) => {
      for (const ref of segment.research_fact_refs ?? []) {
        if (ref > maxIndex) {
          errors.push(
            `sections[${sectionIndex}].segments[${segmentIndex}]: ` +
            `research_fact_ref ${ref} hors limites`
          );
          continue;
        }

        const fact = research.key_facts[ref];

        if (
          fact.verification_status !== "verified" &&
          segment.contains_unverified_claim !== true
        ) {
          errors.push(
            `sections[${sectionIndex}].segments[${segmentIndex}]: ` +
            `fait ${ref} non vérifié utilisé sans signalement`
          );
        }
      }
    });
  });

  return errors;
}

export function estimateCoverageFixpointRemainingCalls({
  activeIterationsRemaining,
  remainingUncoveredSegments,
  maxIterations = MAX_COVERAGE_FIXPOINT_ITERATIONS
}) {
  if (
    !Number.isSafeInteger(maxIterations) || maxIterations < 1 ||
    !Number.isSafeInteger(activeIterationsRemaining) ||
    activeIterationsRemaining < 0 || activeIterationsRemaining > maxIterations ||
    !Number.isSafeInteger(remainingUncoveredSegments) ||
    remainingUncoveredSegments < 0
  ) {
    throw new Error("Script Agent : état de budget de convergence invalide.");
  }

  return activeIterationsRemaining +
    remainingUncoveredSegments * maxIterations;
}

// Orchestration seule : Repair, Recheck et le coordinateur gardent chacun
// leur contrat fermé. Une FAIL intermédiaire devient une nouvelle entrée de
// Repair ; seul un état terminal est transmis au coordinateur.
export async function convergeCoverageRepair({
  voiceover,
  claims,
  initialCoverage,
  approvedFacts,
  id,
  remainingUncoveredSegments = 0,
  repair = repairVoiceoverClaimCoverage,
  recheck = validateVoiceoverClaimCoverage,
  maxIterations = MAX_COVERAGE_FIXPOINT_ITERATIONS
}) {
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new Error("Script Agent : maxIterations de convergence invalide.");
  }

  let candidate = voiceover;
  let coverage = initialCoverage;
  let latestRepair = null;
  const repairClaims = initialCoverage.claims;
  const candidateHashes = [sha256(candidate)];
  const seenCandidateHashes = new Set(candidateHashes);
  const budgetTrace = [];

  const recordBudget = ({ iteration, phase, activeIterationsRemaining }) => {
    budgetTrace.push({
      iteration,
      phase,
      remaining_calls_max: estimateCoverageFixpointRemainingCalls({
        activeIterationsRemaining,
        remainingUncoveredSegments,
        maxIterations
      })
    });
  };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    latestRepair = repair({
      voiceover: candidate,
      claims: repairClaims,
      unsupported: coverage.unsupported,
      approvedFacts
    });

    if (latestRepair.status !== REPAIR_STATUS.CANDIDATE) {
      recordBudget({ iteration, phase: "terminal", activeIterationsRemaining: 0 });
      return {
        voiceover: candidate,
        coverage,
        repair: latestRepair,
        iterations: iteration,
        candidate_hashes: candidateHashes,
        budget_trace: budgetTrace,
        terminal_reason: latestRepair.status,
        outcome: classifyRepairOutcome({
          repairStatus: latestRepair.status,
          coverageStatus: null
        })
      };
    }

    candidate = latestRepair.voiceover;
    const candidateHash = sha256(candidate);

    if (seenCandidateHashes.has(candidateHash)) {
      recordBudget({ iteration, phase: "terminal", activeIterationsRemaining: 0 });
      return {
        voiceover: candidate,
        coverage,
        repair: latestRepair,
        iterations: iteration,
        candidate_hashes: candidateHashes,
        budget_trace: budgetTrace,
        terminal_reason: "CANDIDATE_HASH_CYCLE",
        outcome: classifyRepairOutcome({
          repairStatus: latestRepair.status,
          coverageStatus: COVERAGE_STATUS.FAIL
        })
      };
    }

    seenCandidateHashes.add(candidateHash);
    candidateHashes.push(candidateHash);

    // validateVoiceoverClaimCoverage atteint createMessage(), dont beginRealCall()
    // consulte d'abord le cache puis vérifie le plafond juste avant tout SDK call.
    // Un cache hit consomme donc exactement zéro appel réel.
    recordBudget({
      iteration,
      phase: "before_recheck",
      activeIterationsRemaining: maxIterations - iteration + 1
    });
    coverage = await recheck({ voiceover: candidate, claims, id });

    if (coverage.covered) {
      recordBudget({ iteration, phase: "terminal", activeIterationsRemaining: 0 });
      return {
        voiceover: candidate,
        coverage,
        repair: latestRepair,
        iterations: iteration,
        candidate_hashes: candidateHashes,
        budget_trace: budgetTrace,
        terminal_reason: COVERAGE_STATUS.PASS,
        outcome: classifyRepairOutcome({
          repairStatus: latestRepair.status,
          coverageStatus: COVERAGE_STATUS.PASS
        })
      };
    }

    recordBudget({
      iteration,
      phase: "after_recheck_fail",
      activeIterationsRemaining: maxIterations - iteration
    });
  }

  recordBudget({
    iteration: maxIterations,
    phase: "terminal",
    activeIterationsRemaining: 0
  });
  return {
    voiceover: candidate,
    coverage,
    repair: latestRepair,
    iterations: maxIterations,
    candidate_hashes: candidateHashes,
    budget_trace: budgetTrace,
    terminal_reason: "MAX_ITERATIONS",
    outcome: classifyRepairOutcome({
      repairStatus: latestRepair.status,
      coverageStatus: COVERAGE_STATUS.FAIL
    })
  };
}

async function validateGeneratedScript(data, research, options = {}) {
  const validation = validateScriptDossier(data, options);

  if (!validation.valid) {
    throw new Error(
      "Script Agent : dossier rejeté par le Script Gate. " +
      validation.errors.join(" | ")
    );
  }

  const referenceErrors =
    validateResearchReferences(data, research);

  if (referenceErrors.length > 0) {
    throw new Error(
      "Script Agent : références Research invalides. " +
      referenceErrors.join(" | ")
    );
  }

  const claimValidation =
    validateScriptClaims(data, research);

  if (!claimValidation.valid) {
    throw new Error(
      "Script Agent : dossier rejeté par le Claim Gate. " +
      claimValidation.errors.join(" | ")
    );
  }

  // R28.10 — couverture factuelle : coordinateur de convergence (R28.9) pour
  // chaque segment, à travers la porte de couverture. Script PASS si et
  // seulement si chaque segment est PASS ; au premier NOT_PASS, arrêt.
  const coverage = await runScriptCoverageGate({
    script: data,
    research,
    ...(options.coverageTransport ? { transport: options.coverageTransport } : {})
  });

  // Métadonnées autorisées (R28.10A D8, R28.11) : valid et errors (contrat des
  // verdicts persistés du validateur de qualité), statut, protocole, empreinte
  // et contenu du verrou, et par segment les métadonnées de la porte.
  const claimCoverageValidation = {
    valid: coverage.status === "PASS",
    errors: [],
    status: coverage.status,
    protocol_id: coverage.protocol_id,
    lock_sha256: coverage.lock_sha256,
    // R28.11 : verrou complet (11 éléments), enregistré au premier passage et
    // contrôlé à la reprise (assertReusedScriptLock).
    lock: { ...buildCoverageLock({ entities: researchEntitiesOf(research) }) },
    segments: coverage.segments.map(segment => ({ ...segment }))
  };

  if (coverage.status !== "PASS") {
    claimCoverageValidation.protocol_outcome = {
      status: "NOT_PASS",
      segment_id: coverage.failure?.segment_id ?? null,
      label: coverage.failure?.label ?? null,
      reason: coverage.failure?.reason ?? null,
      category: coverage.failure?.category ?? null,
      unit_ids: coverage.failure?.unit_ids ?? [],
      detail: coverage.failure?.detail ?? null
    };

    return {
      validation,
      research_reference_validation: { valid: true, errors: [] },
      claim_validation: claimValidation,
      claim_coverage_validation: claimCoverageValidation,
      protocol_outcome: claimCoverageValidation.protocol_outcome
    };
  }

  // PASS : chaque segment reçoit le voiceover final du coordinateur (texte
  // d'origine moins les unités supprimées, jamais réécrit).
  for (const item of coverage.final_voiceovers) {
    data.sections[item.section_index].segments[item.segment_index].voiceover = item.voiceover;
  }

  // Cadre narré : hook et conclusion sont dérivés de leurs segments, qui
  // ont pu être réparés par le gate de couverture ci-dessus. Le script
  // final est revalidé.
  let finalValidation = validation;

  if (options.requireNarratedFrame || scriptHasFrameRoles(data)) {
    syncNarratedFrameFields(data);

    finalValidation = validateScriptDossier(data, options);

    if (!finalValidation.valid) {
      throw new Error(
        // R28.10A D10 : libellé hors ATTRIBUTABLE_GATES, la couverture ne
        // met jamais un chapitre en quarantaine.
        "Script Agent : dossier rejeté par la revalidation du cadre " +
        "narré après couverture. " +
        finalValidation.errors.join(" | ")
      );
    }
  }

  return {
    validation: finalValidation,
    research_reference_validation: {
      valid: true,
      errors: []
    },
    claim_validation: claimValidation,
    claim_coverage_validation: claimCoverageValidation
  };
}

async function runSegmentedScriptAgent({
  research,
  title,
  profile,
  narratedFrame,
  validationOptions,
  productionDir
}) {
  const { total, maxTokens } = chapterPlan(profile);
  const directory = path.join(productionDir, SEGMENT_DIRECTORY);
  const planHash = sha256(stableJson({
    schema: SEGMENT_SCHEMA,
    title: title || research.topic,
    research,
    profile: {
      target: profile.target,
      min: profile.min,
      max: profile.max,
      sections: profile.sections
    },
    narrated_frame: narratedFrame === true,
    total
  }));

  fs.mkdirSync(directory, { recursive: true });

  const checkpoints = [];
  let previous = null;
  let generated = 0;
  let reused = 0;

  for (let index = 0; index < total; index += 1) {
    let checkpoint = readCheckpoint({
      directory,
      index,
      planHash,
      total,
      previousContextHash: previous
        ? sha256(stableJson(previous))
        : null,
      research,
      profile
    });

    if (checkpoint) {
      reused += 1;
    } else {
      const { response, meta, request_sha256: requestHash } = await createMessage({
        system: buildSystemPrompt(profile, narratedFrame === true),
        messages: [{
          role: "user",
          content: buildChapterPrompt({
            research,
            title,
            profile,
            narratedFrame,
            index,
            total,
            previous
          })
        }],
        maxTokens,
        temperature: 0.2
      });

      // R23-D : rien n'est écrit tant que le chapitre n'a pas passé toutes
      // les validations ; une réponse rejetée est écartée du cache.
      const reject = message => {
        discardCachedResponse(requestHash);
        throw new Error(`Script Agent : chapitre ${index + 1}/${total} ${message}`);
      };

      if (meta.stop_reason === "max_tokens") {
        reject(
          "tronqué — stop_reason=max_tokens. " +
          `Tokens sortie=${meta.output_tokens ?? "inconnu"} (limite ${maxTokens}).`
        );
      }

      let chapter;

      try {
        chapter = parseJson(extractText(response));
      } catch (error) {
        reject(`invalide — ${error.message}`);
      }

      chapter = withoutProviderNarrativeRoles(chapter);

      const errors = chapterErrors({ chapter, index, research, profile });

      if (errors.length > 0) {
        reject(`invalide. ${errors.join(" | ")}`);
      }

      checkpoint = {
        schema: SEGMENT_SCHEMA,
        plan_sha256: planHash,
        index: index + 1,
        total,
        chapter,
        usage: meta,
        ...(requestHash ? { request_sha256: requestHash } : {}),
        previous_context_sha256: previous
          ? sha256(stableJson(previous))
          : null,
        created_at: new Date().toISOString()
      };

      atomicJson(checkpointFile(directory, index), checkpoint);
      generated += 1;
    }

    checkpoints.push(checkpoint);
    previous = chapterContext(checkpoint.chapter);
  }

  const sections = checkpoints.map(checkpoint => ({
    title: checkpoint.chapter.title,
    purpose: checkpoint.chapter.purpose,
    segments: withoutProviderNarrativeRoles(checkpoint.chapter)
      .segments.map(segment => ({ ...segment }))
  }));
  const firstSegment = sections[0].segments[0];
  const lastSection = sections.at(-1);
  const lastSegment = lastSection.segments.at(-1);

  if (narratedFrame) {
    firstSegment.role = "hook";
    lastSegment.role = "conclusion";
  }

  const data = {
    title: title || research.topic,
    hook: firstSegment.voiceover,
    thesis: checkpoints[0].chapter.thesis,
    estimated_duration_minutes: profile.target,
    sections,
    conclusion: lastSegment.voiceover
  };
  let gateResult;

  try {
    gateResult = await validateGeneratedScript(
      data,
      research,
      validationOptions
    );
  } catch (error) {
    // R23-D : un gate du script complet qui désigne des chapitres les écarte
    // (checkpoint et réponse en cache) ; la reprise les régénère.
    for (const index of blamedChapters(String(error?.message ?? ""), total)) {
      quarantineCheckpoint(directory, index);
    }

    throw error;
  }
  const usage = checkpoints.reduce((totalUsage, checkpoint) => ({
    input_tokens: totalUsage.input_tokens + (checkpoint.usage.input_tokens ?? 0),
    output_tokens: totalUsage.output_tokens + (checkpoint.usage.output_tokens ?? 0),
    duration_ms: totalUsage.duration_ms + (checkpoint.usage.duration_ms ?? 0)
  }), { input_tokens: 0, output_tokens: 0, duration_ms: 0 });

  if (gateResult.protocol_outcome) {
    return {
      agent: "script",
      mode: "full",
      protocol_outcome: gateResult.protocol_outcome,
      claim_coverage_validation: gateResult.claim_coverage_validation,
      usage: {
        ...usage,
        model: "segmented-script",
        stop_reason: "end_turn",
        calls: generated,
        reused_segments: reused
      },
      script_generation: {
        mode: "segmented",
        total_segments: total,
        generated_segments: generated,
        reused_segments: reused,
        checkpoint_directory: SEGMENT_DIRECTORY,
        plan_sha256: planHash
      }
    };
  }

  return {
    agent: "script",
    mode: "full",
    data,
    ...gateResult,
    usage: {
      ...usage,
      model: "segmented-script",
      stop_reason: "end_turn",
      calls: generated,
      reused_segments: reused
    },
    script_generation: {
      mode: "segmented",
      total_segments: total,
      generated_segments: generated,
      reused_segments: reused,
      checkpoint_directory: SEGMENT_DIRECTORY,
      plan_sha256: planHash
    }
  };
}

export async function runScriptAgent({
  research,
  title,
  testMode = false,
  durationProfile,
  narratedFrame = false,
  productionDir,
  coverageTransport
}) {
  const profile = agentDurationProfile(durationProfile);
  const validationOptions = {
    durationRange: { min: profile.min, max: profile.max },
    requireNarratedFrame: narratedFrame === true,
    ...(coverageTransport ? { coverageTransport } : {})
  };

  const researchValidation =
    validateResearchDossier(research);

  if (!researchValidation.valid) {
    throw new Error(
      "Script Agent : dossier Research invalide. " +
      researchValidation.errors.join(" | ")
    );
  }

  // Les tests et les intégrations qui appellent directement l'agent gardent
  // leur contrat monolithique historique. L'orchestrateur full fournit le
  // répertoire de production, ce qui active les checkpoints segmentés.
  if (!testMode && productionDir) {
    return runSegmentedScriptAgent({
      research,
      title,
      profile,
      narratedFrame,
      validationOptions,
      productionDir
    });
  }

  const userPrompt = testMode
    ? `
TEST TECHNIQUE UNIQUEMENT.

Titre :
${title || research.topic}

À partir du dossier Research fourni ci-dessous, retourne un script
JSON MINIMAL permettant de tester le contrat technique.

Pour ce test uniquement :
- 2 sections ;
- ${narratedFrame ? "1 segment par section, hors hook et conclusion" : "1 segment par section"} ;
- estimated_duration_minutes doit rester entre ${profile.min} et ${profile.max} ;
- n'invente aucun fait.
${narratedFrame ? `\n${FRAME_REMINDER}\n` : ""}
DOSSIER RESEARCH :
${JSON.stringify(scriptFactualResearch(research))}
`.trim()
    : `
Rédige le script voix-off documentaire complet.

Titre :
${title || research.topic}

Le documentaire final doit durer entre ${profile.min} et ${profile.max} minutes.
${narratedFrame ? `\n${FRAME_REMINDER}\n` : ""}
Utilise exclusivement le dossier Research suivant.

DOSSIER RESEARCH :
${JSON.stringify(scriptFactualResearch(research))}
`.trim();

  const { response, meta } = await createMessage({
    system: buildSystemPrompt(profile, narratedFrame === true),
    messages: [
      {
        role: "user",
        content: userPrompt
      }
    ],
    maxTokens: testMode ? 2200 : 12000,
    temperature: 0.2
  });

  const text = extractText(response);

  if (meta.stop_reason === "max_tokens") {
    throw new Error(
      "Script Agent : réponse tronquée — stop_reason=max_tokens. " +
      `Tokens sortie=${meta.output_tokens ?? "inconnu"}.`
    );
  }

  const data = parseJson(text);

  const gateResult =
    await validateGeneratedScript(data, research, validationOptions);

  if (gateResult.protocol_outcome) {
    return {
      agent: "script",
      mode: testMode ? "test" : "full",
      protocol_outcome: gateResult.protocol_outcome,
      claim_coverage_validation: gateResult.claim_coverage_validation,
      usage: meta
    };
  }

  return {
    agent: "script",
    mode: testMode ? "test" : "full",
    data,
    ...gateResult,
    usage: meta
  };
}
