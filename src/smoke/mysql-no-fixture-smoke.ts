import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createWorkflowMysqlPoolFromEnv } from "../mysql/create-mysql-pool";
import { applyMysqlMigrations, loadMysqlMigrations } from "../mysql/migrations";
import {
  createWorkflowApiRuntimeFromEnv,
  type WorkflowApiRuntime,
  type WorkflowApiRuntimeEnv
} from "../runtime/create-workflow-api-runtime";
import { runLocalRunnerDrain, type LocalRunnerDrainResult, type LocalRunnerEngine } from "../local-runner/local-runner";
import { WorkflowApiRunnerClient } from "../local-runner/runner-client";
import { createWorkflowApiServer, type WorkflowApiServer } from "../workflow-api/server";

interface MysqlNoFixtureSmokeSummary {
  prdJiraKey: string;
  actorEmail: string;
  runnerId: string;
  apiUrl: string;
  claims: Array<{
    jobId: string;
    jobType: string;
    resultStatus: string;
  }>;
  drain: {
    stoppedReason: string;
    attempts: number;
    processedJobs: number;
  };
  downstreamDrain: {
    stoppedReason: string;
    attempts: number;
    processedJobs: number;
  };
  lldDrain: {
    stoppedReason: string;
    attempts: number;
    processedJobs: number;
  };
  specDrain: {
    stoppedReason: string;
    attempts: number;
    processedJobs: number;
  };
  implementationDrain: {
    stoppedReason: string;
    attempts: number;
    processedJobs: number;
  };
  finalPrdStatus: unknown;
  downstreamDocuments: Array<{
    id: string;
    type: unknown;
    status: unknown;
    sourceKey: unknown;
  }>;
  pullRequestArtifactCount: number;
}

interface SmokeDocumentSummary {
  id: string;
  type: unknown;
  status: unknown;
  sourceKey: unknown;
}

type FetchImpl = typeof fetch;

export async function runMysqlNoFixtureSmoke(
  env: WorkflowApiRuntimeEnv = process.env,
  fetchImpl: FetchImpl = fetch
): Promise<MysqlNoFixtureSmokeSummary> {
  const smokeEnv = createSmokeEnv(env);
  const config = smokeConfig(smokeEnv);
  await maybeApplyMigrations(smokeEnv);

  const runtime = createWorkflowApiRuntimeFromEnv(smokeEnv);
  let server: WorkflowApiServer | undefined;

  try {
    server = await createWorkflowApiServer({
      fixture: runtime.fixture,
      scheduler: runtime.scheduler,
      documentRepository: runtime.documentRepository,
      jiraIssueReader: runtime.jiraIssueReader,
      wikiFeedbackCollector: runtime.wikiFeedbackCollector,
      snapshotMirror: runtime.snapshotMirror,
      readModel: runtime.readModel,
      prdIntakeCommand: runtime.prdIntakeCommand,
      feedbackRevisionCommand: runtime.feedbackRevisionCommand,
      workflowResultCommand: runtime.workflowResultCommand,
      workflowTransitionCommand: runtime.workflowTransitionCommand,
      repositoryTransitionResultReader: runtime.repositoryTransitionResultReader,
      repositoryTransitionIntervalMs: runtime.repositoryTransitionIntervalMs,
      internalTickIntervalMs: runtime.internalTickIntervalMs,
      auth: runtime.auth
    }).listen(0);

    const intake = await postJson<{ status: string; runId?: string; documentId?: string; jobId?: string }>(
      fetchImpl,
      server.url,
      "/prd/intake",
      {
        prdJiraKey: config.prdJiraKey,
        requestedBy: config.actorEmail
      },
      config.appToken
    );

    if (!intake.runId || !intake.documentId) {
      throw new Error("Smoke intake did not return runId and documentId");
    }

    const runnerClient = new WorkflowApiRunnerClient({
      baseUrl: server.url,
      token: config.runnerToken,
      fetch: fetchImpl
    });
    const runner = {
      id: config.runnerId,
      ownerUserId: config.actorEmail,
      mode: "local" as const,
      allowedProjectIds: ["prd-confirmation"],
      allowedRepositoryIds: ["prd-docs"],
      capabilities: [
        "document.generate",
        "document.evaluate",
        "document.revise",
        "workflow.route",
        "workflow.fanout",
        "implementation.open_pr",
        "implementation.update_pr",
        "implementation.collect_pr_status"
      ],
      engines: [config.engine],
      defaultEngine: config.engine
    };
    const engine = createSmokeLocalRunnerEngine(config.prdJiraKey);

    const drain = await runLocalRunnerDrain({
      client: runnerClient,
      engine,
      runner,
      maxJobs: 5
    });
    const claims = claimSummaries(drain);

    const finalState = await getJson<Record<string, unknown>>(
      fetchImpl,
      server.url,
      `/state/${encodeURIComponent(config.prdJiraKey)}`,
      config.appToken
    );

    if (finalState.prdStatus !== "approval_pending") {
      throw new Error(`Expected final PRD status approval_pending, got: ${String(finalState.prdStatus)}`);
    }

    await approveDocument(fetchImpl, server.url, intake.documentId, config.actorEmail, "Smoke PRD approval", config.appToken);

    const downstreamDrain = await runLocalRunnerDrain({
      client: runnerClient,
      engine,
      runner,
      maxJobs: 6
    });
    const downstreamClaims = claimSummaries(downstreamDrain);
    let downstreamDocuments = await loadDownstreamDocuments(fetchImpl, server.url, intake.runId, config.appToken);
    const hld = requireDocumentOfType(downstreamDocuments, "hld", "approval_pending");

    await approveDocument(fetchImpl, server.url, hld.id, config.actorEmail, "Smoke HLD approval", config.appToken);

    const lldDrain = await runLocalRunnerDrain({
      client: runnerClient,
      engine,
      runner,
      maxJobs: 8
    });
    const lldClaims = claimSummaries(lldDrain);
    downstreamDocuments = await loadDownstreamDocuments(fetchImpl, server.url, intake.runId, config.appToken);
    const llds = requireDocumentsOfType(downstreamDocuments, "lld", "approval_pending", 2);

    for (const lld of llds) {
      await approveDocument(fetchImpl, server.url, lld.id, config.actorEmail, "Smoke LLD approval", config.appToken);
    }

    const specDrain = await runLocalRunnerDrain({
      client: runnerClient,
      engine,
      runner,
      maxJobs: 14
    });
    const specClaims = claimSummaries(specDrain);
    downstreamDocuments = await loadDownstreamDocuments(fetchImpl, server.url, intake.runId, config.appToken);
    const specs = requireDocumentsOfType(downstreamDocuments, "spec", "approval_pending", 4);

    for (const spec of specs) {
      await approveDocument(fetchImpl, server.url, spec.id, config.actorEmail, "Smoke Spec approval", config.appToken);
    }

    const implementationDrain = await runLocalRunnerDrain({
      client: runnerClient,
      engine,
      runner,
      maxJobs: 12
    });
    const implementationClaims = claimSummaries(implementationDrain);
    downstreamDocuments = await loadDownstreamDocuments(fetchImpl, server.url, intake.runId, config.appToken);
    const approvedState = await getJson<Record<string, unknown>>(
      fetchImpl,
      server.url,
      `/state/${encodeURIComponent(config.prdJiraKey)}`,
      config.appToken
    );
    const pullRequestArtifactCount = await countPullRequestArtifacts(
      fetchImpl,
      server.url,
      specs.map((spec) => spec.id),
      config.appToken
    );

    if (approvedState.prdStatus !== "approved") {
      throw new Error(`Expected final approved PRD status, got: ${String(approvedState.prdStatus)}`);
    }

    if (pullRequestArtifactCount < specs.length) {
      throw new Error(`Expected pull request artifacts for specs, got: ${pullRequestArtifactCount}`);
    }

    return {
      prdJiraKey: config.prdJiraKey,
      actorEmail: config.actorEmail,
      runnerId: config.runnerId,
      apiUrl: server.url,
      claims: [...claims, ...downstreamClaims, ...lldClaims, ...specClaims, ...implementationClaims],
      drain: {
        stoppedReason: drain.stoppedReason,
        attempts: drain.attempts,
        processedJobs: drain.processedJobs
      },
      downstreamDrain: {
        stoppedReason: downstreamDrain.stoppedReason,
        attempts: downstreamDrain.attempts,
        processedJobs: downstreamDrain.processedJobs
      },
      lldDrain: {
        stoppedReason: lldDrain.stoppedReason,
        attempts: lldDrain.attempts,
        processedJobs: lldDrain.processedJobs
      },
      specDrain: {
        stoppedReason: specDrain.stoppedReason,
        attempts: specDrain.attempts,
        processedJobs: specDrain.processedJobs
      },
      implementationDrain: {
        stoppedReason: implementationDrain.stoppedReason,
        attempts: implementationDrain.attempts,
        processedJobs: implementationDrain.processedJobs
      },
      finalPrdStatus: approvedState.prdStatus,
      downstreamDocuments,
      pullRequestArtifactCount
    };
  } finally {
    await server?.close();
    await runtime.close();
  }
}

function claimSummaries(drain: LocalRunnerDrainResult): MysqlNoFixtureSmokeSummary["claims"] {
  return drain.results.flatMap((result) =>
    result.status === "idle"
      ? []
      : [
          {
            jobId: result.job.id,
            jobType: result.job.jobType,
            resultStatus: result.result.status
          }
        ]
  );
}

async function approveDocument(
  fetchImpl: FetchImpl,
  baseUrl: string,
  documentId: string,
  actorEmail: string,
  reason: string,
  token?: string
): Promise<void> {
  await postJson(fetchImpl, baseUrl, `/approval-gates/gate_${encodeURIComponent(documentId)}/approve`, {
    requestedBy: actorEmail,
    reason
  }, token);
}

async function loadDownstreamDocuments(
  fetchImpl: FetchImpl,
  baseUrl: string,
  runId: string,
  token?: string
): Promise<SmokeDocumentSummary[]> {
  const runSummary = await getJson<{ documents?: Array<Record<string, unknown>> }>(
    fetchImpl,
    baseUrl,
    `/workflow-runs/${encodeURIComponent(runId)}`,
    token
  );

  return (runSummary.documents ?? [])
    .filter((document) => document.type !== "prd")
    .map((document) => ({
      id: String(document.id),
      type: document.type,
      status: document.status,
      sourceKey: document.sourceKey
    }));
}

function requireDocumentOfType(
  documents: SmokeDocumentSummary[],
  type: string,
  status: string
): SmokeDocumentSummary {
  return requireDocumentsOfType(documents, type, status, 1)[0];
}

function requireDocumentsOfType(
  documents: SmokeDocumentSummary[],
  type: string,
  status: string,
  minimumCount: number
): SmokeDocumentSummary[] {
  const matches = documents.filter((document) => document.type === type && document.status === status);

  if (matches.length < minimumCount) {
    throw new Error(
      `Expected at least ${minimumCount} ${type} document(s) with status ${status}, got: ${JSON.stringify(documents)}`
    );
  }

  return matches;
}

async function countPullRequestArtifacts(
  fetchImpl: FetchImpl,
  baseUrl: string,
  documentIds: string[],
  token?: string
): Promise<number> {
  const histories = await Promise.all(
    documentIds.map((documentId) =>
      getJson<{ artifacts?: Array<Record<string, unknown>> }>(
        fetchImpl,
        baseUrl,
        `/documents/${encodeURIComponent(documentId)}/versions`,
        token
      )
    )
  );

  return histories.reduce(
    (count, history) => count + (history.artifacts ?? []).filter((artifact) => artifact.type === "pull_request").length,
    0
  );
}

function createSmokeLocalRunnerEngine(prdJiraKey: string): LocalRunnerEngine {
  return {
    async run({ job }) {
      if (job.jobType === "prd.generate_draft") {
        return {
          output: {
            status: "succeeded",
            summary: "Smoke PRD draft generated",
            markdown: `# ${prdJiraKey}\n\nSmoke PRD draft.`
          },
          logs: [
            {
              level: "info",
              message: "Smoke PRD draft generated",
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      if (job.jobType === "prd.evaluate_quality") {
        return {
          output: {
            status: "passed",
            score: 0.98,
            summary: "Smoke PRD quality gate passed"
          },
          logs: [
            {
              level: "info",
              message: "Smoke PRD quality gate passed",
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      if (job.jobType === "prd.route_downstream") {
        return {
          output: {
            status: "routed",
            route: "hld",
            rationale: "Smoke PRD is approved and needs an HLD before implementation.",
            downstreamDocuments: [
              {
                type: "hld",
                title: `HLD for ${prdJiraKey}`
              }
            ]
          },
          logs: [
            {
              level: "info",
              message: "Smoke downstream route selected HLD",
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      if (job.jobType === "document.generate" || job.jobType === "document.revise") {
        const documentType = typeof job.input.documentType === "string" ? job.input.documentType : "document";
        const title = typeof job.input.title === "string" ? job.input.title : `${documentType.toUpperCase()} smoke draft`;

        return {
          output: {
            status: "succeeded",
            summary: `${title} generated`,
            markdown: `# ${title}\n\nGenerated by smoke local runner.`
          },
          logs: [
            {
              level: "info",
              message: `Smoke ${documentType} document generated`,
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      if (job.jobType === "document.evaluate") {
        return {
          output: {
            status: "passed",
            score: 0.94,
            summary: "Smoke document quality gate passed"
          },
          logs: [
            {
              level: "info",
              message: "Smoke document quality gate passed",
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      if (job.jobType === "document.fan_out") {
        const sourceDocumentId = typeof job.input.sourceDocumentId === "string" ? job.input.sourceDocumentId : "document";
        const parentDocumentType = typeof job.input.parentDocumentType === "string" ? job.input.parentDocumentType : "document";
        const targetDocumentType = parentDocumentType === "hld" ? "lld" : "spec";

        return {
          output: {
            status: "fanout_ready",
            targetDocumentType,
            rationale: `Smoke ${parentDocumentType} is ready for ${targetDocumentType} fan-out.`,
            downstreamDocuments: [
              {
                type: targetDocumentType,
                title: `${targetDocumentType.toUpperCase()} 1 for ${sourceDocumentId}`
              },
              {
                type: targetDocumentType,
                title: `${targetDocumentType.toUpperCase()} 2 for ${sourceDocumentId}`
              }
            ]
          },
          logs: [
            {
              level: "info",
              message: `Smoke ${parentDocumentType} fan-out selected ${targetDocumentType} documents`,
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      if (job.jobType === "implementation.open_pr") {
        const sourceDocumentId = typeof job.input.sourceDocumentId === "string" ? job.input.sourceDocumentId : job.id;
        const pullRequestNumber = deterministicPullRequestNumber(sourceDocumentId);

        return {
          output: {
            status: "succeeded",
            pullRequestNumber,
            pullRequestUrl: `https://github.example.com/workflow/smoke/pull/${pullRequestNumber}`,
            documentVersionId: job.input.documentVersionId
          },
          logs: [
            {
              level: "info",
              message: "Smoke implementation pull request opened",
              metadata: {
                jobType: job.jobType,
                pullRequestNumber
              }
            }
          ]
        };
      }

      if (job.jobType === "implementation.update_pr") {
        const pullRequestNumber = Number(job.input.pullNumber ?? deterministicPullRequestNumber(job.id));
        const pullRequestUrl =
          typeof job.input.pullRequestUrl === "string"
            ? job.input.pullRequestUrl
            : `https://github.example.com/workflow/smoke/pull/${pullRequestNumber}`;

        return {
          output: {
            status: "succeeded",
            pullRequestNumber,
            pullRequestUrl,
            documentVersionId: job.input.documentVersionId,
            latestCommitSha: `smoke-update-${job.id}`
          },
          logs: [
            {
              level: "info",
              message: "Smoke implementation pull request updated",
              metadata: {
                jobType: job.jobType,
                pullRequestNumber
              }
            }
          ]
        };
      }

      if (job.jobType === "implementation.collect_pr_status") {
        return {
          output: {
            status: "succeeded",
            reviewStatus: "approved",
            ciStatus: "success"
          },
          logs: [
            {
              level: "info",
              message: "Smoke implementation pull request checks passed",
              metadata: {
                jobType: job.jobType
              }
            }
          ]
        };
      }

      throw new Error(`Smoke runner does not support job type: ${job.jobType}`);
    }
  };
}

function createSmokeEnv(env: WorkflowApiRuntimeEnv): WorkflowApiRuntimeEnv {
  return {
    ...env,
    INTEGRATION_MODE: env.INTEGRATION_MODE || "stub",
    WORKFLOW_RUNTIME_STORE: "mysql",
    WORKFLOW_COMPATIBILITY_FIXTURE: "disabled",
    WORKFLOW_REPOSITORY_TRANSITION_MS: "0"
  };
}

function smokeConfig(env: WorkflowApiRuntimeEnv): {
  prdJiraKey: string;
  actorEmail: string;
  runnerId: string;
  engine: string;
  appToken?: string;
  runnerToken?: string;
} {
  const actorEmail =
    optionalEnv(env, "SMOKE_ACTOR_EMAIL") ??
    optionalEnv(env, "LOCAL_RUNNER_OWNER_EMAIL") ??
    optionalEnv(env, "LOCAL_RUNNER_OWNER_USER_ID") ??
    "smoke@example.com";

  return {
    prdJiraKey: optionalEnv(env, "SMOKE_PRD_JIRA_KEY") ?? `PRD-SMOKE-${timestampForKey(new Date())}`,
    actorEmail,
    runnerId: optionalEnv(env, "SMOKE_RUNNER_ID") ?? optionalEnv(env, "LOCAL_RUNNER_ID") ?? "runner-smoke-local",
    engine: optionalEnv(env, "RUNNER_ENGINE") ?? "codex",
    appToken: optionalEnv(env, "WORKFLOW_APP_API_TOKEN"),
    runnerToken: optionalEnv(env, "SMOKE_RUNNER_TOKEN") ?? optionalEnv(env, "LOCAL_RUNNER_TOKEN")
  };
}

async function maybeApplyMigrations(env: WorkflowApiRuntimeEnv): Promise<void> {
  if (env.SMOKE_SKIP_MIGRATIONS === "true") {
    return;
  }

  const database = createWorkflowMysqlPoolFromEnv(env);

  try {
    await applyMysqlMigrations(database, await loadMysqlMigrations());
  } finally {
    await database.end?.();
  }
}

async function postJson<T = Record<string, unknown>>(
  fetchImpl: FetchImpl,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function getJson<T = Record<string, unknown>>(
  fetchImpl: FetchImpl,
  baseUrl: string,
  path: string,
  token?: string
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: jsonHeaders(token)
  });

  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

function jsonHeaders(token: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function timestampForKey(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function deterministicPullRequestNumber(value: string): number {
  return 100 + [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 900;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runMysqlNoFixtureSmoke()
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
