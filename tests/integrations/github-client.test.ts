import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubRestClient } from "../../backend/src/integrations/github-client";

describe("GitHubRestClient", () => {
  let server: Awaited<ReturnType<typeof createFakeGitHubServer>>;

  beforeEach(async () => {
    server = await createFakeGitHubServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("creates a branch from a base branch and opens a pull request", async () => {
    const client = new GitHubRestClient({
      baseUrl: server.url,
      token: "ghp_secret",
      owner: "acme",
      repo: "workflow-app"
    });

    const branch = await client.createBranch({
      fromBranch: "main",
      branchName: "feature/spec-100"
    });
    const pullRequest = await client.createPullRequest({
      title: "Implement SPEC-100",
      body: "Generated from workflow run run_100.",
      head: "feature/spec-100",
      base: "main",
      draft: true,
      maintainerCanModify: false
    });

    expect(branch).toEqual({
      ref: "refs/heads/feature/spec-100",
      sha: "base-sha"
    });
    expect(pullRequest).toEqual({
      number: 42,
      url: "https://github.com/acme/workflow-app/pull/42",
      state: "open",
      draft: true
    });
    expect(server.requests).toMatchObject([
      {
        method: "GET",
        path: "/repos/acme/workflow-app/git/ref/heads/main",
        authorization: "Bearer ghp_secret"
      },
      {
        method: "POST",
        path: "/repos/acme/workflow-app/git/refs",
        body: {
          ref: "refs/heads/feature/spec-100",
          sha: "base-sha"
        }
      },
      {
        method: "POST",
        path: "/repos/acme/workflow-app/pulls",
        body: {
          title: "Implement SPEC-100",
          body: "Generated from workflow run run_100.",
          head: "feature/spec-100",
          base: "main",
          draft: true,
          maintainer_can_modify: false
        }
      }
    ]);
  });

  it("reads pull request review and check-run status", async () => {
    const client = new GitHubRestClient({
      baseUrl: server.url,
      token: "ghp_secret",
      owner: "acme",
      repo: "workflow-app"
    });

    const status = await client.readPullRequestStatus(42);

    expect(status).toEqual({
      number: 42,
      url: "https://github.com/acme/workflow-app/pull/42",
      state: "open",
      draft: false,
      merged: false,
      branchName: "feature/spec-100",
      baseBranch: "main",
      repositoryCloneUrl: "https://github.com/acme/workflow-app.git",
      latestCommitSha: "head-sha",
      reviewStatus: "approved",
      ciStatus: "success",
      checkRuns: [
        {
          name: "unit",
          status: "completed",
          conclusion: "success",
          url: "https://github.com/acme/workflow-app/actions/runs/1"
        },
        {
          name: "lint",
          status: "completed",
          conclusion: "skipped",
          url: "https://github.com/acme/workflow-app/actions/runs/2"
        }
      ]
    });
    expect(server.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "/repos/acme/workflow-app/pulls/42"],
      ["GET", "/repos/acme/workflow-app/pulls/42/reviews"],
      ["GET", "/repos/acme/workflow-app/commits/head-sha/check-runs"]
    ]);
  });

  it("includes GitHub error responses in failures", async () => {
    server.refStatus = 404;
    const client = new GitHubRestClient({
      baseUrl: server.url,
      token: "ghp_secret",
      owner: "acme",
      repo: "workflow-app"
    });

    await expect(
      client.createBranch({
        fromBranch: "missing",
        branchName: "feature/spec-100"
      })
    ).rejects.toThrow("GitHub ref read failed for heads/missing: HTTP 404");
  });
});

async function createFakeGitHubServer(): Promise<{
  url: string;
  requests: Array<Record<string, any>>;
  refStatus: number;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const state = {
    refStatus: 200
  };
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push({
      method: request.method,
      path,
      authorization: request.headers.authorization,
      apiVersion: request.headers["x-github-api-version"],
      body
    });

    routeFakeGitHub(request.method ?? "GET", path, response, state);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get refStatus() {
      return state.refStatus;
    },
    set refStatus(value: number) {
      state.refStatus = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function routeFakeGitHub(
  method: string,
  path: string,
  response: ServerResponse,
  state: { refStatus: number }
): void {
  if (method === "GET" && path.startsWith("/repos/acme/workflow-app/git/ref/heads/")) {
    if (state.refStatus !== 200) {
      writeJson(response, { message: "Not Found" }, state.refStatus);
      return;
    }

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
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-05-20T01:00:00Z",
        user: {
          login: "alice"
        }
      },
      {
        state: "APPROVED",
        submitted_at: "2026-05-20T02:00:00Z",
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
        },
        {
          name: "lint",
          status: "completed",
          conclusion: "skipped",
          html_url: "https://github.com/acme/workflow-app/actions/runs/2"
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
