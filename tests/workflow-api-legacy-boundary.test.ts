import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readRepoFile(pathFromRepoRoot: string): string {
  return readFileSync(fileURLToPath(new URL(`../${pathFromRepoRoot}`, import.meta.url)), "utf8");
}

describe("workflow API legacy PRD boundary", () => {
  it("keeps the HTTP server from importing legacy PRD confirmation modules directly", () => {
    const source = readRepoFile("backend/src/workflow-api/server.ts");

    expect(source).toContain("./compatibility-actions");
    expect(source).toContain("compatibilityActionsFactory");
    expect(source).toContain("compatibilityActions");
    expect(source).not.toContain("../legacy/prd-confirmation");
    expect(source).not.toContain("../prd-confirmation");
    expect(source).not.toContain("./legacy-prd-compatibility");
    expect(source).not.toContain("./legacy-prd-server-actions");
    expect(source).not.toContain("createLegacyPrdServerActions");
    expect(source).not.toContain("./legacy-prd-command-projection");
    expect(source).not.toContain("./legacy-prd-read-projection");
    expect(source).not.toContain("./legacy-prd-route-actions");
    expect(source).not.toContain("summarizeLegacyPrd");
    expect(source).not.toContain("legacyPrd.fixture");
    expect(source).not.toContain("legacyPrdActions");
    expect(source).not.toContain("legacyPrd");
    expect(source).not.toContain("context.legacyPrd.");
    expect(source).not.toContain("!context.legacyPrd &&");
    expect(source).not.toContain("context.legacyPrd ||");
    expect(source).not.toContain("context.legacyPrd &&");
    expect(source).toContain("repositoryBackedMode");
    expect(source).not.toContain("requireCompatibilityFixture");
    expect(source).not.toContain("createLegacyPrdEngineTransitionCommandInput");
    expect(source).not.toContain("legacyPrdWorkflowJobCommandInputForFixtureJob");
    expect(source).not.toContain("function summarizeState");
    expect(source).not.toContain("function refreshApprovalGate");
    expect(source).not.toContain("function primaryDocumentIdForJob");
    expect(source).not.toContain("createLegacyPrdSnapshot");
    expect(source).not.toContain("createLegacyPrdCompatibility");
    expect(source).not.toContain("fixture?:");
    expect(source).not.toContain("snapshotMirror?:");
    expect(source).not.toContain("context.fixture");
    expect(source).not.toContain("context.snapshotMirror");
    expect(source).not.toContain("fixture.workflow");
    expect(source).not.toContain("fixture.store");
  });

  it("does not keep the old public transition projection shim around", () => {
    expect(repoFileExists("backend/src/workflow-api/engine-transition-projection.ts")).toBe(false);
  });

  it("keeps product runtime creation from importing legacy PRD persistence directly", () => {
    const source = readRepoFile("backend/src/runtime/create-workflow-api-runtime.ts");

    expect(source).toContain("../workflow-api/legacy-prd-compatibility");
    expect(source).not.toContain("../legacy/prd-confirmation/mysql-snapshot-loader");
    expect(source).not.toContain("../legacy/prd-confirmation/mysql-snapshot-mirror");
    expect(source).not.toContain("snapshotLoader");
    expect(source).not.toContain("fixture?:");
    expect(source).not.toContain("snapshotMirror?:");
  });
});

function repoFileExists(pathFromRepoRoot: string): boolean {
  return existsSync(fileURLToPath(new URL(`../${pathFromRepoRoot}`, import.meta.url)));
}
