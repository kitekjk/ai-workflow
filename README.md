# ai-workflow

Workspace for building a custom AI-assisted development workflow system.

The project originally explored n8n as a workflow orchestrator, but the current
direction is a custom metadata-driven workflow app with a dedicated agent
scheduler, agent runner, and execution dashboard. n8n exports are kept only as
historical experiments and reference material.

## Goals

- Define reusable workflow metadata for AI-assisted development.
- Build a workflow app that can edit definitions and show execution state.
- Build an agent scheduler that claims, retries, cancels, and tracks jobs.
- Build an agent runner that executes versioned skills through code-agent
  engines such as Claude CLI or Codex CLI.
- Preserve traceability across Jira, GitHub, generated artifacts, quality gates,
  and execution logs.

## Structure

```text
ai-workflow/
  docs/                         Requirements, notes, and design decisions
  scripts/                      Local runner demos and helper scripts
  skills/                       Versioned skill package experiments
  ui-execution-dashboard-demo/  Frontend execution dashboard demo
  workflows/experiments/n8n/    Archived n8n workflow experiments
```

## Current Direction

The production system is expected to have three major parts:

1. **AI Workflow App**: metadata-driven workflow definitions, workflow editor,
   execution dashboard, status ledger, and Jira/GitHub visibility.
2. **Agent Scheduler**: pending job polling or queue subscription, atomic claim,
   locking, concurrency limits, retries, cancellation, heartbeat, timeout, and
   stale job recovery.
3. **Agent Runner**: skill registry, execution records, workspace preparation,
   engine adapters, artifact collection, and status event emission.

See `docs/development-requirements.md` for the current requirements summary.

## Existing Demos

- `ui-execution-dashboard-demo/`: frontend-only mock dashboard for nested
  workflow execution visibility.
- `scripts/agent-runner-demo.mjs`: local demo runner that executes the
  `skills/prd.simple` package through Claude CLI.
- `npm run demo:prd`: TypeScript vertical slice for PRD confirmation workflow
  orchestration with stubbed Jira, Git, Wiki, scheduler, and runner behavior.

## Local Checks

Install root dependencies:

```bash
npm install
```

Run the PRD confirmation tests:

```bash
npm test -- tests/prd-confirmation.test.ts
```

Run the PRD confirmation demo:

```bash
npm run demo:prd
```

Run the local Workflow API:

```bash
npm run start:api
```

Example API calls:

```bash
curl -X POST http://127.0.0.1:3000/prd/intake \
  -H 'content-type: application/json' \
  -d '{"prdJiraKey":"PRD-100"}'

curl -X POST http://127.0.0.1:3000/tick

curl http://127.0.0.1:3000/state/PRD-100
```

Run with real Jira, PRD repo, and Confluence adapters:

```bash
cp .env.example .env
# Fill JIRA_*, PRD_REPO_*, and CONFLUENCE_* values.
INTEGRATION_MODE=real npm run start:api
```

In real mode, Jira is still manually triggered:

```bash
curl -X POST http://127.0.0.1:3000/prd/intake \
  -H 'content-type: application/json' \
  -d '{"prdJiraKey":"YOUR-PRD-KEY"}'
```

Choose the PRD runner skill with `RUNNER_SKILL_MODE`:

- `stub`: deterministic local fake skill, useful for API demos.
- `adapter`: template-based PRD markdown committed to the PRD repo and
  published to Confluence.
- `cli`: Claude CLI or Codex CLI generates, evaluates, and revises the PRD
  document; the workflow then commits the markdown and publishes the wiki page.

Example CLI-backed run:

```bash
INTEGRATION_MODE=real
RUNNER_SKILL_MODE=cli
RUNNER_ENGINE=claude # or codex
CLAUDE_CLI_PATH=claude
CODEX_CLI_PATH=codex
RUNNER_CLI_TIMEOUT_MS=120000
RUNNER_OUTPUT_LANGUAGE=ko
npm run start:api
```

The CLI runner uses `scripts/prd-cli-engine.mjs` as a bridge. It sends the PRD
job context to the selected CLI and requires the final answer to be a JSON
object. Draft and revision jobs must include `markdown`; quality jobs must
include a `status` such as `passed` or `needs_revision`.

Confluence publishing is implemented as a generic markdown page publisher.
Current PRD jobs still expose PRD-shaped artifacts for workflow compatibility,
but the wiki layer accepts `documentType` values such as `prd`, `hld`, `lld`,
and `adr`.

The n8n Docker setup and exported workflows remain in the repository for
comparison and migration reference, not as the planned production runtime.
