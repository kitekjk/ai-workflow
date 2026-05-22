import type { Artifact, Document, DocumentQualityResult, DocumentVersion } from "../document-core/domain";
import type { WorkflowJob, WorkflowJobResult, WorkflowTask } from "../workflow-core/domain";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import {
  MysqlWorkflowMutationApplier,
  type WorkflowMutation,
  type WorkflowMutationApplier
} from "./workflow-mutation-applier";

export interface RecordWorkflowResultProjectionInput {
  jobId: string;
  jobs: WorkflowJob[];
  jobResults: WorkflowJobResult[];
  documents: Document[];
  documentVersions: DocumentVersion[];
  artifacts: Artifact[];
  qualityResults: DocumentQualityResult[];
}

export interface WorkflowResultCommand {
  recordResultProjection(input: RecordWorkflowResultProjectionInput): Promise<void>;
}

export interface MysqlWorkflowResultCommandOptions {
  idGenerator?: (prefix: string) => string;
  mutationApplier?: WorkflowMutationApplier;
}

export class MysqlWorkflowResultCommand implements WorkflowResultCommand {
  private readonly mutationApplier: WorkflowMutationApplier;

  constructor(
    database: MysqlDatabase,
    options: MysqlWorkflowResultCommandOptions = {}
  ) {
    this.mutationApplier =
      options.mutationApplier ?? new MysqlWorkflowMutationApplier(database, { idGenerator: options.idGenerator });
  }

  async recordResultProjection(input: RecordWorkflowResultProjectionInput): Promise<void> {
    const resultProjectionEvent = workflowResultProjectionEvent(input);
    const mutation: WorkflowMutation = {
      documentStates: input.documents,
      workflowTasks: input.documents.map(workflowTaskForDocumentProjection),
      workflowJobs: input.jobs,
      jobResults: input.jobResults,
      documentVersions: input.documentVersions,
      artifacts: input.artifacts,
      documentCurrentPointers: input.documents.map(documentCurrentPointer),
      qualityResults: input.qualityResults,
      events: resultProjectionEvent ? [resultProjectionEvent] : []
    };

    await this.mutationApplier.apply(mutation);
  }
}

function workflowTaskForDocumentProjection(document: Document): WorkflowTask {
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

function documentCurrentPointer(document: Document): NonNullable<WorkflowMutation["documentCurrentPointers"]>[number] {
  return {
    id: document.id,
    status: document.status,
    currentVersionId: document.currentVersionId,
    currentMarkdownArtifactId: document.currentMarkdownArtifactId,
    currentWikiArtifactId: document.currentWikiArtifactId,
    updatedAt: document.updatedAt
  };
}

function workflowResultProjectionEvent(
  input: RecordWorkflowResultProjectionInput
): NonNullable<WorkflowMutation["events"]>[number] | undefined {
  const runId = runIdForResultProjection(input);

  if (!runId) {
    return undefined;
  }

  return {
    runId,
    jobId: input.jobId,
    type: "workflow.result_projection",
    message: `Workflow result projection recorded for job ${input.jobId}`,
    metadata: {
      jobId: input.jobId,
      jobIds: input.jobs.map((job) => job.id),
      jobResultIds: input.jobResults.map((result) => result.id),
      documentIds: input.documents.map((document) => document.id),
      documentVersionIds: input.documentVersions.map((version) => version.id),
      artifactIds: input.artifacts.map((artifact) => artifact.id),
      qualityResultIds: input.qualityResults.map((qualityResult) => qualityResult.id)
    },
    createdAt: createdAtForResultProjection(input)
  };
}

function runIdForResultProjection(input: RecordWorkflowResultProjectionInput): string | undefined {
  return input.jobs.find((job) => job.id === input.jobId)?.runId ?? input.jobs[0]?.runId ?? input.documents[0]?.workflowRunId;
}

function createdAtForResultProjection(input: RecordWorkflowResultProjectionInput): string {
  return input.jobResults[0]?.createdAt ?? input.jobs.find((job) => job.id === input.jobId)?.updatedAt ?? new Date().toISOString();
}
