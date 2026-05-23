import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository } from "../backend/src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../backend/src/workflow-core/scheduler";

const now = new Date("2026-05-20T00:00:00.000Z");

describe("WorkflowScheduler", () => {
  it("registers a local runner, heartbeats it, and claims eligible assigned work", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      projectId: "pair",
      repositoryId: "prd-docs",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now
    });

    const runner = await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      allowedProjectIds: ["pair"],
      allowedRepositoryIds: ["prd-docs"],
      capabilities: ["document.generate"],
      engines: ["claude"],
      defaultEngine: "claude",
      now
    });
    await scheduler.heartbeat(runner.id, new Date("2026-05-20T00:00:05.000Z"));
    const claim = await scheduler.claim(runner.id, now);

    expect(repository.runners[0]).toMatchObject({
      id: "runner-planner-a",
      status: "online",
      lastHeartbeatAt: "2026-05-20T00:00:05.000Z"
    });
    expect(claim?.job).toMatchObject({
      id: "job_1",
      status: "claimed",
      claimedByRunnerId: "runner-planner-a",
      leaseExpiresAt: "2026-05-20T00:00:30.000Z"
    });
  });

  it("marks stale runners offline and does not claim work for them", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, {
      leaseMs: 30_000,
      runnerOfflineAfterMs: 60_000
    });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now
    });
    await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now
    });

    const staleAt = new Date("2026-05-20T00:01:01.000Z");
    const runners = await scheduler.listRunners(staleAt);
    const claim = await scheduler.claim("runner-planner-a", staleAt);

    expect(runners).toMatchObject([
      {
        id: "runner-planner-a",
        status: "offline",
        lastHeartbeatAt: "2026-05-20T00:00:00.000Z"
      }
    ]);
    expect(claim).toBeUndefined();
    expect(repository.workflowJobs[0].status).toBe("pending");
    expect(repository.workflowJobs[0].claimedByRunnerId).toBeUndefined();
  });

  it("returns diagnostics when no pending job matches the runner", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-b",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now
    });
    await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now
    });

    const result = await scheduler.claimWithDiagnostics("runner-planner-a", now);

    expect(result.claim).toBeUndefined();
    expect(result.diagnostics).toMatchObject({
      runnerId: "runner-planner-a",
      reason: "no_matching_job",
      runnerStatus: "online",
      candidateJobCount: 1,
      nearestJobId: "job_1",
      nearestBlocker: "owner_mismatch"
    });
  });

  it("records runner result attempts and marks retryable failures for future claim", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.evaluate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.evaluate"],
      requiredEngine: "claude",
      now
    });
    await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.evaluate"],
      engines: ["claude"],
      now
    });

    const claim = await scheduler.claim("runner-planner-a", now);
    await scheduler.startJob(claim?.job.id ?? "", "runner-planner-a", now);
    const failed = await scheduler.failJob({
      jobId: claim?.job.id ?? "",
      runnerId: "runner-planner-a",
      output: { status: "failed" },
      errorCode: "timeout",
      errorMessage: "Engine timed out",
      retryable: true,
      now
    });

    expect(failed).toMatchObject({
      attemptNo: 1,
      status: "failed",
      errorCode: "timeout"
    });
    expect(repository.workflowJobs[0]).toMatchObject({
      status: "retrying",
      claimedByRunnerId: undefined
    });
    expect(repository.workflowEvents).toMatchObject([
      {
        runId: "run_1",
        jobId: "job_1",
        type: "job.retry_scheduled",
        message: "Job failed and was scheduled for retry",
        metadata: {
          severity: "warning",
          alert: false,
          attemptNo: 1,
          errorCode: "timeout",
          retryable: true,
          retryExhausted: false,
          metric: "workflow_job_retries_total"
        }
      }
    ]);

    const secondClaim = await scheduler.claim("runner-planner-a", new Date("2026-05-20T00:00:01.000Z"));
    await scheduler.completeJob({
      jobId: secondClaim?.job.id ?? "",
      runnerId: "runner-planner-a",
      output: { status: "passed" },
      now: new Date("2026-05-20T00:00:02.000Z")
    });

    expect(repository.workflowJobResults.map((result) => result.attemptNo)).toEqual([1, 2]);
    expect(repository.workflowJobs[0].status).toBe("succeeded");
  });

  it("emits a critical event when a job fails without another retry", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.evaluate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.evaluate"],
      requiredEngine: "claude",
      now
    });
    await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.evaluate"],
      engines: ["claude"],
      now
    });
    const claim = await scheduler.claim("runner-planner-a", now);
    await scheduler.startJob(claim?.job.id ?? "", "runner-planner-a", now);

    await scheduler.failJob({
      jobId: claim?.job.id ?? "",
      runnerId: "runner-planner-a",
      output: { status: "failed" },
      errorCode: "invalid_output",
      errorMessage: "Runner output was invalid",
      retryable: false,
      now
    });

    expect(repository.workflowJobs[0].status).toBe("failed");
    expect(repository.workflowEvents).toMatchObject([
      {
        type: "job.failed",
        message: "Job failed; no retry will be scheduled",
        metadata: {
          severity: "critical",
          alert: true,
          retryExhausted: true,
          metric: "workflow_job_failures_total"
        }
      }
    ]);
  });

  it("lets an operator manually retry a failed job", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const task = repository.createWorkflowTask({
      runId: run.id,
      taskType: "hld",
      sourceKey: "PRD-100-HLD-1",
      title: "HLD",
      status: "failed",
      currentDocumentId: "doc_hld",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.evaluate",
      input: {
        taskId: task.id
      },
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.evaluate"],
      requiredEngine: "claude",
      now
    });
    await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.evaluate"],
      engines: ["claude"],
      now
    });
    const claim = await scheduler.claim("runner-planner-a", now);
    await scheduler.startJob(claim?.job.id ?? "", "runner-planner-a", now);
    await scheduler.failJob({
      jobId: claim?.job.id ?? "",
      runnerId: "runner-planner-a",
      output: { status: "failed" },
      errorCode: "invalid_output",
      errorMessage: "Runner output was invalid",
      retryable: false,
      now
    });

    const retried = await scheduler.requestJobRetry({
      jobId: "job_1",
      requestedBy: "planner-a",
      reason: "Runner fixed its config",
      now: new Date("2026-05-20T00:00:01.000Z")
    });

    expect(retried).toMatchObject({
      id: "job_1",
      status: "retrying",
      claimedByRunnerId: undefined,
      leaseExpiresAt: undefined
    });
    expect(repository.workflowTasks[0]).toMatchObject({
      id: "task_1",
      status: "quality_review",
      updatedAt: "2026-05-20T00:00:01.000Z"
    });
    expect(repository.workflowEvents.map((event) => event.type)).toEqual(["job.failed", "job.retry_requested"]);
    expect(repository.workflowEvents.at(-1)).toMatchObject({
      type: "job.retry_requested",
      message: "Job retry requested",
      metadata: {
        severity: "warning",
        requestedBy: "planner-a",
        reason: "Runner fixed its config",
        status: "retrying",
        taskId: "task_1",
        taskStatus: "quality_review",
        metric: "workflow_job_manual_retries_total"
      }
    });

    const nextClaim = await scheduler.claim("runner-planner-a", new Date("2026-05-20T00:00:02.000Z"));

    expect(nextClaim?.job).toMatchObject({
      id: "job_1",
      status: "claimed",
      claimedByRunnerId: "runner-planner-a"
    });
  });

  it("lets an operator retry the latest retryable job for a task", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const task = repository.createWorkflowTask({
      runId: run.id,
      taskType: "hld",
      sourceKey: "PRD-100-HLD-1",
      title: "HLD",
      status: "failed",
      now
    });
    const otherTask = repository.createWorkflowTask({
      runId: run.id,
      taskType: "spec",
      sourceKey: "PRD-100-SPEC-1",
      title: "Spec",
      status: "failed",
      now
    });
    const oldJob = repository.createWorkflowJob({
      runId: run.id,
      taskId: task.id,
      jobType: "document.generate",
      now
    });
    const latestRetryableJob = repository.createWorkflowJob({
      runId: run.id,
      taskId: task.id,
      jobType: "document.evaluate",
      now: new Date("2026-05-20T00:00:01.000Z")
    });
    const otherTaskJob = repository.createWorkflowJob({
      runId: run.id,
      taskId: otherTask.id,
      jobType: "document.evaluate",
      now: new Date("2026-05-20T00:00:02.000Z")
    });
    oldJob.status = "failed";
    oldJob.updatedAt = "2026-05-20T00:00:01.000Z";
    latestRetryableJob.status = "canceled";
    latestRetryableJob.updatedAt = "2026-05-20T00:00:03.000Z";
    otherTaskJob.status = "failed";
    otherTaskJob.updatedAt = "2026-05-20T00:00:04.000Z";

    const retried = await scheduler.requestTaskRetry({
      taskId: task.id,
      requestedBy: "planner-a",
      reason: "Task needs another quality pass",
      now: new Date("2026-05-20T00:00:05.000Z")
    });

    expect(retried).toMatchObject({
      task: {
        id: task.id,
        status: "quality_review",
        updatedAt: "2026-05-20T00:00:05.000Z"
      },
      job: {
        id: latestRetryableJob.id,
        status: "retrying",
        claimedByRunnerId: undefined,
        leaseExpiresAt: undefined
      }
    });
    expect(oldJob.status).toBe("failed");
    expect(otherTaskJob.status).toBe("failed");
    expect(repository.workflowEvents).toMatchObject([
      {
        type: "job.retry_requested",
        jobId: latestRetryableJob.id,
        metadata: {
          requestedBy: "planner-a",
          reason: "Task needs another quality pass",
          taskId: task.id,
          taskStatus: "quality_review"
        }
      }
    ]);
  });

  it("lets an operator send a task back to an upstream revision task", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    const lldTask = repository.createWorkflowTask({
      runId: run.id,
      taskType: "lld",
      sourceKey: "PRD-100-LLD-1",
      title: "LLD",
      status: "completed",
      currentDocumentId: "doc_lld",
      metadata: {
        currentDocumentVersionId: "docv_lld_1"
      },
      now
    });
    const specTask = repository.createWorkflowTask({
      runId: run.id,
      parentTaskId: lldTask.id,
      taskType: "spec",
      sourceKey: "PRD-100-SPEC-1",
      title: "Spec",
      status: "completed",
      currentDocumentId: "doc_spec",
      now
    });
    const codeTask = repository.createWorkflowTask({
      runId: run.id,
      parentTaskId: specTask.id,
      taskType: "code",
      sourceKey: "PRD-100-SPEC-1",
      title: "Code Implementation",
      status: "failed",
      currentDocumentId: "doc_spec",
      now
    });

    const result = await scheduler.requestTaskRevision({
      sourceTaskId: codeTask.id,
      targetTaskId: lldTask.id,
      requestedBy: "dev-a@example.com",
      reason: "Implementation exposed an LLD gap",
      feedback: "Clarify retry semantics before implementation continues.",
      now: new Date("2026-05-20T00:00:05.000Z")
    });

    expect(result).toMatchObject({
      sourceTask: {
        id: codeTask.id,
        status: "blocked",
        updatedAt: "2026-05-20T00:00:05.000Z"
      },
      targetTask: {
        id: lldTask.id,
        status: "in_progress",
        updatedAt: "2026-05-20T00:00:05.000Z"
      },
      job: {
        id: "job_1",
        taskId: lldTask.id,
        jobType: "document.revise",
        assignedUserId: "dev-a@example.com",
        requiredCapabilities: ["document.revise"],
        input: {
          taskId: lldTask.id,
          requestedBy: "dev-a@example.com",
          documentType: "lld",
          sourceDocumentId: "doc_lld",
          currentDocumentVersionId: "docv_lld_1",
          feedback: "Clarify retry semantics before implementation continues.",
          revisionSource: "workflow.task_revision_request",
          sourceTaskId: codeTask.id,
          targetTaskId: lldTask.id
        }
      }
    });
    expect(repository.workflowEvents).toMatchObject([
      {
        type: "task.revision_requested",
        jobId: "job_1",
        metadata: {
          requestedBy: "dev-a@example.com",
          sourceTaskId: codeTask.id,
          sourceTaskStatus: "blocked",
          targetTaskId: lldTask.id,
          targetTaskStatus: "in_progress",
          jobType: "document.revise"
        }
      }
    ]);
  });

  it("recovers expired leases so another eligible runner can claim stale work", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 10_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now
    });
    await scheduler.registerRunner({
      id: "runner-dev-a",
      ownerUserId: "dev-a",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now
    });
    await scheduler.registerRunner({
      id: "runner-dev-a-laptop",
      ownerUserId: "dev-a",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now
    });

    await scheduler.claim("runner-dev-a", now);
    const recovered = await scheduler.recoverExpiredLeases(new Date("2026-05-20T00:00:11.000Z"));
    const claim = await scheduler.claim("runner-dev-a-laptop", new Date("2026-05-20T00:00:12.000Z"));

    expect(recovered.map((job) => job.id)).toEqual(["job_1"]);
    expect(repository.workflowEvents).toMatchObject([
      {
        runId: "run_1",
        jobId: "job_1",
        type: "job.lease_expired",
        message: "Job lease expired and was scheduled for retry",
        metadata: {
          severity: "warning",
          alert: true,
          status: "retrying",
          metric: "workflow_job_lease_expirations_total"
        }
      }
    ]);
    expect(claim?.job).toMatchObject({
      id: "job_1",
      status: "claimed",
      claimedByRunnerId: "runner-dev-a-laptop"
    });
  });

  it("renews active job leases so healthy runners are not recovered as stale", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 10_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now
    });
    await scheduler.registerRunner({
      id: "runner-dev-a",
      ownerUserId: "dev-a",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now
    });

    await scheduler.claim("runner-dev-a", now);
    await scheduler.startJob("job_1", "runner-dev-a", new Date("2026-05-20T00:00:01.000Z"));
    const renewed = await scheduler.renewJobLease(
      "job_1",
      "runner-dev-a",
      new Date("2026-05-20T00:00:20.000Z")
    );
    const recovered = await scheduler.recoverExpiredLeases(new Date("2026-05-20T00:00:11.000Z"));

    expect(renewed).toMatchObject({
      id: "job_1",
      status: "running",
      leaseExpiresAt: "2026-05-20T00:00:30.000Z"
    });
    expect(recovered).toEqual([]);
    expect(repository.workflowJobs[0]).toMatchObject({
      status: "running",
      claimedByRunnerId: "runner-dev-a",
      leaseExpiresAt: "2026-05-20T00:00:30.000Z"
    });
  });

  it("requests cancellation and lets the claimed runner acknowledge it", async () => {
    const repository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.generate",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.generate"],
      requiredEngine: "codex",
      now
    });
    await scheduler.registerRunner({
      id: "runner-dev-a",
      ownerUserId: "dev-a",
      mode: "local",
      capabilities: ["spec.generate"],
      engines: ["codex"],
      now
    });

    const claim = await scheduler.claim("runner-dev-a", now);
    await scheduler.startJob(claim?.job.id ?? "", "runner-dev-a", now);
    const cancelRequested = await scheduler.requestJobCancellation({
      jobId: claim?.job.id ?? "",
      requestedBy: "planner-a",
      reason: "Superseded by a new request",
      now: new Date("2026-05-20T00:00:01.000Z")
    });

    expect(cancelRequested).toMatchObject({
      status: "cancel_requested",
      claimedByRunnerId: "runner-dev-a"
    });

    const canceled = await scheduler.acknowledgeJobCancellation({
      jobId: claim?.job.id ?? "",
      runnerId: "runner-dev-a",
      output: { status: "canceled" },
      now: new Date("2026-05-20T00:00:02.000Z")
    });

    expect(canceled).toMatchObject({
      status: "canceled",
      output: { status: "canceled" }
    });
    expect(repository.workflowJobs[0]).toMatchObject({
      status: "canceled",
      claimedByRunnerId: undefined
    });
    expect(repository.workflowEvents.map((event) => event.type)).toEqual([
      "job.cancel_requested",
      "job.canceled"
    ]);
  });
});
