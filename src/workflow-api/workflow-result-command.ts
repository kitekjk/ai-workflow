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
  workflowTasks: WorkflowTask[];
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
      workflowTasks: input.workflowTasks,
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
      taskIds: input.workflowTasks.map((task) => task.id),
      documentIds: input.documents.map((document) => document.id),
      documentVersionIds: input.documentVersions.map((version) => version.id),
      artifactIds: input.artifacts.map((artifact) => artifact.id),
      qualityResultIds: input.qualityResults.map((qualityResult) => qualityResult.id)
    },
    createdAt: createdAtForResultProjection(input)
  };
}

function runIdForResultProjection(input: RecordWorkflowResultProjectionInput): string | undefined {
  const targetJob = input.jobs.find((job) => job.id === input.jobId);

  if (targetJob) {
    return targetJob.runId;
  }

  return singleRunId([
    ...input.jobs.map((job) => job.runId),
    ...input.workflowTasks.map((task) => task.runId),
    ...input.documents.map((document) => document.workflowRunId)
  ]);
}

function createdAtForResultProjection(input: RecordWorkflowResultProjectionInput): string {
  return (
    input.jobResults.find((result) => result.jobId === input.jobId)?.createdAt ??
    input.jobs.find((job) => job.id === input.jobId)?.updatedAt ??
    input.jobResults[0]?.createdAt ??
    new Date().toISOString()
  );
}

function singleRunId(runIds: string[]): string | undefined {
  const uniqueRunIds = [...new Set(runIds.filter(Boolean))];

  return uniqueRunIds.length === 1 ? uniqueRunIds[0] : undefined;
}
