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
- PR status collection now persists a new pull request artifact snapshot and
  treats `merged=true` as the terminal Code task signal through
  `implementation_pr_merged`.

## Next Work

Continue in large feature slices:

- Replace the smoke stub implementation behavior with GitHub-backed execution
  where `GITHUB_TOKEN` is configured, while keeping stub mode deterministic for
  local tests.
- Continue reducing compatibility projection code now that the API can return
  real tasks; fixture/mock views should remain fallback-only.

## Validation Baseline

Current good after the full slice:

- `npm run typecheck`
- `npm test` passed: 42 files / 260 tests
- `npm run smoke:mysql:no-fixture` passed through PRD/HLD/LLD/Spec approval,
  implementation PR creation/status collection, and 4 pull request artifacts
  with 28 processed jobs
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
