import { describe, test, expect } from "vitest";
import { parseWorkflowDefinitionYaml } from "../../backend/src/workflow-definition/parser";
import { validateWorkflowDefinition, WorkflowDefinitionValidationError } from "../../backend/src/workflow-definition/validator";

const GOOD_YAML = `
id: test-workflow
version: 1
name: Test
documentTypes: [prd]
entryStage: start
policy:
  approvalSource: jira_status
  qualityFailureAction: human_clarification
  revisionTrigger: explicit_request
  feedbackSources: [app]
stages:
  start:
    label: Start
    jobTemplate:
      jobType: prd.generate_draft
      runner:
        requiredCapability: document.generate
    on:
      success: done
  done:
    type: terminal
    kind: completed
`;

describe("parseWorkflowDefinitionYaml", () => {
  test("parses a valid YAML", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    expect(def.id).toBe("test-workflow");
    expect(def.version).toBe(1);
    expect(def.entryStage).toBe("start");
    expect(Object.keys(def.stages)).toEqual(["start", "done"]);
  });

  test("rejects YAML missing id", () => {
    const bad = GOOD_YAML.replace(/^id: .+$/m, "");
    expect(() => parseWorkflowDefinitionYaml(bad)).toThrow(/missing required field: id/);
  });

  test("rejects YAML with non-integer version", () => {
    const bad = GOOD_YAML.replace("version: 1", "version: 1.5");
    expect(() => parseWorkflowDefinitionYaml(bad)).toThrow(/invalid version/);
  });
});

describe("validateWorkflowDefinition", () => {
  test("accepts a valid definition", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });

  test("rejects definition with entryStage missing from stages", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    def.entryStage = "nonexistent";
    expect(() => validateWorkflowDefinition(def)).toThrow(WorkflowDefinitionValidationError);
    expect(() => validateWorkflowDefinition(def)).toThrow(/entryStage 'nonexistent'/);
  });

  test("rejects definition with dangling on: target", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    (def.stages.start as any).on.success = "nowhere";
    expect(() => validateWorkflowDefinition(def)).toThrow(/points to undefined target stage 'nowhere'/);
  });

  test("rejects definition with unknown stage.type", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    (def.stages.done as any).type = "weird";
    expect(() => validateWorkflowDefinition(def)).toThrow(/unknown type: 'weird'/);
  });

  test("rejects definition with unreachable stage", () => {
    const def = parseWorkflowDefinitionYaml(GOOD_YAML);
    def.stages["orphan"] = { type: "terminal", kind: "completed" };
    expect(() => validateWorkflowDefinition(def)).toThrow(/Stage 'orphan' is unreachable/);
  });
});
