import { describe, expect, it } from "vitest";
import type { DocumentRepository } from "../src/document-core/repository";
import { getDocumentCurrentView } from "../src/document-core/views";
import { InMemoryDocumentRepository } from "../src/document-core/in-memory-repository";
import type { WorkflowRepository } from "../src/workflow-core/repository";
import { InMemoryWorkflowRepository } from "../src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../src/workflow-core/scheduler";

describe("repository contracts", () => {
  it("lets the scheduler depend on the workflow repository interface", async () => {
    const repository: WorkflowRepository = new InMemoryWorkflowRepository();
    const scheduler = new WorkflowScheduler(repository, { leaseMs: 10_000 });
    const now = new Date("2026-05-20T00:00:00.000Z");
    const run = await repository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    await repository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      now
    });

    await scheduler.registerRunner({
      id: "runner-planner-a",
      ownerUserId: "planner-a",
      mode: "local",
      capabilities: ["document.generate"],
      engines: ["claude"],
      now
    });

    expect((await scheduler.claim("runner-planner-a", now))?.job.id).toBe("job_1");
  });

  it("lets current/history views depend on the document repository interface", async () => {
    const repository: DocumentRepository = new InMemoryDocumentRepository();
    const document = await repository.createDocument({
      workflowRunId: "run_1",
      type: "prd",
      sourceKey: "PRD-100",
      title: "PRD-100"
    });
    const version = await repository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1"
    });
    await repository.registerArtifact({
      documentId: document.id,
      documentVersionId: version.id,
      producerJobId: "job_1",
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md"
    });

    await expect(getDocumentCurrentView(repository, document.id)).resolves.toMatchObject({
      documentId: "doc_1",
      currentVersion: {
        id: "docv_1"
      },
      currentArtifacts: [
        {
          id: "art_1",
          type: "document_markdown"
        }
      ]
    });
  });
});
