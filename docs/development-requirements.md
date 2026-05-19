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

The canonical high-level workflow is:

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

After PRD approval, the workflow does not always need to start at HLD. A PRD
routing job should analyze the confirmed PRD and choose the earliest safe
downstream artifact: HLD, LLD, or Spec.

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
  → HLD, LLD, or Spec routing decision
    → HLD when multiple domains or architecture boundaries are affected
      → Multiple LLDs
        → Multiple Specs per LLD
    → LLD when multiple use cases in one domain need implementation design
      → Multiple Specs per LLD
    → Spec when one use case/API can be specified directly
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

### Stage 1: PRD Confirmation Workflow

The first workflow stage is to confirm a PRD from one or more operational
request Jira tickets. This is a planner-owned workflow. AI can assist with
drafting, evaluation, revision, and traceability, but the planner or product
owner should retain control over grouping, final content, and approval.

Recommended starting model:

```text
Operational request Jira tickets
  -> Planner reviews and groups requests in Jira
  -> Planner creates PRD Jira ticket in Jira
  -> Planner links source request tickets to the PRD ticket in Jira
  -> Workflow App intakes PRD ticket
  -> Workflow Engine reads linked source requests
  -> PRD draft generation job
  -> Runner Skill commits draft directly to PRD repo main
  -> Runner Skill publishes or updates PRD wiki page
  -> PRD evaluation job
  -> AI or planner revision loop
  -> Planner/PO approval through Jira status transition
  -> PRD confirmed in Jira
  -> Downstream HLD/LLD/Spec workflow can start
```

The Workflow App should not create PRD Jira tickets or own request grouping in
v1. The planner creates the PRD ticket directly in Jira and explicitly links the
source operational request tickets there. The Workflow App intakes an existing
PRD ticket and starts the PRD confirmation workflow from that Jira context.

The initial PRD Jira ticket should be treated mostly as a container for the
grouping decision. It may not contain PRD content yet. The source operational
request tickets are expected to contain the actual request details, context,
constraints, and desired outcomes. PRD draft generation should therefore read
the linked request tickets as the primary input and use the PRD ticket metadata
as grouping, ownership, and workflow context.

The Workflow App may later recommend candidate request groupings or create PRD
tickets on behalf of planners, but that should be an extension rather than the
initial responsibility. Grouping operational requests into one PRD is a
planning/product decision and should be explicit in Jira through issue links, a
structured field, or both.

Recommended PRD Jira ticket fields or links:

```text
issue_type: Initiative or PRD
source_request_links: one or more operational request Jira keys
initial_prd_body: optional, may be empty in v1
target_repositories: PRD/backend/frontend repositories as needed
business_owner: planner or product owner
approval_owner: planner, PO, or designated approver
workflow_definition_id: prd_confirmation
workflow_run_id: populated by Workflow App
prd_repo_url: populated after draft commit
prd_wiki_url: populated after wiki publish
quality_score: populated after evaluation
gate_status: draft | evaluating | needs_revision | approved | rejected
downstream_route: HLD | LLD | Spec, populated after PRD approval
downstream_route_confidence: high | medium | low
downstream_route_reason: short human-readable summary
```

PRD confirmation responsibilities:

- Operational team creates individual request Jira tickets.
- Planner decides which request tickets belong in a PRD.
- Planner creates or updates the PRD Jira ticket directly in Jira and links
  source requests.
- Workflow App/Engine validates that the PRD ticket has at least one linked
  source request, imports source request snapshots, and creates internal work
  items.
- Runner Worker skills generate PRD drafts, commit directly to the PRD repo,
  publish wiki pages, apply wiki/Jira feedback revisions, and run evaluations,
  but do not update Jira.
- Workflow Engine records runner results, updates Jira, and creates revision
  work when needed.
- Planner or PO approves the confirmed PRD before downstream development
  workflows begin.

PRD intake validation should check:

- The PRD Jira ticket exists and is readable.
- The PRD Jira ticket has at least one linked operational request ticket.
- Each linked source request ticket is readable.
- Required ownership fields are present or can be inferred.
- The PRD ticket is not already bound to an active workflow run unless the user
  is explicitly resuming or retrying that run.
- The source request snapshots are stored before generation starts so the PRD
  draft can be reproduced later.

PRD confirmation trigger options:

```text
v1 manual:
  Planner enters PRD Jira key in Workflow App or clicks "Generate PRD".

v1 polling-ready:
  Workflow App can later poll JQL for PRD tickets with a status or label such
  as PRD Requested / ai-prd-requested.

later webhook:
  Jira webhook starts the same internal intake command.
```

PRD evaluation behavior:

- The PRD draft should be evaluated against a planning rubric.
- If the score passes the threshold, the PRD moves to planner approval.
- If the score fails, the workflow should not automatically rewrite the PRD from
  the same incomplete inputs.
- The quality gate result should produce missing information, clarification
  questions, risk items, and concrete revision guidance.
- Workflow Engine should mark the PRD ticket as needs_revision or create a
  clarification/revision Jira ticket when separate human ownership is needed.
- A PRD revision job should run only after the planner or requester provides
  additional input and explicitly asks the workflow to apply feedback.
- Approval should be an explicit Jira status transition before HLD generation
  starts.

PRD wiki feedback behavior:

- Wiki feedback revision should be explicitly triggered in v1.
- The planner should signal that wiki feedback is ready by using a Workflow App
  action, Jira status transition, Jira comment command, or another explicit
  command.
- Workflow Engine should then create a `prd.apply_feedback_revision` runner
  job.
- Runner Skill should read the wiki feedback, Jira comments, or additional
  planner input, apply the revision to the PRD repo, update the wiki page, and
  report a structured revision summary back as runner result data.
- Workflow Engine should then decide whether to run another quality evaluation,
  request planner clarification, or move toward approval.
- Wiki polling or webhook-based automatic feedback detection can be added later,
  but should not be required for v1.

PRD approval behavior:

- Jira status transition should be the v1 source of truth for final PRD
  approval.
- A planner or PO approves the PRD by moving the PRD Jira ticket to the agreed
  approved status.
- Workflow Engine should consume that approval through manual refresh, polling,
  or a later webhook.
- Workflow Engine should update the PRD Jira ticket with the final PRD repo
  link, final wiki link, final quality score, gate status, and downstream
  workflow readiness.
- HLD/LLD/Spec workflows must not start until the PRD Jira ticket reaches the
  approved status.

PRD downstream routing behavior:

- After PRD approval, Workflow Engine should create a `prd.route_downstream`
  internal work item and runner job.
- The routing job should read the confirmed PRD artifact, PRD Jira metadata,
  linked operational request snapshots, and any target repository context.
- The routing job should estimate `usecase_count`, `domain_impact_count`, and
  whether the change is a single API or entrypoint-centered modification.
- The primary routing rule is:

```text
domain_impact_count >= 2
  -> start at HLD

domain_impact_count == 1 and usecase_count >= 2
  -> start at LLD

domain_impact_count == 1 and usecase_count == 1 and the change is a single
API/entrypoint-centered modification
  -> start at Spec

unable to determine confidently
  -> start at LLD or ask for clarification, depending on risk
```

- A domain should count as impacted only when its model, policy, state,
  ownership boundary, transaction behavior, or event/API contract changes.
  Read-only lookup or display of another domain's data should be recorded as a
  dependency, but should not automatically force HLD.
- A use case should be estimated from independent user actions, APIs,
  scheduled jobs, message consumers/producers, state-changing commands, or
  independently testable acceptance criteria.
- Escalate from Spec to LLD even for one use case when the PRD implies DB schema
  changes, state-transition design, concurrency/transaction design, compensation
  logic, external integration behavior, or a non-trivial policy change.
- Escalate from LLD to HLD when the PRD changes cross-domain policy, domain
  ownership, state propagation, service boundaries, platform architecture, or
  multi-team responsibilities.
- The routing job may also set `adr_needed: true` when a technology or
  architecture decision must be resolved before HLD/LLD/Spec work can proceed.

Recommended routing result schema:

```yaml
route: HLD | LLD | Spec
confidence: high | medium | low
usecase_count: 1
domain_impact_count: 1
domains:
  - Order
reasons:
  - Single Order API use case can be specified directly.
dependencies:
  - Payment is read-only dependency, not an impacted domain.
adr_needed: false
needs_clarification:
  - Confirm whether Payment status is updated or only read.
next_work_items:
  - type: Spec
    suggested_jira_parent: PRD-123
    source_prd_url: https://example.invalid/prd/PRD-123
```

Jira handling for PRD routing:

- The routing job implementation should be tracked by its own Jira ticket,
  because it is a reusable workflow capability rather than a one-off PRD task.
- Per-PRD routing results should be written as structured comments and fields on
  the PRD Jira ticket.
- A separate HLD/LLD/Spec Jira ticket should be created only after routing
  determines the next human-owned work item.
- Do not create a separate Jira issue for every routing runner execution. Store
  job-level details in `agent_jobs`, `agent_job_results`, `status_events`, and
  the PRD Jira comment.
- If confidence is low or required ownership is unclear, Workflow Engine should
  either create a clarification task or mark the PRD as blocked for downstream
  routing rather than silently choosing HLD/LLD/Spec.

PRD artifact ownership:

```text
PRD Git repository
  - canonical PRD source
  - runner skill commits drafts and revisions directly to main
  - commit history provides traceability and rollback
  - PR/merge flow is not required for v1 because Jira is the approval source of
    truth

Wiki page
  - immediately published review/share copy
  - runner skill creates or updates the page whenever the PRD draft changes
  - planners review the wiki page because Git review is not assumed
  - wiki is not the canonical source, but it is the primary human review surface

Workflow artifact store
  - runner logs, raw outputs, quality reports, snapshots, and intermediate
    execution artifacts
  - not the canonical PRD source

Jira PRD ticket
  - workflow status, gate status, approval status, source request links,
    PRD repo link, wiki link, quality score, and comments
```

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

### Jira, Workflow, and Runner Ownership

Every runner job should have a primary Jira tracking context before execution
starts. Multiple runner jobs may share the same Jira issue when they are
execution steps within the same human-owned work item. The Workflow App/Engine
is responsible for assigning that primary Jira key, creating a new Jira ticket
only when a separate human-owned work item, approval, clarification, or revision
needs to be tracked independently.

Ownership rules:

- Jira is the business/work-tracking source of truth.
- Workflow App/Engine is the orchestration source of truth.
- GitHub is the artifact/code-review source of truth.
- Runner workers are execution units and should not directly create, update,
  transition, comment on, or link Jira issues.
- Jira mutations should go through a Jira Adapter owned by the Workflow
  App/Engine boundary.
- Runner workers may receive Jira keys as context and may emit structured
  results, artifacts, logs, status events, and change requests.

The normal creation flow is:

```text
Workflow Engine
  -> determine next work item
  -> determine primary Jira tracking context
  -> create a separate Jira ticket only when the work requires independent
     human ownership or tracking
  -> create or update internal work_item
  -> create agent_job with primary_jira_key and work_item_id
  -> scheduler dispatches job to runner worker
```

The normal completion flow is:

```text
Runner Worker
  -> write status_events
  -> write artifacts and final structured result
  -> mark agent_job as terminal or blocked

Workflow Engine
  -> consume runner result
  -> update work_item state
  -> update primary Jira ticket/comment/status/link
  -> decide next workflow node
```

Jira ticket creation rules:

- Create a Jira ticket for a human-owned work unit such as PRD, HLD, LLD, Spec,
  Dev, Test, Deployment, QA, or an approval gate when that unit needs independent
  tracking.
- Do not create a separate Jira ticket for every runner job. PRD generation,
  PRD quality evaluation, feedback-based PRD revision, and PRD repository
  commits can all share the same PRD Jira ticket.
- Create a separate Jira ticket when additional information is needed from an
  operational requester, when a planner must perform a substantial manual
  revision, when an approved upstream artifact needs a formal change request,
  or when work must move to a different owner/team.
- Store job-level traceability in `agent_jobs`, `agent_job_results`,
  `status_events`, and comments/links on the primary Jira ticket rather than
  creating Jira issue noise for every execution step.

### Upstream Revision Tickets

When lower-level work discovers that an upstream artifact must change, the
runner should not modify the upstream Jira issue directly. It should emit a
structured change request. The Workflow Engine should create a separate Jira
ticket for that revision and link it to both the source work item and the
upstream artifact issue.

Example:

```text
Dev job finds a Spec problem
  -> runner emits change_request(target_artifact_type=spec)
  -> engine marks Dev ticket blocked or waiting
  -> engine creates Spec Revision ticket
  -> engine links Dev ticket, original Spec ticket, and Spec Revision ticket
  -> engine starts a revision workflow
  -> original Dev work resumes or is replanned after revision approval
```

Recommended issue relationship:

```text
Original request issue
  -> PRD Initiative
    -> HLD Epic
      -> LLD Story
        -> Spec/Dev/Test Task

Revision/Change Request Task
  -> links to affected upstream artifact issue
  -> links to blocking downstream issue
  -> may create follow-up runner jobs through a revision workflow
```

This keeps the main Jira hierarchy stable while preserving a clear audit trail
for feedback discovered during downstream execution.

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
external_issues
work_item_jira_links
artifact_versions
quality_gate_results
status_events
agent_jobs
agent_job_results
change_requests
workflow_engine_inbox
workflow_engine_outbox
external_links
```

Suggested work item fields:

```text
id
parent_id
run_id
project_key
artifact_type
primary_jira_key
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

Suggested relationship model:

```text
external_issues
  - stores Jira issue snapshots and sync metadata
  - can represent operational request issues, generated artifact issues, and
    revision/change-request issues

work_items
  - internal execution tree node
  - must have a primary Jira tracking context before runner execution
  - may map to one generated artifact, manual gate, runner job, or integration
    action

work_item_jira_links
  - maps work items to Jira issues
  - supports primary, parent, source_request, upstream_artifact,
    downstream_blocker, revision, and related roles

agent_jobs
  - executable unit created by Workflow Engine
  - references work_item_id and primary_jira_key
  - claimed by Scheduler and executed by Runner Worker

agent_job_results
  - final structured result emitted by Runner Worker
  - includes output status, artifacts, quality data, and change requests

change_requests
  - structured request to revise upstream artifacts or workflow state
  - created from runner result data
  - processed by Workflow Engine, which may create separate Jira revision
    tickets and follow-up workflows

workflow_engine_inbox
  - durable queue for runner result events, approval commands, retry requests,
    cancel requests, and adapter results that still need engine processing

workflow_engine_outbox
  - durable queue for side effects such as Jira mutations, GitHub mutations,
    notification events, and scheduler-visible job creation
```

Runner workers should write status and results to MySQL rather than calling the
Workflow API directly. Workflow Engine should consume durable inbox/outbox
records and process them idempotently. This avoids fragile HTTP callback
handling, keeps progress recoverable after process restarts, and preserves a
single orchestration path for manual commands, runner results, and integration
side effects.

## 12. Agent Runner Requirements

The agent runner should be designed as a general execution platform rather than multiple hardcoded runner types.

The workflow app should call the runner with:

- Goal
- Context references
- Primary Jira key
- Work item ID
- Skill ID and version
- Policy
- Credential scope
- Required outputs

The runner's behavior should be determined by the selected versioned skill and execution policy.

The runner should treat Jira and GitHub references as execution context, not as
ownership of those systems. Runner output should be structured enough for the
Workflow Engine to decide whether to update Jira, create revision tickets,
re-run upstream steps, resume blocked work, or stop for human approval.

Runner result data should support:

```json
{
  "status": "succeeded | failed | blocked | needs_revision",
  "summary": "Human-readable execution summary",
  "artifacts": [],
  "quality": {
    "score": 0,
    "pass": false,
    "feedback": []
  },
  "change_requests": [
    {
      "target_artifact_type": "spec",
      "target_jira_key": "PROJ-123",
      "reason": "The API error contract is ambiguous.",
      "requested_change": "Clarify validation error response format.",
      "blocking_current_job": true
    }
  ]
}
```

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

The workflow app should not directly execute long-running runner work in-process. It should create an `agent_job`, and an agent runner scheduler should claim jobs and dispatch them to runner workers.

Recommended flow:

```text
Workflow App
  -> create agent_job
  -> link job to workflow_run/work_item
  -> observe status_events and final result

Runner Scheduler
  -> claim pending job
  -> lock job for one runner
  -> dispatch job to a separate runner worker process
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
- Dispatch to a separate runner worker process
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

For v1, MySQL polling with atomic claim semantics is the preferred scheduler
foundation because the company infrastructure supports MySQL and DynamoDB.
The scheduler should rely on transactional row claiming, short lock windows,
heartbeats, and stale-job recovery. DynamoDB can be considered later for
high-volume event storage or queue-like workloads if operational needs justify
it, but the initial relational execution model should target MySQL.

The scheduler and runner worker should be separate processes. The scheduler is
responsible for job discovery, claiming, locking, retry timing, cancellation
detection, and stale-job recovery. Runner workers are responsible for long-lived
AI execution, workspace preparation, engine adapter invocation, artifact
collection, and detailed execution logs. This separation keeps lock management
and orchestration lightweight while allowing runner capacity, isolation, and
credentials to be scaled independently.

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

### Process Topology

The usable v1 should run as separate processes where the separation has
operational value, but avoid unnecessary service fragmentation. The target
local and deployment topology is:

```text
frontend
workflow-api
workflow-engine
scheduler
runner-worker
mysql
```

Process responsibilities:

- `workflow-api`: HTTP API, authentication, user commands, dashboard reads,
  Jira intake requests, approval/retry/cancel/pause commands.
- `workflow-engine`: workflow definition interpretation, state transitions,
  runner result processing, branching, fan-out/fan-in, approval gates,
  change-request handling, and creation of agent jobs.
- `scheduler`: MySQL-backed job claiming, locking, heartbeat monitoring,
  timeout detection, retry timing, cancellation detection, stale-job recovery,
  and dispatch to runner workers.
- `runner-worker`: long-running AI execution, workspace preparation, skill
  loading, engine adapter execution, artifact collection, logs, results, and
  status event emission.
- `frontend`: workflow dashboard, execution tree, event ledger, workflow
  definition views, and operator controls.

Jira and GitHub integration should be module boundaries, not separate v1
processes. The same applies to artifact storage, workflow definition import,
and engine inbox processing. These concerns should be written as isolated
packages or commands so they can become dedicated workers later if needed,
without adding process complexity now.

### Module Boundaries

The codebase should be modular even when processes remain limited:

```text
packages/domain
packages/db
packages/workflow-dsl
packages/workflow-runtime
packages/runner-contract
packages/jira-adapter
packages/github-adapter
packages/artifact-store
packages/config
packages/logger

tools/workflow-importer
tools/db-migrate
tools/seed-demo
```

Important ownership rules:

- Jira/GitHub side effects are owned by Workflow App/Engine modules, not runner
  workers.
- Runner workers may emit structured results, artifacts, status events, and
  change requests, but should not directly create or update Jira tickets.
- Workflow definitions are canonical in Git YAML/JSON and imported into MySQL
  for execution and dashboard queries.
- MySQL is the v1 operational store for workflow runs, work items, agent jobs,
  status events, imported definitions, and adapter state.

## 15. Usable V1 Direction

The first release should be usable for real internal workflow execution, not a
minimal throwaway demo. It should prove the custom workflow approach while
supporting varied development workflows such as task-size classification,
branching, document generation, implementation, review, testing, deployment,
and QA.

Recommended v1 scope:

1. Define workflows in Git-versioned YAML/JSON metadata.
2. Import workflow definitions into MySQL for execution, search, and dashboard
   queries while keeping Git as the canonical source.
3. Implement core node types: trigger, decision, branch, agent_job,
   quality_gate, approval, fanout, fanin, child_workflow, jira_update,
   github_pr, test, deploy, and manual_task.
4. Implement the planner-owned PRD confirmation workflow from linked
   operational request Jira tickets.
5. Implement task-size classification and branching so small, medium, and large
   development requests can follow different paths.
6. Implement parent-child workflow runs and work item trees.
7. Implement a durable status ledger in MySQL.
8. Implement the execution tree dashboard against real execution state.
9. Add the `agent_jobs` model and job contract.
10. Add a MySQL-backed runner scheduler that claims and runs pending jobs.
11. Add separate runner worker processes with support for versioned skill
    packages.
12. Run document-generation, quality-gate, review, and code-agent jobs through
    Claude CLI or Codex CLI engine adapters.
13. Add local or object-storage-ready runner execution records and status
    events.
14. Add Jira read/create/update integration, with manual Jira issue intake first
    and polling/webhook trigger support layered in later.
15. Add GitHub artifact and PR links.
16. Add retry, failure, cancellation, timeout, and stale-job recovery states.
17. Add human approval and override flows at major gates.

## 16. Open Questions

The following topics still need design decisions:

- Agent job API shape
- Skill package schema and versioning rules
- Runner scheduler implementation details for MySQL polling, including claim
  query shape, lock timeout, heartbeat interval, retry timing, and concurrency
  limits
- DynamoDB usage, if any, for event storage or high-volume operational records
- Workflow definition import/cache details for Git canonical source plus MySQL
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
