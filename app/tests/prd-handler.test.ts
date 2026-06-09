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
