import {
  createMessage,
  extractText
} from "../services/anthropic.js";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  validateScriptDossier
} from "../utils/validate-script.js";

import {
  validateVisualDirectorDossier
} from "../utils/validate-visual-director.js";

import {
  validateVisualFactualGrounding
} from "../utils/validate-visual-factual-grounding.js";

import {
  repairVisualFactualGrounding
} from "../utils/repair-visual-factual-grounding.js";

import {
  discardCachedResponse
} from "../services/call-guard.js";

const SYSTEM_PROMPT = `
Tu es le Visual Director de la chaîne YouTube
"Les Découvertes du Nomade".

Tu transformes un script documentaire VALIDÉ en plan visuel
structuré destiné aux étapes suivantes de production.

Tu ne réécris PAS le script.

Tu décides comment illustrer visuellement chaque segment de voix-off.

RÈGLES ABSOLUES :

1. Le script fourni est ta seule base narrative et factuelle.

2. Tu ne fais aucune recherche web.

3. Tu n'inventes aucun fait, chiffre, lieu, événement,
   personne, institution ou détail absent du script.

4. Tu ne modifies jamais le voiceover.

5. Tu dois conserver exactement l'organisation du script :
   sections puis segments.

6. Chaque segment du script doit avoir une entrée correspondante
   dans ton plan visuel.

7. script_segment_index est l'index du segment à l'intérieur
   de sa section, en commençant à 0.

8. estimated_seconds doit être exactement la durée
   estimated_seconds du segment source.

9. Un segment peut et doit être découpé en plusieurs shots
   lorsque sa durée le nécessite.

10. Un shot représente une intention visuelle exploitable.

11. Chaque shot doit posséder :
    - order ;
    - duration_seconds ;
    - visual_description ;
    - asset_query ;
    - asset_type ;
    - requires_exact_location ;
    - research_fact_refs.

12. La somme des duration_seconds des shots d'un segment
    doit être égale à estimated_seconds du segment.

13. Les shots doivent être ordonnés à partir de 1.

14. Évite autant que possible les plans inutilement longs.
    Pour un documentaire faceless dynamique, privilégie généralement
    plusieurs plans courts plutôt qu'un seul plan couvrant tout
    un long segment.

15. visual_description décrit ce que le spectateur devrait voir.

16. asset_query est une requête concise et exploitable
    ultérieurement par un Asset Agent.

17. asset_query ne doit PAS inventer un lieu précis
    absent du script.

18. asset_query peut être en anglais lorsqu'une formulation anglaise
    facilite la recherche future de stock footage.

19. asset_type doit être exactement l'une de ces valeurs :

    "stock_video"
    "map"
    "graphic"
    "archive"
    "generated"

20. Utilise "stock_video" pour des images réelles génériques
    pouvant être recherchées dans une banque vidéo.

21. Utilise "map" lorsqu'une carte est la représentation
    la plus pertinente.

22. Utilise "graphic" pour une visualisation, un schéma,
    un chiffre ou une explication graphique.

23. Utilise "archive" uniquement lorsqu'un contenu historique
    ou documentaire d'archive est réellement justifié par le script.

24. Utilise "generated" lorsqu'un visuel généré est pertinent
    et qu'un plan réel n'est pas nécessaire.

25. requires_exact_location doit être true seulement lorsqu'il est
    important que le média montre réellement le lieu précis
    mentionné ou nécessaire dans le script.

26. Ne prétends jamais qu'une vidéo générique représente
    un lieu précis si cela n'est pas vérifié.

27. research_fact_refs doit uniquement reprendre des références
    présentes dans research_fact_refs du segment source.

28. N'ajoute jamais une research_fact_ref absente
    du segment source.

29. Si un shot est purement narratif ou atmosphérique et n'illustre
    directement aucun fait particulier, research_fact_refs peut
    être [].

30. Un visuel ne doit jamais introduire une affirmation factuelle
    nouvelle absente du script.

31. Le plan visuel doit être suffisamment précis pour que
    l'étape suivante puisse rechercher ou produire les assets
    sans devoir réinterpréter toute la narration.

32. Tu ne télécharges aucun asset.

33. Tu ne choisis aucune URL.

34. Tu ne prétends jamais qu'un asset existe.

35. Ta mission s'arrête à la création du PLAN VISUEL.

Réponds UNIQUEMENT avec un JSON valide.

Aucun Markdown.
Aucun texte avant ou après le JSON.

Structure obligatoire :

{
  "title": "",
  "sections": [
    {
      "title": "",
      "segments": [
        {
          "script_segment_index": 0,
          "estimated_seconds": 0,
          "shots": [
            {
              "order": 1,
              "duration_seconds": 0,
              "visual_description": "",
              "asset_query": "",
              "asset_type": "stock_video",
              "requires_exact_location": false,
              "research_fact_refs": []
            }
          ]
        }
      ]
    }
  ]
}
`.trim();

// R23-B — le plan public reste un unique visual.json, mais la génération
// full est découpée en lots de segments source. Chaque lot est vérifié puis
// persisté indépendamment pour qu'une reprise ne regénère jamais les lots
// précédemment valides.
const BATCH_SCHEMA = "visual-batch.v1";
const BATCH_DIRECTORY = "visual-batches";
const DEFAULT_BATCH_SIZE = 8;
const MAX_BATCH_SIZE = 16;

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const stableJson = value => JSON.stringify(value);

function atomicJson(file, data) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;

  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, file);
}

function resolveBatchSize(value = process.env.VISUAL_DIRECTOR_BATCH_SIZE) {
  if (value === undefined || value === "") return DEFAULT_BATCH_SIZE;

  const size = Number(value);

  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
    throw new Error(
      "Visual Director : VISUAL_DIRECTOR_BATCH_SIZE invalide " +
      `(entier 1 à ${MAX_BATCH_SIZE} attendu).`
    );
  }

  return size;
}

function batchFile(directory, index) {
  return path.join(directory, `batch-${String(index + 1).padStart(3, "0")}.json`);
}

function flattenScriptSegments(script) {
  return script.sections.flatMap((section, sectionIndex) =>
    section.segments.map((segment, segmentIndex) => ({
      section_index: sectionIndex,
      script_segment_index: segmentIndex,
      section_title: section.title,
      voiceover: segment.voiceover,
      estimated_seconds: segment.estimated_seconds,
      research_fact_refs: segment.research_fact_refs ?? [],
      claims: segment.claims ?? []
    }))
  );
}

function splitBatches(items, batchSize) {
  const batches = [];

  for (let start = 0; start < items.length; start += batchSize) {
    batches.push(items.slice(start, start + batchSize));
  }

  return batches;
}

function batchSystemPrompt() {
  return `${SYSTEM_PROMPT}

MODE LOT : tu ne génères qu'un sous-ensemble explicitement fourni de
segments source. Ne génère aucun autre segment. La structure de sortie de ce
mode remplace la structure globale ci-dessus :
{
  "segments": [
    {
      "section_index": 0,
      "script_segment_index": 0,
      "estimated_seconds": 0,
      "shots": []
    }
  ]
}
Chaque entrée doit correspondre une et une seule fois à un segment source du
lot. section_index et script_segment_index doivent être repris exactement.`;
}

function batchPrompt(batch, index, total) {
  return `
Construis le lot visuel ${index + 1}/${total}.

Traite exactement les segments source ci-dessous, dans cet ordre. Chaque
entrée doit produire des shots dont la somme des duration_seconds égale
exactement estimated_seconds. Ne modifie ni voiceover, ni références
factuelles ; n'utilise dans chaque shot que les research_fact_refs autorisées.

SEGMENTS SOURCE DU LOT :
${JSON.stringify(batch, null, 2)}
`.trim();
}

function parseJson(text) {
  if (!text?.trim()) {
    throw new Error(
      "Visual Director : réponse Anthropic vide."
    );
  }

  const raw = text.trim();

  const jsonFence =
    raw.match(/```json\s*([\s\S]*?)```/i);

  if (jsonFence?.[1]) {
    return JSON.parse(
      jsonFence[1].trim()
    );
  }

  const genericFence =
    raw.match(/```\s*([\s\S]*?)```/);

  if (genericFence?.[1]) {
    try {
      return JSON.parse(
        genericFence[1].trim()
      );
    } catch {
      // Continue.
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Continue.
  }

  const firstBrace =
    raw.indexOf("{");

  const lastBrace =
    raw.lastIndexOf("}");

  if (
    firstBrace !== -1 &&
    lastBrace > firstBrace
  ) {
    try {
      return JSON.parse(
        raw.slice(
          firstBrace,
          lastBrace + 1
        )
      );
    } catch (error) {
      throw new Error(
        "Visual Director : JSON invalide. " +
        error.message
      );
    }
  }

  throw new Error(
    "Visual Director : aucun objet JSON détecté."
  );
}

function validateScriptMapping(
  visualPlan,
  script
) {
  const errors = [];

  if (
    visualPlan.sections.length !==
    script.sections.length
  ) {
    errors.push(
      "nombre de sections différent du script"
    );

    return errors;
  }

  script.sections.forEach(
    (scriptSection, sectionIndex) => {
      const visualSection =
        visualPlan.sections[sectionIndex];

      if (!visualSection) {
        errors.push(
          `sections[${sectionIndex}] absente`
        );
        return;
      }

      if (
        visualSection.segments.length !==
        scriptSection.segments.length
      ) {
        errors.push(
          `sections[${sectionIndex}]: nombre de segments différent du script`
        );

        return;
      }

      scriptSection.segments.forEach(
        (scriptSegment, segmentIndex) => {
          const visualSegment =
            visualSection.segments[
              segmentIndex
            ];

          const label =
            `sections[${sectionIndex}].segments[${segmentIndex}]`;

          if (
            visualSegment.script_segment_index !==
            segmentIndex
          ) {
            errors.push(
              `${label}: script_segment_index ne correspond pas au script`
            );
          }

          if (
            visualSegment.estimated_seconds !==
            scriptSegment.estimated_seconds
          ) {
            errors.push(
              `${label}: estimated_seconds différent du script`
            );
          }

          const allowedRefs =
            new Set(
              scriptSegment
                .research_fact_refs ?? []
            );

          for (
            const shot of
            visualSegment.shots ?? []
          ) {
            for (
              const ref of
              shot.research_fact_refs ?? []
            ) {
              if (!allowedRefs.has(ref)) {
                errors.push(
                  `${label}: shot utilise research_fact_ref ${ref} absent du segment source`
                );
              }
            }
          }
        }
      );
    }
  );

  return errors;
}

function validateBatchSegments(response, batch) {
  const errors = [];
  const segments = response?.segments;

  if (!Array.isArray(segments)) {
    return ["segments doit être un tableau"];
  }

  const expected = new Map(
    batch.map(item => [
      `${item.section_index}:${item.script_segment_index}`,
      item
    ])
  );
  const seen = new Set();

  segments.forEach((segment, index) => {
    const label = `plans[${index}]`;
    const key = `${segment?.section_index}:${segment?.script_segment_index}`;
    const source = expected.get(key);

    if (!Number.isInteger(segment?.section_index) || segment.section_index < 0) {
      errors.push(`${label}: section_index invalide`);
    }

    if (
      !Number.isInteger(segment?.script_segment_index) ||
      segment.script_segment_index < 0
    ) {
      errors.push(`${label}: script_segment_index invalide`);
    }

    if (!source) {
      errors.push(`${label}: plan inconnu (${key})`);
      return;
    }

    if (seen.has(key)) {
      errors.push(`${label}: plan dupliqué (${key})`);
      return;
    }

    seen.add(key);

    if (segment.estimated_seconds !== source.estimated_seconds) {
      errors.push(
        `${label}: estimated_seconds différent de sections[` +
        `${source.section_index}].segments[${source.script_segment_index}]`
      );
    }

    const allowedRefs = new Set(source.research_fact_refs);

    for (const shot of segment.shots ?? []) {
      for (const ref of shot.research_fact_refs ?? []) {
        if (!allowedRefs.has(ref)) {
          errors.push(`${label}: research_fact_ref ${ref} non autorisé`);
        }
      }
    }
  });

  for (const key of expected.keys()) {
    if (!seen.has(key)) errors.push(`plan manquant (${key})`);
  }

  const structural = validateVisualDirectorDossier({
    title: "lot visuel",
    sections: [{
      title: "lot",
      segments: segments.map((segment, index) => ({
        ...segment,
        script_segment_index: index
      }))
    }]
  });

  if (!structural.valid) {
    errors.push(...structural.errors.map(error => `structure : ${error}`));
  }

  return errors;
}

function readBatchCheckpoint({ directory, index, total, planHash, batch }) {
  const file = batchFile(directory, index);

  if (!fs.existsSync(file)) return null;

  try {
    const checkpoint = JSON.parse(fs.readFileSync(file, "utf8"));
    const batchHash = sha256(stableJson(batch));

    if (
      checkpoint?.schema !== BATCH_SCHEMA ||
      checkpoint.plan_sha256 !== planHash ||
      checkpoint.batch_sha256 !== batchHash ||
      checkpoint.index !== index + 1 ||
      checkpoint.total !== total ||
      !checkpoint.usage || typeof checkpoint.usage !== "object" ||
      validateBatchSegments(checkpoint, batch).length > 0
    ) return null;

    return checkpoint;
  } catch {
    return null;
  }
}

function assembleBatches(script, checkpoints) {
  const bySource = new Map();

  for (const checkpoint of checkpoints) {
    for (const segment of checkpoint.segments) {
      const key = `${segment.section_index}:${segment.script_segment_index}`;

      bySource.set(key, {
        script_segment_index: segment.script_segment_index,
        estimated_seconds: segment.estimated_seconds,
        shots: segment.shots
      });
    }
  }

  return {
    title: script.title,
    sections: script.sections.map((section, sectionIndex) => ({
      title: section.title,
      segments: section.segments.map((_, segmentIndex) => {
        const key = `${sectionIndex}:${segmentIndex}`;
        const visualSegment = bySource.get(key);

        if (!visualSegment) {
          throw new Error(
            `Visual Director : plan manquant pour sections[${sectionIndex}].segments[${segmentIndex}].`
          );
        }

        return visualSegment;
      })
    }))
  };
}

// Grounding factuel d'une liste de plans (un appel par plan, réparation et
// recontrôle si nécessaire) : logique historique, extraite pour être appliquée
// à un lot avant l'écriture de son checkpoint (R23-D). Les plans sont modifiés
// en place par la réparation. entries : [{ label, shot, scriptClaims }].
async function groundShots(entries) {
  const result = {
    valid: true,
    errors: [],
    shots: []
  };

  for (const { label, shot, scriptClaims } of entries) {
    const shotRefs =
      new Set(
        shot.research_fact_refs ?? []
      );

    const claims =
      (scriptClaims ?? [])
        .filter(
          claim =>
            shotRefs.has(
              claim.research_fact_ref
            )
        )
        .map(claim => claim.text)
        .filter(
          text =>
            typeof text === "string" &&
            text.trim().length > 0
        );

    const initialGrounding =
      await validateVisualFactualGrounding({
        visualDescription:
          shot.visual_description,
        assetQuery:
          shot.asset_query,
        claims
      });

    let finalGrounding = initialGrounding;
    let repair = null;

    if (!initialGrounding.grounded) {
      repair =
        await repairVisualFactualGrounding({
          shot,
          claims,
          unsupportedVisualClaims:
            initialGrounding
              .unsupported_visual_claims
        });

      shot.visual_description =
        repair.visual_description;

      shot.asset_query =
        repair.asset_query;

      finalGrounding =
        await validateVisualFactualGrounding({
          visualDescription:
            shot.visual_description,
          assetQuery:
            shot.asset_query,
          claims
        });
    }

    result.shots.push({
      label,
      grounded: finalGrounding.grounded,
      repaired: repair !== null,
      initial_unsupported_visual_claims:
        initialGrounding
          .unsupported_visual_claims,
      unsupported_visual_claims:
        finalGrounding
          .unsupported_visual_claims,
      initial_usage:
        initialGrounding.usage,
      repair_usage:
        repair?.usage ?? null,
      usage:
        finalGrounding.usage
    });

    if (!finalGrounding.grounded) {
      result.valid = false;

      const unsupported =
        finalGrounding
          .unsupported_visual_claims
          .map(
            item =>
              `[${item.field}] ${item.text}` +
              (
                item.reason
                  ? ` — ${item.reason}`
                  : ""
              )
          )
          .join(" || ");

      result.errors.push(
        `${label}: affirmations visuelles factuelles non couvertes après réparation` +
        (
          unsupported
            ? ` — ${unsupported}`
            : ""
        )
      );
    }
  }

  return result;
}

// Plans d'un lot, avec les claims de leur segment source.
function batchGroundingEntries(segments, batch) {
  const sources = new Map(batch.map(item => [`${item.section_index}:${item.script_segment_index}`, item]));

  return segments.flatMap(segment =>
    (segment.shots ?? []).map((shot, shotIndex) => ({
      label: `sections[${segment.section_index}].segments[${segment.script_segment_index}].shots[${shotIndex}]`,
      shot,
      scriptClaims: sources.get(`${segment.section_index}:${segment.script_segment_index}`)?.claims ?? []
    }))
  );
}

// Grounding complet d'un lot déjà vérifié structurellement, avant toute
// écriture. Lève sans rien écrire si un plan reste non ancré.
async function groundBatch({ segments, batch, index, total }) {
  const grounding = await groundShots(batchGroundingEntries(segments, batch));

  if (!grounding.valid) {
    throw new Error(
      `Visual Director : lot ${index + 1}/${total} rejeté par le Visual Factual Grounding Gate. ` +
      grounding.errors.join(" | ")
    );
  }

  return grounding.shots;
}

const groundingComplete = checkpoint =>
  Array.isArray(checkpoint.factual_grounding?.shots) &&
  checkpoint.factual_grounding.shots.length === checkpoint.segments.reduce((n, segment) => n + (segment.shots?.length ?? 0), 0) &&
  checkpoint.factual_grounding.shots.every(shot => shot?.grounded === true);

// R23-D — un checkpoint mis en cause par un gate du plan complet est déplacé
// (jamais supprimé) dans rejected/ ; sa réponse en cache est écartée.
function quarantineBatch(directory, index) {
  const file = batchFile(directory, index);

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

async function generateBatchedVisualPlan({
  script,
  productionDir,
  batchSize
}) {
  const entries = flattenScriptSegments(script);
  const batches = splitBatches(entries, batchSize);
  const directory = path.join(productionDir, BATCH_DIRECTORY);
  const planHash = sha256(stableJson({
    schema: BATCH_SCHEMA,
    script,
    batch_size: batchSize
  }));

  fs.mkdirSync(directory, { recursive: true });

  const checkpoints = [];
  let generated = 0;
  let reused = 0;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    let checkpoint = readBatchCheckpoint({
      directory,
      index,
      total: batches.length,
      planHash,
      batch
    });

    if (checkpoint && !groundingComplete(checkpoint)) {
      // Checkpoint antérieur au grounding par lot : ancré maintenant, puis
      // réécrit seulement s'il passe ; sinon écarté.
      try {
        checkpoint.factual_grounding = {
          shots: await groundBatch({ segments: checkpoint.segments, batch, index, total: batches.length })
        };
      } catch (error) {
        quarantineBatch(directory, index);
        throw error;
      }

      atomicJson(batchFile(directory, index), checkpoint);
    }

    if (checkpoint) {
      reused += 1;
    } else {
      const { response, meta, request_sha256: requestHash } = await createMessage({
        system: batchSystemPrompt(),
        messages: [{
          role: "user",
          content: batchPrompt(batch, index, batches.length)
        }],
        maxTokens: 9000,
        temperature: 0.2
      });

      // R23-D : rien n'est écrit tant que le lot n'a pas passé JSON,
      // structure, validations et grounding ; une réponse rejetée est
      // écartée du cache pour que la reprise refasse l'appel.
      let responseData;
      let factualGrounding;

      try {
        if (meta.stop_reason === "max_tokens") {
          throw new Error(
            "Visual Director : lot " +
            `${index + 1}/${batches.length} tronqué — stop_reason=max_tokens. ` +
            `Tokens sortie=${meta.output_tokens ?? "inconnu"}.`
          );
        }

        responseData = parseJson(extractText(response));
        const errors = validateBatchSegments(responseData, batch);

        if (errors.length > 0) {
          throw new Error(
            `Visual Director : lot ${index + 1}/${batches.length} rejeté. ` +
            errors.join(" | ")
          );
        }

        factualGrounding = {
          shots: await groundBatch({ segments: responseData.segments, batch, index, total: batches.length })
        };
      } catch (error) {
        discardCachedResponse(requestHash);
        throw error;
      }

      checkpoint = {
        schema: BATCH_SCHEMA,
        plan_sha256: planHash,
        batch_sha256: sha256(stableJson(batch)),
        index: index + 1,
        total: batches.length,
        segments: responseData.segments,
        factual_grounding: factualGrounding,
        usage: meta,
        ...(requestHash ? { request_sha256: requestHash } : {}),
        created_at: new Date().toISOString()
      };

      atomicJson(batchFile(directory, index), checkpoint);
      generated += 1;
    }

    checkpoints.push(checkpoint);
  }

  const usage = checkpoints.reduce((total, checkpoint) => ({
    input_tokens: total.input_tokens + (checkpoint.usage.input_tokens ?? 0),
    output_tokens: total.output_tokens + (checkpoint.usage.output_tokens ?? 0),
    duration_ms: total.duration_ms + (checkpoint.usage.duration_ms ?? 0)
  }), { input_tokens: 0, output_tokens: 0, duration_ms: 0 });

  return {
    data: assembleBatches(script, checkpoints),
    factual_grounding_shots: checkpoints.flatMap(checkpoint => checkpoint.factual_grounding.shots),
    batch_of: new Map(batches.flatMap((batch, index) => batch.map(item => [`${item.section_index}:${item.script_segment_index}`, index]))),
    checkpoint_directory: directory,
    usage: {
      ...usage,
      model: "batched-visual-director",
      stop_reason: "end_turn",
      calls: generated,
      reused_batches: reused
    },
    storyboard_generation: {
      mode: "batched",
      batch_size: batchSize,
      total_batches: batches.length,
      generated_batches: generated,
      reused_batches: reused,
      checkpoint_directory: BATCH_DIRECTORY,
      plan_sha256: planHash
    }
  };
}

export async function runVisualDirector({
  script,
  testMode = false,
  durationProfile,
  productionDir,
  batchSize
}) {
  const scriptValidation =
    validateScriptDossier(script, {
      durationRange: durationProfile
        ? { min: durationProfile.min, max: durationProfile.max }
        : undefined
    });

  if (!scriptValidation.valid) {
    throw new Error(
      "Visual Director : Script source invalide. " +
      scriptValidation.errors.join(" | ")
    );
  }

  let data;
  let usage;
  let storyboardGeneration;
  let batched = null;

  if (!testMode && productionDir) {
    const result = await generateBatchedVisualPlan({
      script,
      productionDir,
      batchSize: resolveBatchSize(batchSize)
    });

    data = result.data;
    usage = result.usage;
    storyboardGeneration = result.storyboard_generation;
    batched = result;
  } else {
    const userPrompt = `
SCRIPT SOURCE VALIDE :

${JSON.stringify(script, null, 2)}

Construis le plan visuel complet correspondant.

Ne modifie aucune information du script.

Chaque segment source doit être représenté.

Respecte exactement ses estimated_seconds.

N'utilise dans les shots que les research_fact_refs
déjà présentes dans le segment source.
`.trim();

    const {
      response,
      meta
    } = await createMessage({
      system: SYSTEM_PROMPT,

      messages: [
        {
          role: "user",
          content: userPrompt
        }
      ],

      maxTokens:
        testMode ? 3500 : 12000,

      temperature: 0.2
    });

    if (
      meta.stop_reason ===
      "max_tokens"
    ) {
      throw new Error(
        "Visual Director : réponse tronquée — stop_reason=max_tokens. " +
        `Tokens sortie=${meta.output_tokens ?? "inconnu"}.`
      );
    }

    data = parseJson(
      extractText(response)
    );

    usage = meta;
  }

  let validation;

  try {
    validation =
      validateVisualDirectorDossier(
        data
      );

    if (!validation.valid) {
      throw new Error(
        "Visual Director : dossier rejeté par le Visual Gate. " +
        validation.errors.join(" | ")
      );
    }

    const mappingErrors =
      validateScriptMapping(
        data,
        script
      );

    if (mappingErrors.length > 0) {
      throw new Error(
        "Visual Director : mapping Script invalide. " +
        mappingErrors.join(" | ")
      );
    }
  } catch (error) {
    // R23-D : en mode par lots, les lots désignés par le gate sont écartés
    // (checkpoint et réponse en cache) ; la reprise les régénère.
    if (batched) {
      const blamed = new Set(
        [...String(error?.message ?? "").matchAll(/sections\[(\d+)\]\.segments\[(\d+)\]/g)]
          .map(m => batched.batch_of.get(`${m[1]}:${m[2]}`))
          .filter(index => index !== undefined)
      );

      for (const index of blamed) quarantineBatch(batched.checkpoint_directory, index);
    }

    throw error;
  }

  // Grounding : déjà fait lot par lot avant l'écriture des checkpoints en
  // mode par lots (R23-D) ; sinon, logique historique sur le plan complet.
  const factualGroundingValidation = batched
    ? { valid: true, errors: [], shots: batched.factual_grounding_shots }
    : await groundShots(
      data.sections.flatMap((visualSection, sectionIndex) =>
        visualSection.segments.flatMap((visualSegment, segmentIndex) =>
          visualSegment.shots.map((shot, shotIndex) => ({
            label: `sections[${sectionIndex}].segments[${segmentIndex}].shots[${shotIndex}]`,
            shot,
            scriptClaims: script.sections[sectionIndex].segments[segmentIndex].claims ?? []
          }))
        )
      )
    );

  if (!factualGroundingValidation.valid) {
    throw new Error(
      "Visual Director : dossier rejeté par le Visual Factual Grounding Gate. " +
      factualGroundingValidation.errors.join(" | ")
    );
  }

  return {
    agent: "visual_director",
    mode:
      testMode ? "test" : "full",
    data,
    validation,
    script_mapping_validation: {
      valid: true,
      errors: []
    },
    factual_grounding_validation:
      factualGroundingValidation,
    usage,
    ...(storyboardGeneration
      ? { storyboard_generation: storyboardGeneration }
      : {})
  };
}
