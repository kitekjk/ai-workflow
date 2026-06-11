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
});
