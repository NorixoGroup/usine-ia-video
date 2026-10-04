// Rendu HTML côté serveur. Toute valeur dynamique passe par escapeHtml.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

function page(title, token, body) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css?t=${encodeURIComponent(token)}">
</head><body>
${body}
</body></html>`;
}

function checklistToText(checklist) {
  return checklist.map(item => `[${item.done ? "x" : " "}] ${item.label}`).join("\n");
}

function videoForm({ production, entry, token }) {
  const e = entry ?? {};
  const type = e.type ?? (production.mode === "full" ? "real" : "test");

  return `<form class="entry" method="post" action="/videos?t=${encodeURIComponent(token)}">
<input type="hidden" name="production_id" value="${escapeHtml(production.id)}">
<label>Type <select name="type">
<option value="real"${type === "real" ? " selected" : ""}>real</option>
<option value="test"${type === "test" ? " selected" : ""}>test</option></select></label>
<label>Identifiant YouTube (11 caractères, optionnel) <input name="video_id" maxlength="11" value="${escapeHtml(e.video_id ?? "")}"></label>
<label>Date cible <input type="date" name="target_date" value="${escapeHtml(e.target_date ?? "")}"></label>
<label>Checklist de publication (une ligne par point, « [x] » = fait)
<textarea name="publication_checklist" rows="4">${escapeHtml(checklistToText(e.publication_checklist ?? []))}</textarea></label>
<label>Notes <textarea name="notes" rows="3" maxlength="2000">${escapeHtml(e.notes ?? "")}</textarea></label>
<button type="submit">Enregistrer</button>
</form>`;
}

const SCOPE_LABELS = {
  "https://www.googleapis.com/auth/youtube.readonly": "lecture YouTube",
  "https://www.googleapis.com/auth/yt-analytics.readonly": "lecture des analytiques"
};

// Miroir local de la chaîne : état de la dernière synchronisation et bouton (aucun appel à l'affichage).
function mirrorBlock(mirror, token) {
  const channel = mirror?.channel ?? { status: "not_loaded" };
  const videos = mirror?.videos ?? { status: "not_loaded" };
  const sync = mirror?.sync ?? { status: "not_loaded" };
  let state;

  if (channel.status === "ok") {
    const error = channel.last_error ? ` · dernière tentative en échec (${escapeHtml(channel.last_error.reason)}) le ${escapeHtml(channel.last_error.at)}, miroir précédent conservé` : "";
    const count = videos.status === "ok" ? `${videos.total} vidéo${videos.total > 1 ? "s" : ""}${videos.removed ? `, ${videos.removed} retirée${videos.removed > 1 ? "s" : ""}` : ""}` : "vidéos non lues";

    state = `Chaîne « ${escapeHtml(channel.channel.title)} » · ${count} · synchronisée le ${escapeHtml(channel.synced_at)}${error}.`;
  } else if (channel.status === "error") {
    state = `Non lue : dernière synchronisation en échec (${escapeHtml(channel.reason)}) le ${escapeHtml(channel.fetched_at)}.`;
  } else {
    state = "Non lue : aucune synchronisation n'a encore été faite.";
  }

  const last = sync.last_summary;
  const details = last ? `<p>Dernière synchronisation : ${escapeHtml(sync.last_sync_at ?? "inconnue")} · mode ${escapeHtml(last.mode === "full" ? "Full" : "Incremental")} · ${escapeHtml(String(last.quota_units ?? 0))} unité(s) · ${escapeHtml(String(last.videos_analyzed ?? 0))} vidéo(s) analysée(s) · dernière Full : ${escapeHtml(sync.last_full_sync ?? "inconnue")}.</p>` : "";

  return `<h3>Miroir local de la chaîne</h3>
<p>${state}</p>
${details}
<form method="post" action="/youtube/sync?t=${encodeURIComponent(token)}"><button type="submit">Synchroniser la chaîne</button></form>`;
}

// Analytiques de la chaîne (R20.5, lot 4A) : résumé local et bouton (aucun appel à l'affichage).
function analyticsBlock(analytics, token) {
  const a = analytics ?? { status: "not_loaded" };
  const n = value => escapeHtml(String(Math.round(value * 10) / 10));
  let body;

  if (a.status === "ok") {
    const t = a.totals;
    const error = a.last_error ? ` · dernière tentative en échec (${escapeHtml(a.last_error.reason)}) le ${escapeHtml(a.last_error.at)}, données précédentes conservées` : "";

    body = `<p>Données jusqu'au ${escapeHtml(a.data_until)} (fuseau du Pacifique) · synchronisées le ${escapeHtml(a.synced_at)} · ${escapeHtml(String(a.days_stored))} jour(s) enregistré(s)${error}.</p>
<p>Du ${escapeHtml(a.period.from)} au ${escapeHtml(a.period.to)} : ${n(t.views)} vue(s) · ${n(t.watch_time_minutes)} minute(s) regardée(s) · abonnés ${t.subscribers_net >= 0 ? "+" : ""}${n(t.subscribers_net)} · ${n(t.likes)} j'aime · ${n(t.comments)} commentaire(s) · ${n(t.shares)} partage(s) · pourcentage moyen regardé : ${t.average_view_percentage === null ? "sans objet" : `${n(t.average_view_percentage)} %`}.</p>`;
  } else if (a.status === "error") {
    body = `<p>Non lues : dernière synchronisation en échec (${escapeHtml(a.reason)}) le ${escapeHtml(a.at)}.</p>`;
  } else {
    body = "<p>Non lues : aucune synchronisation n'a encore été faite.</p>";
  }

  return `<h3>Analytiques de la chaîne</h3>
${body}
<form method="post" action="/youtube/analytics/sync?t=${encodeURIComponent(token)}"><button type="submit">Synchroniser les analytiques</button></form>
${insightsBlock(analytics?.insights, token)}`;
}

// Bloc Analytics (R20.6) : répartitions, classements, propositions de liaison (lecture seule ;
// la validation d'une proposition passe par le formulaire existant du registre).
const BREAKDOWN_LABELS = { traffic_source: "Sources de trafic", device_type: "Appareils", country: "Pays" };
const num = value => escapeHtml(String(Math.round((value ?? 0) * 10) / 10));
const videoLink = (videoId, token) => `/analytics/video?v=${encodeURIComponent(videoId)}&t=${encodeURIComponent(token)}`;

function rankingTable(title, items, token) {
  if (!items.length) return `<h4>${escapeHtml(title)}</h4><p class="muted">Aucune vidéo.</p>`;

  return `<h4>${escapeHtml(title)}</h4>
<table><thead><tr><th>Vidéo</th><th>Vues (28 j)</th><th>Minutes</th><th>% regardé</th></tr></thead><tbody>
${items.map(v => `<tr><td><a href="${escapeHtml(videoLink(v.video_id, token))}">${escapeHtml(v.title ?? v.video_id)}</a>${v.privacy_status ? ` <span class="tag">${escapeHtml(v.privacy_status)}</span>` : ""}</td><td>${num(v.views)}</td><td>${num(v.watch_time_minutes)}</td><td>${v.average_view_percentage === null ? "—" : `${num(v.average_view_percentage)} %`}</td></tr>`).join("\n")}
</tbody></table>`;
}

function proposalForm(p, token) {
  const e = p.entry;

  return `<form class="entry" method="post" action="/videos?t=${encodeURIComponent(token)}">
<input type="hidden" name="production_id" value="${escapeHtml(p.production_id)}">
<input type="hidden" name="type" value="${escapeHtml(e.type)}">
<input type="hidden" name="video_id" value="${escapeHtml(p.video_id)}">
<input type="hidden" name="target_date" value="${escapeHtml(e.target_date ?? "")}">
<input type="hidden" name="publication_checklist" value="${escapeHtml(checklistToText(e.publication_checklist))}">
<input type="hidden" name="notes" value="${escapeHtml(e.notes)}">
<p>« ${escapeHtml(p.video_title)} » ↔ <code>${escapeHtml(p.production_id)}</code> (${escapeHtml(p.production_title)}) · score ${escapeHtml(String(p.score))} · ${escapeHtml(p.reasons.join(" ; "))}</p>
<button type="submit">Valider le lien</button>
</form>`;
}

function insightsBlock(insights, token) {
  if (!insights) return "";

  const { overview, proposals } = insights;
  const parts = [];
  const dims = overview.breakdowns?.dimensions;

  if (dims) {
    parts.push(`<h4>Répartitions (28 jours)</h4>${Object.entries(dims).map(([name, d]) => {
      const label = escapeHtml(BREAKDOWN_LABELS[name] ?? name);
      const error = d.last_error ? ` <span class="muted">(dernière lecture en échec : ${escapeHtml(d.last_error.reason)})</span>` : "";

      return d.status === "ok"
        ? `<p>${label} : ${d.rows.length ? d.rows.slice(0, 5).map(r => `${escapeHtml(r.key)} ${num(r.views)}`).join(" · ") : "aucune donnée"}${error}</p>`
        : `<p>${label} : non disponible${error}</p>`;
    }).join("\n")}`);
  }

  const v = overview.videos;

  if (v.status === "ok") {
    parts.push(`<h4>Vidéos</h4><p>${escapeHtml(String(v.tracked))} vidéo(s) suivie(s) · ${escapeHtml(String(v.eligible))} classée(s) · synchronisées le ${escapeHtml(v.synced_at)}${v.last_error ? ` · dernière tentative en échec (${escapeHtml(v.last_error.reason)})` : ""}.</p>`);
    parts.push(rankingTable("Meilleures vidéos", v.top, token));
    parts.push(rankingTable("Moins bonnes vidéos", v.worst, token));
  } else {
    parts.push(`<h4>Vidéos</h4><p>${v.status === "error" ? `Non lues : dernière synchronisation en échec (${escapeHtml(v.reason)}).` : "Non lues : aucune synchronisation des vidéos n'a encore été faite."}</p>`);
  }

  parts.push(`<h4>Liaisons production ↔ vidéo</h4><p>${escapeHtml(String(overview.links.linked_videos))} vidéo(s) liée(s) · ${escapeHtml(String(proposals.length))} proposition(s) à valider.</p>
${proposals.map(p => proposalForm(p, token)).join("\n")}`);

  return parts.join("\n");
}

// Fiche d'une vidéo (lecture seule).
export function renderVideoAnalytics({ detail, token }) {
  const title = detail.title ?? detail.video_id;
  const a = detail.analytics;
  const totals = (label, t) => t ? `<p>${escapeHtml(label)} : ${num(t.views)} vue(s) · ${num(t.watch_time_minutes)} minute(s) · ${num(t.likes)} j'aime · ${num(t.comments)} commentaire(s) · ${num(t.shares)} partage(s) · abonnés +${num(t.subscribers_gained)} / -${num(t.subscribers_lost)} · % regardé ${t.average_view_percentage === null ? "—" : `${num(t.average_view_percentage)} %`}</p>` : "";
  const lineage = detail.lineage
    ? `<h2>Production liée</h2>
<p><code>${escapeHtml(detail.lineage.production.id)}</code> · ${escapeHtml(detail.lineage.production.title)} · <span class="tag">${escapeHtml(detail.link.type)}</span></p>
<ul>${Object.entries(detail.lineage.artifacts).map(([name, art]) => `<li>${escapeHtml(name)} (${escapeHtml(art.file)}) : ${art.present ? "présent" : "absent"}${art.title ? ` · « ${escapeHtml(art.title)} »` : ""}${art.title_verdict ? ` · verdict du titre ${escapeHtml(art.title_verdict)}` : ""}${art.shots !== undefined && art.shots !== null ? ` · ${escapeHtml(String(art.shots))} plan(s)` : ""}</li>`).join("")}</ul>
${detail.lineage.publication ? `<p>Publication : checklist ${escapeHtml(String(detail.lineage.publication.checklist_done))}/${escapeHtml(String(detail.lineage.publication.checklist_total))}.</p>` : ""}`
    : "<h2>Production liée</h2><p class=\"muted\">Aucune production liée.</p>";
  const rows = detail.daily.map(d => `<tr><td>${escapeHtml(d.day)}</td><td>${num(d.views)}</td><td>${num(d.watch_time_minutes)}</td><td>${num(d.average_view_percentage)} %</td><td>${num(d.likes)}</td><td>${num(d.subscribers_gained)}</td></tr>`).join("\n");

  return page(`Vidéo ${detail.video_id}`, token, `<h1>${escapeHtml(title)}</h1>
<p><a href="/?t=${encodeURIComponent(token)}">Retour</a></p>
<p><code>${escapeHtml(detail.video_id)}</code>${detail.privacy_status ? ` · <span class="tag">${escapeHtml(detail.privacy_status)}</span>` : ""} · miroir : ${escapeHtml(detail.mirror_status)}${detail.published_at ? ` · publiée le ${escapeHtml(detail.published_at)}` : ""}</p>
<h2>Analytiques</h2>
${a.status === "not_loaded" ? "<p>Non lues : aucune synchronisation des vidéos ne concerne cette vidéo.</p>" : `<p>Données jusqu'au ${escapeHtml(a.data_until ?? "—")} (fuseau du Pacifique) · ${escapeHtml(String(a.days_stored))} jour(s) enregistré(s)${a.last_error ? ` · dernière lecture en échec (${escapeHtml(a.last_error.reason)})` : ""}.</p>
${totals("28 derniers jours", a.recent)}
${totals("Depuis le début du suivi", a.lifetime)}`}
${lineage}
<h2>Détail quotidien</h2>
<table><thead><tr><th>Jour</th><th>Vues</th><th>Minutes</th><th>% regardé</th><th>J'aime</th><th>Abonnés gagnés</th></tr></thead><tbody>
${rows || '<tr><td colspan="6" class="muted">Aucun jour enregistré.</td></tr>'}
</tbody></table>`);
}

// Bloc « Connexion Google » : état et bouton, jamais aucun secret.
function youtubeBlock(youtube, token) {
  if (!youtube) return "";

  if (!youtube.enabled) {
    const names = [...(youtube.problem?.missing ?? []), ...(youtube.problem?.invalid ?? [])];

    return `<h2>Connexion Google</h2>
<p class="banner">Connexion Google non configurée.${names.length ? ` Variables à fournir ou à corriger : <code>${escapeHtml(names.join(", "))}</code>.` : ""}</p>`;
  }

  const c = youtube.connection;
  const link = `/oauth/youtube/login?t=${encodeURIComponent(token)}`;

  if (c.status === "connected") {
    const scopes = (c.scopes ?? []).map(s => SCOPE_LABELS[s] ?? "autorisation").join(", ");

    return `<h2>Connexion Google</h2>
<p>Connectée le ${escapeHtml(c.connected_at)} · accès en ${escapeHtml(scopes)} uniquement.</p>
<p><a class="button" href="${escapeHtml(link)}">Se reconnecter à Google</a></p>
${mirrorBlock(youtube.mirror, token)}
${analyticsBlock(youtube.analytics, token)}`;
  }

  return `<h2>Connexion Google</h2>
<p>Non connectée.</p>
<p><a class="button" href="${escapeHtml(link)}">Se connecter à Google</a></p>`;
}

export function renderDashboard({ productions, registry, token, message = null, youtube = null }) {
  const byProduction = new Map(registry.videos.map(v => [v.production_id, v]));

  const rows = productions.shown.map(p => {
    const entry = byProduction.get(p.id);
    const agents = p.agents.map(a => `${escapeHtml(a.id)}:${escapeHtml(a.status)}`).join(" · ");

    return `<tr><td><code>${escapeHtml(p.id)}</code><br><span class="muted">${escapeHtml(p.title)}</span></td>
<td><span class="tag">${escapeHtml(p.status)}</span> <span class="tag">${escapeHtml(p.mode)}</span>${p.locked ? ' <span class="tag">verrouillée</span>' : ""}
<br><span class="muted">${agents}</span></td>
<td>${entry ? `<span class="tag">${escapeHtml(entry.type)}</span> ${escapeHtml(entry.video_id ?? "—")}` : '<span class="muted">non lié</span>'}</td></tr>
<tr><td colspan="3"><details><summary>Lier / éditer</summary>${p.readable ? videoForm({ production: p, entry, token }) : "<p>Production illisible.</p>"}</details></td></tr>`;
  }).join("\n");

  const banner = message ? `<p class="banner">${escapeHtml(message)}</p>` : "";

  return page("YouTube Agent", token, `<h1>YouTube Agent</h1>
<p class="muted">Session locale, aucun appel externe.</p>
${banner}
${youtubeBlock(youtube, token)}
<h2>Productions (${productions.shown.length} sur ${productions.total})</h2>
<table><thead><tr><th>Production</th><th>État</th><th>Vidéo</th></tr></thead><tbody>
${rows || '<tr><td colspan="3" class="muted">Aucune production.</td></tr>'}
</tbody></table>`);
}

export function renderError({ title, message, token = "" }) {
  return page(title, token, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
