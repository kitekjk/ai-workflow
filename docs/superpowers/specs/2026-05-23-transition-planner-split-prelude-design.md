# Prelude: Transition Planner Split by Job-Type Prefix

- **Date:** 2026-05-23
- **Status:** Approved (brainstorming phase complete; implementation planning next)
- **Slice shape:** Pure refactor, no behavior change
- **Purpose:** De-risk the upcoming `workflow-definition-prd-slice` by isolating PRD-specific transition logic into its own file
- **Follow-up slice:** `2026-05-23-workflow-definition-prd-slice-design.md`

## 1. Background

`backend/src/workflow-api/repository-transition-planner.ts` is 1442 LOC. It exposes one main entry point, `planRepositoryWorkflowTransition()`, which dispatches inside a private `repositoryTransitionFor()` to per-`jobType` handlers. Three distinct concern groups share the file:

- **PRD-specific** job types: `prd.generate_draft`, `prd.apply_feedback_revision`, `prd.evaluate_quality`, `prd.route_downstream`.
- **Generic document** job types used by HLD/LLD/Spec: `document.generate`, `document.evaluate`, `document.revise`, `document.fan_out`.
- **Implementation** job types: `implementation.open_pr`, `implementation.update_pr`, `implementation.collect_pr_status`.

Most helper functions (`documentOutputProjection`, `markdownArtifactFor`, `qualityResultFor`, etc.) are shared across groups.

The upcoming workflow-definition slice replaces the PRD-specific handlers with a single interpreter call. Doing that inside the current 1442-LOC file means the reviewer must read everything to verify nothing else regressed. Splitting first localizes the change.

## 2. Goals

1. PRD-specific transition logic lives in `prd-transition-planner.ts`.
2. Generic document and implementation transitions live in their own files.
3. `repository-transition-planner.ts` becomes a thin router (~150 LOC) that picks a handler by `jobType` prefix and calls it.
4. Existing 325 tests pass without modification — they are the equivalence oracle.
5. No new public API; all currently-exported symbols remain exported from the original path.

## 3. Non-goals

- No logic change. Behavior must be byte-identical to today.
- No splitting of `server.ts`, `App.tsx`, `workflowApi.ts`, or any other monolith — this prelude is laser-focused on the planner.
- No introduction of dependency injection, factories, or registries. Plain module functions called by a `switch` on jobType prefix.
- No reorganization of test files. Tests stay where they are.

## 4. Approach

Module-level split keyed by jobType prefix. The router stays as the only consumer of the per-prefix files.

### 4.1 New layout

```
backend/src/workflow-api/
  repository-transition-planner.ts          (router; ~150 LOC)
  repository-transition-planner-shared.ts   (shared helpers; ~600 LOC)
  prd-transition-planner.ts                 (~200 LOC)
  document-transition-planner.ts            (~250 LOC)
  implementation-transition-planner.ts      (~350 LOC)
```

### 4.2 Routing rule

The router uses the jobType prefix:

```ts
// repository-transition-planner.ts (sketch after split)
export function planRepositoryWorkflowTransition(input, idGenerator, now): RepositoryTransition {
  if (input.result.status === "failed" || input.result.output.status === "failed") {
    return failedTransition();
  }

  const jobType = input.job.jobType;
  if (jobType.startsWith("prd."))            return planPrdTransition(input, idGenerator, now);
  if (jobType.startsWith("document."))       return planDocumentTransition(input, idGenerator, now);
  if (jobType.startsWith("implementation.")) return planImplementationTransition(input, idGenerator, now);

  throw new Error(`Unknown job type for transition: ${jobType}`);
}
```

Special cases that span groups (e.g., `prd.evaluate_quality` and `document.evaluate` share the same handler today) stay together — that handler goes into `document-transition-planner.ts` and `prd-transition-planner.ts` re-exports it or delegates. Decision rule: shared handlers live with the group that owns the broader pattern (`document.*`), and the PRD file calls them when needed.

### 4.3 Shared helpers

`repository-transition-planner-shared.ts` holds helpers used by two or more group files:

- `documentOutputProjection`, `markdownArtifactFor`, `wikiArtifactFor`, `qualityResultFor`, `pullRequestArtifactFor`
- `createFollowUpJob`, `nextJobInputFor`, `nextRevisionEvaluationInputFor`, `revisionResumeForQualityPass`
- `qualityTransitionTypeFor`, `resultStatusFor`, `documentTypeOrUndefined`, plus the small type-narrowing utilities at the bottom of the current file
- The transition input/output types remain in this shared file (or move to a dedicated `repository-transition-types.ts` if cleaner — implementation-time call)

Helpers used only by one group move into that group's file.

### 4.4 Public surface

Today's exported names continue to be exported from `repository-transition-planner.ts`:

- `planRepositoryWorkflowTransition`
- `canPlanRepositoryWorkflowTransition`
- `repositoryWorkflowTransitionJobTypes`
- Plus any types that other modules import

No other module's imports change.

## 5. Implementation Steps (single PR)

1. Create `repository-transition-planner-shared.ts` and move shared helpers; keep them re-exported from the original file so other callers do not break.
2. Create `prd-transition-planner.ts` with the four PRD-prefixed handlers.
3. Create `document-transition-planner.ts` with the four `document.*` handlers (also owns the shared quality-evaluation handler used by PRD).
4. Create `implementation-transition-planner.ts` with the three `implementation.*` handlers.
5. Rewrite `repository-transition-planner.ts` as the router; remove the inlined handlers.
6. Run `npm run typecheck && npm test` — must be green.
7. Run `npm run smoke:mysql:no-fixture` — must produce the same 28 jobs / 4 Code tasks / 8 PR artifacts pattern.

All in one PR. The split is mechanical and atomic; partial states are not useful as checkpoints.

## 6. Test Strategy

### 6.1 Oracle (do not modify)

```
tests/repository-transition-planner.test.ts
tests/repository-transition-processor.test.ts
tests/workflow-mutation-applier.test.ts
tests/workflow-api.test.ts
tests/smoke-mysql-no-fixture.test.ts
tests/feedback-revision-command.test.ts
tests/workflow-result-command.test.ts
tests/repository-transition-api.test.ts
```

These must pass without modification. Any required edit means the split changed behavior — fix the split, do not edit the tests.

### 6.2 No new tests in this prelude

The split has no new behavior, so it does not need new tests. The existing oracle is sufficient.

### 6.3 Merge gate

1. Full `npm test` green with no edits to oracle files.
2. `npm run smoke:mysql:no-fixture` produces 28 jobs / 4 Code tasks / 8 PR artifacts.
3. `git diff --stat` shows: 4 new files, 1 modified file (`repository-transition-planner.ts` shrinks to ~150 LOC), 0 modified test files.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Shared closure or module-scope state breaks across files | Inspect the current file for any module-scope mutable state. There is none today (all functions are pure modulo passed-in `idGenerator`/`now`). |
| Import cycle between shared file and group files | Group files import from shared file only; shared file imports from no group file. One-way edges only. |
| Re-export drift (a caller imports a helper from `repository-transition-planner.ts` that no longer exists there) | Keep `repository-transition-planner.ts` re-exporting all previously public symbols. Verified by `npm run typecheck`. |
| Quality-evaluation handler being shared by PRD and document confuses the boundary | Document explicitly: shared handler lives in `document-transition-planner.ts`; PRD file imports and delegates. Comment in the source. |

## 8. Out-of-scope

| Item | Reason |
|---|---|
| Splitting `server.ts`, `App.tsx`, `workflowApi.ts` | Not required by the workflow-definition slice. Future hygiene. |
| Introducing a `TransitionPlanner` interface / DI | Plain functions are sufficient; no consumer needs polymorphism today. |
| Renaming functions or changing the dispatcher API | This is mechanical relocation only. |
| Test file reorganization | Tests stay where they are; their target imports remain valid through `repository-transition-planner.ts`. |

## 9. Success Criteria

Prelude complete when:

1. PR merged with the file layout from §4.1.
2. `repository-transition-planner.ts` is ≤ 200 LOC and contains only the router + re-exports.
3. Oracle tests pass unmodified.
4. Smoke pattern intact.
5. The follow-up workflow-definition slice can land its PR2 ⑧ step by touching only `prd-transition-planner.ts`.
