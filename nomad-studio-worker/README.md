# Nomad Studio — worker vidéo (packaging Docker local)

Empaquetage Docker du moteur documentaire existant (`src/orchestrator/mvp.js`
et ses agents) pour une exécution future sur le VPS Hostinger, indépendante
du Mac et du conteneur n8n déjà en place.

**Ce dossier concerne exclusivement le pipeline documentaire « Les
Découvertes du Nomade ». Le projet distinct « Karim & Lina » (shorts animés,
`animated-shorts/`) n'est ni concerné ni inclus.**

## Ce que ce packaging fait, et ne fait pas

- Il empaquette le moteur existant **sans modifier son code métier** (agents
  IA, FFmpeg, contrôle des dépenses).
- C'est un conteneur de type **job à la demande** : il exécute une
  production, puis se termine. **Ce n'est pas un service permanent**, et il
  ne sonde pas Supabase — ce mécanisme de déclenchement sera conçu dans une
  phase future, séparément.
- Sans argument (comportement par défaut de l'image), le moteur affiche son
  état et se termine en code 2, **sans aucun appel payant** — vérifié par
  lecture du code (`src/orchestrator/mvp.js`, le mode LIVE complet exige
  explicitement `--dry-run` ou `--research-script`).

## Fichiers

- `Dockerfile` — image du worker. **Contexte de build = racine du dépôt**
  (pas ce dossier), car l'image doit copier `package.json`, `src/`,
  `scripts/` et `config/` depuis la racine.
- `../.dockerignore` — à la racine du dépôt (pas ici), pour correspondre au
  contexte de build ci-dessus. Exclut notamment tout fichier `.env*` réel,
  `node_modules/`, `.git/`, et le projet `animated-shorts/`.
- `../docker-compose.nomad-studio.yml` — configuration isolée, séparée de
  celle de n8n (réseau et volumes dédiés, aucun port publié).
- `worker.env.example` — noms de variables attendues, **sans aucune
  valeur réelle**.

## Tests prévus (aucun exécuté dans cette mission — Docker non disponible sur
cette machine, constaté par `which docker` sans résultat)

**Test A — Construction Docker locale** (nécessite Docker) :
```
docker compose -f docker-compose.nomad-studio.yml build
```
Vérifier que l'image se construit, que `ffmpeg -version` et `ffprobe
-version` répondent à l'intérieur, et qu'aucun secret n'apparaît dans les
couches (`docker history nomad-studio-worker:local`).

**Test B — Exécution sans appel payant** (nécessite Docker) :
```
docker compose -f docker-compose.nomad-studio.yml run --rm nomad-studio-worker
```
`NO_API=1` est la valeur par défaut dans `docker-compose.nomad-studio.yml`
lui-même (pas seulement dans `worker.env.example`). `ANTHROPIC_API_KEY` et
`ELEVENLABS_API_KEY` ne sont **pas obligatoires** pour ce test : vérifié par
lecture du code (`src/services/anthropic.js`, `createMessage` refuse tout
appel dès que `NO_API=1`, **avant** toute lecture ou validation de la clé) —
non vérifié par une exécution réelle, Docker étant absent de cette machine.

**Test C — Benchmark FFmpeg** (nécessite Docker, hors de cette mission) :
rendu d'une fixture existante du dépôt (`src/fixtures/`), mesure de la durée,
du CPU/RAM observés et de l'espace disque utilisé.

**Test D — Validation sur Hostinger** : uniquement après un nouveau GO
explicite, avec surveillance de l'impact sur n8n.

**Test E — Reprise et sécurité** : redémarrage du conteneur pendant un rendu
simulé, vérification que `projects/` (volume persistant) conserve le journal
d'appels, et que `NO_API=1` bloque bien toute nouvelle tentative après
redémarrage.

## Prérequis encore manquants (hors périmètre de ce packaging)

- Mécanisme de déclenchement sécurisé (n8n → Supabase → lancement du job
  Docker) : non implémenté.
- Approvisionnement automatisé des médias d'entrée (`/app/media`, monté en
  lecture seule) : non implémenté — le moteur attend déjà un dossier
  entièrement préparé (`--media-dir`), par conception.
- Transfert des vidéos finales (`/app/output`) vers un stockage objet
  externe : non implémenté.

## Volumes : fonctionnement détaillé et limites

Les quatre volumes déclarés dans `docker-compose.nomad-studio.yml` ont des
rôles distincts, détaillés ici conformément à la demande de clarification :

1. **`/app/media` (lecture seule) — comment les médias y arriveront.**
   Aujourd'hui, **aucun composant autorisé ne dépose automatiquement de
   fichiers dans ce volume** : c'est un volume Docker vide tant qu'un futur
   composant (hors périmètre de ce packaging) ne vient pas l'alimenter —
   par exemple un petit outil qui téléchargerait les médias choisis par un
   administrateur depuis Supabase/un stockage objet avant le lancement du
   job. Le moteur, lui, ne fait que **lire** ce dossier (`--media-dir`),
   jamais y écrire (cohérent avec le montage `:ro`).
2. **Comment le worker les lira.** Exactement comme en local aujourd'hui :
   `--media-dir=/app/media`, avec les sous-dossiers `assets/` et `voice/`
   attendus par `src/media/local-media.js` (vérifié dans le code, inchangé).
3. **Conflits entre plusieurs productions.** Ce volume est partagé par
   toutes les exécutions du worker : si deux productions utilisaient le même
   volume en même temps, leurs fichiers d'entrée pourraient se mélanger.
   **Pour cette phase**, la contrainte « une seule production lourde à la
   fois » (déjà posée en B2-CLOUD-1) doit être respectée strictement pour
   éviter ce risque — aucune solution multi-production n'est mise en place
   ici.
4. **Préserver les journaux d'idempotence.** `nomad-studio-projects` reste
   le seul volume à ne jamais purger ni recréer sans précaution : c'est lui
   qui porte `calls.json` et `call-cache/`, la garantie anti-double-
   facturation déjà vérifiée dans `call-guard.js`.
5. **Éviter la saturation des 100 Go du VPS.** Aucune purge automatique n'a
   été implémentée ici (conformément à l'interdiction de supprimer des
   journaux sans politique validée) — une surveillance de l'espace disque et
   une politique de rétention explicite restent un prérequis **opérationnel
   séparé**, pas résolu par ce packaging seul.

## Note sur le contexte de build et les secrets

Le `.dockerignore` (à la racine du dépôt) sert de deuxième couche de
protection, mais la protection principale est que le `Dockerfile` ne copie
que 5 chemins explicitement nommés (`package.json`, `package-lock.json`,
`src/`, `scripts/`, `config/`) — jamais `COPY . .`. Un fichier sensible non
listé dans `.dockerignore` ne serait donc copié dans l'image que s'il se
trouvait déjà sous un de ces 5 chemins, ce qui n'est le cas d'aucun secret
réel de ce dépôt (les jetons OAuth et données locales de l'agent vivent sous
`data/`, jamais copié).

## Vers une architecture multi-moteurs (proposition, non implémentée)

Nomad Studio est pensé pour accueillir, à terme, plusieurs moteurs vidéo
indépendants (documentaire, shorts animés « Karim & Lina », futurs formats),
partageant une infrastructure commune (Norixo/Vercel, Supabase, n8n) mais
exécutés par des **workers Docker spécialisés et distincts** :

```
Nomad Studio (infrastructure commune)
  → Supabase   : file de tâches, états, budgets — par moteur
  → n8n        : planification et notifications — communes
  → Workers Docker, un par moteur :
       - documentary-worker        (ce packaging, moteur "Les Découvertes du Nomade")
       - animated-shorts-worker    (futur, moteur Karim & Lina, non construit)
       - future-video-worker-*     (futurs moteurs)
```

Chaque worker garde sa propre image, ses propres dépendances, sa propre
configuration de ressources CPU/RAM et ses propres répertoires temporaires —
**ce Dockerfile documentaire ne doit pas devenir une image générique** pour
plusieurs moteurs : un moteur, une image. Sur un même VPS (ex. Hostinger
KVM 2), une limite globale de concurrence (un seul rendu lourd, tous moteurs
confondus, à la fois) reste nécessaire tant que les ressources sont
partagées — à concevoir séparément, pas dans ce packaging.

**Rien de cette architecture n'est construit à ce stade** : ni le worker
Karim & Lina, ni la file de tâches Supabase, ni la limite de concurrence
inter-moteurs. Cette section documente seulement la direction prévue.
