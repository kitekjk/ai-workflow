# Workflow Definition PRD Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Externalize the PRD workflow to a single canonical YAML file and replace the PRD-specific transition logic with a generic, definition-driven interpreter. Behavior is observationally equivalent to today; the existing 325 tests are the oracle.

**Architecture:** Three coordinated PRs on `workflow-definition-prd-slice` branch. (PR 0) Optional pre-flight test gap-fills so the equivalence oracle is complete. (PR 1) Purely additive infra: schema, parser, validator, YAML definition file, interpreter, MySQL migration, repository, registry, route_decided contract. (PR 2) Wire-in: intake pins definition, prd planner delegates to interpreter, server gets reload endpoint, `prdConfirmationWorkflowPolicy` deleted.

**Tech Stack:** TypeScript 5.7, Node 20, Vitest 2, MySQL 8 (port 3307 locally), `yaml@^2` (new dep ~80KB). Project root `c:\Users\kitek\Works\ai-workflow`. Active branch `workflow-definition-prd-slice` (base: `main` at `495b4a9`).

**Spec:** `docs/superpowers/specs/2026-05-23-workflow-definition-prd-slice-design.md`

---

## File Structure (locked-in before tasks)

### New files

| Path | Responsibility | Approx LOC |
|---|---|---|
| `workflows/definitions/prd-confirmation.v1.yaml` | Canonical PRD workflow definition | 90 |
| `backend/src/workflow-definition/schema.ts` | TypeScript types for `WorkflowDefinition` and stages | 90 |
| `backend/src/workflow-definition/parser.ts` | YAML → JS object → normalized `WorkflowDefinition` | 70 |
| `backend/src/workflow-definition/validator.ts` | Reachability, dangling `on:` targets, unknown `stage.type`, jobType literal check | 90 |
| `backend/src/workflow-definition/interpreter.ts` | Pure `interpretWorkflowEvent()` | 220 |
| `backend/src/workflow-definition/repository.ts` | `WorkflowDefinitionRepository` interface | 25 |
| `backend/src/workflow-definition/in-memory-repository.ts` | In-memory repo for tests | 60 |
| `backend/src/workflow-definition/mysql-repository.ts` | MySQL-backed repo | 120 |
| `backend/src/workflow-definition/registry.ts` | Bootstrap + hash-diff version bumping | 110 |
| `migrations/mysql/006_workflow_definition.sql` | New table + 4 column adds | 80 |
| `tests/workflow-definition/schema.test.ts` | Parser + schema unit tests | 80 |
| `tests/workflow-definition/interpreter.test.ts` | 13 transition cases | 200 |
| `tests/workflow-definition/registry.test.ts` | Bootstrap, hash diff, deprecation | 90 |
| `tests/workflow-definition/mysql-repository.test.ts` | Repository contract | 100 |
| `tests/workflow-definition-integration.test.ts` | PR2 integration: intake pin + stage events | 130 |
| `tests/fixtures/prd-definition.ts` | Test helper that loads the PRD YAML | 25 |

### Modified files (PR 0 — pre-flight)

| Path | Change |
|---|---|
| `tests/workflow-api.test.ts` or `tests/repository-transition-planner.test.ts` | Add 6 small tests covering uncovered PRD paths |

### Modified files (PR 1)

| Path | Change |
|---|---|
| `package.json` | Add `yaml@^2` dependency |
| `tests/mysql-migration.test.ts` | Add migration 006 to runner expectations |
| `scripts/document-runner-engine.mjs` | Emit `status: "route_decided"` on `prd.route_downstream` success |
| `backend/src/document-core/prompt-contracts.ts` | Document `route_decided` in the PRD route prompt contract |

### Modified files (PR 2)

| Path | Change |
|---|---|
| `backend/src/workflow-api/workflow-intake-command.ts` | Match definition by documentType, pin `(definition_id, version, entry_stage)` on workflow_task |
| `backend/src/workflow-api/prd-transition-planner.ts` | PRD branch delegates to `interpretWorkflowEvent()` |
| `backend/src/workflow-api/server.ts` | Add `POST /workflow-definitions/reload` + `GET /workflow-definitions` and `GET /workflow-definitions/:id` |
| `backend/src/workflow-core/domain.ts` | Delete `prdConfirmationWorkflowPolicy` const + the `WorkflowPolicy` interface IF no remaining consumer |
| `backend/src/workflow-core/mysql-repository.ts` | Read/write the 4 new `workflow_task` columns |
| `backend/src/workflow-core/in-memory-repository.ts` | Read/write the 4 new fields on the in-memory task |
| `backend/src/workflow-api/repository-transition-processor.ts` | Pass new stage events into mutation applier (alongside legacy `prd_*` events) |
| `backend/src/workflow-api/workflow-mutation-applier.ts` | Accept new event types (`task.stage_entered`, etc.) — pass-through only |

### Files explicitly NOT modified

- All 8 oracle test files (see Spec §9.1): `tests/workflow-api.test.ts`, `tests/repository-transition-planner.test.ts`, `tests/repository-transition-processor.test.ts`, `tests/workflow-mutation-applier.test.ts`, `tests/workflow-result-command.test.ts`, `tests/prd-intake-command.test.ts`, `tests/feedback-revision-command.test.ts`, `tests/smoke-mysql-no-fixture.test.ts`.
- `backend/src/workflow-api/document-transition-planner.ts`, `implementation-transition-planner.ts`, `repository-transition-planner-shared.ts`, `repository-transition-planner.ts` (router).
- Frontend (`apps/workflow-app/*`).
- Legacy (`backend/src/legacy/*`).

---

## PR Plan

| PR | Scope | Tasks | Cumulative Risk |
|---|---|---|---|
| **PR 0** (optional, recommended) | Pre-flight: 6 small test additions for uncovered PRD paths | 1-6 | None — purely tests on current code, no behavior change |
| **PR 1** | New infra + YAML + migration + tests + route_decided contract | 7-12 | Low — dead code; existing path unchanged |
| **PR 2** | Wire-in (intake, planner delegation, server endpoint, delete const) | 13-17 | Medium — production path changes, oracle tests must stay green |

All work happens on `workflow-definition-prd-slice` branch with multiple commits. The PR split is enforced by separate `git push`/`gh pr create` events at the milestones.

---

# PR 0: Pre-flight Coverage Gap Fill

Per Spec §8.2. Adds tests for currently uncovered PRD transition paths so the oracle is complete before any wire-in. Each task adds one focused test against the EXISTING (pre-refactor) code. No production code changes. All tests must pass.

## Task 1: Quality `max_attempts` exhaustion test

**Files:**
- Modify: `tests/repository-transition-planner.test.ts`

- [ ] **Step 1: Read existing test patterns**

Open `tests/repository-transition-planner.test.ts`. Find the `prd.evaluate_quality` test cases. Understand how `WorkflowJobResult` shapes are built in these tests (look at the helpers used).

- [ ] **Step 2: Add the failing-retry-exhaustion test**

Append to the appropriate `describe` block:

```ts
test("prd.evaluate_quality records needs_revision when quality fails", () => {
  // (this test already exists in some form — verify; if not, add)
});

test("prd.generate_draft followed by prd.evaluate_quality failed retries are recorded in jobs", () => {
  // Construct a chain: draft → eval (failed). Verify that the planner output
  // reports the failure path (documentStatus needs_revision) and emits the
  // expected `prd_quality_needs_revision` transitionType. This codifies the
  // currently-implicit retry-failure behavior. Use the same idGenerator and
  // input shape as nearby tests.
  const draftInput = makePrdJobInput({ jobType: "prd.generate_draft", result: { status: "succeeded" } });
  const draftPlan = planRepositoryWorkflowTransition(draftInput);
  expect(draftPlan.transitionType).toBe("prd_draft_generated");

  const evalInput = makePrdJobInput({ jobType: "prd.evaluate_quality", result: { status: "needs_revision", score: 60 } });
  const evalPlan = planRepositoryWorkflowTransition(evalInput);
  expect(evalPlan.transitionType).toBe("prd_quality_needs_revision");
  expect(evalPlan.mutation.documentStates[0].status).toBe("needs_revision");
});
```

If `makePrdJobInput` does not already exist in the file, write a small local helper that builds the input from the existing fixture shape. Read the file to find the existing pattern.

- [ ] **Step 3: Run test**

```
npm test -- tests/repository-transition-planner.test.ts
```

Expected: all tests pass including the new one.

- [ ] **Step 4: Commit**

```bash
git add tests/repository-transition-planner.test.ts
git commit -m "$(cat <<'EOF'
test(pr0): add prd.generate_draft → evaluate_quality needs_revision coverage

Pre-flight gap-fill for the upcoming workflow-definition slice. Codifies the
currently-implicit needs_revision transition so the interpreter equivalence
oracle can rely on it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 2: Approval rejected test

**Files:**
- Modify: `tests/workflow-api.test.ts`

- [ ] **Step 1: Find PRD approval test cluster**

Search `tests/workflow-api.test.ts` for tests that exercise PRD approval (`POST /workflow-runs/:id/.../approval` or similar). Identify how approval state is set and refreshed.

- [ ] **Step 2: Add a rejected-approval test**

Append:

```ts
test("PRD approval rejected transition results in canceled workflow state", async () => {
  // Set up a PRD that reached approval_pending. Move the Jira status to a
  // rejected/취소됨 status. Refresh the workflow. The workflow_task status
  // becomes 'canceled' and no downstream routing job is scheduled.
  const { runId } = await intakeAndDraftThroughEvaluation(server, { sourceKey: "PRD-REJECT-1" });
  await setJiraStatus(server, "PRD-REJECT-1", "취소됨");
  await refreshWorkflow(server, runId);
  const state = await getWorkflowState(server, runId);
  expect(state.tasks[0].status).toBe("canceled");
  expect(state.jobs.find((j: any) => j.jobType === "prd.route_downstream")).toBeUndefined();
});
```

The test calls helpers that should already exist; reuse them. If `setJiraStatus` doesn't exist, inline the Jira-stub set call directly (search the file for how existing tests refresh approval state).

- [ ] **Step 3: Run test**

```
npm test -- tests/workflow-api.test.ts
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add tests/workflow-api.test.ts
git commit -m "$(cat <<'EOF'
test(pr0): add PRD approval-rejected coverage

Pre-flight gap-fill. Codifies the currently-uncovered path where a PRD Jira
ticket is moved to 취소됨/rejected — workflow_task ends in 'canceled' with
no downstream routing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 3: Routing needs_scope_confirmation + manual decision tests

**Files:**
- Modify: `tests/workflow-api.test.ts`

- [ ] **Step 1: Add scope-confirmation entry test**

Append:

```ts
test("PRD route_downstream needs_scope_confirmation sets prd_downstream_scope_confirmation_required and needs_revision status", async () => {
  const { runId, jobId } = await intakeAndDraftThroughApproval(server, { sourceKey: "PRD-SCOPE-1" });
  // Force the route_downstream stub to emit needs_scope_confirmation
  await postRunnerResult(server, jobId, {
    status: "needs_scope_confirmation",
    output: { status: "needs_scope_confirmation", rationale: "scale unclear" }
  });
  const state = await getWorkflowState(server, runId);
  const events = await getStatusEvents(server, runId);
  expect(events.some((e: any) => e.metadata?.transitionType === "prd_downstream_scope_confirmation_required")).toBe(true);
  expect(state.documents[0].status).toBe("needs_revision");
});
```

`intakeAndDraftThroughApproval`, `postRunnerResult`, `getStatusEvents` — reuse from elsewhere in the same file. If you cannot find equivalents, search `tests/` for usage of `repository-transition-planner` and `WorkflowJobResult` and replicate the shape.

- [ ] **Step 2: Run test**

```
npm test -- tests/workflow-api.test.ts
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add tests/workflow-api.test.ts
git commit -m "$(cat <<'EOF'
test(pr0): add PRD route_downstream needs_scope_confirmation coverage

Pre-flight gap-fill. The needs_scope_confirmation path currently has only
partial coverage; this test pins its observable behavior (transitionType
prd_downstream_scope_confirmation_required + document status needs_revision).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 4: Manual decision (scale clarification) test

**Files:**
- Modify: `tests/workflow-api.test.ts`

- [ ] **Step 1: Locate manual decision API or recreate from scratch**

Search for any existing endpoint that allows an operator to pick a downstream stage manually (looking for `/decision`, `manual`, `clarification`, or similar in routes). The existing code may handle this through a feedback or revision endpoint. The goal is to verify that when the operator manually picks HLD (for example), the workflow proceeds to that stage.

If no explicit manual-decision endpoint exists today, the path is exercised through `POST /workflow-sources/:sourceKey/feedback-revision` with a decision payload — verify by reading `feedback-revision-command.ts`.

- [ ] **Step 2: Add a manual decision test**

Append:

```ts
test("operator manual scale decision resumes PRD routing", async () => {
  const { runId } = await intakeAndDraftThroughRouting(server, { sourceKey: "PRD-DECIDE-1" });
  // PRD is in needs_scope_confirmation. Operator picks "HLD".
  await postFeedbackRevision(server, "PRD-DECIDE-1", {
    documentType: "prd",
    actor: "operator@example.com",
    feedback: { decision: "HLD" }
  });
  const state = await getWorkflowState(server, runId);
  // After manual decision, the workflow should have created an HLD task
  // (or recorded the decision in workflow state).
  // Adjust the assertion to match the actual current behavior — this test
  // codifies whatever the current path produces.
  expect(state.tasks.some((t: any) => t.taskType === "hld")).toBe(true);
});
```

If the current code does NOT actually produce that result (i.e., this is uncovered behavior because the feature is partial), the assertion may need to be looser — e.g., assert only that a state event was recorded. The point of this gap-fill is to lock in whatever the current code does, not to add new behavior.

- [ ] **Step 3: Run, adjust assertion if needed, commit**

```
npm test -- tests/workflow-api.test.ts
```

If failing, narrow the assertion until the test reflects current behavior, then commit:

```bash
git add tests/workflow-api.test.ts
git commit -m "$(cat <<'EOF'
test(pr0): add operator manual-decision coverage for PRD scale clarification

Pre-flight gap-fill. Codifies current behavior when an operator manually picks
a downstream stage from the scale-clarification state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 5: Revision-requested-without-new-feedback noop test

**Files:**
- Modify: `tests/feedback-revision-command.test.ts`

- [ ] **Step 1: Add the noop test**

Append:

```ts
test("revision request without new feedback is a no-op (no new job created)", async () => {
  const { runId, documentId } = await intakeAndDraftThroughEvaluation(harness, { sourceKey: "PRD-NOFB-1" });
  // First feedback revision call with valid feedback succeeds and schedules a job.
  await harness.recordFeedbackRevision({ sourceKey: "PRD-NOFB-1", documentType: "prd", feedback: [{ source: "app", body: "fix this" }] });
  const jobsAfterFirst = await harness.listJobs(runId);
  const reviseCount1 = jobsAfterFirst.filter((j: any) => j.jobType === "prd.apply_feedback_revision").length;
  // Second call with no new feedback should not schedule another revision job.
  await harness.recordFeedbackRevision({ sourceKey: "PRD-NOFB-1", documentType: "prd", feedback: [] });
  const jobsAfterSecond = await harness.listJobs(runId);
  const reviseCount2 = jobsAfterSecond.filter((j: any) => j.jobType === "prd.apply_feedback_revision").length;
  expect(reviseCount2).toBe(reviseCount1);
});
```

`harness` is whatever fixture/helper the existing file uses. Read the file's `beforeEach`/`beforeAll` to identify it.

- [ ] **Step 2: Run + commit**

```
npm test -- tests/feedback-revision-command.test.ts
```

```bash
git add tests/feedback-revision-command.test.ts
git commit -m "$(cat <<'EOF'
test(pr0): add no-new-feedback revision noop coverage

Pre-flight gap-fill. Codifies the current behavior where a revision request
without new feedback does not produce a new prd.apply_feedback_revision job.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 6: Duplicate PRD intake guard test

**Files:**
- Modify: `tests/prd-intake-command.test.ts`

- [ ] **Step 1: Add the duplicate-guard assertion**

Append:

```ts
test("intake of an already-active PRD source returns the existing run id (idempotent)", async () => {
  const intake1 = await command.recordIntake({
    runId: "run_dup_1",
    workItemId: "wi_dup_1",
    jobId: "job_dup_1",
    sourceType: "jira",
    sourceKey: "PRD-DUP-1",
    documentType: "prd",
    requestedBy: "planner@example.com"
  });
  // A second intake with a different runId for the same sourceKey should either:
  //   (a) return the existing run id (idempotent), or
  //   (b) throw a known error indicating the source is already active.
  // Pin whichever the current code does.
  try {
    const intake2 = await command.recordIntake({
      runId: "run_dup_2",
      workItemId: "wi_dup_2",
      jobId: "job_dup_2",
      sourceType: "jira",
      sourceKey: "PRD-DUP-1",
      documentType: "prd",
      requestedBy: "planner@example.com"
    });
    // If it returns, must be idempotent
    expect(intake2.runId).toBe(intake1.runId);
  } catch (err) {
    // If it throws, the error message must indicate duplicate
    expect((err as Error).message).toMatch(/duplicate|already|active/i);
  }
});
```

- [ ] **Step 2: Run + commit**

```
npm test -- tests/prd-intake-command.test.ts
```

```bash
git add tests/prd-intake-command.test.ts
git commit -m "$(cat <<'EOF'
test(pr0): add PRD duplicate-intake guard coverage

Pre-flight gap-fill. Codifies whichever guard the current intake code uses
when a second intake arrives for an already-active PRD source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### PR 0 close-out

After Tasks 1-6 commit, run the full suite and confirm:

```
npm run typecheck
npm test
```

Expected: 44+ files, 325+6 = 331 tests (or however many tests the 6 new ones added) passing, no flakes. If a port-binding EACCES occurs in `tests/local-runner.test.ts`, retry that test alone.

`git log --oneline origin/main..HEAD` should show 6 commits, all `test(pr0): ...`. This is the PR 0 endpoint. Push and open PR 0 if desired; merge before PR 1.

---

# PR 1: workflow-definition Infrastructure

Purely additive. New `backend/src/workflow-definition/` package, YAML definition file, MySQL migration, comprehensive unit tests, and the `route_decided` contract update. Nothing existing calls the new code yet.

## Task 7: Add `yaml` dependency

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `package-lock.json` (regenerated by npm)

- [ ] **Step 1: Add yaml dep**

```bash
npm install yaml@^2 --save
```

This adds `"yaml": "^2.x.x"` to `package.json` `dependencies` and updates `package-lock.json`.

- [ ] **Step 2: Verify**

```bash
node -e "console.log(require('yaml').parse('a: 1').a)"
```

Expected output: `1`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: add yaml dependency for workflow-definition parser

Adds yaml@^2 (~80KB) for parsing workflow definition files in the upcoming
workflow-definition package.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 8: workflow-definition schema types

**Files:**
- Create: `backend/src/workflow-definition/schema.ts`

- [ ] **Step 1: Create the file with all types from Spec §5.2**

```ts
// backend/src/workflow-definition/schema.ts
import type { WorkflowDocumentType, WorkflowCommandJobType } from "../workflow-core/domain";

export interface WorkflowDefinition {
  id: string;
  version: number;
  name: string;
  documentTypes: WorkflowDocumentType[];
  entryStage: string;
  policy: WorkflowPolicyConfig;
  stages: Record<string, WorkflowStage>;
}

export interface WorkflowPolicyConfig {
  approvalSource: "jira_status";
  qualityFailureAction: "human_clarification" | "auto_rewrite" | "manual_or_auto";
  revisionTrigger: "explicit_request";
  feedbackSources: Array<"app" | "jira" | "wiki" | "github">;
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
  jobType: WorkflowCommandJobType;
  runner: { requiredCapability: string; requiredSkill?: SkillRequirement };
  threshold?: number;
  retry?: { maxAttempts: number; backoffMs?: number };
}

export interface SkillRequirement {
  id: string;
  versionRange: string;
}

export interface ApprovalConfig {
  role: "planner" | "developer" | "decision_owner";
  via: "jira_status";
  jiraTransition: {
    pending: string;
    approved: string;
    rejected: string;
    needsRevision: string;
  };
}

export type JobOnKey =
  | "success" | "failure"
  | "passed" | "needsRevision"
  | "routeDecided" | "needsScopeConfirmation";

export function isRunnableStage(stage: WorkflowStage): stage is RunnableStage {
  return stage.type === undefined || stage.type === "runnable";
}

export function isApprovalGateStage(stage: WorkflowStage): stage is ApprovalGateStage {
  return (stage as ApprovalGateStage).type === "approval_gate";
}

export function isFeedbackWaitStage(stage: WorkflowStage): stage is FeedbackWaitStage {
  return (stage as FeedbackWaitStage).type === "feedback_wait";
}

export function isManualDecisionStage(stage: WorkflowStage): stage is ManualDecisionStage {
  return (stage as ManualDecisionStage).type === "manual_decision";
}

export function isTerminalStage(stage: WorkflowStage): stage is TerminalStage {
  return (stage as TerminalStage).type === "terminal";
}
```

- [ ] **Step 2: Run typecheck**

```
npm run typecheck
```

Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add backend/src/workflow-definition/schema.ts
git commit -m "$(cat <<'EOF'
feat(workflow-definition): add schema types for workflow definitions

Adds WorkflowDefinition, the five WorkflowStage variants (runnable, approval_gate,
feedback_wait, manual_decision, terminal), JobTemplate, ApprovalConfig, and
narrow type guards. Reuses the existing WorkflowCommandJobType literal union.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 9: Parser + validator

**Files:**
- Create: `backend/src/workflow-definition/parser.ts`
- Create: `backend/src/workflow-definition/validator.ts`
- Create: `tests/workflow-definition/schema.test.ts`

- [ ] **Step 1: Create parser**

```ts
// backend/src/workflow-definition/parser.ts
import { parse } from "yaml";
import type { WorkflowDefinition } from "./schema";

export function parseWorkflowDefinitionYaml(source: string): WorkflowDefinition {
  const parsed = parse(source);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Workflow definition YAML must be a top-level object");
  }

  const definition = parsed as WorkflowDefinition;

  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new Error(`Workflow definition is missing required field: id`);
  }
  if (typeof definition.version !== "number" || !Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error(`Workflow definition '${definition.id}' has invalid version: ${definition.version}`);
  }
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: name`);
  }
  if (!Array.isArray(definition.documentTypes) || definition.documentTypes.length === 0) {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: documentTypes`);
  }
  if (typeof definition.entryStage !== "string" || definition.entryStage.length === 0) {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: entryStage`);
  }
  if (!definition.stages || typeof definition.stages !== "object") {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: stages`);
  }
  if (!definition.policy || typeof definition.policy !== "object") {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: policy`);
  }

  return definition;
}
```

- [ ] **Step 2: Create validator**

```ts
// backend/src/workflow-definition/validator.ts
import type { WorkflowDefinition, WorkflowStage } from "./schema";
import {
  isRunnableStage,
  isApprovalGateStage,
  isFeedbackWaitStage,
  isManualDecisionStage,
  isTerminalStage
} from "./schema";

const KNOWN_STAGE_TYPES = new Set(["runnable", "approval_gate", "feedback_wait", "manual_decision", "terminal"]);

export class WorkflowDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDefinitionValidationError";
  }
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  // 1. entryStage must exist
  if (!(definition.entryStage in definition.stages)) {
    throw new WorkflowDefinitionValidationError(
      `entryStage '${definition.entryStage}' is not defined in stages`
    );
  }

  // 2. Each stage.type must be known (undefined defaults to runnable)
  for (const [stageId, stage] of Object.entries(definition.stages)) {
    const stageType = stage.type ?? "runnable";
    if (!KNOWN_STAGE_TYPES.has(stageType)) {
      throw new WorkflowDefinitionValidationError(
        `Stage '${stageId}' has unknown type: '${stageType}'`
      );
    }
  }

  // 3. All `on:` targets must exist
  for (const [stageId, stage] of Object.entries(definition.stages)) {
    if (isTerminalStage(stage)) continue;

    const onMap = stage.on as Record<string, string>;
    for (const [key, target] of Object.entries(onMap)) {
      if (typeof target !== "string") continue;
      if (!(target in definition.stages)) {
        throw new WorkflowDefinitionValidationError(
          `Stage '${stageId}.on.${key}' points to undefined target stage '${target}'`
        );
      }
    }
  }

  // 4. Reachability: all stages must be reachable from entryStage
  const reachable = new Set<string>();
  const queue: string[] = [definition.entryStage];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const stage = definition.stages[current];
    if (isTerminalStage(stage)) continue;

    const onMap = stage.on as Record<string, string>;
    for (const target of Object.values(onMap)) {
      if (typeof target === "string" && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const stageId of Object.keys(definition.stages)) {
    if (!reachable.has(stageId)) {
      throw new WorkflowDefinitionValidationError(
        `Stage '${stageId}' is unreachable from entryStage '${definition.entryStage}'`
      );
    }
  }
}
```

- [ ] **Step 3: Create schema tests**

```ts
// tests/workflow-definition/schema.test.ts
import { describe, test, expect } from "vitest";
import { parseWorkflowDefinitionYaml } from "../../backend/src/workflow-definition/parser";
import { validateWorkflowDefinition, WorkflowDefinitionValidationError } from "../../backend/src/workflow-definition/validator";

const GOOD_YAML = `
id: test-workflow
version: 1
name: Test
documentTypes: [prd]
entryStage: start
policy:
  approvalSource: jira_status
  qualityFailureAction: human_clarification
  revisionTrigger: explicit_request
  feedbackSources: [app]
stages:
  start:
    label: Start
    jobTemplate:
      jobType: prd.generate_draft
      runner:
        requiredCapability: document.generate
    on:
      success: done
  done:
    type: terminal
    kind: completed
`;

describe("parseWorkflowDefinitionYaml", () => {
  test("parses a valid YAML", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    expect(def.id).toBe("test-workflow");
    expect(def.version).toBe(1);
    expect(def.entryStage).toBe("start");
    expect(Object.keys(def.stages)).toEqual(["start", "done"]);
  });

  test("rejects YAML missing id", () => {
    const bad = GOOD_YAML.replace(/^id: .+$/m, "");
    expect(() => parseWorkflowDefinitionYaml(bad)).toThrow(/missing required field: id/);
  });

  test("rejects YAML with non-integer version", () => {
    const bad = GOOD_YAML.replace("version: 1", "version: 1.5");
    expect(() => parseWorkflowDefinitionYaml(bad)).toThrow(/invalid version/);
  });
});

describe("validateWorkflowDefinition", () => {
  test("accepts a valid definition", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });

  test("rejects definition with entryStage missing from stages", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    def.entryStage = "nonexistent";
    expect(() => validateWorkflowDefinition(def)).toThrow(WorkflowDefinitionValidationError);
    expect(() => validateWorkflowDefinition(def)).toThrow(/entryStage 'nonexistent'/);
  });

  test("rejects definition with dangling on: target", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    (def.stages.start as any).on.success = "nowhere";
    expect(() => validateWorkflowDefinition(def)).toThrow(/points to undefined target stage 'nowhere'/);
  });

  test("rejects definition with unknown stage.type", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    (def.stages.done as any).type = "weird";
    expect(() => validateWorkflowDefinition(def)).toThrow(/unknown type: 'weird'/);
  });

  test("rejects definition with unreachable stage", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    def.stages["orphan"] = { type: "terminal", kind: "completed" };
    expect(() => validateWorkflowDefinition(def)).toThrow(/Stage 'orphan' is unreachable/);
  });
});
```

- [ ] **Step 4: Run tests**

```
npm test -- tests/workflow-definition/schema.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Run full typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/workflow-definition/parser.ts \
        backend/src/workflow-definition/validator.ts \
        tests/workflow-definition/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-definition): add YAML parser and validator

parseWorkflowDefinitionYaml() validates required top-level fields and produces
a normalized WorkflowDefinition. validateWorkflowDefinition() checks entryStage
existence, dangling on: targets, unknown stage.type values, and stage
reachability from entryStage. 8 unit tests cover the happy path and 5 failure
modes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 10: PRD definition YAML file

**Files:**
- Create: `workflows/definitions/prd-confirmation.v1.yaml`

- [ ] **Step 1: Write the YAML file verbatim from Spec §5.1**

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
      routeDecided: completed
      needsScopeConfirmation: prd.scale_clarification

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

- [ ] **Step 2: Verify parses + validates with the parser**

Quick smoke at the command line:

```bash
node -e "const fs=require('fs'); const {parse}=require('yaml'); const d=parse(fs.readFileSync('workflows/definitions/prd-confirmation.v1.yaml','utf8')); console.log(JSON.stringify(d, null, 2).slice(0, 300))"
```

Expected: prints first 300 chars of normalized JSON, ending with valid structure.

- [ ] **Step 3: Commit**

```bash
git add workflows/definitions/prd-confirmation.v1.yaml
git commit -m "$(cat <<'EOF'
feat(workflow-definition): add canonical PRD confirmation workflow YAML

workflows/definitions/prd-confirmation.v1.yaml encodes the current PRD
workflow behavior (draft → quality → approval → routing → completed) plus the
needs_revision feedback loop and the scale_clarification manual decision path.
Mirrors the implicit behavior in prd-transition-planner.ts and
prdConfirmationWorkflowPolicy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 11: Interpreter implementation + comprehensive tests

**Files:**
- Create: `backend/src/workflow-definition/interpreter.ts`
- Create: `tests/workflow-definition/interpreter.test.ts`
- Create: `tests/fixtures/prd-definition.ts`

- [ ] **Step 1: Create the test fixture loader**

```ts
// tests/fixtures/prd-definition.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowDefinitionYaml } from "../../backend/src/workflow-definition/parser";
import { validateWorkflowDefinition } from "../../backend/src/workflow-definition/validator";
import type { WorkflowDefinition } from "../../backend/src/workflow-definition/schema";

export function loadTestPrdDefinition(): WorkflowDefinition {
  const yamlPath = join(process.cwd(), "workflows", "definitions", "prd-confirmation.v1.yaml");
  const source = readFileSync(yamlPath, "utf8");
  const definition = parseWorkflowDefinitionYaml(source);
  validateWorkflowDefinition(definition);
  return definition;
}
```

- [ ] **Step 2: Create the interpreter**

```ts
// backend/src/workflow-definition/interpreter.ts
import type { WorkflowCommandJobType, WorkflowJobResult } from "../workflow-core/domain";
import type { FeedbackItem } from "../document-core/domain";
import type {
  ApprovalGateStage,
  JobOnKey,
  RunnableStage,
  TerminalStage,
  WorkflowDefinition,
  WorkflowStage
} from "./schema";
import {
  isApprovalGateStage,
  isFeedbackWaitStage,
  isManualDecisionStage,
  isRunnableStage,
  isTerminalStage
} from "./schema";

export interface WorkflowInterpreterInput {
  definition: WorkflowDefinition;
  runState: WorkflowRunState;
  event: WorkflowInterpreterEvent;
}

export interface WorkflowRunState {
  runId: string;
  currentStageId: string;
  currentTaskId: string;
  attemptCounts: Record<string, number>;
  metadata: Record<string, unknown>;
}

export type WorkflowInterpreterEvent =
  | { type: "job.completed"; jobType: WorkflowCommandJobType; result: WorkflowJobResult }
  | { type: "feedback.received"; feedback: FeedbackItem }
  | { type: "approval.changed"; status: "approved" | "rejected" | "needs_revision" }
  | { type: "manual.decision"; decision: string };

export interface WorkflowInterpreterOutput {
  transitions: StageTransition[];
  jobsToCreate: JobCreationRequest[];
  externalActions: ExternalAction[];
  terminal: { kind: "completed" | "failed"; reason: string } | null;
  unmatchedEvent?: { stageId: string; eventType: string; eventStatus?: string };
}

export interface StageTransition {
  fromStageId: string;
  toStageId: string;
  reason: string;
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

export function interpretWorkflowEvent(input: WorkflowInterpreterInput): WorkflowInterpreterOutput {
  const { definition, runState, event } = input;
  const stage = definition.stages[runState.currentStageId];

  if (!stage) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }
  if (isTerminalStage(stage)) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }

  if (event.type === "job.completed") {
    return handleJobCompleted(definition, runState, stage, event);
  }
  if (event.type === "feedback.received" && isFeedbackWaitStage(stage)) {
    return transitionTo(definition, runState, stage.on.feedbackReceived, "feedback received");
  }
  if (event.type === "approval.changed" && isApprovalGateStage(stage)) {
    return handleApprovalChanged(definition, runState, stage, event.status);
  }
  if (event.type === "manual.decision" && isManualDecisionStage(stage)) {
    return transitionTo(definition, runState, stage.on.decided, `manual decision: ${event.decision}`);
  }
  return emptyOutputWithUnmatched(runState.currentStageId, event);
}

function handleJobCompleted(
  definition: WorkflowDefinition,
  runState: WorkflowRunState,
  stage: WorkflowStage,
  event: { type: "job.completed"; jobType: WorkflowCommandJobType; result: WorkflowJobResult }
): WorkflowInterpreterOutput {
  if (!isRunnableStage(stage)) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }
  if (stage.jobTemplate.jobType !== event.jobType) {
    return emptyOutputWithUnmatched(runState.currentStageId, event);
  }

  const status = resolveResultStatus(event.result);
  const onKey = resultStatusToOnKey(status);

  // Retry handling for failure
  if (status === "failed") {
    const attempts = runState.attemptCounts[runState.currentStageId] ?? 0;
    const max = stage.jobTemplate.retry?.maxAttempts ?? 1;
    if (attempts + 1 < max) {
      return {
        transitions: [],
        jobsToCreate: [
          {
            jobType: stage.jobTemplate.jobType,
            taskId: runState.currentTaskId,
            input: {},
            retry: stage.jobTemplate.retry
          }
        ],
        externalActions: [],
        terminal: null
      };
    }
  }

  const target = stage.on[onKey];
  if (!target) {
    return emptyOutputWithUnmatched(runState.currentStageId, event, status);
  }

  return transitionTo(definition, runState, target, `job ${event.jobType} → ${status}`);
}

function handleApprovalChanged(
  definition: WorkflowDefinition,
  runState: WorkflowRunState,
  stage: ApprovalGateStage,
  status: "approved" | "rejected" | "needs_revision"
): WorkflowInterpreterOutput {
  const onKey = status === "needs_revision" ? "needsRevision" : status;
  const target = stage.on[onKey];
  if (!target) {
    return emptyOutputWithUnmatched(runState.currentStageId, { type: "approval.changed", status });
  }
  return transitionTo(definition, runState, target, `approval ${status}`);
}

function transitionTo(
  definition: WorkflowDefinition,
  runState: WorkflowRunState,
  targetStageId: string,
  reason: string
): WorkflowInterpreterOutput {
  const targetStage = definition.stages[targetStageId];
  if (!targetStage) {
    return emptyOutputWithUnmatched(runState.currentStageId, { type: "missing_target" } as any);
  }

  const transitions: StageTransition[] = [
    { fromStageId: runState.currentStageId, toStageId: targetStageId, reason }
  ];

  const jobsToCreate: JobCreationRequest[] = [];
  const externalActions: ExternalAction[] = [];
  let terminal: WorkflowInterpreterOutput["terminal"] = null;

  if (isTerminalStage(targetStage)) {
    terminal = { kind: targetStage.kind === "completed" ? "completed" : "failed", reason };
  } else if (isRunnableStage(targetStage)) {
    jobsToCreate.push({
      jobType: targetStage.jobTemplate.jobType,
      taskId: runState.currentTaskId,
      input: {},
      retry: targetStage.jobTemplate.retry
    });
  } else if (isApprovalGateStage(targetStage)) {
    externalActions.push(externalForApprovalEntry(runState, targetStage));
  }

  return { transitions, jobsToCreate, externalActions, terminal };
}

function externalForApprovalEntry(runState: WorkflowRunState, stage: ApprovalGateStage): ExternalAction {
  const issueKey = String(runState.metadata.sourceKey ?? runState.metadata.prdJiraKey ?? "");
  return {
    type: "jira.transition",
    issueKey,
    toStatus: stage.approval.jiraTransition.pending
  };
}

function resolveResultStatus(result: WorkflowJobResult): string {
  const top = (result as any).status;
  const inner = (result as any).output?.status;
  if (typeof inner === "string") return inner;
  if (typeof top === "string") return top;
  return "succeeded";
}

function resultStatusToOnKey(status: string): JobOnKey {
  if (status === "succeeded" || status === "success") return "success";
  if (status === "failed" || status === "failure") return "failure";
  if (status === "passed") return "passed";
  if (status === "needs_revision") return "needsRevision";
  if (status === "route_decided") return "routeDecided";
  if (status === "needs_scope_confirmation") return "needsScopeConfirmation";
  return "success";
}

function emptyOutputWithUnmatched(
  stageId: string,
  event: WorkflowInterpreterEvent | { type: string; status?: string },
  statusHint?: string
): WorkflowInterpreterOutput {
  return {
    transitions: [],
    jobsToCreate: [],
    externalActions: [],
    terminal: null,
    unmatchedEvent: { stageId, eventType: event.type, eventStatus: statusHint }
  };
}
```

- [ ] **Step 3: Create the interpreter test file with all 13 cases from Spec §9.3**

```ts
// tests/workflow-definition/interpreter.test.ts
import { describe, test, expect } from "vitest";
import { interpretWorkflowEvent, type WorkflowInterpreterEvent, type WorkflowRunState } from "../../backend/src/workflow-definition/interpreter";
import { loadTestPrdDefinition } from "../fixtures/prd-definition";

const definition = loadTestPrdDefinition();

function state(currentStageId: string, attempts: number = 0): WorkflowRunState {
  return {
    runId: "run_test",
    currentStageId,
    currentTaskId: "task_test",
    attemptCounts: { [currentStageId]: attempts },
    metadata: { sourceKey: "PRD-TEST-1", prdJiraKey: "PRD-TEST-1" }
  };
}

function jobCompleted(jobType: string, outputStatus: string): WorkflowInterpreterEvent {
  return {
    type: "job.completed",
    jobType: jobType as any,
    result: { id: "res_x", jobId: "job_x", status: "succeeded", output: { status: outputStatus } } as any
  };
}

describe("interpretWorkflowEvent (PRD)", () => {
  test("1. prd.draft + job.completed(succeeded) → prd.quality + prd.evaluate_quality job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.draft"),
      event: jobCompleted("prd.generate_draft", "succeeded")
    });
    expect(out.transitions[0].toStageId).toBe("prd.quality");
    expect(out.jobsToCreate[0].jobType).toBe("prd.evaluate_quality");
  });

  test("2. prd.draft + job.completed(failed, attempts=0) → retry same stage, same jobType", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.draft", 0),
      event: jobCompleted("prd.generate_draft", "failed")
    });
    expect(out.transitions).toHaveLength(0);
    expect(out.jobsToCreate[0].jobType).toBe("prd.generate_draft");
  });

  test("3. prd.draft + job.completed(failed, attempts=3 max) → prd.failed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.draft", 3),
      event: jobCompleted("prd.generate_draft", "failed")
    });
    expect(out.transitions[0].toStageId).toBe("prd.failed");
    expect(out.terminal?.kind).toBe("failed");
  });

  test("4. prd.quality + job.completed(passed) → prd.approval + jira→승인 대기", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.quality"),
      event: jobCompleted("prd.evaluate_quality", "passed")
    });
    expect(out.transitions[0].toStageId).toBe("prd.approval");
    const jiraAction = out.externalActions.find((a) => a.type === "jira.transition");
    expect(jiraAction?.toStatus).toBe("승인 대기");
  });

  test("5. prd.quality + job.completed(needs_revision) → prd.needs_revision", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.quality"),
      event: jobCompleted("prd.evaluate_quality", "needs_revision")
    });
    expect(out.transitions[0].toStageId).toBe("prd.needs_revision");
  });

  test("6. prd.needs_revision + feedback.received → prd.revise + prd.apply_feedback_revision job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.needs_revision"),
      event: { type: "feedback.received", feedback: { id: "fb1", source: "app", body: "fix" } as any }
    });
    expect(out.transitions[0].toStageId).toBe("prd.revise");
    expect(out.jobsToCreate[0].jobType).toBe("prd.apply_feedback_revision");
  });

  test("7. prd.revise + job.completed(succeeded) → prd.quality + prd.evaluate_quality job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.revise"),
      event: jobCompleted("prd.apply_feedback_revision", "succeeded")
    });
    expect(out.transitions[0].toStageId).toBe("prd.quality");
    expect(out.jobsToCreate[0].jobType).toBe("prd.evaluate_quality");
  });

  test("8. prd.approval + approval.changed(approved) → prd.routing + prd.route_downstream job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.approval"),
      event: { type: "approval.changed", status: "approved" }
    });
    expect(out.transitions[0].toStageId).toBe("prd.routing");
    expect(out.jobsToCreate[0].jobType).toBe("prd.route_downstream");
  });

  test("9. prd.approval + approval.changed(rejected) → prd.failed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.approval"),
      event: { type: "approval.changed", status: "rejected" }
    });
    expect(out.transitions[0].toStageId).toBe("prd.failed");
    expect(out.terminal?.kind).toBe("failed");
  });

  test("10. prd.routing + job.completed(route_decided) → completed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.routing"),
      event: jobCompleted("prd.route_downstream", "route_decided")
    });
    expect(out.transitions[0].toStageId).toBe("completed");
    expect(out.terminal?.kind).toBe("completed");
  });

  test("11. prd.routing + job.completed(needs_scope_confirmation) → prd.scale_clarification", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.routing"),
      event: jobCompleted("prd.route_downstream", "needs_scope_confirmation")
    });
    expect(out.transitions[0].toStageId).toBe("prd.scale_clarification");
  });

  test("12. prd.scale_clarification + manual.decision('HLD') → completed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.scale_clarification"),
      event: { type: "manual.decision", decision: "HLD" }
    });
    expect(out.transitions[0].toStageId).toBe("completed");
    expect(out.terminal?.kind).toBe("completed");
  });

  test("13. prd.quality + feedback.received (mismatch) → noop, unmatchedEvent populated", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.quality"),
      event: { type: "feedback.received", feedback: { id: "fb1", source: "app", body: "x" } as any }
    });
    expect(out.transitions).toHaveLength(0);
    expect(out.jobsToCreate).toHaveLength(0);
    expect(out.unmatchedEvent).toBeDefined();
    expect(out.unmatchedEvent?.stageId).toBe("prd.quality");
  });
});
```

- [ ] **Step 4: Run tests**

```
npm test -- tests/workflow-definition/interpreter.test.ts
```

Expected: 13 tests pass. If a case fails, fix the interpreter; do NOT loosen the test.

- [ ] **Step 5: Run full typecheck**

```
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/workflow-definition/interpreter.ts \
        tests/workflow-definition/interpreter.test.ts \
        tests/fixtures/prd-definition.ts
git commit -m "$(cat <<'EOF'
feat(workflow-definition): add pure interpretWorkflowEvent function

interpretWorkflowEvent(definition, runState, event) computes the next
transitions/jobs/external actions for a definition-driven workflow. Pure
function, no I/O. Handles runnable/approval_gate/feedback_wait/manual_decision/
terminal stages, retry budgets, and unmatched-event noop. 13 parameterized
test cases cover every PRD transition path in the canonical YAML.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 12: Migration 006 + repository + registry

**Files:**
- Create: `migrations/mysql/006_workflow_definition.sql`
- Modify: `tests/mysql-migration.test.ts`
- Create: `backend/src/workflow-definition/repository.ts`
- Create: `backend/src/workflow-definition/in-memory-repository.ts`
- Create: `backend/src/workflow-definition/mysql-repository.ts`
- Create: `tests/workflow-definition/mysql-repository.test.ts`
- Create: `backend/src/workflow-definition/registry.ts`
- Create: `tests/workflow-definition/registry.test.ts`

- [ ] **Step 1: Create migration 006**

```sql
-- migrations/mysql/006_workflow_definition.sql

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

-- Idempotent column adds to workflow_task (pattern from migration 004)
SET @add_definition_id = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN definition_id VARCHAR(64) NULL AFTER source_key',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'definition_id'
);
PREPARE add_definition_id FROM @add_definition_id;
EXECUTE add_definition_id;
DEALLOCATE PREPARE add_definition_id;

SET @add_definition_version = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN definition_version INT NULL AFTER definition_id',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'definition_version'
);
PREPARE add_definition_version FROM @add_definition_version;
EXECUTE add_definition_version;
DEALLOCATE PREPARE add_definition_version;

SET @add_current_stage_id = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN current_stage_id VARCHAR(128) NULL AFTER status',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'current_stage_id'
);
PREPARE add_current_stage_id FROM @add_current_stage_id;
EXECUTE add_current_stage_id;
DEALLOCATE PREPARE add_current_stage_id;

SET @add_stage_attempt_counts = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE workflow_task ADD COLUMN stage_attempt_counts JSON NULL AFTER current_stage_id',
    'SELECT 1')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workflow_task' AND COLUMN_NAME = 'stage_attempt_counts'
);
PREPARE add_stage_attempt_counts FROM @add_stage_attempt_counts;
EXECUTE add_stage_attempt_counts;
DEALLOCATE PREPARE add_stage_attempt_counts;
```

- [ ] **Step 2: Update mysql-migration test to include 006**

Open `tests/mysql-migration.test.ts`. Find where the test asserts expected migration file list. Add `006_workflow_definition.sql` to the expected list. If the test loads migrations dynamically (which migration 004's safe-rerun pattern suggests), this may be automatic — verify by running the test before commit.

- [ ] **Step 3: Repository interface**

```ts
// backend/src/workflow-definition/repository.ts
import type { WorkflowDefinition } from "./schema";

export interface WorkflowDefinitionRecord {
  definition: WorkflowDefinition;
  sourcePath: string;
  sourceHash: string;
  status: "active" | "deprecated";
  importedAt: string;
}

export interface WorkflowDefinitionRepository {
  upsert(record: WorkflowDefinitionRecord): Promise<void>;
  deprecatePreviousVersions(id: string, keepVersion: number): Promise<void>;
  findByIdAndVersion(id: string, version: number): Promise<WorkflowDefinitionRecord | null>;
  findActiveById(id: string): Promise<WorkflowDefinitionRecord | null>;
  findActiveByDocumentType(documentType: string): Promise<WorkflowDefinitionRecord | null>;
  listActive(): Promise<WorkflowDefinitionRecord[]>;
}
```

- [ ] **Step 4: In-memory repository**

```ts
// backend/src/workflow-definition/in-memory-repository.ts
import type { WorkflowDefinitionRecord, WorkflowDefinitionRepository } from "./repository";

export class InMemoryWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  private readonly records = new Map<string, WorkflowDefinitionRecord>();

  private key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  async upsert(record: WorkflowDefinitionRecord): Promise<void> {
    this.records.set(this.key(record.definition.id, record.definition.version), { ...record });
  }

  async deprecatePreviousVersions(id: string, keepVersion: number): Promise<void> {
    for (const record of this.records.values()) {
      if (record.definition.id === id && record.definition.version !== keepVersion) {
        record.status = "deprecated";
      }
    }
  }

  async findByIdAndVersion(id: string, version: number): Promise<WorkflowDefinitionRecord | null> {
    return this.records.get(this.key(id, version)) ?? null;
  }

  async findActiveById(id: string): Promise<WorkflowDefinitionRecord | null> {
    let best: WorkflowDefinitionRecord | null = null;
    for (const record of this.records.values()) {
      if (record.definition.id === id && record.status === "active") {
        if (!best || record.definition.version > best.definition.version) best = record;
      }
    }
    return best;
  }

  async findActiveByDocumentType(documentType: string): Promise<WorkflowDefinitionRecord | null> {
    let best: WorkflowDefinitionRecord | null = null;
    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      if (!record.definition.documentTypes.includes(documentType as any)) continue;
      if (!best || record.definition.version > best.definition.version) best = record;
    }
    return best;
  }

  async listActive(): Promise<WorkflowDefinitionRecord[]> {
    return [...this.records.values()].filter((r) => r.status === "active");
  }
}
```

- [ ] **Step 5: MySQL repository**

```ts
// backend/src/workflow-definition/mysql-repository.ts
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import type { WorkflowDefinitionRecord, WorkflowDefinitionRepository } from "./repository";
import type { WorkflowDefinition } from "./schema";

export class MysqlWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  constructor(private readonly db: MysqlDatabase) {}

  async upsert(record: WorkflowDefinitionRecord): Promise<void> {
    const { definition, sourcePath, sourceHash, status, importedAt } = record;
    await this.db.execute(
      `INSERT INTO workflow_definition
         (id, version, name, document_types, entry_stage, body_json, source_path, source_hash, status, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name),
         document_types=VALUES(document_types),
         entry_stage=VALUES(entry_stage),
         body_json=VALUES(body_json),
         source_path=VALUES(source_path),
         source_hash=VALUES(source_hash),
         status=VALUES(status),
         imported_at=VALUES(imported_at)`,
      [
        definition.id,
        definition.version,
        definition.name,
        JSON.stringify(definition.documentTypes),
        definition.entryStage,
        JSON.stringify(definition),
        sourcePath,
        sourceHash,
        status,
        importedAt
      ]
    );
  }

  async deprecatePreviousVersions(id: string, keepVersion: number): Promise<void> {
    await this.db.execute(
      `UPDATE workflow_definition SET status='deprecated' WHERE id=? AND version<>? AND status='active'`,
      [id, keepVersion]
    );
  }

  async findByIdAndVersion(id: string, version: number): Promise<WorkflowDefinitionRecord | null> {
    const rows = (await this.db.query(
      `SELECT * FROM workflow_definition WHERE id=? AND version=? LIMIT 1`,
      [id, version]
    )) as any[];
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async findActiveById(id: string): Promise<WorkflowDefinitionRecord | null> {
    const rows = (await this.db.query(
      `SELECT * FROM workflow_definition WHERE id=? AND status='active' ORDER BY version DESC LIMIT 1`,
      [id]
    )) as any[];
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async findActiveByDocumentType(documentType: string): Promise<WorkflowDefinitionRecord | null> {
    const rows = (await this.db.query(
      `SELECT * FROM workflow_definition WHERE status='active' AND JSON_CONTAINS(document_types, JSON_QUOTE(?)) ORDER BY version DESC LIMIT 1`,
      [documentType]
    )) as any[];
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async listActive(): Promise<WorkflowDefinitionRecord[]> {
    const rows = (await this.db.query(
      `SELECT * FROM workflow_definition WHERE status='active' ORDER BY id, version`,
      []
    )) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: any): WorkflowDefinitionRecord {
    const definition = typeof row.body_json === "string" ? JSON.parse(row.body_json) : row.body_json;
    return {
      definition: definition as WorkflowDefinition,
      sourcePath: row.source_path,
      sourceHash: row.source_hash,
      status: row.status,
      importedAt: typeof row.imported_at === "string" ? row.imported_at : new Date(row.imported_at).toISOString()
    };
  }
}
```

- [ ] **Step 6: Repository contract test**

```ts
// tests/workflow-definition/mysql-repository.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { InMemoryWorkflowDefinitionRepository } from "../../backend/src/workflow-definition/in-memory-repository";
import type { WorkflowDefinitionRecord } from "../../backend/src/workflow-definition/repository";

function makeRecord(id: string, version: number, documentType: string = "prd"): WorkflowDefinitionRecord {
  return {
    definition: {
      id,
      version,
      name: `${id} v${version}`,
      documentTypes: [documentType as any],
      entryStage: "start",
      policy: {
        approvalSource: "jira_status",
        qualityFailureAction: "human_clarification",
        revisionTrigger: "explicit_request",
        feedbackSources: ["app"]
      },
      stages: {
        start: { label: "Start", jobTemplate: { jobType: "prd.generate_draft" as any, runner: { requiredCapability: "x" } }, on: { success: "end" } },
        end: { type: "terminal", kind: "completed" }
      }
    },
    sourcePath: `workflows/definitions/${id}.v${version}.yaml`,
    sourceHash: `hash-${id}-${version}`,
    status: "active",
    importedAt: "2026-05-23T00:00:00.000Z"
  };
}

describe("WorkflowDefinitionRepository contract (in-memory)", () => {
  let repo: InMemoryWorkflowDefinitionRepository;

  beforeEach(() => {
    repo = new InMemoryWorkflowDefinitionRepository();
  });

  test("upsert + findByIdAndVersion", async () => {
    const r = makeRecord("prd-confirmation", 1);
    await repo.upsert(r);
    const fetched = await repo.findByIdAndVersion("prd-confirmation", 1);
    expect(fetched?.definition.id).toBe("prd-confirmation");
    expect(fetched?.definition.version).toBe(1);
  });

  test("findActiveById returns the highest active version", async () => {
    await repo.upsert(makeRecord("prd-confirmation", 1));
    await repo.upsert(makeRecord("prd-confirmation", 2));
    const found = await repo.findActiveById("prd-confirmation");
    expect(found?.definition.version).toBe(2);
  });

  test("findActiveByDocumentType returns the highest active version matching documentType", async () => {
    await repo.upsert(makeRecord("prd-confirmation", 1, "prd"));
    await repo.upsert(makeRecord("prd-confirmation", 2, "prd"));
    await repo.upsert(makeRecord("hld-pipeline", 1, "hld"));
    const found = await repo.findActiveByDocumentType("prd");
    expect(found?.definition.id).toBe("prd-confirmation");
    expect(found?.definition.version).toBe(2);
  });

  test("deprecatePreviousVersions marks earlier versions deprecated", async () => {
    await repo.upsert(makeRecord("prd-confirmation", 1));
    await repo.upsert(makeRecord("prd-confirmation", 2));
    await repo.deprecatePreviousVersions("prd-confirmation", 2);
    const v1 = await repo.findByIdAndVersion("prd-confirmation", 1);
    expect(v1?.status).toBe("deprecated");
    const active = await repo.findActiveById("prd-confirmation");
    expect(active?.definition.version).toBe(2);
  });

  test("listActive returns only active records", async () => {
    await repo.upsert(makeRecord("a", 1));
    await repo.upsert(makeRecord("b", 1));
    await repo.deprecatePreviousVersions("a", 99); // marks "a" v1 as deprecated since 99 != 1
    const list = await repo.listActive();
    expect(list.length).toBe(1);
    expect(list[0].definition.id).toBe("b");
  });
});
```

- [ ] **Step 7: Registry**

```ts
// backend/src/workflow-definition/registry.ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowDefinitionYaml } from "./parser";
import { validateWorkflowDefinition } from "./validator";
import type { WorkflowDefinitionRecord, WorkflowDefinitionRepository } from "./repository";

export interface RegistryBootstrapOptions {
  definitionsRoot: string;
  now?: () => Date;
  actorEmail?: string;
}

export interface RegistryBootstrapResult {
  loaded: Array<{ id: string; version: number; sourcePath: string; status: "imported" | "unchanged" }>;
  actorEmail?: string;
}

export class WorkflowDefinitionRegistry {
  constructor(private readonly repository: WorkflowDefinitionRepository) {}

  async bootstrap(options: RegistryBootstrapOptions): Promise<RegistryBootstrapResult> {
    const now = (options.now ?? (() => new Date()))().toISOString();
    const files = await this.findYamlFiles(options.definitionsRoot);
    const loaded: RegistryBootstrapResult["loaded"] = [];

    for (const sourcePath of files) {
      const source = await readFile(sourcePath, "utf8");
      const definition = parseWorkflowDefinitionYaml(source);
      validateWorkflowDefinition(definition);
      const sourceHash = sha256(source);

      const existing = await this.repository.findByIdAndVersion(definition.id, definition.version);
      if (existing && existing.sourceHash === sourceHash) {
        loaded.push({ id: definition.id, version: definition.version, sourcePath, status: "unchanged" });
        continue;
      }

      const record: WorkflowDefinitionRecord = {
        definition,
        sourcePath,
        sourceHash,
        status: "active",
        importedAt: now
      };
      await this.repository.upsert(record);
      await this.repository.deprecatePreviousVersions(definition.id, definition.version);
      loaded.push({ id: definition.id, version: definition.version, sourcePath, status: "imported" });
    }

    return { loaded };
  }

  private async findYamlFiles(root: string): Promise<string[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
        .map((e) => join(root, e.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 8: Registry tests**

```ts
// tests/workflow-definition/registry.test.ts
import { describe, test, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryWorkflowDefinitionRepository } from "../../backend/src/workflow-definition/in-memory-repository";
import { WorkflowDefinitionRegistry } from "../../backend/src/workflow-definition/registry";

const YAML_V1 = `
id: test-flow
version: 1
name: Test
documentTypes: [prd]
entryStage: start
policy:
  approvalSource: jira_status
  qualityFailureAction: human_clarification
  revisionTrigger: explicit_request
  feedbackSources: [app]
stages:
  start:
    label: Start
    jobTemplate:
      jobType: prd.generate_draft
      runner: { requiredCapability: x }
    on: { success: end }
  end:
    type: terminal
    kind: completed
`;

const YAML_V2 = YAML_V1.replace("version: 1", "version: 2").replace("name: Test", "name: Test (changed)");

describe("WorkflowDefinitionRegistry.bootstrap", () => {
  let tempDir: string;
  let repo: InMemoryWorkflowDefinitionRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wf-def-"));
    repo = new InMemoryWorkflowDefinitionRepository();
  });

  test("imports a new definition on first run", async () => {
    writeFileSync(join(tempDir, "test.yaml"), YAML_V1);
    const registry = new WorkflowDefinitionRegistry(repo);
    const result = await registry.bootstrap({ definitionsRoot: tempDir });
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0].status).toBe("imported");
    rmSync(tempDir, { recursive: true });
  });

  test("idempotent re-run with unchanged file is no-op", async () => {
    writeFileSync(join(tempDir, "test.yaml"), YAML_V1);
    const registry = new WorkflowDefinitionRegistry(repo);
    await registry.bootstrap({ definitionsRoot: tempDir });
    const result = await registry.bootstrap({ definitionsRoot: tempDir });
    expect(result.loaded[0].status).toBe("unchanged");
    rmSync(tempDir, { recursive: true });
  });

  test("bumped version is imported and previous is deprecated", async () => {
    writeFileSync(join(tempDir, "test.yaml"), YAML_V1);
    const registry = new WorkflowDefinitionRegistry(repo);
    await registry.bootstrap({ definitionsRoot: tempDir });

    writeFileSync(join(tempDir, "test.yaml"), YAML_V2);
    const result = await registry.bootstrap({ definitionsRoot: tempDir });
    expect(result.loaded[0].version).toBe(2);
    expect(result.loaded[0].status).toBe("imported");

    const v1 = await repo.findByIdAndVersion("test-flow", 1);
    expect(v1?.status).toBe("deprecated");
    rmSync(tempDir, { recursive: true });
  });

  test("missing definitionsRoot returns empty result", async () => {
    const registry = new WorkflowDefinitionRegistry(repo);
    const result = await registry.bootstrap({ definitionsRoot: join(tempDir, "nonexistent") });
    expect(result.loaded).toHaveLength(0);
  });
});
```

- [ ] **Step 9: Run all PR1-so-far tests**

```
npm run typecheck
npm test -- tests/workflow-definition/
npm test -- tests/mysql-migration.test.ts
```

Expected:
- typecheck: clean
- workflow-definition test files: all green (schema + interpreter + registry + mysql-repository contract)
- migration test: green with 006 in expected list

- [ ] **Step 10: Run the full suite**

```
npm test
```

Expected: 44+ files / 325 + N tests pass (where N = new test count from PR0 and PR1 tasks).

- [ ] **Step 11: Commit**

```bash
git add migrations/mysql/006_workflow_definition.sql \
        tests/mysql-migration.test.ts \
        backend/src/workflow-definition/repository.ts \
        backend/src/workflow-definition/in-memory-repository.ts \
        backend/src/workflow-definition/mysql-repository.ts \
        tests/workflow-definition/mysql-repository.test.ts \
        backend/src/workflow-definition/registry.ts \
        tests/workflow-definition/registry.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow-definition): add migration 006, repository, and bootstrap registry

- migrations/mysql/006_workflow_definition.sql: new workflow_definition table
  plus idempotent ALTERs adding definition_id/version/current_stage_id/
  stage_attempt_counts columns to workflow_task (pattern from migration 004).
- backend/src/workflow-definition/{repository,in-memory-repository,mysql-repository}.ts:
  WorkflowDefinitionRepository contract with active-version, document-type,
  and deprecate operations. In-memory + MySQL implementations.
- backend/src/workflow-definition/registry.ts: WorkflowDefinitionRegistry.bootstrap()
  scans a definitions directory, parses + validates each YAML, computes sha256,
  upserts on hash change, deprecates previous versions, no-op when unchanged.
- Unit tests for repository contract (in-memory) and registry bootstrap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### PR 1 close-out

After Task 12 commit, the workflow-definition package is complete and self-tested. Nothing existing calls it yet. PR 1 ready.

```
npm run typecheck
npm test
npm --prefix apps/workflow-app run build
```

All three must pass. Push and open PR 1 if desired; merge before PR 2.

---

# PR 2: PRD Interpreter Wire-in

Replaces the PRD-specific transition logic with interpreter delegation, updates the route_decided contract, pins definitions on intake, adds reload endpoint, and deletes the `prdConfirmationWorkflowPolicy` constant. The 8 oracle test files in Spec §9.1 must NOT be modified.

## Task 13: route_decided contract update

Spec §6.2 note: The PRD route_downstream skill currently emits `status: "succeeded"` on success and `status: "needs_scope_confirmation"` on clarification. Add an explicit `route_decided` status on success so the interpreter can distinguish the two.

**Files:**
- Modify: `scripts/document-runner-engine.mjs`
- Modify: `backend/src/document-core/prompt-contracts.ts`

- [ ] **Step 1: Read the current PRD route_downstream contract**

Open `backend/src/document-core/prompt-contracts.ts`. Find the PRD route_downstream prompt and its expected output schema. Identify where `status` values are described.

- [ ] **Step 2: Update the prompt contract to add `route_decided`**

Edit the prompt contract documentation (the comment block describing valid `status` values) to include `route_decided` as the success status. Find the section that currently lists `needs_scope_confirmation` and add `route_decided` alongside.

- [ ] **Step 3: Update document-runner-engine.mjs**

Open `scripts/document-runner-engine.mjs`. Find the route_downstream handling. After the skill returns, if the output indicates success (no `needs_scope_confirmation`), normalize the status to `route_decided` if it isn't already. Be defensive: a missing or `succeeded` status should map to `route_decided`. A `needs_scope_confirmation` status passes through unchanged.

The exact edit shape depends on the current code. Find the route_downstream branch and add:

```js
// Normalize route_downstream success status to "route_decided" so the
// definition-driven interpreter can distinguish the success path from
// needs_scope_confirmation.
if (jobType === "prd.route_downstream") {
  if (result.status !== "needs_scope_confirmation") {
    result.status = "route_decided";
  }
}
```

(Place after the runner returns its JSON object and before it is sent to the API.)

- [ ] **Step 4: Run the runner-engine test**

```
npm test -- tests/runner-engines/
```

Expected: existing tests still pass. The contract addition should be backward compatible — `succeeded` is mapped to `route_decided`, but consumers using existing `output.route` fields are unaffected.

- [ ] **Step 5: Verify the planner still works with old test fixtures**

```
npm test -- tests/repository-transition-planner.test.ts
```

These tests should pass. They assert on `output.route`, not on `status === "succeeded"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/document-runner-engine.mjs backend/src/document-core/prompt-contracts.ts
git commit -m "$(cat <<'EOF'
feat(runner): normalize prd.route_downstream success to status=route_decided

Adds explicit route_decided status so the upcoming definition-driven
interpreter can distinguish success from needs_scope_confirmation through
the result.status field. Output fields (route, rationale) are unchanged;
existing consumers asserting on output.route are unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 14: Intake pins definition

**Files:**
- Modify: `backend/src/workflow-api/workflow-intake-command.ts`
- Modify: `backend/src/workflow-core/mysql-repository.ts` (persist new columns)
- Modify: `backend/src/workflow-core/in-memory-repository.ts` (mirror in memory)

- [ ] **Step 1: Update mysql-repository to read/write the 4 new workflow_task columns**

Open `backend/src/workflow-core/mysql-repository.ts`. Find the SELECT and INSERT/UPSERT statements for `workflow_task`. Add the 4 new columns (`definition_id`, `definition_version`, `current_stage_id`, `stage_attempt_counts`) to both. Make them nullable in the row → object mapping.

Specifically, where workflow_task rows are mapped to the `WorkflowTask` domain object, add a sibling field — e.g., extend `WorkflowTask` in domain.ts with optional fields:

```ts
// backend/src/workflow-core/domain.ts (extend WorkflowTask)
export interface WorkflowTask {
  id: string;
  runId: string;
  parentTaskId?: string;
  taskType: WorkflowTaskType;
  sourceKey: string;
  title: string;
  status: WorkflowTaskStatus;
  currentDocumentId?: string;
  definitionId?: string;             // NEW
  definitionVersion?: number;        // NEW
  currentStageId?: string;           // NEW
  stageAttemptCounts?: Record<string, number>; // NEW
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

Update the SELECT projection in `mysql-repository.ts` to include the 4 new columns and the row mapper to populate them. Update INSERT/UPSERT to write them.

- [ ] **Step 2: Update in-memory-repository for symmetry**

Open `backend/src/workflow-core/in-memory-repository.ts`. The in-memory store typically stores domain objects directly, so no schema change is needed beyond ensuring the new optional fields are preserved through any `... ` copies.

- [ ] **Step 3: Update workflow-intake-command to inject the definition reference**

```ts
// Add to MysqlWorkflowIntakeCommand constructor:
constructor(
  database: MysqlDatabase,
  options: MysqlWorkflowIntakeCommandOptions & { definitionRepository?: WorkflowDefinitionRepository } = {}
) { ... }

// In recordIntake(), after computing taskId and before the mutation:
const definitionRecord = options.definitionRepository
  ? await options.definitionRepository.findActiveByDocumentType(normalized.documentType)
  : null;

// Add the pin fields to the workflow_task row in the mutation:
workflowTasks: [
  {
    id: taskId,
    runId: normalized.runId,
    taskType: normalized.documentType,
    sourceKey: normalized.sourceKey,
    title,
    status: "draft",
    currentDocumentId: documentId,
    definitionId: definitionRecord?.definition.id,
    definitionVersion: definitionRecord?.definition.version,
    currentStageId: definitionRecord?.definition.entryStage,
    stageAttemptCounts: definitionRecord ? {} : undefined,
    metadata: taskMetadata(metadata, legacyPrdInput),
    createdAt: now,
    updatedAt: now
  }
],
```

Update `MysqlWorkflowIntakeCommandOptions` to include the optional `definitionRepository` field.

- [ ] **Step 4: Run unit tests**

```
npm test -- tests/prd-intake-command.test.ts tests/mysql-workflow-repository.test.ts
```

Expected: existing tests still pass without modification (the new fields are optional). If a test fails because it asserts on the exact shape of the workflow_task object, that's a missing optional field expectation — the test is part of the oracle, so do NOT modify it. Instead, ensure new fields default to undefined when no `definitionRepository` is provided.

- [ ] **Step 5: Run the full suite**

```
npm run typecheck
npm test
```

Expected: all green, no oracle test modified.

- [ ] **Step 6: Commit**

```bash
git add backend/src/workflow-core/domain.ts \
        backend/src/workflow-core/mysql-repository.ts \
        backend/src/workflow-core/in-memory-repository.ts \
        backend/src/workflow-api/workflow-intake-command.ts
git commit -m "$(cat <<'EOF'
feat(workflow-intake): pin definition on workflow_task

Adds optional definitionId, definitionVersion, currentStageId, and
stageAttemptCounts fields to WorkflowTask. Mysql repository reads/writes the
matching columns added in migration 006. workflow-intake-command pulls the
highest active definition matching the documentType from an optional
definitionRepository and pins (id, version, entryStage) on the new task.
Backward-compatible: if no repository is provided, the new fields are
undefined and existing behavior is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 15: Planner delegation

**Files:**
- Modify: `backend/src/workflow-api/prd-transition-planner.ts`

Replace the four explicit PRD handler implementations with one call to `interpretWorkflowEvent`, then translate the interpreter's output into the existing `RepositoryTransition` shape.

- [ ] **Step 1: Add an interpreter adapter function in prd-transition-planner.ts**

The interpreter returns `WorkflowInterpreterOutput` (transitions, jobsToCreate, externalActions, terminal). The legacy `RepositoryTransition` shape uses `transitionType`, `documentStatus`, `documents`, `workflowTasks`, `workflowJobs`, etc. Map between them.

Add to `prd-transition-planner.ts`:

```ts
import { interpretWorkflowEvent, type WorkflowRunState } from "../workflow-definition/interpreter";
import { loadPrdDefinitionForTest } from "...";  // see next step; in production this comes from the registry
import { ... } from "./repository-transition-planner-shared";

// New private function (replaces the 4 existing handlers):
function planPrdTransitionViaInterpreter(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string,
  definition: WorkflowDefinition
): RepositoryTransition {
  const event = workflowJobResultToEvent(input);
  const runState = workflowTaskToRunState(input);
  const output = interpretWorkflowEvent({ definition, runState, event });
  return interpreterOutputToRepositoryTransition(input, output, idGenerator, now);
}

function workflowJobResultToEvent(input: PlanRepositoryWorkflowTransitionInput): WorkflowInterpreterEvent {
  return {
    type: "job.completed",
    jobType: input.job.jobType,
    result: input.result
  };
}

function workflowTaskToRunState(input: PlanRepositoryWorkflowTransitionInput): WorkflowRunState {
  const task = (input.workflowTasks ?? []).find((t) => t.id === input.job.taskId);
  return {
    runId: input.job.runId,
    currentStageId: task?.currentStageId ?? "prd.draft",
    currentTaskId: input.job.taskId ?? "task_unknown",
    attemptCounts: task?.stageAttemptCounts ?? {},
    metadata: {
      sourceKey: input.document.sourceKey,
      prdJiraKey: input.document.sourceKey,
      documentId: input.document.id
    }
  };
}

function interpreterOutputToRepositoryTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  output: WorkflowInterpreterOutput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  // Translation map:
  //   output.transitions[0] (or none)        → transitionType (composed from old + new event)
  //   output.jobsToCreate                    → workflowJobs (built via createFollowUpJob)
  //   output.externalActions                 → currently no-op (Jira mutations stay in the existing path)
  //   output.terminal                        → workflowRuns status change
  //
  // The legacy `transitionType` is preserved for backward compatibility. The
  // new task.stage_entered / task.stage_exited events are emitted by the
  // mutation-applier layer (see Task 16).
  // ... build RepositoryTransition fields, including the documentOutputProjection
  //     side-effects that the original prd.generate_draft handler emitted.
  // For the success path (prd.generate_draft → prd.quality), preserve the
  // documentVersions and artifacts from documentOutputProjection — these are
  // not generated by the interpreter and must come from the legacy projection.
  // Recommendation: keep the projection call AND map the interpreter's
  // transitions into stageTransitionEvents (a new field on RepositoryTransition).
}
```

This is non-trivial. The implementer must:
1. Decide the exact mapping rule (which legacy `transitionType` corresponds to which interpreter outcome).
2. Preserve the document projection side-effects (markdown/wiki artifacts) by calling `documentOutputProjection` for the appropriate paths.
3. Add the `stageTransitionEvents` parallel emission described in Spec §7.5.

Given the complexity, the implementer SHOULD escalate this task if the mapping logic is unclear. The plan author (you) should be ready to provide additional guidance:

| Interpreter output | Legacy transitionType | Notes |
|---|---|---|
| `transitions[0].toStageId == "prd.quality"` from prd.draft | `prd_draft_generated` | call documentOutputProjection; also schedule prd.evaluate_quality from output.jobsToCreate |
| `transitions[0].toStageId == "prd.quality"` from prd.revise | `prd_feedback_revision_applied` | call documentOutputProjection({revision: true}); also schedule prd.evaluate_quality |
| `transitions[0].toStageId == "prd.approval"` from prd.quality (passed) | `prd_quality_passed` | qualityResults included |
| `transitions[0].toStageId == "prd.needs_revision"` from prd.quality | `prd_quality_needs_revision` | qualityResults included |
| `transitions[0].toStageId == "prd.scale_clarification"` from prd.routing | `prd_downstream_scope_confirmation_required` | documentStatus = needs_revision |
| `terminal == "completed"` from prd.routing | `prd_downstream_documents_created` | call createDownstreamDocuments with input.result.output.route |

Use this table to write the translation logic. The translation is a switch on `output.transitions[0]?.toStageId + input.job.jobType`.

- [ ] **Step 2: Replace `planPrdTransition` dispatcher**

```ts
export function planPrdTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const definition = getOrLoadPrdDefinition();
  return planPrdTransitionViaInterpreter(input, idGenerator, now, definition);
}
```

For the definition source, prefer a module-level cache:

```ts
let cachedPrdDefinition: WorkflowDefinition | null = null;

function getOrLoadPrdDefinition(): WorkflowDefinition {
  if (cachedPrdDefinition) return cachedPrdDefinition;
  const yamlPath = join(process.cwd(), "workflows", "definitions", "prd-confirmation.v1.yaml");
  const source = readFileSync(yamlPath, "utf8");
  const def = parseWorkflowDefinitionYaml(source);
  validateWorkflowDefinition(def);
  cachedPrdDefinition = def;
  return def;
}
```

This is a temporary load path until the registry is wired into runtime — see Task 17. For PR2 it is acceptable.

- [ ] **Step 3: Run oracle tests**

```
npm test -- tests/repository-transition-planner.test.ts \
              tests/repository-transition-processor.test.ts \
              tests/workflow-mutation-applier.test.ts \
              tests/workflow-result-command.test.ts \
              tests/workflow-api.test.ts \
              tests/feedback-revision-command.test.ts \
              tests/prd-intake-command.test.ts \
              tests/smoke-mysql-no-fixture.test.ts
```

All must pass without test-file modification. If any fails, fix the interpreter-output-to-RepositoryTransition translation (NOT the test).

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflow-api/prd-transition-planner.ts
git commit -m "$(cat <<'EOF'
refactor(planner): delegate PRD transitions to definition interpreter

prd-transition-planner.ts now calls interpretWorkflowEvent() with a loaded
PRD definition and translates the interpreter's output into the legacy
RepositoryTransition shape. Behavior observationally identical; the existing
8 oracle test files pass unmodified. The definition is loaded once per process
from workflows/definitions/prd-confirmation.v1.yaml; Task 17 replaces this
with the registry-backed load.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 16: Stage events parallel emission

**Files:**
- Modify: `backend/src/workflow-api/workflow-mutation-applier.ts` (extend event types)
- Modify: `backend/src/workflow-api/prd-transition-planner.ts` (emit new events alongside legacy)

- [ ] **Step 1: Extend `WorkflowEvent` type (or whichever the mutation applier consumes) to allow new event types**

Find the event type union in the mutation applier or its interface (`tests/repository-transition-processor.test.ts` may help locate it). Add the four new `event_type` strings as valid: `task.stage_entered`, `task.stage_exited`, `definition.imported`, `definition.reload_requested`. These flow through to `status_events` as-is.

- [ ] **Step 2: In `planPrdTransitionViaInterpreter`, append stage events**

After computing the legacy RepositoryTransition, also emit the corresponding `task.stage_exited` (from current stage) and `task.stage_entered` (to target stage) events. Add an `events` field to the returned mutation, populated with the new event types.

The legacy `prd_*` transition events continue to be emitted (Spec §7.5 explicit debt).

- [ ] **Step 3: Run all tests + smoke**

```
npm run typecheck
npm test
```

Expected: all 325 + new tests pass, no test file modified.

- [ ] **Step 4: Commit**

```bash
git add backend/src/workflow-api/workflow-mutation-applier.ts \
        backend/src/workflow-api/prd-transition-planner.ts
git commit -m "$(cat <<'EOF'
feat(workflow-api): parallel-emit stage events from PRD interpreter

PRD interpreter delegation now emits task.stage_entered / task.stage_exited
alongside the legacy prd_* transitionType events. status_events stores both
event families during this transition slice; the legacy events will be
removed in a successor slice (Spec §12).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 17: Reload endpoint + GET routes + registry boot

**Files:**
- Modify: `backend/src/workflow-api/server.ts`
- Modify: `backend/src/runtime/create-workflow-api-runtime.ts` (boot the registry)

- [ ] **Step 1: Boot the registry at runtime startup**

In `create-workflow-api-runtime.ts`, after MySQL is connected, create the registry:

```ts
import { MysqlWorkflowDefinitionRepository } from "../workflow-definition/mysql-repository";
import { WorkflowDefinitionRegistry } from "../workflow-definition/registry";
import { join } from "node:path";

// ... in the runtime creation function, after db setup:
const definitionRepository = new MysqlWorkflowDefinitionRepository(db);
const definitionRegistry = new WorkflowDefinitionRegistry(definitionRepository);
await definitionRegistry.bootstrap({
  definitionsRoot: join(process.cwd(), "workflows", "definitions")
});
```

Expose both `definitionRepository` and `definitionRegistry` from the runtime return object.

- [ ] **Step 2: Wire the definition repository into the intake command**

Pass `definitionRepository` into `new MysqlWorkflowIntakeCommand(db, { definitionRepository, ... })`.

- [ ] **Step 3: Replace the file-system load in prd-transition-planner with the runtime-supplied definition**

This requires injecting a definition source into the planner. Simplest: keep the file-system cache as a fallback, but also accept a definition supplier passed via the existing input or via a module-level setter (`setPrdDefinitionSupplier`). The cleanest path:

```ts
let definitionSupplier: (() => WorkflowDefinition) | null = null;

export function setPrdDefinitionSupplier(fn: () => WorkflowDefinition): void {
  definitionSupplier = fn;
  cachedPrdDefinition = null;
}

function getOrLoadPrdDefinition(): WorkflowDefinition {
  if (definitionSupplier) return definitionSupplier();
  // ... existing file-system load fallback
}
```

Then in the runtime, call `setPrdDefinitionSupplier(() => /* fetch from registry */)`.

- [ ] **Step 4: Add reload + GET routes to server.ts**

Find an existing GET route pattern in `server.ts` (e.g., `/workflow-runs`) and follow the same pattern. Add:

```ts
if (method === "POST" && path === "/workflow-definitions/reload") {
  const actorEmail = req.headers["x-actor-email"];
  await runtime.definitionRegistry?.bootstrap({
    definitionsRoot: join(process.cwd(), "workflows", "definitions"),
    actorEmail: typeof actorEmail === "string" ? actorEmail : undefined
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "reloaded" }));
  return;
}

if (method === "GET" && path === "/workflow-definitions") {
  const active = await runtime.definitionRepository?.listActive() ?? [];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ definitions: active.map(formatDefinition) }));
  return;
}

if (method === "GET" && path.startsWith("/workflow-definitions/")) {
  const [id, queryString] = path.slice("/workflow-definitions/".length).split("?");
  const version = parseVersionFromQuery(queryString);
  const record = version
    ? await runtime.definitionRepository?.findByIdAndVersion(id, version)
    : await runtime.definitionRepository?.findActiveById(id);
  if (!record) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(formatDefinition(record)));
  return;
}
```

Define `formatDefinition` to return `{ id, version, name, documentTypes, entryStage, status, importedAt, body }`. Reuse types where applicable.

- [ ] **Step 5: Verify**

```
npm run typecheck
npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/runtime/create-workflow-api-runtime.ts \
        backend/src/workflow-api/server.ts \
        backend/src/workflow-api/prd-transition-planner.ts
git commit -m "$(cat <<'EOF'
feat(workflow-api): bootstrap workflow-definition registry; add reload and GET routes

Runtime now bootstraps a WorkflowDefinitionRegistry on startup, importing
YAML definitions from workflows/definitions/. The intake command pulls the
active PRD definition by documentType to pin tasks. Three new routes:
  - POST /workflow-definitions/reload
  - GET  /workflow-definitions
  - GET  /workflow-definitions/:id?version=N
The prd-transition-planner uses an injected definition supplier (registry-
backed) instead of file-system reads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

## Task 18: Delete `prdConfirmationWorkflowPolicy` + integration test + smoke

**Files:**
- Modify: `backend/src/workflow-core/domain.ts` (delete the constant)
- Search across `tests/` and `backend/src/` for direct imports
- Create: `tests/workflow-definition-integration.test.ts`

- [ ] **Step 1: Find consumers of `prdConfirmationWorkflowPolicy`**

```bash
grep -rn "prdConfirmationWorkflowPolicy" backend/src/ tests/ apps/ scripts/
```

Note every match.

- [ ] **Step 2: Replace each consumer**

For test files (oracle): do NOT modify. If an oracle test imports the constant, that means the constant must remain. Re-read Spec §9.1 — if you find an oracle import, escalate to the plan author. The plan assumes only non-oracle files import this constant.

For non-oracle files: replace with `loadTestPrdDefinition()` from `tests/fixtures/prd-definition.ts` or a runtime equivalent that fetches from the registry. Update the import path.

- [ ] **Step 3: Delete the constant + the WorkflowPolicy interface (if no other consumer)**

In `backend/src/workflow-core/domain.ts`, remove lines 64-97 (the `WorkflowPolicy` interface, the `prdConfirmationWorkflowPolicy` const, and the surrounding helper types like `WorkflowApprovalTransitionPolicy` if they have no remaining consumer).

Run `grep -rn "WorkflowPolicy" backend/src/ tests/ apps/ scripts/` to confirm no orphans.

- [ ] **Step 4: Create the integration test**

```ts
// tests/workflow-definition-integration.test.ts
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { startInProcessApi, ApiHarness } from "...";  // existing helper or recreate
import { intakeAndDraftThroughEvaluation } from "...";  // existing helper

describe("workflow-definition integration", () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await startInProcessApi();
  });

  afterAll(async () => {
    await harness.shutdown();
  });

  test("PRD intake pins definition_id=prd-confirmation, version=1, current_stage_id=prd.draft", async () => {
    const { runId } = await harness.intakePrd({ sourceKey: "PRD-WD-INT-1" });
    const task = await harness.fetchTaskForRun(runId);
    expect(task.definitionId).toBe("prd-confirmation");
    expect(task.definitionVersion).toBe(1);
    expect(task.currentStageId).toBe("prd.draft");
  });

  test("each PRD transition emits task.stage_entered and task.stage_exited", async () => {
    const { runId } = await harness.runFullPrdHappyPath({ sourceKey: "PRD-WD-INT-2" });
    const events = await harness.fetchStatusEvents(runId);
    const stageEntered = events.filter((e: any) => e.type === "task.stage_entered");
    const stageExited = events.filter((e: any) => e.type === "task.stage_exited");
    expect(stageEntered.length).toBeGreaterThanOrEqual(4); // draft, quality, approval, routing, completed
    expect(stageExited.length).toBeGreaterThanOrEqual(4);
    const stageSequence = stageEntered.map((e: any) => e.metadata.stageId);
    expect(stageSequence).toContain("prd.draft");
    expect(stageSequence).toContain("prd.quality");
    expect(stageSequence).toContain("prd.approval");
    expect(stageSequence).toContain("prd.routing");
    expect(stageSequence).toContain("completed");
  });

  test("legacy prd_* transition events still emit alongside new stage events", async () => {
    const { runId } = await harness.runFullPrdHappyPath({ sourceKey: "PRD-WD-INT-3" });
    const events = await harness.fetchStatusEvents(runId);
    const transitionTypes = events.map((e: any) => e.metadata?.transitionType).filter(Boolean);
    expect(transitionTypes).toContain("prd_draft_generated");
    expect(transitionTypes).toContain("prd_quality_passed");
    expect(transitionTypes).toContain("prd_downstream_documents_created");
  });
});
```

Adjust harness/helper names to match what `tests/smoke-mysql-no-fixture.test.ts` uses; they should be reusable.

- [ ] **Step 5: Run the integration test**

```
npm test -- tests/workflow-definition-integration.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Run the MySQL smoke**

```powershell
$env:WORKFLOW_MYSQL_PORT='3307'
npm run smoke:mysql:no-fixture
```

Expected: 28 jobs / 4 Code tasks / 8 PR artifacts (the documented stable pattern, Spec §9.5 gate 3).

- [ ] **Step 7: Run the full suite + verify oracle untouched**

```
npm test
git diff origin/main -- tests/workflow-api.test.ts \
                         tests/repository-transition-planner.test.ts \
                         tests/repository-transition-processor.test.ts \
                         tests/workflow-mutation-applier.test.ts \
                         tests/workflow-result-command.test.ts \
                         tests/prd-intake-command.test.ts \
                         tests/feedback-revision-command.test.ts \
                         tests/smoke-mysql-no-fixture.test.ts
```

The diff for the oracle files MUST be empty (Spec §9.5 gate 2). The test count rises by the new tests added (PR0 + PR1 + PR2 integration). All must pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/workflow-core/domain.ts \
        tests/workflow-definition-integration.test.ts
git commit -m "$(cat <<'EOF'
refactor(workflow-core): delete prdConfirmationWorkflowPolicy constant

The PRD workflow is now driven by workflows/definitions/prd-confirmation.v1.yaml
through the workflow-definition interpreter (Spec §6). The hardcoded policy
constant has no remaining consumer. Adds an integration test that verifies
PRD intake pins the definition and that each transition emits stage events
alongside the legacy prd_* events (parallel emission per Spec §7.5).

PR 2 merge gates verified:
- All 8 oracle test files unmodified
- npm test green
- npm run smoke:mysql:no-fixture: 28 jobs / 4 Code tasks / 8 PR artifacts
- task.stage_entered / task.stage_exited present in status_events

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### PR 2 close-out

Final verification:

```
npm run typecheck
npm test
npm --prefix apps/workflow-app run build
$env:WORKFLOW_MYSQL_PORT='3307'; npm run smoke:mysql:no-fixture
```

All must pass. `git diff --stat origin/main` should show:
- 4 new files in `backend/src/workflow-definition/`
- 1 new migration file
- 1 new YAML definition file
- 5-7 new test files (PR0 gap-fills + PR1 unit tests + PR2 integration)
- Modifications to: `package.json`, `package-lock.json`, `backend/src/workflow-core/{domain,mysql-repository,in-memory-repository}.ts`, `backend/src/workflow-api/{workflow-intake-command,prd-transition-planner,workflow-mutation-applier,server}.ts`, `backend/src/runtime/create-workflow-api-runtime.ts`, `scripts/document-runner-engine.mjs`, `backend/src/document-core/prompt-contracts.ts`
- ZERO modifications to oracle test files

Push and open PR 2.

---

## Risks during execution

| Risk | What to do |
|---|---|
| The interpreter-output-to-RepositoryTransition translation in Task 15 is more complex than the table indicates | Escalate. Provide the actual output shapes you encounter. The plan author can refine the table. |
| The route_decided contract change in Task 13 breaks a hidden test | The PRD route_downstream tests assert on `output.route` not `output.status`, per Spec §6.2 note. If a test fails, it's likely the new behavior is correct and the test is over-specified. Pause and escalate; do not modify oracle files. |
| The `WorkflowPolicy` interface or `prdConfirmationWorkflowPolicy` is imported by an oracle test | Escalate. The plan assumed only non-oracle consumers. The fix is either keep the constant temporarily or update non-oracle helpers. |
| MySQL container not running for the smoke | Document the omission in the PR description. Rely on the Vitest in-memory smoke shape test. The smoke is a Spec §9.5 gate 3 — if MySQL is unavailable in this environment, the gate is conditional. |
| `task.stage_entered` event handling conflicts with the existing `workflow.engine_transition` event the planner emits | Add stage events as ADDITIONAL items in the events array; do not replace existing events. The parallel emission is intentional debt per Spec §12. |
| Test count drifts unexpectedly | Compare against the baseline captured during the prelude. A drift of new tests added is expected; a drift down means a regression. |

---

## Definition of done

- PR 0 (optional, recommended): 6 small test additions committed; full suite green.
- PR 1: `backend/src/workflow-definition/` package exists with schema/parser/validator/interpreter/repository/registry; YAML definition file present; migration 006 applied; new unit tests pass; full suite still green; nothing existing calls the new code.
- PR 2: `prdConfirmationWorkflowPolicy` deleted; PRD workflow runs through interpreter; intake pins definition; reload + GET routes work; integration test passes; smoke pattern (28/4/8) preserved; oracle test files unmodified; new `task.stage_*` events present in `status_events` alongside legacy `prd_*` events.
- After all three PRs merge, the workflow-definition slice is complete and the next slice (HLD/LLD/Spec definition-ization) can build on the existing infra.
