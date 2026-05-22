# Session State - 2026-05-22

## Current Direction

Development should proceed in large vertical feature slices rather than small
polish-only steps. The current target slice is the full repository-backed
workflow path:

```text
PRD intake
-> local runner PRD generation/evaluation
-> PRD approval
-> HLD routing/generation/evaluation
-> HLD approval
-> LLD fan-out/generation/evaluation
-> LLD approval
-> Spec fan-out/generation/evaluation
-> Spec approval
-> implementation PR open/status collection
```

## Implemented So Far

- MySQL no-fixture runtime can intake PRDs without the compatibility fixture.
- Local runner claim scope is email-first through `requestedBy` /
  `LOCAL_RUNNER_OWNER_EMAIL`.
- Local runner drain mode exists via `LOCAL_RUNNER_MAX_JOBS`.
- Repository transitions now persist runner-generated document versions,
  markdown/wiki artifacts, quality gate results, and current document pointers.
- `POST /repository-transitions/process-next` processes one pending repository
  transition for bounded local development loops.
- Dashboard has a `Run Local Runner` development control that drains eligible
  API jobs and triggers repository transitions between claims.
- Dashboard has a `Full API Slice` development control that seeds a unique
  synthetic `PRD-SMOKE-DASH-*` request, drains the scoped local runner,
  auto-approves PRD/HLD/LLD/Spec gates, and refreshes the full
  document-to-implementation view.
- Dashboard `Task Delivery Map` shows PRD -> HLD -> LLD -> Spec -> Code task
  lineage. Raw Workflow API jobs are no longer top-level dashboard rows; each
  task owns a nested job history, and implementation PR artifacts are shown on
  Code tasks instead of duplicated on Spec tasks.
- `WorkflowTask` is now a first-class domain/read-model entity. MySQL has a
  `workflow_task` hierarchy, `workflow_job.task_id`, and
  `document.workflow_task_id`; PRD intake, downstream document creation,
  revision jobs, approval-triggered implementation work, and repository
  transitions now attach concrete jobs under stable tasks.
- Runner pause/resume controls now exist end-to-end: API endpoints,
  in-memory/MySQL scheduler persistence, sticky `disabled` state across
  heartbeat/register, dashboard buttons, and regression tests.
- Local runner onboarding now has `npm run doctor:local-runner`, which checks
  API URL, runner identity, owner email, capability/engine scope, required
  Claude/Codex CLI command, GitHub settings for implementation capabilities,
  and workspace writability without registering or claiming work.
- MySQL no-fixture smoke now reaches PRD/HLD/LLD/Spec `approved`, drains
  implementation PR creation/status collection, and verifies `pull_request`
  artifacts for generated Specs.
- Implementation PR status collection now emits `revisionRequired` for GitHub
  review changes and `reworkRequired` for CI-only failures. Repository
  transitions turn that signal into a GitHub feedback item plus a
  `document.revise`/`prd.apply_feedback_revision` job under the target task,
  so Code work can block and route back to the current Spec or an explicit
  upstream HLD/LLD/PRD task.
- Runner onboarding is now exposed through `GET /runner-onboarding` and the
  dashboard `Local Runner Onboarding` panel. It returns/copies PowerShell env
  setup, `npm install`, `npm run doctor:local-runner`, bounded drain, and
  watch commands scoped to the current actor email.
- Code-only implementation rework now has a distinct loop:
  `implementation.collect_pr_status` can schedule `implementation.update_pr`
  under the same Code task for CI-only failures, and `implementation.update_pr`
  schedules another `implementation.collect_pr_status` after updating the PR.
- Local runner workspace preparation now creates the job template `workdir`
  inside the isolated job workspace before execution. This keeps
  `implementation.update_pr` runnable with `workdir: "implementation"` and
  rejects paths that escape the runner workspace.
- GitHub PR status collection now carries the PR head branch, base branch, and
  clone URL into repository transitions. Code-only rework jobs receive those
  fields, and the local runner clones the PR branch into the prepared
  `implementation` workdir before handing control to Codex/Claude.
- The generic CLI bridge now treats `implementation.update_pr` as a code PR
  rework task rather than a document generation task. It instructs the agent to
  use the checked-out branch, apply the smallest code fix, run relevant tests,
  commit locally, and return PR update JSON. The local runner then pushes the
  PR branch before scheduling the next status collection.
- Initial implementation can now happen inside `implementation.open_pr` when a
  local runner has `GITHUB_CLONE_URL` and `LOCAL_RUNNER_WORKSPACE_ROOT`: the
  runner clones the repo, checks out the workflow branch, runs Codex/Claude with
  an initial code implementation prompt, pushes the branch, then creates the
  GitHub PR.
- The initial implementation prompt now asks the AI to return
  `pullRequestTitle` and `pullRequestBody`; the local runner uses those fields
  when opening the PR and falls back to the workflow template only if omitted.
- `skills/implementation.pr-author` now captures the runner skill instructions
  for initial code implementation: inspect context, implement, test when
  practical, commit locally, and return reviewer-ready PR title/body JSON.
- `skills/implementation.pr-updater` now captures the runner skill
  instructions for code-only PR rework after CI/review feedback, and
  `implementation.update_pr` outputs carry that skill metadata.
- PR status collection now persists a new pull request artifact snapshot and
  treats `merged=true` as the terminal Code task signal through
  `implementation_pr_merged`.
- `npm run smoke:mysql:no-fixture` keeps deterministic stub implementation as
  the default, and can opt into real GitHub-backed implementation jobs with
  `SMOKE_IMPLEMENTATION_MODE=github` plus GitHub clone/workspace settings. In
  stub mode, PR status collection now emits a merged terminal PR signal so the
  smoke verifies final workflow-run completion and completed Code task counts.
- Compatibility snapshots now carry first-class `workflowTasks`, document
  `workflowTaskId`, and job `taskId`; snapshot mirroring and result
  projections persist those task links instead of recreating task hierarchy
  from documents at API read time.
- MySQL no-fixture mode now handles the PRD feedback-revision shortcut and
  explicit HLD/LLD `POST /documents/:id/fan-out` requests without the
  compatibility fixture. These paths build jobs from the read model, attach
  them to workflow tasks, and record them through the shared command writers.
- Read-model-backed approval/fan-out scheduling now matches fixture
  idempotency: repeated PRD route, HLD/LLD fan-out, or Spec implementation
  scheduling returns `already_scheduled` instead of inserting duplicate jobs.
  HLD/LLD ADR requests also preserve the fixture split between standard fan-out
  and ADR-only follow-up fan-out.
- No-fixture approval gate refresh now advances already-approved read-model
  PRD/HLD/LLD/Spec documents by scheduling the same downstream route, fan-out,
  or implementation job that an explicit approve action would schedule, while
  still using the idempotent duplicate guard.
- Repository-backed transitions now close the `workflow_run` as `completed`
  only when a terminal `implementation.collect_pr_status` result reports a
  merged implementation PR and every Code task in the read-model summary is
  completed after applying that result. The transition processor passes
  read-model run/task state into the planner, and the shared mutation applier
  persists the run status change in the same transaction as the final Code task
  completion and PR artifact snapshot.
- MySQL migration `004_workflow_task_hierarchy.sql` is now safe to rerun after
  a partial DDL application and backfills document tasks parent-before-child,
  so existing PRD/HLD/LLD/Spec rows do not violate the workflow task self-FK.
- Compatibility snapshots now roll up `workflow_run.status` from first-class
  workflow tasks as well: failed tasks/items mark the run failed, and merged
  completed Code tasks can mark the run completed. This keeps fixture fallback
  views aligned with the no-fixture repository transition semantics.
- Dashboard API mapping now strips pull request artifacts from document task
  rows whenever a first-class Code task exists for the same document, so PR
  state is owned by the Code task in both projected and task-first views.
- Workflow run tree views now expose explicit task parent edges and task-to-job
  edges, and task nodes carry `parentTaskId`. Clients no longer need to infer
  the `workflow -> task -> job` graph from document IDs or node ordering.
- The dashboard now fetches `/workflow-runs/:id/tree` alongside the run summary
  and uses `workflow_task_parent` edges as the source of truth for Connected
  Workflow View links, falling back to item parent IDs only for older API
  responses.
- Dashboard task detail/job history grouping now also uses
  `workflow_task_job` edges before falling back to `job.taskId` or document
  inference, so jobs attach to the task graph emitted by the API.
- Workflow result projection recording now requires explicit `workflowTasks`
  and no longer rebuilds task hierarchy from document IDs when persisting
  runner result snapshots.
- Fixture engine-transition projection now passes affected `workflowTasks`
  into the command writer, and transition events include task IDs, reducing
  another document-derived task reconstruction path.
- Document current read models now include the associated `workflowTask`.
  Read-model approval actions and fixture document-state recording pass that
  task into the transition command so task IDs, parents, and metadata are
  preserved while status/current document pointers are updated.
- Read-model document revision, PRD feedback revision, downstream routing,
  fan-out, and Spec implementation scheduling now prefer
  `current.workflowTask.id` for task ownership before using the legacy
  document-derived task ID fallback.

## Next Work

Continue in large feature slices:

- Continue reducing compatibility projection code now that the API can return
  real tasks and explicit graph edges; fixture/mock views should remain
  fallback-only.

## Validation Baseline

Current good after the full slice:

- `npm run typecheck`
- `npm test` passed: 43 files / 286 tests
- `npm run smoke:mysql:no-fixture` passed through PRD/HLD/LLD/Spec approval,
  implementation PR creation/status collection, final workflow-run completion,
  4 completed Code tasks, and 8 pull request artifacts with 28 processed jobs
- `npm --prefix ui-execution-dashboard-demo run build`
- `npx vitest run tests/local-runner-preflight.test.ts tests/local-runner-github-implementation.test.ts tests/local-runner.test.ts`
- `npm test -- tests/local-runner-github-implementation.test.ts tests/repository-transition-planner.test.ts`
- `npm test -- tests/runner-api.test.ts`
- `npm test -- tests/local-runner.test.ts tests/local-runner-preflight.test.ts tests/document-prompt-contracts.test.ts`
- `npm test -- tests/local-runner.test.ts tests/local-runner-preflight.test.ts tests/local-runner-github-implementation.test.ts tests/integrations/github-client.test.ts tests/repository-transition-planner.test.ts`
- `npm test -- tests/runner-engines/prd-cli-engine-script.test.ts tests/document-prompt-contracts.test.ts tests/local-runner.test.ts`
- `npm test -- tests/local-runner-github-implementation.test.ts tests/document-prompt-contracts.test.ts tests/runner-engines/prd-cli-engine-script.test.ts`
- `npm test -- tests/local-runner-github-implementation.test.ts`
- Browser check passed after onboarding/update-pr changes: dashboard rendered
  `implementation.update_pr` in Local Runner Onboarding, had no visible
  overflow in that panel, and reported no console errors.
- Browser check passed for `Full API Slice`: 28 jobs processed, 8 documents
  approved, 12 visible tasks, no raw job rows, and 4 Code tasks with PR
  artifacts and nested implementation job history
- Browser check passed for runner pause/resume: dashboard runner moved to
  `disabled` with `runner disabled` diagnostics, then back to `online`
- Browser check passed after task domain promotion: dashboard reloaded at
  `http://127.0.0.1:5173/ai-workflow/`, rendered 13 flow nodes in the current
  view, and reported no console errors.
