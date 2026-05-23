import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowDefinitionYaml } from "./parser";
import { validateWorkflowDefinition } from "./validator";
import type { WorkflowDefinitionRecord, WorkflowDefinitionRepository } from "./repository";

export interface RegistryBootstrapOptions {
  definitionsRoot: string;
  now?: () => Date;
  actorEmail?: string;
}

export interface RegistryBootstrapResult {
  loaded: Array<{ id: string; version: number; sourcePath: string; status: "imported" | "unchanged" }>;
  actorEmail?: string;
}

export class WorkflowDefinitionRegistry {
  constructor(private readonly repository: WorkflowDefinitionRepository) {}

  async bootstrap(options: RegistryBootstrapOptions): Promise<RegistryBootstrapResult> {
    const now = (options.now ?? (() => new Date()))().toISOString();
    const files = await this.findYamlFiles(options.definitionsRoot);
    const loaded: RegistryBootstrapResult["loaded"] = [];

    for (const sourcePath of files) {
      const source = await readFile(sourcePath, "utf8");
      const definition = parseWorkflowDefinitionYaml(source);
      validateWorkflowDefinition(definition);
      const sourceHash = sha256(source);

      const existing = await this.repository.findByIdAndVersion(definition.id, definition.version);
      if (existing && existing.sourceHash === sourceHash) {
        loaded.push({ id: definition.id, version: definition.version, sourcePath, status: "unchanged" });
        continue;
      }

      const record: WorkflowDefinitionRecord = {
        definition,
        sourcePath,
        sourceHash,
        status: "active",
        importedAt: now
      };
      await this.repository.upsert(record);
      await this.repository.deprecatePreviousVersions(definition.id, definition.version);
      loaded.push({ id: definition.id, version: definition.version, sourcePath, status: "imported" });
    }

    return { loaded, actorEmail: options.actorEmail };
  }

  private async findYamlFiles(root: string): Promise<string[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
        .map((e) => join(root, e.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
