function getClaimsForShot(
  scriptSegment,
  shot
) {
  const shotRefs =
    new Set(
      shot.research_fact_refs ?? []
    );

  return (scriptSegment.claims ?? [])
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
}

const scriptSegment = {
  claims: [
    {
      text: "CLAIM ZERO",
      research_fact_ref: 0
    },
    {
      text: "CLAIM UN",
      research_fact_ref: 1
    },
    {
      text: "CLAIM DEUX",
      research_fact_ref: 2
    },
    {
      text: "CLAIM ZERO BIS",
      research_fact_ref: 0
    }
  ]
};

const cases = [
  {
    name: "shot ref 0",
    shot: {
      research_fact_refs: [0]
    },
    expected: [
      "CLAIM ZERO",
      "CLAIM ZERO BIS"
    ]
  },
  {
    name: "shot ref 1",
    shot: {
      research_fact_refs: [1]
    },
    expected: [
      "CLAIM UN"
    ]
  },
  {
    name: "shot refs 0 + 2",
    shot: {
      research_fact_refs: [0, 2]
    },
    expected: [
      "CLAIM ZERO",
      "CLAIM DEUX",
      "CLAIM ZERO BIS"
    ]
  },
  {
    name: "shot atmospherique refs vides",
    shot: {
      research_fact_refs: []
    },
    expected: []
  }
];

let failed = false;

for (const test of cases) {
  const actual =
    getClaimsForShot(
      scriptSegment,
      test.shot
    );

  const pass =
    JSON.stringify(actual) ===
    JSON.stringify(test.expected);

  console.log("");
  console.log(
    "CAS :",
    test.name
  );

  console.log(
    "Refs :",
    JSON.stringify(
      test.shot.research_fact_refs
    )
  );

  console.log(
    "Claims transmis :",
    JSON.stringify(actual)
  );

  console.log(
    "Attendu :",
    JSON.stringify(test.expected)
  );

  console.log(
    pass
      ? "RESULTAT : PASS"
      : "RESULTAT : FAIL"
  );

  if (!pass) {
    failed = true;
  }
}

console.log("");
console.log(
  "========================================"
);

if (failed) {
  console.error(
    "RESULTAT GLOBAL : FAIL — scoping claims incorrect"
  );

  process.exit(1);
}

console.log(
  "RESULTAT GLOBAL : PASS — claims correctement scopes par shot"
);

console.log(
  "PASS — refs [0] n'autorisent que les claims ref 0"
);

console.log(
  "PASS — refs [1] n'autorisent que les claims ref 1"
);

console.log(
  "PASS — refs multiples composent correctement la frontière"
);

console.log(
  "PASS — refs [] transmet exactement zero claim"
);

process.exit(0);
