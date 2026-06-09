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
