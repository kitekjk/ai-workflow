import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import type { WorkflowDefinitionRecord, WorkflowDefinitionRepository } from "./repository";
import type { WorkflowDefinition } from "./schema";

type MysqlRow = Record<string, unknown>;

export class MysqlWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  constructor(private readonly db: MysqlDatabase) {}

  async upsert(record: WorkflowDefinitionRecord): Promise<void> {
    const { definition, sourcePath, sourceHash, status, importedAt } = record;
    await this.db.execute(
      `INSERT INTO workflow_definition
         (id, version, name, document_types, entry_stage, body_json, source_path, source_hash, status, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name),
         document_types=VALUES(document_types),
         entry_stage=VALUES(entry_stage),
         body_json=VALUES(body_json),
         source_path=VALUES(source_path),
         source_hash=VALUES(source_hash),
         status=VALUES(status),
         imported_at=VALUES(imported_at)`,
      [
        definition.id,
        definition.version,
        definition.name,
        JSON.stringify(definition.documentTypes),
        definition.entryStage,
        JSON.stringify(definition),
        sourcePath,
        sourceHash,
        status,
        importedAt
      ]
    );
  }

  async deprecatePreviousVersions(id: string, keepVersion: number): Promise<void> {
    await this.db.execute(
      `UPDATE workflow_definition SET status='deprecated' WHERE id=? AND version<>? AND status='active'`,
      [id, keepVersion]
    );
  }

  async findByIdAndVersion(id: string, version: number): Promise<WorkflowDefinitionRecord | null> {
    const [rows] = await this.db.execute<MysqlRow[]>(
      `SELECT * FROM workflow_definition WHERE id=? AND version=? LIMIT 1`,
      [id, version]
    );
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async findActiveById(id: string): Promise<WorkflowDefinitionRecord | null> {
    const [rows] = await this.db.execute<MysqlRow[]>(
      `SELECT * FROM workflow_definition WHERE id=? AND status='active' ORDER BY version DESC LIMIT 1`,
      [id]
    );
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async findActiveByDocumentType(documentType: string): Promise<WorkflowDefinitionRecord | null> {
    const [rows] = await this.db.execute<MysqlRow[]>(
      `SELECT * FROM workflow_definition WHERE status='active' AND JSON_CONTAINS(document_types, JSON_QUOTE(?)) ORDER BY version DESC LIMIT 1`,
      [documentType]
    );
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async listActive(): Promise<WorkflowDefinitionRecord[]> {
    const [rows] = await this.db.execute<MysqlRow[]>(
      `SELECT * FROM workflow_definition WHERE status='active' ORDER BY id, version`,
      []
    );
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: MysqlRow): WorkflowDefinitionRecord {
    const bodyJson = row.body_json;
    const definition =
      typeof bodyJson === "string"
        ? (JSON.parse(bodyJson) as WorkflowDefinition)
        : (bodyJson as WorkflowDefinition);
    const importedAtRaw = row.imported_at;
    const importedAt =
      typeof importedAtRaw === "string"
        ? importedAtRaw
        : importedAtRaw instanceof Date
          ? importedAtRaw.toISOString()
          : new Date().toISOString();
    return {
      definition,
      sourcePath: String(row.source_path ?? ""),
      sourceHash: String(row.source_hash ?? ""),
      status: (row.status === "deprecated" ? "deprecated" : "active") as "active" | "deprecated",
      importedAt
    };
  }
}
