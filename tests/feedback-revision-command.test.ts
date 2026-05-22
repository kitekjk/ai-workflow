import { describe, expect, it } from "vitest";
import type { AgentJob, FeedbackItem } from "../backend/src/prd-confirmation/domain";
import { MysqlFeedbackRevisionCommand } from "../backend/src/workflow-api/feedback-revision-command";
import type { MysqlConnection, MysqlDatabase } from "../backend/src/workflow-core/mysql-repository";

describe("MysqlFeedbackRevisionCommand", () => {
  it("records standalone document feedback as a direct MySQL command", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlFeedbackRevisionCommand(database, { idGenerator: fixedIds("event_1") });

    await command.recordFeedback({
      feedback: feedbackItem({
        revisionJobId: undefined
      })
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
        null
      ])
    );
    expect(database.statements[1].params).toEqual(
      expect.arrayContaining([
        "event_1",
        null,
        "workflow.feedback_recorded",
        "Feedback recorded: fb_1",
        "2026-05-20 00:00:00.000",
        "doc_wi_1"
      ])
    );
    expect(JSON.parse(String(database.statements[1].params[4]))).toEqual({
      feedbackId: "fb_1",
      documentId: "doc_wi_1",
      workItemId: "wi_1",
      source: "app",
      author: "planner@example.com",
      revisionJobId: null
    });
  });

  it("records revision jobs before feedback rows that point at the job", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlFeedbackRevisionCommand(database, { idGenerator: fixedIds("event_1", "event_2") });
    const job: AgentJob = {
      id: "job_2",
      workItemId: "wi_1",
      jobType: "document.revise",
      primaryJiraKey: "PRD-100-HLD-1",
      status: "pending",
      input: {
        sourceDocumentId: "doc_wi_1",
        feedbackItemIds: ["fb_1"]
      }
    };

    await command.recordRevisionJob({
      runId: "run_1",
      job,
      taskId: "task_wi_1",
      feedbackItems: [
        feedbackItem({
          revisionJobId: "job_2"
        })
      ],
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO workflow_job"),
      expect.stringContaining("INSERT INTO feedback_item"),
      expect.stringContaining("INSERT INTO workflow_event"),
      expect.stringContaining("INSERT INTO workflow_event")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining([
        "job_2",
        "run_1",
        "task_wi_1",
        "document.revise",
        "pending",
        JSON.stringify(job.input),
        "developer",
        JSON.stringify(["document.revise"]),
        "local_allowed",
        "2026-05-20 00:00:00.000"
      ])
    );
    expect(database.statements[1].params).toContain("job_2");
    expect(database.statements[2].params).toEqual(
      expect.arrayContaining([
        "event_1",
        "job_2",
        "workflow.feedback_recorded",
        "Feedback recorded: fb_1",
        "2026-05-20 00:00:00.000",
        "doc_wi_1"
      ])
    );
    expect(database.statements[3].params).toEqual(
      expect.arrayContaining([
        "event_2",
        "run_1",
        "job_2",
        "workflow.revision_job_recorded",
        "Revision job recorded: job_2"
      ])
    );
    expect(JSON.parse(String(database.statements[3].params[5]))).toEqual({
      jobId: "job_2",
      jobType: "document.revise",
      status: "pending",
      sourceKey: "PRD-100-HLD-1",
      feedbackItemIds: ["fb_1"]
    });
  });

  it("rolls back and releases the connection when revision recording fails", async () => {
    const database = new FakeMysqlDatabase({ failOnStatement: 2 });
    const command = new MysqlFeedbackRevisionCommand(database);

    await expect(
      command.recordRevisionJob({
        runId: "run_1",
        job: {
          id: "job_2",
          workItemId: "wi_1",
          jobType: "prd.apply_feedback_revision",
          primaryJiraKey: "PRD-100",
          status: "pending",
          input: {}
        },
        feedbackItems: [feedbackItem({ revisionJobId: "job_2" })]
      })
    ).rejects.toThrow("forced database failure");

    expect(database.events).toEqual(["begin", "rollback", "release"]);
  });
});

function feedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
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
