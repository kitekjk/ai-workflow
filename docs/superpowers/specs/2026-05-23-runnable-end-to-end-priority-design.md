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
them, stream or persist logs, report heartbeats, and return normalized results.

### P0 Skill And Plugin Resolution

Runner jobs must be able to declare required AI skills or plugins. The runner
should check what is already installed, resolve missing requirements through
the configured local plugin/skill registry, install or prepare them where
allowed, and fail with an actionable error when a requirement cannot be
satisfied.

### P1 Runnable Workflow Path

The product workflow path should run through the core stages with the real
workflow/task/job model: PRD, HLD, LLD, Spec, Code, and pull request status.
Tasks represent visible workflow stages. Jobs represent concrete attempts such
as generate, evaluate, revise, implement, review, or collect status. Repeated
evaluation and revision should create more jobs under the same task rather
than cluttering the workflow view with duplicate stage nodes.

### P2 Minimal Control UI

The UI only needs enough surface to operate the real flow: create or select a
workflow, inspect tasks and their job attempts, start or resume work, see
runner/job status, and open generated artifacts. Runner management and broad
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

## Error Handling

The next phase should normalize runner and dependency failures into product
events:

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
