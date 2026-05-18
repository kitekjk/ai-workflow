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
});

async function createFakeConfluenceServer(): Promise<{
  url: string;
  requests: Array<Record<string, any>>;
  nextStatus: number;
  nextBody: unknown;
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
    } as unknown
  };
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method,
      path: new URL(request.url ?? "/", "http://localhost").pathname,
      authorization: request.headers.authorization,
      body
    });
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
