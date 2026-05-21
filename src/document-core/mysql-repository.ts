import { randomUUID } from "node:crypto";
import type { Artifact, Document, DocumentVersion } from "./domain";
import type {
  CreateDocumentInput,
  CreateDocumentVersionInput,
  DocumentCurrentRecord,
  DocumentRepository,
  RegisterArtifactInput
} from "./repository";
import type { MysqlConnection, MysqlDatabase, MysqlQueryExecutor } from "../workflow-core/mysql-repository";

export interface MysqlDocumentRepositoryOptions {
  idGenerator?: (prefix: string) => string;
}

type MysqlRow = Record<string, unknown>;

export class MysqlDocumentRepository implements DocumentRepository {
  private readonly idGenerator: (prefix: string) => string;

  constructor(
    private readonly database: MysqlDatabase,
    options: MysqlDocumentRepositoryOptions = {}
  ) {
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async createDocument(input: CreateDocumentInput): Promise<Document> {
    const now = toIso(input.now);
    const document: Document = {
      id: this.idGenerator("doc"),
      workflowRunId: input.workflowRunId,
      parentDocumentId: input.parentDocumentId,
      type: input.type,
      sourceKey: input.sourceKey,
      title: input.title,
      status: "draft",
      createdAt: now,
      updatedAt: now
    };

    await this.database.execute(
      `INSERT INTO document (
        id, workflow_run_id, parent_document_id, type, source_key, title, status,
        current_version_id, current_markdown_artifact_id, current_wiki_artifact_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        document.id,
        document.workflowRunId,
        document.parentDocumentId ?? null,
        document.type,
        document.sourceKey,
        document.title,
        document.status,
        document.currentVersionId ?? null,
        document.currentMarkdownArtifactId ?? null,
        document.currentWikiArtifactId ?? null,
        document.createdAt,
        document.updatedAt
      ]
    );

    return document;
  }

  async createDocumentVersion(input: CreateDocumentVersionInput): Promise<DocumentVersion> {
    return this.withTransaction(async (connection) => {
      await this.requireDocument(connection, input.documentId, true);

      const [rows] = await connection.execute<Array<{ next_version: number }>>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM document_version
         WHERE document_id = ?`,
        [input.documentId]
      );
      const createdAt = toIso(input.now);
      const version: DocumentVersion = {
        id: this.idGenerator("docv"),
        documentId: input.documentId,
        version: Number(rows[0]?.next_version ?? 1),
        producerJobId: input.producerJobId,
        summary: input.summary,
        revisionSummary: input.revisionSummary,
        revisionJobId: input.revisionJobId,
        contentHash: input.contentHash,
        createdAt
      };

      await connection.execute(
        `INSERT INTO document_version (
          id, document_id, version, producer_job_id, summary, revision_summary, revision_job_id, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          version.id,
          version.documentId,
          version.version,
          version.producerJobId,
          version.summary ?? null,
          version.revisionSummary ?? null,
          version.revisionJobId ?? null,
          version.contentHash ?? null,
          version.createdAt
        ]
      );
      await connection.execute(
        `UPDATE document SET current_version_id = ?, updated_at = ? WHERE id = ?`,
        [version.id, version.createdAt, version.documentId]
      );

      return version;
    });
  }

  async registerArtifact(input: RegisterArtifactInput): Promise<Artifact> {
    return this.withTransaction(async (connection) => {
      const artifact: Artifact = {
        id: this.idGenerator("art"),
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        producerJobId: input.producerJobId,
        type: input.type,
        location: input.location,
        uri: input.uri,
        externalId: input.externalId,
        externalVersion: input.externalVersion,
        contentHash: input.contentHash,
        metadata: input.metadata ?? {},
        createdAt: toIso(input.now)
      };

      await connection.execute(
        `INSERT INTO artifact (
          id, document_id, document_version_id, producer_job_id, type, location, uri,
          external_id, external_version, content_hash, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          artifact.id,
          artifact.documentId ?? null,
          artifact.documentVersionId ?? null,
          artifact.producerJobId,
          artifact.type,
          artifact.location,
          artifact.uri,
          artifact.externalId ?? null,
          artifact.externalVersion ?? null,
          artifact.contentHash ?? null,
          JSON.stringify(artifact.metadata),
          artifact.createdAt
        ]
      );

      if (artifact.documentId && artifact.type === "document_markdown") {
        await connection.execute(
          `UPDATE document SET current_markdown_artifact_id = ?, updated_at = ? WHERE id = ?`,
          [artifact.id, artifact.createdAt, artifact.documentId]
        );
      }

      if (artifact.documentId && artifact.type === "wiki_page") {
        await connection.execute(
          `UPDATE document SET current_wiki_artifact_id = ?, updated_at = ? WHERE id = ?`,
          [artifact.id, artifact.createdAt, artifact.documentId]
        );
      }

      return artifact;
    });
  }

  async getCurrentDocument(documentId: string): Promise<DocumentCurrentRecord> {
    const document = await this.requireDocument(this.database, documentId);
    const currentVersion = document.currentVersionId
      ? await this.getDocumentVersion(document.currentVersionId)
      : undefined;
    const artifactIds = [document.currentMarkdownArtifactId, document.currentWikiArtifactId].filter(
      (id): id is string => Boolean(id)
    );
    const currentArtifacts = artifactIds.length > 0 ? await this.getArtifactsByIds(artifactIds) : [];

    return {
      document,
      currentVersion,
      currentArtifacts
    };
  }

  async listDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT * FROM document_version WHERE document_id = ? ORDER BY version ASC`,
      [documentId]
    );

    return rows.map(rowToDocumentVersion);
  }

  async listArtifactHistory(documentId: string, type?: Artifact["type"]): Promise<Artifact[]> {
    const params: unknown[] = [documentId];
    const typeFilter = type ? " AND type = ?" : "";

    if (type) {
      params.push(type);
    }

    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT * FROM artifact WHERE document_id = ?${typeFilter} ORDER BY created_at ASC`,
      params
    );

    return rows.map(rowToArtifact);
  }

  private async getDocumentVersion(versionId: string): Promise<DocumentVersion | undefined> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT * FROM document_version WHERE id = ?`,
      [versionId]
    );

    return rows[0] ? rowToDocumentVersion(rows[0]) : undefined;
  }

  private async getArtifactsByIds(artifactIds: string[]): Promise<Artifact[]> {
    const [rows] = await this.database.execute<MysqlRow[]>(
      `SELECT * FROM artifact WHERE id IN (${artifactIds.map(() => "?").join(", ")})`,
      artifactIds
    );
    const artifactsById = new Map(rows.map((row) => [String(row.id), rowToArtifact(row)]));

    return artifactIds.map((id) => artifactsById.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  }

  private async requireDocument(
    executor: MysqlQueryExecutor,
    documentId: string,
    forUpdate = false
  ): Promise<Document> {
    const [rows] = await executor.execute<MysqlRow[]>(
      `SELECT * FROM document WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
      [documentId]
    );
    const row = rows[0];

    if (!row) {
      throw new Error(`Document not found: ${documentId}`);
    }

    return rowToDocument(row);
  }

  private async withTransaction<T>(callback: (connection: MysqlConnection) => Promise<T>): Promise<T> {
    const connection = await this.database.getConnection();

    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

export function rowToDocument(row: MysqlRow): Document {
  return {
    id: stringValue(row.id),
    workflowRunId: stringValue(row.workflow_run_id),
    parentDocumentId: optionalString(row.parent_document_id),
    type: stringValue(row.type) as Document["type"],
    sourceKey: stringValue(row.source_key),
    title: stringValue(row.title),
    status: stringValue(row.status) as Document["status"],
    currentVersionId: optionalString(row.current_version_id),
    currentMarkdownArtifactId: optionalString(row.current_markdown_artifact_id),
    currentWikiArtifactId: optionalString(row.current_wiki_artifact_id),
    createdAt: isoValue(row.created_at),
    updatedAt: isoValue(row.updated_at)
  };
}

export function rowToDocumentVersion(row: MysqlRow): DocumentVersion {
  return {
    id: stringValue(row.id),
    documentId: stringValue(row.document_id),
    version: numberValue(row.version),
    producerJobId: stringValue(row.producer_job_id),
    summary: optionalString(row.summary),
    revisionSummary: optionalString(row.revision_summary),
    revisionJobId: optionalString(row.revision_job_id),
    contentHash: optionalString(row.content_hash),
    createdAt: isoValue(row.created_at)
  };
}

export function rowToArtifact(row: MysqlRow): Artifact {
  return {
    id: stringValue(row.id),
    documentId: optionalString(row.document_id),
    documentVersionId: optionalString(row.document_version_id),
    producerJobId: stringValue(row.producer_job_id),
    type: stringValue(row.type) as Artifact["type"],
    location: stringValue(row.location) as Artifact["location"],
    uri: stringValue(row.uri),
    externalId: optionalString(row.external_id),
    externalVersion: optionalString(row.external_version),
    contentHash: optionalString(row.content_hash),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: isoValue(row.created_at)
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }

  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string database value, got: ${String(value)}`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function isoValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return stringValue(value);
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
