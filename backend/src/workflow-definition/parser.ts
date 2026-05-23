import { parse } from "yaml";
import type { WorkflowDefinition } from "./schema";

export function parseWorkflowDefinitionYaml(source: string): WorkflowDefinition {
  const parsed = parse(source);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Workflow definition YAML must be a top-level object");
  }

  const definition = parsed as WorkflowDefinition;

  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new Error(`Workflow definition is missing required field: id`);
  }
  if (typeof definition.version !== "number" || !Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error(`Workflow definition '${definition.id}' has invalid version: ${definition.version}`);
  }
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: name`);
  }
  if (!Array.isArray(definition.documentTypes) || definition.documentTypes.length === 0) {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: documentTypes`);
  }
  if (typeof definition.entryStage !== "string" || definition.entryStage.length === 0) {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: entryStage`);
  }
  if (!definition.stages || typeof definition.stages !== "object") {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: stages`);
  }
  if (!definition.policy || typeof definition.policy !== "object") {
    throw new Error(`Workflow definition '${definition.id}' is missing required field: policy`);
  }

  return definition;
}
