import type { WorkflowDefinition } from "./schema";

export interface WorkflowDefinitionRecord {
  definition: WorkflowDefinition;
  sourcePath: string;
  sourceHash: string;
  status: "active" | "deprecated";
  importedAt: string;
}

export interface WorkflowDefinitionRepository {
  upsert(record: WorkflowDefinitionRecord): Promise<void>;
  deprecatePreviousVersions(id: string, keepVersion: number): Promise<void>;
  findByIdAndVersion(id: string, version: number): Promise<WorkflowDefinitionRecord | null>;
  findActiveById(id: string): Promise<WorkflowDefinitionRecord | null>;
  findActiveByDocumentType(documentType: string): Promise<WorkflowDefinitionRecord | null>;
  listActive(): Promise<WorkflowDefinitionRecord[]>;
}
