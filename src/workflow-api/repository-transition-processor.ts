import type { Document } from "../document-core/domain";
import type { WorkflowJob, WorkflowJobResult } from "../workflow-core/domain";
import type { WorkflowApiReadModel } from "./mysql-read-model";
import {
  canPlanRepositoryWorkflowTransition,
  planRepositoryWorkflowTransition
} from "./repository-transition-planner";
import type { WorkflowTransitionCommand } from "./workflow-transition-command";

export interface RepositoryTransitionProcessorInput {
  readModel: WorkflowApiReadModel;
  workflowTransitionCommand: WorkflowTransitionCommand;
}

export interface ProcessRepositoryJobResultInput {
  job: WorkflowJob;
  jobResult: WorkflowJobResult;
  now: Date;
}

export interface ProcessRepositoryJobResultOutput {
  processed: boolean;
  transitionType?: string;
}

export interface RepositoryTransitionPendingResult {
  job: WorkflowJob;
  jobResult: WorkflowJobResult;
}

export interface RepositoryTransitionPendingResultReader {
  nextPendingJobResult(input?: { now?: Date }): Promise<RepositoryTransitionPendingResult | undefined>;
}

export interface ProcessNextPendingRepositoryResultInput {
  reader: RepositoryTransitionPendingResultReader;
  now: Date;
}

export class RepositoryTransitionProcessor {
  constructor(private readonly input: RepositoryTransitionProcessorInput) {}

  async processNextPendingResult(
    input: ProcessNextPendingRepositoryResultInput
  ): Promise<ProcessRepositoryJobResultOutput> {
    const pending = await input.reader.nextPendingJobResult({ now: input.now });

    if (!pending) {
      return { processed: false };
    }

    return this.processJobResult({
      job: pending.job,
      jobResult: pending.jobResult,
      now: input.now
    });
  }

  async processJobResult(
    input: ProcessRepositoryJobResultInput
  ): Promise<ProcessRepositoryJobResultOutput> {
    if (
      !this.input.workflowTransitionCommand.recordRepositoryTransition ||
      !canPlanRepositoryWorkflowTransition(input.job.jobType)
    ) {
      return { processed: false };
    }

    const summary = await this.input.readModel.summarizeWorkflowRun(input.job.runId);
    const documents = documentsFromWorkflowRunSummary(summary);
    const documentId = primaryDocumentIdForJob(input.job, documents);
    const document = documentId ? documents.find((candidate) => candidate.id === documentId) : undefined;

    if (!document) {
      throw new Error(`Repository transition could not find primary document for job: ${input.job.id}`);
    }

    const transition = planRepositoryWorkflowTransition({
      document,
      job: input.job,
      result: input.jobResult,
      now: input.now
    });

    await this.input.workflowTransitionCommand.recordRepositoryTransition(transition);

    return {
      processed: true,
      transitionType: transition.transitionType
    };
  }
}

function documentsFromWorkflowRunSummary(summary: Record<string, unknown> | undefined): Document[] {
  if (!summary || !Array.isArray(summary.documents)) {
    return [];
  }

  return summary.documents.filter(isDocumentRecord);
}

function isDocumentRecord(value: unknown): value is Document {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Document).id === "string" &&
    typeof (value as Document).workflowRunId === "string" &&
    typeof (value as Document).type === "string" &&
    typeof (value as Document).sourceKey === "string"
  );
}

function primaryDocumentIdForJob(job: { input: Record<string, unknown> }, documents: Document[]): string | undefined {
  const sourceDocumentId = stringOrUndefined(job.input.sourceDocumentId);

  if (sourceDocumentId && documents.some((document) => document.id === sourceDocumentId)) {
    return sourceDocumentId;
  }

  const documentId = stringOrUndefined(job.input.documentId);

  if (documentId && documents.some((document) => document.id === documentId)) {
    return documentId;
  }

  const parentDocumentId = stringOrUndefined(job.input.parentDocumentId);

  if (parentDocumentId && documents.some((document) => document.id === parentDocumentId)) {
    return parentDocumentId;
  }

  return documents[0]?.id;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
