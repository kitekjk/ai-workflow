import { describe, expect, it } from "vitest";
import { MysqlWorkflowMutationApplier } from "../src/workflow-api/workflow-mutation-applier";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlWorkflowMutationApplier", () => {
  it("applies workflow run, document, job, and event mutations in one transaction", async () => {
    const database = new FakeMysqlDatabase();
    const applier = new MysqlWorkflowMutationApplier(database, { idGenerator: fixedIds("event_1") });

    await applier.apply({
      workflowRuns: [
        {
          id: "run_1",
          workflowDefinitionId: "prd_confirmation",
          status: "active",
          sourceType: "jira",
          sourceKey: "PRD-100",
          outputLanguage: "ko",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z"
        }
      ],
      documents: [
        {
          id: "doc_wi_1",
          workflowRunId: "run_1",
          type: "prd",
          sourceKey: "PRD-100",
          title: "FAQ automation PRD",
          status: "draft",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z"
        }
      ],
      workflowJobs: [
        {
          id: "job_1",
          runId: "run_1",
          jobType: "prd.generate_draft",
          status: "pending",
          input: {},
          priority: 0,
          projectId: "prd-confirmation",
          repositoryId: "prd-docs",
          requiredRole: "planner",
          requiredCapabilities: ["document.generate"],
          executionPolicy: "local_allowed",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z"
        }
      ],
      events: [
        {
          runId: "run_1",
          jobId: "job_1",
          type: "workflow.prd_intake",
          message: "PRD intake recorded: PRD-100",
          metadata: {
            prdJiraKey: "PRD-100"
          },
          createdAt: "2026-05-20T00:00:00.000Z"
        }
      ]
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO workflow_run"),
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining(["run_1", "prd_confirmation", "active", "jira", "PRD-100", "ko"])
    );
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining(["doc_wi_1", "run_1", "prd", "PRD-100", "FAQ automation PRD", "draft"])
    );
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining(["job_1", "run_1", "prd.generate_draft", "pending", JSON.stringify({})])
    );
    expect(database.statements[3].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_1",
        "job_1",
        "workflow.prd_intake",
        "PRD intake recorded: PRD-100",
        JSON.stringify({ prdJiraKey: "PRD-100" }),
        "2026-05-20 00:00:00.000"
      ])
    );
  });

  it("rolls back the whole mutation when any write fails", async () => {
    const database = new FakeMysqlDatabase({ failOnStatement: 2 });
    const applier = new MysqlWorkflowMutationApplier(database);

    await expect(
      applier.apply({
        workflowRuns: [
          {
            id: "run_1",
            workflowDefinitionId: "prd_confirmation",
            status: "active",
            sourceType: "jira",
            sourceKey: "PRD-100",
            outputLanguage: "ko",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          }
        ],
        documents: [
          {
            id: "doc_wi_1",
            workflowRunId: "run_1",
            type: "prd",
            sourceKey: "PRD-100",
            title: "FAQ automation PRD",
            status: "draft",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z"
          }
        ]
      })
    ).rejects.toThrow("forced database failure");

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });

  it("applies feedback item and document-scoped event mutations", async () => {
    const database = new FakeMysqlDatabase();
    const applier = new MysqlWorkflowMutationApplier(database, { idGenerator: fixedIds("event_1") });

    await applier.apply({
      feedbackItems: [
        {
          id: "fb_1",
          workItemId: "wi_1",
          documentId: "doc_wi_1",
          source: "app",
          author: "planner@example.com",
          body: "Add rollout KPI.",
          createdAt: "2026-05-20T00:00:00.000Z",
          metadata: {
            source: "manual"
          },
          revisionJobId: "job_2"
        }
      ],
      documentEvents: [
        {
          documentId: "doc_wi_1",
          jobId: "job_2",
          type: "workflow.feedback_recorded",
          message: "Feedback recorded: fb_1",
          metadata: {
            feedbackId: "fb_1"
          },
          createdAt: "2026-05-20T00:00:00.000Z"
        }
      ]
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO feedback_item"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining([
        "fb_1",
        "doc_wi_1",
        "wi_1",
        "app",
        "planner@example.com",
        "Add rollout KPI.",
        "job_2"
      ])
    );
    expect(database.statements[1].sql).toContain("FROM document");
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "job_2",
        "workflow.feedback_recorded",
        "Feedback recorded: fb_1",
        JSON.stringify({ feedbackId: "fb_1" }),
        "2026-05-20 00:00:00.000",
        "doc_wi_1"
      ])
    );
  });

  it("applies document state mutations without rewriting current artifact pointers", async () => {
    const database = new FakeMysqlDatabase();
    const applier = new MysqlWorkflowMutationApplier(database);

    await applier.apply({
      documentStates: [
        {
          id: "doc_wi_1",
          workflowRunId: "run_1",
          type: "prd",
          sourceKey: "PRD-100",
          title: "FAQ automation PRD",
          status: "approved",
          currentVersionId: "version_1",
          currentMarkdownArtifactId: "artifact_md_1",
          currentWikiArtifactId: "artifact_wiki_1",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:01:00.000Z"
        }
      ]
    });

    expect(database.statements.map((statement) => statement.sql)).toEqual([expect.stringContaining("INSERT INTO document")]);
    expect(database.statements[0].sql).not.toContain("current_version_id = VALUES(current_version_id)");
    expect(database.statements[0].params).not.toContain("version_1");
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining(["doc_wi_1", "run_1", "prd", "PRD-100", "FAQ automation PRD", "approved"])
    );
  });

  it("applies result projection mutations in read-model dependency order", async () => {
    const database = new FakeMysqlDatabase();
    const applier = new MysqlWorkflowMutationApplier(database, { idGenerator: fixedIds("event_1") });

    await applier.apply({
      workflowJobs: [
        {
          id: "job_1",
          runId: "run_1",
          jobType: "prd.generate_draft",
          status: "succeeded",
          input: {},
          priority: 0,
          projectId: "prd-confirmation",
          repositoryId: "prd-docs",
          requiredRole: "planner",
          requiredCapabilities: ["document.generate"],
          executionPolicy: "local_allowed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      jobResults: [
        {
          id: "result_1",
          jobId: "job_1",
          attemptNo: 1,
          status: "succeeded",
          output: {
            status: "succeeded"
          },
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      documentStates: [
        {
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
        }
      ],
      documentVersions: [
        {
          id: "docv_1",
          documentId: "doc_wi_1",
          version: 1,
          producerJobId: "job_1",
          summary: "Generated PRD draft",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      artifacts: [
        {
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
        }
      ],
      documentCurrentPointers: [
        {
          id: "doc_wi_1",
          status: "quality_review",
          currentVersionId: "docv_1",
          currentMarkdownArtifactId: "art_1",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      qualityResults: [
        {
          id: "qgr_1",
          documentId: "doc_wi_1",
          documentVersionId: "docv_1",
          evaluatorJobId: "job_1",
          status: "passed",
          score: 91,
          summary: "Quality passed",
          missingInformation: [],
          clarificationQuestions: [],
          riskItems: [],
          autoRevisionScheduled: false,
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      events: [
        {
          runId: "run_1",
          jobId: "job_1",
          type: "workflow.result_projection",
          message: "Workflow result projection recorded for job job_1",
          metadata: {
            jobId: "job_1"
          },
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });

    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_job_result"),
      expect.stringContaining("INSERT INTO document_version"),
      expect.stringContaining("INSERT INTO artifact"),
      expect.stringContaining("UPDATE document SET status"),
      expect.stringContaining("INSERT INTO quality_gate_result"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining(["result_1", "job_1", 1, "succeeded", JSON.stringify({ status: "succeeded" })])
    );
    expect(database.statements[3].params).toEqual(
      expect.arrayContaining(["docv_1", "doc_wi_1", 1, "job_1"])
    );
    expect(database.statements[6].params).toEqual(
      expect.arrayContaining(["qgr_1", "doc_wi_1", "docv_1", "job_1", "passed"])
    );
  });
});

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
