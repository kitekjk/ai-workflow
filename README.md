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
  apps/workflow-app/            Workflow App frontend
  backend/src/                  Workflow API, scheduler, runner, domain code
  docs/                         Requirements, notes, and design decisions
  scripts/                      Local runner demos and helper scripts
  skills/                       Versioned skill package experiments
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

See `docs/development-requirements.md` for the current requirements summary and
`docs/deployment-runbook.md` for deployment, local runner, and MySQL migration
operations.

## Existing Demos

- `apps/workflow-app/`: React Workflow App for execution visibility and
  control-plane actions.
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

The MVP identifies human actions by email fields such as `requestedBy`,
`actor`, `author`, and `LOCAL_RUNNER_OWNER_EMAIL`; that is enough for
assignment, audit, and dashboard attribution. New PRD intake jobs are assigned
to the requester email so a matching local runner can claim only that owner's
work. The older `LOCAL_RUNNER_OWNER_USER_ID` name remains as a compatibility
alias. The dashboard Actor field sends that email on intake, feedback,
revision, and approval API actions, and the dashboard log mixes in persisted
workflow events so actor metadata appears in the execution ledger. The
dashboard also reads `GET /runners` to show connected managed/local runners
and their claim diagnostics, and the scheduler enforces each runner's
configured concurrency before issuing another claim. Bearer auth is optional
and only turns on when tokens are configured. Use it later if the API is
exposed beyond localhost:

```bash
WORKFLOW_APP_API_TOKEN=app-secret
WORKFLOW_RUNNER_TOKENS=runner-yourname-laptop:runner-secret
LOCAL_RUNNER_TOKEN=runner-secret
```

Use the MySQL-backed scheduler/document runtime for runner APIs:

```bash
WORKFLOW_RUNTIME_STORE=mysql npm run start:api
```

In MySQL mode, `WORKFLOW_RUNNER_OFFLINE_AFTER_MS` controls when a runner is
shown and treated as offline after its last heartbeat. It defaults to twice
`WORKFLOW_JOB_LEASE_MS`. `WORKFLOW_SCHEDULER_RECOVERY_MS` controls the
in-process scheduler loop that recovers expired claimed/running job leases back
to `retrying`. It defaults to `1000`; set it to `0` or `disabled` only when a
separate scheduler process owns lease recovery.

`GET /runners` and no-job `POST /runners/{runnerId}/claim` responses include
diagnostics such as `claim_available`, `runner_offline`,
`runner_capacity_full`, `no_available_job`, or `no_matching_job`. Runner list
responses promote capacity-full online runners to `busy` for dashboard/operator
visibility. The local runner prints those fields as `claimReason`,
`claimMessage`, and `nearestBlocker` in its idle JSON log.
Operators can pause and resume registered runners with
`POST /runners/{runnerId}/pause` and `POST /runners/{runnerId}/resume`. A paused
runner is stored as `disabled`; heartbeat and repeated registration keep it
disabled until an explicit resume, so a running local process cannot
accidentally reclaim work after an operator pause.

Run the repeatable MySQL no-fixture smoke when MySQL is available:

```bash
npm run smoke:mysql:no-fixture
```

The smoke command applies migrations by default, starts an in-process
no-fixture Workflow API, intakes a unique `PRD-SMOKE-*` stub PRD, registers a
scoped local runner using `SMOKE_ACTOR_EMAIL`, drains the generated draft and
quality jobs through the local runner execution path, approves the PRD through
the approval-gate API, drains downstream routing, HLD generation/evaluation,
HLD approval fan-out, LLD generation/evaluation, LLD approval fan-out, Spec
generation/evaluation, Spec approval, implementation PR creation, and PR status
collection. The final smoke verifies the PRD/HLD/LLD/Spec documents are
approved and that pull request artifacts were recorded for the generated Specs.

For local end-to-end runner checks against a running API, set
`LOCAL_RUNNER_MAX_JOBS` instead of `LOCAL_RUNNER_ONCE=true`. The runner will
claim and execute up to that many eligible jobs, then exit when it becomes idle
or reaches the limit.

Before starting a local runner on a new machine, run:

```bash
npm run doctor:local-runner
```

The doctor command validates `WORKFLOW_API_BASE_URL`, local runner identity,
owner email, capability/engine scope, required Claude/Codex CLI command,
GitHub implementation settings, and workspace writability without registering
or claiming work. It exits non-zero when a required setup item is missing.

In MySQL mode, PRD compatibility workflow actions are also mirrored into the
workflow/document read-model tables after state-changing API calls. API startup
then hydrates the PRD compatibility fixture from those MySQL read-model rows
before routes are served. Generic workflow and document GET views read directly
from the MySQL read model when `WORKFLOW_RUNTIME_STORE=mysql`. Set
`WORKFLOW_COMPATIBILITY_FIXTURE=disabled` with MySQL mode to run the
read-model-backed GET views and runner APIs without the legacy PRD fixture;
local stub mode can still intake the seeded `PRD-100` issue through a stub Jira
reader for smoke checks, while real mode reads Jira through the configured Jira
client. Remaining PRD transition endpoints return `501` until the
repository-backed transition engine replaces them. PRD intake is also written
through a MySQL command path for the initial run, document, and draft job.
Workflow/App, Jira, and Wiki feedback plus explicit revision
requests are also written through a MySQL command path for `feedback_item` and
revision `workflow_job` rows. Approval state changes and downstream
routing/fan-out/implementation job scheduling have a MySQL command path for the
affected `document` and `workflow_job` rows. Engine-created document state
changes and follow-up jobs are recorded through one command transaction during
the internal compatibility workflow tick loop, including an explicit engine
transition type plus work item and external issue before/after state metadata
and affected work item/document ids for later repository-backed engine
migration. The loop defaults to `WORKFLOW_INTERNAL_TICK_MS=1000` while the
compatibility fixture is enabled; set it to `0` or `disabled` to keep only the
manual dev/test `POST /tick` trigger. Runner result processing also records the
run projection for
`workflow_job_result`, `document_version`, `artifact`, `quality_gate_result`,
and current document pointers. With the compatibility fixture disabled,
repository-backed result transitions also run from an internal repository loop
controlled by `WORKFLOW_REPOSITORY_TRANSITION_MS` so completed runner results
can advance workflow state without a manual `/tick`. When that loop is enabled,
runner result requests only persist the result; the loop owns the workflow
state transition to avoid duplicate processing. If the loop is disabled, the
API keeps the request-time transition path as a fallback. Operators and the
dashboard can also trigger one repository transition explicitly with
`POST /repository-transitions/process-next`; this is useful for local
development when a bounded runner drain wants the next follow-up job to become
claimable immediately.

To run that transition loop outside the API process, set
`WORKFLOW_REPOSITORY_TRANSITION_MS=0` on the API and run:

```bash
WORKFLOW_REPOSITORY_TRANSITION_WORKER_ID=transition-worker-a \
npm run start:repository-transition-worker
```

Multiple transition workers coordinate through the MySQL
`workflow_transition_claim` lease table. Successful transitions close the claim
as `processed`; workers that lose a race for the oldest result retry within the
same polling wave so later visible results can still be claimed.

Example API calls:

```bash
curl -X POST http://127.0.0.1:3000/prd/intake \
  -H 'content-type: application/json' \
  -d '{"prdJiraKey":"PRD-100"}'

curl http://127.0.0.1:3000/state/PRD-100
```

`POST /tick` remains available as a manual development/test trigger, but the
normal fixture-backed API process advances the workflow through its internal
tick loop.

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
