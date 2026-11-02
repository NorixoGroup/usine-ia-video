# État du projet — 2 novembre 2026

## Projet
Les Découvertes du Nomade
EP01 — Australie
Documentaire YouTube français, narration en voix off.

## Source éditoriale
~/Desktop/Les-Decouvertes-du-Nomade/EP01-Australie/
01_MASTER_SCRIPT/MASTER_SCRIPT_V2.1_Australie.txt

Le Master Script V2.1 est la référence éditoriale.
Ne pas modifier sans validation du propriétaire.

## Narration G01 à G04
G01 : audio approuvé, durée observée 159,838 s.
G02 : audio approuvé, durée observée 117,725 s.
G03 : audio approuvé, durée observée 147,354 s.
G04 : audio généré, écoute et approbation encore à confirmer.

JSON présents dans narration/approved/ pour G01 à G04.
La présence d'un JSON approuvé ne signifie pas
automatiquement que son audio a été approuvé.

## Narration G05 à G13
12 brouillons JSON créés dans :
narration/drafts/australia-ep01/

G05 : p01 + p02
G06 : un bloc
G07 : p01 + p02
G08 : un bloc
G09 : un bloc
G10 : un bloc
G11 : un bloc
G12 : un bloc
G13 : p01 + p02

Tous les 12 blocs sont DRAFT_NOT_APPROVED.
Aucun appel ElevenLabs pour ces blocs.

## Travail réalisé
- Extraction des sections du Master Script.
- Exclusion de l'annexe bibliographique de G13.
- Découpage des blocs sous 2500 caractères.
- Création des brouillons avec SHA256.
- Audit initial des nombres, sigles et noms anglais.

## Prochaines actions
1. Adapter les 12 textes à la narration orale française.
2. Vérifier les faits et les prononciations.
3. Valider éditorialement les textes.
4. Auditer le système de génération et les garde-fous.
5. Construire un producteur batch sûr et reprenable.
6. Demander une autorisation explicite avant les appels payants.
7. Écouter et approuver les audios générés.

## Interdictions
Ne pas regénérer G01 à G04 automatiquement.
Ne pas produire G05 à G13 tant que les textes
et le système batch ne sont pas validés.
