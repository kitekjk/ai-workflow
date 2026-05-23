import type { Document } from "../document-core/domain";
import type {
  WorkflowEngineExternalIssueStatus,
  WorkflowEngineTransitionType,
  WorkflowEngineWorkItemState,
  WorkflowCommandJob,
  WorkflowCommandJobType,
  WorkflowTask
} from "../workflow-core/domain";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import {
  MysqlWorkflowMutationApplier,
  type WorkflowMutation,
  type WorkflowMutationApplier
} from "./workflow-mutation-applier";

export interface RecordDocumentStateCommandInput {
  document: Document;
  workflowTask?: WorkflowTask;
  actor?: string;
  reason?: string;
  now?: Date;
}

export interface RecordWorkflowJobCommandInput {
  runId: string;
  job: WorkflowCommandJob;
  taskId?: string;
  workflowTask?: WorkflowTask;
  now?: Date;
}

export interface RecordEngineTransitionCommandInput {
  transitionType?: WorkflowEngineTransitionType;
  affectedWorkItemIds?: string[];
  affectedDocumentIds?: string[];
  createdWorkItemIds?: string[];
  workItemState?: WorkflowEngineWorkItemState;
  externalIssueStatus?: WorkflowEngineExternalIssueStatus;
  processedResult?: WorkflowEngineProcessedResultSummary;
  workflowTasks?: WorkflowTask[];
  documents: Document[];
  jobs: RecordWorkflowJobCommandInput[];
  now?: Date;
}

export interface RecordRepositoryTransitionCommandInput {
  transitionType?: WorkflowEngineTransitionType;
  mutation: WorkflowMutation;
}

export interface WorkflowEngineProcessedResultSummary {
  jobId: string;
  jobType: WorkflowCommandJobType;
  primaryJiraKey: string;
  status?: string;
}

export interface WorkflowTransitionCommand {
  recordDocumentState(input: RecordDocumentStateCommandInput): Promise<void>;
  recordWorkflowJob(input: RecordWorkflowJobCommandInput): Promise<void>;
  recordEngineTransition?(input: RecordEngineTransitionCommandInput): Promise<void>;
  recordRepositoryTransition?(input: RecordRepositoryTransitionCommandInput): Promise<void>;
}

export interface MysqlWorkflowTransitionCommandOptions {
  idGenerator?: (prefix: string) => string;
  mutationApplier?: WorkflowMutationApplier;
}

export class MysqlWorkflowTransitionCommand implements WorkflowTransitionCommand {
  private readonly mutationApplier: WorkflowMutationApplier;

  constructor(
    database: MysqlDatabase,
    options: MysqlWorkflowTransitionCommandOptions = {}
  ) {
    this.mutationApplier =
      options.mutationApplier ?? new MysqlWorkflowMutationApplier(database, { idGenerator: options.idGenerator });
  }

  async recordDocumentState(input: RecordDocumentStateCommandInput): Promise<void> {
    const document = documentStateForInput(input);

    await this.mutationApplier.apply({
      workflowTasks: [workflowTaskForDocumentState(document, input.workflowTask)],
      documentStates: [document],
      events: [documentStateRecordedEvent(input)]
    });
  }

  async recordWorkflowJob(input: RecordWorkflowJobCommandInput): Promise<void> {
    await this.mutationApplier.apply({
      workflowTasks: input.workflowTask ? [input.workflowTask] : [],
      workflowJobs: [workflowJobForInput(input)],
      events: [workflowJobRecordedEvent(input)]
    });
  }

  async recordEngineTransition(input: RecordEngineTransitionCommandInput): Promise<void> {
    const engineEvent = engineTransitionEvent(input);
    const documentTasks = input.workflowTasks ?? input.documents.map((document) =>
      workflowTaskForDocumentState(
        documentStateForInput({
          document,
          now: input.now
        })
      )
    );
    const jobTasks = input.jobs
      .map((job) => job.workflowTask)
      .filter((task): task is WorkflowTask => Boolean(task));

    await this.mutationApplier.apply({
      workflowTasks: [...documentTasks, ...jobTasks],
      documentStates: input.documents.map((document) =>
        documentStateForInput({
          document,
          now: input.now
        })
      ),
      workflowJobs: input.jobs.map((job) =>
        workflowJobForInput({
          ...job,
          now: input.now
        })
      ),
      events: engineEvent ? [engineEvent] : []
    });
  }

  async recordRepositoryTransition(input: RecordRepositoryTransitionCommandInput): Promise<void> {
    await this.mutationApplier.apply(input.mutation);
  }
}

function documentStateForInput(input: RecordDocumentStateCommandInput): Document {
  const now = toIso(input.now ?? new Date(input.document.updatedAt));
  return {
    ...input.document,
    updatedAt: now
  };
}

function workflowJobForInput(input: RecordWorkflowJobCommandInput): NonNullable<WorkflowMutation["workflowJobs"]>[number] {
  return createWorkflowJobRecord({
    id: input.job.id,
    runId: input.runId,
    taskId: workflowJobTaskId(input),
    jobType: input.job.jobType,
    status: input.job.status,
    input: input.job.input,
    projectId: "prd-confirmation",
    repositoryId: "prd-docs",
    assignedUserId: assignedUserIdForWorkflowJob(input.job),
    now: input.now
  });
}

function workflowTaskForDocumentState(document: Document, workflowTask?: WorkflowTask): WorkflowTask {
  if (workflowTask) {
    return {
      ...workflowTask,
      status: document.status,
      currentDocumentId: document.id,
      metadata: {
        ...workflowTask.metadata,
        documentId: document.id
      },
      updatedAt: document.updatedAt
    };
  }

  return {
    id: document.workflowTaskId ?? taskIdForDocument(document.id),
    runId: document.workflowRunId,
    parentTaskId:
      !document.workflowTaskId && document.parentDocumentId ? taskIdForDocument(document.parentDocumentId) : undefined,
    taskType: document.type,
    sourceKey: document.sourceKey,
    title: document.title,
    status: document.status,
    currentDocumentId: document.id,
    metadata: {
      documentId: document.id
    },
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}

function taskIdForDocument(documentId: string): string {
  return documentId.startsWith("doc_") ? `task_${documentId.slice("doc_".length)}` : `task_${documentId}`;
}

function engineTransitionEvent(
  input: RecordEngineTransitionCommandInput
): NonNullable<WorkflowMutation["events"]>[number] | undefined {
  if (!input.transitionType) {
    return undefined;
  }

  const runId = runIdForEngineTransition(input);

  if (!runId) {
    return undefined;
  }

  return {
    runId,
    type: "workflow.engine_transition",
    message: `Workflow engine transition: ${input.transitionType}`,
    metadata: {
      transitionType: input.transitionType,
      affectedWorkItemIds: input.affectedWorkItemIds ?? [],
      affectedDocumentIds: input.affectedDocumentIds ?? [],
      createdWorkItemIds: input.createdWorkItemIds ?? [],
      workItemState: input.workItemState,
      externalIssueStatus: input.externalIssueStatus,
      processedResult: input.processedResult,
      taskIds: [
        ...(input.workflowTasks ?? []).map((task) => task.id),
        ...input.jobs.flatMap((job) => job.workflowTask ? [job.workflowTask.id] : [])
      ],
      documentIds: input.documents.map((document) => document.id),
      createdJobIds: input.jobs.map(({ job }) => job.id)
    },
    createdAt: toIso(input.now)
  };
}

function runIdForEngineTransition(input: RecordEngineTransitionCommandInput): string | undefined {
  return singleRunId([
    ...(input.workflowTasks ?? []).map((task) => task.runId),
    ...input.jobs.flatMap((job) => (job.workflowTask ? [job.workflowTask.runId] : [])),
    ...input.documents.map((document) => document.workflowRunId),
    ...input.jobs.map((job) => job.runId)
  ]);
}

function singleRunId(runIds: string[]): string | undefined {
  const uniqueRunIds = [...new Set(runIds.filter(Boolean))];

  return uniqueRunIds.length === 1 ? uniqueRunIds[0] : undefined;
}

function documentStateRecordedEvent(input: RecordDocumentStateCommandInput): NonNullable<WorkflowMutation["events"]>[number] {
  return {
    runId: input.document.workflowRunId,
    type: "workflow.document_state",
    message: `Document state recorded: ${input.document.id}`,
    metadata: {
      documentId: input.document.id,
      documentType: input.document.type,
      sourceKey: input.document.sourceKey,
      status: input.document.status,
      actor: input.actor ?? null,
      reason: input.reason ?? null
    },
    createdAt: toIso(input.now ?? new Date(input.document.updatedAt))
  };
}

function workflowJobRecordedEvent(input: RecordWorkflowJobCommandInput): NonNullable<WorkflowMutation["events"]>[number] {
  return {
    runId: input.runId,
    jobId: input.job.id,
    type: "workflow.job_recorded",
    message: `Workflow job recorded: ${input.job.id}`,
    metadata: {
      jobId: input.job.id,
      jobType: input.job.jobType,
      status: input.job.status,
      sourceKey: input.job.primaryJiraKey,
      taskId: workflowJobTaskId(input)
    },
    createdAt: toIso(input.now)
  };
}

function workflowJobTaskId(input: RecordWorkflowJobCommandInput): string | undefined {
  return input.taskId ?? input.workflowTask?.id ?? stringOrUndefined(input.job.input.taskId);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

function assignedUserIdForWorkflowJob(job: WorkflowCommandJob): string | undefined {
  const requestedBy = job.input.requestedBy;

  return typeof requestedBy === "string" && requestedBy.length > 0 ? requestedBy : undefined;
}
