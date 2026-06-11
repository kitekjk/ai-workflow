# M0+ Real Skill Engine — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming complete, ready for plan)
**Predecessor:** M0 (stub-based PRD reactor, merged PR #3). See [M0 spec](2026-06-02-workflow-app-m0-minimal-spec.md).

## 1. Goal & Scope

Replace the in-process `stubSkill` ([app/src/stub-skill.ts](../../../app/src/stub-skill.ts)) with a
real `Skill` implementation that spawns `claude -p`. **What M0+ validates is the engine wiring —
not domain quality:** process spawn, F9 logging (capture stdout+stderr, surface failure), F10
workspace isolation + cleanup, file-based envelope return, and wrapper-prompt injection.

The replacement point is already isolated: the `Skill` type `(jobType, input) => Promise<Envelope>`.
The runner and reactor do not change shape (except the failure-propagation work in §4, which is an
independent review finding folded into this milestone because the real engine can now fail).

**In scope:** generate / quality / routing all flow through real `claude -p`. Domain logic behind it
is a trivial dummy skill. Runner failure propagates to task termination.

**Out of scope (M0++):** real domain plugins, revise loop, fan-out, multi-runner atomic claim, real
git/wiki writes (bare ref preserved — D4).

## 2. Key Decisions (from brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Cycle scope | Full generate/quality/routing through real CLI; Jira stays `RecordingOutbound`; git/wiki deferred (bare ref). |
| Q2 | Prompt source | Domain capability = installed plugin/skill (not in app repo). App owns only the **I/O envelope contract**, injected by an engine-built **wrapper prompt**. jobType→skill mapping + schema live in app data (YAML). |
| Q3 | Invocation | `claude -p` spawned directly via `child_process` (thin, no bridge). codex deferred to the same `Skill` seam. |
| Q4 | Envelope return | Skill writes envelope to a **workspace file** (`./out/envelope.json`); engine reads it. Fully separated from chatty stdout. |
| Q5 | Engine abstraction | `Skill` seam only — one `claude` implementation. No premature adapter layer. |
| Mapping | Plugin reality | YAML maps `jobType → skill name`; **real domain plugins do not exist yet** → a minimal **dummy skill** proves the engine end-to-end. Domain quality comes later. |
| M0+ scope | Dummy behavior | Dummy skill is a **real installed Claude skill** invoked via `claude -p` (trivial domain, e.g. one-line summary) — so M0+ exercises the whole engine path. Not a canned no-op. |
| Review #1 | Failure propagation | **Included.** Runner failure → task `failed` + run `failed` + Jira outbound, keeping F7 (policy stays data-driven). |

## 3. Engine (`app/src/cli-engine.ts`, new)

`makeClaudeSkill(config): Skill` — a factory returning a function matching the existing `Skill` type
`(jobType, input) => Promise<Envelope>`. The runner/reactor call it identically to `stubSkill`.

Internal flow per invocation:

1. **Resolve skill name** — `strategy.jobs[jobType].skill` (new YAML field, e.g. `skill: prd-cycle`).
2. **Prepare workspace (F10)** — `prepareJobWorkspace(jobId)` → isolated directory.
3. **Build wrapper prompt** — zero domain knowledge. Content:
   *"Use the `<skill>` skill to handle this job. Inputs: `<inlineInputs + inputRefs as JSON>`.
   Write the resulting envelope JSON, conforming to the schema below, to `./out/envelope.json`."*
   plus the job's `outputSchema` inlined.
4. **Spawn** — `claude -p <wrapper> --output-format json`, `cwd = workspace`, with timeout/abort and
   **both stdout and stderr captured (F9)**. Follow the legacy
   [cli-engine.ts](../../../backend/src/runner-engines/cli-engine.ts) pattern (incl. Windows shebang
   workaround) but keep it thin — do **not** copy `runnerJobTemplate` / capability matching.
5. **Return** — on success, read & parse `./out/envelope.json` → return `Envelope`. **Shape validation
   stays in the runner** via the existing `validateEnvelope` (seam preserved).
6. **Throw on failure** — non-zero exit / timeout / missing or invalid envelope file → throw with a
   diagnostic message that **includes the captured stdout+stderr**. The runner's `fail()` catches it.

### Workspace module (`app/src/workspace.ts`, new)

`prepareJobWorkspace(jobId)` — sanitize jobId, create an isolated dir under a configured base,
`realpath`, assert the resolved path is inside the base (path-traversal guard), return
`{ dir, outFile }`. Cleanup after the engine reads the envelope. A thin version of legacy
[workspace.ts](../../../backend/src/local-runner/workspace.ts).

### Config extension (`app/src/config.ts`)

Add engine config: `CLAUDE_CLI_PATH` (default `claude`), `timeoutMs`, `model`, `maxTurns`,
`workspaceBase`. Read from env, consistent with existing config style.

## 4. Failure Propagation (review finding #1)

Today `runOnce(): Job | null`, where `null` conflates "no pending job" with "job failed", so
[`drain()`](../../../app/src/reactor.ts) cannot tell them apart — a failed job leaves its task
`in_progress` forever. With a real `claude` process (which can time out / exit non-zero / produce no
envelope), this orphan-on-failure becomes a live defect. Fix:

- Change `runOnce()` to return a **discriminated union**:
  `{ kind: "idle" }` / `{ kind: "finished", job }` / `{ kind: "failed", job, reason }`.
- `drain()`: `finished` → existing `onJobFinished`; `failed` → new `onJobFailed(job, reason)`;
  `idle` → break.
- **F7 preserved** — `onJobFailed` does *not* terminate the task directly. It fires a `job_failed`
  event to the handler; `prdHandler` returns
  `[outboundFor("job_failed", ctx, { reason }), { kind: "terminate", outcome: "failed" }]`.
  The failure-comment policy lives as data in `_common.yaml` under `outbound.job_failed`.

## 5. Testing, Wiring, Dummy Skill

**Testing:**
- **Existing reactor/runner tests** keep using in-process `stubSkill` (fast, deterministic). Unchanged.
- **New unit tests (no claude spawn):** workspace path-inside safety; wrapper-prompt assembly;
  envelope file parse / missing-file error; **failure propagation** (a `Skill` that throws → assert
  `drain` terminates task `failed` + run `failed` + outbound called).
- **New engine integration test, gated** like MySQL (`RUN_CLI_TESTS=1`): spawn real `claude` with the
  dummy skill, assert envelope file round-trip + F9 capture + F10 cleanup. Skipped in CI by default.

**Wiring:** `app.ts` composition selects the engine via env flag `SKILL_ENGINE=claude|stub`
(default `stub`, so tests and accidental runs stay safe). `stubSkill` is preserved.

**Dummy skill (one, generic):** authored in this repo (e.g. `app/skills/prd-cycle/`); all of
generate/quality/routing map to it. Because the wrapper injects the jobType and the output schema, a
single generic skill can emit the correct envelope shape per job (generate: `summary` + refs;
quality: `score`; routing: `next_task_types` + `nextTaskCandidates`). It does trivial real work and
writes `./out/envelope.json`.

## 6. Acceptance (M0+)

1. A PRD run drives generate → quality → 승인대기 → routing → completed with **every job executed by a
   real `claude -p` process** (gated integration test).
2. Each job's envelope is returned via the **workspace file**, not stdout; shape-validated by the
   runner; refs accumulate onto the task as in M0.
3. **F9:** an engine failure (timeout / non-zero exit / missing envelope) surfaces stdout+stderr in
   the runner log and does not silently swallow the cause.
4. **F10:** each job runs in an isolated workspace directory that is cleaned up; path-traversal guarded.
5. **Failure propagation:** an engine failure terminates the task `failed` + run `failed` and emits a
   Jira failure comment via data-driven outbound (no orphaned `in_progress` task).
6. F7 still holds: no `jobType`/engine `type` branching in dispatch; skill mapping + failure policy
   are YAML data. The only domain logic remains in `prd-handler.ts`.

## 7. References (legacy `backend/src` — F9/F10 already learned)

- [runner-engines/cli-engine.ts](../../../backend/src/runner-engines/cli-engine.ts) — spawn + stdout/stderr
  capture, timeout/abort, shebang workaround. **Base pattern for the new engine.**
- [local-runner/workspace.ts](../../../backend/src/local-runner/workspace.ts) — `prepareJobWorkspace`
  isolation + path-inside check. **F10 reference.**
- [runner-engines/engine-config.ts](../../../backend/src/runner-engines/engine-config.ts) — env-based
  invocation args. Keep the *idea* (env-driven config), drop the bridge complexity.

Keep the new code **thin** — do not copy legacy complexity (runnerJobTemplate, capability matching).
