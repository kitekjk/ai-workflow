import { describe, expect, it } from "vitest";
import type { Runner } from "../src/workflow-core/domain";
import { canRunnerClaimJob } from "../src/workflow-core/domain";
import { InMemoryWorkflowRepository } from "../src/workflow-core/in-memory-repository";

const now = new Date("2026-05-20T00:00:00.000Z");

describe("workflow-core runner claim policy", () => {
  it("allows a local runner to claim only its assigned scoped job", () => {
    const repository = new InMemoryWorkflowRepository();
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.upsertRunner(localRunner({ ownerUserId: "dev-a" }));

    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-b",
      projectId: "pair",
      repositoryId: "order-service",
      requiredCapabilities: ["spec.implement", "repo.write"],
      requiredEngine: "codex",
      now
    });
    const eligible = repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a",
      projectId: "pair",
      repositoryId: "order-service",
      requiredCapabilities: ["spec.implement", "repo.write"],
      requiredEngine: "codex",
      now
    });

    const claim = repository.claimNextJob({
      runnerId: "runner-dev-a",
      now,
      leaseMs: 60_000
    });

    expect(claim?.job.id).toBe(eligible.id);
    expect(claim?.job).toMatchObject({
      status: "claimed",
      claimedByRunnerId: "runner-dev-a",
      leaseExpiresAt: "2026-05-20T00:01:00.000Z"
    });
  });

  it("rejects local runner claims when project, repository, capability, or engine does not match", () => {
    const runner = localRunner({ ownerUserId: "dev-a" });
    const repository = new InMemoryWorkflowRepository();
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });

    const mismatches = [
      { projectId: "other-project" },
      { repositoryId: "billing-service" },
      { requiredCapabilities: ["document.evaluate"] },
      { requiredEngine: "claude" },
      { requiredEngine: undefined, preferredEngine: "claude" }
    ];

    for (const mismatch of mismatches) {
      const job = repository.createWorkflowJob({
        runId: run.id,
        jobType: "spec.implement",
        assignedUserId: "dev-a",
        projectId: "pair",
        repositoryId: "order-service",
        requiredCapabilities: ["spec.implement"],
        requiredEngine: "codex",
        now,
        ...mismatch
      });

      expect(canRunnerClaimJob(runner, job, now)).toBe(false);
    }
  });

  it("does not let two runners claim the same job lease", () => {
    const repository = new InMemoryWorkflowRepository();
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.upsertRunner(localRunner({ ownerUserId: "dev-a" }));
    repository.upsertRunner({
      ...localRunner({ ownerUserId: "dev-a" }),
      id: "runner-dev-a-laptop"
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a",
      projectId: "pair",
      repositoryId: "order-service",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now
    });

    const firstClaim = repository.claimNextJob({
      runnerId: "runner-dev-a",
      now,
      leaseMs: 60_000
    });
    const secondClaim = repository.claimNextJob({
      runnerId: "runner-dev-a-laptop",
      now,
      leaseMs: 60_000
    });

    expect(firstClaim?.job.id).toBe("job_1");
    expect(secondClaim).toBeUndefined();
  });

  it("records job results as attempt history", () => {
    const repository = new InMemoryWorkflowRepository();
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const job = repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      now
    });

    const first = repository.recordJobResult({
      jobId: job.id,
      status: "failed",
      output: { status: "failed" },
      errorCode: "invalid_json",
      errorMessage: "Runner output was not JSON",
      now
    });
    const second = repository.recordJobResult({
      jobId: job.id,
      status: "succeeded",
      output: { status: "succeeded" },
      now
    });

    expect(first.attemptNo).toBe(1);
    expect(second.attemptNo).toBe(2);
    expect(repository.workflowJobResults).toHaveLength(2);
  });
});

function localRunner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: "runner-dev-a",
    ownerUserId: "dev-a",
    mode: "local",
    status: "online",
    teamIds: ["team-a"],
    allowedProjectIds: ["pair"],
    allowedRepositoryIds: ["order-service"],
    capabilities: ["spec.implement", "repo.write"],
    engines: ["codex"],
    defaultEngine: "codex",
    concurrency: 1,
    lastHeartbeatAt: now.toISOString(),
    ...overrides
  };
}
