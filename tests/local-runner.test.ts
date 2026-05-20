import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDocumentRepository } from "../src/document-core/in-memory-repository";
import {
  CliLocalRunnerEngine,
  JobTemplateCliLocalRunnerEngine,
  normalizeLocalRunnerCliResult
} from "../src/local-runner/cli-engine-adapter";
import { runLocalRunnerOnce, type LocalRunnerEngine } from "../src/local-runner/local-runner";
import { RunnerResultValidationError } from "../src/local-runner/result-schema";
import { WorkflowApiRunnerClient } from "../src/local-runner/runner-client";
import { createPrdConfirmationFixture } from "../src/prd-confirmation/fixture";
import { InMemoryWorkflowRepository } from "../src/workflow-core/in-memory-repository";
import { WorkflowScheduler } from "../src/workflow-core/scheduler";
import { createWorkflowApiServer, type WorkflowApiServer } from "../src/workflow-api/server";

const now = new Date("2026-05-20T00:00:00.000Z");

describe("local runner loop", () => {
  let workflowRepository: InMemoryWorkflowRepository;
  let documentRepository: InMemoryDocumentRepository;
  let server: WorkflowApiServer;
  const workspaceRoots: string[] = [];

  beforeEach(async () => {
    workflowRepository = new InMemoryWorkflowRepository();
    documentRepository = new InMemoryDocumentRepository();
    const fixture = createPrdConfirmationFixture({ qualityPasses: false });
    const scheduler = new WorkflowScheduler(workflowRepository, { leaseMs: 30_000 });

    server = await createWorkflowApiServer({
      fixture,
      scheduler,
      documentRepository
    }).listen(0);
  });

  afterEach(async () => {
    await server.close();
    await Promise.all(workspaceRoots.map((root) => rm(root, { recursive: true, force: true })));
    workspaceRoots.length = 0;
  });

  it("claims assigned work, runs the engine, uploads artifacts, and completes the job", async () => {
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      input: {
        sourceKey: "PRD-100"
      },
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now
    });
    const document = documentRepository.createDocument({
      workflowRunId: run.id,
      type: "prd",
      sourceKey: "PRD-100",
      title: "PRD-100",
      now
    });
    const version = documentRepository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1",
      now
    });
    const engine: LocalRunnerEngine = {
      async run({ job }) {
        return {
          output: {
            status: "drafted",
            jobType: job.jobType
          },
          logs: [
            {
              level: "info",
              message: "Draft generated",
              metadata: {
                sectionCount: 3
              }
            }
          ],
          artifacts: [
            {
              documentId: document.id,
              documentVersionId: version.id,
              type: "document_markdown",
              location: "git",
              uri: "https://git.example.com/prds/PRD-100.md",
              contentHash: "sha256:local-runner"
            }
          ]
        };
      }
    };

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: server.url }),
      engine,
      runner: {
        id: "runner-planner-a",
        ownerUserId: "planner-a",
        mode: "local",
        capabilities: ["document.generate"],
        engines: ["claude"],
        defaultEngine: "claude"
      },
      now
    });

    expect(result).toMatchObject({
      status: "completed",
      result: {
        status: "succeeded",
        output: {
          status: "drafted",
          jobType: "document.generate"
        }
      }
    });
    expect(workflowRepository.workflowJobs[0]).toMatchObject({
      status: "succeeded",
      claimedByRunnerId: "runner-planner-a"
    });
    expect(documentRepository.artifacts).toMatchObject([
      {
        id: "art_1",
        producerJobId: "job_1",
        type: "document_markdown",
        location: "git"
      }
    ]);
    expect(documentRepository.getCurrentDocument(document.id).document.currentMarkdownArtifactId).toBe("art_1");
    expect(workflowRepository.workflowEvents).toMatchObject([
      {
        type: "runner.log",
        message: "Job started",
        metadata: {
          runnerId: "runner-planner-a",
          jobType: "document.generate"
        }
      },
      {
        type: "runner.log",
        message: "Draft generated",
        metadata: {
          runnerId: "runner-planner-a",
          level: "info",
          sectionCount: 3
        }
      }
    ]);
  });

  it("reports engine failures back to the scheduler without completing the job", async () => {
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: "document.evaluate",
      assignedUserId: "qa-a",
      requiredCapabilities: ["document.evaluate"],
      requiredEngine: "codex",
      now
    });
    const engine: LocalRunnerEngine = {
      async run() {
        throw new Error("Codex CLI returned invalid JSON");
      }
    };

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: server.url }),
      engine,
      runner: {
        id: "runner-qa-a",
        ownerUserId: "qa-a",
        mode: "local",
        capabilities: ["document.evaluate"],
        engines: ["codex"],
        defaultEngine: "codex",
        retryableEngineErrors: true
      },
      now
    });

    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        errorCode: "runner_engine_error",
        errorMessage: "Codex CLI returned invalid JSON"
      }
    });
    expect(workflowRepository.workflowJobs[0]).toMatchObject({
      status: "retrying",
      claimedByRunnerId: undefined
    });
  });

  it("records invalid structured runner output as a retryable runner failure", async () => {
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: "document.generate",
      assignedUserId: "planner-a",
      requiredCapabilities: ["document.generate"],
      requiredEngine: "claude",
      now
    });
    const engine = {
      async run() {
        return {
          output: {
            summary: "missing status"
          }
        };
      }
    } as LocalRunnerEngine;

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: server.url }),
      engine,
      runner: {
        id: "runner-planner-a",
        ownerUserId: "planner-a",
        mode: "local",
        capabilities: ["document.generate"],
        engines: ["claude"],
        defaultEngine: "claude",
        retryableEngineErrors: true
      },
      now
    });

    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        errorCode: "runner_engine_error",
        errorMessage: "output.status must be a non-empty string"
      }
    });
    expect(workflowRepository.workflowJobs[0]).toMatchObject({
      status: "retrying"
    });
  });

  it("prepares a job workspace and uploads generated files from inside it", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-runner-"));
    workspaceRoots.push(workspaceRoot);
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.generate",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.generate"],
      requiredEngine: "codex",
      now
    });
    const document = documentRepository.createDocument({
      workflowRunId: run.id,
      type: "spec",
      sourceKey: "PRD-100",
      title: "PRD-100 Spec",
      now
    });
    const version = documentRepository.createDocumentVersion({
      documentId: document.id,
      producerJobId: "job_1",
      now
    });
    const engine: LocalRunnerEngine = {
      async run({ workspaceDir }) {
        expect(workspaceDir).toBeTruthy();
        await mkdir(join(workspaceDir ?? "", "out"), { recursive: true });
        await writeFile(join(workspaceDir ?? "", "out", "spec.md"), "# Generated Spec\n");

        return {
          output: {
            status: "generated"
          },
          generatedFiles: [
            {
              path: "out/spec.md",
              documentId: document.id,
              documentVersionId: version.id,
              metadata: {
                label: "spec markdown"
              }
            }
          ]
        };
      }
    };

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: server.url }),
      engine,
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["spec.generate"],
        engines: ["codex"],
        defaultEngine: "codex"
      },
      workspace: {
        rootDir: workspaceRoot
      },
      now
    });

    expect(result.status).toBe("completed");
    expect(documentRepository.artifacts).toMatchObject([
      {
        documentId: "doc_1",
        documentVersionId: "docv_1",
        producerJobId: "job_1",
        type: "generated_file",
        location: "local_workspace",
        uri: "local-workspace:out/spec.md",
        contentHash: expect.stringMatching(/^sha256:/),
        metadata: {
          label: "spec markdown",
          relativePath: "out/spec.md",
          sizeBytes: 17
        }
      }
    ]);
  });

  it("rejects generated files outside the prepared workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-runner-"));
    workspaceRoots.push(workspaceRoot);
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.generate",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.generate"],
      requiredEngine: "codex",
      now
    });
    const engine: LocalRunnerEngine = {
      async run() {
        return {
          output: {
            status: "generated"
          },
          generatedFiles: [
            {
              path: "../outside.md"
            }
          ]
        };
      }
    };

    const result = await runLocalRunnerOnce({
      client: new WorkflowApiRunnerClient({ baseUrl: server.url }),
      engine,
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["spec.generate"],
        engines: ["codex"],
        defaultEngine: "codex"
      },
      workspace: {
        rootDir: workspaceRoot
      },
      now
    });

    expect(result).toMatchObject({
      status: "failed",
      result: {
        status: "failed",
        errorCode: "runner_engine_error",
        errorMessage: "../outside.md must stay inside runner workspace"
      }
    });
    expect(workflowRepository.workflowJobs[0]).toMatchObject({
      status: "retrying"
    });
    expect(documentRepository.artifacts).toEqual([]);
  });

  it("acknowledges cancellation and skips artifact publishing after engine returns", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-runner-"));
    workspaceRoots.push(workspaceRoot);
    const run = workflowRepository.createWorkflowRun({
      workflowDefinitionId: "prd_to_spec",
      sourceType: "jira",
      sourceKey: "PRD-100",
      now
    });
    workflowRepository.createWorkflowJob({
      runId: run.id,
      jobType: "spec.generate",
      assignedUserId: "dev-a",
      requiredCapabilities: ["spec.generate"],
      requiredEngine: "codex",
      now
    });
    const client = new WorkflowApiRunnerClient({ baseUrl: server.url });
    const engine: LocalRunnerEngine = {
      async run({ job, workspaceDir }) {
        await mkdir(join(workspaceDir ?? "", "out"), { recursive: true });
        await writeFile(join(workspaceDir ?? "", "out", "spec.md"), "# Canceled Spec\n");
        await client.requestCancellation({
          jobId: job.id,
          requestedBy: "planner-a",
          reason: "Superseded while running",
          now: new Date("2026-05-20T00:00:01.000Z")
        });

        return {
          output: {
            status: "generated"
          },
          generatedFiles: [
            {
              path: "out/spec.md"
            }
          ]
        };
      }
    };

    const result = await runLocalRunnerOnce({
      client,
      engine,
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        capabilities: ["spec.generate"],
        engines: ["codex"],
        defaultEngine: "codex"
      },
      workspace: {
        rootDir: workspaceRoot
      },
      now
    });

    expect(result).toMatchObject({
      status: "canceled",
      result: {
        status: "canceled",
        output: {
          status: "canceled"
        }
      }
    });
    expect(workflowRepository.workflowJobs[0]).toMatchObject({
      status: "canceled",
      claimedByRunnerId: undefined
    });
    expect(documentRepository.artifacts).toEqual([]);
  });

  it("normalizes CLI JSON into output and artifact uploads", () => {
    expect(
      normalizeLocalRunnerCliResult({
        output: {
          status: "succeeded"
        },
        artifacts: [
          {
            documentId: "doc_1",
            documentVersionId: "docv_1",
            type: "document_markdown",
            location: "git",
            uri: "https://git.example.com/prds/PRD-100.md",
            metadata: {
              path: "prds/PRD-100.md"
            }
          }
        ],
        generatedFiles: [
          {
            path: "out/spec.md",
            documentId: "doc_1",
            documentVersionId: "docv_1"
          }
        ],
        logs: [
          {
            level: "debug",
            message: "workspace ready",
            metadata: {
              elapsedMs: 10
            }
          }
        ]
      })
    ).toEqual({
      output: {
        status: "succeeded"
      },
      artifacts: [
        {
          documentId: "doc_1",
          documentVersionId: "docv_1",
          type: "document_markdown",
          location: "git",
          uri: "https://git.example.com/prds/PRD-100.md",
          metadata: {
            path: "prds/PRD-100.md"
          }
        }
      ],
      generatedFiles: [
        {
          path: "out/spec.md",
          documentId: "doc_1",
          documentVersionId: "docv_1"
        }
      ],
      logs: [
        {
          level: "debug",
          message: "workspace ready",
          metadata: {
            elapsedMs: 10
          }
        }
      ]
    });
  });

  it("rejects CLI JSON that does not match the runner result schema", () => {
    expect(() =>
      normalizeLocalRunnerCliResult({
        output: {
          status: "succeeded"
        },
        artifacts: [
          {
            type: "generated_file",
            location: "local_workspace"
          }
        ]
      })
    ).toThrow(RunnerResultValidationError);

    expect(() =>
      normalizeLocalRunnerCliResult({
        output: {
          summary: "missing status"
        }
      })
    ).toThrow("output.status must be a non-empty string");
  });

  it("retains CLI stderr and stdout size as runner logs", async () => {
    const engine = new CliLocalRunnerEngine({
      async runJsonWithProcessOutput() {
        return {
          output: {
            output: {
              status: "succeeded"
            },
            logs: [
              {
                level: "info",
                message: "engine planned sections"
              }
            ]
          },
          stdout: '{"output":{"status":"succeeded"}}\n',
          stderr: "using cached auth ghp_secret\n"
        };
      }
    } as never, {
      secretEnv: {
        GITHUB_TOKEN: "ghp_secret"
      }
    });

    const result = await engine.run({
      runner: {
        id: "runner-dev-a",
        mode: "local",
        status: "online",
        teamIds: [],
        allowedProjectIds: [],
        allowedRepositoryIds: [],
        capabilities: ["document.generate"],
        engines: ["codex"],
        concurrency: 1
      },
      job: {
        id: "job_1",
        runId: "run_1",
        jobType: "document.generate",
        status: "running",
        input: {},
        priority: 0,
        requiredCapabilities: ["document.generate"],
        executionPolicy: "local_allowed",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      }
    });

    expect(result.logs).toEqual([
      {
        level: "info",
        message: "engine planned sections"
      },
      {
        level: "debug",
        message: "CLI stderr",
        metadata: {
          stderr: "using cached auth [REDACTED]",
          stderrBytes: 29
        }
      },
      {
        level: "debug",
        message: "CLI stdout parsed",
        metadata: {
          stdoutBytes: 34
        }
      }
    ]);
  });

  it("builds the CLI engine from the claimed job template", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ai-workflow-template-runner-"));
    workspaceRoots.push(workspaceRoot);
    const fakeCodex = join(workspaceRoot, "codex");
    const argsFile = join(workspaceRoot, "args.json");
    const cwdFile = join(workspaceRoot, "cwd.txt");
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd().replace(/\\\\/g, "/"));
const outputIndex = args.indexOf("--output-last-message");
fs.writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "succeeded",
  summary: "selected codex from job template"
}));
`
    );
    await chmod(fakeCodex, 0o755);

    const engine = new JobTemplateCliLocalRunnerEngine({
      env: {
        RUNNER_ENGINE: "claude",
        CLAUDE_CLI_PATH: "claude"
      },
      outputLanguage: "ko"
    });
    const result = await engine.run({
      runner: {
        id: "runner-dev-a",
        ownerUserId: "dev-a",
        mode: "local",
        status: "online",
        teamIds: [],
        allowedProjectIds: [],
        allowedRepositoryIds: [],
        capabilities: ["document.generate"],
        engines: ["claude", "codex"],
        defaultEngine: "claude",
        concurrency: 1
      },
      job: {
        id: "job_1",
        runId: "run_1",
        jobType: "document.generate",
        status: "running",
        input: {
          runnerJobTemplate: {
            runner: {
              engine: "codex",
              command: fakeCodex,
              sandbox: "workspace-write",
              workdir: "."
            }
          }
        },
        priority: 0,
        requiredCapabilities: ["document.generate"],
        requiredEngine: "codex",
        executionPolicy: "local_allowed",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      },
      workspaceDir: workspaceRoot
    });

    expect(result.output).toEqual({
      status: "succeeded",
      summary: "selected codex from job template"
    });
    expect(JSON.parse(await readFile(argsFile, "utf8"))).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
    expect(await readFile(cwdFile, "utf8")).toBe(workspaceRoot.replace(/\\/g, "/"));
  });
});
