# Runnable End-to-End Priority Design

Date: 2026-05-23

## Decision

Development should prioritize making the real product workflow runnable end to
end. The target is not a separate presentation-only path. The same workflow
path should later be used for hands-on evaluation, operator validation, and
production hardening.

UI work should stay minimal until the runnable path is stable. The immediate
goal is to start a workflow, run assigned work on a local runner, install or
resolve AI skills/plugins needed by that work, observe task/job state, and see
the workflow reach a terminal state with artifacts and pull request status.

## Priority Model

### P0 Runner Runtime

The local runner is the highest priority because it is the execution boundary.
It must be able to register with the scheduler, advertise owner email, project
scope, supported engines, and capabilities, claim only matching jobs, execute
them, stream or persist logs, renew leases while long-running work is active,
report heartbeats, and return normalized results. A running job must not become
eligible for another runner while its original runner is still alive and
actively extending the claim.

### P0 Skill And Plugin Resolution

Runner jobs must be able to declare required AI skills or plugins. The runner
should check what is already installed, resolve missing requirements through
the configured local plugin/skill registry, install or prepare them where
allowed, and fail with an actionable error when a requirement cannot be
satisfied. Capability strings are not enough for this phase; jobs need
explicit dependency metadata such as skill/plugin id and version.

### P1 Runnable Workflow Path

The product workflow path should run through the core stages with the real
workflow/task/job model: PRD, HLD, LLD, Spec, Code, and pull request status.
Tasks represent visible workflow stages. Jobs represent concrete attempts such
as generate, evaluate, revise, implement, review, or collect status. Repeated
evaluation and revision should create more jobs under the same task rather
than cluttering the workflow view with duplicate stage nodes.

### P2 Minimal Control UI

The UI only needs enough surface to operate the real flow: create or select a
workflow, inspect tasks and their job attempts, start or resume real
runner-backed work, see runner/job status, and open generated artifacts.
Canned runner output should be isolated as a development harness so it does
not look like the actual local runner path. Runner management and broad
settings can move to separate pages later.

### P3 Recovery And Feedback Loops

After the happy path works, add recovery behavior: retry failed jobs, cancel or
release claims, send a task back to an earlier stage, route code feedback back
to LLD or Spec when needed, and collect pull request or CI status into the
workflow.

### P4 Product Cleanup

Legacy compatibility removal, advanced runner admin screens, advanced
authorization, a richer workflow editor, and dashboard polish should follow the
runnable path. These are valuable, but they should not block the first real
end-to-end execution.

## Architecture Implications

- Scheduler remains central and owns job assignment.
- Local runners are distributed workers and only claim jobs matching owner
  email, project scope, engine, and declared capability requirements.
- Workflow state is modeled as workflow -> task -> job.
- The visible workflow graph should show tasks as stable stage nodes.
- Job attempts are task details and should drive task status transitions.
- Skills/plugins are runner execution dependencies, not dashboard-only
  metadata.
- Pull request message generation belongs in the execution workflow as an AI
  job, while the PR creation step is performed by the runner or backend adapter
  according to configured credentials.

## Current Implementation Notes

- Runner lease renewal is implemented across scheduler, repository, API,
  runner client, and local runner loop. `LOCAL_RUNNER_JOB_LEASE_RENEWAL_MS`
  controls the local renewal interval.
- Runner cancellation is implemented as cooperative local execution signaling:
  the runner polls for `cancel_requested`, aborts the active engine through
  `AbortSignal`, and the CLI engine terminates the child process.
- Runner failures are categorized through `workflow_job_result.error_category`
  and scheduler event metadata. The local runner currently maps missing
  packages, workspace/artifact path issues, invalid result contracts, GitHub/PR
  failures, cancellations, and generic engine failures into stable categories.
- Runner skill/plugin dependency resolution is implemented as a local
  pre-execution check plus local registry prepare flow. Job input can declare
  explicit skill/plugin package ids and versions, missing requirements fail
  with `runner_package_missing` before the AI engine runs, and
  `LOCAL_RUNNER_PACKAGE_AUTO_INSTALL=true` can copy matching packages from
  configured registry roots into local install roots. Package-specific
  `source` / `installSource` values can also install from local paths,
  `file://` URLs, git URLs, or GitHub repo shorthand before resolution.
- MySQL no-fixture smoke can keep deterministic implementation jobs while
  routing document jobs through the real Claude/Codex CLI runner with
  `SMOKE_DOCUMENT_MODE=cli`; that mode validates the selected runner engine and
  CLI command before migrations/API startup.
- The next gap is hardening package source trust/checksums and then driving
  the full PRD -> HLD -> LLD -> Spec -> Code runnable path through the real
  runner.

## Error Handling

The next phase should keep expanding normalized runner and dependency failures
into actionable product events:

- missing skill or plugin
- unsupported engine
- claim scope mismatch
- execution timeout
- invalid AI result contract
- artifact write failure
- pull request creation or status collection failure

Each failure should be visible on the job, update the parent task correctly,
and leave enough context for retry or operator action.

## Testing And Readiness

The first readiness gate is a single real workflow run completing through the
core path with a local runner. Automated tests should focus on scheduler claim
rules, runner dependency resolution, task/job state transitions, and artifact
or pull request status persistence. UI checks should stay smoke-level until the
execution model is stable.

## Explicit Non-Goals For The Next Phase

- no separate presentation-only workflow path
- no broad UI redesign before the runnable path is stable
- no advanced authorization before email-first runner scope is proven
- no full legacy compatibility removal while product execution still depends
  on compatibility references
