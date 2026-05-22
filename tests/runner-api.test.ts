import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDocumentRepository } from "../backend/src/document-core/in-memory-repository";
import { createPrdConfirmationFixture } from "../backend/src/prd-confirmation/fixture";
import { InMemoryWorkflowRepository } from "../backend/src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../backend/src/workflow-core/scheduler";
import { createWorkflowApiServer, type WorkflowApiServer } from "../backend/src/workflow-api/server";

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
      assignedUserId: "dev-a@example.com",
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
      ownerEmail: "dev-a@example.com",
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
        ownerUserId: "dev-a@example.com",
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
          assignedUserId: "dev-a@example.com",
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

  it("pauses a runner until an operator explicitly resumes it", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });

    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      defaultEngine: "codex",
      now
    });
    const paused = await postJson(`${baseUrl}/runners/runner-dev-a/pause`, {
      now: "2026-05-20T00:00:01.000Z"
    });
    const heartbeat = await postJson(`${baseUrl}/runners/runner-dev-a/heartbeat`, {
      mode: "local",
      ownerEmail: "dev-a@example.com",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      defaultEngine: "codex",
      now: "2026-05-20T00:00:02.000Z"
    });
    const disabledClaim = await postJson(`${baseUrl}/runners/runner-dev-a/claim`, {
      now: "2026-05-20T00:00:03.000Z"
    });
    const resumed = await postJson(`${baseUrl}/runners/runner-dev-a/resume`, {
      now: "2026-05-20T00:00:04.000Z"
    });
    const claim = await postJson(`${baseUrl}/runners/runner-dev-a/claim`, {
      now: "2026-05-20T00:00:05.000Z"
    });

    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      runner: {
        id: "runner-dev-a",
        status: "disabled"
      }
    });
    expect(await heartbeat.json()).toMatchObject({
      runner: {
        id: "runner-dev-a",
        status: "disabled"
      }
    });
    expect(await disabledClaim.json()).toMatchObject({
      claim: null,
      diagnostics: {
        reason: "runner_disabled",
        runnerStatus: "disabled"
      }
    });
    expect(await resumed.json()).toMatchObject({
      runner: {
        id: "runner-dev-a",
        status: "online"
      }
    });
    expect(await claim.json()).toMatchObject({
      claim: {
        job: {
          id: "job_1",
          status: "claimed",
          claimedByRunnerId: "runner-dev-a"
        }
      }
    });
  });

  it("does not let a runner claim more jobs than its concurrency allows", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });

    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      concurrency: 1,
      now
    });

    const firstClaim = await postJson(`${baseUrl}/runners/runner-dev-a/claim`, { now });
    const secondClaim = await postJson(`${baseUrl}/runners/runner-dev-a/claim`, {
      now: "2026-05-20T00:00:01.000Z"
    });

    expect(firstClaim.status).toBe(200);
    expect(await firstClaim.json()).toMatchObject({
      claim: {
        job: {
          id: "job_1",
          claimedByRunnerId: "runner-dev-a"
        }
      }
    });
    expect(secondClaim.status).toBe(200);
    expect(await secondClaim.json()).toMatchObject({
      claim: null,
      diagnostics: {
        runnerId: "runner-dev-a",
        reason: "runner_capacity_full",
        runnerStatus: "online",
        activeJobCount: 1,
        concurrency: 1
      }
    });
    expect(repository.workflowJobs.map((job) => job.status)).toEqual(["claimed", "pending"]);
  });

  it("recovers expired leases through the configured server loop", async () => {
    const recoveryRepository = new InMemoryWorkflowRepository();
    const recoveryScheduler = new WorkflowScheduler(recoveryRepository, { leaseMs: 10_000 });
    const claimTime = new Date(now);
    const run = recoveryRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: claimTime
    });
    recoveryRepository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: claimTime
    });
    await recoveryScheduler.registerRunner({
      id: "runner-dev-a",
      ownerUserId: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now: claimTime
    });
    await recoveryScheduler.claim("runner-dev-a", claimTime);

    const recoveryServer = await createWorkflowApiServer({
      scheduler: recoveryScheduler,
      schedulerRecoveryIntervalMs: 5,
      now: () => new Date("2026-05-20T00:00:11.000Z")
    }).listen(0);

    try {
      await waitForCondition(() => recoveryRepository.workflowJobs[0]?.status === "retrying");

      expect(recoveryRepository.workflowJobs[0]).toMatchObject({
        status: "retrying",
        claimedByRunnerId: undefined,
        leaseExpiresAt: undefined
      });
      expect(recoveryRepository.workflowEvents).toMatchObject([
        {
          type: "job.lease_expired",
          metadata: {
            alert: true,
            metric: "workflow_job_lease_expirations_total"
          }
        }
      ]);
    } finally {
      await recoveryServer.close();
    }
  });

  it("lists registered runners for dashboard visibility", async () => {
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-managed-a",
      mode: "managed",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now: "2026-05-20T00:00:05.000Z"
    });

    const response = await fetch(`${baseUrl}/runners?now=2026-05-20T00:00:10.000Z`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runners: [
        {
          id: "runner-dev-a",
          ownerUserId: "dev-a@example.com",
          mode: "local",
          status: "online",
          capabilities: ["spec.implement"],
          engines: ["codex"],
          claimDiagnostics: {
            reason: "no_available_job",
            runnerStatus: "online",
            candidateJobCount: 0
          }
        },
        {
          id: "runner-managed-a",
          mode: "managed",
          status: "online",
          capabilities: ["document.generate"],
          engines: ["claude"],
          claimDiagnostics: {
            reason: "no_available_job",
            runnerStatus: "online",
            candidateJobCount: 0
          }
        }
      ]
    });
  });

  it("returns copyable local runner onboarding commands", async () => {
    const response = await fetch(
      `${baseUrl}/runner-onboarding?ownerEmail=dev-a%40example.com&defaultEngine=codex&maxJobs=4`
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      runnerId: "runner-dev-a-example-com-pc",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      defaultEngine: "codex",
      capabilities: expect.arrayContaining(["document.generate", "implementation.open_pr", "implementation.update_pr"]),
      environment: {
        WORKFLOW_API_BASE_URL: expect.stringContaining("http://127.0.0.1:"),
        LOCAL_RUNNER_ID: "runner-dev-a-example-com-pc",
        LOCAL_RUNNER_OWNER_EMAIL: "dev-a@example.com",
        LOCAL_RUNNER_WORKSPACE_ROOT: ".runner-workspaces",
        LOCAL_RUNNER_MAX_JOBS: "4",
        GITHUB_TOKEN: "<set locally>",
        GITHUB_CLONE_URL: "https://github.com/<org>/<repo>.git"
      },
      commands: [
        { label: "Install", command: "npm install" },
        { label: "Doctor", command: "npm run doctor:local-runner" },
        { label: "Drain", command: "npm run start:local-runner" },
        {
          label: "Watch",
          command: "Remove-Item Env:LOCAL_RUNNER_MAX_JOBS -ErrorAction SilentlyContinue; npm run start:local-runner"
        }
      ]
    });
    expect(payload.powershellSetup).toContain('$env:LOCAL_RUNNER_OWNER_EMAIL="dev-a@example.com"');
    expect(payload.powershellSetup).toContain('$env:LOCAL_RUNNER_MAX_JOBS="4"');
    expect(JSON.stringify(payload)).not.toContain("ghp_");
  });

  it("shows runner claim availability diagnostics in the runner list", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now
    });

    const response = await fetch(`${baseUrl}/runners?now=2026-05-20T00:00:10.000Z`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runners: [
        {
          id: "runner-dev-a",
          claimDiagnostics: {
            reason: "claim_available",
            runnerStatus: "online",
            candidateJobCount: 1,
            nearestJobId: "job_1"
          }
        }
      ]
    });
  });

  it("marks capacity-full runners busy in the runner list", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a@example.com",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      concurrency: 1,
      now
    });
    await postJson(`${baseUrl}/runners/runner-dev-a/claim`, { now });

    const response = await fetch(`${baseUrl}/runners?now=2026-05-20T00:00:10.000Z`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runners: [
        {
          id: "runner-dev-a",
          status: "busy",
          claimDiagnostics: {
            reason: "runner_capacity_full",
            runnerStatus: "busy",
            activeJobCount: 1,
            concurrency: 1
          }
        }
      ]
    });
  });

  it("marks stale runners offline in the runner list", async () => {
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-dev-a",
      ownerEmail: "dev-a@example.com",
      mode: "local",
      capabilities: ["spec.implement"],
      engines: ["codex"],
      now
    });

    const response = await fetch(`${baseUrl}/runners?now=2026-05-20T00:01:01.000Z`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runners: [
        {
          id: "runner-dev-a",
          status: "offline",
          lastHeartbeatAt: now,
          claimDiagnostics: {
            reason: "runner_offline",
            runnerStatus: "offline"
          }
        }
      ]
    });
  });

  it("requires the configured app token for control-plane API calls", async () => {
    const protectedServer = await createWorkflowApiServer({
      fixture: createPrdConfirmationFixture(),
      auth: {
        appToken: "app-secret"
      }
    }).listen(0);

    try {
      const unauthorized = await postJson(`${protectedServer.url}/tick`, {});
      const authorized = await postJson(`${protectedServer.url}/tick`, {}, "app-secret");

      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ error: "Unauthorized" });
      expect(authorized.status).toBe(200);
    } finally {
      await protectedServer.close();
    }
  });

  it("binds runner API authorization to the runner id", async () => {
    const protectedRepository = new InMemoryWorkflowRepository();
    const protectedScheduler = new WorkflowScheduler(protectedRepository, { leaseMs: 30_000 });
    const run = protectedRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    protectedRepository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.implement",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.implement"],
      requiredEngine: "codex",
      now: new Date(now)
    });
    const protectedServer = await createWorkflowApiServer({
      scheduler: protectedScheduler,
      auth: {
        runnerTokens: {
          "runner-dev-a": "runner-a-secret",
          "runner-dev-b": "runner-b-secret"
        }
      }
    }).listen(0);

    try {
      const body = {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["spec.implement"],
        engines: ["codex"],
        now
      };
      const missingToken = await postJson(`${protectedServer.url}/runners/register`, body);
      const unknownRunner = await postJson(
        `${protectedServer.url}/runners/register`,
        {
          ...body,
          id: "runner-dev-c"
        },
        "runner-a-secret"
      );
      const registered = await postJson(`${protectedServer.url}/runners/register`, body, "runner-a-secret");
      const wrongClaimToken = await postJson(
        `${protectedServer.url}/runners/runner-dev-a/claim`,
        { now },
        "runner-b-secret"
      );
      const claim = await postJson(`${protectedServer.url}/runners/runner-dev-a/claim`, { now }, "runner-a-secret");
      const wrongCallbackToken = await postJson(
        `${protectedServer.url}/runner-jobs/job_1/start`,
        {
          runnerId: "runner-dev-a",
          now
        },
        "runner-b-secret"
      );
      const started = await postJson(
        `${protectedServer.url}/runner-jobs/job_1/start`,
        {
          runnerId: "runner-dev-a",
          now
        },
        "runner-a-secret"
      );

      expect(missingToken.status).toBe(401);
      expect(unknownRunner.status).toBe(403);
      expect(registered.status).toBe(201);
      expect(wrongClaimToken.status).toBe(401);
      expect(claim.status).toBe(200);
      expect(wrongCallbackToken.status).toBe(401);
      expect(started.status).toBe(200);
    } finally {
      await protectedServer.close();
    }
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
    const invalidRunCursor = await fetch(`${baseUrl}/workflow-runs/${run.id}/events?cursor=not-a-cursor`);

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
    expect(invalidRunCursor.status).toBe(400);
    expect(await invalidRunCursor.json()).toEqual({ error: "Invalid event cursor" });
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
    expect(await invalidCursor.json()).toEqual({ error: "Invalid event cursor" });
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

  it("exposes a manual retry endpoint for terminal runner jobs", async () => {
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
    await postJson(`${baseUrl}/runner-jobs/job_1/fail`, {
      runnerId: "runner-dev-a",
      output: { status: "failed" },
      errorCode: "invalid_output",
      errorMessage: "Runner output was invalid",
      retryable: false,
      now: "2026-05-20T00:00:01.000Z"
    });

    const retry = await postJson(`${baseUrl}/runner-jobs/job_1/retry`, {
      requestedBy: "planner-a",
      reason: "Fix prompt and run again",
      now: "2026-05-20T00:00:02.000Z"
    });
    const claim = await postJson(`${baseUrl}/runners/runner-dev-a/claim`, {
      now: "2026-05-20T00:00:03.000Z"
    });
    const events = await getJson(`${baseUrl}/workflow-runs/${run.id}/events?type=job.retry_requested`);

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      job: {
        id: "job_1",
        status: "retrying"
      }
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      claim: {
        job: {
          id: "job_1",
          status: "claimed",
          claimedByRunnerId: "runner-dev-a"
        }
      }
    });
    expect(events).toMatchObject({
      events: [
        {
          jobId: "job_1",
          type: "job.retry_requested",
          metadata: {
            requestedBy: "planner-a",
            reason: "Fix prompt and run again",
            status: "retrying"
          }
        }
      ]
    });
  });

  it("exposes a task retry endpoint that retries the task's latest terminal job", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
    });
    const task = repository.createWorkflowTask({
      runId: run.id,
      taskType: "hld",
      sourceKey: "PRD-100-HLD-1",
      title: "HLD",
      status: "failed",
      now: new Date(now)
    });
    repository.createWorkflowJob({
      runId: run.id,
      taskId: task.id,
      jobType: "document.evaluate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.evaluate"],
      requiredEngine: "claude",
      now: new Date(now)
    });
    await postJson(`${baseUrl}/runners/register`, {
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.evaluate"],
      engines: ["claude"],
      now
    });
    await postJson(`${baseUrl}/runners/runner-planner-a/claim`, { now });
    await postJson(`${baseUrl}/runner-jobs/job_1/start`, {
      runnerId: "runner-planner-a",
      now
    });
    await postJson(`${baseUrl}/runner-jobs/job_1/fail`, {
      runnerId: "runner-planner-a",
      output: { status: "failed" },
      errorCode: "invalid_output",
      errorMessage: "Runner output was invalid",
      retryable: false,
      now: "2026-05-20T00:00:01.000Z"
    });

    const retry = await postJson(`${baseUrl}/workflow-tasks/${encodeURIComponent(task.id)}/retry`, {
      requestedBy: "planner-a",
      reason: "Task-level retry",
      now: "2026-05-20T00:00:02.000Z"
    });
    const claim = await postJson(`${baseUrl}/runners/runner-planner-a/claim`, {
      now: "2026-05-20T00:00:03.000Z"
    });
    const events = await getJson(`${baseUrl}/workflow-runs/${run.id}/events?type=job.retry_requested`);

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      task: {
        id: task.id,
        status: "quality_review"
      },
      job: {
        id: "job_1",
        status: "retrying"
      }
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      claim: {
        job: {
          id: "job_1",
          status: "claimed",
          claimedByRunnerId: "runner-planner-a"
        }
      }
    });
    expect(events).toMatchObject({
      events: [
        {
          jobId: "job_1",
          type: "job.retry_requested",
          metadata: {
            requestedBy: "planner-a",
            reason: "Task-level retry",
            status: "retrying",
            taskId: task.id,
            taskStatus: "quality_review"
          }
        }
      ]
    });
  });

  it("exposes a task revision endpoint that sends work back to an upstream task", async () => {
    const run = repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now: new Date(now)
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
      now: new Date(now)
    });
    const specTask = repository.createWorkflowTask({
      runId: run.id,
      parentTaskId: lldTask.id,
      taskType: "spec",
      sourceKey: "PRD-100-SPEC-1",
      title: "Spec",
      status: "completed",
      currentDocumentId: "doc_spec",
      now: new Date(now)
    });
    const codeTask = repository.createWorkflowTask({
      runId: run.id,
      parentTaskId: specTask.id,
      taskType: "code",
      sourceKey: "PRD-100-SPEC-1",
      title: "Code Implementation",
      status: "failed",
      currentDocumentId: "doc_spec",
      now: new Date(now)
    });

    const revision = await postJson(`${baseUrl}/workflow-tasks/${encodeURIComponent(codeTask.id)}/request-revision`, {
      targetTaskId: lldTask.id,
      requestedBy: "dev-a@example.com",
      reason: "Implementation exposed an LLD gap",
      feedback: "Clarify retry semantics before implementation continues.",
      now: "2026-05-20T00:00:05.000Z"
    });
    const payload = await revision.json();
    const events = await getJson(`${baseUrl}/workflow-runs/${run.id}/events?type=task.revision_requested`);

    expect(revision.status).toBe(202);
    expect(payload).toMatchObject({
      sourceTask: {
        id: codeTask.id,
        status: "blocked"
      },
      targetTask: {
        id: lldTask.id,
        status: "in_progress"
      },
      job: {
        id: "job_1",
        taskId: lldTask.id,
        jobType: "document.revise",
        assignedUserId: "dev-a@example.com",
        requiredCapabilities: ["document.revise"],
        input: {
          taskId: lldTask.id,
          sourceDocumentId: "doc_lld",
          currentDocumentVersionId: "docv_lld_1",
          feedback: "Clarify retry semantics before implementation continues.",
          sourceTaskId: codeTask.id,
          targetTaskId: lldTask.id
        }
      }
    });
    expect(events).toMatchObject({
      events: [
        {
          jobId: "job_1",
          type: "task.revision_requested",
          metadata: {
            requestedBy: "dev-a@example.com",
            sourceTaskId: codeTask.id,
            sourceTaskStatus: "blocked",
            targetTaskId: lldTask.id,
            targetTaskStatus: "in_progress",
            jobType: "document.revise"
          }
        }
      ]
    });
  });
});

async function postJson(url: string, body: Record<string, unknown>, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function waitForCondition(condition: () => boolean, timeoutMs = 750): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}
