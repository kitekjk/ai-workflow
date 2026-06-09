# Workflow App M0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M0 reactor app that drives one PRD cycle (`intake → generate → quality → 사람 승인 → routing → completed`) end-to-end against MySQL, with a **stub skill** standing in for the real Claude CLI.

**Architecture:** A thin **Jira-reactor**: inbound webhook → state machine + `prd` EventHandler (code) reading Strategy data (YAML) → spawns Jobs → a single Runner calls a **stub skill** and returns an `envelope` → app validates envelope *shape* (not ref truth — bare claim, D4) → Outbound Dispatcher mirrors to Jira. All external writes (git/wiki/PR) are owned by the skill; the app stores only **opaque refs**. Persistence goes through a **single Db boundary** (NFR-4) to structurally block F5 (datetime) / F6 (LIMIT). Core logic is tested against in-memory repos for speed; one gated integration test proves the MySQL boundary.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), `tsx` runner, `vitest`, `mysql2/promise`, `yaml`, `ajv` (JSON Schema validation). Node ≥ 20 (`crypto.randomUUID`).

**Source docs:** [m0-minimal-spec.md](../specs/2026-06-02-workflow-app-m0-minimal-spec.md) (build baseline), [boundary-design.md](../specs/2026-06-02-skill-owned-writes-boundary-design.md) (why the app holds only refs), [architecture.md §2/§3/§4](../specs/2026-05-27-workflow-architecture.md) (entity/component detail), [rebuild-ideas.md](../specs/2026-05-25-ai-workflow-rebuild-ideas.md) (F5–F11 lessons).

**Scope decisions locked in (2026-06-09):**
- New directory `app/` on branch `worktree-rebuild-prd`. Legacy `backend/src` untouched (avoid legacy gravity).
- MySQL (matches `docker-compose` `workflow-mysql`, NFR-6). Single persistence boundary blocks F5/F6.
- Stub skill first — Runner returns fixed envelopes. Real Claude CLI is **out of this plan** (M0+ follow-on).

**Out of scope (M0+):** HLD/LLD/Spec/Code/QA task types, revise loop, fan-out, real Claude CLI engine (F9/F10 surface), dashboard/UI, RBAC, ref reachability verification.

---

## File Structure

All paths relative to the worktree root (`.claude/worktrees/rebuild-prd/`).

| File | Responsibility |
| --- | --- |
| `app/tsconfig.json` | TS config for the app (extends root). |
| `app/src/domain.ts` | Entity types + enums (`WorkflowRun`/`Task`/`Job`/`Envelope`/`Ref`) + `newId()`. No logic. |
| `app/src/clock.ts` | `Clock` type + `systemClock` (injectable `now(): string` ISO). |
| `app/src/strategy.ts` | Strategy types + YAML loader + validation (`_common.yaml` + `prd.yaml`). |
| `app/src/envelope.ts` | ajv-based envelope validator (domainOutput vs `output_schema` + refs shape). |
| `app/src/handler-types.ts` | `Event` / `Action` / `ExternalAction` / `TaskContext` / `EventHandler` + `fillTemplate`. |
| `app/src/prd-handler.ts` | `prd` EventHandler — the only task-type logic in M0. |
| `app/src/registry.ts` | `HandlerRegistry` (type → handler). |
| `app/src/repos.ts` | Repo **ports** (interfaces) + `InMemoryRepos` (tests + M0 default runtime). |
| `app/src/db.ts` | MySQL boundary: pool + datetime conversions (F5) + safe LIMIT (F6). |
| `app/src/mysql-repos.ts` | MySQL repo implementations over `Db`. |
| `app/src/stub-skill.ts` | Fixed envelopes per `job_type` (stands in for real skill). |
| `app/src/runner.ts` | Claim pending Job → call skill → validate envelope → store result. |
| `app/src/reactor.ts` | Wires handler+state-machine+orchestrator: `startRun` / `onJobFinished` / `onExternalEvent` / `drain`. |
| `app/src/jira.ts` | Inbound normalize+route + Outbound port (`RecordingOutbound` for tests). |
| `app/src/config.ts` | Env config (MySQL creds, trigger). |
| `app/src/migrate.ts` | Apply `001_init.sql`. |
| `app/migrations/001_init.sql` | `workflow_run` / `task` / `job` tables. |
| `app/workflows/definitions/_common.yaml` | Document-common trigger/outbound/inbound. |
| `app/workflows/definitions/prd.yaml` | PRD meta + jobs (L4). |
| `app/tests/*.test.ts` | TDD tests per module + one e2e + one gated DB integration test. |

---

## Task 0: Environment setup

**Files:**
- Create: `app/tsconfig.json`
- Modify: `package.json` (scripts + `ajv` dep)

- [ ] **Step 1: Install deps in the worktree (node_modules is absent in a fresh worktree)**

Run:
```bash
cd .claude/worktrees/rebuild-prd
npm install
npm install ajv@^8.17.1
```
Expected: `ajv` added to `dependencies`, `node_modules/` populated.

- [ ] **Step 2: Create `app/tsconfig.json`**

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Add scripts to `package.json`**

Add these entries to the `"scripts"` object:
```json
    "typecheck:app": "tsc --noEmit -p app/tsconfig.json",
    "test:app": "vitest run app/tests",
    "db:migrate:app": "tsx app/src/migrate.ts"
```

- [ ] **Step 4: Verify typecheck runs (no files yet → no errors)**

Run: `npm run typecheck:app`
Expected: exits 0 (empty project compiles).

- [ ] **Step 5: Commit**

```bash
git add app/tsconfig.json package.json package-lock.json
git commit -m "chore(app): scaffold M0 app dir, add ajv + scripts"
```

---

## Task 1: Domain types + id + clock

**Files:**
- Create: `app/src/domain.ts`
- Create: `app/src/clock.ts`
- Test: `app/tests/domain.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/domain.test.ts`:
```ts
import { newId } from "../src/domain";
import { systemClock } from "../src/clock";

describe("domain primitives", () => {
  it("newId returns a unique uuid each call", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("systemClock.now returns an ISO 8601 string", () => {
    const t = systemClock.now();
    expect(new Date(t).toISOString()).toBe(t);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- domain`
Expected: FAIL — cannot find module `../src/domain`.

- [ ] **Step 3: Write `app/src/domain.ts`**

```ts
import { randomUUID } from "node:crypto";

export type RunStatus = "running" | "completed" | "canceled" | "failed";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "awaiting_human"
  | "succeeded"
  | "failed"
  | "canceled";
export type JobStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "canceled";
export type JobType = "generate" | "quality" | "routing";

/** Opaque external reference. App stores + renders; never reads/verifies (D4 bare claim). */
export interface Ref {
  system: string; // "git" | "wiki" | ...
  key: string;
  url?: string;
  label?: string;
}

/** Skill result (skill → app). domainOutput shape is validated; refs are opaque. */
export interface Envelope {
  domainOutput: Record<string, unknown>;
  refs: Ref[];
  nextTaskCandidates?: string[];
}

export interface WorkflowRun {
  id: string;
  definitionVersion: string;
  sourceRequestRef: string; // Jira issue key of the operating request
  status: RunStatus;
  createdAt: string; // ISO
  completedAt: string | null;
}

export interface Task {
  id: string;
  runId: string;
  parentTaskId: string | null;
  type: string; // "prd"
  jiraKey: string;
  assigneeEmail: string | null;
  status: TaskStatus;
  refs: Ref[]; // accumulated from envelopes; opaque metadata
  createdAt: string;
  terminatedAt: string | null;
}

export interface Job {
  id: string;
  taskId: string;
  jobType: JobType;
  inlineInputs: Record<string, unknown>;
  inputRefs: Ref[];
  status: JobStatus;
  envelope: Envelope | null;
  runnerId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export function newId(): string {
  return randomUUID();
}
```

- [ ] **Step 4: Write `app/src/clock.ts`**

```ts
export interface Clock {
  now(): string; // ISO 8601
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:app -- domain`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/domain.ts app/src/clock.ts app/tests/domain.test.ts
git commit -m "feat(app): domain types, id and clock primitives"
```

---

## Task 2: Strategy data files + loader

**Files:**
- Create: `app/workflows/definitions/_common.yaml`
- Create: `app/workflows/definitions/prd.yaml`
- Create: `app/src/strategy.ts`
- Test: `app/tests/strategy.test.ts`

- [ ] **Step 1: Create `app/workflows/definitions/_common.yaml`**

```yaml
# Document-common trigger/outbound/inbound. base handler reads this (M0: prd only).
# status/transition/trigger strings are environment-dependent Jira config values (F7: data, not code).
trigger:
  new_run_status: "PRD 요청"
outbound:
  quality_passed:
    - { action: jira_status, status: "승인대기" }
    - { action: jira_comment, template: "품질 {score}점 — 승인 대기. {summary}" }
  quality_failed:
    - { action: jira_status, status: "수정요청" }
    - { action: jira_comment, template: "품질 {score}점(기준 {threshold}). 보완: {missing_items}" }
inbound:
  "승인": approved
```

- [ ] **Step 2: Create `app/workflows/definitions/prd.yaml`**

```yaml
version: 1
type: prd
meta:
  approver_role: planner
jobs:
  generate:
    skill: prd.generate
    output_schema:
      type: object
      required: [summary]
      properties:
        summary: { type: string }
  quality:
    skill: prd.quality
    threshold: 85
    output_schema:
      type: object
      required: [score, missing_items]
      properties:
        score: { type: integer, minimum: 0, maximum: 100 }
        missing_items: { type: array, items: { type: string } }
  routing:
    skill: prd.routing
    output_schema:
      type: object
      required: [next_task_types]
      properties:
        next_task_types: { type: array, items: { enum: [hld, lld, spec] } }
```

- [ ] **Step 3: Write the failing test**

`app/tests/strategy.test.ts`:
```ts
import { loadStrategy } from "../src/strategy";

const DEFS = new URL("../workflows/definitions/", import.meta.url).pathname;

describe("loadStrategy", () => {
  it("loads prd strategy + common with camelCased keys", () => {
    const { strategy, common } = loadStrategy(DEFS, "prd");
    expect(strategy.type).toBe("prd");
    expect(strategy.version).toBe(1);
    expect(strategy.jobs.quality.threshold).toBe(85);
    expect(strategy.jobs.generate.skill).toBe("prd.generate");
    expect(common.trigger.newRunStatus).toBe("PRD 요청");
    expect(common.inbound["승인"]).toBe("approved");
    expect(common.outbound.quality_passed[0]).toEqual({
      action: "jira_status",
      status: "승인대기",
    });
  });

  it("throws when type does not match filename", () => {
    expect(() => loadStrategy(DEFS, "nope")).toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test:app -- strategy`
Expected: FAIL — cannot find module `../src/strategy`.

- [ ] **Step 5: Write `app/src/strategy.ts`**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface JobDef {
  skill: string;
  outputSchema: Record<string, unknown>; // JSON Schema (consumed by ajv as-is)
  threshold?: number;
}

export interface StrategyDef {
  version: number;
  type: string;
  meta: { approverRole?: string };
  jobs: Record<string, JobDef>;
}

export interface OutboundEntry {
  action: "jira_status" | "jira_comment";
  status?: string;
  template?: string;
}

export interface CommonDef {
  trigger: { newRunStatus: string };
  outbound: Record<string, OutboundEntry[]>; // keys: quality_passed | quality_failed | ...
  inbound: Record<string, string>; // "승인" -> "approved"
}

export interface LoadedStrategy {
  strategy: StrategyDef;
  common: CommonDef;
}

function readYaml(path: string): any {
  return parse(readFileSync(path, "utf8"));
}

export function loadStrategy(defsDir: string, type: string): LoadedStrategy {
  const raw = readYaml(join(defsDir, `${type}.yaml`));
  if (raw?.type !== type) {
    throw new Error(
      `strategy file type "${raw?.type}" does not match requested "${type}"`,
    );
  }
  if (typeof raw.version !== "number") {
    throw new Error(`strategy "${type}" missing numeric version`);
  }
  const jobs: Record<string, JobDef> = {};
  for (const [jobType, def] of Object.entries<any>(raw.jobs ?? {})) {
    if (!def?.skill) throw new Error(`job "${jobType}" missing skill`);
    if (!def?.output_schema) throw new Error(`job "${jobType}" missing output_schema`);
    jobs[jobType] = {
      skill: def.skill,
      outputSchema: def.output_schema,
      threshold: def.threshold,
    };
  }

  const commonRaw = readYaml(join(defsDir, `_common.yaml`));
  const newRunStatus = commonRaw?.trigger?.new_run_status;
  if (!newRunStatus) throw new Error(`_common.yaml missing trigger.new_run_status`);

  const strategy: StrategyDef = {
    version: raw.version,
    type: raw.type,
    meta: { approverRole: raw.meta?.approver_role },
    jobs,
  };
  const common: CommonDef = {
    trigger: { newRunStatus },
    outbound: commonRaw.outbound ?? {},
    inbound: commonRaw.inbound ?? {},
  };
  return { strategy, common };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:app -- strategy`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add app/workflows/definitions app/src/strategy.ts app/tests/strategy.test.ts
git commit -m "feat(app): strategy yaml (prd + _common) and loader"
```

---

## Task 3: Envelope validator (shape only — bare claim)

**Files:**
- Create: `app/src/envelope.ts`
- Test: `app/tests/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/envelope.test.ts`:
```ts
import { validateEnvelope } from "../src/envelope";

const qualitySchema = {
  type: "object",
  required: ["score", "missing_items"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    missing_items: { type: "array", items: { type: "string" } },
  },
};

describe("validateEnvelope", () => {
  it("accepts a well-shaped envelope", () => {
    const r = validateEnvelope(
      {
        domainOutput: { score: 90, missing_items: [] },
        refs: [{ system: "git", key: "r@abc", url: "https://x/abc" }],
      },
      qualitySchema,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects domainOutput that violates output_schema", () => {
    const r = validateEnvelope(
      { domainOutput: { score: 200, missing_items: [] }, refs: [] },
      qualitySchema,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a ref missing required key", () => {
    const r = validateEnvelope(
      { domainOutput: { score: 90, missing_items: [] }, refs: [{ system: "git" }] },
      qualitySchema,
    );
    expect(r.ok).toBe(false);
  });

  it("does NOT verify ref reachability (bare claim) — fake but well-shaped ref passes", () => {
    const r = validateEnvelope(
      {
        domainOutput: { score: 90, missing_items: [] },
        refs: [{ system: "git", key: "does-not-exist@deadbeef" }],
      },
      qualitySchema,
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- envelope`
Expected: FAIL — cannot find module `../src/envelope`.

- [ ] **Step 3: Write `app/src/envelope.ts`**

```ts
import Ajv, { type AnySchema } from "ajv";
import type { Envelope } from "./domain";

const ajv = new Ajv({ allErrors: true });

const REFS_SCHEMA: AnySchema = {
  type: "array",
  items: {
    type: "object",
    required: ["system", "key"],
    properties: {
      system: { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      label: { type: "string" },
    },
  },
};
const validateRefs = ajv.compile(REFS_SCHEMA);

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string };

/**
 * Validates the *shape* of an envelope: domainOutput against the job's output_schema
 * and refs against the fixed ref shape. Does NOT verify ref reachability (D4 bare claim).
 */
export function validateEnvelope(
  envelope: Envelope,
  outputSchema: Record<string, unknown>,
): ValidationResult {
  const validateDomain = ajv.compile(outputSchema as AnySchema);
  if (!validateDomain(envelope.domainOutput)) {
    return { ok: false, errors: ajv.errorsText(validateDomain.errors) };
  }
  if (!validateRefs(envelope.refs)) {
    return { ok: false, errors: ajv.errorsText(validateRefs.errors) };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:app -- envelope`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/envelope.ts app/tests/envelope.test.ts
git commit -m "feat(app): envelope shape validator (ajv, bare-claim by design)"
```

---

## Task 4: Handler types + template fill

**Files:**
- Create: `app/src/handler-types.ts`
- Test: `app/tests/handler-types.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/handler-types.test.ts`:
```ts
import { fillTemplate } from "../src/handler-types";

describe("fillTemplate", () => {
  it("substitutes scalar vars", () => {
    expect(fillTemplate("품질 {score}점 — {summary}", { score: 90, summary: "ok" })).toBe(
      "품질 90점 — ok",
    );
  });

  it("renders array vars as bullet lines", () => {
    expect(fillTemplate("보완: {missing_items}", { missing_items: ["a", "b"] })).toBe(
      "보완: \n- a\n- b",
    );
  });

  it("leaves unknown vars as empty string", () => {
    expect(fillTemplate("x={nope}", {})).toBe("x=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- handler-types`
Expected: FAIL — cannot find module `../src/handler-types`.

- [ ] **Step 3: Write `app/src/handler-types.ts`**

```ts
import type { Envelope, JobType, Ref, Task } from "./domain";
import type { CommonDef, StrategyDef } from "./strategy";

export type Event =
  | { kind: "task_spawned"; taskId: string }
  | { kind: "job_finished"; taskId: string; jobType: JobType; envelope: Envelope }
  | { kind: "external_event"; taskId: string; transition: string };

export type ExternalAction =
  | { kind: "jira_status"; issueKey: string; status: string }
  | { kind: "jira_comment"; issueKey: string; body: string };

export type Action =
  | { kind: "spawn_job"; jobType: JobType; inlineInputs?: Record<string, unknown>; inputRefs?: Ref[] }
  | { kind: "outbound"; actions: ExternalAction[] }
  | { kind: "await_human" }
  | { kind: "terminate"; outcome: "succeeded" | "failed"; nextTaskCandidates?: string[] };

export interface TaskContext {
  task: Task;
  strategy: StrategyDef;
  common: CommonDef;
}

export interface EventHandler {
  onEvent(event: Event, ctx: TaskContext): Action[];
}

/** Substitutes {var}. Arrays render as markdown bullet lines; unknown vars → "". */
export function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) return "\n" + v.map((x) => `- ${x}`).join("\n");
    return String(v);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:app -- handler-types`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/handler-types.ts app/tests/handler-types.test.ts
git commit -m "feat(app): handler Event/Action types + template fill"
```

---

## Task 5: PRD EventHandler + registry

**Files:**
- Create: `app/src/prd-handler.ts`
- Create: `app/src/registry.ts`
- Test: `app/tests/prd-handler.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/prd-handler.test.ts`:
```ts
import { prdHandler } from "../src/prd-handler";
import type { TaskContext } from "../src/handler-types";
import { loadStrategy } from "../src/strategy";
import type { Task } from "../src/domain";

const DEFS = new URL("../workflows/definitions/", import.meta.url).pathname;
const { strategy, common } = loadStrategy(DEFS, "prd");

function ctx(overrides: Partial<Task> = {}): TaskContext {
  const task: Task = {
    id: "t1",
    runId: "r1",
    parentTaskId: null,
    type: "prd",
    jiraKey: "PAIR-1",
    assigneeEmail: null,
    status: "pending",
    refs: [],
    createdAt: "2026-06-09T00:00:00.000Z",
    terminatedAt: null,
    ...overrides,
  };
  return { task, strategy, common };
}

describe("prdHandler", () => {
  it("task_spawned → spawn generate", () => {
    const a = prdHandler.onEvent({ kind: "task_spawned", taskId: "t1" }, ctx());
    expect(a).toEqual([{ kind: "spawn_job", jobType: "generate" }]);
  });

  it("generate finished → spawn quality", () => {
    const a = prdHandler.onEvent(
      { kind: "job_finished", taskId: "t1", jobType: "generate", envelope: { domainOutput: { summary: "s" }, refs: [] } },
      ctx(),
    );
    expect(a).toEqual([{ kind: "spawn_job", jobType: "quality" }]);
  });

  it("quality >= threshold → outbound(quality_passed) + await_human", () => {
    const a = prdHandler.onEvent(
      {
        kind: "job_finished",
        taskId: "t1",
        jobType: "quality",
        envelope: { domainOutput: { score: 90, missing_items: [], summary: "ok" }, refs: [] },
      },
      ctx(),
    );
    expect(a[0]).toEqual({
      kind: "outbound",
      actions: [
        { kind: "jira_status", issueKey: "PAIR-1", status: "승인대기" },
        { kind: "jira_comment", issueKey: "PAIR-1", body: "품질 90점 — 승인 대기. ok" },
      ],
    });
    expect(a[1]).toEqual({ kind: "await_human" });
  });

  it("quality < threshold → outbound(quality_failed) + terminate failed", () => {
    const a = prdHandler.onEvent(
      {
        kind: "job_finished",
        taskId: "t1",
        jobType: "quality",
        envelope: { domainOutput: { score: 50, missing_items: ["AC 부족"] }, refs: [] },
      },
      ctx(),
    );
    expect(a[0].kind).toBe("outbound");
    expect(a[1]).toEqual({ kind: "terminate", outcome: "failed" });
  });

  it("approved transition → spawn routing", () => {
    const a = prdHandler.onEvent(
      { kind: "external_event", taskId: "t1", transition: "승인" },
      ctx({ status: "awaiting_human" }),
    );
    expect(a).toEqual([{ kind: "spawn_job", jobType: "routing" }]);
  });

  it("routing finished → terminate succeeded with candidates", () => {
    const a = prdHandler.onEvent(
      {
        kind: "job_finished",
        taskId: "t1",
        jobType: "routing",
        envelope: { domainOutput: { next_task_types: ["hld"] }, refs: [], nextTaskCandidates: ["hld"] },
      },
      ctx(),
    );
    expect(a).toEqual([{ kind: "terminate", outcome: "succeeded", nextTaskCandidates: ["hld"] }]);
  });

  it("unknown transition → no actions", () => {
    const a = prdHandler.onEvent(
      { kind: "external_event", taskId: "t1", transition: "취소요청" },
      ctx({ status: "awaiting_human" }),
    );
    expect(a).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- prd-handler`
Expected: FAIL — cannot find module `../src/prd-handler`.

- [ ] **Step 3: Write `app/src/prd-handler.ts`**

```ts
import type { Action, EventHandler, ExternalAction, TaskContext } from "./handler-types";
import { fillTemplate } from "./handler-types";

function outboundFor(
  key: string,
  ctx: TaskContext,
  vars: Record<string, unknown>,
): Action {
  const entries = ctx.common.outbound[key] ?? [];
  const actions: ExternalAction[] = entries.map((e) => {
    if (e.action === "jira_status") {
      return { kind: "jira_status", issueKey: ctx.task.jiraKey, status: e.status ?? "" };
    }
    return {
      kind: "jira_comment",
      issueKey: ctx.task.jiraKey,
      body: fillTemplate(e.template ?? "", vars),
    };
  });
  return { kind: "outbound", actions };
}

export const prdHandler: EventHandler = {
  onEvent(event, ctx): Action[] {
    switch (event.kind) {
      case "task_spawned":
        return [{ kind: "spawn_job", jobType: "generate" }];

      case "job_finished": {
        if (event.jobType === "generate") {
          return [{ kind: "spawn_job", jobType: "quality" }];
        }
        if (event.jobType === "quality") {
          const out = event.envelope.domainOutput;
          const score = Number(out.score ?? 0);
          const threshold = ctx.strategy.jobs.quality?.threshold ?? 0;
          const vars = { ...out, threshold };
          if (score >= threshold) {
            return [outboundFor("quality_passed", ctx, vars), { kind: "await_human" }];
          }
          return [
            outboundFor("quality_failed", ctx, vars),
            { kind: "terminate", outcome: "failed" },
          ];
        }
        if (event.jobType === "routing") {
          return [
            {
              kind: "terminate",
              outcome: "succeeded",
              nextTaskCandidates: event.envelope.nextTaskCandidates,
            },
          ];
        }
        return [];
      }

      case "external_event": {
        const semantic = ctx.common.inbound[event.transition];
        if (semantic === "approved") {
          return [{ kind: "spawn_job", jobType: "routing" }];
        }
        return [];
      }
    }
  },
};
```

- [ ] **Step 4: Write `app/src/registry.ts`**

```ts
import type { EventHandler } from "./handler-types";
import { prdHandler } from "./prd-handler";

export type HandlerRegistry = Map<string, EventHandler>;

export function defaultRegistry(): HandlerRegistry {
  return new Map<string, EventHandler>([["prd", prdHandler]]);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:app -- prd-handler`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/prd-handler.ts app/src/registry.ts app/tests/prd-handler.test.ts
git commit -m "feat(app): prd EventHandler + handler registry"
```

---

## Task 6: Repo ports + in-memory implementation

**Files:**
- Create: `app/src/repos.ts`
- Test: `app/tests/repos.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/repos.test.ts`:
```ts
import { InMemoryRepos } from "../src/repos";
import type { Job, Task, WorkflowRun } from "../src/domain";

function run(): WorkflowRun {
  return {
    id: "r1",
    definitionVersion: "v0",
    sourceRequestRef: "PAIR-1",
    status: "running",
    createdAt: "2026-06-09T00:00:00.000Z",
    completedAt: null,
  };
}
function task(): Task {
  return {
    id: "t1",
    runId: "r1",
    parentTaskId: null,
    type: "prd",
    jiraKey: "PAIR-1",
    assigneeEmail: null,
    status: "pending",
    refs: [],
    createdAt: "2026-06-09T00:00:00.000Z",
    terminatedAt: null,
  };
}
function job(id: string, status: Job["status"] = "pending"): Job {
  return {
    id,
    taskId: "t1",
    jobType: "generate",
    inlineInputs: {},
    inputRefs: [],
    status,
    envelope: null,
    runnerId: null,
    startedAt: null,
    endedAt: null,
  };
}

describe("InMemoryRepos", () => {
  it("round-trips run/task and finds task by jira key", async () => {
    const repos = new InMemoryRepos();
    await repos.runs.create(run());
    await repos.tasks.create(task());
    expect((await repos.runs.get("r1"))?.status).toBe("running");
    expect((await repos.tasks.getByJiraKey("PAIR-1"))?.id).toBe("t1");
  });

  it("claimNextPending returns and marks one pending job at a time (FIFO)", async () => {
    const repos = new InMemoryRepos();
    await repos.jobs.create(job("j1"));
    await repos.jobs.create(job("j2"));
    const first = await repos.jobs.claimNextPending("runner-A");
    expect(first?.id).toBe("j1");
    expect(first?.status).toBe("claimed");
    expect(first?.runnerId).toBe("runner-A");
    const second = await repos.jobs.claimNextPending("runner-A");
    expect(second?.id).toBe("j2");
    const none = await repos.jobs.claimNextPending("runner-A");
    expect(none).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- repos`
Expected: FAIL — cannot find module `../src/repos`.

- [ ] **Step 3: Write `app/src/repos.ts`**

```ts
import type { Job, JobStatus, RunStatus, Task, WorkflowRun } from "./domain";

export interface RunRepo {
  create(run: WorkflowRun): Promise<void>;
  get(id: string): Promise<WorkflowRun | null>;
  setStatus(id: string, status: RunStatus, completedAt: string | null): Promise<void>;
}

export interface TaskRepo {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | null>;
  getByJiraKey(jiraKey: string): Promise<Task | null>;
  update(task: Task): Promise<void>;
}

export interface JobRepo {
  create(job: Job): Promise<void>;
  get(id: string): Promise<Job | null>;
  /** Atomically claim the oldest pending job (FIFO by insertion). */
  claimNextPending(runnerId: string): Promise<Job | null>;
  update(job: Job): Promise<void>;
}

export interface Repos {
  runs: RunRepo;
  tasks: TaskRepo;
  jobs: JobRepo;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class InMemoryRepos implements Repos {
  private runMap = new Map<string, WorkflowRun>();
  private taskMap = new Map<string, Task>();
  private jobMap = new Map<string, Job>();
  private jobOrder: string[] = [];

  runs: RunRepo = {
    create: async (run) => {
      this.runMap.set(run.id, clone(run));
    },
    get: async (id) => {
      const r = this.runMap.get(id);
      return r ? clone(r) : null;
    },
    setStatus: async (id, status, completedAt) => {
      const r = this.runMap.get(id);
      if (!r) throw new Error(`run ${id} not found`);
      r.status = status;
      r.completedAt = completedAt;
    },
  };

  tasks: TaskRepo = {
    create: async (task) => {
      this.taskMap.set(task.id, clone(task));
    },
    get: async (id) => {
      const t = this.taskMap.get(id);
      return t ? clone(t) : null;
    },
    getByJiraKey: async (jiraKey) => {
      for (const t of this.taskMap.values()) {
        if (t.jiraKey === jiraKey) return clone(t);
      }
      return null;
    },
    update: async (task) => {
      this.taskMap.set(task.id, clone(task));
    },
  };

  jobs: JobRepo = {
    create: async (job) => {
      this.jobMap.set(job.id, clone(job));
      this.jobOrder.push(job.id);
    },
    get: async (id) => {
      const j = this.jobMap.get(id);
      return j ? clone(j) : null;
    },
    claimNextPending: async (runnerId) => {
      for (const id of this.jobOrder) {
        const j = this.jobMap.get(id);
        if (j && j.status === "pending") {
          j.status = "claimed";
          j.runnerId = runnerId;
          return clone(j);
        }
      }
      return null;
    },
    update: async (job) => {
      this.jobMap.set(job.id, clone(job));
    },
  };
}

export const _internal: Record<string, never> = {} as RunStatus extends string
  ? Record<string, never>
  : never;
```

> Note: the trailing `_internal` line is a no-op kept out — **delete it if present**; it exists only to remind you not to leak status enums. Final file should end at the closing brace of `InMemoryRepos`.

- [ ] **Step 4: Remove the reminder line**

Ensure `app/src/repos.ts` ends right after the `InMemoryRepos` class closing brace. Delete the `export const _internal ...` block entirely.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:app -- repos`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/repos.ts app/tests/repos.test.ts
git commit -m "feat(app): repo ports + in-memory implementation"
```

---

## Task 7: Stub skill + Runner

**Files:**
- Create: `app/src/stub-skill.ts`
- Create: `app/src/runner.ts`
- Test: `app/tests/runner.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/runner.test.ts`:
```ts
import { Runner } from "../src/runner";
import { stubSkill } from "../src/stub-skill";
import { InMemoryRepos } from "../src/repos";
import { loadStrategy } from "../src/strategy";
import { systemClock } from "../src/clock";
import type { Job } from "../src/domain";

const DEFS = new URL("../workflows/definitions/", import.meta.url).pathname;
const { strategy } = loadStrategy(DEFS, "prd");

function pendingJob(jobType: Job["jobType"]): Job {
  return {
    id: `job-${jobType}`,
    taskId: "t1",
    jobType,
    inlineInputs: {},
    inputRefs: [],
    status: "pending",
    envelope: null,
    runnerId: null,
    startedAt: null,
    endedAt: null,
  };
}

describe("Runner.runOnce", () => {
  it("claims a pending job, calls the skill, validates, and stores a succeeded envelope", async () => {
    const repos = new InMemoryRepos();
    await repos.jobs.create(pendingJob("generate"));
    const runner = new Runner(repos, strategy, stubSkill, systemClock, "runner-A");

    const finished = await runner.runOnce();
    expect(finished?.jobType).toBe("generate");

    const stored = await repos.jobs.get("job-generate");
    expect(stored?.status).toBe("succeeded");
    expect(stored?.envelope?.domainOutput.summary).toBeTypeOf("string");
    expect(stored?.envelope?.refs.length).toBeGreaterThan(0);
    expect(stored?.endedAt).not.toBeNull();
  });

  it("returns null when no pending job", async () => {
    const repos = new InMemoryRepos();
    const runner = new Runner(repos, strategy, stubSkill, systemClock, "runner-A");
    expect(await runner.runOnce()).toBeNull();
  });

  it("marks job failed when the skill returns an envelope that violates output_schema", async () => {
    const repos = new InMemoryRepos();
    await repos.jobs.create(pendingJob("quality"));
    const badSkill = async () => ({
      domainOutput: { score: 999, missing_items: [] }, // 999 > max 100
      refs: [],
    });
    const runner = new Runner(repos, strategy, badSkill, systemClock, "runner-A");
    const finished = await runner.runOnce();
    expect(finished).toBeNull(); // failed jobs are not surfaced as finished work
    const stored = await repos.jobs.get("job-quality");
    expect(stored?.status).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- runner`
Expected: FAIL — cannot find module `../src/runner`.

- [ ] **Step 3: Write `app/src/stub-skill.ts`**

```ts
import type { Envelope, JobType } from "./domain";

export type Skill = (jobType: JobType, input: {
  inlineInputs: Record<string, unknown>;
  inputRefs: { system: string; key: string; url?: string; label?: string }[];
}) => Promise<Envelope>;

/** M0 stub standing in for the real Claude CLI skill. Returns fixed, well-shaped envelopes. */
export const stubSkill: Skill = async (jobType) => {
  switch (jobType) {
    case "generate":
      return {
        domainOutput: { summary: "PRD 초안 요약 (스텁)" },
        refs: [
          { system: "git", key: "prd-repo@abc1234", url: "https://git.example/abc1234" },
          { system: "wiki", key: "10001", url: "https://wiki.example/pages/10001" },
        ],
      };
    case "quality":
      return {
        domainOutput: { score: 90, missing_items: [], summary: "PRD 초안 요약 (스텁)" },
        refs: [],
      };
    case "routing":
      return {
        domainOutput: { next_task_types: ["hld"] },
        refs: [],
        nextTaskCandidates: ["hld"],
      };
  }
};
```

- [ ] **Step 4: Write `app/src/runner.ts`**

```ts
import type { Clock } from "./clock";
import type { Job } from "./domain";
import { validateEnvelope } from "./envelope";
import type { Repos } from "./repos";
import type { Skill } from "./stub-skill";
import type { StrategyDef } from "./strategy";

/**
 * Single local runner (M0). Claims one pending job, invokes the skill, validates the
 * envelope shape, and stores the result. git/wiki/PR writes are the skill's job — the
 * runner only relays the envelope. Returns the finished job on success, null otherwise.
 */
export class Runner {
  constructor(
    private readonly repos: Repos,
    private readonly strategy: StrategyDef,
    private readonly skill: Skill,
    private readonly clock: Clock,
    private readonly runnerId: string,
  ) {}

  async runOnce(): Promise<Job | null> {
    const claimed = await this.repos.jobs.claimNextPending(this.runnerId);
    if (!claimed) return null;

    const startedAt = this.clock.now();
    const jobDef = this.strategy.jobs[claimed.jobType];
    if (!jobDef) {
      return this.fail(claimed, startedAt);
    }

    let envelope;
    try {
      envelope = await this.skill(claimed.jobType, {
        inlineInputs: claimed.inlineInputs,
        inputRefs: claimed.inputRefs,
      });
    } catch {
      return this.fail(claimed, startedAt);
    }

    const result = validateEnvelope(envelope, jobDef.outputSchema);
    if (!result.ok) {
      return this.fail(claimed, startedAt);
    }

    const succeeded: Job = {
      ...claimed,
      status: "succeeded",
      envelope,
      startedAt,
      endedAt: this.clock.now(),
    };
    await this.repos.jobs.update(succeeded);
    return succeeded;
  }

  private async fail(job: Job, startedAt: string): Promise<null> {
    await this.repos.jobs.update({
      ...job,
      status: "failed",
      startedAt,
      endedAt: this.clock.now(),
    });
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:app -- runner`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add app/src/stub-skill.ts app/src/runner.ts app/tests/runner.test.ts
git commit -m "feat(app): stub skill + runner with envelope validation"
```

---

## Task 8: Jira inbound/outbound (port + recorder)

**Files:**
- Create: `app/src/jira.ts`
- Test: `app/tests/jira.test.ts`

- [ ] **Step 1: Write the failing test**

`app/tests/jira.test.ts`:
```ts
import { normalizeJiraWebhook, RecordingOutbound } from "../src/jira";

describe("normalizeJiraWebhook", () => {
  it("classifies a trigger-status issue as a new_run", () => {
    const evt = normalizeJiraWebhook(
      { issue: { key: "PAIR-7" }, status: "PRD 요청" },
      "PRD 요청",
    );
    expect(evt).toEqual({ kind: "new_run", jiraKey: "PAIR-7" });
  });

  it("classifies a non-trigger status as a transition", () => {
    const evt = normalizeJiraWebhook(
      { issue: { key: "PAIR-7" }, status: "승인" },
      "PRD 요청",
    );
    expect(evt).toEqual({ kind: "transition", jiraKey: "PAIR-7", transition: "승인" });
  });

  it("returns ignore when no issue key present", () => {
    const evt = normalizeJiraWebhook({ status: "승인" }, "PRD 요청");
    expect(evt).toEqual({ kind: "ignore" });
  });
});

describe("RecordingOutbound", () => {
  it("records applied actions in order", async () => {
    const out = new RecordingOutbound();
    await out.apply({ kind: "jira_status", issueKey: "PAIR-7", status: "승인대기" });
    await out.apply({ kind: "jira_comment", issueKey: "PAIR-7", body: "hi" });
    expect(out.applied).toEqual([
      { kind: "jira_status", issueKey: "PAIR-7", status: "승인대기" },
      { kind: "jira_comment", issueKey: "PAIR-7", body: "hi" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- jira`
Expected: FAIL — cannot find module `../src/jira`.

- [ ] **Step 3: Write `app/src/jira.ts`**

```ts
import type { ExternalAction } from "./handler-types";

export type InboundEvent =
  | { kind: "new_run"; jiraKey: string }
  | { kind: "transition"; jiraKey: string; transition: string }
  | { kind: "ignore" };

interface JiraWebhookPayload {
  issue?: { key?: string };
  status?: string;
}

/** Source-agnostic normalize: a trigger-status issue starts a run; anything else is a transition. */
export function normalizeJiraWebhook(
  payload: JiraWebhookPayload,
  triggerStatus: string,
): InboundEvent {
  const jiraKey = payload.issue?.key;
  if (!jiraKey) return { kind: "ignore" };
  if (payload.status === triggerStatus) return { kind: "new_run", jiraKey };
  return { kind: "transition", jiraKey, transition: payload.status ?? "" };
}

/** Outbound port. M0 ships a recorder (tests + dry-run); real Jira client is M0+. */
export interface Outbound {
  apply(action: ExternalAction): Promise<void>;
}

export class RecordingOutbound implements Outbound {
  applied: ExternalAction[] = [];
  async apply(action: ExternalAction): Promise<void> {
    this.applied.push(action);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:app -- jira`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/jira.ts app/tests/jira.test.ts
git commit -m "feat(app): jira inbound normalize + outbound recorder port"
```

---

## Task 9: Reactor (wiring) + e2e happy path

**Files:**
- Create: `app/src/reactor.ts`
- Test: `app/tests/reactor.e2e.test.ts`

- [ ] **Step 1: Write the failing e2e test**

`app/tests/reactor.e2e.test.ts`:
```ts
import { Reactor } from "../src/reactor";
import { InMemoryRepos } from "../src/repos";
import { defaultRegistry } from "../src/registry";
import { RecordingOutbound } from "../src/jira";
import { Runner } from "../src/runner";
import { stubSkill } from "../src/stub-skill";
import { loadStrategy } from "../src/strategy";
import { systemClock } from "../src/clock";

const DEFS = new URL("../workflows/definitions/", import.meta.url).pathname;

function build() {
  const repos = new InMemoryRepos();
  const { strategy, common } = loadStrategy(DEFS, "prd");
  const out = new RecordingOutbound();
  const runner = new Runner(repos, strategy, stubSkill, systemClock, "runner-A");
  const reactor = new Reactor({
    repos,
    registry: defaultRegistry(),
    strategy,
    common,
    outbound: out,
    runner,
    clock: systemClock,
    definitionVersion: "test-v0",
  });
  return { repos, out, reactor };
}

describe("M0 PRD happy path (end-to-end, stub skill)", () => {
  it("intake → generate → quality → 승인대기, then 승인 → routing → completed", async () => {
    const { repos, out, reactor } = build();

    // 1. Inbound: new PRD request ticket at trigger status.
    const task = await reactor.startRun("PAIR-100");
    await reactor.drain(); // generate + quality run

    // Task awaits human after quality passes (score 90 >= 85).
    const afterQuality = await repos.tasks.get(task.id);
    expect(afterQuality?.status).toBe("awaiting_human");

    // Outbound mirrored 승인대기 + comment.
    expect(out.applied).toContainEqual({
      kind: "jira_status",
      issueKey: "PAIR-100",
      status: "승인대기",
    });
    expect(out.applied.some((a) => a.kind === "jira_comment")).toBe(true);

    // Refs from generate envelope accumulated onto the task (opaque metadata).
    expect(afterQuality?.refs.map((r) => r.system).sort()).toEqual(["git", "wiki"]);

    // 2. Human approves in Jira.
    await reactor.onExternalEvent("PAIR-100", "승인");
    await reactor.drain(); // routing runs

    // 3. Run completed; task succeeded; routing candidates recorded on the job.
    const finalTask = await repos.tasks.get(task.id);
    expect(finalTask?.status).toBe("succeeded");
    const run = await repos.runs.get(finalTask!.runId);
    expect(run?.status).toBe("completed");
    expect(run?.completedAt).not.toBeNull();
  });

  it("quality below threshold → task failed, run failed (no revise in M0)", async () => {
    const { repos, reactor } = build();
    // Override skill to fail quality by spawning a low score.
    const lowQuality = new Reactor({
      ...(reactor as unknown as { deps: any }).deps,
      runner: new Runner(
        repos,
        (reactor as unknown as { deps: any }).deps.strategy,
        async (jobType) =>
          jobType === "quality"
            ? { domainOutput: { score: 40, missing_items: ["AC 부족"] }, refs: [] }
            : { domainOutput: { summary: "s" }, refs: [] },
        systemClock,
        "runner-B",
      ),
    });
    const task = await lowQuality.startRun("PAIR-200");
    await lowQuality.drain();
    const t = await repos.tasks.get(task.id);
    expect(t?.status).toBe("failed");
    const run = await repos.runs.get(t!.runId);
    expect(run?.status).toBe("failed");
  });
});
```

> The second test reaches into `reactor.deps`. Task 9 Step 3 exposes a public readonly `deps` on `Reactor` to make this rewiring possible. Keep it — it is the seam for swapping the skill in tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- reactor`
Expected: FAIL — cannot find module `../src/reactor`.

- [ ] **Step 3: Write `app/src/reactor.ts`**

```ts
import type { Clock } from "./clock";
import { newId, type Job, type JobType, type Task } from "./domain";
import type { Action, Event } from "./handler-types";
import type { Outbound } from "./jira";
import type { HandlerRegistry } from "./registry";
import type { Repos } from "./repos";
import type { Runner } from "./runner";
import type { CommonDef, StrategyDef } from "./strategy";

export interface ReactorDeps {
  repos: Repos;
  registry: HandlerRegistry;
  strategy: StrategyDef;
  common: CommonDef;
  outbound: Outbound;
  runner: Runner;
  clock: Clock;
  definitionVersion: string;
}

export class Reactor {
  constructor(public readonly deps: ReactorDeps) {}

  /** Inbound: a new PRD request ticket → run + prd task + first event. */
  async startRun(jiraKey: string): Promise<Task> {
    const { repos, clock, definitionVersion } = this.deps;
    const now = clock.now();
    const runId = newId();
    await repos.runs.create({
      id: runId,
      definitionVersion,
      sourceRequestRef: jiraKey,
      status: "running",
      createdAt: now,
      completedAt: null,
    });
    const task: Task = {
      id: newId(),
      runId,
      parentTaskId: null,
      type: "prd",
      jiraKey,
      assigneeEmail: null,
      status: "in_progress",
      refs: [],
      createdAt: now,
      terminatedAt: null,
    };
    await repos.tasks.create(task);
    await this.applyEvent({ kind: "task_spawned", taskId: task.id });
    return task;
  }

  /** Inbound: a human Jira transition routed to its owning task. */
  async onExternalEvent(jiraKey: string, transition: string): Promise<void> {
    const task = await this.deps.repos.tasks.getByJiraKey(jiraKey);
    if (!task) return;
    await this.applyEvent({ kind: "external_event", taskId: task.id, transition });
  }

  /** Runner reports a finished job → accumulate refs, then react. */
  async onJobFinished(job: Job): Promise<void> {
    const { repos } = this.deps;
    const task = await repos.tasks.get(job.taskId);
    if (!task || !job.envelope) return;
    task.refs = [...task.refs, ...job.envelope.refs];
    await repos.tasks.update(task);
    await this.applyEvent({
      kind: "job_finished",
      taskId: task.id,
      jobType: job.jobType,
      envelope: job.envelope,
    });
  }

  /** Drive the single runner until no pending jobs remain, reacting to each result. */
  async drain(): Promise<void> {
    for (;;) {
      const finished = await this.deps.runner.runOnce();
      if (!finished) break;
      await this.onJobFinished(finished);
    }
  }

  private async applyEvent(event: Event): Promise<void> {
    const { repos, registry, strategy, common } = this.deps;
    const taskId = event.taskId;
    const task = await repos.tasks.get(taskId);
    if (!task) return;
    const handler = registry.get(task.type);
    if (!handler) throw new Error(`no handler for task type "${task.type}"`);

    const actions = handler.onEvent(event, { task, strategy, common });
    for (const action of actions) {
      await this.applyAction(action, task);
    }
  }

  private async applyAction(action: Action, task: Task): Promise<void> {
    const { repos, outbound, clock } = this.deps;
    switch (action.kind) {
      case "spawn_job": {
        const job: Job = {
          id: newId(),
          taskId: task.id,
          jobType: action.jobType as JobType,
          inlineInputs: action.inlineInputs ?? {},
          inputRefs: action.inputRefs ?? task.refs,
          status: "pending",
          envelope: null,
          runnerId: null,
          startedAt: null,
          endedAt: null,
        };
        await repos.jobs.create(job);
        return;
      }
      case "outbound": {
        for (const ext of action.actions) await outbound.apply(ext);
        return;
      }
      case "await_human": {
        const fresh = (await repos.tasks.get(task.id))!;
        fresh.status = "awaiting_human";
        await repos.tasks.update(fresh);
        return;
      }
      case "terminate": {
        const now = clock.now();
        const fresh = (await repos.tasks.get(task.id))!;
        fresh.status = action.outcome;
        fresh.terminatedAt = now;
        await repos.tasks.update(fresh);
        // M0: single task per run → task terminal = run terminal (orchestrator inline).
        const runStatus = action.outcome === "succeeded" ? "completed" : "failed";
        await repos.runs.setStatus(fresh.runId, runStatus, now);
        return;
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:app -- reactor`
Expected: PASS (2 tests). The happy path drives generate→quality→await→routing→completed; the low-quality path ends failed.

- [ ] **Step 5: Run the full app test suite + typecheck**

Run: `npm run typecheck:app && npm run test:app`
Expected: typecheck clean; all app tests PASS.

- [ ] **Step 6: Commit**

```bash
git add app/src/reactor.ts app/tests/reactor.e2e.test.ts
git commit -m "feat(app): reactor wiring + M0 PRD happy-path e2e (in-memory)"
```

---

## Task 10: MySQL persistence boundary (F5/F6) + migration

**Files:**
- Create: `app/migrations/001_init.sql`
- Create: `app/src/config.ts`
- Create: `app/src/db.ts`
- Test: `app/tests/db.test.ts` (pure conversion — always runs)

- [ ] **Step 1: Write the failing test (pure datetime conversion — no DB needed)**

`app/tests/db.test.ts`:
```ts
import { toMysqlDatetime, fromMysqlDatetime, safeLimit } from "../src/db";

describe("datetime boundary (F5)", () => {
  it("converts ISO 8601 'Z' to MySQL DATETIME (UTC, no Z)", () => {
    expect(toMysqlDatetime("2026-06-09T01:02:03.000Z")).toBe("2026-06-09 01:02:03");
  });

  it("round-trips MySQL DATETIME back to ISO", () => {
    expect(fromMysqlDatetime("2026-06-09 01:02:03")).toBe("2026-06-09T01:02:03.000Z");
  });

  it("accepts a Date object from the driver", () => {
    const d = new Date("2026-06-09T01:02:03.000Z");
    expect(fromMysqlDatetime(d)).toBe("2026-06-09T01:02:03.000Z");
  });

  it("passes null through", () => {
    expect(toMysqlDatetime(null)).toBeNull();
    expect(fromMysqlDatetime(null)).toBeNull();
  });
});

describe("safeLimit (F6)", () => {
  it("returns an inlinable integer for valid input", () => {
    expect(safeLimit(5)).toBe(5);
  });

  it("rejects non-integer/negative to avoid SQL injection via inlining", () => {
    expect(() => safeLimit(-1)).toThrow();
    expect(() => safeLimit(1.5)).toThrow();
    expect(() => safeLimit(Number("x"))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:app -- db`
Expected: FAIL — cannot find module `../src/db`.

- [ ] **Step 3: Write `app/src/config.ts`**

```ts
export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function mysqlConfigFromEnv(env = process.env): MysqlConfig {
  return {
    host: env.WORKFLOW_MYSQL_HOST ?? "127.0.0.1",
    port: Number(env.WORKFLOW_MYSQL_PORT ?? "3306"),
    user: env.WORKFLOW_MYSQL_USER ?? "ai_workflow",
    password: env.WORKFLOW_MYSQL_PASSWORD ?? "ai_workflow",
    database: env.WORKFLOW_MYSQL_DATABASE ?? "ai_workflow",
  };
}
```

- [ ] **Step 4: Write `app/src/db.ts`**

```ts
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type { MysqlConfig } from "./config";

/** F5: store all datetimes as UTC 'YYYY-MM-DD HH:mm:ss'. ISO 'Z' never reaches MySQL raw. */
export function toMysqlDatetime(iso: string | null): string | null {
  if (iso === null) return null;
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

export function fromMysqlDatetime(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  // MySQL DATETIME comes back as 'YYYY-MM-DD HH:mm:ss' (UTC by our convention).
  return new Date(value.replace(" ", "T") + "Z").toISOString();
}

/** F6: mysql2 cannot bind LIMIT as a placeholder. Validate then inline an integer. */
export function safeLimit(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`invalid LIMIT: ${n}`);
  }
  return n;
}

/** Single persistence boundary (NFR-4). All MySQL access goes through here. */
export class Db {
  private constructor(private readonly pool: Pool) {}

  static fromConfig(cfg: MysqlConfig): Db {
    const pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      timezone: "Z", // interpret/emit DATETIME as UTC
      connectionLimit: 4,
    });
    return new Db(pool);
  }

  async query<T extends RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query<T[]>(sql, params);
    return rows;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.pool.execute(sql, params);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
```

- [ ] **Step 5: Write `app/migrations/001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS workflow_run (
  id CHAR(36) PRIMARY KEY,
  definition_version VARCHAR(64) NOT NULL,
  source_request_ref VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME NOT NULL,
  completed_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task (
  id CHAR(36) PRIMARY KEY,
  run_id CHAR(36) NOT NULL,
  parent_task_id CHAR(36) NULL,
  type VARCHAR(32) NOT NULL,
  jira_key VARCHAR(64) NOT NULL,
  assignee_email VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL,
  refs LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL,
  terminated_at DATETIME NULL,
  INDEX idx_task_jira_key (jira_key),
  INDEX idx_task_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job (
  id CHAR(36) PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  job_type VARCHAR(32) NOT NULL,
  inline_inputs LONGTEXT NOT NULL,
  input_refs LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  envelope LONGTEXT NULL,
  runner_id VARCHAR(64) NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  INDEX idx_job_status (status),
  INDEX idx_job_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:app -- db`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add app/src/config.ts app/src/db.ts app/migrations/001_init.sql app/tests/db.test.ts
git commit -m "feat(app): mysql Db boundary (F5 datetime, F6 limit) + 001 schema"
```

---

## Task 11: MySQL repos + migrate runner + gated integration test

**Files:**
- Create: `app/src/mysql-repos.ts`
- Create: `app/src/migrate.ts`
- Test: `app/tests/mysql-repos.int.test.ts` (gated by `RUN_DB_TESTS=1`)

- [ ] **Step 1: Write `app/src/mysql-repos.ts`**

```ts
import type { Db } from "./db";
import { fromMysqlDatetime, safeLimit, toMysqlDatetime } from "./db";
import type {
  Envelope,
  Job,
  JobStatus,
  Ref,
  RunStatus,
  Task,
  WorkflowRun,
} from "./domain";
import type { JobRepo, Repos, RunRepo, TaskRepo } from "./repos";
import type { RowDataPacket } from "mysql2";

const j = (v: unknown): string => JSON.stringify(v);
const p = <T>(v: unknown, fallback: T): T =>
  typeof v === "string" && v.length > 0 ? (JSON.parse(v) as T) : fallback;

export class MysqlRepos implements Repos {
  constructor(private readonly db: Db) {}

  runs: RunRepo = {
    create: async (r: WorkflowRun) => {
      await this.db.execute(
        `INSERT INTO workflow_run (id, definition_version, source_request_ref, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.definitionVersion,
          r.sourceRequestRef,
          r.status,
          toMysqlDatetime(r.createdAt),
          toMysqlDatetime(r.completedAt),
        ],
      );
    },
    get: async (id) => {
      const rows = await this.db.query<RowDataPacket>(
        `SELECT * FROM workflow_run WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        definitionVersion: row.definition_version,
        sourceRequestRef: row.source_request_ref,
        status: row.status as RunStatus,
        createdAt: fromMysqlDatetime(row.created_at)!,
        completedAt: fromMysqlDatetime(row.completed_at),
      };
    },
    setStatus: async (id, status, completedAt) => {
      await this.db.execute(
        `UPDATE workflow_run SET status = ?, completed_at = ? WHERE id = ?`,
        [status, toMysqlDatetime(completedAt), id],
      );
    },
  };

  tasks: TaskRepo = {
    create: async (t: Task) => {
      await this.db.execute(
        `INSERT INTO task (id, run_id, parent_task_id, type, jira_key, assignee_email, status, refs, created_at, terminated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id,
          t.runId,
          t.parentTaskId,
          t.type,
          t.jiraKey,
          t.assigneeEmail,
          t.status,
          j(t.refs),
          toMysqlDatetime(t.createdAt),
          toMysqlDatetime(t.terminatedAt),
        ],
      );
    },
    get: async (id) => this.mapTask(await this.firstTask(`WHERE id = ?`, [id])),
    getByJiraKey: async (jiraKey) =>
      this.mapTask(await this.firstTask(`WHERE jira_key = ? ORDER BY created_at DESC LIMIT ${safeLimit(1)}`, [jiraKey])),
    update: async (t: Task) => {
      await this.db.execute(
        `UPDATE task SET status = ?, refs = ?, terminated_at = ? WHERE id = ?`,
        [t.status, j(t.refs), toMysqlDatetime(t.terminatedAt), t.id],
      );
    },
  };

  jobs: JobRepo = {
    create: async (job: Job) => {
      await this.db.execute(
        `INSERT INTO job (id, task_id, job_type, inline_inputs, input_refs, status, envelope, runner_id, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.taskId,
          job.jobType,
          j(job.inlineInputs),
          j(job.inputRefs),
          job.status,
          job.envelope ? j(job.envelope) : null,
          job.runnerId,
          toMysqlDatetime(job.startedAt),
          toMysqlDatetime(job.endedAt),
        ],
      );
    },
    get: async (id) => this.mapJob(await this.firstJob(`WHERE id = ?`, [id])),
    claimNextPending: async (runnerId) => {
      // M0 single-runner claim: pick oldest pending, then mark claimed.
      const rows = await this.db.query<RowDataPacket>(
        `SELECT * FROM job WHERE status = 'pending' ORDER BY started_at IS NOT NULL, id ASC LIMIT ${safeLimit(1)}`,
      );
      const row = rows[0];
      if (!row) return null;
      await this.db.execute(
        `UPDATE job SET status = 'claimed', runner_id = ? WHERE id = ? AND status = 'pending'`,
        [runnerId, row.id],
      );
      const claimed = this.mapJob(row);
      return claimed ? { ...claimed, status: "claimed", runnerId } : null;
    },
    update: async (job: Job) => {
      await this.db.execute(
        `UPDATE job SET status = ?, envelope = ?, runner_id = ?, started_at = ?, ended_at = ? WHERE id = ?`,
        [
          job.status,
          job.envelope ? j(job.envelope) : null,
          job.runnerId,
          toMysqlDatetime(job.startedAt),
          toMysqlDatetime(job.endedAt),
          job.id,
        ],
      );
    },
  };

  private async firstTask(where: string, params: unknown[]): Promise<RowDataPacket | undefined> {
    const rows = await this.db.query<RowDataPacket>(`SELECT * FROM task ${where}`, params);
    return rows[0];
  }
  private async firstJob(where: string, params: unknown[]): Promise<RowDataPacket | undefined> {
    const rows = await this.db.query<RowDataPacket>(`SELECT * FROM job ${where}`, params);
    return rows[0];
  }

  private mapTask(row?: RowDataPacket): Task | null {
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      parentTaskId: row.parent_task_id,
      type: row.type,
      jiraKey: row.jira_key,
      assigneeEmail: row.assignee_email,
      status: row.status,
      refs: p<Ref[]>(row.refs, []),
      createdAt: fromMysqlDatetime(row.created_at)!,
      terminatedAt: fromMysqlDatetime(row.terminated_at),
    };
  }

  private mapJob(row?: RowDataPacket): Job | null {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      jobType: row.job_type,
      inlineInputs: p<Record<string, unknown>>(row.inline_inputs, {}),
      inputRefs: p<Ref[]>(row.input_refs, []),
      status: row.status as JobStatus,
      envelope: row.envelope ? p<Envelope>(row.envelope, null as unknown as Envelope) : null,
      runnerId: row.runner_id,
      startedAt: fromMysqlDatetime(row.started_at),
      endedAt: fromMysqlDatetime(row.ended_at),
    };
  }
}
```

- [ ] **Step 2: Write `app/src/migrate.ts`**

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { mysqlConfigFromEnv } from "./config";

async function main(): Promise<void> {
  const cfg = mysqlConfigFromEnv();
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "../migrations/001_init.sql"), "utf8");
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
  });
  await conn.query(sql);
  await conn.end();
  // eslint-disable-next-line no-console
  console.log("migration 001 applied");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Write the gated integration test**

`app/tests/mysql-repos.int.test.ts`:
```ts
import { Db } from "../src/db";
import { mysqlConfigFromEnv } from "../src/config";
import { MysqlRepos } from "../src/mysql-repos";
import type { WorkflowRun } from "../src/domain";

const RUN = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!RUN)("MysqlRepos integration (requires MySQL + migration)", () => {
  let db: Db;
  let repos: MysqlRepos;

  beforeAll(() => {
    db = Db.fromConfig(mysqlConfigFromEnv());
    repos = new MysqlRepos(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("round-trips a run with ISO datetime through MySQL (F5 proof)", async () => {
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      definitionVersion: "it-v0",
      sourceRequestRef: "PAIR-IT-1",
      status: "running",
      createdAt: "2026-06-09T01:02:03.000Z",
      completedAt: null,
    };
    await repos.runs.create(run);
    const got = await repos.runs.get(run.id);
    expect(got?.createdAt).toBe("2026-06-09T01:02:03.000Z");
    expect(got?.status).toBe("running");
  });

  it("claimNextPending uses inlined LIMIT without a placeholder (F6 proof)", async () => {
    const taskId = crypto.randomUUID();
    await repos.tasks.create({
      id: taskId,
      runId: crypto.randomUUID(),
      parentTaskId: null,
      type: "prd",
      jiraKey: "PAIR-IT-2",
      assigneeEmail: null,
      status: "in_progress",
      refs: [],
      createdAt: "2026-06-09T01:02:03.000Z",
      terminatedAt: null,
    });
    const jobId = crypto.randomUUID();
    await repos.jobs.create({
      id: jobId,
      taskId,
      jobType: "generate",
      inlineInputs: {},
      inputRefs: [],
      status: "pending",
      envelope: null,
      runnerId: null,
      startedAt: null,
      endedAt: null,
    });
    const claimed = await repos.jobs.claimNextPending("runner-IT");
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("claimed");
  });
});
```

- [ ] **Step 4: Run app suite without DB (integration test auto-skips)**

Run: `npm run typecheck:app && npm run test:app`
Expected: typecheck clean; integration test reported as skipped; all other tests PASS.

- [ ] **Step 5: (Optional, when Docker available) run the integration test for real**

```bash
docker compose --profile workflow-db up -d workflow-mysql
# wait for healthy, then:
npm run db:migrate:app
RUN_DB_TESTS=1 npm run test:app -- mysql-repos.int
```
Expected: 2 integration tests PASS (F5 + F6 proofs).

- [ ] **Step 6: Commit**

```bash
git add app/src/mysql-repos.ts app/src/migrate.ts app/tests/mysql-repos.int.test.ts
git commit -m "feat(app): mysql repos + migrate runner + gated F5/F6 integration test"
```

---

## Task 12: App wiring + webhook shell (manual smoke)

**Files:**
- Create: `app/src/app.ts`
- Modify: `package.json` (add `start:app` script)

- [ ] **Step 1: Write `app/src/app.ts`**

```ts
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { systemClock } from "./clock";
import { mysqlConfigFromEnv } from "./config";
import { Db } from "./db";
import { MysqlRepos } from "./mysql-repos";
import { defaultRegistry } from "./registry";
import { loadStrategy } from "./strategy";
import { Runner } from "./runner";
import { stubSkill } from "./stub-skill";
import { normalizeJiraWebhook, RecordingOutbound } from "./jira";
import { Reactor } from "./reactor";

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function buildReactor(): Promise<{ reactor: Reactor; common: ReturnType<typeof loadStrategy>["common"]; db: Db }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const defs = join(here, "../workflows/definitions/");
  const { strategy, common } = loadStrategy(defs, "prd");
  const db = Db.fromConfig(mysqlConfigFromEnv());
  const repos = new MysqlRepos(db);
  const outbound = new RecordingOutbound(); // M0: real Jira client is M0+
  const runner = new Runner(repos, strategy, stubSkill, systemClock, "local-runner");
  const reactor = new Reactor({
    repos,
    registry: defaultRegistry(),
    strategy,
    common,
    outbound,
    runner,
    clock: systemClock,
    definitionVersion: process.env.DEFINITION_VERSION ?? "dev",
  });
  return { reactor, common, db };
}

async function main(): Promise<void> {
  const { reactor, common } = await buildReactor();
  const port = Number(process.env.PORT ?? "8787");

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/jira/webhook") {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      try {
        const payload = JSON.parse(await readBody(req));
        const evt = normalizeJiraWebhook(payload, common.trigger.newRunStatus);
        if (evt.kind === "new_run") {
          await reactor.startRun(evt.jiraKey);
          await reactor.drain();
        } else if (evt.kind === "transition") {
          await reactor.onExternalEvent(evt.jiraKey, evt.transition);
          await reactor.drain();
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ handled: evt.kind }),
        );
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    })();
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`workflow-app M0 listening on :${port} (POST /jira/webhook)`);
  });
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Add `start:app` to `package.json` scripts**

```json
    "start:app": "tsx app/src/app.ts"
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:app`
Expected: exits 0.

- [ ] **Step 4: (Optional) manual end-to-end smoke with MySQL up**

```bash
docker compose --profile workflow-db up -d workflow-mysql
npm run db:migrate:app
npm run start:app &
curl -s -X POST localhost:8787/jira/webhook -H 'content-type: application/json' \
  -d '{"issue":{"key":"PAIR-900"},"status":"PRD 요청"}'
# → {"handled":"new_run"} ; run reaches 승인대기
curl -s -X POST localhost:8787/jira/webhook -H 'content-type: application/json' \
  -d '{"issue":{"key":"PAIR-900"},"status":"승인"}'
# → {"handled":"transition"} ; run completes
```
Expected: rows in `workflow_run` (completed), `task` (succeeded, refs populated), `job` (3 succeeded).

- [ ] **Step 5: Commit**

```bash
git add app/src/app.ts package.json
git commit -m "feat(app): http webhook shell wiring reactor over mysql"
```

---

## Task 13: M0 acceptance check + docs

**Files:**
- Create: `app/README.md`

- [ ] **Step 1: Run the full suite + typecheck (final gate)**

Run: `npm run typecheck:app && npm run test:app`
Expected: typecheck clean; all tests PASS (DB integration skipped unless `RUN_DB_TESTS=1`).

- [ ] **Step 2: Write `app/README.md`**

```markdown
# Workflow App (M0)

Jira-reactor that drives one PRD cycle with a **stub skill** (real Claude CLI is M0+).
See [the M0 spec](../docs/superpowers/specs/2026-06-02-workflow-app-m0-minimal-spec.md).

## Run

```bash
npm install
docker compose --profile workflow-db up -d workflow-mysql
npm run db:migrate:app
npm run start:app
```

POST a Jira webhook to `localhost:8787/jira/webhook`:
- `{"issue":{"key":"PAIR-1"},"status":"PRD 요청"}` → starts a run (→ 승인대기)
- `{"issue":{"key":"PAIR-1"},"status":"승인"}` → routing → completed

## Test

```bash
npm run test:app                       # unit + e2e (in-memory)
RUN_DB_TESTS=1 npm run test:app        # also runs MySQL F5/F6 integration
```

## M0 acceptance (spec §6)

1. ✅ PRD 티켓 생성 → generate → quality → 승인대기 자동 진행 (e2e test).
2. ✅ 승인 → routing → Run completed, Jira+DB 일관 (e2e + smoke).
3. ✅ 스킬 ref 가 Task 메타로 저장 (e2e asserts git+wiki refs).
4. ✅ F7: 정책은 데이터(YAML), 코드에 type 분기 없음 (registry + strategy).
5. ⚠️ F11: 앱이 문서 내용 무보유(ref만) — 거짓 약속 표면 제거. ref 진위는 미검증(bare claim, D4).
   F5/F6: 단일 Db boundary 로 구조적 차단 (db.test + 통합 테스트).
```

- [ ] **Step 3: Commit**

```bash
git add app/README.md
git commit -m "docs(app): M0 readme + acceptance mapping"
```

---

## Self-Review

**1. Spec coverage (m0-minimal-spec §1–§6):**
- §2 Entities (WorkflowRun/Task/Job) → Task 1 (`domain.ts`) + Task 6/11 (repos). ✅
- §3 React loop (intake→generate→quality→await→approve→routing→complete) → Task 5 (handler) + Task 9 (reactor) + Task 9 e2e. ✅
- §3 quality fail → Task=failed/Run=failed → Task 5 + Task 9 second e2e test. ✅
- §3 trigger status as data → Task 2 (`_common.yaml` `trigger`) + Task 8 (`normalizeJiraWebhook`). ✅
- §4 Strategy 2 files + output_schema validation + refs[] shape → Task 2 (loader) + Task 3 (envelope). ✅
- §5 Components: Inbound (Task 8), Outbound Jira-only (Task 8 recorder), State machine/EventHandler (Task 5/9), Orchestrator inline (Task 9 terminate), Scheduler/Runner single-poll, no git code (Task 7). ✅
- §5 Runner: stdout+stderr/workspace isolation/Claude CLI → **deferred** (stub skill; real CLI is M0+, called out in scope). ⚠️ documented, not built.
- §6 acceptance #1–#5 → Task 13 README mapping + tests. ✅
- F5/F6 (single persistence boundary, NFR-4) → Task 10/11. ✅
- F7 (policy=data) → Task 2/5 (no type branching in dispatch; registry + YAML). ✅
- F11 (app holds no content, refs only) → Task 1 (`Ref`/`Envelope`), Task 9 (refs accumulation), honest acceptance wording. ✅

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to" left. The only intentional removal step is Task 6 Step 4 (delete the reminder line) — explicit, not a placeholder.

**3. Type consistency:** `Envelope.domainOutput`, `Ref{system,key,url?,label?}`, `JobType = generate|quality|routing`, `Action` variants (`spawn_job`/`outbound`/`await_human`/`terminate`), `ExternalAction` (`jira_status`/`jira_comment`), `Repos{runs,tasks,jobs}` with method names (`create`/`get`/`getByJiraKey`/`update`/`setStatus`/`claimNextPending`/`runOnce`) are used identically across Tasks 1, 4, 5, 6, 7, 9, 11. `loadStrategy` returns `{strategy, common}` used consistently in Tasks 2, 5, 7, 9, 12. `validateEnvelope(envelope, outputSchema)` signature matches Task 3 ↔ Task 7. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-09-workflow-app-m0.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
