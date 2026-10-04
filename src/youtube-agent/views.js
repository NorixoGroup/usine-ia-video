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
<p>Connectée le ${escapeHtml(c.connected_at)} · accès en ${escapeHtml(scopes)} uniquement. Aucune donnée YouTube n'est encore lue.</p>
<p><a class="button" href="${escapeHtml(link)}">Se reconnecter à Google</a></p>`;
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
