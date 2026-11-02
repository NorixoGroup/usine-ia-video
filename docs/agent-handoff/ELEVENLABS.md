# ElevenLabs — Configuration et sécurité

## Configuration utilisée
Modèle : eleven_multilingual_v2
Voice ID : UBXZKOKbt62aLQHhc1Jm

## Fichiers techniques connus
src/utils/narration-override.js
scripts/produce-elevenlabs-australia-s01-g04.js
scripts/prepare-australia-narration-batch.py

Vérifier leur présence et leur contenu avant utilisation.

## Validation existante
NARRATION_OVERRIDE_MAX_TEXT_LENGTH = 2500.
La liste actuelle des unités autorisées peut être
limitée à s01-g01, s01-g02, s01-g03, s01-g04.

Les identifiants des blocs G05/G07/G13 utilisent
des suffixes p01 et p02. Vérifier la compatibilité
du validateur, du producteur et des journaux.

## Garde-fous
- Aucun appel payant sans accord explicite.
- Utiliser NO_API=1 pour les contrôles sans API.
- Vérifier STRICT_CAP et les plafonds d'appels.
- Examiner calls.json avant chaque génération.
- Empêcher les appels doublons.
- Ne pas écraser les MP3 existants.
- Ne pas écraser les JSON approuvés.
- Vérifier les SHA256 avant génération.
- Arrêter le batch en cas d'erreur ambiguë.
- Prévoir la reprise sans régénérer les blocs terminés.

## État
Le producteur G04 existe.
Un producteur batch G05-G13 n'est pas encore confirmé.
Ne pas supposer qu'un script générique existe.

## Principe
Préparation -> validation éditoriale -> contrôle technique
-> autorisation de dépense -> génération -> écoute
-> approbation -> journalisation.
