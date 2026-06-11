# M0+ Real Skill Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-process `stubSkill` with a real `Skill` that spawns `claude -p`, returns the envelope via a workspace file, captures stdout+stderr on failure (F9), isolates+cleans a per-job workspace (F10), and propagates runner failure to task/run termination.

**Architecture:** A `makeClaudeSkill(strategy, config)` factory produces a function matching the existing `Skill` seam `(jobType, input) => Promise<Envelope>`. The runner/reactor are unchanged except for a failure-propagation refactor (`runOnce` returns a discriminated result so `drain` can terminate a task on engine failure). The only impure part — spawning `claude` — is injected as a `RunClaude` function so the engine is unit-testable without a real CLI; a gated integration test (`RUN_CLI_TESTS=1`) exercises the real spawn.

**Tech Stack:** TypeScript (ESM), vitest, Node `child_process`/`fs/promises`, existing ajv envelope validation, YAML strategy.

**Design reference:** [docs/superpowers/specs/2026-06-11-m0plus-real-skill-engine-design.md](../specs/2026-06-11-m0plus-real-skill-engine-design.md)

---

## File Structure

- **Create** `app/src/workspace.ts` — per-job isolated workspace (mkdir, sanitize, realpath path-inside guard). One responsibility: filesystem isolation.
- **Create** `app/src/cli-engine.ts` — the engine: config-from-env, wrapper-prompt builder, envelope-file reader, real `claude` spawn, and `makeClaudeSkill` factory. The impure spawn is injectable.
- **Create** `app/skills/prd-cycle/SKILL.md` — the dummy domain skill (trivial work; writes envelope file). Forward-compat; the gated test does not hard-depend on its installation.
- **Modify** `app/src/stub-skill.ts` — add `jobId` to the `Skill` input type (seam change; impls ignore it).
- **Modify** `app/src/runner.ts` — `runOnce` returns a `RunResult` discriminated union; pass `jobId` to the skill.
- **Modify** `app/src/reactor.ts` — `drain` handles the union; new `onJobFailed`; fire `job_failed` event.
- **Modify** `app/src/handler-types.ts` — add `job_failed` to the `Event` union.
- **Modify** `app/src/prd-handler.ts` — handle `job_failed` (data-driven outbound + terminate failed).
- **Modify** `app/workflows/definitions/_common.yaml` — add `outbound.job_failed` policy.
- **Modify** `app/src/app.ts` — select engine via `SKILL_ENGINE=claude|stub` (default `stub`).
- **Modify** `app/tests/runner.test.ts` — update assertions to the union return.
- **Modify** `app/tests/reactor.e2e.test.ts` — add engine-failure propagation test.
- **Modify** `.env.example`, `app/README.md` — document new env + engine.

Test files created: `app/tests/workspace.test.ts`, `app/tests/cli-engine.test.ts`.

---

## Task 1: Workspace isolation module (F10)

**Files:**
- Create: `app/src/workspace.ts`
- Test: `app/tests/workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// app/tests/workspace.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { prepareJobWorkspace } from "../src/workspace";

const base = () => mkdtempSync(join(tmpdir(), "wsbase-"));

describe("prepareJobWorkspace", () => {
  it("creates an isolated dir with an out/ subdir and returns the envelope path", async () => {
    const ws = await prepareJobWorkspace(base(), "job-123");
    const s = await stat(join(ws.dir, "out"));
    expect(s.isDirectory()).toBe(true);
    expect(ws.outFile).toBe(join(ws.dir, "out", "envelope.json"));
  });

  it("sanitizes a jobId with path separators so it cannot escape the base", async () => {
    const b = base();
    const ws = await prepareJobWorkspace(b, "../../etc/passwd");
    expect(ws.dir.startsWith(b)).toBe(true);
    expect(ws.dir).not.toContain("..");
  });

  it("gives different jobIds different directories", async () => {
    const b = base();
    const a = await prepareJobWorkspace(b, "job-a");
    const c = await prepareJobWorkspace(b, "job-c");
    expect(a.dir).not.toBe(c.dir);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/tests/workspace.test.ts`
Expected: FAIL — `Cannot find module '../src/workspace'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// app/src/workspace.ts
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface Workspace {
  /** Absolute, realpath'd isolated job directory. */
  dir: string;
  /** Absolute path the skill must write its envelope to. */
  outFile: string;
}

/** Reduce an arbitrary jobId to a safe single path segment. */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length > 0 ? safe : "job";
}

/**
 * F10: prepare a fresh, isolated workspace for one job. Creates `<base>/<safeId>/out`,
 * resolves the real path, and asserts it stays inside the base (path-traversal guard).
 */
export async function prepareJobWorkspace(base: string, jobId: string): Promise<Workspace> {
  const baseResolved = resolve(base);
  await mkdir(baseResolved, { recursive: true });
  const realBase = await realpath(baseResolved);

  const dir = join(realBase, sanitizeId(jobId));
  await mkdir(join(dir, "out"), { recursive: true });
  const real = await realpath(dir);

  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error(`workspace "${real}" escapes base "${realBase}"`);
  }
  return { dir: real, outFile: join(real, "out", "envelope.json") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/tests/workspace.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/workspace.ts app/tests/workspace.test.ts
git commit -m "feat(app): F10 per-job workspace isolation module"
```

---

## Task 2: Engine config from env

**Files:**
- Modify: `app/src/config.ts`
- Test: `app/tests/cli-engine.test.ts` (new file; first test goes here)

- [ ] **Step 1: Write the failing test**

```typescript
// app/tests/cli-engine.test.ts
import { engineConfigFromEnv } from "../src/cli-engine";

describe("engineConfigFromEnv", () => {
  it("uses defaults when env is empty", () => {
    const c = engineConfigFromEnv({});
    expect(c.cliPath).toBe("claude");
    expect(c.timeoutMs).toBe(120000);
    expect(c.workspaceBase).toBe(".workspaces");
    expect(c.model).toBeUndefined();
    expect(c.maxTurns).toBeUndefined();
  });

  it("reads overrides from env", () => {
    const c = engineConfigFromEnv({
      CLAUDE_CLI_PATH: "/usr/local/bin/claude",
      SKILL_TIMEOUT_MS: "5000",
      SKILL_MODEL: "claude-opus-4-8",
      SKILL_MAX_TURNS: "3",
      SKILL_WORKSPACE_BASE: "/tmp/ws",
    });
    expect(c).toEqual({
      cliPath: "/usr/local/bin/claude",
      timeoutMs: 5000,
      model: "claude-opus-4-8",
      maxTurns: 3,
      workspaceBase: "/tmp/ws",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/tests/cli-engine.test.ts`
Expected: FAIL — `Cannot find module '../src/cli-engine'`.

- [ ] **Step 3: Write minimal implementation**

Create `app/src/cli-engine.ts` with only the config piece for now (the rest is added in Tasks 3 & 5):

```typescript
// app/src/cli-engine.ts
export interface EngineConfig {
  cliPath: string;
  timeoutMs: number;
  model?: string;
  maxTurns?: number;
  workspaceBase: string;
}

export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    cliPath: env.CLAUDE_CLI_PATH ?? "claude",
    timeoutMs: Number(env.SKILL_TIMEOUT_MS ?? "120000"),
    model: env.SKILL_MODEL,
    maxTurns: env.SKILL_MAX_TURNS ? Number(env.SKILL_MAX_TURNS) : undefined,
    workspaceBase: env.SKILL_WORKSPACE_BASE ?? ".workspaces",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/tests/cli-engine.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/cli-engine.ts app/tests/cli-engine.test.ts
git commit -m "feat(app): engine config from env (cli path, timeout, model, workspace)"
```

---

## Task 3: Wrapper-prompt builder

**Files:**
- Modify: `app/src/cli-engine.ts`
- Test: `app/tests/cli-engine.test.ts`

The wrapper carries zero domain knowledge: it names the skill, hands over inputs, and states the envelope I/O contract + schema.

- [ ] **Step 1: Write the failing test**

Append to `app/tests/cli-engine.test.ts`:

```typescript
import { buildWrapperPrompt } from "../src/cli-engine";

describe("buildWrapperPrompt", () => {
  const schema = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
  const input = {
    jobId: "job-1",
    inlineInputs: { ticket: "PAIR-1" },
    inputRefs: [{ system: "git", key: "abc123" }],
  };

  it("names the skill and the job type", () => {
    const p = buildWrapperPrompt("prd.generate", "generate", input, schema);
    expect(p).toContain("prd.generate");
    expect(p).toContain("generate");
  });

  it("includes the inputs but NOT the internal jobId", () => {
    const p = buildWrapperPrompt("prd.generate", "generate", input, schema);
    expect(p).toContain("PAIR-1");
    expect(p).toContain("abc123");
    expect(p).not.toContain("job-1");
  });

  it("states the envelope output path and inlines the schema", () => {
    const p = buildWrapperPrompt("prd.generate", "generate", input, schema);
    expect(p).toContain("./out/envelope.json");
    expect(p).toContain("domainOutput");
    expect(p).toContain('"summary"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/tests/cli-engine.test.ts`
Expected: FAIL — `buildWrapperPrompt is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `app/src/cli-engine.ts`:

```typescript
import type { JobType } from "./domain";

export interface SkillInput {
  jobId: string;
  inlineInputs: Record<string, unknown>;
  inputRefs: { system: string; key: string; url?: string; label?: string }[];
}

export function buildWrapperPrompt(
  skill: string,
  jobType: JobType,
  input: SkillInput,
  outputSchema: Record<string, unknown>,
): string {
  const inputs = { inlineInputs: input.inlineInputs, inputRefs: input.inputRefs };
  return [
    `Use the \`${skill}\` skill to perform the "${jobType}" job.`,
    ``,
    `Job inputs (JSON):`,
    JSON.stringify(inputs, null, 2),
    ``,
    `When finished, write ONLY the result envelope as JSON to the file ./out/envelope.json`,
    `relative to your current working directory. Do not print the envelope to stdout.`,
    `The envelope MUST have exactly this shape:`,
    `{`,
    `  "domainOutput": <object matching the JSON Schema below>,`,
    `  "refs": [ { "system": string, "key": string, "url"?: string, "label"?: string } ],`,
    `  "nextTaskCandidates"?: string[]`,
    `}`,
    ``,
    `domainOutput JSON Schema:`,
    JSON.stringify(outputSchema, null, 2),
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/tests/cli-engine.test.ts`
Expected: PASS (5 tests total in file).

- [ ] **Step 5: Commit**

```bash
git add app/src/cli-engine.ts app/tests/cli-engine.test.ts
git commit -m "feat(app): wrapper-prompt builder (skill + inputs + envelope contract)"
```

---

## Task 4: Add jobId to the Skill seam

The engine needs a per-job id to isolate its workspace, but the current `Skill` input lacks one. Add it; existing implementations ignore the extra field, so all current tests stay green.

**Files:**
- Modify: `app/src/stub-skill.ts:3-6`
- Modify: `app/src/runner.ts:34-37`

- [ ] **Step 1: Update the Skill input type**

In `app/src/stub-skill.ts`, change the `Skill` type to add `jobId`:

```typescript
export type Skill = (jobType: JobType, input: {
  jobId: string;
  inlineInputs: Record<string, unknown>;
  inputRefs: { system: string; key: string; url?: string; label?: string }[];
}) => Promise<Envelope>;
```

(The `stubSkill` body below it is unchanged — it ignores `input`.)

- [ ] **Step 2: Pass jobId from the runner**

In `app/src/runner.ts`, update the skill call (currently lines 34-37):

```typescript
      envelope = await this.skill(claimed.jobType, {
        jobId: claimed.id,
        inlineInputs: claimed.inlineInputs,
        inputRefs: claimed.inputRefs,
      });
```

- [ ] **Step 3: Run the full app suite to verify nothing broke**

Run: `npm run typecheck:app && npm run test:app`
Expected: PASS — 35 pass + 2 skip (unchanged). Inline test skills with fewer params remain assignable to `Skill`.

- [ ] **Step 4: Commit**

```bash
git add app/src/stub-skill.ts app/src/runner.ts
git commit -m "feat(app): thread jobId through the Skill seam (workspace isolation hook)"
```

---

## Task 5: The claude engine (`makeClaudeSkill`)

Assemble the factory. The impure spawn is injected as `RunClaude` so success/failure paths are unit-testable with a fake; the real spawn is the default.

**Files:**
- Modify: `app/src/cli-engine.ts`
- Test: `app/tests/cli-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `app/tests/cli-engine.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeClaudeSkill } from "../src/cli-engine";
import type { RunClaude } from "../src/cli-engine";
import type { StrategyDef } from "../src/strategy";

const strategy: StrategyDef = {
  version: 1,
  type: "prd",
  meta: {},
  jobs: {
    generate: { skill: "prd.generate", outputSchema: { type: "object" } },
  },
};

const cfg = () => ({
  cliPath: "claude",
  timeoutMs: 1000,
  workspaceBase: mkdtempSync(join(tmpdir(), "engine-")),
});

const input = { jobId: "job-1", inlineInputs: {}, inputRefs: [] };

describe("makeClaudeSkill", () => {
  it("returns the envelope the skill wrote to the workspace file", async () => {
    const fakeRun: RunClaude = async (_c, cwd) => {
      writeFileSync(
        join(cwd, "out", "envelope.json"),
        JSON.stringify({ domainOutput: { summary: "ok" }, refs: [] }),
      );
      return { stdout: "done", stderr: "", code: 0 };
    };
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    const env = await skill("generate", input);
    expect(env.domainOutput.summary).toBe("ok");
  });

  it("throws with stdout+stderr when claude exits non-zero (F9)", async () => {
    const fakeRun: RunClaude = async () => ({ stdout: "OUT", stderr: "BOOM", code: 1 });
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    await expect(skill("generate", input)).rejects.toThrow(/BOOM/);
  });

  it("throws when no envelope file was written", async () => {
    const fakeRun: RunClaude = async () => ({ stdout: "", stderr: "", code: 0 });
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    await expect(skill("generate", input)).rejects.toThrow(/envelope file/);
  });

  it("throws on an unknown job type", async () => {
    const fakeRun: RunClaude = async () => ({ stdout: "", stderr: "", code: 0 });
    const skill = makeClaudeSkill(strategy, cfg(), fakeRun);
    // @ts-expect-error deliberately unknown job type
    await expect(skill("nope", input)).rejects.toThrow(/no jobDef/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/tests/cli-engine.test.ts`
Expected: FAIL — `makeClaudeSkill` / `RunClaude` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `app/src/cli-engine.ts`:

```typescript
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import type { Envelope } from "./domain";
import type { Skill } from "./stub-skill";
import type { StrategyDef } from "./strategy";
import { prepareJobWorkspace } from "./workspace";

export interface ClaudeResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type RunClaude = (
  config: EngineConfig,
  cwd: string,
  prompt: string,
) => Promise<ClaudeResult>;

/** Real spawn of `claude -p ... --output-format json`. F9: capture stdout AND stderr. */
export const runClaude: RunClaude = (config, cwd, prompt) =>
  new Promise<ClaudeResult>((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "json"];
    if (config.model) args.push("--model", config.model);
    if (config.maxTurns) args.push("--max-turns", String(config.maxTurns));

    const child = spawn(config.cliPath, args, { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude timed out after ${config.timeoutMs}ms\nstderr: ${stderr}`));
    }, config.timeoutMs);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });

async function readEnvelopeFile(path: string): Promise<Envelope> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`envelope file not found at ${path}`);
  }
  try {
    return JSON.parse(text) as Envelope;
  } catch (e) {
    throw new Error(`envelope file is not valid JSON: ${String(e)}`);
  }
}

/**
 * Build a Skill backed by the real Claude CLI. Domain work is the installed skill's;
 * this only injects the I/O contract, isolates a workspace (F10), surfaces failures (F9),
 * and reads the envelope file. Shape validation stays in the Runner (validateEnvelope).
 */
export function makeClaudeSkill(
  strategy: StrategyDef,
  config: EngineConfig,
  run: RunClaude = runClaude,
): Skill {
  return async (jobType, input) => {
    const jobDef = strategy.jobs[jobType];
    if (!jobDef) throw new Error(`no jobDef for job type "${jobType}"`);

    const ws = await prepareJobWorkspace(config.workspaceBase, input.jobId);
    try {
      const prompt = buildWrapperPrompt(jobDef.skill, jobType, input, jobDef.outputSchema);
      const { stdout, stderr, code } = await run(config, ws.dir, prompt);
      if (code !== 0) {
        throw new Error(`claude exited ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      }
      return await readEnvelopeFile(ws.outFile);
    } finally {
      await rm(ws.dir, { recursive: true, force: true });
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/tests/cli-engine.test.ts`
Expected: PASS (9 tests total in file).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:app`
Expected: clean.

```bash
git add app/src/cli-engine.ts app/tests/cli-engine.test.ts
git commit -m "feat(app): claude engine (workspace + wrapper + file return + F9 failure surface)"
```

---

## Task 6: Failure propagation (runner → task/run termination)

Make `runOnce` return a discriminated result so `drain` can tell "no work" from "job failed", and terminate the task `failed` (with a data-driven Jira comment) on engine failure — keeping F7.

**Files:**
- Modify: `app/src/runner.ts`
- Modify: `app/src/handler-types.ts:4-7`
- Modify: `app/src/reactor.ts`
- Modify: `app/src/prd-handler.ts`
- Modify: `app/workflows/definitions/_common.yaml`
- Modify: `app/tests/runner.test.ts`
- Modify: `app/tests/reactor.e2e.test.ts`

- [ ] **Step 1: Update runner.test.ts to the new union return (failing)**

Replace the three assertions in `app/tests/runner.test.ts` to expect a `RunResult`:

```typescript
  it("claims a pending job, calls the skill, validates, and stores a succeeded envelope", async () => {
    const repos = new InMemoryRepos();
    await repos.jobs.create(pendingJob("generate"));
    const runner = new Runner(repos, strategy, stubSkill, systemClock, "runner-A");

    const result = await runner.runOnce();
    expect(result.kind).toBe("finished");
    if (result.kind === "finished") expect(result.job.jobType).toBe("generate");

    const stored = await repos.jobs.get("job-generate");
    expect(stored?.status).toBe("succeeded");
    expect(stored?.envelope?.domainOutput.summary).toBeTypeOf("string");
    expect(stored?.envelope?.refs.length).toBeGreaterThan(0);
    expect(stored?.endedAt).not.toBeNull();
  });

  it("returns idle when no pending job", async () => {
    const repos = new InMemoryRepos();
    const runner = new Runner(repos, strategy, stubSkill, systemClock, "runner-A");
    expect((await runner.runOnce()).kind).toBe("idle");
  });

  it("returns failed (and marks job failed) when the envelope violates output_schema", async () => {
    const repos = new InMemoryRepos();
    await repos.jobs.create(pendingJob("quality"));
    const badSkill = async () => ({
      domainOutput: { score: 999, missing_items: [] }, // 999 > max 100
      refs: [],
    });
    const runner = new Runner(repos, strategy, badSkill, systemClock, "runner-A");
    const result = await runner.runOnce();
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toMatch(/shape invalid/);
    const stored = await repos.jobs.get("job-quality");
    expect(stored?.status).toBe("failed");
  });
```

Run: `npx vitest run app/tests/runner.test.ts`
Expected: FAIL — `runOnce` still returns `Job | null`; `.kind` is undefined.

- [ ] **Step 2: Change runOnce to return RunResult**

Replace the body of `app/src/runner.ts` (keep the imports and class shell) with:

```typescript
export type RunResult =
  | { kind: "idle" }
  | { kind: "finished"; job: Job }
  | { kind: "failed"; job: Job; reason: string };

export class Runner {
  constructor(
    private readonly repos: Repos,
    private readonly strategy: StrategyDef,
    private readonly skill: Skill,
    private readonly clock: Clock,
    private readonly runnerId: string,
  ) {}

  async runOnce(): Promise<RunResult> {
    const claimed = await this.repos.jobs.claimNextPending(this.runnerId);
    if (!claimed) return { kind: "idle" };

    const startedAt = this.clock.now();
    const jobDef = this.strategy.jobs[claimed.jobType];
    if (!jobDef) {
      return this.fail(claimed, startedAt, `no jobDef for job type "${claimed.jobType}"`);
    }

    let envelope;
    try {
      envelope = await this.skill(claimed.jobType, {
        jobId: claimed.id,
        inlineInputs: claimed.inlineInputs,
        inputRefs: claimed.inputRefs,
      });
    } catch (err) {
      return this.fail(claimed, startedAt, `skill threw: ${String(err)}`);
    }

    const result = validateEnvelope(envelope, jobDef.outputSchema);
    if (!result.ok) {
      return this.fail(claimed, startedAt, `envelope shape invalid: ${result.errors}`);
    }

    const succeeded: Job = {
      ...claimed,
      status: "succeeded",
      envelope,
      startedAt,
      endedAt: this.clock.now(),
    };
    await this.repos.jobs.update(succeeded);
    return { kind: "finished", job: succeeded };
  }

  private async fail(job: Job, startedAt: string, reason: string): Promise<RunResult> {
    // F9 lesson: never swallow the failure cause silently. M0 has no per-job error
    // column, so surface the reason to the runner log at minimum.
    console.error(`[runner] job ${job.id} (${job.jobType}) failed: ${reason}`);
    const failed: Job = {
      ...job,
      status: "failed",
      startedAt,
      endedAt: this.clock.now(),
    };
    await this.repos.jobs.update(failed);
    return { kind: "failed", job: failed, reason };
  }
}
```

(The import block at the top of the file stays as-is.)

- [ ] **Step 3: Run runner tests to verify they pass**

Run: `npx vitest run app/tests/runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Add the `job_failed` event type**

In `app/src/handler-types.ts`, extend the `Event` union:

```typescript
export type Event =
  | { kind: "task_spawned"; taskId: string }
  | { kind: "job_finished"; taskId: string; jobType: JobType; envelope: Envelope }
  | { kind: "job_failed"; taskId: string; jobType: JobType; reason: string }
  | { kind: "external_event"; taskId: string; transition: string };
```

- [ ] **Step 5: Handle `job_failed` in prdHandler**

In `app/src/prd-handler.ts`, add a case inside the `switch (event.kind)` (e.g. after `job_finished`):

```typescript
      case "job_failed":
        return [
          outboundFor("job_failed", ctx, { reason: event.reason }),
          { kind: "terminate", outcome: "failed" },
        ];
```

- [ ] **Step 6: Add drain handling + onJobFailed in the reactor**

In `app/src/reactor.ts`, replace `drain()` and add `onJobFailed()`:

```typescript
  /** Drive the single runner until no pending jobs remain, reacting to each result. */
  async drain(): Promise<void> {
    for (;;) {
      const result = await this.deps.runner.runOnce();
      if (result.kind === "idle") break;
      if (result.kind === "finished") {
        await this.onJobFinished(result.job);
      } else {
        await this.onJobFailed(result.job, result.reason);
      }
    }
  }

  /** Runner reports a failed job → terminate its task (policy via handler, F7). */
  async onJobFailed(job: Job, reason: string): Promise<void> {
    await this.applyEvent({
      kind: "job_failed",
      taskId: job.taskId,
      jobType: job.jobType,
      reason,
    });
  }
```

- [ ] **Step 7: Add the `job_failed` outbound policy (data, F7)**

In `app/workflows/definitions/_common.yaml`, add under `outbound:`:

```yaml
  job_failed:
    - { action: jira_status, status: "수정요청" }
    - { action: jira_comment, template: "작업 실패: {reason}" }
```

- [ ] **Step 8: Add the engine-failure propagation e2e test (failing first, then green)**

Append to `app/tests/reactor.e2e.test.ts` inside the `describe`:

```typescript
  it("engine failure → task failed, run failed, Jira failure comment (no orphan)", async () => {
    const { repos, out, reactor } = build();
    const boom = new Reactor({
      ...(reactor as unknown as { deps: any }).deps,
      runner: new Runner(
        repos,
        (reactor as unknown as { deps: any }).deps.strategy,
        async () => {
          throw new Error("claude exited 1");
        },
        systemClock,
        "runner-boom",
      ),
    });
    const task = await boom.startRun("PAIR-500");
    await boom.drain();

    const t = await repos.tasks.get(task.id);
    expect(t?.status).toBe("failed");
    const run = await repos.runs.get(t!.runId);
    expect(run?.status).toBe("failed");
    expect(out.applied.some((a) => a.kind === "jira_comment" && a.body.includes("작업 실패"))).toBe(true);
  });
```

- [ ] **Step 9: Run the full app suite**

Run: `npm run typecheck:app && npm run test:app`
Expected: PASS — 36 pass + 2 skip (was 35; +1 propagation test). The TypeScript `switch` over `Event` is now exhaustive with `job_failed`.

- [ ] **Step 10: Commit**

```bash
git add app/src/runner.ts app/src/handler-types.ts app/src/reactor.ts app/src/prd-handler.ts app/workflows/definitions/_common.yaml app/tests/runner.test.ts app/tests/reactor.e2e.test.ts
git commit -m "feat(app): propagate runner failure to task/run termination (review #1, F7-preserving)"
```

---

## Task 7: Wire the engine, dummy skill, gated integration test, docs

**Files:**
- Modify: `app/src/app.ts`
- Create: `app/skills/prd-cycle/SKILL.md`
- Modify: `app/tests/cli-engine.test.ts` (gated integration test)
- Modify: `.env.example`, `app/README.md`

- [ ] **Step 1: Select the engine via env in buildReactor**

In `app/src/app.ts`, add imports and choose the skill. Replace the import of `stubSkill` line and the `runner` construction:

Add near the other imports:

```typescript
import { engineConfigFromEnv, makeClaudeSkill } from "./cli-engine";
```

Replace the runner line in `buildReactor` (currently `const runner = new Runner(repos, strategy, stubSkill, systemClock, "local-runner");`):

```typescript
  const skill =
    process.env.SKILL_ENGINE === "claude"
      ? makeClaudeSkill(strategy, engineConfigFromEnv())
      : stubSkill; // default: stub (safe for tests and dry runs)
  const runner = new Runner(repos, strategy, skill, systemClock, "local-runner");
```

(Keep the existing `import { stubSkill } from "./stub-skill";`.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:app`
Expected: clean.

- [ ] **Step 3: Author the dummy skill**

Create `app/skills/prd-cycle/SKILL.md`:

```markdown
---
name: prd-cycle
description: M0+ dummy domain skill for the PRD cycle. Does trivial work and writes a minimally valid envelope to ./out/envelope.json. Replace with real domain plugins in M0++.
---

# prd-cycle (dummy)

You are invoked by the workflow engine with a job type, JSON inputs, and a domainOutput
JSON Schema. Do the minimum trivial domain work and write the envelope.

1. Read the job type and inputs from the prompt.
2. Produce a `domainOutput` object that satisfies the given schema:
   - generate → `{ "summary": "<one-line summary of the input ticket>" }`
   - quality  → `{ "score": 90, "missing_items": [] }`
   - routing  → `{ "next_task_types": ["hld"] }`
3. Write the envelope JSON to `./out/envelope.json` (relative to the working directory):
   `{ "domainOutput": <above>, "refs": [], "nextTaskCandidates"?: ["hld"] (routing only) }`
4. Do not print the envelope to stdout.
```

- [ ] **Step 4: Add the gated real-CLI integration test**

Append to `app/tests/cli-engine.test.ts`:

```typescript
import { engineConfigFromEnv as engineCfg } from "../src/cli-engine";

// Real `claude` spawn. Gated like the MySQL integration tests. The wrapper prompt fully
// specifies the task, so this exercises the engine I/O path (spawn → file → read) even if
// the prd-cycle skill is not separately installed.
const RUN_CLI = process.env.RUN_CLI_TESTS === "1";
(RUN_CLI ? describe : describe.skip)("makeClaudeSkill (real claude)", () => {
  it("round-trips an envelope file from a real claude run", async () => {
    const s: StrategyDef = {
      version: 1,
      type: "prd",
      meta: {},
      jobs: {
        generate: {
          skill: "prd-cycle",
          outputSchema: {
            type: "object",
            required: ["summary"],
            properties: { summary: { type: "string" } },
          },
        },
      },
    };
    const skill = makeClaudeSkill(s, engineCfg());
    const env = await skill("generate", {
      jobId: "it-1",
      inlineInputs: { ticket: "PAIR-1: build login" },
      inputRefs: [],
    });
    expect(typeof env.domainOutput.summary).toBe("string");
  }, 120000);
});
```

- [ ] **Step 5: Run the default suite (gated test skipped)**

Run: `npm run test:app`
Expected: PASS — 36 pass + 3 skip (MySQL ×2 + CLI ×1).

- [ ] **Step 6: Document env + engine**

Add to `.env.example` (under an "M0+ skill engine" heading):

```bash
# M0+ real skill engine — set SKILL_ENGINE=claude to use the real Claude CLI (default: stub)
SKILL_ENGINE=stub
CLAUDE_CLI_PATH=claude
SKILL_TIMEOUT_MS=120000
# SKILL_MODEL=claude-opus-4-8
# SKILL_MAX_TURNS=6
SKILL_WORKSPACE_BASE=.workspaces
```

In `app/README.md`, under "## Run", add a note after the start command:

```markdown
By default the app uses the **stub skill**. To drive jobs with the real Claude CLI:

    SKILL_ENGINE=claude npm run start:app

The engine isolates each job in a workspace under `SKILL_WORKSPACE_BASE`, injects the
envelope I/O contract as a wrapper prompt, and reads the result from `./out/envelope.json`
(F9: stdout+stderr are surfaced on failure; F10: the workspace is cleaned up).
Run the gated real-CLI integration test with `RUN_CLI_TESTS=1 npm run test:app`.
```

Also add `.workspaces/` to `.gitignore`.

- [ ] **Step 7: Final verification**

Run: `npm run typecheck:app && npm run test:app`
Expected: clean typecheck; 36 pass + 3 skip.

- [ ] **Step 8: Commit**

```bash
git add app/src/app.ts app/skills/prd-cycle/SKILL.md app/tests/cli-engine.test.ts .env.example app/README.md .gitignore
git commit -m "feat(app): wire claude engine via SKILL_ENGINE + dummy skill + gated CLI test + docs"
```

---

## Self-Review Notes

- **Spec coverage:** §2 engine → Tasks 1,3,5; §3 workspace/config → Tasks 1,2; §3 file return → Task 5; §4 failure propagation → Task 6; §5 testing/wiring/dummy skill → Tasks 5,6,7; §6 acceptance 1–6 → covered across Tasks 5–7 (acceptance 1/2 gated test + unit, 3 F9 Task 5, 4 F10 Task 1+5, 5 propagation Task 6, 6 F7 Task 6). Q2 mapping field already exists in `prd.yaml`/`JobDef` — no new YAML field needed (noted in plan header).
- **Type consistency:** `RunResult` (Task 6) consumed by `drain` (Task 6); `Skill` input gains `jobId` (Task 4) consumed by `makeClaudeSkill` (Task 5) and `runOnce` (Task 6); `RunClaude`/`EngineConfig`/`SkillInput`/`buildWrapperPrompt`/`makeClaudeSkill` all defined in `cli-engine.ts` and used consistently; `Event.job_failed` (Task 6) handled in `prdHandler` and produced by `onJobFailed`.
- **No placeholders:** every code step shows complete code; commands have expected output.
