// Smoke de la garde des appels réels (R13) — zéro API.
//
// Usage :
//   NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/call-guard-smoke.js
//
// Partie 1 : la garde est testée en mémoire, avec un SDK mocké et une
// clé factice. Partie 2 : la porte du mode complet est testée dans des
// processus enfants, sans clé réelle, sous garde réseau. Aucun appel
// réel n'est possible : le SDK est mocké ou bloqué par le garde réseau.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import {
  buildMessageRequest,
  createMessage,
  previewMessageCost
} from "../src/services/anthropic.js";

import {
  HARD_CEILING,
  REAL_CALLS_ACK_ENV,
  JOURNAL_FILE,
  CACHE_DIR,
  parseRealCallsCap,
  configureCallGuard,
  resetCallGuard,
  getCallGuardStatus,
  requestSha256,
  redactSecrets,
  setCacheBypass,
  isRequestCached
} from "../src/services/call-guard.js";

import { runResearchAgent } from "../src/agents/research.js";

import {
  CANONICAL_TITLE,
  CANONICAL_PROMPT
} from "../src/fixtures/anthropic-dataset.js";

const networkGuard = globalThis.__fixtureNetworkGuard;

if (process.env.NO_API !== "1" || !networkGuard) {
  console.error(
    "FAIL — ce smoke doit être lancé avec NO_API=1 et le garde réseau " +
    "(node --import ./scripts/fixture-network-guard.js)."
  );
  process.exit(1);
}

// Aucune clé réelle n'est nécessaire : elle est retirée du processus.
delete process.env.ANTHROPIC_API_KEY;

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PROJECTS = path.join(ROOT, "projects");
const GUARD = path.join(ROOT, "scripts", "fixture-network-guard.js");

// Clé entièrement factice, en mémoire uniquement.
const DUMMY_KEY = "x".repeat(60);

const META_KEYS = [
  "duration_ms",
  "input_tokens",
  "model",
  "output_tokens",
  "stop_reason"
];

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS — ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL — ${name}`);
    console.error(`       ${error?.message ?? error}`);
  }
}

async function expectReject(fn, pattern) {
  let error = null;

  try {
    await fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "une erreur était attendue, aucune n'a été levée");
  assert(
    pattern.test(error.message),
    `erreur inattendue : ${error.message}`
  );

  return error;
}

function expectThrow(fn, pattern) {
  let error = null;

  try {
    fn();
  } catch (caught) {
    error = caught;
  }

  assert(error, "une erreur était attendue, aucune n'a été levée");
  assert(
    pattern.test(error.message),
    `erreur inattendue : ${error.message}`
  );
}

async function withEnv(overrides, fn) {
  const previous = {};

  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const tempDirs = [];

function makeDir() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "call-guard-smoke-")
  );

  tempDirs.push(directory);

  return directory;
}

function okResponse(text) {
  return {
    id: "msg_mock",
    model: "mock-model",
    content: [{ type: "text", text }],
    usage: { input_tokens: 3, output_tokens: 2 },
    stop_reason: "end_turn"
  };
}

// SDK mocké en mémoire : compte les appels reçus.
function mockSdk(handler) {
  const calls = [];

  Anthropic.Messages.prototype.create = async function (request) {
    calls.push(request);
    return handler(request, calls.length);
  };

  return calls;
}

function restoreSdk() {
  Anthropic.Messages.prototype.create = networkGuard.sdkMessagesCreate;
}

function ask(text) {
  return createMessage({
    system: "Système de test",
    messages: [{ role: "user", content: text }],
    maxTokens: 10,
    temperature: 0
  });
}

const REAL_ENV = {
  ANTHROPIC_FIXTURES: undefined,
  NO_API: undefined,
  PIPELINE_REAL_CALLS_ACK: "1",
  ANTHROPIC_API_KEY: DUMMY_KEY
};

// Exécute fn avec une garde configurée sur un dossier neuf.
async function withGuard({ cap = 5, handler }, fn) {
  const directory = makeDir();

  return withEnv(REAL_ENV, async () => {
    const calls = mockSdk(handler ?? (() => okResponse("réponse")));

    try {
      configureCallGuard({ productionDir: directory, cap });
      return await fn({ directory, calls });
    } finally {
      resetCallGuard();
      restoreSdk();
    }
  });
}

function readJournal(directory) {
  return JSON.parse(
    fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8")
  );
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name));
}

console.log("--- 1. Constantes et plafond ---");

await test("plafond dur = 500, sans valeur par défaut", () => {
  assert(HARD_CEILING === 500, `HARD_CEILING = ${HARD_CEILING}`);
  expectThrow(() => parseRealCallsCap(undefined), /obligatoire/);
  expectThrow(() => parseRealCallsCap(null), /obligatoire/);
  expectThrow(() => parseRealCallsCap(""), /obligatoire/);
});

await test("plafond : entiers 1..500 admis, tout le reste refusé", () => {
  assert(parseRealCallsCap("1") === 1, "1");
  assert(parseRealCallsCap("500") === 500, "500");
  assert(parseRealCallsCap(12) === 12, "12 numérique");

  for (const bad of [
    "0", "-1", "501", "abc", "1.5", "1e2", "07", "0x10", " ", "1 2",
    "99999999999999999999"
  ]) {
    expectThrow(() => parseRealCallsCap(bad), /Appels réels/);
  }
});

await test("empreinte : indépendante de l'ordre des clés, sensible au contenu", () => {
  assert(
    requestSha256({ a: 1, b: { c: [1, 2], d: 3 } }) ===
      requestSha256({ b: { d: 3, c: [1, 2] }, a: 1 }),
    "ordre des clés"
  );
  assert(
    requestSha256({ a: 1 }) !== requestSha256({ a: 2 }),
    "contenu"
  );
  assert(/^[0-9a-f]{64}$/.test(requestSha256({})), "format");
});

await test("redactSecrets masque les clés connues et les motifs sk-…", () => {
  return withEnv({ ANTHROPIC_API_KEY: DUMMY_KEY }, () => {
    const text = redactSecrets(`clé ${DUMMY_KEY} et sk-ant-abcdef123456`);
    assert(!text.includes(DUMMY_KEY), "clé d'environnement");
    assert(!text.includes("sk-ant-abcdef123456"), "motif sk-");
  });
});

console.log("");
console.log("--- 2. Autorisation (fail-closed) ---");

await test("configure : NO_API=1 prime, même avec accusé et plafond valides", async () => {
  const directory = makeDir();

  await withEnv(
    { NO_API: "1", [REAL_CALLS_ACK_ENV]: "1" },
    () => expectThrow(
      () => configureCallGuard({ productionDir: directory, cap: 3 }),
      /NO_API=1/
    )
  );

  assert(!getCallGuardStatus().configured, "garde configurée malgré NO_API");
});

await test("configure : accusé d'environnement absent ou différent de 1 → refus", async () => {
  const directory = makeDir();

  for (const ack of [undefined, "0", "true", "yes", ""]) {
    await withEnv(
      { NO_API: undefined, [REAL_CALLS_ACK_ENV]: ack },
      () => expectThrow(
        () => configureCallGuard({ productionDir: directory, cap: 3 }),
        new RegExp(REAL_CALLS_ACK_ENV)
      )
    );
  }
});

await test("configure : plafond absent ou invalide → refus", async () => {
  const directory = makeDir();

  for (const cap of [undefined, 0, -3, 501, "abc", 1.5]) {
    await withEnv(
      { NO_API: undefined, [REAL_CALLS_ACK_ENV]: "1" },
      () => expectThrow(
        () => configureCallGuard({ productionDir: directory, cap }),
        /Appels réels/
      )
    );
  }
});

await test("configure : dossier de production introuvable → refus", async () => {
  await withEnv(
    { NO_API: undefined, [REAL_CALLS_ACK_ENV]: "1" },
    () => expectThrow(
      () => configureCallGuard({
        productionDir: path.join(os.tmpdir(), "call-guard-inexistant-xyz"),
        cap: 2
      }),
      /introuvable/
    )
  );
});

await test("garde non configurée : un appel réel est refusé, SDK jamais atteint", async () => {
  await withEnv(REAL_ENV, async () => {
    const calls = mockSdk(() => okResponse("ne doit jamais partir"));

    try {
      await expectReject(() => ask("bonjour"), /non autorisé/);
      assert(calls.length === 0, `${calls.length} appel(s) SDK`);
    } finally {
      restoreSdk();
    }
  });
});

await test("NO_API=1 prime après configuration, cache compris", async () => {
  await withGuard({ cap: 3 }, async ({ calls }) => {
    await ask("requête A");

    assert(calls.length === 1, "premier appel");

    await withEnv({ NO_API: "1" }, async () => {
      await expectReject(() => ask("requête A"), /NO_API=1/);
      await expectReject(() => ask("requête B"), /NO_API=1/);
    });

    assert(calls.length === 1, "aucun appel supplémentaire sous NO_API=1");
  });
});

await test("accusé retiré après configuration → appel refusé", async () => {
  await withGuard({ cap: 3 }, async ({ calls }) => {
    await withEnv({ [REAL_CALLS_ACK_ENV]: undefined }, () =>
      expectReject(() => ask("requête"), new RegExp(REAL_CALLS_ACK_ENV))
    );

    assert(calls.length === 0, "SDK atteint");
  });
});

console.log("");
console.log("--- 3. Journal, compteur, plafond ---");

await test("journal écrit AVANT l'envoi, puis clos ; cache et compteur exacts", async () => {
  let seenDuringCall = null;
  const directory = makeDir();

  await withEnv(REAL_ENV, async () => {
    const calls = mockSdk(() => {
      const journal = readJournal(directory);

      seenDuringCall = journal.entries.map(entry => entry.status);

      return okResponse("réponse mock");
    });

    try {
      configureCallGuard({ productionDir: directory, cap: 4 });

      const { response, meta } = await ask("première requête");

      assert(calls.length === 1, "un appel SDK");
      assert(
        JSON.stringify(seenDuringCall) === '["started"]',
        `journal pendant l'appel : ${seenDuringCall}`
      );
      assert(response.content[0].text === "réponse mock", "réponse");
      assert(
        JSON.stringify(Object.keys(meta).sort()) ===
          JSON.stringify(META_KEYS),
        `meta : ${Object.keys(meta)}`
      );

      const journal = readJournal(directory);
      const entry = journal.entries[0];

      assert(journal.schema === 1 && journal.entries.length === 1, "journal");
      assert(entry.status === "succeeded", `statut ${entry.status}`);
      assert(/^c0001-[0-9a-f]{12}$/.test(entry.call_id), entry.call_id);
      assert(entry.input_tokens === 3 && entry.output_tokens === 2, "tokens");
      assert(entry.ended_at !== null, "ended_at");
      assert(
        fs.existsSync(
          path.join(directory, CACHE_DIR, `${entry.request_sha256}.json`)
        ),
        "cache absent"
      );
      assert(
        getCallGuardStatus().used === 1 &&
        getCallGuardStatus().cap === 4,
        JSON.stringify(getCallGuardStatus())
      );
    } finally {
      resetCallGuard();
      restoreSdk();
    }
  });
});

await test("requête identique : servie par le cache, sans appel SDK ni compteur", async () => {
  await withGuard({ cap: 2 }, async ({ directory, calls }) => {
    const first = await ask("même requête");
    const second = await ask("même requête");
    const third = await ask("même requête");

    assert(calls.length === 1, `${calls.length} appel(s) SDK`);
    assert(
      JSON.stringify(second.response) === JSON.stringify(first.response) &&
      JSON.stringify(third.response) === JSON.stringify(first.response),
      "réponse différente"
    );
    assert(second.meta.duration_ms === 0, "duration_ms du cache");
    assert(
      JSON.stringify(Object.keys(second.meta).sort()) ===
        JSON.stringify(META_KEYS),
      "clés meta"
    );

    const status = getCallGuardStatus();

    assert(status.used === 1 && status.cache_hits === 2, JSON.stringify(status));

    const statuses = readJournal(directory).entries.map(e => e.status);

    assert(
      JSON.stringify(statuses) ===
        '["succeeded","cache_hit","cache_hit"]',
      statuses.join(",")
    );
  });
});

await test("plafond : l'appel N+1 est refusé, SDK jamais atteint, rien n'est journalisé", async () => {
  await withGuard({ cap: 2 }, async ({ directory, calls }) => {
    await ask("requête 1");
    await ask("requête 2");

    const before = fs.readFileSync(
      path.join(directory, JOURNAL_FILE),
      "utf8"
    );

    await expectReject(() => ask("requête 3"), /Plafond d'appels réels atteint \(2\)/);

    assert(calls.length === 2, `${calls.length} appel(s) SDK`);
    assert(getCallGuardStatus().used === 2, "compteur");
    assert(
      fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8") === before,
      "journal modifié par un refus"
    );
  });
});

await test("appel échoué : compté, journalisé failed, erreur expurgée, pas de cache", async () => {
  await withGuard({
    cap: 3,
    handler: () => {
      throw Object.assign(
        new Error(`échec ${DUMMY_KEY} sk-ant-abcdef123456`),
        { status: 500 }
      );
    }
  }, async ({ directory, calls }) => {
    await expectReject(() => ask("requête qui échoue"), /Erreur Anthropic HTTP 500/);

    assert(calls.length === 1, "un seul appel, aucun retry automatique");
    assert(getCallGuardStatus().used === 1, "l'échec doit être compté");

    const entry = readJournal(directory).entries[0];

    assert(entry.status === "failed", entry.status);
    assert(
      !entry.error.includes(DUMMY_KEY) &&
      !entry.error.includes("sk-ant-abcdef123456") &&
      entry.error.includes("[REDACTED]"),
      `erreur non expurgée : ${entry.error}`
    );
    assert(
      !fs.existsSync(path.join(directory, CACHE_DIR)),
      "cache écrit pour un échec"
    );
  });
});

await test("compteur atomique : 6 requêtes concurrentes, plafond 3 → exactement 3 appels", async () => {
  await withGuard({
    cap: 3,
    handler: () => new Promise(resolve =>
      setTimeout(() => resolve(okResponse("ok")), 5)
    )
  }, async ({ calls }) => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5, 6].map(index => ask(`requête ${index}`))
    );

    const ok = results.filter(r => r.status === "fulfilled").length;
    const refused = results.filter(
      r => r.status === "rejected" && /Plafond/.test(r.reason.message)
    ).length;

    assert(ok === 3 && refused === 3, `ok=${ok} refusés=${refused}`);
    assert(calls.length === 3, `${calls.length} appel(s) SDK`);
    assert(getCallGuardStatus().used === 3, "compteur");
  });
});

await test("double appel : deux requêtes identiques concurrentes → un seul envoi", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  await withGuard({
    cap: 5,
    handler: async () => {
      await gate;
      return okResponse("ok");
    }
  }, async ({ calls }) => {
    const first = ask("requête jumelle");
    const second = ask("requête jumelle");

    await expectReject(() => second, /Double appel refusé/);

    release();
    await first;

    assert(calls.length === 1, `${calls.length} appel(s) SDK`);
    assert(getCallGuardStatus().used === 1, "compteur");
  });
});

console.log("");
console.log("--- 4. Appels sans issue (unresolved) ---");

// Fabrique un vrai appel resté "started" : un SDK qui ne répond jamais,
// puis la garde est réinitialisée comme après la mort du processus.
async function makeOrphanJournal(directory, texts) {
  await withEnv(REAL_ENV, async () => {
    mockSdk(() => new Promise(() => {}));

    try {
      configureCallGuard({ productionDir: directory, cap: 20 });

      for (const text of texts) {
        ask(text).catch(() => {});
      }

      await new Promise(resolve => setImmediate(resolve));
    } finally {
      resetCallGuard();
      restoreSdk();
    }
  });

  return readJournal(directory).entries.map(entry => entry.call_id);
}

await test("appel started sans issue : configure refuse, journal inchangé", async () => {
  const directory = makeDir();
  const [callId] = await makeOrphanJournal(directory, ["orpheline"]);

  assert(
    readJournal(directory).entries[0].status === "started",
    "orphelin non créé"
  );

  const before = fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8");

  await withEnv(REAL_ENV, async () => {
    const error = await (async () => {
      try {
        configureCallGuard({ productionDir: directory, cap: 3 });
      } catch (caught) {
        return caught;
      }

      return null;
    })();

    assert(error && /sans issue connue/.test(error.message), "refus attendu");
    assert(error.message.includes(callId), "call_id absent du message");
    assert(/--accept-unresolved-calls/.test(error.message), "aide au déblocage");
    assert(!getCallGuardStatus().configured, "garde configurée malgré le refus");
  });

  assert(
    fs.readFileSync(path.join(directory, JOURNAL_FILE), "utf8") === before,
    "journal modifié par le refus"
  );
});

await test("déblocage : nominatif seulement — wildcard, liste, id inconnu, doublon refusés", async () => {
  const directory = makeDir();
  const [callId] = await makeOrphanJournal(directory, ["orpheline"]);

  await withEnv(REAL_ENV, async () => {
    for (const bad of [
      "*", "all", "c0001-*", "c0001-aaaaaaaaaaaa,c0002-bbbbbbbbbbbb", ""
    ]) {
      expectThrow(
        () => configureCallGuard({
          productionDir: directory, cap: 3, acceptUnresolved: [bad]
        }),
        /call_id valide/
      );
    }

    expectThrow(
      () => configureCallGuard({
        productionDir: directory,
        cap: 3,
        acceptUnresolved: ["c0009-aaaaaaaaaaaa"]
      }),
      /n'est pas un appel sans issue/
    );

    expectThrow(
      () => configureCallGuard({
        productionDir: directory,
        cap: 3,
        acceptUnresolved: [callId, callId]
      }),
      /plusieurs fois/
    );

    assert(!getCallGuardStatus().configured, "configurée malgré les refus");
    assert(
      readJournal(directory).entries[0].status === "started",
      "journal modifié par un refus"
    );
  });
});

await test("déblocage d'un seul appel : les autres restent bloquants", async () => {
  const directory = makeDir();
  const [first, second] = await makeOrphanJournal(
    directory,
    ["orpheline 1", "orpheline 2"]
  );

  await withEnv(REAL_ENV, async () => {
    expectThrow(
      () => configureCallGuard({
        productionDir: directory, cap: 3, acceptUnresolved: [first]
      }),
      new RegExp(second)
    );

    assert(
      readJournal(directory).entries.every(e => e.status === "started"),
      "un refus ne doit rien débloquer"
    );
  });
});

await test("déblocage nominatif : tracé dans le journal, appels de nouveau possibles", async () => {
  const directory = makeDir();
  const [callId] = await makeOrphanJournal(directory, ["orpheline"]);

  await withEnv(REAL_ENV, async () => {
    const calls = mockSdk(() => okResponse("après déblocage"));

    try {
      const result = configureCallGuard({
        productionDir: directory, cap: 3, acceptUnresolved: [callId]
      });

      assert(
        JSON.stringify(result.accepted) === JSON.stringify([callId]),
        "accepted"
      );

      const entry = readJournal(directory).entries[0];

      assert(entry.status === "unresolved_accepted", entry.status);
      assert(
        entry.resolution.via === "--accept-unresolved-calls" &&
        entry.resolution.outcome === "unknown" &&
        typeof entry.resolution.accepted_at === "string",
        JSON.stringify(entry.resolution)
      );

      // La requête orpheline n'est PAS relancée automatiquement.
      assert(calls.length === 0, "appel automatique après déblocage");

      await ask("nouvelle requête");

      assert(calls.length === 1, "appel explicite après déblocage");
    } finally {
      resetCallGuard();
      restoreSdk();
    }
  });
});

await test("journal invalide : configure refuse (fail-closed)", async () => {
  for (const content of [
    "pas du json",
    '{"schema":2,"entries":[]}',
    '{"schema":1,"entries":[{"call_id":"x"}]}'
  ]) {
    const directory = makeDir();

    fs.writeFileSync(path.join(directory, JOURNAL_FILE), content);

    await withEnv(REAL_ENV, () => {
      expectThrow(
        () => configureCallGuard({ productionDir: directory, cap: 2 }),
        /Journal des appels/
      );
    });
  }
});

console.log("");
console.log("--- 5. Cache : intégrité, fail-closed ---");

await test("cache invalide, incohérent ou illisible : erreur, jamais de nouvel appel", async () => {
  await withGuard({ cap: 10 }, async ({ directory, calls }) => {
    await ask("requête en cache");

    const entry = readJournal(directory).entries[0];
    const file = path.join(
      directory, CACHE_DIR, `${entry.request_sha256}.json`
    );
    const original = fs.readFileSync(file, "utf8");
    const record = JSON.parse(original);

    const alterations = {
      "JSON illisible": () => "{ pas du json",
      "réponse altérée": () => {
        const copy = structuredClone(record);
        copy.result.response.content[0].text = "altérée";
        return JSON.stringify(copy);
      },
      "empreinte de requête différente": () => {
        const copy = structuredClone(record);
        copy.request_sha256 = "0".repeat(64);
        return JSON.stringify(copy);
      },
      "meta incomplète": () => {
        const copy = structuredClone(record);
        delete copy.result.meta.model;
        return JSON.stringify(copy);
      },
      "schéma inconnu": () => {
        const copy = structuredClone(record);
        copy.schema = 9;
        return JSON.stringify(copy);
      },
      "intégrité absente": () => {
        const copy = structuredClone(record);
        delete copy.integrity;
        return JSON.stringify(copy);
      }
    };

    const journalBefore = readJournal(directory).entries.length;

    for (const [label, alter] of Object.entries(alterations)) {
      fs.writeFileSync(file, alter());

      await expectReject(
        () => ask("requête en cache"),
        /Cache des appels invalide/
      );

      assert(calls.length === 1, `${label} : appel SDK de remplacement`);
    }

    assert(
      readJournal(directory).entries.length === journalBefore,
      "le journal ne doit pas bouger sur un cache invalide"
    );

    fs.writeFileSync(file, original);

    const restored = await ask("requête en cache");

    assert(
      calls.length === 1 &&
      restored.response.content[0].text === "réponse",
      "le cache restauré doit être de nouveau servi"
    );
  });
});

console.log("");
console.log("--- 5b. Sonde du cache et coût prévisible (R29.3) ---");

const PARAMS = { system: "Système de test", messages: [{ role: "user", content: "requête sondée" }], maxTokens: 10, temperature: 0 };
const treeSnapshot = directory => listFiles(directory)
  .map(file => [path.relative(directory, file), fs.readFileSync(file, "utf8")])
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));

await test("R29.3 — buildMessageRequest : mêmes clés que l'ancienne requête de createMessage, valeurs par défaut conservées", () => {
  assert(
    JSON.stringify(buildMessageRequest({ system: "S", messages: [1] })) ===
      JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, temperature: 0.2, messages: [1], system: "S" }),
    "requête par défaut"
  );
  assert(!("system" in buildMessageRequest({ messages: [1] })), "system présent sans prompt");
  assert(!("tools" in buildMessageRequest({ messages: [1], tools: [] })), "tools vide transmis");
  const withTools = buildMessageRequest({ messages: [1], tools: [{ name: "t" }], model: "m", maxTokens: 5, temperature: 0 });
  assert(JSON.stringify(withTools) === JSON.stringify({ model: "m", max_tokens: 5, temperature: 0, messages: [1], tools: [{ name: "t" }] }), JSON.stringify(withTools));
});

await test("R29.3 — isRequestCached : absent, puis présent après l'appel ; l'empreinte prédite est celle du journal", async () => {
  await withGuard({ cap: 5 }, async ({ directory }) => {
    const request = buildMessageRequest(PARAMS);
    assert(isRequestCached(request) === false, "présent avant l'appel");
    await ask("requête sondée");
    assert(isRequestCached(request) === true, "absent après l'appel");
    assert(requestSha256(request) === readJournal(directory).entries[0].request_sha256, "empreinte différente de celle du journal");
    assert(isRequestCached(buildMessageRequest({ ...PARAMS, temperature: 0.5 })) === false, "une autre requête ne doit pas être en cache");
  });
});

await test("R29.3 — isRequestCached est strictement en lecture seule : fichiers, journal, compteurs inchangés", async () => {
  await withGuard({ cap: 5 }, async ({ directory, calls }) => {
    await ask("requête sondée");
    const before = [treeSnapshot(directory), getCallGuardStatus(), calls.length];
    for (let index = 0; index < 3; index += 1) {
      isRequestCached(buildMessageRequest(PARAMS));
      isRequestCached(buildMessageRequest({ ...PARAMS, maxTokens: 11 }));
    }
    assert(JSON.stringify([treeSnapshot(directory), getCallGuardStatus(), calls.length]) === JSON.stringify(before), "effet de bord de la sonde");
  });
});

await test("R29.3 — isRequestCached en régénération (cacheBypass) : jamais en cache, comme beginRealCall", async () => {
  await withGuard({ cap: 5 }, async () => {
    await ask("requête sondée");
    setCacheBypass(true);
    try {
      assert(isRequestCached(buildMessageRequest(PARAMS)) === false, "cache lu en régénération");
    } finally {
      setCacheBypass(false);
    }
    assert(isRequestCached(buildMessageRequest(PARAMS)) === true, "cache non restauré");
  });
});

await test("R29.3 — isRequestCached : entrée invalide → erreur fail-closed marquée cache_invalid, jamais « absent » ; rien d'écrit", async () => {
  await withGuard({ cap: 5 }, async ({ directory }) => {
    await ask("requête sondée");
    const file = path.join(directory, CACHE_DIR, `${readJournal(directory).entries[0].request_sha256}.json`);
    fs.writeFileSync(file, "{ pas du json");
    const before = treeSnapshot(directory);
    let error = null;
    try {
      isRequestCached(buildMessageRequest(PARAMS));
    } catch (caught) {
      error = caught;
    }
    assert(error && error.cache_invalid === true && /Cache des appels invalide/.test(error.message), error?.message);
    assert(JSON.stringify(treeSnapshot(directory)) === JSON.stringify(before), "la sonde a modifié le cache");
  });
});

await test("R29.3 — isRequestCached sans garde configuré : erreur explicite", () => {
  expectThrow(() => isRequestCached(buildMessageRequest(PARAMS)), /aucune autorisation d'appels réels/);
});

await test("R29.3 — previewMessageCost : coût nul sous fixtures, sans objet sous NO_API ou sans garde, sinon cache connu", async () => {
  await withGuard({ cap: 5 }, async () => {
    assert(JSON.stringify(previewMessageCost(PARAMS)) === JSON.stringify({ applicable: true, cached: false }), "avant l'appel");
    await ask("requête sondée");
    assert(JSON.stringify(previewMessageCost(PARAMS)) === JSON.stringify({ applicable: true, cached: true }), "après l'appel");
    await withEnv({ ANTHROPIC_FIXTURES: "1" }, () => assert(JSON.stringify(previewMessageCost(PARAMS)) === JSON.stringify({ applicable: false, reason: "FIXTURES" }), "fixtures"));
    await withEnv({ NO_API: "1" }, () => assert(JSON.stringify(previewMessageCost(PARAMS)) === JSON.stringify({ applicable: false, reason: "NO_API" }), "NO_API"));
  });
  await withEnv(REAL_ENV, () => assert(JSON.stringify(previewMessageCost(PARAMS)) === JSON.stringify({ applicable: false, reason: "GUARD_UNCONFIGURED" }), "garde non configuré"));
});

await test("R29.3 — previewMessageCost et createMessage partagent les valeurs par défaut (modèle, max_tokens, température)", async () => {
  await withGuard({ cap: 5 }, async ({ calls }) => {
    await createMessage({ system: "Système de test", messages: [{ role: "user", content: "défauts" }] });
    assert(calls.length === 1 && calls[0].model === "claude-sonnet-4-5" && calls[0].max_tokens === 1024 && calls[0].temperature === 0.2, JSON.stringify(calls[0]));
    assert(previewMessageCost({ system: "Système de test", messages: [{ role: "user", content: "défauts" }] }).cached === true, "la sonde ne retrouve pas l'appel par défaut");
  });
});

await test("R29.3 — previewMessageCost : aucun appel SDK, aucun réseau", async () => {
  await withGuard({ cap: 5 }, async ({ calls }) => {
    previewMessageCost(PARAMS);
    assert(calls.length === 0 && getCallGuardStatus().used === 0, "la sonde a appelé le SDK");
  });
});

console.log("--- 6. Aucun secret, aucune fuite ---");

await test("ni clé ni contenu de prompt dans le journal, le cache ou les erreurs", async () => {
  await withGuard({
    cap: 5,
    handler: (_request, index) => {
      if (index === 2) {
        throw new Error(`refus ${DUMMY_KEY}`);
      }

      return okResponse("réponse neutre");
    }
  }, async ({ directory }) => {
    await ask("MARQUEUR-CONFIDENTIEL-PROMPT");
    await expectReject(() => ask("autre requête"), /Erreur Anthropic/);

    const files = listFiles(directory);

    assert(files.length >= 2, "fichiers attendus");

    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");

      assert(!text.includes(DUMMY_KEY), `clé dans ${path.basename(file)}`);
      assert(!/sk-[A-Za-z0-9_-]{6,}/.test(text), `motif sk- dans ${path.basename(file)}`);
    }

    const journalText = fs.readFileSync(
      path.join(directory, JOURNAL_FILE), "utf8"
    );

    assert(
      !journalText.includes("MARQUEUR-CONFIDENTIEL-PROMPT") &&
      !journalText.includes("Système de test"),
      "prompt dans le journal"
    );
  });
});

console.log("");
console.log("--- 7. Compatibilité fixtures ---");

await test("fixtures prioritaires : aucun passage par la garde, aucun journal", async () => {
  const directory = makeDir();

  await withEnv(
    {
      ANTHROPIC_FIXTURES: "1",
      ANTHROPIC_FIXTURE_SCENARIO: undefined,
      NO_API: "1"
    },
    async () => {
      const result = await runResearchAgent({
        title: CANONICAL_TITLE,
        prompt: CANONICAL_PROMPT,
        testMode: true
      });

      assert(result.mode === "test", "mode");
      assert(
        result.usage.model === "fixture:research",
        `modèle ${result.usage.model}`
      );
    }
  );

  // Même avec une garde configurée : les fixtures ne comptent pas.
  await withEnv(
    { ...REAL_ENV, ANTHROPIC_FIXTURES: "1", NO_API: undefined },
    async () => {
      try {
        configureCallGuard({ productionDir: directory, cap: 1 });

        await runResearchAgent({
          title: CANONICAL_TITLE,
          prompt: CANONICAL_PROMPT,
          testMode: true
        });

        assert(getCallGuardStatus().used === 0, "fixture comptée");
        assert(
          !fs.existsSync(path.join(directory, JOURNAL_FILE)),
          "journal écrit pour une fixture"
        );
      } finally {
        resetCallGuard();
      }
    }
  );
});

console.log("");
console.log("--- 8. Porte du mode complet (processus enfants) ---");

function listProductions() {
  return fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).sort() : [];
}

function runMvp(args, env = {}) {
  const before = listProductions();

  const child = spawnSync(
    process.execPath,
    ["--import", GUARD, "src/orchestrator/mvp.js", ...args],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8"
    }
  );

  const guardLine = child.stderr.match(
    /\[fixture-network-guard\] actif — tentatives bloquées : (\d+)/
  );

  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    created: listProductions().filter(name => !before.includes(name)),
    blocked: guardLine ? Number(guardLine[1]) : null
  };
}

function expectGateRefusal(run, pattern) {
  assert(run.status !== 0 && run.status !== null, `exit ${run.status}`);
  assert(pattern.test(run.stderr), `stderr : ${run.stderr.slice(0, 400)}`);
  assert(run.created.length === 0, `production créée : ${run.created}`);
  assert(run.blocked === 0, `tentatives réseau : ${run.blocked}`);
  assert(!run.stdout.includes("Production :"), "production annoncée");
}

const ACK = { [REAL_CALLS_ACK_ENV]: "1" };

await test("--mode=full sans plafond → refus avant toute production", () => {
  expectGateRefusal(
    runMvp(["--research-script", "--mode=full"], ACK),
    /--real-calls-cap=<N> est obligatoire/
  );
});

await test("--mode=full sans accusé d'environnement → refus", () => {
  expectGateRefusal(
    runMvp(["--research-script", "--mode=full", "--real-calls-cap=3"]),
    new RegExp(REAL_CALLS_ACK_ENV)
  );
});

await test("--mode=full sous NO_API=1 → refus, NO_API prime", () => {
  expectGateRefusal(
    runMvp(
      ["--research-script", "--mode=full", "--real-calls-cap=3"],
      { ...ACK, NO_API: "1" }
    ),
    /NO_API=1/
  );
});

await test("--mode=full : plafond invalide (0, 501, abc, vide) → refus", () => {
  for (const cap of ["0", "501", "abc", ""]) {
    expectGateRefusal(
      runMvp(
        ["--research-script", "--mode=full", `--real-calls-cap=${cap}`],
        ACK
      ),
      /Appels réels/
    );
  }
});

await test("--mode inconnu, --mode=full sans --research-script → refus", () => {
  expectGateRefusal(
    runMvp(["--research-script", "--mode=bogus"]),
    /--mode inconnu "bogus"/
  );
  expectGateRefusal(
    runMvp(["--dry-run", "--mode=full", "--real-calls-cap=3"], ACK),
    /--mode=full exige --research-script/
  );
});

await test("--real-calls-cap sans --mode=full, --accept-unresolved-calls sans reprise → refus", () => {
  expectGateRefusal(
    runMvp(["--research-script", "--real-calls-cap=3"], ACK),
    /--real-calls-cap exige --mode=full/
  );
  expectGateRefusal(
    runMvp(
      [
        "--research-script", "--mode=full", "--real-calls-cap=3",
        "--accept-unresolved-calls=c0001-aaaaaaaaaaaa"
      ],
      ACK
    ),
    /--accept-unresolved-calls exige --resume et --mode=full/
  );
});

await test("--regenerate (D′1) : exige --resume et --mode=full, un seul agent, identifiants de --stop-after → refus avant toute production", () => {
  expectGateRefusal(
    runMvp(["--research-script", "--mode=full", "--real-calls-cap=3", "--regenerate=script"], ACK),
    /--regenerate exige --resume et --mode=full/
  );
  expectGateRefusal(
    runMvp(["--research-script", "--resume=prod-2026-01-01T00-00-00-000Z-aaaaaa", "--regenerate=script"], ACK),
    /--regenerate exige --resume et --mode=full/
  );
  for (const value of ["visual", "asset", "quality", ""]) {
    expectGateRefusal(
      runMvp(["--research-script", "--resume=prod-2026-01-01T00-00-00-000Z-aaaaaa", "--mode=full", "--real-calls-cap=3", `--regenerate=${value}`], ACK),
      /--regenerate invalide/
    );
  }
  expectGateRefusal(
    runMvp(["--research-script", "--resume=prod-2026-01-01T00-00-00-000Z-aaaaaa", "--mode=full", "--real-calls-cap=3", "--regenerate=script", "--regenerate=research"], ACK),
    /un seul agent/
  );
  expectGateRefusal(
    runMvp(["--research-script", "--resume=prod-2026-01-01T00-00-00-000Z-aaaaaa", "--mode=full", "--real-calls-cap=3", "--regenerate=script", "--stop-after=research"], ACK),
    /arrêterait la production avant l'agent régénéré/
  );
});

await test("mode test sans fixtures : aucun appel réel implicite, même avec une clé", () => {
  // Clé factice + ni fixtures ni NO_API : l'ancien code aurait tenté un
  // appel réel. La garde le refuse avant le SDK.
  const run = runMvp(
    ["--research-script"],
    { ANTHROPIC_API_KEY: DUMMY_KEY }
  );

  assert(run.status === 1, `exit ${run.status}`);
  assert(run.created.length === 1, `${run.created.length} production(s)`);
  assert(
    /Appel Anthropic réel non autorisé/.test(run.stderr),
    run.stderr.slice(0, 400)
  );
  assert(run.blocked === 0, `SDK atteint : ${run.blocked} tentative(s)`);

  const dir = path.join(PROJECTS, run.created[0]);
  const production = JSON.parse(
    fs.readFileSync(path.join(dir, "production.json"), "utf8")
  );

  assert(production.status === "failed", production.status);
  assert(production.mode === "test", production.mode);
  assert(
    !fs.existsSync(path.join(dir, JOURNAL_FILE)) &&
    !fs.existsSync(path.join(dir, CACHE_DIR)) &&
    !fs.existsSync(path.join(dir, ".lock")),
    "journal, cache ou verrou présents"
  );
  assert(
    !JSON.stringify(production).includes(DUMMY_KEY),
    "clé dans production.json"
  );
});

await test("--mode=full autorisé mais sous fixtures : échec fail-closed, aucun appel SDK, mode et verrou corrects", () => {
  const run = runMvp(
    ["--research-script", "--mode=full", "--real-calls-cap=3"],
    { ...ACK, ANTHROPIC_FIXTURES: "1" }
  );

  assert(run.status === 1, `exit ${run.status}`);
  assert(run.created.length === 1, `${run.created.length} production(s)`);
  assert(run.blocked === 0, `tentatives réseau : ${run.blocked}`);

  const dir = path.join(PROJECTS, run.created[0]);
  const production = JSON.parse(
    fs.readFileSync(path.join(dir, "production.json"), "utf8")
  );

  assert(production.mode === "full", production.mode);
  assert(production.status === "failed", production.status);
  assert(
    production.agents.find(a => a.id === "research").status === "failed",
    "research devait échouer"
  );
  assert(
    /Appels réels : mode complet, plafond 3/.test(run.stdout),
    "bannière du mode complet"
  );
  assert(
    !fs.existsSync(path.join(dir, ".lock")),
    "verrou non retiré"
  );
  assert(
    !fs.existsSync(path.join(dir, "research.json")),
    "artefact écrit pour un agent en échec"
  );
});

console.log("");
console.log("--- 9. Garantie zéro API ---");

await test("régénération (D′1) : cache contourné, appel compté, cache_bypass, ancienne entrée archivée ; puis cache normal", async () => {
  await withGuard({ cap: 3, handler: (request, n) => okResponse(`réponse ${n}`) }, async ({ directory, calls }) => {
    const first = await ask("question régénérée");
    assert(calls.length === 1 && first.response.content[0].text === "réponse 1", "premier appel");

    setCacheBypass(true);
    let second;
    try {
      second = await ask("question régénérée");
    } finally {
      setCacheBypass(false);
    }
    assert(calls.length === 2 && second.response.content[0].text === "réponse 2", "le cache aurait dû être contourné");
    assert(getCallGuardStatus().used === 2 && getCallGuardStatus().cache_hits === 0, JSON.stringify(getCallGuardStatus()));

    const entries = readJournal(directory).entries;
    assert(entries[0].status === "succeeded" && !("cache_bypass" in entries[0]), "appel ordinaire marqué");
    assert(entries[1].status === "succeeded" && entries[1].cache_bypass === true, "cache_bypass absent du journal");

    const hash = entries[1].request_sha256;
    const archived = listFiles(path.join(directory, CACHE_DIR, "superseded"));
    assert(archived.length === 1 && archived[0].endsWith(`${hash}.json`), `archive : ${archived}`);
    assert(JSON.parse(fs.readFileSync(archived[0], "utf8")).result.response.content[0].text === "réponse 1", "ancienne réponse non conservée");
    assert(JSON.parse(fs.readFileSync(path.join(directory, CACHE_DIR, `${hash}.json`), "utf8")).result.response.content[0].text === "réponse 2", "nouvelle réponse non mise en cache");

    const third = await ask("question régénérée");
    assert(calls.length === 2 && third.response.content[0].text === "réponse 2", "après l'exception, le cache doit servir la nouvelle réponse");
    assert(readJournal(directory).entries[2].status === "cache_hit" && getCallGuardStatus().used === 2, "cache_hit attendu");
  });

  expectThrow(() => setCacheBypass(true), /aucune autorisation/);
});

await test("aucune sortie réseau ni appel SDK réel pendant le smoke", () => {
  assert(
    networkGuard.attempts().length === 0,
    `tentatives : ${networkGuard.attempts()}`
  );
  assert(
    Anthropic.Messages.prototype.create === networkGuard.sdkMessagesCreate,
    "SDK non restauré"
  );
  assert(!getCallGuardStatus().configured, "garde restée configurée");
  assert(process.env.NO_API === "1", "NO_API non restauré");
  assert(!process.env.ANTHROPIC_API_KEY, "clé dans le processus");
});

for (const directory of tempDirs) {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log("");
console.log("========================================");
console.log(`Tests : ${passed} PASS / ${failed} FAIL`);
console.log("API Anthropic réelle utilisée : NON");
console.log(
  failed === 0
    ? "RESULTAT GLOBAL : PASS — garde des appels réels : autorisation, plafond, journal, cache, unresolved"
    : "RESULTAT GLOBAL : FAIL"
);

process.exit(failed === 0 ? 0 : 1);
