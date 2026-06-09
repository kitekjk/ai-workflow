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
