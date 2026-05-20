import { describe, expect, it } from "vitest";
import { createEmptyStore } from "../src/prd-confirmation/domain";
import { MysqlPrdSnapshotLoader } from "../src/prd-confirmation/mysql-snapshot-loader";
import { runEngineOnce } from "../src/prd-confirmation/workflow-engine";
import { PrdConfirmationWorkflow } from "../src/prd-confirmation/workflow";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlPrdSnapshotLoader", () => {
  it("restores the PRD compatibility store from MySQL read-model rows without replaying processed results", async () => {
    const database = new FakeMysqlReadDatabase({
      workflowRuns: [
        {
          id: "run_1",
          workflow_definition_id: "prd_confirmation",
          status: "active",
          source_type: "jira",
          source_key: "PRD-100",
          output_language: "ko",
          created_at: "2026-05-20T00:00:00.000Z",
          updated_at: "2026-05-20T00:00:00.000Z"
        }
      ],
      documents: [
        {
          id: "doc_wi_1",
          workflow_run_id: "run_1",
          parent_document_id: null,
          type: "prd",
          source_key: "PRD-100",
          title: "FAQ automation PRD",
          status: "approval_pending",
          current_version_id: "docv_1",
          current_markdown_artifact_id: "art_1",
          current_wiki_artifact_id: "art_2",
          created_at: "2026-05-20T00:00:00.000Z",
          updated_at: "2026-05-20T00:00:00.000Z"
        }
      ],
      documentVersions: [
        {
          id: "docv_1",
          document_id: "doc_wi_1",
          version: 1,
          producer_job_id: "job_1",
          summary: "Draft PRD",
          revision_summary: null,
          revision_job_id: null,
          content_hash: null,
          created_at: "2026-05-20T00:01:00.000Z"
        }
      ],
      workflowJobs: [
        jobRow("job_1", "prd.generate_draft", "succeeded", {}),
        jobRow("job_2", "prd.evaluate_quality", "succeeded", {})
      ],
      workflowJobResults: [
        resultRow("result_1", "job_1", { markdown: "# PRD", summary: "Draft PRD" }),
        resultRow("result_2", "job_2", { status: "passed", score: 91, summary: "Quality passed" })
      ],
      artifacts: [
        artifactRow("art_1", "document_markdown", "git", "https://git.example.com/prd/PRD-100.md", {
          legacyType: "prd_markdown"
        }),
        artifactRow("art_2", "wiki_page", "wiki", "https://wiki.example.com/prd/PRD-100", {
          legacyType: "prd_wiki_page"
        })
      ],
      feedbackItems: [
        {
          id: "fb_1",
          document_id: "doc_wi_1",
          work_item_id: "wi_1",
          source: "wiki",
          author: "planner@example.com",
          body: "Add rollout KPI.",
          external_id: "comment-1",
          external_url: "https://wiki.example.com/comment-1",
          metadata_json: JSON.stringify({ pageId: "999" }),
          revision_job_id: null,
          created_at: "2026-05-20T00:02:00.000Z"
        }
      ]
    });
    const store = createEmptyStore();
    const loader = new MysqlPrdSnapshotLoader(database);

    const result = await loader.loadInto(store);

    expect(result).toMatchObject({
      restored: true,
      workflowRuns: 1,
      workItems: 1,
      jobs: 2,
      jobResults: 2,
      artifacts: 2,
      feedbackItems: 1
    });
    expect(store.workItems).toEqual([
      {
        id: "wi_1",
        runId: "run_1",
        artifactType: "prd",
        parentWorkItemId: undefined,
        primaryJiraKey: "PRD-100",
        title: "FAQ automation PRD",
        state: "awaiting_approval"
      }
    ]);
    expect(store.agentJobs.map((job) => [job.id, job.jobType, job.status])).toEqual([
      ["job_1", "prd.generate_draft", "succeeded"],
      ["job_2", "prd.evaluate_quality", "succeeded"]
    ]);
    expect(store.agentJobResults.every((jobResult) => jobResult.processed)).toBe(true);
    expect(store.artifacts.map((artifact) => [artifact.type, artifact.url])).toEqual([
      ["prd_markdown", "https://git.example.com/prd/PRD-100.md"],
      ["prd_wiki_page", "https://wiki.example.com/prd/PRD-100"]
    ]);
    expect(store.feedbackItems[0]).toMatchObject({
      id: "fb_1",
      workItemId: "wi_1",
      documentId: "doc_wi_1",
      source: "wiki",
      body: "Add rollout KPI."
    });
    expect(store.externalIssues.get("PRD-100")).toMatchObject({
      status: "awaiting_approval",
      summary: "FAQ automation PRD"
    });
    expect(await runEngineOnce(store)).toBe(false);
  });

  it("does not mutate the store when no PRD read-model rows exist", async () => {
    const database = new FakeMysqlReadDatabase();
    const store = createEmptyStore();

    store.externalIssues.set("PRD-100", {
      key: "PRD-100",
      issueType: "prd",
      status: "prd_requested",
      summary: "Existing seeded PRD",
      linkedSourceKeys: ["OPS-1"]
    });

    const result = await new MysqlPrdSnapshotLoader(database).loadInto(store);

    expect(result.restored).toBe(false);
    expect(store.workItems).toEqual([]);
    expect(store.externalIssues.get("PRD-100")?.linkedSourceKeys).toEqual(["OPS-1"]);
  });

  it("keeps restored PRD intake idempotent even when source snapshots are not present", async () => {
    const store = createEmptyStore();

    store.workItems.push({
      id: "wi_1",
      runId: "run_1",
      artifactType: "prd",
      primaryJiraKey: "PRD-100",
      state: "awaiting_approval"
    });

    await expect(new PrdConfirmationWorkflow(store).intakePrdTicket("PRD-100")).resolves.toEqual({
      status: "accepted"
    });
  });
});

interface FakeRows {
  workflowRuns?: Row[];
  documents?: Row[];
  documentVersions?: Row[];
  workflowJobs?: Row[];
  workflowJobResults?: Row[];
  artifacts?: Row[];
  feedbackItems?: Row[];
}

type Row = Record<string, unknown>;

class FakeMysqlReadDatabase implements MysqlDatabase, MysqlConnection {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(private readonly rows: FakeRows = {}) {}

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    const normalizedSql = normalizeSql(sql);
    this.queries.push({ sql: normalizedSql, params });

    if (normalizedSql.includes("FROM workflow_job_result")) {
      return [(this.rows.workflowJobResults ?? []) as T, undefined];
    }

    if (normalizedSql.includes("FROM workflow_run")) {
      return [(this.rows.workflowRuns ?? []) as T, undefined];
    }

    if (normalizedSql.includes("FROM document_version")) {
      return [(this.rows.documentVersions ?? []) as T, undefined];
    }

    if (normalizedSql.includes("FROM document")) {
      return [(this.rows.documents ?? []) as T, undefined];
    }

    if (normalizedSql.includes("FROM workflow_job")) {
      return [(this.rows.workflowJobs ?? []) as T, undefined];
    }

    if (normalizedSql.includes("FROM artifact")) {
      return [(this.rows.artifacts ?? []) as T, undefined];
    }

    if (normalizedSql.includes("FROM feedback_item")) {
      return [(this.rows.feedbackItems ?? []) as T, undefined];
    }

    return [[] as T, undefined];
  }

  async getConnection(): Promise<MysqlConnection> {
    return this;
  }

  async beginTransaction(): Promise<void> {}

  async commit(): Promise<void> {}

  async rollback(): Promise<void> {}

  release(): void {}
}

function jobRow(
  id: string,
  jobType: string,
  status: string,
  input: Record<string, unknown>
): Row {
  return {
    id,
    run_id: "run_1",
    job_type: jobType,
    status,
    input_json: JSON.stringify(input),
    priority: 0,
    project_id: "prd-confirmation",
    repository_id: "prd-docs",
    assigned_user_id: null,
    assigned_team_id: null,
    required_role: "planner",
    required_capabilities_json: JSON.stringify(["document.generate"]),
    preferred_engine: null,
    required_engine: null,
    execution_policy: "local_allowed",
    assigned_runner_id: null,
    claimed_by_runner_id: null,
    claimed_at: null,
    lease_expires_at: null,
    created_at: id === "job_1" ? "2026-05-20T00:00:00.000Z" : "2026-05-20T00:01:00.000Z",
    updated_at: "2026-05-20T00:01:00.000Z"
  };
}

function resultRow(id: string, jobId: string, output: Record<string, unknown>): Row {
  return {
    id,
    job_id: jobId,
    runner_id: "runner-1",
    attempt_no: 1,
    status: "succeeded",
    output_json: JSON.stringify(output),
    error_code: null,
    error_message: null,
    created_at: id === "result_1" ? "2026-05-20T00:00:30.000Z" : "2026-05-20T00:01:30.000Z"
  };
}

function artifactRow(
  id: string,
  type: string,
  location: string,
  uri: string,
  metadata: Record<string, unknown>
): Row {
  return {
    id,
    document_id: "doc_wi_1",
    document_version_id: "docv_1",
    producer_job_id: "job_1",
    type,
    location,
    uri,
    external_id: null,
    external_version: null,
    content_hash: null,
    metadata_json: JSON.stringify(metadata),
    created_at: id === "art_1" ? "2026-05-20T00:01:00.000Z" : "2026-05-20T00:01:01.000Z"
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
