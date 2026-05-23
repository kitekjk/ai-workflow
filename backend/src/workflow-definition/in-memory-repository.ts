import type { WorkflowDefinitionRecord, WorkflowDefinitionRepository } from "./repository";

export class InMemoryWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  private readonly records = new Map<string, WorkflowDefinitionRecord>();

  private key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  async upsert(record: WorkflowDefinitionRecord): Promise<void> {
    this.records.set(this.key(record.definition.id, record.definition.version), { ...record });
  }

  async deprecatePreviousVersions(id: string, keepVersion: number): Promise<void> {
    for (const record of this.records.values()) {
      if (record.definition.id === id && record.definition.version !== keepVersion) {
        record.status = "deprecated";
      }
    }
  }

  async findByIdAndVersion(id: string, version: number): Promise<WorkflowDefinitionRecord | null> {
    return this.records.get(this.key(id, version)) ?? null;
  }

  async findActiveById(id: string): Promise<WorkflowDefinitionRecord | null> {
    let best: WorkflowDefinitionRecord | null = null;
    for (const record of this.records.values()) {
      if (record.definition.id === id && record.status === "active") {
        if (!best || record.definition.version > best.definition.version) best = record;
      }
    }
    return best;
  }

  async findActiveByDocumentType(documentType: string): Promise<WorkflowDefinitionRecord | null> {
    let best: WorkflowDefinitionRecord | null = null;
    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      if (!record.definition.documentTypes.includes(documentType as never)) continue;
      if (!best || record.definition.version > best.definition.version) best = record;
    }
    return best;
  }

  async listActive(): Promise<WorkflowDefinitionRecord[]> {
    return [...this.records.values()].filter((r) => r.status === "active");
  }
}
