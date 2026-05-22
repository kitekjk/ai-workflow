# Runner CLI Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stub PRD generation and quality evaluation logic with runner skills that execute Claude CLI or Codex CLI and return standardized PRD artifacts and gate results.

**Architecture:** Keep the existing Workflow API, Engine, Scheduler, and Runner Worker unchanged. Add engine adapters under `backend/src/runner-engines`, job adapters under `backend/src/prd-confirmation`, and tests that execute deterministic fake CLI binaries before wiring real `claude` or `codex` commands through environment configuration.

**Tech Stack:** TypeScript, Node.js child_process, Vitest, existing in-memory workflow slice, existing Jira/Git/Confluence adapters.

---

## File Structure

- Create `backend/src/runner-engines/cli-engine.ts`: generic process runner for CLI
  engines with timeout, stdout/stderr capture, JSON result parsing, and clear
  errors.
- Create `backend/src/runner-engines/engine-config.ts`: reads `RUNNER_ENGINE`,
  `CLAUDE_CLI_PATH`, `CODEX_CLI_PATH`, timeout, and model/prompt settings.
- Create `backend/src/prd-confirmation/cli-prd-skills.ts`: PRD skill executor that uses
  the CLI engine for `prd.generate_draft`, `prd.evaluate_quality`, and
  `prd.apply_feedback_revision`.
- Modify `backend/src/runtime/create-runtime.ts`: choose stub, adapter-backed, or CLI
  PRD skill based on environment.
- Modify `.env.example`: document CLI runner configuration.
- Add `tests/runner-engines/cli-engine.test.ts`: verifies process execution,
  JSON parsing, stderr handling, non-zero exit handling, and timeout handling.
- Add `tests/prd-confirmation-cli-skills.test.ts`: verifies the CLI PRD skill
  writes PRD markdown to repo/wiki and converts quality JSON to standard
  results.

## Task 1: CLI Engine

**Files:**
- Create: `backend/src/runner-engines/cli-engine.ts`
- Test: `tests/runner-engines/cli-engine.test.ts`

- [ ] **Step 1: Write the failing process success test**

```ts
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliEngine } from "../../backend/src/runner-engines/cli-engine";

it("runs a CLI command and parses JSON stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-engine-"));
  const bin = join(dir, "fake-cli");
  writeFileSync(bin, "#!/usr/bin/env node\nconsole.log(JSON.stringify({status:'ok', text:'hello'}));\n");
  chmodSync(bin, 0o755);

  const engine = new CliEngine({ command: bin, timeoutMs: 5000 });
  const result = await engine.runJson({ prompt: "generate PRD" });

  expect(result).toEqual({ status: "ok", text: "hello" });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- tests/runner-engines/cli-engine.test.ts
```

Expected: fail because `backend/src/runner-engines/cli-engine.ts` does not exist.

- [ ] **Step 3: Implement minimal `CliEngine`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CliEngine {
  constructor(private readonly options: { command: string; timeoutMs: number }) {}

  async runJson(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { stdout } = await execFileAsync(this.options.command, [], {
      timeout: this.options.timeoutMs,
      input: JSON.stringify(input)
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
npm test -- tests/runner-engines/cli-engine.test.ts
```

Expected: pass.

- [ ] **Step 5: Add failure behavior tests**

Add tests for:

```ts
it("includes stderr when the CLI exits non-zero", async () => {});
it("throws a clear error when stdout is not valid JSON", async () => {});
it("times out a long-running CLI process", async () => {});
```

Expected errors must contain the command name and useful stderr/stdout context.

- [ ] **Step 6: Implement failure behavior**

Update `CliEngine.runJson()` to catch process errors, preserve stderr/stdout,
and throw clear `CliEngineError` messages.

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/runner-engines/cli-engine.test.ts
```

Expected: all CLI engine tests pass.

## Task 2: CLI PRD Skill Executor

**Files:**
- Create: `backend/src/prd-confirmation/cli-prd-skills.ts`
- Test: `tests/prd-confirmation-cli-skills.test.ts`

- [ ] **Step 1: Write the failing PRD draft test**

Create a fake CLI that returns:

```json
{
  "status": "succeeded",
  "markdown": "# PAIR-2 Generated PRD\n\n...",
  "summary": "Generated PRD draft"
}
```

Test that `CliPrdSkills`:

- calls the CLI for `prd.generate_draft`
- commits markdown through `LocalGitPrdRepository`
- publishes markdown through `WikiPublisher`
- returns `prd_markdown` and `prd_wiki_page` artifacts

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm test -- tests/prd-confirmation-cli-skills.test.ts
```

Expected: fail because `CliPrdSkills` does not exist.

- [ ] **Step 3: Implement draft generation**

Implement `CliPrdSkills.execute()` for `prd.generate_draft`:

```ts
const output = await engine.runJson({
  jobType: job.jobType,
  primaryJiraKey: job.primaryJiraKey,
  sourceRequests: ...
});
```

Then commit `output.markdown`, publish wiki, and return normalized artifacts.

- [ ] **Step 4: Add quality gate test**

Fake CLI returns:

```json
{
  "status": "needs_revision",
  "score": 72,
  "missingInformation": ["Success metric is missing"],
  "clarificationQuestions": ["What measurable outcome should this target?"],
  "riskItems": ["Scope may be unclear"]
}
```

Assert the standard result has the same fields and creates no artifacts.

- [ ] **Step 5: Implement quality gate execution**

Implement `prd.evaluate_quality` by calling the CLI and returning normalized
quality result data.

- [ ] **Step 6: Add feedback revision test**

Fake CLI returns revised markdown. Assert one combined
`prd.apply_feedback_revision` job reads feedback, writes a new Git commit,
updates wiki, and returns a revision summary.

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/prd-confirmation-cli-skills.test.ts
```

Expected: all CLI PRD skill tests pass.

## Task 3: Runtime Configuration

**Files:**
- Create: `backend/src/runner-engines/engine-config.ts`
- Modify: `backend/src/runtime/create-runtime.ts`
- Modify: `.env.example`
- Test: `tests/runtime/create-runtime.test.ts`

- [ ] **Step 1: Write runtime selection tests**

Test these modes:

```text
RUNNER_SKILL_MODE=stub
RUNNER_SKILL_MODE=adapter
RUNNER_SKILL_MODE=cli
RUNNER_ENGINE=claude
RUNNER_ENGINE=codex
```

Expected: missing CLI path in `cli` mode throws a clear env error.

- [ ] **Step 2: Implement config parser**

Add:

```env
RUNNER_SKILL_MODE=adapter
RUNNER_ENGINE=claude
CLAUDE_CLI_PATH=claude
CODEX_CLI_PATH=codex
RUNNER_CLI_TIMEOUT_MS=120000
```

- [ ] **Step 3: Wire runtime selection**

Update `createRuntimeFromEnv()`:

- stub mode keeps `StubPrdSkills`
- adapter mode keeps current `AdapterBackedPrdSkills`
- cli mode creates `CliPrdSkills`

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/runtime/create-runtime.test.ts
npm test
```

Expected: all tests pass.

## Task 4: Manual Real CLI Smoke

**Files:**
- Modify: `README.md`
- No automated test required beyond existing tests.

- [ ] **Step 1: Configure `.env`**

Use:

```env
INTEGRATION_MODE=real
RUNNER_SKILL_MODE=cli
RUNNER_ENGINE=claude
CLAUDE_CLI_PATH=claude
RUNNER_CLI_TIMEOUT_MS=120000
```

- [ ] **Step 2: Verify CLI auth outside the app**

Run:

```bash
claude --version
codex --version
```

Expected: the selected CLI is installed and authenticated.

- [ ] **Step 3: Run the workflow**

Run:

```bash
npm run start:api
curl -X POST http://127.0.0.1:3000/prd/intake \
  -H 'content-type: application/json' \
  -d '{"prdJiraKey":"PAIR-2"}'
curl -X POST http://127.0.0.1:3000/tick
curl -X POST http://127.0.0.1:3000/tick
curl http://127.0.0.1:3000/state/PAIR-2
```

Expected:

- `prd.generate_draft` succeeds through CLI output.
- PRD repo receives a commit.
- Confluence page is created or updated.
- `prd.evaluate_quality` returns structured quality data.

## Self-Review

- Spec coverage: covers replacing stub PRD generation/evaluation with
  CLI-backed runner skills while preserving existing workflow boundaries.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: uses existing `PrdSkillExecutor`, `PrdRepository`,
  `WikiPublisher`, `AgentJob`, and `PrdConfirmationStore` concepts.
