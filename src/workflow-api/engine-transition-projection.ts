import type { Document } from "../document-core/domain";
import { createGenericPrdSnapshot } from "../prd-confirmation/generic-adapter";
import type { AgentJob, AgentJobResult, PrdConfirmationStore } from "../prd-confirmation/domain";
import type { WorkflowEngineStepResult } from "../prd-confirmation/workflow-engine";
import type { WorkflowTask } from "../workflow-core/domain";
import type {
  RecordEngineTransitionCommandInput,
  RecordWorkflowJobCommandInput,
  WorkflowEngineProcessedResultSummary
} from "./workflow-transition-command";

export function createEngineTransitionCommandInput(
  store: PrdConfirmationStore,
  engineStep: WorkflowEngineStepResult,
  now: Date
): RecordEngineTransitionCommandInput | undefined {
  if (!engineStep.progressed) {
    return undefined;
  }

  const snapshot = createGenericPrdSnapshot(store);
  const documents = documentsForEngineStep(snapshot.documents, engineStep);
  const workflowTasks = workflowTasksForEngineStep(snapshot.workflowTasks, engineStep);
  const jobs = engineStep.createdJobIds.map((jobId) => workflowJobCommandInputForFixtureJob(store, jobId));

  return {
    transitionType: engineStep.transitionType,
    affectedWorkItemIds: engineStep.affectedWorkItemIds,
    affectedDocumentIds: engineStep.affectedDocumentIds,
    createdWorkItemIds: engineStep.createdWorkItemIds,
    workItemState: engineStep.workItemState,
    externalIssueStatus: engineStep.externalIssueStatus,
    processedResult: processedResultSummary(engineStep.processedResult),
    workflowTasks,
    documents,
    jobs,
    now
  };
}

export function workflowJobCommandInputForFixtureJob(
  store: PrdConfirmationStore,
  jobId: string
): RecordWorkflowJobCommandInput {
  const job = store.agentJobs.find((candidate) => candidate.id === jobId);

  if (!job) {
    throw new Error(`Workflow transition command could not find fixture job state: ${jobId}`);
  }

  const workItem = store.workItems.find((candidate) => candidate.id === job.workItemId);

  if (!workItem) {
    throw new Error(`Workflow transition command could not find fixture work item state: ${job.workItemId}`);
  }

  return {
    runId: workItem.runId,
    job: cloneAgentJob(job),
    taskId: taskIdForFixtureJob(job, workItem),
    workflowTask: isImplementationJob(job.jobType) ? implementationTaskForFixtureJob(job, workItem) : undefined
  };
}

function taskIdForFixtureJob(job: AgentJob, workItem: { id: string }): string {
  return isImplementationJob(job.jobType) ? codeTaskIdForWorkItem(workItem.id) : taskIdForWorkItem(workItem.id);
}

function implementationTaskForFixtureJob(
  job: AgentJob,
  workItem: { id: string; runId: string; primaryJiraKey: string; title?: string }
): WorkflowTask {
  const createdAt = "2026-01-01T00:00:00.000Z";
  const documentId = documentIdForWorkItemId(workItem.id);

  return {
    id: codeTaskIdForWorkItem(workItem.id),
    runId: workItem.runId,
    parentTaskId: taskIdForWorkItem(workItem.id),
    taskType: "code",
    sourceKey: workItem.primaryJiraKey,
    title: `Code Implementation for ${workItem.primaryJiraKey}`,
    status: job.status === "failed" ? "failed" : "draft",
    currentDocumentId: documentId,
    metadata: {
      documentId
    },
    createdAt,
    updatedAt: createdAt
  };
}

function taskIdForWorkItem(workItemId: string): string {
  return `task_${workItemId}`;
}

function codeTaskIdForWorkItem(workItemId: string): string {
  return `task_${documentIdForWorkItemId(workItemId)}_code`;
}

function documentIdForWorkItemId(workItemId: string): string {
  return `doc_${workItemId}`;
}

function isImplementationJob(jobType: string): boolean {
  return jobType.startsWith("implementation.");
}

function documentsForEngineStep(documents: Document[], engineStep: WorkflowEngineStepResult): Document[] {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const selectedDocuments: Document[] = [];

  for (const documentId of engineStep.affectedDocumentIds) {
    const document = documentsById.get(documentId);

    if (!document) {
      throw new Error(`Workflow transition command could not find engine document state: ${documentId}`);
    }

    selectedDocuments.push(document);
  }

  return selectedDocuments;
}

function workflowTasksForEngineStep(tasks: WorkflowTask[], engineStep: WorkflowEngineStepResult): WorkflowTask[] {
  const affectedDocumentIds = new Set(engineStep.affectedDocumentIds);

  return tasks.filter((task) => task.currentDocumentId && affectedDocumentIds.has(task.currentDocumentId));
}

function cloneAgentJob(job: AgentJob): AgentJob {
  return {
    ...job,
    input: { ...job.input }
  };
}

function processedResultSummary(
  result: AgentJobResult | undefined
): WorkflowEngineProcessedResultSummary | undefined {
  if (!result) {
    return undefined;
  }

  return {
    jobId: result.jobId,
    jobType: result.jobType,
    primaryJiraKey: result.primaryJiraKey,
    status: stringOrUndefined(result.output.status)
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
