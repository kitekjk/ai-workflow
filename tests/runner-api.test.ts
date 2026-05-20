import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDocumentRepository } from "../src/document-core/in-memory-repository";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { InMemoryWorkflowRepository } from "../src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../src/workflow-core/scheduler";
import { createWorkflowApiServer, type WorkflowApiServer } from "../src/workflow-api/server";

const now = "2026-05-20T00:00:00.000Z";

describe("Runner API", () => {
  let repository: InMemoryWorkflowRepository;
  let documents: InMemoryDocumentRepository;
  let server: WorkflowApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    repository = new InMemoryWorkflowRepository();
    documents = new InMemoryDocumentRepository();
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 30_000 });
    server = await createWorkflowApiServer({
      fixture,
      scheduler,
      documentRepository: documents
    }).listen(0);
    baseUrl = server.url;
  });

  afterEach(async () => {
    await server.close();
  });

  it("registers a local runner and lets the scheduler assign only eligible work", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a",
      projectId: "project-a",
      repositoryId: "repo-a",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-b",
      projectId: "project-a",
      repositoryId: "repo-a",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });

    const registrationResponse = await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerUserId: "dev-a",
      mode: "local",
      allowedProjectIds: ["project-a"],
      allowedRepositoryIds: ["repo-a"],
      capabilities: ["spec.implement"],
      engines: ["codex"],
      defaultEngine: "codex",
      now
    });
    const registration = await registrationResponse.json();

    expect(registrationResponse.status).toBe(201);
    expect(registration).toMatchObject({
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        status: "online",
        engines: ["codex"]
      }
    });

    const heartbeat = await postJson(`${baseUrl}/runners/runner-dev-a/heartbeat`, {
      now: "2026-05-20T00:00:05.000Z"
    });

    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({
      runner: {
        id: "runner-dev-a",
        lastHeartbeatAt: "2026-05-20T00:00:05.000Z"
      }
    });

    const claim = await postJson(`${baseUrl}/runners/runner-dev-a/claim`, {
      now: "2026-05-20T00:00:10.000Z"
    });

    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      claim: {
        job: {
          id: "job_1",
          status: "claimed",
          assignedUserId: "dev-a",
          claimedByRunnerId: "runner-dev-a",
          leaseExpiresAt: "2026-05-20T00:00:40.000Z"
        },
        runner: {
          id: "runner-dev-a"
        }
      }
    });
    expect(repository.workflowJobs[1].status).toBe("pending");
  });

  it("accepts start, success result, and retryable failure callbacks", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.evaluate",
      assignedUserId: "qa-a",
      requiredCapabilities: ["document.evaluate"],
      requiredEngine: "claude",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "qa-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-qa-a",
      ownerUserId: "qa-a",
      mode: "local",
      capabilities: ["document.evaluate", "document.generate"],
      engines: ["claude"],
      now
    });

    await postJson(`${baseUrl}/runners/runner-qa-a/claim`, { now });
    const started = await postJson(`${baseUrl}/runner-jobs/job_1/start`, {
      runnerId: "runner-qa-a",
      now: "2026-05-20T00:00:01.000Z"
    });
    const result = await postJson(`${baseUrl}/runner-jobs/job_1/results`, {
      runnerId: "runner-qa-a",
      output: { status: "passed" },
      now: "2026-05-20T00:00:02.000Z"
    });

    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      job: {
        id: "job_1",
        status: "running"
      }
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      result: {
        jobId: "job_1",
        attemptNo: 1,
        status: "succeeded",
        output: { status: "passed" }
      }
    });

    await postJson(`${baseUrl}/runners/runner-qa-a/claim`, {
      now: "2026-05-20T00:00:03.000Z"
    });
    const failed = await postJson(`${baseUrl}/runner-jobs/job_2/fail`, {
      runnerId: "runner-qa-a",
      output: { status: "failed" },
      errorCode: "engine_timeout",
      errorMessage: "Claude timed out",
      retryable: true,
      now: "2026-05-20T00:00:04.000Z"
    });

    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      result: {
        jobId: "job_2",
        attemptNo: 1,
        status: "failed",
        errorCode: "engine_timeout"
      }
    });
    expect(repository.workflowJobs.map((job) => job.status)).toEqual(["succeeded", "retrying"]);

    const events = await getJson(`${baseUrl}/workflow-runs/${run.id}/events?type=job.retry_scheduled`);
    expect(events).toMatchObject({
      events: [
        {
          id: "event_1",
          runId: run.id,
          jobId: "job_2",
          type: "job.retry_scheduled",
          message: "Job failed and was scheduled for retry",
          metadata: {
            severity: "warning",
            alert: false,
            runnerId: "runner-qa-a",
            attemptNo: 1,
            errorCode: "engine_timeout",
            metric: "workflow_job_retries_total"
          }
        }
      ]
    });
  });

  it("records runner logs as workflow events and reads them back with a limit", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now
    });
    await postJson(`${baseUrl}/runners/runner-planner-a/claim`, { now });

    const firstLog = await postJson(`${baseUrl}/runner-jobs/job_1/logs`, {
      runnerId: "runner-planner-a",
      level: "info",
      message: "Preparing workspace",
      metadata: { step: "prepare" },
      now: "2026-05-20T00:00:01.000Z"
    });
    await postJson(`${baseUrl}/runner-jobs/job_1/logs`, {
      runnerId: "runner-planner-a",
      level: "warn",
      message: "Retrying model call",
      metadata: { attempt: 2 },
      now: "2026-05-20T00:00:02.000Z"
    });
    const firstPage = await getJson(`${baseUrl}/runner-jobs/job_1/logs?limit=1`);
    const secondPage = await getJson(
      `${baseUrl}/runner-jobs/job_1/logs?limit=1&cursor=${encodeURIComponent(String(firstPage.nextCursor))}`
    );
    const invalidCursor = await fetch(`${baseUrl}/runner-jobs/job_1/logs?cursor=not-a-cursor`);

    expect(firstLog.status).toBe(201);
    expect(await firstLog.json()).toMatchObject({
      event: {
        id: "event_1",
        jobId: "job_1",
        type: "runner.log",
        message: "Preparing workspace",
        metadata: {
          level: "info",
          runnerId: "runner-planner-a",
          step: "prepare"
        }
      }
    });
    expect(firstPage).toMatchObject({
      events: [
        {
          id: "event_1",
          message: "Preparing workspace"
        }
      ],
      nextCursor: expect.any(String)
    });
    expect(secondPage).toMatchObject({
      events: [
        {
          id: "event_2",
          message: "Retrying model call"
        }
      ]
    });
    expect(secondPage.nextCursor).toBeUndefined();
    expect(invalidCursor.status).toBe(400);
  });

  it("redacts secrets from runner logs and failure callbacks before storing them", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now
    });
    await postJson(`${baseUrl}/runners/runner-planner-a/claim`, { now });

    const log = await postJson(`${baseUrl}/runner-jobs/job_1/logs`, {
      runnerId: "runner-planner-a",
      level: "debug",
      message: "Calling GitHub with Bearer ghp_secret",
      metadata: {
        apiToken: "ghp_secret",
        nested: {
          authorization: "Bearer ghp_secret",
          safe: "kept"
        }
      },
      now: "2026-05-20T00:00:01.000Z"
    });
    const failed = await postJson(`${baseUrl}/runner-jobs/job_1/fail`, {
      runnerId: "runner-planner-a",
      output: {
        status: "failed",
        githubToken: "ghp_secret"
      },
      errorCode: "engine_error",
      errorMessage: "GitHub rejected Bearer ghp_secret",
      retryable: false,
      now: "2026-05-20T00:00:02.000Z"
    });

    expect(log.status).toBe(201);
    expect(await log.json()).toMatchObject({
      event: {
        message: "Calling GitHub with Bearer [REDACTED]",
        metadata: {
          apiToken: "[REDACTED]",
          nested: {
            authorization: "[REDACTED]",
            safe: "kept"
          }
        }
      }
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      result: {
        output: {
          status: "failed",
          githubToken: "[REDACTED]"
        },
        errorMessage: "GitHub rejected Bearer [REDACTED]"
      }
    });
    expect(repository.workflowEvents[0].message).not.toContain("ghp_secret");
    expect(repository.workflowJobResults[0].errorMessage).not.toContain("ghp_secret");
  });

  it("registers runner artifacts only for jobs claimed by that runner", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now: new Date(now)
    });
    const document = documents.createDocument({
      workflowRunId: run.id,
      type: "prd",
      sourceKey: "PRD-100",
      title: "PRD-100",
      now: new Date(now)
    });
    const version = documents.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1",
      summary: "Initial PRD draft",
      now: new Date(now)
    });

    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now
    });

    const rejected = await postJson(`${baseUrl}/runner-jobs/job_1/artifacts`, {
      runnerId: "other-runner",
      documentId: document.id,
      documentVersionId: version.id,
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md",
      now: "2026-05-20T00:00:01.000Z"
    });
    await postJson(`${baseUrl}/runners/runner-planner-a/claim`, { now });
    const accepted = await postJson(`${baseUrl}/runner-jobs/job_1/artifacts`, {
      runnerId: "runner-planner-a",
      documentId: document.id,
      documentVersionId: version.id,
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md?token=ghp_secret",
      contentHash: "sha256:abc",
      metadata: {
        path: "prds/PRD-100.md",
        apiToken: "ghp_secret"
      },
      now: "2026-05-20T00:00:02.000Z"
    });

    expect(rejected.status).toBe(409);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      artifact: {
        id: "art_1",
        documentId: "doc_1",
        documentVersionId: "docv_1",
        producerJobId: "job_1",
        type: "document_markdown",
        location: "git",
        uri: "https://git.example.com/prds/PRD-100.md?token=[REDACTED]",
        contentHash: "sha256:abc",
        metadata: {
          path: "prds/PRD-100.md",
          apiToken: "[REDACTED]"
        }
      }
    });
    expect(documents.getCurrentDocument(document.id).document.currentMarkdownArtifactId).toBe("art_1");
  });

  it("exposes cancel request and runner cancellation acknowledgement endpoints", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.generate",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.generate"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerUserId: "dev-a",
      mode: "local",
      capabilities: ["spec.generate"],
      engines: ["codex"],
      now
    });
    await postJson(`${baseUrl}/runners/runner-dev-a/claim`, { now });
    await postJson(`${baseUrl}/runner-jobs/job_1/start`, {
      runnerId: "runner-dev-a",
      now
    });

    const cancel = await postJson(`${baseUrl}/runner-jobs/job_1/cancel`, {
      requestedBy: "planner-a",
      reason: "No longer needed",
      now: "2026-05-20T00:00:01.000Z"
    });
    const completeWhileCanceled = await postJson(`${baseUrl}/runner-jobs/job_1/results`, {
      runnerId: "runner-dev-a",
      output: { status: "succeeded" },
      now: "2026-05-20T00:00:02.000Z"
    });
    const canceled = await postJson(`${baseUrl}/runner-jobs/job_1/canceled`, {
      runnerId: "runner-dev-a",
      output: { status: "canceled" },
      now: "2026-05-20T00:00:03.000Z"
    });
    const job = await getJson(`${baseUrl}/runner-jobs/job_1`);

    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toMatchObject({
      job: {
        id: "job_1",
        status: "cancel_requested",
        claimedByRunnerId: "runner-dev-a"
      }
    });
    expect(completeWhileCanceled.status).toBe(409);
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      result: {
        jobId: "job_1",
        runnerId: "runner-dev-a",
        status: "canceled",
        output: { status: "canceled" }
      }
    });
    expect(job).toMatchObject({
      job: {
        id: "job_1",
        status: "canceled"
      }
    });
  });
});

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}
