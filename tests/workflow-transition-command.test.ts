import { describe, expect, it } from "vitest";
import type { Document } from "../src/document-core/domain";
import type { AgentJob } from "../src/prd-confirmation/domain";
import { MysqlWorkflowTransitionCommand } from "../src/workflow-api/workflow-transition-command";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlWorkflowTransitionCommand", () => {
  it("records document approval state as a direct MySQL command", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowTransitionCommand(database, { idGenerator: fixedIds("event_1") });

    await command.recordDocumentState({
      document: document({
        status: "approved"
      }),
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining([
        "doc_wi_1",
        "run_1",
        "prd",
        "PRD-100",
        "FAQ automation PRD",
        "approved",
        "2026-05-20T00:00:00.000Z"
      ])
    );
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_1",
        "workflow.document_state",
        "Document state recorded: doc_wi_1"
      ])
    );
    expect(JSON.parse(String(database.statements[1].params[5]))).toEqual({
      documentId: "doc_wi_1",
      documentType: "prd",
      sourceKey: "PRD-100",
      status: "approved"
    });
  });

  it("uses the document update time for direct document state events when no command time is provided", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowTransitionCommand(database, { idGenerator: fixedIds("event_1") });

    await command.recordDocumentState({
      document: document({
        status: "approved",
        updatedAt: "2026-05-20T00:02:00.000Z"
      })
    });

    expect(database.statements[0].params).toContain("2026-05-20T00:02:00.000Z");
    expect(database.statements[1].params.at(-1)).toBe("2026-05-20T00:02:00.000Z");
  });

  it("records routing jobs with scheduler claim metadata", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowTransitionCommand(database, { idGenerator: fixedIds("event_1") });
    const job: AgentJob = {
      id: "job_3",
      workItemId: "wi_1",
      jobType: "prd.route_downstream",
      primaryJiraKey: "PRD-100",
      status: "pending",
      input: {
        sourceDocumentId: "doc_wi_1"
      }
    };

    await command.recordWorkflowJob({
      runId: "run_1",
      job,
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining([
        "job_3",
        "run_1",
        "prd.route_downstream",
        "pending",
        JSON.stringify(job.input),
        "developer",
        JSON.stringify(["workflow.route"]),
        "local_allowed"
      ])
    );
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_1",
        "job_3",
        "workflow.job_recorded",
        "Workflow job recorded: job_3"
      ])
    );
    expect(JSON.parse(String(database.statements[1].params[5]))).toEqual({
      jobId: "job_3",
      jobType: "prd.route_downstream",
      status: "pending",
      sourceKey: "PRD-100"
    });
  });

  it("uses implementation job capabilities for local runner matching", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowTransitionCommand(database);

    await command.recordWorkflowJob({
      runId: "run_1",
      job: {
        id: "job_16",
        workItemId: "wi_5",
        jobType: "implementation.open_pr",
        primaryJiraKey: "PRD-100-HLD-1-LLD-1-SPEC-1",
        status: "pending",
        input: {
          documentId: "doc_wi_5"
        }
      }
    });

    expect(database.statements[0].params).toEqual(
      expect.arrayContaining(["implementation.open_pr", "developer", JSON.stringify(["implementation.open_pr"])])
    );
  });

  it("records engine document states and follow-up jobs in one transaction", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlWorkflowTransitionCommand(database, { idGenerator: fixedIds("event_1") });
    const job: AgentJob = {
      id: "job_2",
      workItemId: "wi_1",
      jobType: "prd.evaluate_quality",
      primaryJiraKey: "PRD-100",
      status: "pending",
      input: {}
    };

    await command.recordEngineTransition({
      transitionType: "prd_draft_generated",
      affectedWorkItemIds: ["wi_1"],
      affectedDocumentIds: ["doc_wi_1"],
      createdWorkItemIds: ["wi_2"],
      workItemState: {
        workItemId: "wi_1",
        before: "draft_requested",
        after: "evaluating"
      },
      externalIssueStatus: {
        issueKey: "PRD-100",
        before: "drafting",
        after: "drafting"
      },
      processedResult: {
        jobId: "job_1",
        jobType: "prd.generate_draft",
        primaryJiraKey: "PRD-100",
        status: "succeeded"
      },
      documents: [
        document({
          status: "quality_review"
        }),
        document({
          id: "doc_wi_2",
          parentDocumentId: "doc_wi_1",
          type: "hld",
          sourceKey: "PRD-100-HLD-1",
          title: "HLD for PRD-100"
        })
      ],
      jobs: [
        {
          runId: "run_1",
          job
        }
      ],
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO document"),
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining([
        "job_2",
        "run_1",
        "prd.evaluate_quality",
        "pending",
        JSON.stringify(job.input),
        "developer",
        JSON.stringify(["document.evaluate"])
      ])
    );
    expect(database.statements[3].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "run_1",
        "workflow.engine_transition",
        "Workflow engine transition: prd_draft_generated"
      ])
    );
    expect(JSON.parse(String(database.statements[3].params[5]))).toEqual({
      transitionType: "prd_draft_generated",
      affectedWorkItemIds: ["wi_1"],
      affectedDocumentIds: ["doc_wi_1"],
      createdWorkItemIds: ["wi_2"],
      workItemState: {
        workItemId: "wi_1",
        before: "draft_requested",
        after: "evaluating"
      },
      externalIssueStatus: {
        issueKey: "PRD-100",
        before: "drafting",
        after: "drafting"
      },
      processedResult: {
        jobId: "job_1",
        jobType: "prd.generate_draft",
        primaryJiraKey: "PRD-100",
        status: "succeeded"
      },
      documentIds: ["doc_wi_1", "doc_wi_2"],
      createdJobIds: ["job_2"]
    });
  });

  it("rolls back and releases the connection when transition recording fails", async () => {
    const database = new FakeMysqlDatabase({ failOnStatement: 1 });
    const command = new MysqlWorkflowTransitionCommand(database);

    await expect(command.recordDocumentState({ document: document() })).rejects.toThrow("forced database failure");

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });

  it("rolls back the full engine transition batch when any write fails", async () => {
    const database = new FakeMysqlDatabase({ failOnStatement: 2 });
    const command = new MysqlWorkflowTransitionCommand(database);

    await expect(
      command.recordEngineTransition({
        documents: [
          document(),
          document({
            id: "doc_wi_2",
            parentDocumentId: "doc_wi_1"
          })
        ],
        jobs: []
      })
    ).rejects.toThrow("forced database failure");

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });
});

function document(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc_wi_1",
    workflowRunId: "run_1",
    type: "prd",
    sourceKey: "PRD-100",
    title: "FAQ automation PRD",
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
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
