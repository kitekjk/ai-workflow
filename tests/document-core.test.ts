import { describe, expect, it } from "vitest";
import { InMemoryDocumentRepository } from "../backend/src/document-core/in-memory-repository";
import { getDocumentCurrentView, getDocumentHistoryView } from "../backend/src/document-core/views";

describe("document-core current and history views", () => {
  it("keeps current artifact pointers separate from immutable history", () => {
    const repository = new InMemoryDocumentRepository();
    const document = repository.createDocument({
      workflowRunId: "run_1",
      type: "prd",
      sourceKey: "PRD-100",
      title: "FAQ Automation PRD",
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    const version1 = repository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1",
      contentHash: "hash-v1",
      now: new Date("2026-05-20T00:01:00.000Z")
    });
    const markdown1 = repository.registerArtifact({
      documentId: document.id,
      documentVersionId: version1.id,
      producerJobId: "job_1",
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md",
      contentHash: "hash-v1",
      now: new Date("2026-05-20T00:02:00.000Z")
    });
    repository.registerArtifact({
      documentId: document.id,
      documentVersionId: version1.id,
      producerJobId: "job_1",
      type: "wiki_page",
      location: "wiki",
      uri: "https://wiki.example.com/prd/PRD-100",
      externalVersion: "1",
      now: new Date("2026-05-20T00:03:00.000Z")
    });

    const version2 = repository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_3",
      contentHash: "hash-v2",
      now: new Date("2026-05-20T00:04:00.000Z")
    });
    const markdown2 = repository.registerArtifact({
      documentId: document.id,
      documentVersionId: version2.id,
      producerJobId: "job_3",
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md",
      contentHash: "hash-v2",
      now: new Date("2026-05-20T00:05:00.000Z")
    });

    const current = repository.getCurrentDocument(document.id);

    expect(current.document.currentVersionId).toBe(version2.id);
    expect(current.document.currentMarkdownArtifactId).toBe(markdown2.id);
    expect(current.currentArtifacts.map((artifact) => artifact.id)).toContain(markdown2.id);
    expect(current.currentArtifacts.map((artifact) => artifact.id)).not.toContain(markdown1.id);
    expect(repository.listDocumentVersions(document.id).map((version) => version.version)).toEqual([1, 2]);
    expect(repository.listArtifactHistory(document.id, "document_markdown").map((artifact) => artifact.id)).toEqual([
      markdown1.id,
      markdown2.id
    ]);
  });

  it("serializes current and history as separate API-ready views", async () => {
    const repository = new InMemoryDocumentRepository();
    const document = repository.createDocument({
      workflowRunId: "run_1",
      type: "prd",
      sourceKey: "PRD-100",
      title: "FAQ Automation PRD"
    });
    const version = repository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1",
      summary: "Initial draft",
      contentHash: "hash-v1"
    });
    repository.registerArtifact({
      documentId: document.id,
      documentVersionId: version.id,
      producerJobId: "job_1",
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md",
      contentHash: "hash-v1"
    });

    await expect(getDocumentCurrentView(repository, document.id)).resolves.toMatchObject({
      documentId: document.id,
      currentVersion: {
        id: version.id,
        version: 1
      },
      currentArtifacts: [
        {
          type: "document_markdown",
          location: "git",
          uri: "https://git.example.com/prds/PRD-100.md"
        }
      ]
    });
    await expect(getDocumentHistoryView(repository, document.id)).resolves.toMatchObject({
      documentId: document.id,
      versions: [{ id: version.id, version: 1 }],
      artifacts: [
        {
          type: "document_markdown",
          location: "git",
          uri: "https://git.example.com/prds/PRD-100.md"
        }
      ]
    });
  });
});
