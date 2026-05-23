import { describe, test, expect, beforeEach } from "vitest";
import { InMemoryWorkflowDefinitionRepository } from "../../backend/src/workflow-definition/in-memory-repository";
import type { WorkflowDefinitionRecord } from "../../backend/src/workflow-definition/repository";

function makeRecord(id: string, version: number, documentType: string = "prd"): WorkflowDefinitionRecord {
  return {
    definition: {
      id,
      version,
      name: `${id} v${version}`,
      documentTypes: [documentType as never],
      entryStage: "start",
      policy: {
        approvalSource: "jira_status",
        qualityFailureAction: "human_clarification",
        revisionTrigger: "explicit_request",
        feedbackSources: ["app"]
      },
      stages: {
        start: { label: "Start", jobTemplate: { jobType: "prd.generate_draft" as never, runner: { requiredCapability: "x" } }, on: { success: "end" } },
        end: { type: "terminal", kind: "completed" }
      }
    },
    sourcePath: `workflows/definitions/${id}.v${version}.yaml`,
    sourceHash: `hash-${id}-${version}`,
    status: "active",
    importedAt: "2026-05-23T00:00:00.000Z"
  };
}

describe("WorkflowDefinitionRepository contract (in-memory)", () => {
  let repo: InMemoryWorkflowDefinitionRepository;

  beforeEach(() => {
    repo = new InMemoryWorkflowDefinitionRepository();
  });

  test("upsert + findByIdAndVersion", async () => {
    const r = makeRecord("prd-confirmation", 1);
    await repo.upsert(r);
    const fetched = await repo.findByIdAndVersion("prd-confirmation", 1);
    expect(fetched?.definition.id).toBe("prd-confirmation");
    expect(fetched?.definition.version).toBe(1);
  });

  test("findActiveById returns the highest active version", async () => {
    await repo.upsert(makeRecord("prd-confirmation", 1));
    await repo.upsert(makeRecord("prd-confirmation", 2));
    const found = await repo.findActiveById("prd-confirmation");
    expect(found?.definition.version).toBe(2);
  });

  test("findActiveByDocumentType returns the highest active version matching documentType", async () => {
    await repo.upsert(makeRecord("prd-confirmation", 1, "prd"));
    await repo.upsert(makeRecord("prd-confirmation", 2, "prd"));
    await repo.upsert(makeRecord("hld-pipeline", 1, "hld"));
    const found = await repo.findActiveByDocumentType("prd");
    expect(found?.definition.id).toBe("prd-confirmation");
    expect(found?.definition.version).toBe(2);
  });

  test("deprecatePreviousVersions marks earlier versions deprecated", async () => {
    await repo.upsert(makeRecord("prd-confirmation", 1));
    await repo.upsert(makeRecord("prd-confirmation", 2));
    await repo.deprecatePreviousVersions("prd-confirmation", 2);
    const v1 = await repo.findByIdAndVersion("prd-confirmation", 1);
    expect(v1?.status).toBe("deprecated");
    const active = await repo.findActiveById("prd-confirmation");
    expect(active?.definition.version).toBe(2);
  });

  test("listActive returns only active records", async () => {
    await repo.upsert(makeRecord("a", 1));
    await repo.upsert(makeRecord("b", 1));
    await repo.deprecatePreviousVersions("a", 99);
    const list = await repo.listActive();
    expect(list.length).toBe(1);
    expect(list[0].definition.id).toBe("b");
  });
});
