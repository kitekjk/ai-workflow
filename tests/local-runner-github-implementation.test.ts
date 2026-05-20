import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDocumentRepository } from "../src/document-core/in-memory-repository";
import { GitHubRestClient } from "../src/integrations/github-client";
import { GitHubImplementationLocalRunnerEngine } from "../src/local-runner/github-implementation-engine";
import { runLocalRunnerOnce } from "../src/local-runner/local-runner";
import { WorkflowApiRunnerClient } from "../src/local-runner/runner-client";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { InMemoryWorkflowRepository } from "../src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../src/workflow-core/scheduler";
import { createWorkflowApiServer, type WorkflowApiServer } from "../src/workflow-api/server";

const now = new Date("2026-05-20T00:00:00.000Z");

describe("GitHub implementation local runner engine", () => {
  let workflowRepository: InMemoryWorkflowRepository;
  let documentRepository: InMemoryDocumentRepository;
  let apiServer: WorkflowApiServer;
  let githubServer: Awaited<ReturnType<typeof createFakeGitHubServer>>;

  beforeEach(async () => {
    workflowRepository = new InMemoryWorkflowRepository();
    documentRepository = new InMemoryDocumentRepository();
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const scheduler = new WorkflowScheduler(workflowRepository, { leaseMs: 30_000 });

    apiServer = await createWorkflowApiServer({
      fixture,
      scheduler,
      documentRepository
    }).listen(0);
    githubServer = await createFakeGitHubServer();
  });

  afterEach(async () => {
    await apiServer.close();
    await githubServer.close();
  });

  it("opens a GitHub pull request and uploads it as an external artifact", async () => {
    const { document, version } = createSpecImplementationWork({
      jobType: "implementation.open_pr",
      input: {
        documentId: "doc_1",
        documentVersionId: "docv_1",
        branchName: "feature/spec-100",
        baseBranch: "main",
        title: "Implement SPEC-100",
        body: "Generated from workflow run run_1.",
        draft: true
      }
    });

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: apiServer.url }),
      engine: githubEngine(),
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["implementation.open_pr"],
        engines: []
      },
      now
    });

    expect(result).toMatchObject({
      status: "completed",
      result: {
        output: {
          status: "pull_request_opened",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/acme/workflow-app/pull/42"
        }
      }
    });
    expect(documentRepository.artifacts).toMatchObject([
      {
        documentId: document.id,
        documentVersionId: version.id,
        producerJobId: "job_1",
        type: "pull_request",
        location: "external",
        uri: "https://github.com/acme/workflow-app/pull/42",
        externalId: "42",
        externalVersion: "base-sha",
        metadata: {
          provider: "github",
          owner: "acme",
          repo: "workflow-app",
          branchName: "feature/spec-100",
          baseBranch: "main",
          reviewStatus: "pending",
          ciStatus: "pending"
        }
      }
    ]);
    expect(githubServer.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/repos/acme/workflow-app/git/ref/heads/main"],
      ["POST", "/repos/acme/workflow-app/git/refs"],
      ["POST", "/repos/acme/workflow-app/pulls"]
    ]);
  });

  it("collects GitHub PR review and CI status as a new pull request artifact snapshot", async () => {
    const { document, version } = createSpecImplementationWork({
      jobType: "implementation.collect_pr_status",
      input: {
        documentId: "doc_1",
        documentVersionId: "docv_1",
        pullNumber: 42
      }
    });

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: apiServer.url }),
      engine: githubEngine(),
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["implementation.collect_pr_status"],
        engines: []
      },
      now
    });

    expect(result).toMatchObject({
      status: "completed",
      result: {
        output: {
          status: "pull_request_status_collected",
          reviewStatus: "approved",
          ciStatus: "success",
          latestCommitSha: "head-sha"
        }
      }
    });
    expect(documentRepository.artifacts).toMatchObject([
      {
        documentId: document.id,
        documentVersionId: version.id,
        producerJobId: "job_1",
        type: "pull_request",
        location: "external",
        uri: "https://github.com/acme/workflow-app/pull/42",
        externalId: "42",
        externalVersion: "head-sha",
        metadata: {
          reviewStatus: "approved",
          ciStatus: "success",
          checkRuns: [
            {
              name: "unit",
              status: "completed",
              conclusion: "success",
              url: "https://github.com/acme/workflow-app/actions/runs/1"
            }
          ]
        }
      }
    ]);
    expect(githubServer.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/repos/acme/workflow-app/pulls/42"],
      ["GET", "/repos/acme/workflow-app/pulls/42/reviews"],
      ["GET", "/repos/acme/workflow-app/commits/head-sha/check-runs"]
    ]);
  });

  function createSpecImplementationWork(input: {
    jobType: string;
    input: Record<string, unknown>;
  }): {
    document: ReturnType<InMemoryDocumentRepository["createDocument"]>;
    version: ReturnType<InMemoryDocumentRepository["createDocumentVersion"]>;
  } {
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "SPEC-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: input.jobType,
      input: input.input,
      assignedUserId: "dev-a",
      repositoryId: "workflow-app",
      requiredCapabilities: [input.jobType],
      now
    });
    const document = documentRepository.createDocument({
      workflowRunId: run.id,
      type: "spec",
      sourceKey: "SPEC-100",
      title: "SPEC-100",
      now
    });
    const version = documentRepository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1",
      summary: "Implementation spec",
      now
    });

    return { document, version };
  }

  function githubEngine(): GitHubImplementationLocalRunnerEngine {
    return new GitHubImplementationLocalRunnerEngine({
      client: new GitHubRestClient({
        baseUrl: githubServer.url,
        token: "ghp_secret",
        owner: "acme",
        repo: "workflow-app"
      }),
      owner: "acme",
      repo: "workflow-app",
      defaultBaseBranch: "main"
    });
  }
});

async function createFakeGitHubServer(): Promise<{
  url: string;
  requests: Array<Record<string, any>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push({
      method: request.method,
      path,
      authorization: request.headers.authorization,
      body
    });

    routeFakeGitHub(request.method ?? "GET", path, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function routeFakeGitHub(method: string, path: string, response: ServerResponse): void {
  if (method === "GET" && path === "/repos/acme/workflow-app/git/ref/heads/main") {
    writeJson(response, {
      ref: "refs/heads/main",
      object: {
        sha: "base-sha"
      }
    });
    return;
  }

  if (method === "POST" && path === "/repos/acme/workflow-app/git/refs") {
    writeJson(
      response,
      {
        ref: "refs/heads/feature/spec-100",
        object: {
          sha: "base-sha"
        }
      },
      201
    );
    return;
  }

  if (method === "POST" && path === "/repos/acme/workflow-app/pulls") {
    writeJson(
      response,
      {
        number: 42,
        html_url: "https://github.com/acme/workflow-app/pull/42",
        state: "open",
        draft: true,
        head: {
          sha: "head-sha"
        }
      },
      201
    );
    return;
  }

  if (method === "GET" && path === "/repos/acme/workflow-app/pulls/42") {
    writeJson(response, {
      number: 42,
      html_url: "https://github.com/acme/workflow-app/pull/42",
      state: "open",
      draft: false,
      merged: false,
      head: {
        sha: "head-sha"
      }
    });
    return;
  }

  if (method === "GET" && path === "/repos/acme/workflow-app/pulls/42/reviews") {
    writeJson(response, [
      {
        state: "APPROVED",
        submitted_at: "2026-05-20T00:00:00Z",
        user: {
          login: "alice"
        }
      }
    ]);
    return;
  }

  if (method === "GET" && path === "/repos/acme/workflow-app/commits/head-sha/check-runs") {
    writeJson(response, {
      check_runs: [
        {
          name: "unit",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/acme/workflow-app/actions/runs/1"
        }
      ]
    });
    return;
  }

  writeJson(response, { message: "Not Found" }, 404);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
