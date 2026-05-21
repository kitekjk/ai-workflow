import { describe, expect, it } from "vitest";
import { MysqlWorkflowApiReadModel } from "../src/workflow-api/mysql-read-model";
import type { MysqlConnection, MysqlDatabase } from "../src/workflow-core/mysql-repository";

describe("MysqlWorkflowApiReadModel", () => {
  it("summarizes workflow and document views directly from MySQL read-model rows", async () => {
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
      workflowJobs: [
        {
          id: "job_1",
          run_id: "run_1",
          job_type: "prd.generate_draft",
          status: "succeeded",
          input_json: JSON.stringify({ sourceDocumentId: "doc_wi_1" }),
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
          created_at: "2026-05-20T00:00:00.000Z",
          updated_at: "2026-05-20T00:01:00.000Z"
        }
      ],
      workflowJobResults: [
        {
          id: "result_1",
          job_id: "job_1",
          output_json: JSON.stringify({ status: "succeeded", summary: "Generated PRD" }),
          created_at: "2026-05-20T00:02:00.000Z"
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
          updated_at: "2026-05-20T00:01:00.000Z"
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
          content_hash: "hash-1",
          created_at: "2026-05-20T00:01:00.000Z"
        }
      ],
      artifacts: [
        {
          id: "art_1",
          document_id: "doc_wi_1",
          document_version_id: "docv_1",
          producer_job_id: "job_1",
          type: "document_markdown",
          location: "git",
          uri: "https://git.example.com/prd/PRD-100.md",
          external_id: null,
          external_version: null,
          content_hash: "hash-1",
          metadata_json: JSON.stringify({ legacyType: "prd_markdown" }),
          created_at: "2026-05-20T00:01:00.000Z"
        },
        {
          id: "art_2",
          document_id: "doc_wi_1",
          document_version_id: "docv_1",
          producer_job_id: "job_1",
          type: "wiki_page",
          location: "wiki",
          uri: "https://wiki.example.com/prd/PRD-100",
          external_id: "999",
          external_version: "3",
          content_hash: null,
          metadata_json: JSON.stringify({ legacyType: "prd_wiki_page" }),
          created_at: "2026-05-20T00:01:01.000Z"
        }
      ],
      qualityResults: [
        {
          id: "qgr_1",
          document_id: "doc_wi_1",
          document_version_id: "docv_1",
          workflow_job_id: "job_2",
          status: "passed",
          score: 91,
          summary: "Quality passed",
          missing_information_json: JSON.stringify([]),
          clarification_questions_json: JSON.stringify([]),
          risk_items_json: JSON.stringify(["Monitor rollout KPI"]),
          quality_failure_action: null,
          auto_revision_scheduled: false,
          created_at: "2026-05-20T00:02:00.000Z"
        }
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
          created_at: "2026-05-20T00:03:00.000Z"
        }
      ]
    });
    const readModel = new MysqlWorkflowApiReadModel(database);

    const state = await readModel.summarizeState("PRD-100");
    const run = await readModel.summarizeWorkflowRun("run_1");
    const tree = await readModel.summarizeWorkflowRunTree("run_1");
    const current = await readModel.summarizeDocumentCurrent("doc_wi_1");
    const history = await readModel.summarizeDocumentHistory("doc_wi_1");

    expect(state).toMatchObject({
      prdJiraKey: "PRD-100",
      prdStatus: "approval_pending",
      jobs: [{ id: "job_1", type: "prd.generate_draft", status: "succeeded" }],
      artifacts: [
        { type: "document_markdown", location: "git", url: "https://git.example.com/prd/PRD-100.md" },
        { type: "wiki_page", location: "wiki", url: "https://wiki.example.com/prd/PRD-100" }
      ],
      latestQualityResult: { id: "qgr_1" },
      latestRevisionSummary: null,
      latestResult: { status: "succeeded", summary: "Generated PRD" }
    });
    expect(run).toMatchObject({
      run: { id: "run_1", sourceKey: "PRD-100" },
      jobs: [{ id: "job_1", jobType: "prd.generate_draft" }],
      documents: [{ id: "doc_wi_1", currentVersionId: "docv_1" }]
    });
    expect(tree).toMatchObject({
      nodes: [{ id: "job_1", primaryDocumentId: "doc_wi_1" }]
    });
    expect(current).toMatchObject({
      document: { id: "doc_wi_1" },
      currentVersion: { id: "docv_1", summary: "Draft PRD" },
      latestQualityResult: { id: "qgr_1", riskItems: ["Monitor rollout KPI"] },
      currentArtifacts: [{ id: "art_1" }, { id: "art_2" }],
      pendingFeedback: [{ id: "fb_1", source: "wiki" }]
    });
    expect(history).toMatchObject({
      documentId: "doc_wi_1",
      versions: [{ id: "docv_1" }],
      qualityResults: [{ id: "qgr_1" }],
      artifacts: [{ id: "art_1" }, { id: "art_2" }],
      feedbackItems: [{ id: "fb_1" }]
    });
  });
});

interface FakeRows {
  workflowRuns?: Row[];
  workflowJobs?: Row[];
  workflowJobResults?: Row[];
  documents?: Row[];
  documentVersions?: Row[];
  artifacts?: Row[];
  qualityResults?: Row[];
  feedbackItems?: Row[];
}

type Row = Record<string, unknown>;

class FakeMysqlReadDatabase implements MysqlDatabase, MysqlConnection {
  constructor(private readonly rows: FakeRows = {}) {}

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    const normalizedSql = normalizeSql(sql);

    if (normalizedSql.includes("FROM workflow_run") && normalizedSql.includes("source_key")) {
      return [this.rows.workflowRuns?.filter((row) => row.source_key === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM workflow_run")) {
      return [this.rows.workflowRuns?.filter((row) => row.id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM workflow_job_result")) {
      const jobIdsForRun = new Set(
        this.rows.workflowJobs?.filter((row) => row.run_id === params[0]).map((row) => row.id)
      );
      return [this.rows.workflowJobResults?.filter((row) => jobIdsForRun.has(row.job_id)) as T, undefined];
    }

    if (normalizedSql.includes("FROM workflow_job")) {
      return [this.rows.workflowJobs?.filter((row) => row.run_id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM document_version WHERE id")) {
      return [this.rows.documentVersions?.filter((row) => row.id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM document_version")) {
      return [this.rows.documentVersions?.filter((row) => row.document_id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM document WHERE workflow_run_id")) {
      return [this.rows.documents?.filter((row) => row.workflow_run_id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM document WHERE id")) {
      return [this.rows.documents?.filter((row) => row.id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM artifact WHERE id IN")) {
      return [this.rows.artifacts?.filter((row) => params.includes(row.id)) as T, undefined];
    }

    if (normalizedSql.includes("FROM artifact")) {
      return [this.rows.artifacts?.filter((row) => row.document_id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM quality_gate_result")) {
      return [this.rows.qualityResults?.filter((row) => row.document_id === params[0]) as T, undefined];
    }

    if (normalizedSql.includes("FROM feedback_item") && normalizedSql.includes("revision_job_id IS NULL")) {
      return [
        this.rows.feedbackItems?.filter((row) => row.document_id === params[0] && row.revision_job_id === null) as T,
        undefined
      ];
    }

    if (normalizedSql.includes("FROM feedback_item")) {
      return [this.rows.feedbackItems?.filter((row) => row.document_id === params[0]) as T, undefined];
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

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
