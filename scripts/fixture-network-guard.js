// Garde réseau des tests Fixture Engine.
//
// Usage : node --import ./scripts/fixture-network-guard.js <script>
//
// Toute tentative de sortie réseau (fetch, socket, DNS, http/https) et
// tout appel anthropic.messages.create lève une erreur et est comptée.
// Le bilan est écrit sur stderr à la fin du processus.

import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

import Anthropic from "@anthropic-ai/sdk";

const attempts = [];

function block(kind) {
  return function blockedByFixtureNetworkGuard() {
    attempts.push(kind);

    throw new Error(
      `fixture-network-guard — ${kind} interdit pendant les tests fixtures.`
    );
  };
}

globalThis.fetch = block("fetch");

net.Socket.prototype.connect = block("net.Socket.connect");

dns.lookup = block("dns.lookup");
dns.resolve = block("dns.resolve");
dns.promises.lookup = block("dns.promises.lookup");
dns.promises.resolve = block("dns.promises.resolve");

http.request = block("http.request");
http.get = block("http.get");
https.request = block("https.request");
https.get = block("https.get");

syncBuiltinESMExports();

Anthropic.Messages.prototype.create =
  block("anthropic.messages.create");

export const networkGuard = {
  // Copie des tentatives bloquées depuis le démarrage du processus.
  attempts: () => [...attempts],
  sdkMessagesCreate: Anthropic.Messages.prototype.create
};

globalThis.__fixtureNetworkGuard = networkGuard;

process.on("exit", () => {
  fs.writeSync(
    2,
    `[fixture-network-guard] actif — tentatives bloquées : ${attempts.length}` +
    (attempts.length ? ` (${attempts.join(", ")})` : "") +
    "\n"
  );
});
