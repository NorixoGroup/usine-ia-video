# Instructions des agents — Usine IA Vidéo

## Priorité
Lire CLAUDE.md avant toute intervention. Ce fichier complète
CLAUDE.md et ne remplace aucune règle existante.

## Reprise du projet
Lire dans cet ordre :
1. docs/agent-handoff/PROJECT_STATUS.md
2. docs/agent-handoff/NARRATION.md
3. docs/agent-handoff/ELEVENLABS.md
4. Les scripts et JSON réellement présents dans le dépôt.

## Règles impératives
- Ne jamais lancer d'API payante sans autorisation explicite.
- NO_API=1 signifie aucun appel API réel.
- Ne jamais écraser un audio ou un JSON approuvé.
- Ne jamais considérer un brouillon comme approuvé.
- Vérifier les chemins, scripts et fichiers avant exécution.
- Préférer les opérations idempotentes et reprenables.
- Conserver la provenance, les SHA256 et les journaux d'appels.
- Ne pas inventer de résultats de tests ou d'écoutes audio.
- Respecter les consignes existantes de CLAUDE.md.
- Après une étape validée, actualiser PROJECT_STATUS.md.
- Ne pas effectuer de commit ou de push sans instruction.

## Communication
Expliquer les coûts potentiels avant génération.
Présenter les commandes et les risques avant exécution.
Privilégier des étapes vérifiables et économes en tokens.
