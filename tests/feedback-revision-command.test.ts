import { describe, expect, it } from "vitest";
import type { AgentJob, FeedbackItem } from "../src/prd-confirmation/domain";
import { MysqlFeedbackRevisionCommand } from "../src/workflow-api/feedback-revision-command";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlFeedbackRevisionCommand", () => {
  it("records standalone document feedback as a direct MySQL command", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlFeedbackRevisionCommand(database);

    await command.recordFeedback({
      feedback: feedbackItem({
        revisionJobId: undefined
      })
    });

    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO feedback_item")
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
  });

  it("records revision jobs before feedback rows that point at the job", async () => {
    const database = new FakeMysqlDatabase();
    const command = new MysqlFeedbackRevisionCommand(database);
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
      expect.stringContaining("INSERT INTO feedback_item")
    ]);
    expect(database.statements[0].params).toEqual(
      expect.arrayContaining([
        "job_2",
        "run_1",
        "document.revise",
        "pending",
        JSON.stringify(job.input),
        "developer",
        JSON.stringify(["document.revise"]),
        "local_allowed",
        "2026-05-20T00:00:00.000Z"
      ])
    );
    expect(database.statements[1].params).toContain("job_2");
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
