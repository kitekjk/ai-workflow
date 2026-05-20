import { MysqlDocumentRepository } from "../document-core/mysql-repository";
import type { DocumentRepository } from "../document-core/repository";
import { createWorkflowMysqlPoolFromEnv } from "../mysql/create-mysql-pool";
import {
  MysqlPrdSnapshotLoader,
  type PrdSnapshotLoader,
  type PrdSnapshotLoadResult
} from "../prd-confirmation/mysql-snapshot-loader";
import { MysqlPrdSnapshotMirror, type PrdSnapshotMirror } from "../prd-confirmation/mysql-snapshot-mirror";
import type { WikiFeedbackCollector } from "../prd-confirmation/ports";
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
import { createRuntimeFromEnv, type RuntimeFixture } from "./create-runtime";

export interface WorkflowApiRuntime {
  fixture: RuntimeFixture;
  scheduler?: WorkflowScheduler;
  documentRepository?: DocumentRepository;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  snapshotMirror?: PrdSnapshotMirror;
  snapshotLoader?: PrdSnapshotLoader;
  restorePrdSnapshot?: () => Promise<PrdSnapshotLoadResult>;
  readModel?: WorkflowApiReadModel;
  prdIntakeCommand?: PrdIntakeCommand;
  feedbackRevisionCommand?: FeedbackRevisionCommand;
  workflowResultCommand?: WorkflowResultCommand;
  workflowTransitionCommand?: WorkflowTransitionCommand;
  runtimeStore: WorkflowRuntimeStore;
  close(): Promise<void>;
}

export type WorkflowRuntimeStore = "memory" | "mysql";

export interface WorkflowApiRuntimeEnv extends NodeJS.ProcessEnv {
  WORKFLOW_RUNTIME_STORE?: string;
  WORKFLOW_JOB_LEASE_MS?: string;
}

export function createWorkflowApiRuntimeFromEnv(env: WorkflowApiRuntimeEnv): WorkflowApiRuntime {
  const fixture = createRuntimeFromEnv(env);
  const runtimeStore = parseWorkflowRuntimeStore(env.WORKFLOW_RUNTIME_STORE);

  if (runtimeStore === "memory") {
    return {
      fixture,
      wikiFeedbackCollector: fixture.wikiFeedbackCollector,
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
  const snapshotMirror = new MysqlPrdSnapshotMirror(database);
  const snapshotLoader = new MysqlPrdSnapshotLoader(database);
  const readModel = new MysqlWorkflowApiReadModel(database);
  const prdIntakeCommand = new MysqlPrdIntakeCommand(database);
  const feedbackRevisionCommand = new MysqlFeedbackRevisionCommand(database);
  const workflowResultCommand = new MysqlWorkflowResultCommand(database);
  const workflowTransitionCommand = new MysqlWorkflowTransitionCommand(database);

  return {
    fixture,
    scheduler,
    documentRepository,
    wikiFeedbackCollector: fixture.wikiFeedbackCollector,
    snapshotMirror,
    snapshotLoader,
    restorePrdSnapshot: () => snapshotLoader.loadInto(fixture.store),
    readModel,
    prdIntakeCommand,
    feedbackRevisionCommand,
    workflowResultCommand,
    workflowTransitionCommand,
    runtimeStore,
    close: () => closeMysqlDatabase(database)
  };
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

async function closeMysqlDatabase(database: MysqlDatabase): Promise<void> {
  await (database as { end?: () => Promise<void> }).end?.();
}
