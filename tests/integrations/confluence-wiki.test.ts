import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfluenceWikiPublisher } from "../../src/integrations/confluence-wiki";

describe("ConfluenceWikiPublisher", () => {
  let server: Awaited<ReturnType<typeof createFakeConfluenceServer>>;

  beforeEach(async () => {
    server = await createFakeConfluenceServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("publishes PRD markdown as a Confluence page under the configured parent", async () => {
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "123"
    });

    const result = await publisher.publishPrd({
      jiraKey: "PRD-100",
      title: "PRD-100 FAQ automation",
      markdown: "# PRD-100\n\nGenerated content."
    });

    expect(result).toEqual({
      type: "prd_wiki_page",
      location: "wiki",
      url: `${server.url}/wiki/spaces/PRD/pages/999`
    });
    expect(server.requests).toMatchObject([
      {
        method: "POST",
        path: "/wiki/rest/api/content",
        authorization: "Basic Ym90QGV4YW1wbGUuY29tOnNlY3JldA==",
        body: {
          type: "page",
          title: "PRD-100 FAQ automation",
          space: { key: "PRD" },
          ancestors: [{ id: "123" }]
        }
      }
    ]);
    expect(server.requests[0].body.body.storage.value).toContain("<h1>PRD-100</h1>");
  });

  it("publishes generic markdown documents as Confluence pages", async () => {
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "DOCS",
      parentPageId: "456"
    });

    const result = await publisher.publishMarkdownPage({
      documentType: "hld",
      sourceKey: "PAIR-2",
      title: "PAIR-2 Generated HLD",
      markdown: "# HLD\n\n## Architecture"
    });

    expect(result).toEqual({
      type: "wiki_page",
      documentType: "hld",
      location: "wiki",
      url: `${server.url}/wiki/spaces/PRD/pages/999`
    });
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/wiki/rest/api/content",
      body: {
        type: "page",
        title: "PAIR-2 Generated HLD",
        space: { key: "DOCS" },
        ancestors: [{ id: "456" }]
      }
    });
    expect(server.requests[0].body.body.storage.value).toContain("<h2>Architecture</h2>");
  });

  it("converts markdown section headings to Confluence heading elements", async () => {
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "123"
    });

    await publisher.publishPrd({
      jiraKey: "PRD-100",
      title: "PRD-100 FAQ automation",
      markdown: "# PRD-100\n\n## 1. 개요\n\n### 1.1 배경"
    });

    expect(server.requests[0].body.body.storage.value).toContain("<h1>PRD-100</h1>");
    expect(server.requests[0].body.body.storage.value).toContain("<h2>1. 개요</h2>");
    expect(server.requests[0].body.body.storage.value).toContain("<h3>1.1 배경</h3>");
  });

  it("converts heading lines even when the next paragraph is not separated by a blank line", async () => {
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "123"
    });

    await publisher.publishPrd({
      jiraKey: "PRD-100",
      title: "PRD-100 FAQ automation",
      markdown: "# PRD-100\n\n## 1. 개요\n- 첫 번째 항목\n- 두 번째 항목"
    });

    const storage = server.requests[0].body.body.storage.value;
    expect(storage).toContain("<h2>1. 개요</h2>");
    expect(storage).not.toContain("## 1. 개요");
  });

  it("accepts a full Confluence page URL as parent page id input", async () => {
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "https://wiki.example.com/wiki/spaces/PRD/pages/123456/Page+Title"
    });

    await publisher.publishPrd({
      jiraKey: "PRD-100",
      title: "PRD-100 FAQ automation",
      markdown: "# PRD-100\n\nGenerated content."
    });

    expect(server.requests[0].body.ancestors).toEqual([{ id: "123456" }]);
  });

  it("includes the Confluence error body when page creation fails", async () => {
    server.nextStatus = 400;
    server.nextBody = {
      message: "Could not create content with type page"
    };
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "bad-parent"
    });

    await expect(
      publisher.publishPrd({
        jiraKey: "PRD-100",
        title: "PRD-100 FAQ automation",
        markdown: "# PRD-100\n\nGenerated content."
      })
    ).rejects.toThrow("Could not create content with type page");
  });

  it("updates an existing PRD page when Confluence rejects duplicate titles", async () => {
    server.nextStatus = 400;
    server.nextBody = {
      message:
        "com.atlassian.confluence.api.service.exceptions.api.BadRequestException: A page with this title already exists"
    };
    server.existingPage = {
      id: "999",
      title: "PRD-100 FAQ automation",
      version: { number: 3 },
      _links: {
        webui: "/wiki/spaces/PRD/pages/999"
      }
    };
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "123"
    });

    const result = await publisher.publishPrd({
      jiraKey: "PRD-100",
      title: "PRD-100 FAQ automation",
      markdown: "# PRD-100\n\nUpdated generated content."
    });

    expect(result.url).toBe(`${server.url}/wiki/spaces/PRD/pages/999`);
    expect(server.requests.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/wiki/rest/api/content"],
      ["GET", "/wiki/rest/api/content"],
      ["PUT", "/wiki/rest/api/content/999"]
    ]);
    expect(server.requests[1].query).toMatchObject({
      spaceKey: "PRD",
      title: "PRD-100 FAQ automation",
      expand: "version,_links"
    });
    expect(server.requests[2].body).toMatchObject({
      id: "999",
      type: "page",
      title: "PRD-100 FAQ automation",
      version: { number: 4 }
    });
    expect(server.requests[2].body.body.storage.value).toContain("Updated generated content.");
  });
});

async function createFakeConfluenceServer(): Promise<{
  url: string;
  requests: Array<Record<string, any>>;
  nextStatus: number;
  nextBody: unknown;
  existingPage?: any;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, any>> = [];
  const state = {
    nextStatus: 200,
    nextBody: {
      id: "999",
      _links: {
        webui: "/wiki/spaces/PRD/pages/999"
      }
    } as unknown,
    existingPage: undefined as any
  };
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
      body
    });

    if (request.method === "GET" && url.pathname === "/wiki/rest/api/content") {
      writeJson(response, { results: state.existingPage ? [state.existingPage] : [] });
      return;
    }

    if (request.method === "PUT" && url.pathname.startsWith("/wiki/rest/api/content/")) {
      writeJson(response, state.existingPage ?? state.nextBody);
      return;
    }

    writeJson(response, state.nextBody, state.nextStatus);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get nextStatus() {
      return state.nextStatus;
    },
    set nextStatus(value: number) {
      state.nextStatus = value;
    },
    get nextBody() {
      return state.nextBody;
    },
    set nextBody(value: unknown) {
      state.nextBody = value;
    },
    get existingPage() {
      return state.existingPage;
    },
    set existingPage(value: any) {
      state.existingPage = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function readBody(request: IncomingMessage): Promise<any> {
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
