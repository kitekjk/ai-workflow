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
- Workflow API now defaults to the MySQL no-fixture runtime; the old PRD
  confirmation fixture is explicit legacy opt-in only.
- Legacy PRD confirmation code has moved to
  `backend/src/legacy/prd-confirmation`, while shared contracts such as Jira
  issue shape, feedback items, workflow policy, and transition event types now
  live in non-legacy core/integration modules.
- Runtime wiring is split so product integration settings live in
  `backend/src/runtime/integration-config.ts`, the old fixture factory lives in
  `backend/src/runtime/legacy-prd-runtime.ts`, and the historical
  `backend/src/runtime/create-runtime.ts` compatibility re-export has been
  removed.
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
- Runner onboarding is now exposed through `GET /runner-onboarding` for the
  future settings or runner management surface. It returns PowerShell env
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
- MySQL no-fixture smoke can now opt into real CLI-backed document jobs with
  `SMOKE_DOCUMENT_MODE=cli` while keeping implementation jobs stubbed or
  separately opting into `SMOKE_IMPLEMENTATION_MODE=github`. This lets PRD/HLD/
  LLD/Spec generation, evaluation, routing, and fan-out exercise the same
  `JobTemplateCliLocalRunnerEngine` used by developer PCs.
- CLI document smoke mode now fails fast before migrations/API startup when the
  selected `RUNNER_ENGINE` is unsupported or the matching `CODEX_CLI_PATH` /
  `CLAUDE_CLI_PATH` cannot be resolved.
- Compatibility snapshots now carry first-class `workflowTasks`, document
  `workflowTaskId`, and job `taskId`; snapshot mirroring and result
  projections persist those task links instead of recreating task hierarchy
  from documents at API read time.
- Workflow API legacy fixture calls are now behind
  `backend/src/workflow-api/legacy-prd-compatibility.ts`; server code no
  longer imports `backend/src/legacy/prd-confirmation/*` directly. The old
  engine transition projection implementation is isolated as
  `legacy-prd-engine-transition-projection.ts`; the public
  `engine-transition-projection.ts` compatibility export has been removed.
- Legacy PRD MySQL snapshot loader/mirror wiring is now created through the
  same compatibility module. `create-workflow-api-runtime.ts` no longer imports
  legacy snapshot persistence directly and no longer exposes `snapshotLoader`;
  callers only get `snapshotMirror` for the old server fixture path plus
  `restorePrdSnapshot()` for startup restoration.
- Legacy fixture command projection is isolated in
  `backend/src/workflow-api/legacy-prd-command-projection.ts`, and legacy
  write-route orchestration now lives in
  `backend/src/workflow-api/legacy-prd-server-actions.ts`. The server no
  longer imports command projection or route-action modules directly; old
  fixture routes go through the server-action facade for route action,
  repository-backed command projection, and snapshot persistence. `server.ts`
  also no longer reads `legacyPrd.fixture` directly or scatters
  `context.legacyPrd` mode checks through route handlers; repository-backed
  behavior is gated by an explicit `repositoryBackedMode` flag, and legacy
  operations are exposed to request handlers as a `legacyPrdActions` port.
- Legacy fixture read projection is isolated in
  `backend/src/workflow-api/legacy-prd-read-projection.ts`. Old fixture-backed
  state/run/tree/document current/history views are exposed through
  `LegacyPrdWorkflowApiReadModel`, and the server gets that adapter through
  `legacy-prd-server-actions.ts` so legacy read internals stay behind the same
  compatibility facade.
- Legacy fixture route actions are isolated in
  `backend/src/workflow-api/legacy-prd-route-actions.ts`. `server.ts` no longer
  creates legacy snapshots directly and no longer reaches into `fixture.store`
  or `fixture.workflow`; fixture-backed intake, feedback, wiki feedback,
  revision, and fan-out actions go through compatibility helpers.
- The Workflow API server now accepts legacy behavior only through an explicit
  `LegacyPrdCompatibility` facade. Runtime/main/smoke wiring and legacy tests
  pass `legacyPrd`; the old raw `fixture` and `snapshotMirror` server inputs
  have been removed from the public server creation surface.
- Workflow API runtime results also no longer expose raw legacy `fixture` or
  `snapshotMirror` fields. Legacy runtime state is reachable only through
  `runtime.legacyPrd`, while product no-fixture runtimes keep that field
  undefined.
- Fixture-backed read views now sit behind `LegacyPrdWorkflowApiReadModel`, so
  server read routes use the same `WorkflowApiReadModel` surface for both
  repository-backed and compatibility-backed views. The old public
  `engine-transition-projection.ts` shim has also been removed; tests and
  compatibility code import `legacy-prd-engine-transition-projection.ts`
  directly when they need fixture projection internals.
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
- Operator-driven manual job retry now exists end-to-end:
  `POST /runner-jobs/:id/retry` moves failed/canceled/skipped jobs back to
  `retrying`, records a `job.retry_requested` event, and dashboard API mode has
  selected-job Cancel/Retry controls wired to the scheduler.
- The API now exposes a task-first dashboard bundle at
  `GET /workflow-runs/:id/dashboard`. The dashboard uses it when available so
  run, task tree, document current/history, and ledger events travel together;
  older multi-request mapping remains as a fallback for legacy servers.
- The dashboard bundle still includes runner diagnostics and local-runner
  onboarding scoped by `ownerEmail`, so a future runner management page can
  hydrate status and setup commands from one run-scoped snapshot.
- Workflow run tree job nodes now resolve `primaryDocumentId` from the
  first-class task link before input/document fallbacks, and the dashboard task
  mapper only uses document-based job grouping when no task-job edge or
  `job.taskId` link exists.
- Repository transition processing now follows the same task-first document
  selection rule: `job.taskId` resolves through the read-model task's
  `currentDocumentId` before older job input document fields are considered.
- Result projection and compatibility engine-transition events no longer guess
  a run from the first job/document when the target job is missing or the batch
  spans multiple runs; they only emit run-scoped events when the run id is
  explicit or unambiguous.
- Workflow job recording now preserves `job.input.taskId` as the durable task
  link when explicit command task fields are absent, and job-recorded events
  carry the same task ID.
- MySQL read-model task/job edges and repository transition document selection
  now use the same durable task-link rule: `workflow_job.task_id` first, then
  `job.input.taskId`. Older rows with only input metadata still render under
  the correct task and process against that task's current document.
- Manual job retry now reopens the owning task as executable work:
  `prd.evaluate_quality`/`document.evaluate` retries move the task to
  `quality_review`, other retries move it to `in_progress`, and the retry
  event records `taskId`/`taskStatus`. Dashboard task rows let active task
  state override stale document state so a retrying task appears running.
- Operator task retry now exists end-to-end:
  `POST /workflow-tasks/:id/retry` finds that task's latest failed/canceled/
  skipped job, routes it through the same manual retry path, returns the
  reopened task plus retried job, and the dashboard exposes a Retry Task
  control alongside lower-level Retry Job.
- Manual upstream rework now exists end-to-end:
  `POST /workflow-tasks/:id/request-revision` blocks the source task, reopens
  the selected upstream PRD/HLD/LLD/ADR/Spec task as `in_progress`, creates the
  correct revision job under that target task, records a
  `task.revision_requested` event, and the dashboard exposes a Target selector
  plus Send Back control for task-level rerouting.
- Upstream rework now resumes downstream work after quality passes:
  revision jobs carry `sourceTaskId`/`targetTaskId` into their evaluation jobs.
  When that evaluation passes, repository transitions walk the target-to-source
  task path, reopen the next blocked child task, and create the next revision
  or implementation update job. Revising LLD resumes Spec first; revising Spec
  resumes Code with `implementation.update_pr` when PR metadata is available.
- Dashboard information architecture was simplified: `Task Delivery Map` is now
  the canonical task-first table, the redundant `Workflow Execution Tree` panel
  was removed, and the lower content area now focuses on Selected Item plus
  Status Events side by side on desktop-sized widths.
- Runner operations were removed from the workflow detail surface: `Runner
  Status` and `Local Runner Onboarding` no longer render on the current detail
  page, and runner setup/status is reserved for a future settings or runner
  management screen.
- Repository layout was clarified before the next feature slice:
  frontend code moved from `ui-execution-dashboard-demo` to
  `apps/workflow-app`, while backend/domain/runner code moved from root `src`
  to `backend/src`.
- Workflow API legacy read/write behavior now reaches the HTTP server through
  `createLegacyPrdServerActions()` and a `LegacyPrdServerActions` port. Route
  handlers use `legacyPrdActions` for old fixture-only actions and
  `repositoryBackedMode` for product paths, so `server.ts` no longer imports
  legacy command/read/route projection internals or reads `context.legacyPrd`
  directly.
- The server creation surface no longer accepts `legacyPrd` directly. HTTP
  server wiring now takes a neutral `compatibilityActionsFactory` from
  `backend/src/workflow-api/compatibility-actions.ts`; app entrypoints and
  legacy tests assemble that factory through `legacy-prd-server-actions.ts`.
  This keeps PRD fixture construction outside `server.ts` while preserving the
  old compatibility opt-in path.
- Product intake/state clients can now avoid PRD-specific route names:
  `POST /workflow-runs/intake` accepts a Jira source key plus document/workflow
  type metadata, and `GET /workflow-sources/:sourceKey/state` returns the
  source state through the same read model. The dashboard Full API Slice,
  MySQL no-fixture smoke, README, and deployment runbook now use the new
  workflow/source routes. `/prd/intake` and `/state/:sourceKey` remain
  compatibility aliases.
- Source-scoped feedback revision now has a product route as well:
  `POST /workflow-sources/:sourceKey/feedback-revision` accepts source type,
  document type, actor, and feedback, then uses the same repository-backed or
  compatibility action path as the old `/prd/feedback-revision` alias.
- Workflow listing now has a product API and dashboard path:
  `GET /workflow-runs?limit=N` returns recent workflow runs from the read
  model, MySQL and legacy read models implement the list surface, and the
  dashboard merges that list into the Workflow List. In API mode, selecting a
  different listed run loads that run's detail/dashboard bundle.
- Workflow intake command code now has a product-named
  `backend/src/workflow-api/workflow-intake-command.ts`; the old
  `prd-intake-command.ts` file is only a compatibility re-export. The product
  `/workflow-runs/intake` route can now create repository-backed workflows from
  `jira`, `app`, or `github` sources and can seed root `prd`, `hld`, `lld`,
  `adr`, or `spec` tasks. Non-PRD roots start with a `document.generate` job.
- The dashboard Workflow List now includes a compact create form wired to the
  same product intake route, so operators can seed Jira PRD runs or app/GitHub
  document-root runs without using the old PRD-specific action.
- Planning was reprioritized around "Runnable End-to-End First". The goal is
  the real product workflow becoming executable across runner, skills/plugins,
  workflow/task/job state, artifacts, and pull request status. UI work should
  remain minimal until that execution path is stable.
- Runner lease renewal is now implemented end-to-end. The scheduler/repository
  exposes lease extension, the API has `POST /runner-jobs/:id/renew-lease`,
  `WorkflowApiRunnerClient` calls it, and `runLocalRunnerOnce` renews the lease
  while workspace preparation, CLI execution, artifact upload, and completion
  are in flight.
- Local runner cancellation is now cooperative during execution. The runner
  polls claimed jobs for `cancel_requested`, passes an `AbortSignal` into local
  engines, and the CLI engine terminates its child process when the signal
  fires. `LOCAL_RUNNER_CANCELLATION_POLL_MS` controls the poll interval.
- Runner failures now carry a normalized `errorCategory` across runner client,
  API, scheduler events, in-memory/MySQL repositories, and
  `workflow_job_result.error_category`. Local runner failures classify missing
  packages as `dependency`, invalid runner output as `result_contract`,
  workspace/artifact path issues as `workspace`, GitHub/PR issues as `github`,
  and generic CLI/runtime failures as `engine`.
- Runner skill/plugin dependency resolution and preparation now exist in
  `backend/src/local-runner/package-resolver.ts`. Jobs can declare
  `runnerSkill`, `requiredSkills`, `runnerRequirements.skills`,
  `runnerPlugin`, `requiredPlugins`, or typed `requiredRunnerPackages`; the
  local runner checks them before engine execution and fails non-retryably with
  `runner_package_missing` when required packages are absent. With
  `LOCAL_RUNNER_PACKAGE_AUTO_INSTALL=true`, the runner can copy matching
  packages from configured skill/plugin registry roots into the local install
  roots before execution. Requirements can now also include `source` or
  `installSource`, letting the runner install a specific package from a local
  path, `file://` URL, or git/GitHub source before resolving it from the local
  roots. `npm run prepare:local-runner-packages` runs the same prepare flow
  without claiming a job. Preflight also validates implementation PR
  author/updater skill packages for implementation capabilities.

## Next Work

Continue in large feature slices:

- Build the real runnable workflow path across PRD/HLD/LLD/Spec/Code/pull
  request status, using the actual local runner path rather than dashboard
  canned output.
- Tighten runner runtime completeness around observable logs and shutdown
  behavior now that lease renewal, cooperative cancellation, package
  resolution, and normalized failure categories are in place.
- Harden remote package installation with allowlists, checksum/signature
  verification, and marketplace-specific auth if package sources move beyond
  trusted repo/local paths.
- Wire the real workflow path across PRD/HLD/LLD/Spec/Code/pull request status
  using workflow -> task -> job, where repeated evaluation or revision creates
  more jobs under the same visible task.
- Keep dashboard work to the minimum needed to operate and observe the real
  path: workflow create/select, task/job attempts, runner/job status, and
  generated artifacts. Keep canned runner output separated as a development
  harness rather than the product local runner path.

## Validation Baseline

Current good after the full slice:

- `npm run typecheck`
- `npm test` passed: 44 files / 325 tests
- `npm test -- tests/smoke-mysql-no-fixture.test.ts tests/local-runner-preflight.test.ts`
  passed after adding fail-fast CLI smoke prerequisite validation.
- `npm test -- tests/local-runner.test.ts tests/runner-engines/cli-engine.test.ts`
  passed after adding cooperative runner cancellation signaling.
- `npm test -- tests/local-runner.test.ts tests/runner-api.test.ts tests/workflow-scheduler.test.ts tests/mysql-workflow-repository.test.ts tests/mysql-migration.test.ts tests/repository-transition-work-reader.test.ts tests/prd-snapshot-loader.test.ts tests/workflow-mutation-applier.test.ts`
  passed after adding normalized runner failure categories.
- `npm test -- tests/local-runner.test.ts tests/local-runner-preflight.test.ts`
  passed after adding package-specific `source` / `installSource` package
  preparation.
- `LOCAL_RUNNER_CAPABILITIES=implementation.open_pr,implementation.update_pr
  npm run prepare:local-runner-packages` passed and resolved the repository
  `implementation.pr-author` / `implementation.pr-updater` packages.
- PowerShell `$env:WORKFLOW_MYSQL_PORT='3307'; npm run smoke:mysql:no-fixture`
  passed on the local workflow MySQL container at `127.0.0.1:3307`, completing
  the PRD/HLD/LLD/Spec/Code stub implementation path with 28 processed jobs,
  4 completed Code tasks, 8 pull request artifacts, and explicit
  `documentMode: "stub"` / `implementationMode: "stub"` summary fields.
- `npm run smoke:mysql:no-fixture` passed through PRD/HLD/LLD/Spec approval,
  implementation PR creation/status collection, final workflow-run completion,
  4 completed Code tasks, and 8 pull request artifacts with 28 processed jobs
- `npm --prefix apps/workflow-app run build`
- `git diff --check` passed with only existing line-ending normalization
  warnings.
- `npm test -- tests/workflow-api-legacy-boundary.test.ts tests/workflow-api.test.ts tests/runtime/create-runtime.test.ts`
  passed after the legacy server-action facade boundary was tightened.
- `npm test -- tests/workflow-api-legacy-boundary.test.ts tests/workflow-api.test.ts tests/runner-api.test.ts tests/local-runner.test.ts tests/local-runner-github-implementation.test.ts tests/runtime/create-runtime.test.ts`
  passed after replacing direct server `legacyPrd` input with the compatibility
  action factory.
- `npm test -- tests/workflow-api.test.ts tests/smoke-mysql-no-fixture.test.ts`
  passed after adding product workflow/source intake-state routes and moving
  dashboard/smoke clients to them.
- `npm test -- tests/workflow-api.test.ts` passed after adding
  `/workflow-sources/:sourceKey/feedback-revision`.
- `npm test -- tests/workflow-api.test.ts tests/workflow-api-read-model.test.ts tests/runtime/create-runtime.test.ts`
  and `npm --prefix apps/workflow-app run build` passed after adding workflow
  run listing and dashboard list/detail loading.
- `npx vitest run tests/local-runner-preflight.test.ts tests/local-runner-github-implementation.test.ts tests/local-runner.test.ts`
- `npm test -- tests/local-runner-github-implementation.test.ts tests/repository-transition-planner.test.ts`
- `npm test -- tests/runner-api.test.ts`
- `npm test -- tests/local-runner.test.ts tests/local-runner-preflight.test.ts tests/document-prompt-contracts.test.ts`
- `npm test -- tests/local-runner.test.ts tests/local-runner-preflight.test.ts tests/local-runner-github-implementation.test.ts tests/integrations/github-client.test.ts tests/repository-transition-planner.test.ts`
- `npm test -- tests/runner-engines/prd-cli-engine-script.test.ts tests/document-prompt-contracts.test.ts tests/local-runner.test.ts`
- `npm test -- tests/local-runner-github-implementation.test.ts tests/document-prompt-contracts.test.ts tests/runner-engines/prd-cli-engine-script.test.ts`
- `npm test -- tests/local-runner-github-implementation.test.ts`
- Browser check passed after onboarding/update-pr API changes:
  `implementation.update_pr` appeared in the generated runner setup data and
  the page reported no console errors before the runner detail panels were
  later removed from the workflow detail screen.
- Browser check passed for `Full API Slice`: 28 jobs processed, 8 documents
  approved, 12 visible tasks, no raw job rows, and 4 Code tasks with PR
  artifacts and nested implementation job history
- Browser check passed for runner pause/resume: dashboard runner moved to
  `disabled` with `runner disabled` diagnostics, then back to `online`
- Browser check passed after task domain promotion: dashboard reloaded at
  `http://127.0.0.1:5173/ai-workflow/`, rendered 13 flow nodes in the current
  view, and reported no console errors.
- Browser check passed after manual retry and dashboard bundle work: dashboard
  reloaded at `http://127.0.0.1:5173/ai-workflow/`, rendered Connected
  Workflow View, Selected Item, and Cancel/Retry Job controls, with no console
  errors.
- Browser check passed after retry task-state mapping: dashboard reloaded at
  `http://127.0.0.1:5173/ai-workflow/`, rendered 13 flow nodes, 11 task rows,
  Connected Workflow View, Task Delivery Map, Selected Item, and Status Events
  with no console errors.
- `npm test -- tests\workflow-scheduler.test.ts tests\runner-api.test.ts tests\mysql-workflow-repository.test.ts`
  passed after task-level retry.
- Browser check passed after task-level retry UI: dashboard reloaded at
  `http://127.0.0.1:5173/ai-workflow/`, rendered Retry Task/Retry Job
  controls, had no horizontal body overflow, and reported no console errors.
- `npm test -- tests\workflow-scheduler.test.ts tests\runner-api.test.ts`
  passed after manual upstream rework.
- Browser check passed after Send Back UI: dashboard reloaded at
  `http://127.0.0.1:5173/ai-workflow/`, rendered Target and Send Back
  controls, had no horizontal body overflow, and reported no console errors.
- `npm test -- tests\repository-transition-planner.test.ts tests\repository-transition-processor.test.ts`
  passed after downstream resume/cascade transitions.
- Browser check passed after removing Workflow Execution Tree: dashboard
  rendered Task Delivery Map, did not render Workflow Execution Tree, showed
  Selected Item and Status Events side by side at the current browser width,
  had no horizontal body overflow, and reported no console errors.
- Browser check passed after compacting Status Events: event rows no longer
  overflow inside the side panel, the log panel sizes to its content, Selected
  Item and Status Events remain side by side, and the page reports no console
  errors.
- Browser check passed after removing runner detail panels: the dashboard no
  longer renders `Runner Status` or `Local Runner Onboarding`, still renders
  Workflow List, Connected Workflow View, Task Delivery Map, Selected Item, and
  Status Events, has no horizontal body overflow, and reports no console
  errors.
- Repository layout rename validation passed: `npm run typecheck`,
  `npm test`, and `npm --prefix apps/workflow-app run build` all passed after
  moving backend code to `backend/src` and the frontend to
  `apps/workflow-app`. Browser reload at `http://127.0.0.1:5173/ai-workflow/`
  rendered the same dashboard panels with title `workflow-app`, no horizontal
  overflow, and no console errors.
