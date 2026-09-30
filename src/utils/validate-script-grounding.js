const STOP_WORDS = new Set([
  "alors", "avec", "avoir", "cette", "comme", "dans", "des",
  "elle", "elles", "entre", "être", "fait", "faire", "leur",
  "leurs", "mais", "nous", "pour", "plus", "sans", "ses",
  "sont", "sur", "une", "vous", "aux", "ces", "cet", "qui",
  "que", "quoi", "dont", "est", "les", "par", "pas", "son",
  "tout", "tous", "très", "ainsi", "donc", "vers", "reste",
  "reste", "aussi", "même", "peut", "peuvent", "pays"
]);

function normalize(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulWords(text) {
  return [
    ...new Set(
      normalize(text)
        .split(/\s+/)
        .filter(word =>
          word.length >= 4 &&
          !STOP_WORDS.has(word)
        )
    )
  ];
}

function lexicalCoverage(voiceover, claims) {
  const voiceWords = meaningfulWords(voiceover);

  if (voiceWords.length === 0) {
    return {
      coverage: 0,
      matched_words: [],
      voice_words: []
    };
  }

  const claimWords = new Set(
    claims.flatMap(claim => meaningfulWords(claim))
  );

  const matched = voiceWords.filter(
    word => claimWords.has(word)
  );

  return {
    coverage: matched.length / voiceWords.length,
    matched_words: matched,
    voice_words: voiceWords
  };
}

export function validateScriptGrounding(script, research, {
  minimumLexicalCoverage = 0.12
} = {}) {
  const errors = [];
  const warnings = [];
  const segments = [];

  if (!script || typeof script !== "object") {
    return {
      valid: false,
      errors: ["Script absent ou invalide"],
      warnings,
      segments
    };
  }

  if (!research || !Array.isArray(research.key_facts)) {
    return {
      valid: false,
      errors: ["Research key_facts absent ou invalide"],
      warnings,
      segments
    };
  }

  if (!Array.isArray(script.sections)) {
    return {
      valid: false,
      errors: ["Script sections absent ou invalide"],
      warnings,
      segments
    };
  }

  script.sections.forEach((section, sectionIndex) => {
    if (!Array.isArray(section?.segments)) {
      errors.push(
        `sections[${sectionIndex}]: segments absent ou invalide`
      );
      return;
    }

    section.segments.forEach((segment, segmentIndex) => {
      const label =
        `sections[${sectionIndex}].segments[${segmentIndex}]`;

      const refs = Array.isArray(segment?.research_fact_refs)
        ? segment.research_fact_refs
        : [];

      if (refs.length === 0) {
        errors.push(
          `${label}: aucun research_fact_ref`
        );

        segments.push({
          label,
          grounded: false,
          reason: "NO_RESEARCH_REFERENCE",
          coverage: 0
        });

        return;
      }

      const facts = [];

      for (const ref of refs) {
        if (
          !Number.isInteger(ref) ||
          ref < 0 ||
          ref >= research.key_facts.length
        ) {
          errors.push(
            `${label}: research_fact_ref ${ref} hors limites`
          );
          continue;
        }

        facts.push(research.key_facts[ref]);
      }

      if (facts.length === 0) {
        segments.push({
          label,
          grounded: false,
          reason: "NO_USABLE_FACT",
          coverage: 0
        });

        return;
      }

      const nonVerified = facts.filter(
        fact => fact.verification_status !== "verified"
      );

      if (
        nonVerified.length > 0 &&
        segment?.contains_unverified_claim !== true
      ) {
        errors.push(
          `${label}: fait non vérifié utilisé sans signalement`
        );
      }

      const claims = facts
        .map(fact => fact.claim)
        .filter(Boolean);

      const lexical = lexicalCoverage(
        segment?.voiceover,
        claims
      );

      const grounded =
        lexical.coverage >= minimumLexicalCoverage;

      segments.push({
        label,
        grounded,
        coverage: Number(
          lexical.coverage.toFixed(3)
        ),
        matched_words: lexical.matched_words,
        research_fact_refs: refs
      });

      if (!grounded) {
        errors.push(
          `${label}: couverture Research insuffisante ` +
          `(${(lexical.coverage * 100).toFixed(1)}% < ` +
          `${(minimumLexicalCoverage * 100).toFixed(1)}%)`
        );
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    segments
  };
}
