import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDocumentRepository } from "../src/document-core/in-memory-repository";
import { GitHubRestClient } from "../src/integrations/github-client";
import {
  GitHubImplementationLocalRunnerEngine,
  ImplementationPullRequestLocalRunnerEngine,
  ImplementationUpdateLocalRunnerEngine
} from "../src/local-runner/github-implementation-engine";
import { runLocalRunnerOnce, type LocalRunnerEngine } from "../src/local-runner/local-runner";
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
  const cleanupRoots: string[] = [];

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
    await Promise.all(cleanupRoots.map((root) => rm(root, { recursive: true, force: true })));
    cleanupRoots.length = 0;
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

  it("runs initial implementation in a checked-out branch before opening the pull request", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-open-pr-workspace-"));
    const implementationRepo = await createImplementationRepositoryFixture();
    cleanupRoots.push(workspaceRoot, implementationRepo.repoPath);
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
    let implementationSawCheckout = false;
    const cliEngine: LocalRunnerEngine = {
      async run({ job, workspaceDir }) {
        const implementationDir = join(workspaceDir ?? "", "implementation");
        implementationSawCheckout = (await readFile(join(implementationDir, "README.md"), "utf8")).includes(
          "Implementation Repo"
        );
        expect(job.input).toMatchObject({
          repositoryCloneUrl: implementationRepo.repoPath,
          branchName: "feature/spec-100",
          runnerJobTemplate: {
            runner: {
              sandbox: "workspace-write",
              workdir: "implementation"
            }
          }
        });
        await writeFile(join(implementationDir, "feature.txt"), "implemented\n");
        execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: implementationDir });
        execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: implementationDir });
        execFileSync("git", ["add", "feature.txt"], { cwd: implementationDir });
        execFileSync("git", ["commit", "-m", "implement spec 100"], { cwd: implementationDir });
        const latestCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: implementationDir })
          .toString()
          .trim();

        return {
          output: {
            status: "implemented",
            latestCommitSha,
            summary: "Implemented SPEC-100"
          }
        };
      }
    };

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: apiServer.url }),
      engine: new ImplementationPullRequestLocalRunnerEngine({
        client: githubClient(),
        cliEngine,
        owner: "acme",
        repo: "workflow-app",
        repositoryCloneUrl: implementationRepo.repoPath,
        defaultBaseBranch: "main"
      }),
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["implementation.open_pr"],
        engines: ["codex"],
        defaultEngine: "codex"
      },
      workspace: {
        rootDir: workspaceRoot
      },
      now
    });

    expect(implementationSawCheckout).toBe(true);
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
    const pushedSha = execFileSync("git", ["rev-parse", "feature/spec-100"], {
      cwd: implementationRepo.repoPath
    }).toString().trim();
    expect(result.status === "completed" ? result.result.output.latestCommitSha : undefined).toBe(pushedSha);
    expect(
      execFileSync("git", ["show", "feature/spec-100:feature.txt"], { cwd: implementationRepo.repoPath })
        .toString()
        .replace(/\r\n/g, "\n")
    ).toBe("implemented\n");
    expect(documentRepository.artifacts).toMatchObject([
      {
        documentId: document.id,
        documentVersionId: version.id,
        producerJobId: "job_1",
        type: "pull_request",
        location: "external",
        uri: "https://github.com/acme/workflow-app/pull/42",
        externalVersion: pushedSha,
        metadata: {
          repositoryCloneUrl: implementationRepo.repoPath,
          branchName: "feature/spec-100",
          implementationSummary: "Implemented SPEC-100"
        }
      }
    ]);
    expect(githubServer.requests.map((request) => [request.method, request.path])).toEqual([
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
          branchName: "feature/spec-100",
          baseBranch: "main",
          repositoryCloneUrl: "https://github.com/acme/workflow-app.git",
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

  it("pushes implementation update commits after CLI rework", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-update-pr-workspace-"));
    const implementationRepo = await createImplementationRepositoryFixture();
    cleanupRoots.push(workspaceRoot, implementationRepo.repoPath);
    execFileSync("git", ["checkout", "-b", "feature/spec-100"], { cwd: implementationRepo.repoPath });
    await writeFile(join(implementationRepo.repoPath, "feature.txt"), "before rework\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: implementationRepo.repoPath });
    execFileSync("git", ["commit", "-m", "seed feature branch"], { cwd: implementationRepo.repoPath });
    execFileSync("git", ["checkout", "main"], { cwd: implementationRepo.repoPath });
    createSpecImplementationWork({
      jobType: "implementation.update_pr",
      input: {
        documentId: "doc_1",
        documentVersionId: "docv_1",
        pullNumber: 42,
        pullRequestUrl: "https://github.com/acme/workflow-app/pull/42",
        repositoryCloneUrl: implementationRepo.repoPath,
        branchName: "feature/spec-100",
        runnerJobTemplate: {
          runner: {
            workdir: "implementation",
            sandbox: "workspace-write"
          }
        }
      }
    });
    const cliEngine: LocalRunnerEngine = {
      async run({ workspaceDir }) {
        const implementationDir = join(workspaceDir ?? "", "implementation");
        expect((await readFile(join(implementationDir, "feature.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe(
          "before rework\n"
        );
        await writeFile(join(implementationDir, "feature.txt"), "after rework\n");
        execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: implementationDir });
        execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: implementationDir });
        execFileSync("git", ["add", "feature.txt"], { cwd: implementationDir });
        execFileSync("git", ["commit", "-m", "fix implementation branch"], { cwd: implementationDir });

        return {
          output: {
            status: "succeeded",
            pullRequestNumber: 42,
            pullRequestUrl: "https://github.com/acme/workflow-app/pull/42",
            summary: "Fixed implementation branch"
          }
        };
      }
    };

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: apiServer.url }),
      engine: new ImplementationUpdateLocalRunnerEngine({ cliEngine }),
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["implementation.update_pr"],
        engines: ["codex"],
        defaultEngine: "codex"
      },
      workspace: {
        rootDir: workspaceRoot
      },
      now
    });

    const pushedSha = execFileSync("git", ["rev-parse", "feature/spec-100"], {
      cwd: implementationRepo.repoPath
    }).toString().trim();
    expect(result).toMatchObject({
      status: "completed",
      result: {
        output: {
          status: "succeeded",
          pullRequestNumber: 42,
          latestCommitSha: pushedSha
        }
      }
    });
    expect(
      execFileSync("git", ["show", "feature/spec-100:feature.txt"], { cwd: implementationRepo.repoPath })
        .toString()
        .replace(/\r\n/g, "\n")
    ).toBe("after rework\n");
  });

  it("marks collected PR status as document revision-required when reviews request changes", async () => {
    const engine = new GitHubImplementationLocalRunnerEngine({
      client: {
        createBranch: async () => ({ ref: "refs/heads/unused", sha: "unused" }),
        createPullRequest: async () => ({
          number: 1,
          url: "https://github.com/acme/workflow-app/pull/1",
          state: "open",
          draft: true
        }),
        readPullRequestStatus: async () => ({
          number: 42,
          url: "https://github.com/acme/workflow-app/pull/42",
          state: "open",
          draft: false,
          merged: false,
          latestCommitSha: "head-sha",
          reviewStatus: "changes_requested",
          ciStatus: "failure",
          checkRuns: [
            {
              name: "unit",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/acme/workflow-app/actions/runs/1"
            }
          ]
        })
      },
      owner: "acme",
      repo: "workflow-app"
    });

    const result = await engine.run({
      runner: {} as never,
      job: {
        id: "job_status",
        runId: "run_1",
        jobType: "implementation.collect_pr_status",
        status: "running",
        input: {
          pullNumber: 42
        },
        priority: 0,
        requiredCapabilities: ["implementation.collect_pr_status"],
        executionPolicy: "local_allowed",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z"
      }
    });

    expect(result.output).toMatchObject({
      revisionRequired: true,
      reworkRequired: false,
      failureScope: "document",
      reviewStatus: "changes_requested",
      ciStatus: "failure",
      feedback: expect.stringContaining("Failing checks: unit")
    });
  });

  it("marks collected PR status as code rework-required when only checks fail", async () => {
    const engine = new GitHubImplementationLocalRunnerEngine({
      client: {
        createBranch: async () => ({ ref: "refs/heads/unused", sha: "unused" }),
        createPullRequest: async () => ({
          number: 1,
          url: "https://github.com/acme/workflow-app/pull/1",
          state: "open",
          draft: true
        }),
        readPullRequestStatus: async () => ({
          number: 42,
          url: "https://github.com/acme/workflow-app/pull/42",
          state: "open",
          draft: false,
          merged: false,
          latestCommitSha: "head-sha",
          reviewStatus: "approved",
          ciStatus: "failure",
          checkRuns: [
            {
              name: "unit",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/acme/workflow-app/actions/runs/1"
            }
          ]
        })
      },
      owner: "acme",
      repo: "workflow-app"
    });

    const result = await engine.run({
      runner: {} as never,
      job: {
        id: "job_status",
        runId: "run_1",
        jobType: "implementation.collect_pr_status",
        status: "running",
        input: {
          pullNumber: 42
        },
        priority: 0,
        requiredCapabilities: ["implementation.collect_pr_status"],
        executionPolicy: "local_allowed",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z"
      }
    });

    expect(result.output).toMatchObject({
      revisionRequired: false,
      reworkRequired: true,
      failureScope: "implementation",
      reviewStatus: "approved",
      ciStatus: "failure",
      feedback: expect.stringContaining("code update")
    });
  });

  it("does not request revision or rework after the PR has already merged", async () => {
    const engine = new GitHubImplementationLocalRunnerEngine({
      client: {
        createBranch: async () => ({ ref: "refs/heads/unused", sha: "unused" }),
        createPullRequest: async () => ({
          number: 1,
          url: "https://github.com/acme/workflow-app/pull/1",
          state: "open",
          draft: true
        }),
        readPullRequestStatus: async () => ({
          number: 42,
          url: "https://github.com/acme/workflow-app/pull/42",
          state: "closed",
          draft: false,
          merged: true,
          latestCommitSha: "merged-sha",
          reviewStatus: "changes_requested",
          ciStatus: "failure",
          checkRuns: [
            {
              name: "unit",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/acme/workflow-app/actions/runs/1"
            }
          ]
        })
      },
      owner: "acme",
      repo: "workflow-app"
    });

    const result = await engine.run({
      runner: {} as never,
      job: {
        id: "job_status",
        runId: "run_1",
        jobType: "implementation.collect_pr_status",
        status: "running",
        input: {
          pullNumber: 42
        },
        priority: 0,
        requiredCapabilities: ["implementation.collect_pr_status"],
        executionPolicy: "local_allowed",
        createdAt: "2026-05-20T00:00:00.000Z",
        updatedAt: "2026-05-20T00:00:00.000Z"
      }
    });

    expect(result.output).toMatchObject({
      merged: true,
      revisionRequired: false,
      reworkRequired: false,
      reviewStatus: "changes_requested",
      ciStatus: "failure"
    });
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
      client: githubClient(),
      owner: "acme",
      repo: "workflow-app",
      defaultBaseBranch: "main"
    });
  }

  function githubClient(): GitHubRestClient {
    return new GitHubRestClient({
      baseUrl: githubServer.url,
      token: "ghp_secret",
      owner: "acme",
      repo: "workflow-app"
    });
  }
});

async function createImplementationRepositoryFixture(): Promise<{
  repoPath: string;
}> {
  const repoPath = await mkdtemp(join(tmpdir(), "ai-workflow-implementation-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: repoPath });
  await writeFile(join(repoPath, "README.md"), "# Implementation Repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });

  return { repoPath };
}

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
        sha: "head-sha",
        ref: "feature/spec-100",
        repo: {
          clone_url: "https://github.com/acme/workflow-app.git",
          full_name: "acme/workflow-app"
        }
      },
      base: {
        ref: "main"
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
