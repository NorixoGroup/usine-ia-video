# Nomad Studio — worker vidéo (moteur documentaire "Les Découvertes du Nomade")
#
# Image de type JOB : exécute node src/orchestrator/mvp.js une fois, avec les
# arguments fournis au lancement, puis se termine avec un code de sortie
# exploitable. Ce n'est pas un service permanent et ce n'est pas un sondeur
# Supabase : ce mécanisme sera conçu séparément.
#
# Contexte de build attendu : la RACINE du dépôt (voir docker-compose.nomad-studio.yml
# à la racine, build.context: . / build.dockerfile: nomad-studio-worker/Dockerfile).
# Le .dockerignore associé se trouve donc à la racine du dépôt, pas dans ce dossier.

FROM node:22-bookworm-slim

# Dépendances système minimales, vérifiées nécessaires par lecture du code :
#   - ffmpeg (fournit aussi ffprobe) : src/render/ffmpeg-renderer.js, src/media/probe.js
#   - git                           : utilisé par scripts/check-environment.js
#   - tini                          : PID 1, relaie SIGTERM/SIGINT à Node (le moteur
#                                     lui-même n'a pas de gestionnaire de signal explicite —
#                                     tini ne garantit pas un arrêt applicatif propre, il
#                                     garantit seulement que le signal est transmis au bon
#                                     processus plutôt qu'ignoré par PID 1).
#   - ca-certificates               : connexions HTTPS sortantes (Anthropic, ElevenLabs)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg git tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Utilisateur non-root dédié, UID/GID fixes et stables, sans shell de connexion.
RUN groupadd --gid 10001 nomadworker \
  && useradd --uid 10001 --gid nomadworker --no-create-home --shell /usr/sbin/nologin nomadworker

WORKDIR /app

# Installation npm reproductible, à partir du lockfile uniquement.
# Une seule dépendance de production (@anthropic-ai/sdk), aucune devDependencies :
# aucun appel réseau payant n'est déclenché par cette étape (npm ci télécharge
# uniquement le paquet depuis le registre npm public, pas d'API tierce du projet).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Code du moteur documentaire uniquement. Le code métier (agents, FFmpeg,
# call-guard, etc.) n'est pas modifié : il est copié tel quel.
COPY src ./src
COPY scripts ./scripts
COPY config ./config

# Répertoires de travail attendus par le moteur (confirmés dans mvp.js et
# scripts/check-environment.js), créés avec les permissions de l'utilisateur
# non-root. Ils seront normalement remplacés par des volumes montés (voir
# docker-compose.nomad-studio.yml) ; ces instructions garantissent seulement
# qu'ils existent et sont inscriptibles si aucun volume n'est monté.
RUN mkdir -p tmp output projects \
  && chown -R nomadworker:nomadworker /app

USER nomadworker

# Aucune clé API, aucun jeton, aucun fichier .env n'est copié dans cette image
# (voir .dockerignore à la racine du dépôt). Toute configuration est injectée
# à l'exécution via des variables d'environnement ou des secrets Docker.

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/orchestrator/mvp.js"]

# Commande de job explicite par défaut : sans argument, le moteur affiche son
# usage et se termine (dry-run implicite — confirmé dans mvp.js, aucun appel
# réel sans --mode=full --real-calls-cap=<N> explicites). Les arguments réels
# d'une production sont fournis en remplaçant cette commande au lancement
# (docker run <image> --media-dir=... --render ... ou via "command:" dans
# Compose), pas en modifiant cette image.
CMD []
