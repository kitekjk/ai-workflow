import type { Document } from "../document-core/domain";
import type { AgentJob, JobType } from "../prd-confirmation/domain";
import type { WorkflowTask } from "../workflow-core/domain";
import type {
  WorkflowEngineExternalIssueStatus,
  WorkflowEngineTransitionType,
  WorkflowEngineWorkItemState
} from "../prd-confirmation/workflow-engine";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import {
  MysqlWorkflowMutationApplier,
  type WorkflowMutation,
  type WorkflowMutationApplier
} from "./workflow-mutation-applier";

export interface RecordDocumentStateCommandInput {
  document: Document;
  actor?: string;
  reason?: string;
  now?: Date;
}

export interface RecordWorkflowJobCommandInput {
  runId: string;
  job: AgentJob;
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
  documents: Document[];
  jobs: Array<{
    runId: string;
    job: AgentJob;
  }>;
  now?: Date;
}

export interface RecordRepositoryTransitionCommandInput {
  transitionType?: WorkflowEngineTransitionType;
  mutation: WorkflowMutation;
}

export interface WorkflowEngineProcessedResultSummary {
  jobId: string;
  jobType: JobType;
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
    await this.mutationApplier.apply({
      workflowTasks: [workflowTaskForDocumentState(documentStateForInput(input))],
      documentStates: [documentStateForInput(input)],
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
    await this.mutationApplier.apply({
      workflowTasks: input.documents.map((document) =>
        workflowTaskForDocumentState(
          documentStateForInput({
            document,
            now: input.now
          })
        )
      ),
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
    taskId: input.taskId ?? input.workflowTask?.id,
    jobType: input.job.jobType,
    status: input.job.status,
    input: input.job.input,
    projectId: "prd-confirmation",
    repositoryId: "prd-docs",
    assignedUserId: assignedUserIdForWorkflowJob(input.job),
    now: input.now
  });
}

function workflowTaskForDocumentState(document: Document): WorkflowTask {
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

  const runId = input.documents[0]?.workflowRunId ?? input.jobs[0]?.runId;

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
      documentIds: input.documents.map((document) => document.id),
      createdJobIds: input.jobs.map(({ job }) => job.id)
    },
    createdAt: toIso(input.now)
  };
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
      taskId: input.taskId ?? input.workflowTask?.id
    },
    createdAt: toIso(input.now)
  };
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}

function assignedUserIdForWorkflowJob(job: AgentJob): string | undefined {
  const requestedBy = job.input.requestedBy;

  return typeof requestedBy === "string" && requestedBy.length > 0 ? requestedBy : undefined;
}
