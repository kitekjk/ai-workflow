import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowDefinitionYaml } from "../../backend/src/workflow-definition/parser";
import { validateWorkflowDefinition } from "../../backend/src/workflow-definition/validator";
import type { WorkflowDefinition } from "../../backend/src/workflow-definition/schema";

export function loadTestPrdDefinition(): WorkflowDefinition {
  const yamlPath = join(process.cwd(), "workflows", "definitions", "prd-confirmation.v1.yaml");
  const source = readFileSync(yamlPath, "utf8");
  const definition = parseWorkflowDefinitionYaml(source);
  validateWorkflowDefinition(definition);
  return definition;
}
