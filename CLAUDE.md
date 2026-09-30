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
