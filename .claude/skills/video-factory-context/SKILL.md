---
name: video-factory-context
description: Route usine-ia-video investigations efficiently without scanning generated production runs or unrelated pipeline components.
---

# Video Factory Context Router

Use this skill when investigating or changing the usine-ia-video pipeline.

## Goal

Understand the requested pipeline area with minimal repository exploration and minimal context usage.

## Start Here

Configuration:
- `config/agents.json` — orchestrator and agent configuration.
- `config/pipeline.json` — project, video, pipeline, and provider configuration.
- `config/research.json` — web search, source policy, and research limits.

Implementation:
- `src/orchestrator/` — pipeline orchestration and resume/artifact flow.
- `src/agents/` — research, script, visual, asset, voice, assembly, and quality agents.
- `src/services/` — external/provider service boundaries and call guard.
- `src/media/` — local media and probing.
- `src/render/` — timeline and FFmpeg rendering.
- `src/utils/` — validators, repair helpers, and duration utilities.

Validation:
- Search `scripts/*-smoke.js` for the component being changed.
- Prefer the narrowest relevant smoke/check before broader execution.
- `npm run check` runs the environment check.
- `npm run mvp` runs the MVP orchestrator; do not run it merely for diagnosis.

## Generated Runs

`projects/` contains generated production runs.

Do NOT recursively scan, summarize, or load all of `projects/`.

Inspect a run only when:
- the user identifies it,
- the current task requires evidence from a run, or
- targeted investigation identifies one specific relevant run.

When a run is needed, inspect only the relevant files inside that run.

## Efficiency Rules

- Search first; read targeted files/ranges.
- Start from the relevant config, implementation component, and matching smoke test.
- Do not inspect unrelated agents or pipeline stages by default.
- Do not read `.env.local` unless the user explicitly approves a secrets/configuration investigation where it is necessary.
- Reuse established facts instead of repeating repository-wide diagnostics.

Follow the project's global approval, scope, Git, and safety rules for all modifications.
