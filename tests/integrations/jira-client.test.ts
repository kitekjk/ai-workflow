import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JiraRestClient } from "../../src/integrations/jira-client";

describe("JiraRestClient", () => {
  let server: Awaited<ReturnType<typeof createFakeJiraServer>>;

  beforeEach(async () => {
    server = await createFakeJiraServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("loads a PRD issue and linked operational request issues", async () => {
    const client = new JiraRestClient({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      apiVersion: "3",
      authMode: "basic"
    });

    const result = await client.loadPrdWithSources("PRD-100");

    expect(server.authorizationHeaders).toEqual([
      "Basic Ym90QGV4YW1wbGUuY29tOnNlY3JldA==",
      "Basic Ym90QGV4YW1wbGUuY29tOnNlY3JldA==",
      "Basic Ym90QGV4YW1wbGUuY29tOnNlY3JldA=="
    ]);
    expect(server.paths).toEqual([
      "/rest/api/3/issue/PRD-100",
      "/rest/api/3/issue/OPS-1",
      "/rest/api/3/issue/OPS-2"
    ]);
    expect(result.prd).toMatchObject({
      key: "PRD-100",
      issueType: "prd",
      summary: "FAQ automation PRD",
      linkedSourceKeys: ["OPS-1", "OPS-2"]
    });
    expect(result.sources).toMatchObject([
      {
        key: "OPS-1",
        issueType: "operational_request",
        summary: "Reduce repeated FAQ handling"
      },
      {
        key: "OPS-2",
        issueType: "operational_request",
        summary: "Improve answer consistency"
      }
    ]);
  });

  it("supports Jira Server/Data Center style bearer auth and API v2", async () => {
    const client = new JiraRestClient({
      baseUrl: server.url,
      apiToken: "server-pat",
      apiVersion: "2",
      authMode: "bearer"
    });

    await client.loadPrdWithSources("PRD-100");

    expect(server.authorizationHeaders).toEqual([
      "Bearer server-pat",
      "Bearer server-pat",
      "Bearer server-pat"
    ]);
    expect(server.paths).toEqual([
      "/rest/api/2/issue/PRD-100",
      "/rest/api/2/issue/OPS-1",
      "/rest/api/2/issue/OPS-2"
    ]);
  });

  it("writes workflow fields, comments, and transitions to Jira", async () => {
    const client = new JiraRestClient({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      apiVersion: "3",
      authMode: "basic",
      writebackFieldIds: {
        workflowRunId: "customfield_10010",
        currentArtifactUrl: "customfield_10011",
        gateStatus: "customfield_10012",
        qualityScore: "customfield_10013"
      },
      transitionIds: {
        approved: "31"
      }
    });

    const result = await client.writeWorkflowStatus({
      issueKey: "PRD-100",
      workflowRunId: "run_1",
      currentArtifactUrl: "https://git.example.com/prd/PRD-100.md",
      gateStatus: "approved",
      qualityScore: 91,
      comment: "Workflow run run_1 reached approved gate status.",
      transition: "approved"
    });

    expect(result).toEqual({
      fieldsUpdated: ["customfield_10010", "customfield_10011", "customfield_10012", "customfield_10013"],
      commentCreated: true,
      transitioned: true
    });
    expect(server.requests).toMatchObject([
      {
        method: "PUT",
        path: "/rest/api/3/issue/PRD-100",
        body: {
          fields: {
            customfield_10010: "run_1",
            customfield_10011: "https://git.example.com/prd/PRD-100.md",
            customfield_10012: "approved",
            customfield_10013: 91
          }
        }
      },
      {
        method: "POST",
        path: "/rest/api/3/issue/PRD-100/comment",
        body: {
          body: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Workflow run run_1 reached approved gate status."
                  }
                ]
              }
            ]
          }
        }
      },
      {
        method: "POST",
        path: "/rest/api/3/issue/PRD-100/transitions",
        body: {
          transition: {
            id: "31"
          }
        }
      }
    ]);
  });

  it("requires explicit Jira custom field ids before writing workflow fields", async () => {
    const client = new JiraRestClient({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      apiVersion: "3",
      authMode: "basic"
    });

    await expect(
      client.writeWorkflowStatus({
        issueKey: "PRD-100",
        workflowRunId: "run_1"
      })
    ).rejects.toThrow("Jira writeback field id is not configured for workflowRunId");
    expect(server.requests).toEqual([]);
  });
});

async function createFakeJiraServer(): Promise<{
  url: string;
  authorizationHeaders: string[];
  paths: string[];
  requests: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}> {
  const authorizationHeaders: string[] = [];
  const paths: string[] = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    authorizationHeaders.push(String(request.headers.authorization));
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const body = await readJsonBody(request);

    paths.push(path);

    if (request.method !== "GET") {
      requests.push({
        method: request.method ?? "GET",
        path,
        body
      });
    }

    routeFakeJira(request.method ?? "GET", path, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    authorizationHeaders,
    paths,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function routeFakeJira(method: string, path: string, response: ServerResponse): void {
  if (method === "PUT" && path === "/rest/api/3/issue/PRD-100") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (method === "POST" && path === "/rest/api/3/issue/PRD-100/comment") {
    writeJson(response, { id: "comment-1" }, 201);
    return;
  }

  if (method === "POST" && path === "/rest/api/3/issue/PRD-100/transitions") {
    response.writeHead(204);
    response.end();
    return;
  }

  const key = issueKeyForPath(path);

  if (key === "PRD-100") {
    writeJson(response, {
      key,
      fields: {
        summary: "FAQ automation PRD",
        description: "Container ticket",
        issuetype: { name: "Initiative" },
        status: { name: "PRD Requested" },
        issuelinks: [
          { outwardIssue: { key: "OPS-1" } },
          { outwardIssue: { key: "OPS-2" } }
        ]
      }
    });
    return;
  }

  if (key === "OPS-1") {
    writeJson(response, {
      key,
      fields: {
        summary: "Reduce repeated FAQ handling",
        description: "Operations wants fewer repeated FAQ responses.",
        issuetype: { name: "Task" },
        status: { name: "Open" },
        issuelinks: []
      }
    });
    return;
  }

  if (key === "OPS-2") {
    writeJson(response, {
      key,
      fields: {
        summary: "Improve answer consistency",
        description: "Operators need consistent answers for common customer questions.",
        issuetype: { name: "Task" },
        status: { name: "Open" },
        issuelinks: []
      }
    });
    return;
  }

  writeJson(response, { error: "not found" }, 404);
}

function issueKeyForPath(path: string): string {
  const parts = path.split("/");
  const issueIndex = parts.indexOf("issue");
  return issueIndex >= 0 ? decodeURIComponent(parts[issueIndex + 1] ?? "") : "";
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
