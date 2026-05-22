import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfluenceWikiPublisher } from "../../backend/src/integrations/confluence-wiki";

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

  it("routes each document type to its configured Confluence parent page", async () => {
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "DOCS",
      parentPageId: "root-parent",
      parentPageIdByDocumentType: {
        prd: "111",
        hld: "https://wiki.example.com/wiki/spaces/DOCS/pages/222/HLD",
        lld: "333",
        spec: "444"
      }
    });

    await publisher.publishMarkdownPage({
      documentType: "hld",
      sourceKey: "PRD-100-HLD-1",
      title: "PRD-100-HLD-1 HLD",
      markdown: "# HLD"
    });
    await publisher.publishMarkdownPage({
      documentType: "lld",
      sourceKey: "PRD-100-HLD-1-LLD-1",
      title: "PRD-100-HLD-1-LLD-1 LLD",
      markdown: "# LLD"
    });
    await publisher.publishMarkdownPage({
      documentType: "adr",
      sourceKey: "ADR-1",
      title: "ADR-1",
      markdown: "# ADR"
    });

    expect(server.requests.map((request) => request.body.ancestors)).toEqual([
      [{ id: "222" }],
      [{ id: "333" }],
      [{ id: "root-parent" }]
    ]);
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

  it("retries an existing page update with the latest version after a version conflict", async () => {
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
    server.latestExistingPage = {
      id: "999",
      title: "PRD-100 FAQ automation",
      version: { number: 4 },
      _links: {
        webui: "/wiki/spaces/PRD/pages/999"
      }
    };
    server.nextPutStatus = 409;
    server.nextPutBody = {
      message: "Version conflict: current version is newer"
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
      ["PUT", "/wiki/rest/api/content/999"],
      ["GET", "/wiki/rest/api/content"],
      ["PUT", "/wiki/rest/api/content/999"]
    ]);
    expect(server.requests[2].body.version).toEqual({ number: 4 });
    expect(server.requests[4].body.version).toEqual({ number: 5 });
  });

  it("collects footer and open inline comments from a Confluence page", async () => {
    server.footerComments = [
      {
        id: "c-1",
        pageId: "999",
        title: "Footer comment",
        version: {
          createdAt: "2026-05-20T08:00:00.000Z",
          authorId: "account-1"
        },
        body: {
          storage: {
            value: "<p>Add the rollout KPI.</p>"
          }
        },
        _links: {
          webui: "/wiki/spaces/PRD/pages/999?focusedCommentId=c-1"
        }
      }
    ];
    server.inlineComments = [
      {
        id: "ic-1",
        pageId: "999",
        title: "Inline comment",
        version: {
          createdAt: "2026-05-20T08:05:00.000Z",
          authorId: "account-2"
        },
        body: {
          storage: {
            value: "<p>Clarify edge cases.</p>"
          }
        },
        resolutionStatus: "open",
        properties: {
          inlineOriginalSelection: "Acceptance criteria"
        },
        _links: {
          webui: "/wiki/spaces/PRD/pages/999?focusedCommentId=ic-1"
        }
      }
    ];
    const publisher = new ConfluenceWikiPublisher({
      baseUrl: server.url,
      email: "bot@example.com",
      apiToken: "secret",
      spaceKey: "PRD",
      parentPageId: "123"
    });

    const result = await publisher.collectPageFeedback({
      pageUrl: `${server.url}/wiki/spaces/PRD/pages/999/Page+Title`
    });

    expect(result).toMatchObject({
      pageId: "999",
      comments: [
        {
          externalId: "confluence-comment:c-1",
          author: "account-1",
          body: "Add the rollout KPI.",
          createdAt: "2026-05-20T08:00:00.000Z",
          url: `${server.url}/wiki/spaces/PRD/pages/999?focusedCommentId=c-1`
        },
        {
          externalId: "confluence-comment:ic-1",
          author: "account-2",
          body: "Selection: Acceptance criteria\nComment: Clarify edge cases.",
          createdAt: "2026-05-20T08:05:00.000Z",
          url: `${server.url}/wiki/spaces/PRD/pages/999?focusedCommentId=ic-1`,
          metadata: {
            resolutionStatus: "open"
          }
        }
      ]
    });
    expect(server.requests.slice(-2).map((request) => [request.method, request.path])).toEqual([
      ["GET", "/wiki/api/v2/pages/999/footer-comments"],
      ["GET", "/wiki/api/v2/pages/999/inline-comments"]
    ]);
    expect(server.requests.at(-1)?.query).toMatchObject({
      "body-format": "storage",
      "resolution-status": "open",
      status: "current"
    });
  });
});

async function createFakeConfluenceServer(): Promise<{
  url: string;
  requests: Array<Record<string, any>>;
  nextStatus: number;
  nextBody: unknown;
  nextPutStatus: number;
  nextPutBody: unknown;
  existingPage?: any;
  latestExistingPage?: any;
  footerComments: any[];
  inlineComments: any[];
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
    existingPage: undefined as any,
    latestExistingPage: undefined as any,
    nextPutStatus: 200,
    nextPutBody: undefined as unknown,
    footerComments: [] as any[],
    inlineComments: [] as any[],
    searchCount: 0
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
      state.searchCount += 1;
      const page = state.searchCount > 1 ? state.latestExistingPage ?? state.existingPage : state.existingPage;
      writeJson(response, { results: page ? [page] : [] });
      return;
    }

    if (request.method === "PUT" && url.pathname.startsWith("/wiki/rest/api/content/")) {
      if (state.nextPutStatus !== 200) {
        const statusCode = state.nextPutStatus;
        const body = state.nextPutBody ?? state.nextBody;
        state.nextPutStatus = 200;
        state.nextPutBody = undefined;
        writeJson(response, body, statusCode);
        return;
      }

      writeJson(response, state.latestExistingPage ?? state.existingPage ?? state.nextBody);
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/footer-comments")) {
      writeJson(response, { results: state.footerComments, _links: {} });
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/inline-comments")) {
      writeJson(response, { results: state.inlineComments, _links: {} });
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
    get nextPutStatus() {
      return state.nextPutStatus;
    },
    set nextPutStatus(value: number) {
      state.nextPutStatus = value;
    },
    get nextPutBody() {
      return state.nextPutBody;
    },
    set nextPutBody(value: unknown) {
      state.nextPutBody = value;
    },
    get existingPage() {
      return state.existingPage;
    },
    set existingPage(value: any) {
      state.existingPage = value;
    },
    get latestExistingPage() {
      return state.latestExistingPage;
    },
    set latestExistingPage(value: any) {
      state.latestExistingPage = value;
    },
    get footerComments() {
      return state.footerComments;
    },
    set footerComments(value: any[]) {
      state.footerComments = value;
    },
    get inlineComments() {
      return state.inlineComments;
    },
    set inlineComments(value: any[]) {
      state.inlineComments = value;
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
