// Smoke d'échappement HTML : charges XSS dans titre, notes, checklist, identifiants.
// Usage : NO_API=1 node --import ./scripts/fixture-network-guard.js scripts/youtube-agent-ui-escape-smoke.js

import { createHandler } from "../src/youtube-agent/server.js";
import { escapeHtml, renderDashboard } from "../src/youtube-agent/views.js";
import { tmpRoot, cleanup, check, done, makeProduction, PROD_A } from "./youtube-agent-test-helpers.js";

const XSS = `"><script>alert(1)</script><img src=x onerror=alert(2)>'`;
const root = tmpRoot("escape");
makeProduction(root, PROD_A, { input: { title: XSS }, status: XSS, mode: "test" });

const PORT = 4998;
const token = "t".repeat(64);
const handle = createHandler({ root, port: PORT, token });
const headers = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, "content-type": "application/x-www-form-urlencoded" };

function assertSafe(body) {
  if (/<script/i.test(body) || /<img\s/i.test(body) || /onerror=/i.test(body.replace(/&quot;|&#39;|&lt;|&gt;/g, ""))) {
    // onerror= peut apparaître comme texte inerte ; on exige l'absence de balise réelle
    if (/<script|<img/i.test(body)) throw new Error("balise injectée");
  }
}

check("escapeHtml neutralise les cinq caractères", () => {
  if (escapeHtml(`<>&"'`) !== "&lt;&gt;&amp;&quot;&#39;") throw new Error("échappement");
  if (escapeHtml(null) !== "" || escapeHtml(5) !== "5") throw new Error("types");
});

check("titre et statut hostiles échappés dans le tableau de bord", () => {
  const r = handle({ method: "GET", url: `/?t=${token}`, headers: { host: headers.host } });
  assertSafe(r.body);
  if (!r.body.includes("&lt;script&gt;")) throw new Error("échappement absent");
});

check("notes hostiles enregistrées puis ré-affichées échappées", () => {
  const body = new URLSearchParams({
    production_id: PROD_A, type: "test", video_id: "", target_date: "",
    publication_checklist: `[x] ${XSS}`, notes: XSS
  }).toString();
  const post = handle({ method: "POST", url: `/videos?t=${token}`, headers, body });
  if (post.status !== 303) throw new Error(`statut ${post.status}`);
  const page = handle({ method: "GET", url: `/?t=${token}`, headers: { host: headers.host } });
  assertSafe(page.body);
  if (!page.body.includes("&lt;script&gt;")) throw new Error("notes non échappées");
});

check("entrée invalide : message d'erreur échappé, aucune écriture", () => {
  const body = new URLSearchParams({ production_id: PROD_A, type: XSS }).toString();
  const r = handle({ method: "POST", url: `/videos?t=${token}`, headers, body });
  if (r.status !== 400) throw new Error(`statut ${r.status}`);
  assertSafe(r.body);
});

check("valeur hostile dans un attribut ne casse pas le contexte", () => {
  const html = renderDashboard({
    token,
    productions: { total: 1, shown: [{ id: XSS, readable: true, status: "x", mode: "test", title: "", agents: [] }] },
    registry: { videos: [{ production_id: XSS, type: "test", video_id: XSS, target_date: XSS, publication_checklist: [], notes: XSS }] }
  });
  if (/value="[^"]*"[^>]*<script/i.test(html) || /<script/i.test(html)) throw new Error("rupture d'attribut");
});

cleanup(root);
done("youtube-agent-ui-escape-smoke");
