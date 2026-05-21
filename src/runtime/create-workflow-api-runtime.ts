import { MysqlDocumentRepository } from "../document-core/mysql-repository";
import type { DocumentRepository } from "../document-core/repository";
import { createWorkflowMysqlPoolFromEnv, type MysqlPoolEnv } from "../mysql/create-mysql-pool";
import {
  MysqlPrdSnapshotLoader,
  type PrdSnapshotLoader,
  type PrdSnapshotLoadResult
} from "../prd-confirmation/mysql-snapshot-loader";
import { MysqlPrdSnapshotMirror, type PrdSnapshotMirror } from "../prd-confirmation/mysql-snapshot-mirror";
import type { JiraIssueReader, WikiFeedbackCollector } from "../prd-confirmation/ports";
import { WorkflowScheduler } from "../workflow-core/scheduler";
import { MysqlWorkflowRepository, type MysqlDatabase } from "../workflow-core/mysql-repository";
import {
  MysqlFeedbackRevisionCommand,
  type FeedbackRevisionCommand
} from "../workflow-api/feedback-revision-command";
import { MysqlWorkflowApiReadModel, type WorkflowApiReadModel } from "../workflow-api/mysql-read-model";
import { MysqlPrdIntakeCommand, type PrdIntakeCommand } from "../workflow-api/prd-intake-command";
import { MysqlWorkflowResultCommand, type WorkflowResultCommand } from "../workflow-api/workflow-result-command";
import {
  MysqlWorkflowTransitionCommand,
  type WorkflowTransitionCommand
} from "../workflow-api/workflow-transition-command";
import { createJiraIssueReaderFromEnv, createRuntimeFromEnv, type RuntimeFixture } from "./create-runtime";

export interface WorkflowApiRuntime {
  fixture?: RuntimeFixture;
  scheduler?: WorkflowScheduler;
  documentRepository?: DocumentRepository;
  jiraIssueReader?: JiraIssueReader;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  snapshotMirror?: PrdSnapshotMirror;
  snapshotLoader?: PrdSnapshotLoader;
  restorePrdSnapshot?: () => Promise<PrdSnapshotLoadResult>;
  readModel?: WorkflowApiReadModel;
  prdIntakeCommand?: PrdIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  internalTickIntervalMs?: number;
  runtimeStore: WorkflowRuntimeStore;
  close(): Promise<void>;
}

export type WorkflowRuntimeStore = "memory" | "mysql";

export interface WorkflowApiRuntimeEnv extends NodeJS.ProcessEnv, MysqlPoolEnv {
  WORKFLOW_RUNTIME_STORE?: string;
  WORKFLOW_JOB_LEASE_MS?: string;
  WORKFLOW_COMPATIBILITY_FIXTURE?: string;
  WORKFLOW_INTERNAL_TICK_MS?: string;
}

export function createWorkflowApiRuntimeFromEnv(env: WorkflowApiRuntimeEnv): WorkflowApiRuntime {
  const runtimeStore = parseWorkflowRuntimeStore(env.WORKFLOW_RUNTIME_STORE);
  const useCompatibilityFixture = parseCompatibilityFixtureMode(env.WORKFLOW_COMPATIBILITY_FIXTURE, runtimeStore);
  const fixture = useCompatibilityFixture ? createRuntimeFromEnv(env) : undefined;
  const internalTickIntervalMs = fixture ? parseInternalTickIntervalMs(env.WORKFLOW_INTERNAL_TICK_MS) : undefined;

  if (runtimeStore === "memory") {
    if (!fixture) {
      throw new Error("Memory runtime requires the compatibility fixture");
    }

    return {
      fixture,
      wikiFeedbackCollector: fixture.wikiFeedbackCollector,
      internalTickIntervalMs,
      runtimeStore,
      close: async () => {}
    };
  }

  const database = createWorkflowMysqlPoolFromEnv(env);
  const workflowRepository = new MysqlWorkflowRepository(database);
  const documentRepository = new MysqlDocumentRepository(database);
  const scheduler = new WorkflowScheduler(workflowRepository, {
    leaseMs: parseLeaseMs(env.WORKFLOW_JOB_LEASE_MS)
  });
  const snapshotMirror = fixture ? new MysqlPrdSnapshotMirror(database) : undefined;
  const snapshotLoader = fixture ? new MysqlPrdSnapshotLoader(database) : undefined;
  const readModel = new MysqlWorkflowApiReadModel(database);
  const prdIntakeCommand = new MysqlPrdIntakeCommand(database);
  const feedbackRevisionCommand = new MysqlFeedbackRevisionCommand(database);
  const workflowResultCommand = new MysqlWorkflowResultCommand(database);
  const workflowTransitionCommand = new MysqlWorkflowTransitionCommand(database);
  const jiraIssueReader = !fixture && env.INTEGRATION_MODE === "real" ? createJiraIssueReaderFromEnv(env) : undefined;

  return {
    fixture,
    scheduler,
    documentRepository,
    jiraIssueReader,
    wikiFeedbackCollector: fixture?.wikiFeedbackCollector,
    snapshotMirror,
    snapshotLoader,
    restorePrdSnapshot: fixture && snapshotLoader ? () => snapshotLoader.loadInto(fixture.store) : undefined,
    readModel,
    prdIntakeCommand,
    feedbackRevisionCommand,
    workflowResultCommand,
    workflowTransitionCommand,
    internalTickIntervalMs,
    runtimeStore,
    close: () => closeMysqlDatabase(database)
  };
}

function parseCompatibilityFixtureMode(value: string | undefined, runtimeStore: WorkflowRuntimeStore): boolean {
  if (!value || value === "enabled") {
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
  if (!value || value === "memory") {
    return "memory";
  }

  if (value === "mysql") {
    return "mysql";
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

async function closeMysqlDatabase(database: MysqlDatabase): Promise<void> {
  await database.end?.();
}
