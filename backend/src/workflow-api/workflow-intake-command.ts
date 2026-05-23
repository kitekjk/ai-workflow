import type { DocumentType } from "../document-core/domain";
import type { WorkflowRun } from "../workflow-core/domain";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import {
  MysqlWorkflowMutationApplier,
  type WorkflowMutation,
  type WorkflowMutationApplier
} from "./workflow-mutation-applier";

export type WorkflowSourceType = WorkflowRun["sourceType"];

export interface RecordWorkflowIntakeInput {
  runId: string;
  workItemId: string;
  jobId: string;
  sourceType: WorkflowSourceType;
  sourceKey: string;
  documentType: DocumentType;
  workflowDefinitionId?: string;
  outputLanguage?: string;
  title?: string;
  requestedBy?: string;
  now?: Date;
}

export interface RecordPrdIntakeInput {
  runId: string;
  workItemId: string;
  jobId: string;
  prdJiraKey: string;
  title?: string;
  requestedBy?: string;
  now?: Date;
}

export interface RecordWorkflowIntakeResult {
  runId: string;
  documentId: string;
  jobId: string;
}

export type RecordPrdIntakeResult = RecordWorkflowIntakeResult;

export interface WorkflowIntakeCommand {
  recordIntake(input: RecordWorkflowIntakeInput | RecordPrdIntakeInput): Promise<RecordWorkflowIntakeResult>;
}

export type PrdIntakeCommand = WorkflowIntakeCommand;

export interface MysqlWorkflowIntakeCommandOptions {
  idGenerator?: (prefix: string) => string;
  mutationApplier?: WorkflowMutationApplier;
}

export type MysqlPrdIntakeCommandOptions = MysqlWorkflowIntakeCommandOptions;

export class MysqlWorkflowIntakeCommand implements WorkflowIntakeCommand {
  private readonly mutationApplier: WorkflowMutationApplier;

  constructor(
    database: MysqlDatabase,
    options: MysqlWorkflowIntakeCommandOptions = {}
  ) {
    this.mutationApplier =
      options.mutationApplier ?? new MysqlWorkflowMutationApplier(database, { idGenerator: options.idGenerator });
  }

  async recordIntake(input: RecordWorkflowIntakeInput | RecordPrdIntakeInput): Promise<RecordWorkflowIntakeResult> {
    const legacyPrdInput = isLegacyPrdIntakeInput(input);
    const normalized = normalizeWorkflowIntakeInput(input);
    const now = toIso(normalized.now);
    const documentId = documentIdForWorkItem(normalized.workItemId);
    const taskId = taskIdForWorkItem(normalized.workItemId);
    const title = normalized.title ?? normalized.sourceKey;
    const workflowDefinitionId =
      normalized.workflowDefinitionId ?? defaultWorkflowDefinitionId(normalized.documentType);
    const outputLanguage = normalized.outputLanguage ?? "ko";
    const jobType = initialJobTypeForDocument(normalized.documentType);
    const metadata = intakeMetadata({
      runId: normalized.runId,
      workItemId: normalized.workItemId,
      taskId,
      documentId,
      jobId: normalized.jobId,
      sourceType: normalized.sourceType,
      sourceKey: normalized.sourceKey,
      documentType: normalized.documentType,
      workflowDefinitionId,
      outputLanguage,
      title,
      requestedBy: normalized.requestedBy,
      legacyPrdInput
    });
    const mutation: WorkflowMutation = {
      workflowRuns: [
        {
          id: normalized.runId,
          workflowDefinitionId,
          status: "active",
          sourceType: normalized.sourceType,
          sourceKey: normalized.sourceKey,
          outputLanguage,
          createdAt: now,
          updatedAt: now
        }
      ],
      workflowTasks: [
        {
          id: taskId,
          runId: normalized.runId,
          taskType: normalized.documentType,
          sourceKey: normalized.sourceKey,
          title,
          status: "draft",
          currentDocumentId: documentId,
          metadata: taskMetadata(metadata, legacyPrdInput),
          createdAt: now,
          updatedAt: now
        }
      ],
      documents: [
        {
          id: documentId,
          workflowRunId: normalized.runId,
          workflowTaskId: taskId,
          type: normalized.documentType,
          sourceKey: normalized.sourceKey,
          title,
          status: "draft",
          createdAt: now,
          updatedAt: now
        }
      ],
      workflowJobs: [
        createWorkflowJobRecord({
          id: normalized.jobId,
          runId: normalized.runId,
          taskId,
          jobType,
          input: legacyPrdInput ? {} : initialJobInput(metadata),
          projectId: "prd-confirmation",
          repositoryId: "prd-docs",
          assignedUserId: normalized.requestedBy,
          createdAt: now,
          updatedAt: now
        })
      ],
      events: [
        {
          runId: normalized.runId,
          jobId: normalized.jobId,
          type: legacyPrdInput ? "workflow.prd_intake" : "workflow.source_intake",
          message: legacyPrdInput
            ? `PRD intake recorded: ${normalized.sourceKey}`
            : `Workflow source intake recorded: ${normalized.sourceKey}`,
          metadata,
          createdAt: now
        }
      ]
    };

    await this.mutationApplier.apply(mutation);

    return {
      runId: normalized.runId,
      documentId,
      jobId: normalized.jobId
    };
  }
}

export class MysqlPrdIntakeCommand extends MysqlWorkflowIntakeCommand {}

function normalizeWorkflowIntakeInput(
  input: RecordWorkflowIntakeInput | RecordPrdIntakeInput
): RecordWorkflowIntakeInput {
  if (isLegacyPrdIntakeInput(input)) {
    return {
      runId: input.runId,
      workItemId: input.workItemId,
      jobId: input.jobId,
      sourceType: "jira",
      sourceKey: input.prdJiraKey,
      documentType: "prd",
      workflowDefinitionId: "prd_confirmation",
      outputLanguage: "ko",
      title: input.title,
      requestedBy: input.requestedBy,
      now: input.now
    };
  }

  return input;
}

function isLegacyPrdIntakeInput(
  input: RecordWorkflowIntakeInput | RecordPrdIntakeInput
): input is RecordPrdIntakeInput {
  return "prdJiraKey" in input;
}

function intakeMetadata(input: {
  runId: string;
  workItemId: string;
  taskId: string;
  documentId: string;
  jobId: string;
  sourceType: WorkflowSourceType;
  sourceKey: string;
  documentType: DocumentType;
  workflowDefinitionId: string;
  outputLanguage: string;
  title: string;
  requestedBy?: string;
  legacyPrdInput: boolean;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    runId: input.runId,
    workItemId: input.workItemId,
    taskId: input.taskId,
    documentId: input.documentId,
    jobId: input.jobId,
    sourceType: input.sourceType,
    sourceKey: input.sourceKey,
    documentType: input.documentType,
    workflowDefinitionId: input.workflowDefinitionId,
    outputLanguage: input.outputLanguage,
    title: input.title,
    requestedBy: input.requestedBy
  };

  if (input.legacyPrdInput) {
    return {
      runId: input.runId,
      taskId: input.taskId,
      documentId: input.documentId,
      jobId: input.jobId,
      prdJiraKey: input.sourceKey,
      title: input.title,
      requestedBy: input.requestedBy
    };
  }

  return metadata;
}

function taskMetadata(metadata: Record<string, unknown>, legacyPrdInput: boolean): Record<string, unknown> {
  if (legacyPrdInput) {
    return {
      workItemId: workItemIdFromMetadata(metadata),
      requestedBy: metadata.requestedBy
    };
  }

  return {
    workItemId: workItemIdFromMetadata(metadata),
    sourceType: metadata.sourceType,
    documentType: metadata.documentType,
    workflowDefinitionId: metadata.workflowDefinitionId,
    requestedBy: metadata.requestedBy
  };
}

function workItemIdFromMetadata(metadata: Record<string, unknown>): string {
  return typeof metadata.workItemId === "string"
    ? metadata.workItemId
    : String(metadata.documentId).replace(/^doc_/, "");
}

function initialJobInput(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceType: metadata.sourceType,
    sourceKey: metadata.sourceKey,
    documentType: metadata.documentType,
    workflowDefinitionId: metadata.workflowDefinitionId,
    outputLanguage: metadata.outputLanguage,
    title: metadata.title,
    requestedBy: metadata.requestedBy
  };
}

function initialJobTypeForDocument(documentType: DocumentType): string {
  return documentType === "prd" ? "prd.generate_draft" : "document.generate";
}

function defaultWorkflowDefinitionId(documentType: DocumentType): string {
  if (documentType === "prd") {
    return "prd_to_spec";
  }

  if (documentType === "spec") {
    return "spec_to_code";
  }

  return `${documentType}_to_spec`;
}

function documentIdForWorkItem(workItemId: string): string {
  return `doc_${workItemId}`;
}

function taskIdForWorkItem(workItemId: string): string {
  return `task_${workItemId}`;
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
