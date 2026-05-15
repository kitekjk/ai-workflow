# AI Development Workflow System - Development Requirements

## 1. Background

The goal is to build an AI-assisted development workflow system that coordinates product planning, design, implementation, review, testing, deployment, and QA across Jira and GitHub.

The initial exploration used n8n as a workflow orchestrator. n8n was useful for quickly visualizing and editing steps, but its execution UI was not sufficient for deeply nested parent-child workflow visibility. In particular, the desired process requires one HLD to fan out into multiple LLDs, and each LLD to fan out into multiple Specs. A parent execution should be observable as a full tree, including child executions and their current states.

Because of this, the preferred direction is shifting toward a custom metadata-driven workflow system with an editable workflow canvas, a dedicated execution engine, and an integrated status dashboard. n8n may remain useful for experiments or peripheral automation, but should not be assumed to be the core production workflow engine.

## 2. Primary Objective

Build a system that enables AI-assisted planning, design, development, review, testing, deployment, and QA while preserving human control, traceability, and reviewability.

The system should support:

- Jira-driven intake and work tracking
- GitHub-based artifact and code review
- AI-generated PRD, HLD, LLD, Spec, code, review, and test outputs
- Quality gates with scoring, feedback, and retry
- Parent-child workflow execution
- Fan-out and fan-in orchestration
- A human-readable execution dashboard
- Editable workflow definitions driven by metadata

## 3. Agreed Process Flow

The high-level workflow is:

```text
Operational development requests
→ PRD
→ HLD
→ LLD
→ Spec
→ Development
→ Code review
→ Test
→ Dev deployment
→ QA
```

The target hierarchy is:

```text
PRD Initiative
  → HLD Epic
    → LLD Story
      → Spec / Dev / Review / Test Task
```

The fan-out structure is:

```text
One PRD
  → One HLD
    → Multiple LLDs
      → Multiple Specs per LLD
        → Development / review / test per Spec
```

## 4. Jira Model

Jira should be used as the business and work-tracking source of truth.

Recommended issue type mapping:

```text
PRD        = Initiative
HLD        = Epic
LLD        = Story
Spec+      = Task
```

Operational team requests should remain as original request issues. They should be linked to the PRD Initiative rather than replaced by the PRD.

Each generated or managed work item should store or link:

- Project key
- Artifact type
- Parent Jira key
- Source artifacts
- Target repository
- Target path
- Quality score
- Gate status
- Agent job ID
- GitHub PR URL
- Workflow execution/run ID

## 5. Repository Ownership

Repository ownership should match team responsibility.

### PRD Repository

Owner: planning/product team

Contains:

- PRD documents
- Original request grouping and rationale
- PRD quality gate results
- Planning approval history

### Backend Repository

Owner: development team

Contains:

- `system-hld.md`
- Backend LLDs
- API Specs
- Backend implementation
- Backend tests

The HLD is stored in the backend repository, but it should represent the whole system, not only backend concerns.

The HLD should include:

- System overview
- User and operator flows
- Domain model
- Backend/frontend responsibility boundary
- API contract draft
- Screen-to-API mapping
- Data flow
- Auth and permission flow
- Error handling policy
- Non-functional requirements
- Deployment and operation considerations

### Frontend Repository

Owner: development team

Contains:

- Frontend LLDs
- Screen Specs
- Component Specs
- Frontend implementation
- Frontend tests
- References to the canonical HLD in the backend repository

Frontend artifacts should reference the source HLD by repository, path, and commit.

## 6. Artifact Traceability

All generated artifacts should include metadata/frontmatter where possible.

Example:

```yaml
---
project_key: OPS-123
artifact_type: lld
jira_issue: BE-LLD-001
source_prd_repo: org/prd-repo
source_prd_commit: abc123
source_hld_repo: org/backend-repo
source_hld_path: docs/projects/OPS-123/system-hld.md
source_hld_commit: def456
target_repo: org/backend-repo
quality_score: 88
gate_status: approved
---
```

This enables traceability from Jira to generated documents, GitHub PRs, commits, and downstream implementation.

## 7. Quality Gate Requirements

Each AI-generated artifact should pass a quality gate before progressing.

Quality gates should produce structured output:

```json
{
  "score": 88,
  "pass": true,
  "threshold": 85,
  "feedback": [
    "Clarify non-functional requirements",
    "Add exception handling for payment timeout"
  ]
}
```

Recommended behavior:

- Writer agent generates the artifact.
- Critic/evaluator agent scores it against a rubric.
- If the score is below threshold, the artifact is revised and re-scored.
- Retries should be limited by `max_attempts`.
- Human approval should remain available at major gates.

Recommended human approval gates:

- PRD approval by planner/product owner
- HLD approval by lead developer/architect
- LLD approval by domain owner
- Spec approval by developer/planner as needed
- Code review approval by human reviewer
- QA approval by QA or operations owner

## 8. Workflow Engine Direction

The workflow should be metadata-driven rather than hardcoded.

Workflow definitions should be represented as YAML or JSON and should be editable through a UI.

Example workflow definition:

```yaml
id: hld_to_lld_spec_pipeline
name: HLD to LLD/Spec Pipeline

nodes:
  - id: hld_approved
    type: trigger
    label: HLD Approved

  - id: split_lld
    type: fanout
    label: Split HLD into LLDs
    runner: planner.split_lld

  - id: lld_child
    type: child_workflow
    label: LLD Generate and Gate
    workflow: child_lld_generate_gate
    input: each

  - id: fanin_lld
    type: fanin
    label: Wait for all LLDs

  - id: split_spec
    type: fanout
    label: Split LLD into Specs
    runner: planner.split_spec

  - id: spec_child
    type: child_workflow
    label: Spec Generate and Gate
    workflow: child_spec_generate_gate
    input: each

edges:
  - from: hld_approved
    to: split_lld
  - from: split_lld
    to: lld_child
  - from: lld_child
    to: fanin_lld
  - from: fanin_lld
    to: split_spec
  - from: split_spec
    to: spec_child
```

Workflow definitions should be versioned, ideally in Git.

## 9. Workflow Editor Requirements

The system should provide an editable workflow UI similar in spirit to n8n, but specialized for this AI development process.

The editor should support:

- Canvas-based node and edge visualization
- Node creation, deletion, and ordering
- Node configuration editing
- Quality gate threshold editing
- Retry policy editing
- Agent runner selection
- Jira issue type mapping
- GitHub repository and path mapping
- Approval gate configuration
- Workflow versioning

The editor does not need to be a general-purpose automation tool. It should support a limited set of domain-specific node types.

Initial node types:

```text
trigger
agent_job
quality_gate
approval
fanout
fanin
child_workflow
jira_update
github_pr
deploy
manual_task
```

React Flow is a strong candidate for the canvas/editor implementation.

## 10. Execution Dashboard Requirements

n8n's default execution UI did not provide sufficient visibility into nested child workflows. The custom system should include a dedicated execution dashboard.

The dashboard should show the full execution tree:

```text
OPS-123
  PRD Initiative      approved
  HLD Epic            approved
    BE-LLD-001        done
      BE-SPEC-001     done
      BE-SPEC-002     running
    BE-LLD-002        failed
      BE-SPEC-003     blocked
    FE-LLD-001        done
      FE-SPEC-001     done
```

Each row should show:

- Current state
- Artifact type
- Jira issue
- GitHub PR
- Agent job
- Quality score
- Started/finished time
- Retry count
- Error message if any
- Links to logs and artifacts

The dashboard should support:

- Tree view
- Filtering by project, state, artifact type, repo, owner
- Retry failed step
- Cancel or pause running step
- Open Jira issue
- Open GitHub PR
- Open artifact
- View quality gate report

## 11. Execution State Model

The execution model should support parent-child workflow runs and work items.

Suggested core entities:

```text
workflow_definitions
workflow_runs
work_items
artifact_versions
quality_gate_results
status_events
agent_jobs
external_links
```

Suggested work item fields:

```text
id
parent_id
run_id
project_key
artifact_type
jira_key
target_repo
target_path
state
score
attempts
agent_job_id
github_pr_url
started_at
finished_at
error
```

The status ledger should be treated as the operational execution source of truth. Jira remains the business/work source of truth. GitHub remains the artifact/code source of truth.

## 12. Agent Runner Requirements

The agent runner should be designed as a general execution platform rather than multiple hardcoded runner types.

The workflow app should call the runner with:

- Goal
- Context references
- Skill ID and version
- Policy
- Credential scope
- Required outputs

The runner's behavior should be determined by the selected versioned skill and execution policy.

### Runner and Skill Model

The runner should use a skill registry.

Conceptual separation:

```text
Runner      = execution platform
Skill       = versioned capability package
Job         = workflow-requested work item
Plan        = runner's internal skill execution plan
Tool        = external system adapter or local capability
Engine      = Claude CLI, Codex CLI, or another code agent engine
```

Skills should be packaged and versioned independently from workflow definitions.

Example skill package:

```text
skills/prd.simple/
  skill.json
  prompt.md
  templates/
  tests/
```

Skill metadata should describe:

- Skill ID and version
- Input and output contract
- Default engine
- Required permissions
- Prompt/template references
- Compatibility constraints

Workflow definitions should reference explicit skill versions rather than a floating latest version when reproducibility matters.

### Claude CLI Execution Direction

For code-agent execution, the preferred initial direction is to run Claude CLI in headless mode rather than calling the Claude API directly.

Rationale:

- Claude CLI already provides a code-agent execution harness.
- The runner does not need to implement the full tool loop, file editing loop, shell feedback loop, and context management from scratch.
- OAuth-based Claude CLI authentication can be used for local and automation-account based execution.
- The runner can focus on workspace isolation, skill injection, logging, permissions, outputs, and status events.

The runner should treat Claude CLI as an engine adapter:

```text
Agent Runner
  Engine Adapters
    claude_cli
    codex_cli
    raw_api_later
```

For automation usage, a dedicated automation Claude account may be used instead of a personal developer account. The automation account should be isolated to the runner environment and should not be shared as a general developer login.

### Runner Scheduler

The workflow app should not directly execute long-running runner work in-process. It should create an `agent_job`, and an agent runner scheduler should claim and execute jobs.

Recommended flow:

```text
Workflow App
  -> create agent_job
  -> link job to workflow_run/work_item
  -> observe status_events and final result

Runner Scheduler
  -> claim pending job
  -> lock job for one runner
  -> start runner executor
  -> update heartbeat/status
  -> handle timeout, retry, cancellation, and stale jobs

Runner Executor
  -> prepare workspace
  -> load skill package
  -> run engine adapter such as Claude CLI
  -> collect logs, artifacts, diffs, and results
  -> emit status_events
```

Initial scheduler responsibilities:

- Pending job polling or queue subscription
- Atomic job claim/lock
- Concurrency limits
- Timeout enforcement
- Retry scheduling
- Cancellation detection
- Heartbeat updates
- Stale job recovery
- Status and result updates

Suggested agent job states:

```text
pending
claimed
running
succeeded
failed
retry_scheduled
cancel_requested
cancelled
timed_out
```

Current state should be stored on `agent_jobs`. Full execution history should be stored in `status_events`.

For an MVP, PostgreSQL polling with atomic claim semantics is acceptable. Later, the scheduler may move to Redis, RabbitMQ, Temporal, or a cloud queue if needed.

### Credential and Permission Model

The runner should own execution credentials, not the workflow app.

Credential scope should be passed as part of the job policy, and the runner should resolve the actual secrets through a credential provider.

Credential types may include:

- Claude CLI OAuth session for a runner automation account
- Codex or OpenAI credentials
- GitHub App installation token or bot token
- Jira automation user token/OAuth
- Wiki/Confluence automation token/OAuth

Skills should request capabilities, not raw secrets.

Example:

```yaml
permissions:
  - claude_cli.execute
  - github.repo.read
  - github.repo.write
  - jira.issue.read
```

The runner should record which credential scope was used, but should never store secret values in status events, logs, artifacts, or workflow definitions.

### Runner Observability

Each runner execution should produce durable records:

```text
runs/{run_id}/{job_id}/
  input.json
  prompt.md
  events.ndjson
  stdout.log
  stderr.log
  result.json
  outputs/
```

The exact storage location can later move to object storage, but the logical structure should remain.

Runner events should support the execution dashboard and debugging:

```text
job.accepted
job.claimed
job.started
skill.loaded
engine.started
artifact.generated
quality_gate.scored
job.retrying
job.completed
job.failed
job.cancelled
```

## 13. n8n Findings

n8n was tested locally through Docker Compose with Postgres.

The exported n8n workflow experiments are kept under:

```text
workflows/experiments/n8n/
```

Findings:

- n8n is useful for fast workflow sketching.
- n8n makes workflow steps easy to edit visually.
- Parent-child workflow execution is possible.
- HLD to LLD to Spec fan-out was demonstrated.
- Child workflows must be published/active before being called.
- n8n's execution UI does not show a complete parent-child execution tree in one place.
- Running child executions may not expose detailed current internal node state until completion.
- The current Docker image resolved to `2.20.7-exp.0`, and execution viewing showed temporary instability.

Conclusion:

```text
n8n is useful for prototyping and peripheral automation.
n8n should not be the primary production execution dashboard.
The production core should be a custom metadata-driven workflow system.
```

## 14. Proposed System Architecture

Recommended direction:

```text
Custom Workflow App
  - metadata-driven workflow definitions
  - workflow editor
  - execution engine
  - execution dashboard
  - status ledger
  - Jira/GitHub sync

Agent Runner
  - runner scheduler
  - skill registry
  - Claude CLI / Codex CLI engine adapters
  - AI document generation
  - quality gate evaluation
  - code generation
  - code review
  - test generation/execution
  - Git operations

Jira
  - work tracking
  - business approval state
  - issue hierarchy

GitHub
  - document/code artifacts
  - PR review
  - CI status

n8n
  - optional/prototyping
  - external webhook adapter
  - Slack/email/peripheral automation
```

## 15. MVP Direction

The MVP should prove the custom workflow approach without building a full n8n clone.

Recommended MVP:

1. Define workflows in YAML/JSON metadata.
2. Render workflow definitions as a read-only or lightly editable canvas.
3. Implement HLD to LLD to Spec fan-out/fan-in.
4. Implement a status ledger.
5. Implement execution tree dashboard.
6. Add an `agent_jobs` model.
7. Add a simple runner scheduler that claims and runs pending jobs.
8. Add a demo skill that generates a simple PRD from a short requirement.
9. Run the demo skill through Claude CLI in headless mode.
10. Add local runner execution records and status events.
11. Add quality gate placeholder scoring.
12. Add links for Jira/GitHub placeholders.
13. Add retry and failure states.
14. Later connect real Jira, GitHub, Wiki, and expanded agent runner behavior.

## 16. Open Questions

The following topics still need design decisions:

- Agent job API shape
- Skill package schema and versioning rules
- Runner scheduler implementation: DB polling, queue, Temporal, or other
- Whether runner executor is embedded initially or always a separate process
- Database choice
- Workflow definition storage: DB, Git, or both
- Approval workflow details
- GitHub PR strategy for generated documents
- Jira field mapping
- Human override and manual correction flow
- Authentication and authorization model for runner credentials
- Deployment topology
- Claude CLI automation account operation and usage-limit policy

## 17. Next Discussion Topic

The next design discussion should focus on the agent runner scheduler, skill package schema, and Claude CLI execution environment.

Key questions:

- What should the `agent_jobs` schema look like?
- How should the scheduler claim, lock, retry, and cancel jobs?
- What should the first formal skill package schema include?
- Should the runner execute each job in an isolated workspace?
- How should it interact with GitHub repositories?
- How should it report progress to the status ledger?
- How should it handle retries, cancellation, and partial failure?
- How should prompts, model versions, and outputs be versioned?
- How much autonomy should code-writing agents have?
