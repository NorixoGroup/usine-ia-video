# USINE IA VIDEO — PROJECT RULES

Global Claude Code rules remain applicable. This file adds only video-factory-specific constraints.

## Context

Use `/video-factory-context` when pipeline context is needed. Start from the relevant config, implementation component, and matching smoke/check.

## Generated Runs

`projects/` contains generated run artifacts.

Do not recursively scan, summarize, modify, delete, or regenerate runs by default. Inspect only a specifically relevant run when the task requires it.

## Providers and External Effects

Treat real provider/API calls, paid generation, external publication, uploads, and production-like pipeline execution as high-impact actions requiring explicit approval.

Do not interpret provider configuration as proof that a real provider integration exists. Verify the implementation.

## Secrets

Do not read or expose `.env.local` or secrets unless the user explicitly approves a secrets/configuration investigation and the access is necessary.

Never print secret values into responses, logs, fixtures, tests, or committed files.

## Pipeline Execution

Prefer targeted smokes and validators.

Do not run `npm run mvp`, real media generation, provider-backed narration, publication, or other broad/external pipeline execution merely for diagnosis.

## Scope Discipline

A change to one agent or pipeline stage does not authorize unrelated changes to other agents, stages, generated runs, providers, or configuration.


## Agent Handoff — Documentary Production

For Les Découvertes du Nomade / EP01 Australia,
read AGENTS.md and the following documents before work:

- docs/agent-handoff/PROJECT_STATUS.md
- docs/agent-handoff/NARRATION.md
- docs/agent-handoff/ELEVENLABS.md

These documents provide operational context, not authorization
to perform external actions.

CLAUDE.md and global Claude Code rules remain authoritative.
Do not broadly scan projects/ or inspect secrets.

Verify the actual repository state before trusting handoff notes.
Update PROJECT_STATUS.md after an approved milestone.

Never trigger paid APIs, provider-backed media generation,
uploads or publication without explicit user authorization.
