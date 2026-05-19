import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { createWorkflowApiServer, type WorkflowApiServer } from "../src/workflow-api/server";

describe("Workflow API", () => {
  let server: WorkflowApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    server = await createWorkflowApiServer({ fixture }).listen(0);
    baseUrl = server.url;
  });

  afterEach(async () => {
    await server.close();
  });

  it("intakes a planner-owned PRD Jira ticket and exposes workflow state", async () => {
    const intakeResponse = await postJson(`${baseUrl}/prd/intake`, {
      prdJiraKey: "PRD-100"
    });

    expect(intakeResponse.status).toBe(202);
    expect(await intakeResponse.json()).toEqual({ status: "accepted" });

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state).toMatchObject({
      prdJiraKey: "PRD-100",
      prdStatus: "drafting",
      jobs: [
        {
          type: "prd.generate_draft",
          jira: "PRD-100",
          status: "pending"
        }
      ]
    });
  });

  it("runs scheduler, runner, and engine ticks through HTTP", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });

    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state.prdStatus).toBe("needs_revision");
    expect(state.jobs.map((job: { type: string }) => job.type)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality"
    ]);
    expect(state.latestResult).toMatchObject({
      status: "needs_revision",
      missingInformation: ["Success metric is missing"]
    });
  });

  it("accepts explicit feedback revision and reaches approval-ready state", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const feedbackResponse = await postJson(`${baseUrl}/prd/feedback-revision`, {
      prdJiraKey: "PRD-100",
      requestedBy: "planner@example.com",
      feedback: "Add success metric: reduce repeated FAQ handling time by 30%."
    });

    expect(feedbackResponse.status).toBe(202);

    await postJson(`${baseUrl}/test-controls/quality`, { qualityPasses: true });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state).toMatchObject({
      prdStatus: "awaiting_approval"
    });
    expect(state.jobs.map((job: { type: string }) => job.type)).toEqual([
      "prd.generate_draft",
      "prd.evaluate_quality",
      "prd.apply_feedback_revision",
      "prd.evaluate_quality"
    ]);
  });

  it("shows only the latest artifact for each artifact type and location", async () => {
    await postJson(`${baseUrl}/prd/intake`, { prdJiraKey: "PRD-100" });
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/tick`, {});
    await postJson(`${baseUrl}/prd/feedback-revision`, {
      prdJiraKey: "PRD-100",
      requestedBy: "planner@example.com",
      feedback: "Add success metric."
    });
    await postJson(`${baseUrl}/tick`, {});

    const state = await getJson(`${baseUrl}/state/PRD-100`);

    expect(state.artifacts).toEqual([
      {
        type: "prd_markdown",
        location: "git",
        url: "https://git.example.com/prd/prds/PRD-100.md"
      },
      {
        type: "prd_wiki_page",
        location: "wiki",
        url: "https://wiki.example.com/prd/PRD-100"
      }
    ]);
  });

  it("keeps artifact history internally with creation timestamps", async () => {
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const localServer = await createWorkflowApiServer({ fixture }).listen(0);

    try {
      await postJson(`${localServer.url}/prd/intake`, { prdJiraKey: "PRD-100" });
      await postJson(`${localServer.url}/tick`, {});
      await postJson(`${localServer.url}/tick`, {});
      await postJson(`${localServer.url}/prd/feedback-revision`, {
        prdJiraKey: "PRD-100",
        requestedBy: "planner@example.com",
        feedback: "Add success metric."
      });
      await postJson(`${localServer.url}/tick`, {});

      expect(fixture.store.artifacts).toHaveLength(4);
      expect(fixture.store.artifacts.every((artifact) => artifact.createdAt)).toBe(true);
    } finally {
      await localServer.close();
    }
  });
});

async function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);

  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}
