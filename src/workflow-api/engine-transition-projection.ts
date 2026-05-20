import type { Document } from "../document-core/domain";
import { createGenericPrdSnapshot } from "../prd-confirmation/generic-adapter";
import type { AgentJob, PrdConfirmationStore } from "../prd-confirmation/domain";
import type { WorkflowEngineStepResult } from "../prd-confirmation/workflow-engine";
import type {
  RecordEngineTransitionCommandInput,
  RecordWorkflowJobCommandInput
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
    workItemState: engineStep.workItemState,
    externalIssueStatus: engineStep.externalIssueStatus,
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
