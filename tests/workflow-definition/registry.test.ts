import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryWorkflowDefinitionRepository } from "../../backend/src/workflow-definition/in-memory-repository";
import { WorkflowDefinitionRegistry } from "../../backend/src/workflow-definition/registry";

const YAML_V1 = `
id: test-flow
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
      runner: { requiredCapability: x }
    on: { success: end }
  end:
    type: terminal
    kind: completed
`;

const YAML_V2 = YAML_V1.replace("version: 1", "version: 2").replace("name: Test", "name: Test (changed)");

describe("WorkflowDefinitionRegistry.bootstrap", () => {
  let tempDir: string;
  let repo: InMemoryWorkflowDefinitionRepository;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wf-def-"));
    repo = new InMemoryWorkflowDefinitionRepository();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  test("imports a new definition on first run", async () => {
    writeFileSync(join(tempDir, "test.yaml"), YAML_V1);
    const registry = new WorkflowDefinitionRegistry(repo);
    const result = await registry.bootstrap({ definitionsRoot: tempDir });
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0].status).toBe("imported");
  });

  test("idempotent re-run with unchanged file is no-op", async () => {
    writeFileSync(join(tempDir, "test.yaml"), YAML_V1);
    const registry = new WorkflowDefinitionRegistry(repo);
    await registry.bootstrap({ definitionsRoot: tempDir });
    const result = await registry.bootstrap({ definitionsRoot: tempDir });
    expect(result.loaded[0].status).toBe("unchanged");
  });

  test("bumped version is imported and previous is deprecated", async () => {
    writeFileSync(join(tempDir, "test.yaml"), YAML_V1);
    const registry = new WorkflowDefinitionRegistry(repo);
    await registry.bootstrap({ definitionsRoot: tempDir });

    writeFileSync(join(tempDir, "test.yaml"), YAML_V2);
    const result = await registry.bootstrap({ definitionsRoot: tempDir });
    expect(result.loaded[0].version).toBe(2);
    expect(result.loaded[0].status).toBe("imported");

    const v1 = await repo.findByIdAndVersion("test-flow", 1);
    expect(v1?.status).toBe("deprecated");
  });

  test("missing definitionsRoot returns empty result", async () => {
    const registry = new WorkflowDefinitionRegistry(repo);
    const result = await registry.bootstrap({ definitionsRoot: join(tempDir, "nonexistent") });
    expect(result.loaded).toHaveLength(0);
  });
});
