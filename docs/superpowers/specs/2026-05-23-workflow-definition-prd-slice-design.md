# Workflow Definition Metadata-ization: PRD Slice

- **Date:** 2026-05-23
- **Status:** Approved (brainstorming phase complete; implementation planning next)
- **Slice shape:** Vertical thin, PRD-only, Full interpreter
- **Successor slices (out of scope here):** HLD/LLD/Spec/Code definition-ization, Workflow Editor UI, ADR routing depth, definition RBAC

## 1. Background

`docs/development-plan.md` §3.2 and `docs/development-requirements.md` §8 state that workflow definitions should be metadata-driven, externalized to Git-versioned YAML/JSON, and imported into MySQL for execution and dashboard queries. Today, the PRD workflow is encoded across four places:

- `backend/src/workflow-core/domain.ts:76` — `prdConfirmationWorkflowPolicy` constant (approval, retry, feedback policy).
- `backend/src/workflow-core/domain.ts:30-41` — `WorkflowCommandJobType` union (job-type catalog).
- `backend/src/workflow-api/repository-transition-planner.ts` (1442 LOC) — stage transition decisions.
- `backend/src/workflow-api/workflow-intake-command.ts` — entry-stage selection.

Adding a new workflow today requires code change and redeploy. The future Workflow Editor (M5) is blocked on the metadata layer not existing yet.

This slice externalizes the PRD workflow to a single canonical YAML definition and replaces PRD-specific transition logic with a generic interpreter. Other workflows (HLD/LLD/Spec/Code) are unchanged.

## 2. Goals

1. PRD workflow described by a single Git-versioned YAML file at `workflows/definitions/prd-confirmation.v1.yaml`.
2. A pure `interpretWorkflowEvent()` function consumes a definition + run state + event and returns next transitions/jobs/external actions.
3. Engine routes PRD events through the interpreter; behavior is observationally equivalent to the existing hardcoded path.
4. Definitions are imported into MySQL on startup and on demand; workflow runs are pinned to a specific definition version at creation time.
5. Existing 325 tests pass without modification (the equivalence oracle).

## 3. Non-goals

See §10 for the full Out-of-scope register. Highlights:

- No changes to HLD/LLD/Spec/Code workflows in this slice.
- No Workflow Editor UI; no definition edit API; no definition RBAC.
- No fan-out/fan-in expressivity in the definition schema yet (transitions are 1:1).
- No removal of `WorkflowEngineTransitionType` PRD-prefixed events in this slice — emit both legacy and new stage events in parallel; remove later.
- No refactor of the existing 2931-line `server.ts` or 1442-line transition planner beyond what is required to call the interpreter.

## 4. Approach: Translator-first replace-in-place

Of three candidates considered — (1) translator-first replace-in-place, (2) stage-by-stage migration with dual paths, (3) shadow-execute with diffing — we adopt **(1)**.

Rationale:

- The existing 325-test suite (including `smoke-mysql-no-fixture`) is a strong behavioral oracle.
- The project is pre-production, so the shadow-execute cost (option 3) is not justified.
- Long-lived dual code paths (option 2) reproduce exactly the `legacy/prd-confirmation/*` situation the project is already actively cleaning up.
- "Replace-in-place" does not mean "one giant commit": the work is split into two PRs (§7).

The name "translator-first" refers to translating *behavior* into a YAML definition by hand. The hardcoded logic is not auto-extracted; the equivalence proof comes from passing the existing test suite plus the explicit gap-fill tests added in pre-flight (§8.2).

## 5. Definition Schema

### 5.1 YAML canonical example

```yaml
# workflows/definitions/prd-confirmation.v1.yaml
id: prd-confirmation
version: 1
name: PRD Confirmation Workflow
documentTypes: [prd]
entryStage: prd.draft

policy:
  approvalSource: jira_status
  qualityFailureAction: human_clarification
  revisionTrigger: explicit_request
  feedbackSources: [app, jira, wiki, github]

stages:
  prd.draft:
    label: PRD 초안 작성
    jobTemplate:
      jobType: prd.generate_draft
      runner:
        requiredCapability: document.generate
        requiredSkill: { id: prd.simple, versionRange: "^0.1" }
      retry: { maxAttempts: 3, backoffMs: 5000 }
    on:
      success: prd.quality
      failure: prd.failed

  prd.quality:
    label: PRD 품질 평가
    jobTemplate:
      jobType: prd.evaluate_quality
      runner: { requiredCapability: document.evaluate }
      threshold: 85
    on:
      passed: prd.approval
      needsRevision: prd.needs_revision

  prd.needs_revision:
    label: 수정 필요
    type: feedback_wait
    on:
      feedbackReceived: prd.revise

  prd.revise:
    label: PRD 수정
    jobTemplate:
      jobType: prd.apply_feedback_revision
      runner: { requiredCapability: document.revise }
    on:
      success: prd.quality

  prd.approval:
    label: 승인 대기
    type: approval_gate
    approval:
      role: planner
      via: jira_status
      jiraTransition:
        pending: 승인 대기
        approved: 승인 완료
        rejected: 취소됨
        needsRevision: 수정 필요
    on:
      approved: prd.routing
      rejected: prd.failed

  prd.routing:
    label: 하위 단계 라우팅
    jobTemplate:
      jobType: prd.route_downstream
      runner: { requiredCapability: prd.route }
    on:
      routeDecided: completed                  # result.status === "route_decided"
      needsScopeConfirmation: prd.scale_clarification  # result.status === "needs_scope_confirmation"

  prd.scale_clarification:
    label: 규모 확인 필요
    type: manual_decision
    on:
      decided: completed

  completed:
    type: terminal
    kind: completed

  prd.failed:
    type: terminal
    kind: failure
```

### 5.2 TypeScript types

Location: `backend/src/workflow-definition/schema.ts`.

```ts
export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  documentTypes: WorkflowDocumentType[];
  entryStage: string;
  policy: WorkflowPolicyConfig;
  stages: Record<string, WorkflowStage>;
}

export type WorkflowStage =
  | RunnableStage
  | ApprovalGateStage
  | FeedbackWaitStage
  | ManualDecisionStage
  | TerminalStage;

export interface RunnableStage {
  label: string;
  type?: "runnable";
  jobTemplate: JobTemplate;
  on: Partial<Record<JobOnKey, string>>;
}

export interface ApprovalGateStage {
  label: string;
  type: "approval_gate";
  approval: ApprovalConfig;
  on: Partial<Record<"approved" | "rejected" | "needsRevision", string>>;
}

export interface FeedbackWaitStage {
  label: string;
  type: "feedback_wait";
  on: { feedbackReceived: string };
}

export interface ManualDecisionStage {
  label: string;
  type: "manual_decision";
  on: { decided: string };
}

export interface TerminalStage {
  type: "terminal";
  kind: "completed" | "failure";
}

export interface JobTemplate {
  jobType: WorkflowCommandJobType; // existing literal union, reused
  runner: { requiredCapability: string; requiredSkill?: SkillRequirement };
  threshold?: number;
  retry?: { maxAttempts: number; backoffMs?: number };
}

export type JobOnKey =
  | "success" | "failure"
  | "passed" | "needsRevision"
  | "routeDecided" | "needsClarification";
```

### 5.3 Key design decisions

- **YAML canonical, JSON normalized in DB.** Author/edit YAML for human readability; engine consumes the parsed object identically.
- **Stages are an explicit graph keyed by string ID** so the future Editor can map 1:1 to nodes/edges without a separate intermediate representation.
- **`jobType` reuses the existing `WorkflowCommandJobType` literal union** to keep type safety end-to-end. Definitions reference job types by literal string; the schema validator checks them at import time.
- **`on:` keys match `result.status` values directly**, so existing skill output schemas (already returning `passed` / `needs_revision` / `route_decided` / `needs_clarification`) wire in without translation.
- **Approval gates are first-class stages**, not a separate gate table. Same for feedback-wait and manual-decision states.
- **Two terminal stage kinds**: `completed` (success) and `failure` (rejected / unrecoverable). Workflow_run end semantics differ.

## 6. Interpreter

### 6.1 Signature (pure function)

Location: `backend/src/workflow-definition/interpreter.ts`.

```ts
export function interpretWorkflowEvent(
  input: WorkflowInterpreterInput
): WorkflowInterpreterOutput;

export interface WorkflowInterpreterInput {
  definition: WorkflowDefinition;
  runState: WorkflowRunState;
  event: WorkflowInterpreterEvent;
}

export interface WorkflowRunState {
  runId: string;
  currentStageId: string;
  currentTaskId: string;
  attemptCounts: Record<string, number>; // stageId → attempts so far
  metadata: Record<string, unknown>;     // jira key, document id, etc.
}

export type WorkflowInterpreterEvent =
  | { type: "job.completed"; jobType: WorkflowCommandJobType; result: WorkflowJobResult }
  | { type: "feedback.received"; feedback: FeedbackItem }
  | { type: "approval.changed"; status: "approved" | "rejected" | "needs_revision" }
  | { type: "manual.decision"; decision: string };

export interface WorkflowInterpreterOutput {
  transitions: StageTransition[];        // 0 or 1 (multi for future fan-out)
  jobsToCreate: JobCreationRequest[];
  externalActions: ExternalAction[];     // jira transitions, wiki banner
  terminal: { kind: "completed" | "failed"; reason: string } | null;
  unmatchedEvent?: { stageId: string; eventType: string; eventStatus?: string };
}

export interface StageTransition {
  fromStageId: string;
  toStageId: string;
  reason: string; // for status_events ledger
}

export interface JobCreationRequest {
  jobType: WorkflowCommandJobType;
  taskId: string;
  input: Record<string, unknown>;
  retry?: { maxAttempts: number; backoffMs?: number };
}

export type ExternalAction =
  | { type: "jira.transition"; issueKey: string; toStatus: string }
  | { type: "jira.comment"; issueKey: string; body: string }
  | { type: "wiki.banner"; documentId: string; banner: string };
```

### 6.2 Event-to-`on:` matching rules

| Event | Stage type | `on:` key matched |
|---|---|---|
| `job.completed`, `jobType` matches stage `jobTemplate.jobType`, `result.status="succeeded"` | runnable | `on.success` |
| same as above, `result.status="failed"` and `attemptCounts[stageId] < maxAttempts - 1` | runnable | (retry: same stage, same jobType) |
| same as above, `result.status="failed"` and retry budget exhausted | runnable | `on.failure` |
| same as above, `result.status="passed"` | runnable | `on.passed` |
| same as above, `result.status="needs_revision"` | runnable | `on.needsRevision` |
| same as above, `result.status="route_decided"` | runnable | `on.routeDecided` |
| same as above, `result.status="needs_scope_confirmation"` | runnable | `on.needsScopeConfirmation` |

**Note on existing skill output contract.** Today the `prd.route_downstream` runner emits `status: "needs_scope_confirmation"` for the clarification path and uses an implicit `succeeded` for the success path. To make the success-vs-clarification split observable through the `on:` key matching, the skill output contract is updated in PR 1 to emit `status: "route_decided"` explicitly on success. Output fields (`route`, `rationale`, etc.) remain unchanged. The corresponding update is small and lives in `scripts/document-runner-engine.mjs` and the `prd.evaluate` prompt contract — call it out in the implementation plan's Pre-flight section.
| `feedback.received` | feedback_wait | `on.feedbackReceived` |
| `approval.changed`, status="approved" | approval_gate | `on.approved` |
| `approval.changed`, status="rejected" | approval_gate | `on.rejected` |
| `approval.changed`, status="needs_revision" | approval_gate | `on.needsRevision` |
| `manual.decision` | manual_decision | `on.decided` |

On no match: output is empty (no transitions, no jobs, no actions) and `unmatchedEvent` is populated for observability. Caller logs but does not fail.

### 6.3 Retry handling

When a runnable stage's job fails:
- If `attemptCounts[stageId] + 1 < jobTemplate.retry.maxAttempts`, interpreter emits a new `JobCreationRequest` of the same `jobType` and does not transition the stage. Caller increments `attemptCounts[stageId]` when applying the output.
- If at or past max, interpreter follows `on.failure`. If no `on.failure` is defined, route to the workflow's `prd.failed` terminal.

### 6.4 Call sites

- `backend/src/workflow-api/repository-transition-planner.ts`: PRD-specific switch (currently spread across the file) is collapsed to a single `interpretWorkflowEvent()` call inside a `documentType === "prd"` guard. Other documentTypes continue to use the existing hardcoded logic in this slice.
- `backend/src/workflow-api/workflow-intake-command.ts`: chooses the active definition by `documentType`, pins `(definition_id, definition_version, entryStage)` on the new `workflow_task`, and creates the first job using the entry stage's `jobTemplate`.
- The applier of the interpreter output is the existing `WorkflowMutationApplier` — no change.

## 7. DB Schema Changes

### 7.1 New table `workflow_definition`

```sql
CREATE TABLE IF NOT EXISTS workflow_definition (
  id              VARCHAR(64)  NOT NULL,
  version         INT          NOT NULL,
  name            VARCHAR(255) NOT NULL,
  document_types  JSON         NOT NULL,
  entry_stage     VARCHAR(128) NOT NULL,
  body_json       JSON         NOT NULL,
  source_path     VARCHAR(512) NOT NULL,
  source_hash     VARCHAR(64)  NOT NULL,
  status          VARCHAR(32)  NOT NULL DEFAULT 'active',
  imported_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (id, version),
  KEY idx_workflow_definition_status (status, id)
);
```

### 7.2 `workflow_task` column additions

Idempotent ALTERs guarded with `information_schema` checks (pattern from migration 004):

```sql
ALTER TABLE workflow_task
  ADD COLUMN definition_id        VARCHAR(64)  NULL AFTER source_key,
  ADD COLUMN definition_version   INT          NULL AFTER definition_id,
  ADD COLUMN current_stage_id     VARCHAR(128) NULL AFTER status,
  ADD COLUMN stage_attempt_counts JSON         NULL AFTER current_stage_id;
```

### 7.3 `workflow_task.status` derivation rule

`status` column stays as a roll-up of stage type for backward compatibility with dashboards and queries:

| Stage type | Derived `task.status` |
|---|---|
| `runnable` | `in_progress` |
| `approval_gate` | `approval_pending` |
| `feedback_wait` | `needs_revision` |
| `manual_decision` | `blocked` |
| `terminal` kind=completed | `completed` |
| `terminal` kind=failure | `failed` |

### 7.4 Pin-on-create

`workflow_intake_command` matches `documentTypes` to find the highest active `version`, then writes `(definition_id, version, entry_stage)` into the new `workflow_task`. The pin is permanent for that task; future definition imports do not affect it.

### 7.5 New `status_events` event types

No table change. New event_type values:

- `task.stage_entered` — payload `{ taskId, stageId, definitionId, definitionVersion }`
- `task.stage_exited` — payload `{ taskId, fromStageId, toStageId, reason }`
- `definition.imported` — payload `{ definitionId, version, sourceHash, sourcePath }`
- `definition.reload_requested` — payload `{ definitionId, actorEmail }`

During the wire-in PR, the legacy `prd_*` transition events continue to be emitted alongside the new stage events. They are removed in a successor slice.

### 7.6 Migration file

New file `migrations/mysql/006_workflow_definition.sql` containing §7.1 + §7.2 + idempotent guards. Number 005 (`workflow_job_failure_category.sql`) already in tree.

### 7.7 Definition import flow

- **Startup**: `WorkflowDefinitionRegistry.bootstrap()` scans `workflows/definitions/*.yaml`, parses, computes sha256, queries DB for `(id, source_hash)`. If new hash: insert new `version` row, mark previous as `deprecated`. If unchanged: no-op. Always idempotent.
- **On-demand reload**: `POST /workflow-definitions/reload` (actor email required) runs the same logic.
- **Read APIs**: `GET /workflow-definitions` lists active definitions; `GET /workflow-definitions/:id?version=N` returns a specific version's body.

## 8. Implementation Steps and PR Plan

### 8.1 Two-PR split

| PR | Single-sentence scope | Touch surface |
|---|---|---|
| **PR 1: workflow-definition infra** | New `backend/src/workflow-definition/*` package, new YAML definition file, new MySQL migration, new tests; nothing existing calls the new code yet. | Purely additive. Migration adds new table/columns. No behavior change. |
| **PR 2: PRD interpreter wire-in** | Intake pins definition, transition planner delegates PRD branch to interpreter, server gets reload endpoint, legacy `prdConfirmationWorkflowPolicy` constant removed. | Modifies 4 existing files (intake, planner, server, domain), adds 1 test helper. |

PR 1 alone is a safe intermediate state: new infrastructure lands in `main`, but is dead code. The slice ships either PR1 alone (next slice picks up) or PR1+PR2 together.

### 8.2 Pre-flight: coverage gap fill (optional PR 0)

Before PR2, identify and add tests for currently uncovered PRD paths so the equivalence oracle is complete:

| Path | Current coverage | Action |
|---|---|---|
| Quality `max_attempts` exhaustion | partial | add full-retry-budget test |
| Approval `rejected` (취소됨 transition) | uncovered | add new test |
| Routing `needs_clarification` path | partial | add scale_clarification entry + manual decision tests |
| Manual decision (operator pick) | uncovered | add new test |
| Revision requested with no new feedback (noop) | uncovered | add jira-comment-only test |
| Duplicate PRD intake guard | partial | add additional assertion |

This can land as its own small PR before PR1; it is independently valuable hygiene.

### 8.3 Step list

1. **Schema + parser + validator** in `backend/src/workflow-definition/`. Add `yaml@^2` dep (~80KB).
2. **Author `workflows/definitions/prd-confirmation.v1.yaml`** by hand, mirroring the current behavior.
3. **Interpreter** as pure function with the matching table from §6.2; comprehensive unit tests.
4. **Migration 006** with idempotent guards.
5. **Definition repository** (in-memory + MySQL) for `workflow_definition`.
6. **Registry / bootstrap loader** with hash-diff version bumping.
7. **Intake pin** in `workflow-intake-command.ts`.
8. **Transition planner delegation** for `documentType === "prd"`.
9. **Reload endpoint** + GET routes in `server.ts`.
10. **Delete `prdConfirmationWorkflowPolicy`**; test helper replaces direct imports.

Steps 1–6 = PR 1. Steps 7–10 = PR 2.

### 8.4 Checkpoints

| After step | Verification |
|---|---|
| 3 (interpreter) | All §9.3 interpreter unit cases green. |
| 6 (registry) | `npm run typecheck && npm test` whole suite green; PR1 ready. |
| 8 (planner delegation) | Existing PRD-related tests pass without modification. |
| 10 (constant removed) | `npm run smoke:mysql:no-fixture` passes; 28 jobs / 4 Code tasks / 8 PR artifacts pattern retained; new stage events appear in status_events. |

### 8.5 Rollback

- PR1 only landed and PR2 in flight: revert PR1 has no behavior impact.
- PR2 landed, problem found: definition fix + `POST /workflow-definitions/reload` recovers without redeploy. Pinned in-flight runs unaffected.
- Step 10 (constant removal) is the only code-revert-required step; everything else is hot-fixable through the YAML.

## 9. Test Strategy

### 9.1 Equivalence oracle (do not modify)

These eight files are the behavior contract. PR2 may not modify any of them; if a change is needed, the YAML definition is wrong and must be fixed:

```
tests/workflow-api.test.ts
tests/repository-transition-planner.test.ts
tests/repository-transition-processor.test.ts
tests/workflow-mutation-applier.test.ts
tests/workflow-result-command.test.ts
tests/prd-intake-command.test.ts
tests/feedback-revision-command.test.ts
tests/smoke-mysql-no-fixture.test.ts
```

### 9.2 Pre-flight gap fill

See §8.2.

### 9.3 New unit tests (PR1)

- `tests/workflow-definition/schema.test.ts` — parses good YAML; rejects missing `entryStage`, unreachable stages, dangling `on:` targets, unknown `stage.type`.
- `tests/workflow-definition/interpreter.test.ts` — parameterized table covering at minimum these 13 cases (each = one transition):

```
1.  prd.draft           job.completed(succeeded)            → prd.quality, [prd.evaluate_quality]
2.  prd.draft           job.completed(failed, attempts=0)   → prd.draft (retry), [prd.generate_draft]
3.  prd.draft           job.completed(failed, attempts=3)   → prd.failed (terminal)
4.  prd.quality         job.completed(passed)               → prd.approval, ext: jira→승인 대기
5.  prd.quality         job.completed(needs_revision)       → prd.needs_revision, ext: jira→수정 필요
6.  prd.needs_revision  feedback.received                   → prd.revise, [prd.apply_feedback_revision]
7.  prd.revise          job.completed(succeeded)            → prd.quality, [prd.evaluate_quality]
8.  prd.approval        approval.changed(approved)          → prd.routing, [prd.route_downstream]
9.  prd.approval        approval.changed(rejected)          → prd.failed (terminal)
10. prd.routing         job.completed(route_decided)        → completed (terminal)
11. prd.routing         job.completed(needs_scope_confirmation) → prd.scale_clarification
12. prd.scale_clarif.   manual.decision("HLD")              → completed (terminal)
13. prd.quality         feedback.received  (mismatch)       → noop, unmatchedEvent populated
```

- `tests/workflow-definition/registry.test.ts` — startup load; hash diff bumps version; deprecates older active; pinned task does not migrate.
- `tests/workflow-definition/mysql-repository.test.ts` — uses repository contract.
- `tests/mysql-migration.test.ts` — adds 006 to migration runner test cases.

### 9.4 New integration tests (PR2)

- `tests/workflow-definition-integration.test.ts`
  - PRD intake sets `workflow_task.definition_id="prd-confirmation"`, `version=1`, `current_stage_id="prd.draft"`.
  - Each transition emits `task.stage_entered` / `task.stage_exited` in `status_events`.
  - Smoke pattern stage sequence = `[draft, quality, approval, routing, completed]` (no fan-out in this slice).

### 9.5 PR2 merge gate (all four required)

1. PR1's full test suite + §8.2 gap-fill tests green at the PR2 base SHA.
2. PR2 applied: the same test suite passes **without modifying any oracle file**.
3. `npm run smoke:mysql:no-fixture` still produces 28 jobs / 4 Code tasks / 8 PR artifacts.
4. New stage events present in `status_events` for the smoke run; deprecated legacy events present alongside (parallel emission).

## 10. Out-of-scope register

### 10.1 Workflow scope

| Item | Reason | Future slice |
|---|---|---|
| HLD/LLD/Spec/Code definition-ization | Slice depth = PRD only | Next metadata slice (reuses infra) |
| ADR job type and `adr_needed` depth | Definition reserves routing slot; logic unchanged | Slice G (ADR) |
| Fan-out / fan-in expressed in definition | Transitions are 1:1 only | HLD→LLD fan-out slice |

### 10.2 System scope

| Item | Reason | Future slice |
|---|---|---|
| Workflow Editor UI | M5 proper; this slice lays the prerequisite | Slice F |
| Definition edit API (POST/PUT) | Git is canonical; YAML edit + reload is the edit surface | Editor slice |
| Definition search / filter / tagging | Only list and get-by-id this slice | Many-definitions operations slice |
| Definition RBAC | actor-email logging only; no permission checks | Slice E (auth/perm) |
| Multi-tenancy / per-team definition scope | Single org assumed | Slice E |

### 10.3 Code hygiene

| Item | Reason | Future slice |
|---|---|---|
| Decompose `server.ts` / `repository-transition-planner.ts` / `App.tsx` / `workflowApi.ts` | This slice only adds new modules under `workflow-definition/*` | Slice C |
| `legacy/prd-confirmation/*` impact | Product runtime only; legacy fixture untouched | Permanent isolation |
| Removal of `WorkflowEngineTransitionType` PRD-prefixed events | Parallel-emit in PR2 (explicit debt) | Next metadata slice |

### 10.4 Execution plane

| Item | Reason | Future slice |
|---|---|---|
| Local runner | Runner is per-job; unaware of definitions | n/a |
| Scheduler claim logic | Definition-independent | n/a |
| Skill package schema | Reuses current `skill.json` as-is | Slice H (marketplace/security) |

### 10.5 Definition expressivity NOT supported in v1

- Dynamic branching (`if/else` inside a definition).
- Variables / expression substitution at runtime.
- Sub-workflow `include` directives.
- Schedule / timer-based transitions.

Add these only when concretely required.

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| YAML definition misses a real PRD transition | Medium | §8.2 pre-flight gap fill + §9.5 merge gate item 2 |
| `prd.route_downstream` success status name change (`succeeded` → `route_decided`) breaks existing skill / runner contract | Low | Update is in PR 1 (skill prompt + result schema); existing tests adjusted as part of pre-flight, not as oracle modifications since they currently assert on `output.route` not `status` |
| Pinned task references a definition row that gets deleted | Low | Versions are append-only; deprecation does not delete |
| Hot-reload races with a transition in progress | Low | Interpreter is pure; runs use pinned version; reload only affects new intakes |
| `WorkflowCommandJobType` literal union becomes unwieldy as definitions grow | Medium | Acceptable for PRD only; revisit when adding HLD/LLD/Spec definitions |
| Parallel-emit legacy events leak into next slice | Medium | Tracked as explicit debt; remove in next metadata slice |

## 12. Acknowledged debt (must clear in next slice)

- Parallel emission of legacy `prd_*` transition events from `WorkflowEngineTransitionType`.
- `documentType === "prd"` guard in transition planner — to be lifted as HLD/LLD/Spec definitions land.
- `mockWorkflow.ts` (frontend) still imports nothing definition-related — frontend remains a separate slice.

## 13. Success criteria

Slice complete when:

1. PR1 merged: new package present, migration 006 applied, all tests green, no behavioral change observable.
2. PR2 merged: PRD workflow runs through interpreter, oracle test suite unchanged and passing, smoke pattern intact, new stage events visible in ledger, `prdConfirmationWorkflowPolicy` constant deleted.
3. A new YAML definition for a contrived test workflow can be added to `workflows/definitions/` and read via `GET /workflow-definitions` after a reload (proves the import path is general, not PRD-specific).
