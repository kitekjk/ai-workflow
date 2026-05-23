import { MysqlDocumentRepository } from "../document-core/mysql-repository";
import type { DocumentRepository } from "../document-core/repository";
import { createWorkflowMysqlPoolFromEnv, type MysqlPoolEnv } from "../mysql/create-mysql-pool";
import type { JiraIssueReader, WikiFeedbackCollector } from "../integrations/workflow-ports";
import { WorkflowScheduler } from "../workflow-core/scheduler";
import { MysqlWorkflowRepository, type MysqlDatabase } from "../workflow-core/mysql-repository";
import {
  MysqlFeedbackRevisionCommand,
  type FeedbackRevisionCommand
} from "../workflow-api/feedback-revision-command";
import { MysqlWorkflowApiReadModel, type WorkflowApiReadModel } from "../workflow-api/mysql-read-model";
import {
  MysqlWorkflowIntakeCommand,
  type WorkflowIntakeCommand
} from "../workflow-api/workflow-intake-command";
import { MysqlWorkflowResultCommand, type WorkflowResultCommand } from "../workflow-api/workflow-result-command";
import {
  MysqlWorkflowTransitionCommand,
  type WorkflowTransitionCommand
} from "../workflow-api/workflow-transition-command";
import { MysqlRepositoryTransitionWorkReader } from "../workflow-api/repository-transition-work-reader";
import type { RepositoryTransitionPendingResultReader } from "../workflow-api/repository-transition-processor";
import type { WorkflowApiAuthConfig } from "../workflow-api/server";
import {
  createLegacyPrdCompatibility,
  createLegacyPrdSnapshotPersistence,
  type LegacyPrdCompatibility,
  type LegacyPrdSnapshotLoadResult
} from "../workflow-api/legacy-prd-compatibility";
import {
  createJiraIssueReaderFromEnv,
  createStubJiraIssueReader
} from "./integration-config";
import { createLegacyPrdRuntimeFromEnv } from "./legacy-prd-runtime";

export interface WorkflowApiRuntime {
  legacyPrd?: LegacyPrdCompatibility;
  scheduler?: WorkflowScheduler;
  documentRepository?: DocumentRepository;
  jiraIssueReader?: JiraIssueReader;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  restorePrdSnapshot?: () => Promise<LegacyPrdSnapshotLoadResult>;
  readModel?: WorkflowApiReadModel;
  workflowIntakeCommand?: WorkflowIntakeCommand;
  prdIntakeCommand?: WorkflowIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  repositoryTransitionResultReader?: RepositoryTransitionPendingResultReader;
  auth?: WorkflowApiAuthConfig;
  repositoryTransitionIntervalMs?: number;
  schedulerRecoveryIntervalMs?: number;
  internalTickIntervalMs?: number;
  runtimeStore: WorkflowRuntimeStore;
  close(): Promise<void>;
}

export type WorkflowRuntimeStore = "memory" | "mysql";

export interface WorkflowApiRuntimeEnv extends NodeJS.ProcessEnv, MysqlPoolEnv {
  WORKFLOW_RUNTIME_STORE?: string;
  WORKFLOW_JOB_LEASE_MS?: string;
  WORKFLOW_RUNNER_OFFLINE_AFTER_MS?: string;
  WORKFLOW_COMPATIBILITY_FIXTURE?: string;
  WORKFLOW_INTERNAL_TICK_MS?: string;
  WORKFLOW_SCHEDULER_RECOVERY_MS?: string;
  WORKFLOW_REPOSITORY_TRANSITION_MS?: string;
  WORKFLOW_REPOSITORY_TRANSITION_WORKER_ID?: string;
  WORKFLOW_REPOSITORY_TRANSITION_LEASE_MS?: string;
  WORKFLOW_APP_API_TOKEN?: string;
  WORKFLOW_RUNNER_TOKENS?: string;
}

export function createWorkflowApiRuntimeFromEnv(env: WorkflowApiRuntimeEnv): WorkflowApiRuntime {
  const runtimeStore = parseWorkflowRuntimeStore(env.WORKFLOW_RUNTIME_STORE);
  const useCompatibilityFixture = parseCompatibilityFixtureMode(env.WORKFLOW_COMPATIBILITY_FIXTURE, runtimeStore);
  const fixture = useCompatibilityFixture ? createLegacyPrdRuntimeFromEnv(env) : undefined;
  const internalTickIntervalMs = fixture ? parseInternalTickIntervalMs(env.WORKFLOW_INTERNAL_TICK_MS) : undefined;
  const auth = parseWorkflowApiAuthConfig(env);

  if (runtimeStore === "memory") {
    if (!fixture) {
      throw new Error("Memory runtime requires the compatibility fixture");
    }

    return {
      legacyPrd: createLegacyPrdCompatibility({ fixture }),
      wikiFeedbackCollector: fixture.wikiFeedbackCollector,
      internalTickIntervalMs,
      auth,
      runtimeStore,
      close: async () => {}
    };
  }

  const database = createWorkflowMysqlPoolFromEnv(env);
  const workflowRepository = new MysqlWorkflowRepository(database);
  const documentRepository = new MysqlDocumentRepository(database);
  const leaseMs = parseLeaseMs(env.WORKFLOW_JOB_LEASE_MS);
  const scheduler = new WorkflowScheduler(workflowRepository, {
    leaseMs,
    runnerOfflineAfterMs: parseRunnerOfflineAfterMs(env.WORKFLOW_RUNNER_OFFLINE_AFTER_MS, leaseMs)
  });
  const schedulerRecoveryIntervalMs = parseSchedulerRecoveryIntervalMs(env.WORKFLOW_SCHEDULER_RECOVERY_MS);
  const legacyPrdSnapshotPersistence = fixture ? createLegacyPrdSnapshotPersistence(database, fixture) : undefined;
  const legacyPrd = createLegacyPrdCompatibility({
    fixture,
    snapshotMirror: legacyPrdSnapshotPersistence?.snapshotMirror
  });
  const readModel = new MysqlWorkflowApiReadModel(database);
  const workflowIntakeCommand = new MysqlWorkflowIntakeCommand(database);
  const feedbackRevisionCommand = new MysqlFeedbackRevisionCommand(database);
  const workflowResultCommand = new MysqlWorkflowResultCommand(database);
  const workflowTransitionCommand = new MysqlWorkflowTransitionCommand(database);
  const repositoryTransitionResultReader = fixture
    ? undefined
    : new MysqlRepositoryTransitionWorkReader(database, {
        workerId: env.WORKFLOW_REPOSITORY_TRANSITION_WORKER_ID,
        leaseMs: parseRepositoryTransitionLeaseMs(env.WORKFLOW_REPOSITORY_TRANSITION_LEASE_MS)
      });
  const repositoryTransitionIntervalMs = fixture
    ? undefined
    : parseRepositoryTransitionIntervalMs(env.WORKFLOW_REPOSITORY_TRANSITION_MS);
  const jiraIssueReader = !fixture ? createNoFixtureJiraIssueReader(env) : undefined;

  return {
    legacyPrd,
    scheduler,
    documentRepository,
    jiraIssueReader,
    wikiFeedbackCollector: fixture?.wikiFeedbackCollector,
    restorePrdSnapshot: legacyPrdSnapshotPersistence?.restorePrdSnapshot,
    readModel,
    workflowIntakeCommand,
    prdIntakeCommand: workflowIntakeCommand,
    feedbackRevisionCommand,
    workflowResultCommand,
    workflowTransitionCommand,
    repositoryTransitionResultReader,
    auth,
    repositoryTransitionIntervalMs,
    schedulerRecoveryIntervalMs,
    internalTickIntervalMs,
    runtimeStore,
    close: () => closeMysqlDatabase(database)
  };
}

function parseCompatibilityFixtureMode(value: string | undefined, runtimeStore: WorkflowRuntimeStore): boolean {
  if (!value) {
    return runtimeStore === "memory";
  }

  if (value === "enabled") {
    return true;
  }

  if (value === "disabled" && runtimeStore === "mysql") {
    return false;
  }

  if (value === "disabled") {
    throw new Error("WORKFLOW_COMPATIBILITY_FIXTURE=disabled requires WORKFLOW_RUNTIME_STORE=mysql");
  }

  throw new Error(`WORKFLOW_COMPATIBILITY_FIXTURE must be "enabled" or "disabled", got: ${value}`);
}

export function parseWorkflowRuntimeStore(value: string | undefined): WorkflowRuntimeStore {
  if (!value || value === "mysql") {
    return "mysql";
  }

  if (value === "memory") {
    return "memory";
  }

  throw new Error(`WORKFLOW_RUNTIME_STORE must be "memory" or "mysql", got: ${value}`);
}

export function parseLeaseMs(value: string | undefined): number {
  if (!value) {
    return 30_000;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKFLOW_JOB_LEASE_MS must be a positive integer, got: ${value}`);
  }

  return parsed;
}

export function parseRunnerOfflineAfterMs(value: string | undefined, leaseMs = 30_000): number {
  if (!value) {
    return leaseMs * 2;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKFLOW_RUNNER_OFFLINE_AFTER_MS must be a positive integer, got: ${value}`);
  }

  return parsed;
}

export function parseWorkflowApiAuthConfig(env: Pick<
  WorkflowApiRuntimeEnv,
  "WORKFLOW_APP_API_TOKEN" | "WORKFLOW_RUNNER_TOKENS"
>): WorkflowApiAuthConfig | undefined {
  const appToken = optionalNonEmptyString(env.WORKFLOW_APP_API_TOKEN);
  const runnerTokens = parseRunnerTokens(env.WORKFLOW_RUNNER_TOKENS);

  if (!appToken && Object.keys(runnerTokens).length === 0) {
    return undefined;
  }

  return {
    appToken,
    runnerTokens: Object.keys(runnerTokens).length > 0 ? runnerTokens : undefined
  };
}

function parseRunnerTokens(value: string | undefined): Record<string, string> {
  const trimmed = optionalNonEmptyString(value);

  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;

    if (!isStringRecord(parsed)) {
      throw new Error("WORKFLOW_RUNNER_TOKENS JSON must be an object of runner id to token strings");
    }

    return parsed;
  }

  return Object.fromEntries(
    trimmed.split(",").map((pair) => {
      const separatorIndex = pair.indexOf(":");

      if (separatorIndex < 1 || separatorIndex === pair.length - 1) {
        throw new Error("WORKFLOW_RUNNER_TOKENS must use runnerId:token pairs");
      }

      const runnerId = pair.slice(0, separatorIndex).trim();
      const token = pair.slice(separatorIndex + 1).trim();

      if (!runnerId || !token) {
        throw new Error("WORKFLOW_RUNNER_TOKENS must use non-empty runnerId:token pairs");
      }

      return [runnerId, token];
    })
  );
}

function optionalNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string" && item.length > 0)
  );
}

function parseInternalTickIntervalMs(value: string | undefined): number | undefined {
  if (!value) {
    return 1_000;
  }

  if (value === "0" || value === "disabled") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKFLOW_INTERNAL_TICK_MS must be a positive integer, 0, or "disabled", got: ${value}`);
  }

  return parsed;
}

function parseRepositoryTransitionIntervalMs(value: string | undefined): number | undefined {
  if (!value) {
    return 1_000;
  }

  if (value === "0" || value === "disabled") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKFLOW_REPOSITORY_TRANSITION_MS must be a positive integer, 0, or "disabled", got: ${value}`);
  }

  return parsed;
}

function parseSchedulerRecoveryIntervalMs(value: string | undefined): number | undefined {
  if (!value) {
    return 1_000;
  }

  if (value === "0" || value === "disabled") {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKFLOW_SCHEDULER_RECOVERY_MS must be a positive integer, 0, or "disabled", got: ${value}`);
  }

  return parsed;
}

function parseRepositoryTransitionLeaseMs(value: string | undefined): number {
  if (!value) {
    return 30_000;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`WORKFLOW_REPOSITORY_TRANSITION_LEASE_MS must be a positive integer, got: ${value}`);
  }

  return parsed;
}

async function closeMysqlDatabase(database: MysqlDatabase): Promise<void> {
  await database.end?.();
}

function createNoFixtureJiraIssueReader(env: WorkflowApiRuntimeEnv): JiraIssueReader {
  return env.INTEGRATION_MODE === "real" ? createJiraIssueReaderFromEnv(env) : createStubJiraIssueReader();
}
