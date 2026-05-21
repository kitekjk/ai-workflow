import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import { createWorkflowJobRecord } from "../workflow-core/job-metadata";
import {
  MysqlWorkflowMutationApplier,
  type WorkflowMutation,
  type WorkflowMutationApplier
} from "./workflow-mutation-applier";

export interface RecordPrdIntakeInput {
  runId: string;
  workItemId: string;
  jobId: string;
  prdJiraKey: string;
  title?: string;
  now?: Date;
}

export interface RecordPrdIntakeResult {
  runId: string;
  documentId: string;
  jobId: string;
}

export interface PrdIntakeCommand {
  recordIntake(input: RecordPrdIntakeInput): Promise<RecordPrdIntakeResult>;
}

export interface MysqlPrdIntakeCommandOptions {
  idGenerator?: (prefix: string) => string;
  mutationApplier?: WorkflowMutationApplier;
}

export class MysqlPrdIntakeCommand implements PrdIntakeCommand {
  private readonly mutationApplier: WorkflowMutationApplier;

  constructor(
    database: MysqlDatabase,
    options: MysqlPrdIntakeCommandOptions = {}
  ) {
    this.mutationApplier =
      options.mutationApplier ?? new MysqlWorkflowMutationApplier(database, { idGenerator: options.idGenerator });
  }

  async recordIntake(input: RecordPrdIntakeInput): Promise<RecordPrdIntakeResult> {
    const now = toIso(input.now);
    const documentId = documentIdForWorkItem(input.workItemId);
    const title = input.title ?? input.prdJiraKey;
    const metadata = {
      runId: input.runId,
      documentId,
      jobId: input.jobId,
      prdJiraKey: input.prdJiraKey,
      title
    };
    const mutation: WorkflowMutation = {
      workflowRuns: [
        {
          id: input.runId,
          workflowDefinitionId: "prd_confirmation",
          status: "active",
          sourceType: "jira",
          sourceKey: input.prdJiraKey,
          outputLanguage: "ko",
          createdAt: now,
          updatedAt: now
        }
      ],
      documents: [
        {
          id: documentId,
          workflowRunId: input.runId,
          type: "prd",
          sourceKey: input.prdJiraKey,
          title,
          status: "draft",
          createdAt: now,
          updatedAt: now
        }
      ],
      workflowJobs: [
        createWorkflowJobRecord({
          id: input.jobId,
          runId: input.runId,
          jobType: "prd.generate_draft",
          input: {},
          projectId: "prd-confirmation",
          repositoryId: "prd-docs",
          createdAt: now,
          updatedAt: now
        })
      ],
      events: [
        {
          runId: input.runId,
          jobId: input.jobId,
          type: "workflow.prd_intake",
          message: `PRD intake recorded: ${input.prdJiraKey}`,
          metadata,
          createdAt: now
        }
      ]
    };

    await this.mutationApplier.apply(mutation);

    return {
      runId: input.runId,
      documentId,
      jobId: input.jobId
    };
  }
}

function documentIdForWorkItem(workItemId: string): string {
  return `doc_${workItemId}`;
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
