import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("MySQL core workflow migration", () => {
  const migration = readFileSync(
    join(process.cwd(), "migrations", "mysql", "001_core_workflow_state.sql"),
    "utf8"
  );
  const readModelMigration = readFileSync(
    join(process.cwd(), "migrations", "mysql", "002_workflow_snapshot_read_model.sql"),
    "utf8"
  );

  it("creates the core workflow, runner, document, and artifact tables", () => {
    for (const table of [
      "schema_migration",
      "workflow_run",
      "runner",
      "workflow_job",
      "workflow_job_result",
      "workflow_event",
      "document",
      "document_version",
      "artifact",
      "quality_gate_result"
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("keeps local runner claim fields in the workflow_job schema", () => {
    const workflowJobSchema = sectionForTable(migration, "workflow_job");

    for (const column of [
      "assigned_user_id",
      "assigned_team_id",
      "project_id",
      "repository_id",
      "required_capabilities_json",
      "preferred_engine",
      "required_engine",
      "execution_policy",
      "assigned_runner_id",
      "claimed_by_runner_id",
      "lease_expires_at"
    ]) {
      expect(workflowJobSchema).toContain(column);
    }

    expect(workflowJobSchema).toContain("idx_workflow_job_claim");
  });

  it("separates document current pointers from immutable version and artifact history", () => {
    const documentSchema = sectionForTable(migration, "document");
    const versionSchema = sectionForTable(migration, "document_version");
    const artifactSchema = sectionForTable(migration, "artifact");

    expect(documentSchema).toContain("current_version_id");
    expect(documentSchema).toContain("current_markdown_artifact_id");
    expect(documentSchema).toContain("current_wiki_artifact_id");
    expect(versionSchema).toContain("UNIQUE KEY uq_document_version");
    expect(artifactSchema).toContain("idx_artifact_dedupe");
  });

  it("adds an optional workflow-db compose profile for local MySQL", () => {
    const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");

    expect(compose).toContain("workflow-mysql:");
    expect(compose).toContain('profiles: ["workflow-db"]');
    expect(compose).toContain("workflow_mysql_data:");
  });

  it("extends the read model for mirrored revisions, quality results, and feedback", () => {
    expect(readModelMigration).toContain("revision_summary");
    expect(readModelMigration).toContain("revision_job_id");
    expect(readModelMigration).toContain("auto_revision_scheduled");
    expect(readModelMigration).toContain("CREATE TABLE IF NOT EXISTS feedback_item");
    expect(readModelMigration).toContain("uq_feedback_external");
  });
});

function sectionForTable(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);

  if (start < 0) {
    throw new Error(`Missing table: ${table}`);
  }

  const next = sql.indexOf("\nCREATE TABLE", start + 1);
  return next < 0 ? sql.slice(start) : sql.slice(start, next);
}
