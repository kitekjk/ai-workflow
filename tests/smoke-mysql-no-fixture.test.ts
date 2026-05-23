import { describe, expect, it } from "vitest";
import {
  createSmokeLocalRunnerSetup,
  smokeDocumentModeFor,
  smokeImplementationModeFor,
  validateMysqlNoFixtureSmokePrerequisites,
  type MysqlNoFixtureSmokeConfig
} from "../backend/src/smoke/mysql-no-fixture-smoke";
import type { WorkflowJob } from "../backend/src/workflow-core/domain";

describe("mysql no-fixture smoke setup", () => {
  it("keeps stub document mode as the default and can opt into CLI document mode", () => {
    expect(smokeDocumentModeFor({})).toBe("stub");
    expect(smokeDocumentModeFor({ SMOKE_DOCUMENT_MODE: "cli" })).toBe("cli");
    expect(() => smokeDocumentModeFor({ SMOKE_DOCUMENT_MODE: "real" })).toThrow(
      'SMOKE_DOCUMENT_MODE must be "stub" or "cli"'
    );
  });

  it("validates CLI document smoke prerequisites before claiming work", async () => {
    await expect(
      validateMysqlNoFixtureSmokePrerequisites({
        SMOKE_DOCUMENT_MODE: "cli",
        RUNNER_ENGINE: "codex"
      })
    ).rejects.toThrow("CODEX_CLI_PATH is required when SMOKE_DOCUMENT_MODE=cli");

    await expect(
      validateMysqlNoFixtureSmokePrerequisites({
        SMOKE_DOCUMENT_MODE: "cli",
        RUNNER_ENGINE: "codex",
        CODEX_CLI_PATH: process.execPath
      })
    ).resolves.toBeUndefined();

    await expect(
      validateMysqlNoFixtureSmokePrerequisites({
        SMOKE_DOCUMENT_MODE: "cli",
        RUNNER_ENGINE: "ollama",
        CODEX_CLI_PATH: process.execPath
      })
    ).rejects.toThrow('RUNNER_ENGINE must be "claude" or "codex" when SMOKE_DOCUMENT_MODE=cli');
  });

  it("keeps stub implementation mode as the default", () => {
    expect(smokeImplementationModeFor({})).toBe("stub");
    expect(smokeImplementationModeFor({ SMOKE_IMPLEMENTATION_MODE: "github" })).toBe("github");
    expect(() => smokeImplementationModeFor({ SMOKE_IMPLEMENTATION_MODE: "real" })).toThrow(
      'SMOKE_IMPLEMENTATION_MODE must be "stub" or "github"'
    );
  });

  it("can route document jobs through the CLI engine while keeping implementation jobs stubbed", async () => {
    const setup = createSmokeLocalRunnerSetup(
      smokeConfig({
        documentMode: "cli",
        implementationMode: "stub"
      }),
      { RUNNER_ENGINE: "codex" }
    );

    await expect(
      setup.engine.run({
        runner: {
          id: "runner-smoke-test",
          mode: "local",
          status: "online",
          teamIds: [],
          allowedProjectIds: [],
          allowedRepositoryIds: [],
          capabilities: ["document.generate"],
          engines: ["codex"],
          defaultEngine: "codex",
          concurrency: 1
        },
        job: workflowJob({
          id: "job_document_generate",
          jobType: "document.generate",
          input: {
            documentType: "hld"
          }
        })
      })
    ).rejects.toThrow("CODEX_CLI_PATH is required when RUNNER_SKILL_MODE=cli");

    const implementationResult = await setup.engine.run({
      runner: {} as never,
      job: workflowJob({
        id: "job_open_pr",
        jobType: "implementation.open_pr",
        input: {
          sourceDocumentId: "doc_spec_1"
        }
      })
    });

    expect(setup.workspace).toBeUndefined();
    expect(implementationResult.output).toMatchObject({
      status: "succeeded",
      pullRequestUrl: expect.stringContaining("github.example.com/workflow/smoke/pull/")
    });
  });

  it("uses deterministic implementation artifacts in stub mode", async () => {
    const setup = createSmokeLocalRunnerSetup(smokeConfig({ implementationMode: "stub" }), {});
    const result = await setup.engine.run({
      runner: {} as never,
      job: workflowJob({
        id: "job_open_pr",
        jobType: "implementation.open_pr",
        input: {
          sourceDocumentId: "doc_spec_1",
          documentVersionId: "docv_spec_1"
        }
      })
    });

    expect(setup.workspace).toBeUndefined();
    expect(result.output).toMatchObject({
      status: "succeeded",
      pullRequestUrl: expect.stringContaining("github.example.com/workflow/smoke/pull/"),
      documentVersionId: "docv_spec_1"
    });
  });

  it("treats stub implementation status collection as a merged terminal PR", async () => {
    const setup = createSmokeLocalRunnerSetup(smokeConfig({ implementationMode: "stub" }), {});
    const result = await setup.engine.run({
      runner: {} as never,
      job: workflowJob({
        id: "job_collect_pr",
        jobType: "implementation.collect_pr_status",
        input: {
          pullNumber: 42,
          pullRequestUrl: "https://github.example.com/workflow/smoke/pull/42"
        }
      })
    });

    expect(result.output).toMatchObject({
      status: "succeeded",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.example.com/workflow/smoke/pull/42",
      pullRequestState: "closed",
      merged: true,
      reviewStatus: "approved",
      ciStatus: "success"
    });
  });

  it("requires explicit GitHub and workspace settings for github implementation mode", () => {
    expect(() => createSmokeLocalRunnerSetup(smokeConfig({ implementationMode: "github" }), {})).toThrow(
      "SMOKE_IMPLEMENTATION_MODE=github requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO"
    );
    expect(() =>
      createSmokeLocalRunnerSetup(smokeConfig({ implementationMode: "github" }), {
        GITHUB_TOKEN: "ghp_secret",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "workflow-app"
      })
    ).toThrow("GITHUB_CLONE_URL is required for SMOKE_IMPLEMENTATION_MODE=github");
  });
});

function smokeConfig(input: {
  documentMode?: "stub" | "cli";
  implementationMode: "stub" | "github";
}): MysqlNoFixtureSmokeConfig {
  return {
    prdJiraKey: "PRD-SMOKE-TEST",
    actorEmail: "smoke@example.com",
    runnerId: "runner-smoke-test",
    engine: "codex",
    documentMode: input.documentMode ?? "stub",
    implementationMode: input.implementationMode
  };
}

function workflowJob(input: {
  id: string;
  jobType: string;
  input?: Record<string, unknown>;
}): WorkflowJob {
  return {
    id: input.id,
    runId: "run_1",
    jobType: input.jobType,
    status: "running",
    input: input.input ?? {},
    priority: 0,
    requiredCapabilities: [input.jobType],
    executionPolicy: "local_allowed",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z"
  };
}
