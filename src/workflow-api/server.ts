import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { createPrdConfirmationFixture } from "../prd-confirmation/fixture";
import { runRunnerWorkerOnce } from "../prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../prd-confirmation/scheduler";
import { runEngineOnce } from "../prd-confirmation/workflow-engine";

type Fixture = ReturnType<typeof createPrdConfirmationFixture>;

export interface WorkflowApiServer {
  url: string;
  listen(port: number): Promise<WorkflowApiServer>;
  close(): Promise<void>;
}

export function createWorkflowApiServer({ fixture }: { fixture: Fixture }): WorkflowApiServer {
  let baseUrl = "";

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(fixture, request, response);
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  });

  return {
    get url() {
      return baseUrl;
    },

    async listen(port: number) {
      await new Promise<void>((resolve) => {
        server.listen(port, "127.0.0.1", resolve);
      });

      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;

      return this;
    },

    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

async function routeRequest(
  fixture: Fixture,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (method === "POST" && path === "/prd/intake") {
    const body = await readJsonBody<{ prdJiraKey?: string }>(request);
    const prdJiraKey = requireString(body.prdJiraKey, "prdJiraKey");
    const result = await fixture.workflow.intakePrdTicket(prdJiraKey);

    writeJson(response, 202, result);
    return;
  }

  if (method === "POST" && path === "/prd/feedback-revision") {
    const body = await readJsonBody<{
      prdJiraKey?: string;
      requestedBy?: string;
      feedback?: string;
    }>(request);
    const result = await fixture.workflow.requestFeedbackRevision(requireString(body.prdJiraKey, "prdJiraKey"), {
      requestedBy: requireString(body.requestedBy, "requestedBy"),
      feedback: requireString(body.feedback, "feedback")
    });

    writeJson(response, 202, result);
    return;
  }

  if (method === "POST" && path === "/tick") {
    const progressed = [
      await runSchedulerOnce(fixture.store),
      await runRunnerWorkerOnce(fixture.store, fixture.skills),
      await runEngineOnce(fixture.store)
    ].some(Boolean);

    writeJson(response, 200, { progressed });
    return;
  }

  if (method === "POST" && path === "/test-controls/quality") {
    const body = await readJsonBody<{ qualityPasses?: boolean }>(request);
    fixture.skills.qualityPasses = Boolean(body.qualityPasses);
    writeJson(response, 200, { qualityPasses: fixture.skills.qualityPasses });
    return;
  }

  if (method === "GET" && path.startsWith("/state/")) {
    const prdJiraKey = decodeURIComponent(path.slice("/state/".length));

    writeJson(response, 200, summarizeState(fixture, prdJiraKey));
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

function summarizeState(fixture: Fixture, prdJiraKey: string): Record<string, unknown> {
  const workItemIds = fixture.store.workItems
    .filter((workItem) => workItem.primaryJiraKey === prdJiraKey)
    .map((workItem) => workItem.id);

  const jobs = fixture.store.agentJobs
    .filter((job) => workItemIds.includes(job.workItemId))
    .map((job) => ({
      id: job.id,
      type: job.jobType,
      jira: job.primaryJiraKey,
      status: job.status
    }));

  return {
    prdJiraKey,
    prdStatus: fixture.store.externalIssues.get(prdJiraKey)?.status,
    jobs,
    artifacts: fixture.store.artifacts.map((artifact) => ({
      type: artifact.type,
      location: artifact.location,
      url: artifact.url
    })),
    latestResult: fixture.store.agentJobResults.at(-1)?.output ?? null
  };
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function writeJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
