# Transition Planner Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `backend/src/workflow-api/repository-transition-planner.ts` (1442 LOC) into per-jobType-prefix modules plus a shared helpers module, behind a thin router. Behavior must remain byte-identical; existing 325 tests are the oracle.

**Architecture:** The current file mixes (1) the main entry/dispatcher, (2) per-jobType handlers grouped by prefix (`prd.*`, `document.*`, `implementation.*`), (3) shared helpers, and (4) group-specific helpers. The split creates one file per group plus a shared helpers file, with the original file shrinking to a thin router (~150 LOC) that dispatches to group entry points. All currently-public exports remain re-exported from the original path so external consumers are not broken.

**Tech Stack:** TypeScript 5.7, Node 20, Vitest 2. Project root `c:\Users\kitek\Works\ai-workflow`. Active branch `claude-dev`.

**Spec:** `docs/superpowers/specs/2026-05-23-transition-planner-split-prelude-design.md`

---

## File Structure (locked-in before tasks)

After this plan completes, `backend/src/workflow-api/` will contain:

| File | Responsibility | Size target |
|---|---|---|
| `repository-transition-planner.ts` | Public entry points (`planRepositoryWorkflowTransition`, `canPlanRepositoryWorkflowTransition`), `repositoryWorkflowTransitionJobTypes`, dispatch by jobType prefix to group plan functions, re-export of public types | ≤200 LOC |
| `repository-transition-planner-shared.ts` | `RepositoryTransition` type, shared transition helpers (projection, artifact builders, quality result builder, follow-up job creation, revision/resume helpers, utility coercions, ID generator, document-task helpers) | ~700 LOC |
| `prd-transition-planner.ts` | Handlers for `prd.generate_draft`, `prd.apply_feedback_revision`, `prd.route_downstream`; downstream document creation helpers | ~200 LOC |
| `document-transition-planner.ts` | Handlers for `document.generate`, `document.evaluate` (also handles `prd.evaluate_quality`), `document.revise`, `document.fan_out` | ~150 LOC |
| `implementation-transition-planner.ts` | Handlers for `implementation.open_pr`, `implementation.update_pr`, `implementation.collect_pr_status`; PR artifact builder, implementation task helpers, code-task completion roll-up | ~400 LOC |

**Import direction (one-way only):**

```
prd-transition-planner.ts        ─┐
document-transition-planner.ts    ├─→  repository-transition-planner-shared.ts
implementation-transition-planner.ts ─┘

repository-transition-planner.ts  ──→ all four files above

prd-transition-planner.ts ──→ document-transition-planner.ts   (for evaluate handler)
```

No edges go the other direction. No file imports from `repository-transition-planner.ts`.

---

## Function-to-file mapping

| Current location (line) | Symbol | Target file |
|---|---|---|
| 25-34 | `PlanRepositoryWorkflowTransitionInput` (interface) | `repository-transition-planner.ts` (kept) |
| 36-39 | `RepositoryWorkflowTransitionPlan` (interface) | `repository-transition-planner.ts` (kept) |
| 41-53 | `repositoryWorkflowTransitionJobTypes` (const) | `repository-transition-planner.ts` (kept) |
| 55-126 | `planRepositoryWorkflowTransition` | `repository-transition-planner.ts` (kept, calls dispatcher) |
| 128-132 | `canPlanRepositoryWorkflowTransition` | `repository-transition-planner.ts` (kept) |
| 134-148 | `RepositoryTransition` (interface) | `repository-transition-planner-shared.ts` (moved, re-exported) |
| 150-441 | `repositoryTransitionFor` (dispatcher body) | Replaced by per-group `planXTransition` calls; body shrinks to a switch |
| 443-494 | `documentOutputProjection` | `repository-transition-planner-shared.ts` |
| 495-526 | `markdownArtifactFor` | `repository-transition-planner-shared.ts` |
| 527-560 | `wikiArtifactFor` | `repository-transition-planner-shared.ts` |
| 561-582 | `qualityResultFor` | `repository-transition-planner-shared.ts` |
| 583-639 | `pullRequestArtifactFor` | `implementation-transition-planner.ts` |
| 640-653 | `implementationRequiresDocumentRevision` | `implementation-transition-planner.ts` |
| 654-666 | `implementationRequiresCodeRework` | `implementation-transition-planner.ts` |
| 667-724 | `implementationUpdateJobInputFor` | `implementation-transition-planner.ts` |
| 725-731 | `implementationPrUpdaterSkill` | `implementation-transition-planner.ts` |
| 732-766 | `implementationUpdateFeedbackFor` | `implementation-transition-planner.ts` |
| 767-824 | `implementationRevisionTargetFor` | `implementation-transition-planner.ts` |
| 825-844 | `implementationRevisionFeedbackFor` | `implementation-transition-planner.ts` |
| 845-870 | `implementationRevisionFeedbackItemFor` | `implementation-transition-planner.ts` |
| 871-891 | `feedbackRecordedEventFor` | `repository-transition-planner-shared.ts` |
| 892-916 | `createFollowUpJob` | `repository-transition-planner-shared.ts` |
| 917-924 | `qualityTransitionTypeFor` | `repository-transition-planner-shared.ts` |
| 925-935 | `nextJobInputFor` | `repository-transition-planner-shared.ts` |
| 936-948 | `nextRevisionEvaluationInputFor` | `repository-transition-planner-shared.ts` |
| 949-963 | `revisionResumeInputFor` | `repository-transition-planner-shared.ts` |
| 964-996 | `revisionResumeForQualityPass` | `repository-transition-planner-shared.ts` |
| 997-1020 | `nextTaskAfterTargetOnPath` | `repository-transition-planner-shared.ts` |
| 1021-1057 | `createResumeJobForTask` | `repository-transition-planner-shared.ts` |
| 1058-1108 | `createImplementationResumeJob` | `implementation-transition-planner.ts` |
| 1109-1119 | `latestWorkflowJobForTask` | `repository-transition-planner-shared.ts` |
| 1120-1129 | `isRevisableTask` | `repository-transition-planner-shared.ts` |
| 1130-1193 | `createDownstreamDocuments` | `prd-transition-planner.ts` |
| 1194-1204 | `downstreamDocumentsFor` | `prd-transition-planner.ts` |
| 1205-1243 | `downstreamDocumentsForFanOut` | `document-transition-planner.ts` (used by `document.fan_out`) |
| 1244-1268 | `explicitDownstreamDocumentsFor` | `prd-transition-planner.ts` |
| 1269-1272 | `resultStatusFor` | `repository-transition-planner-shared.ts` |
| 1273-1304 | `documentTypeOrUndefined`, `stringOrUndefined`, `positiveIntegerOrUndefined`, `scoreOrUndefined`, `stringArrayOrEmpty`, `booleanOrUndefined` | `repository-transition-planner-shared.ts` |
| 1306-1310 | `qualityFailureActionOrUndefined` | `repository-transition-planner-shared.ts` |
| 1312-1326 | `nextDocumentVersion` | `repository-transition-planner-shared.ts` |
| 1328-1345 | `workflowTaskForDocument` | `repository-transition-planner-shared.ts` |
| 1347-1372 | `implementationTaskForJob` | `implementation-transition-planner.ts` |
| 1374-1390 | `completedWorkflowRunFor` | `implementation-transition-planner.ts` |
| 1392-1406 | `allCodeTasksCompleted` | `implementation-transition-planner.ts` |
| 1408-1410 | `documentStatusToTaskStatus` | `repository-transition-planner-shared.ts` |
| 1412-1414 | `taskIdForDocument` | `repository-transition-planner-shared.ts` |
| 1416-1430 | `artifactLocationForUri` | `repository-transition-planner-shared.ts` |
| 1432-1434 | `sha256` | `repository-transition-planner-shared.ts` |
| 1436-1438 | `isRecord` | `repository-transition-planner-shared.ts` |
| 1440-1442 | `defaultIdGenerator` | `repository-transition-planner-shared.ts` |

If a function not in this mapping appears in the file (e.g., I missed a small helper), default to the shared file unless it is clearly tied to one group.

---

## Task 1: Baseline verification

**Files:** No code changes.

- [ ] **Step 1: Verify clean working tree**

```bash
git status --short
```

Expected: empty output. If anything else, stop and ask.

- [ ] **Step 2: Confirm branch**

```bash
git rev-parse --abbrev-ref HEAD
```

Expected: `claude-dev`.

- [ ] **Step 3: Capture current LOC and run baseline tests**

```bash
wc -l backend/src/workflow-api/repository-transition-planner.ts
npm run typecheck
npm test
```

Expected:
- LOC: ~1442
- typecheck: no errors
- tests: 44 files passed, 325 tests passed

- [ ] **Step 4: Note the baseline (no commit yet)**

Save the baseline test count and LOC for later comparison. Do not commit anything.

---

## Task 2: Create shared helpers module

**Files:**
- Create: `backend/src/workflow-api/repository-transition-planner-shared.ts`
- Modify: `backend/src/workflow-api/repository-transition-planner.ts` (remove moved code, add import + re-export)

- [ ] **Step 1: Create `repository-transition-planner-shared.ts` skeleton**

```ts
// backend/src/workflow-api/repository-transition-planner-shared.ts
import { createHash, randomUUID } from "node:crypto";
import type {
  Artifact,
  ArtifactLocation,
  Document,
  DocumentQualityResult,
  DocumentStatus,
  DocumentType,
  DocumentVersion
} from "../document-core/domain";
import type {
  WorkflowEngineTransitionType,
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "../workflow-core/domain";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import type {
  WorkflowDocumentMutationEvent,
  WorkflowFeedbackItem
} from "./workflow-mutation-applier";

// PlanRepositoryWorkflowTransitionInput is re-imported from the public planner
// to keep one definition. The shared module accepts callers passing this input.
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";

export interface RepositoryTransition {
  transitionType: WorkflowEngineTransitionType;
  documentStatus: DocumentStatus;
  documentFields?: Partial<Pick<Document, "currentVersionId" | "currentMarkdownArtifactId" | "currentWikiArtifactId">>;
  workflowRuns?: WorkflowRun[];
  documents: Document[];
  workflowTasks: WorkflowTask[];
  workflowJobs: WorkflowJob[];
  documentVersions?: DocumentVersion[];
  artifacts?: Artifact[];
  qualityResults?: DocumentQualityResult[];
  feedbackItems?: WorkflowFeedbackItem[];
  documentEvents?: WorkflowDocumentMutationEvent[];
  qualityStatus?: string;
}

// (function bodies appended in step 2)
```

If TypeScript flags the circular type import as a problem, move `PlanRepositoryWorkflowTransitionInput` into a tiny `repository-transition-types.ts` file and import from there in both. Decide at implementation time based on the actual error. The shared content of this plan does not change.

- [ ] **Step 2: Copy shared helper bodies into the new file**

From `backend/src/workflow-api/repository-transition-planner.ts`, copy the *bodies* of these functions to `repository-transition-planner-shared.ts` and prefix each declaration with `export`. Keep names and signatures exactly as they appear in the source:

```
documentOutputProjection            (lines 443-494)
markdownArtifactFor                  (lines 495-526)
wikiArtifactFor                      (lines 527-560)
qualityResultFor                     (lines 561-582)
feedbackRecordedEventFor             (lines 871-891)
createFollowUpJob                    (lines 892-916)
qualityTransitionTypeFor             (lines 917-924)
nextJobInputFor                      (lines 925-935)
nextRevisionEvaluationInputFor       (lines 936-948)
revisionResumeInputFor               (lines 949-963)
revisionResumeForQualityPass         (lines 964-996)
nextTaskAfterTargetOnPath            (lines 997-1020)
createResumeJobForTask               (lines 1021-1057)
latestWorkflowJobForTask             (lines 1109-1119)
isRevisableTask                      (lines 1120-1129)
resultStatusFor                      (lines 1269-1272)
documentTypeOrUndefined              (lines 1273-1278)
stringOrUndefined                    (lines 1279-1282)
positiveIntegerOrUndefined           (lines 1283-1287)
scoreOrUndefined                     (lines 1288-1297)
stringArrayOrEmpty                   (lines 1298-1301)
booleanOrUndefined                   (lines 1302-1304)
qualityFailureActionOrUndefined      (lines 1306-1310)
nextDocumentVersion                  (lines 1312-1326)
workflowTaskForDocument              (lines 1328-1345)
documentStatusToTaskStatus           (lines 1408-1410)
taskIdForDocument                    (lines 1412-1414)
artifactLocationForUri               (lines 1416-1430)
sha256                                (lines 1432-1434)
isRecord                              (lines 1436-1438)
defaultIdGenerator                    (lines 1440-1442)
```

Do not modify the function bodies. Mark each as `export function` (or `export const` for `defaultIdGenerator` if originally arrow). If a helper references another helper now in the same file, no change needed (intra-file calls work).

- [ ] **Step 3: Modify the original file to import + re-export**

In `backend/src/workflow-api/repository-transition-planner.ts`:

1. Delete the function/interface declarations that were moved (matching the line ranges above).
2. At the top of the file (just below existing imports), add:

```ts
import {
  documentOutputProjection,
  markdownArtifactFor,
  wikiArtifactFor,
  qualityResultFor,
  feedbackRecordedEventFor,
  createFollowUpJob,
  qualityTransitionTypeFor,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  revisionResumeInputFor,
  revisionResumeForQualityPass,
  nextTaskAfterTargetOnPath,
  createResumeJobForTask,
  latestWorkflowJobForTask,
  isRevisableTask,
  resultStatusFor,
  documentTypeOrUndefined,
  stringOrUndefined,
  positiveIntegerOrUndefined,
  scoreOrUndefined,
  stringArrayOrEmpty,
  booleanOrUndefined,
  qualityFailureActionOrUndefined,
  nextDocumentVersion,
  workflowTaskForDocument,
  documentStatusToTaskStatus,
  taskIdForDocument,
  artifactLocationForUri,
  sha256,
  isRecord,
  defaultIdGenerator,
  type RepositoryTransition
} from "./repository-transition-planner-shared";
```

3. After the existing public exports, add an explicit re-export for the moved type so external test files that import `RepositoryTransition` from this path still resolve:

```ts
export type { RepositoryTransition } from "./repository-transition-planner-shared";
```

Note: most helpers above are kept as named imports for internal use by the remaining handlers in this file (those will move out in later tasks). Do not re-export the helpers publicly; external code does not import them.

- [ ] **Step 4: Remove `createHash`/`randomUUID` imports from original if no longer used**

After the moves, check whether `createHash` (used by `sha256`) and `randomUUID` (used by `defaultIdGenerator`) are still referenced in `repository-transition-planner.ts`. If not, remove them from the top `import` line. Run typecheck after.

- [ ] **Step 5: Verify typecheck and tests pass**

```bash
npm run typecheck
npm test
```

Expected:
- typecheck: no errors
- tests: 44 files passed, 325 tests passed (same count as baseline)

If a test fails or typecheck reports unresolved symbols, the function inventory is incomplete. Re-read the original lines, locate the missing helper, and either move it to shared or keep it local. Do not change test files.

- [ ] **Step 6: Commit**

```bash
git add backend/src/workflow-api/repository-transition-planner-shared.ts \
        backend/src/workflow-api/repository-transition-planner.ts
git commit -m "$(cat <<'EOF'
refactor(planner): extract shared transition helpers to dedicated module

Move RepositoryTransition type plus document projection, artifact, quality,
follow-up job, revision/resume, and small coercion helpers from the 1442-LOC
repository-transition-planner.ts to a new repository-transition-planner-shared.ts.
The original file imports them and continues to expose RepositoryTransition for
existing callers via re-export.

No behavior change. All 325 tests pass unmodified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create implementation planner module

**Files:**
- Create: `backend/src/workflow-api/implementation-transition-planner.ts`
- Modify: `backend/src/workflow-api/repository-transition-planner.ts`

- [ ] **Step 1: Create `implementation-transition-planner.ts` skeleton**

```ts
// backend/src/workflow-api/implementation-transition-planner.ts
import type { Artifact, Document } from "../document-core/domain";
import type {
  WorkflowJob,
  WorkflowJobResult,
  WorkflowRun,
  WorkflowTask
} from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import type { WorkflowFeedbackItem } from "./workflow-mutation-applier";
import {
  type RepositoryTransition,
  booleanOrUndefined,
  createFollowUpJob,
  feedbackRecordedEventFor,
  positiveIntegerOrUndefined,
  sha256,
  stringOrUndefined
} from "./repository-transition-planner-shared";

// Public entry: dispatches to the three implementation.* handlers.
export function planImplementationTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  if (jobType === "implementation.open_pr")            return planImplementationOpenPr(input, idGenerator, now);
  if (jobType === "implementation.update_pr")          return planImplementationUpdatePr(input, idGenerator, now);
  if (jobType === "implementation.collect_pr_status")  return planImplementationCollectPrStatus(input, idGenerator, now);
  throw new Error(`Unknown implementation job type: ${jobType}`);
}

// (handler functions and helpers appended below)
```

- [ ] **Step 2: Move implementation handlers and helpers**

Cut the bodies of the three `implementation.*` blocks from `repositoryTransitionFor` in the original file (lines 271-438 in the original, which contain the three if-blocks for `implementation.open_pr`, `implementation.update_pr`, `implementation.collect_pr_status`) and wrap each as a private function inside the new file:

```ts
function planImplementationOpenPr(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  // Body from the original `if (input.job.jobType === "implementation.open_pr") { ... return {...}; }`
  // i.e. lines 272-306 of the original file (without the surrounding if condition).
}

function planImplementationUpdatePr(/* same signature */): RepositoryTransition {
  // Body from original lines 310-352.
}

function planImplementationCollectPrStatus(/* same signature */): RepositoryTransition {
  // Body from original lines 356-437.
}
```

Then move (cut from original, paste into new file) and mark as private (non-exported) these helpers:

```
pullRequestArtifactFor              (lines 583-639)
implementationRequiresDocumentRevision  (lines 640-653)
implementationRequiresCodeRework    (lines 654-666)
implementationUpdateJobInputFor     (lines 667-724)
implementationPrUpdaterSkill        (lines 725-731)
implementationUpdateFeedbackFor     (lines 732-766)
implementationRevisionTargetFor     (lines 767-824)
implementationRevisionFeedbackFor   (lines 825-844)
implementationRevisionFeedbackItemFor (lines 845-870)
createImplementationResumeJob       (lines 1058-1108)
implementationTaskForJob            (lines 1347-1372)
completedWorkflowRunFor             (lines 1374-1390)
allCodeTasksCompleted               (lines 1392-1406)
```

- [ ] **Step 3: Update the original dispatcher to delegate**

In `backend/src/workflow-api/repository-transition-planner.ts`, replace the three `if (input.job.jobType === "implementation.*")` blocks inside `repositoryTransitionFor` with a single delegation:

```ts
if (input.job.jobType.startsWith("implementation.")) {
  return planImplementationTransition(input, idGenerator, now);
}
```

Place this delegation where the first `implementation.open_pr` block used to be. Delete the other two implementation blocks. Add the import at the top:

```ts
import { planImplementationTransition } from "./implementation-transition-planner";
```

Remove from the original any imports that were only used by the moved implementation helpers (e.g., `booleanOrUndefined` if it was only used by implementation paths — but it is also used by PRD code in the same file, so leave it).

- [ ] **Step 4: Verify typecheck and tests pass**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean, 325 tests pass. If a test breaks, do not edit it — fix the move.

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflow-api/implementation-transition-planner.ts \
        backend/src/workflow-api/repository-transition-planner.ts
git commit -m "$(cat <<'EOF'
refactor(planner): extract implementation transition handlers to dedicated module

Move implementation.open_pr / implementation.update_pr / implementation.collect_pr_status
handlers plus their PR artifact, feedback, revision, resume, task, and code-task
roll-up helpers into a new implementation-transition-planner.ts. The dispatcher
now delegates any implementation.* jobType through planImplementationTransition().

No behavior change. All 325 tests pass unmodified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create document planner module

**Files:**
- Create: `backend/src/workflow-api/document-transition-planner.ts`
- Modify: `backend/src/workflow-api/repository-transition-planner.ts`

- [ ] **Step 1: Create `document-transition-planner.ts` skeleton**

```ts
// backend/src/workflow-api/document-transition-planner.ts
import type { Document, DocumentType } from "../document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import {
  type RepositoryTransition,
  createFollowUpJob,
  documentOutputProjection,
  documentTypeOrUndefined,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  qualityResultFor,
  qualityTransitionTypeFor,
  resultStatusFor,
  revisionResumeForQualityPass,
  stringArrayOrEmpty,
  stringOrUndefined
} from "./repository-transition-planner-shared";

// Public entry: dispatches to the document.* handlers AND the shared
// quality-evaluation handler used by both document.evaluate and prd.evaluate_quality.
export function planDocumentTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  if (jobType === "document.generate")  return planDocumentGenerate(input, idGenerator, now);
  if (jobType === "document.revise")    return planDocumentRevise(input, idGenerator, now);
  if (jobType === "document.fan_out")   return planDocumentFanOut(input, idGenerator, now);
  if (jobType === "document.evaluate" || jobType === "prd.evaluate_quality") {
    return planQualityEvaluation(input, idGenerator, now);
  }
  throw new Error(`Unknown document/quality job type: ${jobType}`);
}

// Exported so prd-transition-planner.ts can delegate the shared quality handler.
export function planQualityEvaluation(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  // Body from original lines 221-233 (the `prd.evaluate_quality` || `document.evaluate` block).
}

// (rest of handlers and helpers below)
```

- [ ] **Step 2: Move document.* handler bodies and `downstreamDocumentsForFanOut`**

From the original file, copy bodies of these blocks into the new file as private functions:

```
`document.generate`   block at lines 193-204  → planDocumentGenerate
`document.revise`     block at lines 206-219  → planDocumentRevise
`document.fan_out`    block at lines 258-269  → planDocumentFanOut
shared evaluate block at lines 221-233        → planQualityEvaluation (already exported)
```

Each `plan*` is a private function with the same `(input, idGenerator, now): RepositoryTransition` signature. Copy the function body exactly; the only change is removing the `if (jobType === ...)` outer wrap.

Also move the helper:

```
downstreamDocumentsForFanOut  (lines 1205-1243)
```

Keep it private to this file.

- [ ] **Step 3: Update the original dispatcher to delegate**

In `repository-transition-planner.ts`, replace the four blocks above with one delegation:

```ts
if (
  input.job.jobType === "document.generate" ||
  input.job.jobType === "document.revise" ||
  input.job.jobType === "document.fan_out" ||
  input.job.jobType === "document.evaluate" ||
  input.job.jobType === "prd.evaluate_quality"
) {
  return planDocumentTransition(input, idGenerator, now);
}
```

Order matters: place this delegation BEFORE the `prd.route_downstream` branch, so the `prd.evaluate_quality` jobType is captured here before any PRD-prefix catch-all (none exists currently, but be explicit). Add the import:

```ts
import { planDocumentTransition } from "./document-transition-planner";
```

- [ ] **Step 4: Verify typecheck and tests pass**

```bash
npm run typecheck
npm test
```

Expected: clean, 325 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflow-api/document-transition-planner.ts \
        backend/src/workflow-api/repository-transition-planner.ts
git commit -m "$(cat <<'EOF'
refactor(planner): extract document/quality transition handlers to dedicated module

Move document.generate / document.revise / document.fan_out and the shared
quality evaluation handler (used by both document.evaluate and prd.evaluate_quality)
to a new document-transition-planner.ts. The dispatcher delegates these five
job types through planDocumentTransition(). planQualityEvaluation is exported
so the PRD planner can reuse it in the next task.

No behavior change. All 325 tests pass unmodified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Create PRD planner module

**Files:**
- Create: `backend/src/workflow-api/prd-transition-planner.ts`
- Modify: `backend/src/workflow-api/repository-transition-planner.ts`

- [ ] **Step 1: Create `prd-transition-planner.ts` skeleton**

```ts
// backend/src/workflow-api/prd-transition-planner.ts
import type { Document, DocumentType } from "../document-core/domain";
import type { WorkflowJob, WorkflowJobResult, WorkflowTask } from "../workflow-core/domain";
import type { PlanRepositoryWorkflowTransitionInput } from "./repository-transition-planner";
import { planQualityEvaluation } from "./document-transition-planner";
import {
  type RepositoryTransition,
  createFollowUpJob,
  documentOutputProjection,
  documentTypeOrUndefined,
  nextJobInputFor,
  nextRevisionEvaluationInputFor,
  stringOrUndefined
} from "./repository-transition-planner-shared";

// Public entry: dispatches to the PRD-prefixed handlers, including delegating
// prd.evaluate_quality to the shared quality evaluation handler.
export function planPrdTransition(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  const jobType = input.job.jobType;
  if (jobType === "prd.generate_draft")             return planPrdGenerateDraft(input, idGenerator, now);
  if (jobType === "prd.apply_feedback_revision")    return planPrdApplyFeedbackRevision(input, idGenerator, now);
  if (jobType === "prd.evaluate_quality")           return planQualityEvaluation(input, idGenerator, now);
  if (jobType === "prd.route_downstream")           return planPrdRouteDownstream(input, idGenerator, now);
  throw new Error(`Unknown PRD job type: ${jobType}`);
}

// (handlers and helpers below)
```

- [ ] **Step 2: Move PRD handler bodies and helpers**

Copy these block bodies into the new file as private functions:

```
prd.generate_draft           block at lines 165-176 → planPrdGenerateDraft
prd.apply_feedback_revision  block at lines 178-191 → planPrdApplyFeedbackRevision
prd.route_downstream         block at lines 235-256 → planPrdRouteDownstream
```

Also move (cut from original, paste into new file, keep private):

```
createDownstreamDocuments         (lines 1130-1193)
downstreamDocumentsFor             (lines 1194-1204)
explicitDownstreamDocumentsFor    (lines 1244-1268)
```

- [ ] **Step 3: Update the original dispatcher to delegate**

In `repository-transition-planner.ts`, replace the three remaining `prd.*` blocks plus the route_downstream branch with one delegation. After Task 4's changes, the dispatcher should now have these branches (in order):

1. `if (input.result.status === "failed" || ...)` → return job_failed (unchanged)
2. `if (jobType in {document.*, document.evaluate, prd.evaluate_quality})` → planDocumentTransition (from Task 4)
3. `if (jobType.startsWith("implementation."))` → planImplementationTransition (from Task 3)
4. **New:** `if (jobType.startsWith("prd."))` → planPrdTransition

Replace branches 2 through 4 of step 3 above with the cleaner final form:

```ts
if (input.job.jobType.startsWith("prd."))            return planPrdTransition(input, idGenerator, now);
if (input.job.jobType.startsWith("document."))       return planDocumentTransition(input, idGenerator, now);
if (input.job.jobType.startsWith("implementation.")) return planImplementationTransition(input, idGenerator, now);
throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
```

Note: `prd.evaluate_quality` is captured by `prd.*` and forwarded inside `planPrdTransition` to `planQualityEvaluation`. The standalone `document.evaluate` is captured by `document.*` and likewise forwarded. The double-binding to the same shared handler is intentional.

Add the import:

```ts
import { planPrdTransition } from "./prd-transition-planner";
```

- [ ] **Step 4: Verify typecheck and tests pass**

```bash
npm run typecheck
npm test
```

Expected: clean, 325 pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/workflow-api/prd-transition-planner.ts \
        backend/src/workflow-api/repository-transition-planner.ts
git commit -m "$(cat <<'EOF'
refactor(planner): extract PRD transition handlers to dedicated module

Move prd.generate_draft / prd.apply_feedback_revision / prd.route_downstream
plus PRD-specific downstream document helpers to a new prd-transition-planner.ts.
The PRD planner delegates prd.evaluate_quality to the shared quality handler in
document-transition-planner.ts. The dispatcher now consists of three prefix-based
delegations to the per-group plan functions.

No behavior change. All 325 tests pass unmodified.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Reduce original to thin router and verify final shape

**Files:**
- Modify: `backend/src/workflow-api/repository-transition-planner.ts`

- [ ] **Step 1: Audit the original file for leftover code**

Open `backend/src/workflow-api/repository-transition-planner.ts`. After Tasks 2-5, it should contain only:

- Imports
- `PlanRepositoryWorkflowTransitionInput` interface
- `RepositoryWorkflowTransitionPlan` interface
- `repositoryWorkflowTransitionJobTypes` const
- `planRepositoryWorkflowTransition` (the main entry)
- `canPlanRepositoryWorkflowTransition`
- `repositoryTransitionFor` (which is now mostly the three prefix delegations + the job_failed early-return)
- Re-export line for `RepositoryTransition`

Remove any orphaned helper that no test or other file references. Run:

```bash
npm run typecheck
```

If it flags unused imports (e.g., `createHash`, `randomUUID`, or any helper now imported but no longer used in this file), remove them. Re-run typecheck until clean.

- [ ] **Step 2: Confirm LOC target**

```bash
wc -l backend/src/workflow-api/repository-transition-planner.ts
```

Expected: ≤ 200 LOC. If above 200, look for helper bodies still resident in the file and move them to the appropriate group or shared file.

- [ ] **Step 3: Confirm router shape**

Inspect `repositoryTransitionFor` (the private function called from `planRepositoryWorkflowTransition`). After Task 5 its body should be approximately:

```ts
function repositoryTransitionFor(
  input: PlanRepositoryWorkflowTransitionInput,
  idGenerator: (prefix: string) => string,
  now: string
): RepositoryTransition {
  if (input.result.status === "failed" || input.result.output.status === "failed") {
    return {
      transitionType: "job_failed",
      documentStatus: "canceled",
      documents: [],
      workflowTasks: [],
      workflowJobs: []
    };
  }

  if (input.job.jobType.startsWith("prd."))            return planPrdTransition(input, idGenerator, now);
  if (input.job.jobType.startsWith("document."))       return planDocumentTransition(input, idGenerator, now);
  if (input.job.jobType.startsWith("implementation.")) return planImplementationTransition(input, idGenerator, now);

  throw new Error(`No repository workflow transition mapped for job type: ${input.job.jobType}`);
}
```

If the body differs, simplify to this shape.

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: 44 files passed, 325 tests passed. Compare counts to baseline from Task 1. If different, the split is incorrect — fix the move, do not edit tests.

- [ ] **Step 5: Run MySQL smoke**

```bash
$env:WORKFLOW_MYSQL_PORT='3307'
npm run smoke:mysql:no-fixture
```

(PowerShell syntax — the smoke needs the MySQL container running on port 3307 per session-state-2026-05-22. If the user's MySQL is on a different port, set the env accordingly.)

Expected: smoke passes, summary shows 28 processed jobs, 4 completed Code tasks, 8 pull request artifacts (the documented pattern).

If MySQL is not running, document this in the PR description and rely on `npm test` results (which include `tests/smoke-mysql-no-fixture.test.ts` for the in-memory smoke shape).

- [ ] **Step 6: Confirm no test file modified**

```bash
git diff --stat origin/main -- tests/
```

Expected: empty output. If any test file appears, that's a merge-gate failure — revert any test edits before continuing.

- [ ] **Step 7: Confirm public surface unchanged**

Verify exports:

```bash
grep -n "^export" backend/src/workflow-api/repository-transition-planner.ts
```

Expected output lines (order may vary):

```
export interface PlanRepositoryWorkflowTransitionInput
export interface RepositoryWorkflowTransitionPlan
export const repositoryWorkflowTransitionJobTypes
export function planRepositoryWorkflowTransition
export function canPlanRepositoryWorkflowTransition
export type { RepositoryTransition } from "./repository-transition-planner-shared"
```

If any of those is missing, restore the export.

- [ ] **Step 8: Commit**

```bash
git add backend/src/workflow-api/repository-transition-planner.ts
git commit -m "$(cat <<'EOF'
refactor(planner): finalize router shape and prune unused imports

repository-transition-planner.ts is now a thin router (~150 LOC) that delegates
to prd-transition-planner.ts, document-transition-planner.ts, and
implementation-transition-planner.ts by jobType prefix. Public surface
(PlanRepositoryWorkflowTransitionInput, RepositoryWorkflowTransitionPlan,
repositoryWorkflowTransitionJobTypes, planRepositoryWorkflowTransition,
canPlanRepositoryWorkflowTransition, RepositoryTransition re-export) is unchanged.

Merge gates verified:
- npm run typecheck: clean
- npm test: 44 files / 325 tests pass, no test file modified
- npm run smoke:mysql:no-fixture: 28 jobs / 4 Code tasks / 8 PR artifacts
- LOC of original file ≤ 200

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: PR readiness

**Files:** No code changes.

- [ ] **Step 1: Review commit log**

```bash
git log --oneline origin/main..HEAD
```

Expected: 5 new commits (one per Task 2-6), each labeled `refactor(planner): ...`. If the history is messy (intermediate broken states), consider an interactive rebase only if explicitly requested — otherwise leave as is.

- [ ] **Step 2: Generate diff statistics**

```bash
git diff --stat origin/main
```

Expected:
- 4 created files: `repository-transition-planner-shared.ts`, `prd-transition-planner.ts`, `document-transition-planner.ts`, `implementation-transition-planner.ts`
- 1 modified file: `repository-transition-planner.ts` (large negative delta, ending around ~150 LOC)
- 0 modified test files

- [ ] **Step 3: Verify each new file size is within target**

```bash
wc -l backend/src/workflow-api/repository-transition-planner.ts \
      backend/src/workflow-api/repository-transition-planner-shared.ts \
      backend/src/workflow-api/prd-transition-planner.ts \
      backend/src/workflow-api/document-transition-planner.ts \
      backend/src/workflow-api/implementation-transition-planner.ts
```

Expected approximate sizes:
- `repository-transition-planner.ts`: ≤ 200
- `repository-transition-planner-shared.ts`: ~700
- `prd-transition-planner.ts`: ~200
- `document-transition-planner.ts`: ~150
- `implementation-transition-planner.ts`: ~400

A variance of ±50 LOC per file is acceptable; substantial deviation suggests a function landed in the wrong file.

- [ ] **Step 4: Final test run on the full suite**

```bash
npm run typecheck
npm test
npm --prefix apps/workflow-app run build
```

All three must pass.

- [ ] **Step 5: Stop. The PR is ready for human review.**

Do not push or open a PR unless the operator explicitly asks. Report to the operator:

- Number of commits
- Final file sizes
- Test counts (should match baseline: 44 files / 325 tests)
- Whether MySQL smoke ran (and its result) or was skipped

Wait for explicit instruction before any `git push` or `gh pr create`.

---

## Risks during execution

| Risk | What to do |
|---|---|
| A function not in the line-mapping table is discovered during the move | Default to shared; if clearly tied to one group, place there. Do not invent new shared abstractions. |
| Circular type import between shared and the original (via `PlanRepositoryWorkflowTransitionInput`) | Move the interface into a new `repository-transition-types.ts` file imported by both. Do not change its shape. |
| A test fails with a missing symbol | A move was incomplete. Find which file the test imports from, locate the symbol's intended target file, re-add the export there. Never edit the test. |
| `git diff --stat` shows a modified test file | Revert any test edits with `git checkout HEAD -- tests/` and find the actual cause. |
| MySQL container not running for the smoke step | Skip the smoke step, note this in the PR description, rely on Vitest smoke shape test (`tests/smoke-mysql-no-fixture.test.ts`). |
| The router file exceeds 200 LOC | A helper body is still resident. Identify and move it to the appropriate file. |
| Import lint / unused import warnings after a task | Remove the unused import in the same task before commit. |

---

## Definition of done

- 4 new files created at the paths in §File Structure
- `repository-transition-planner.ts` ≤ 200 LOC and exposes the original public symbols
- Existing test files unchanged
- `npm run typecheck`, `npm test`, `npm --prefix apps/workflow-app run build` all green
- `npm run smoke:mysql:no-fixture` green (or explicitly noted as skipped with MySQL unavailable)
- 5 commits on the branch labeled `refactor(planner): ...`
