import { describe, expect, it } from "vitest";
import type { MysqlConnection, MysqlDatabase } from "../backend/src/workflow-core/mysql-repository";
import {
  MysqlDocumentRepository,
  rowToArtifact,
  rowToDocument,
  rowToDocumentVersion
} from "../backend/src/document-core/mysql-repository";

describe("MysqlDocumentRepository", () => {
  it("inserts documents with draft status", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlDocumentRepository(database, { idGenerator: fixedIds("doc_1") });
    const now = new Date("2026-05-20T00:00:00.000Z");

    const document = await repository.createDocument({
      workflowRunId: "run_1",
      type: "prd",
      sourceKey: "PRD-100",
      title: "FAQ Automation PRD",
      now
    });

    expect(document).toMatchObject({
      id: "doc_1",
      workflowRunId: "run_1",
      type: "prd",
      status: "draft"
    });
    expect(database.statements[0]?.sql).toContain("INSERT INTO document");
    expect(database.statements[0]?.params).toContain("FAQ Automation PRD");
  });

  it("creates document versions in a transaction and updates the current version pointer", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlDocumentRepository(database, { idGenerator: fixedIds("docv_2") });
    const now = new Date("2026-05-20T00:01:00.000Z");
    database.queueRows([documentRow({ id: "doc_1" })]);
    database.queueRows([{ next_version: 2 }]);

    const version = await repository.createDocumentVersion({
      documentId: "doc_1",
      producerJobId: "job_2",
      summary: "Revision",
      contentHash: "hash-v2",
      now
    });

    expect(version).toMatchObject({
      id: "docv_2",
      documentId: "doc_1",
      version: 2,
      producerJobId: "job_2"
    });
    expect(database.events).toEqual(["begin", "commit", "release"]);
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("SELECT * FROM document"),
      expect.stringContaining("SELECT COALESCE(MAX(version), 0) + 1"),
      expect.stringContaining("INSERT INTO document_version"),
      expect.stringContaining("UPDATE document SET current_version_id")
    ]);
    expect(database.statements[0]?.sql).toContain("FOR UPDATE");
  });

  it("registers artifacts and updates current markdown/wiki pointers", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlDocumentRepository(database, { idGenerator: fixedIds("art_1", "art_2") });
    const now = new Date("2026-05-20T00:02:00.000Z");

    const markdown = await repository.registerArtifact({
      documentId: "doc_1",
      documentVersionId: "docv_1",
      producerJobId: "job_1",
      type: "document_markdown",
      location: "git",
      uri: "https://git.example.com/prds/PRD-100.md",
      contentHash: "hash-v1",
      metadata: { path: "prds/PRD-100.md" },
      now
    });
    const wiki = await repository.registerArtifact({
      documentId: "doc_1",
      documentVersionId: "docv_1",
      producerJobId: "job_1",
      type: "wiki_page",
      location: "wiki",
      uri: "https://wiki.example.com/prd/PRD-100",
      externalVersion: "3",
      now
    });

    expect(markdown.id).toBe("art_1");
    expect(wiki.id).toBe("art_2");
    expect(database.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("INSERT INTO artifact"),
      expect.stringContaining("UPDATE document SET current_markdown_artifact_id"),
      expect.stringContaining("INSERT INTO artifact"),
      expect.stringContaining("UPDATE document SET current_wiki_artifact_id")
    ]);
  });

  it("loads current document with version and current artifacts", async () => {
    const database = new FakeMysqlDatabase();
    const repository = new MysqlDocumentRepository(database);
    database.queueRows([
      documentRow({
        current_version_id: "docv_1",
        current_markdown_artifact_id: "art_1",
        current_wiki_artifact_id: "art_2"
      })
    ]);
    database.queueRows([documentVersionRow()]);
    database.queueRows([artifactRow({ id: "art_2", type: "wiki_page" }), artifactRow({ id: "art_1" })]);

    const current = await repository.getCurrentDocument("doc_1");

    expect(current.document.currentVersionId).toBe("docv_1");
    expect(current.currentVersion?.version).toBe(1);
    expect(current.currentArtifacts.map((artifact) => artifact.id)).toEqual(["art_1", "art_2"]);
  });

  it("maps MySQL document rows into domain objects", () => {
    expect(rowToDocument(documentRow())).toMatchObject({
      id: "doc_1",
      workflowRunId: "run_1",
      type: "prd",
      status: "draft"
    });
    expect(rowToDocumentVersion(documentVersionRow())).toMatchObject({
      id: "docv_1",
      version: 1,
      contentHash: "hash-v1"
    });
    expect(rowToArtifact(artifactRow())).toMatchObject({
      id: "art_1",
      type: "document_markdown",
      metadata: { path: "prds/PRD-100.md" }
    });
  });
});

class FakeMysqlDatabase implements MysqlDatabase, MysqlConnection {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly events: string[] = [];
  private readonly responses: unknown[] = [];

  queueRows(rows: unknown[]): void {
    this.responses.push(rows);
  }

  async execute<T = unknown>(sql: string, params: readonly unknown[] = []): Promise<[T, unknown]> {
    this.statements.push({ sql: normalizeSql(sql), params });
    const result = normalizeSql(sql).toUpperCase().startsWith("SELECT")
      ? this.responses.shift() ?? []
      : { affectedRows: 1 };
    return [result as T, undefined];
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

function documentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc_1",
    workflow_run_id: "run_1",
    parent_document_id: null,
    type: "prd",
    source_key: "PRD-100",
    title: "FAQ Automation PRD",
    status: "draft",
    current_version_id: null,
    current_markdown_artifact_id: null,
    current_wiki_artifact_id: null,
    created_at: "2026-05-20T00:00:00.000Z",
    updated_at: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

function documentVersionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "docv_1",
    document_id: "doc_1",
    version: 1,
    producer_job_id: "job_1",
    summary: "Initial draft",
    content_hash: "hash-v1",
    created_at: "2026-05-20T00:01:00.000Z",
    ...overrides
  };
}

function artifactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "art_1",
    document_id: "doc_1",
    document_version_id: "docv_1",
    producer_job_id: "job_1",
    type: "document_markdown",
    location: "git",
    uri: "https://git.example.com/prds/PRD-100.md",
    external_id: null,
    external_version: null,
    content_hash: "hash-v1",
    metadata_json: JSON.stringify({ path: "prds/PRD-100.md" }),
    created_at: "2026-05-20T00:02:00.000Z",
    ...overrides
  };
}

function fixedIds(...ids: string[]): (prefix: string) => string {
  let index = 0;
  return (prefix) => ids[index++] ?? `${prefix}_${index}`;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
