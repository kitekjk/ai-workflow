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
});

async function createFakeJiraServer(): Promise<{
  url: string;
  authorizationHeaders: string[];
  paths: string[];
  close: () => Promise<void>;
}> {
  const authorizationHeaders: string[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    authorizationHeaders.push(String(request.headers.authorization));
    paths.push(new URL(request.url ?? "/", "http://localhost").pathname);
    routeFakeJira(request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    authorizationHeaders,
    paths,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function routeFakeJira(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const key = decodeURIComponent(path.split("/").at(-1) ?? "");

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

function writeJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
