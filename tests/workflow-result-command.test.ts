import { describe, expect, it } from "vitest";
import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../src/document-core/domain";
import { MysqlWorkflowResultCommand } from "../src/workflow-api/workflow-result-command";
import type { WorkflowJob, WorkflowJobResult } from "../src/workflow-core/domain";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlWorkflowResultCommand", () => {
  it("records runner result projections in read-model dependency order", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowResultCommand(database, { idGenerator: fixedIds("event_1") });

    await command.recordResultProjection({
      jobId: "job_1",
      jobs: [workflowJob("job_1", "succeeded"), workflowJob("job_2", "pending")],
      jobResults: [workflowJobResult()],
      documents: [document()],
      documentVersions: [documentVersion()],
      artifacts: [artifact()],
      qualityResults: [qualityResult()]
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO workflow_task"),
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_job_result"),
      expect.stringContaining("INSERT INTO document_version"),
      expect.stringContaining("INSERT INTO artifact"),
      expect.stringContaining("UPDATE document SET status"),
      expect.stringContaining("INSERT INTO quality_gate_result"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining(["task_wi_1", "run_1", "prd", "PRD-100", "FAQ automation PRD", "quality_review", "doc_wi_1"])
    );
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining(["job_1", "run_1", "prd.generate_draft", "succeeded"])
    );
    expect(database.statements[4].params).toEqual(
      expect.arrayContaining(["result_1", "job_1", 1, "succeeded", JSON.stringify({ status: "succeeded" })])
    );
    expect(database.statements[5].params).toEqual(
      expect.arrayContaining(["docv_1", "doc_wi_1", 1, "job_1"])
    );
    expect(database.statements[8].params).toEqual(
      expect.arrayContaining(["qgr_1", "doc_wi_1", "docv_1", "job_2", "passed"])
    );
    expect(database.statements[9].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_1",
        "job_1",
        "workflow.result_projection",
        "Workflow result projection recorded for job job_1"
      ])
    );
    expect(JSON.parse(String(database.statements[9].params[5]))).toEqual({
      jobId: "job_1",
      jobIds: ["job_1", "job_2"],
      jobResultIds: ["result_1"],
      documentIds: ["doc_wi_1"],
      documentVersionIds: ["docv_1"],
      artifactIds: ["art_1"],
      qualityResultIds: ["qgr_1"]
    });
  });

  it("rolls back and releases the connection when projection recording fails", async () => {
    const database = new FakeMysqlDatabase({ failOnStatement: 3 });
    const command = new MysqlWorkflowResultCommand(database);

    await expect(
      command.recordResultProjection({
        jobId: "job_1",
        jobs: [workflowJob("job_1", "succeeded")],
        jobResults: [workflowJobResult()],
        documents: [document()],
        documentVersions: [],
        artifacts: [],
        qualityResults: []
      })
    ).rejects.toThrow("forced database failure");

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });
});

function workflowJob(id: string, status: WorkflowJob["status"]): WorkflowJob {
  return {
    id,
    runId: "run_1",
    jobType: id === "job_2" ? "prd.evaluate_quality" : "prd.generate_draft",
    status,
    input: {},
    priority: 0,
    projectId: "prd-confirmation",
    repositoryId: "prd-docs",
    requiredRole: id === "job_2" ? "developer" : "planner",
    requiredCapabilities: id === "job_2" ? ["document.evaluate"] : ["document.generate"],
    executionPolicy: "local_allowed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function workflowJobResult(): WorkflowJobResult {
  return {
    id: "result_1",
    jobId: "job_1",
    attemptNo: 1,
    status: "succeeded",
    output: {
      status: "succeeded"
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function document(): Document {
  return {
    id: "doc_wi_1",
    workflowRunId: "run_1",
    type: "prd",
    sourceKey: "PRD-100",
    title: "FAQ automation PRD",
    status: "quality_review",
    currentVersionId: "docv_1",
    currentMarkdownArtifactId: "art_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function documentVersion(): DocumentVersion {
  return {
    id: "docv_1",
    documentId: "doc_wi_1",
    version: 1,
    producerJobId: "job_1",
    summary: "Generated PRD draft",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function artifact(): Artifact {
  return {
    id: "art_1",
    documentId: "doc_wi_1",
    documentVersionId: "docv_1",
    producerJobId: "job_1",
    type: "document_markdown",
    location: "git",
    uri: "https://git.example.com/prd/PRD-100.md",
    metadata: {
      legacyType: "prd_markdown"
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function qualityResult(): DocumentQualityResult {
  return {
    id: "qgr_1",
    documentId: "doc_wi_1",
    documentVersionId: "docv_1",
    evaluatorJobId: "job_2",
    status: "passed",
    score: 91,
    summary: "Quality passed",
    missingInformation: [],
    clarificationQuestions: [],
    riskItems: [],
    autoRevisionScheduled: false,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

class FakeMysqlDatabase implements MysqlDatabase, MysqlConnection {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly events: string[] = [];

  constructor(private readonly options: { failOnStatement?: number } = {}) {}

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    this.statements.push({ sql: normalizeSql(sql), params });

    if (this.options.failOnStatement === this.statements.length) {
      throw new Error("forced database failure");
    }

    return [{ affectedRows: 1 } as T, undefined];
  }

  async getConnection(): Promise<MysqlConnection> {
    return this;
  }

  async beginTransaction(): Promise<void> {
    this.events.push("begin");
  }

  async commit(): Promise<void> {
    this.events.push("commit");
  }

  async rollback(): Promise<void> {
    this.events.push("rollback");
  }

  release(): void {
    this.events.push("release");
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function fixedIds(...ids: string[]): () => string {
  let index = 0;

  return () => ids[index++] ?? ids.at(-1) ?? "generated_id";
}
