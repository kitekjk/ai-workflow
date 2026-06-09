import { randomUUID } from "node:crypto";
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
      id: randomUUID(),
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
    const taskId = randomUUID();
    await repos.tasks.create({
      id: taskId,
      runId: randomUUID(),
      parentTaskId: null,
      type: "prd",
      jiraKey: "PAIR-IT-2",
      assigneeEmail: null,
      status: "in_progress",
      refs: [],
      createdAt: "2026-06-09T01:02:03.000Z",
      terminatedAt: null,
    });
    const jobId = randomUUID();
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
