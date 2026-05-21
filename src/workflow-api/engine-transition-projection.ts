import type { Document } from "../document-core/domain";
import { createGenericPrdSnapshot } from "../prd-confirmation/generic-adapter";
import type { AgentJob, AgentJobResult, PrdConfirmationStore } from "../prd-confirmation/domain";
import type { WorkflowEngineStepResult } from "../prd-confirmation/workflow-engine";
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
  const jobs = engineStep.createdJobIds.map((jobId) => workflowJobCommandInputForFixtureJob(store, jobId));

  return {
    transitionType: engineStep.transitionType,
    affectedWorkItemIds: engineStep.affectedWorkItemIds,
    affectedDocumentIds: engineStep.affectedDocumentIds,
    createdWorkItemIds: engineStep.createdWorkItemIds,
    workItemState: engineStep.workItemState,
    externalIssueStatus: engineStep.externalIssueStatus,
    processedResult: processedResultSummary(engineStep.processedResult),
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
    job: cloneAgentJob(job)
  };
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
