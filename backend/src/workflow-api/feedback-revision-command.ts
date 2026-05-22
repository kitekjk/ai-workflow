import type { AgentJob, FeedbackItem } from "../prd-confirmation/domain";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import {
  MysqlWorkflowMutationApplier,
  type WorkflowMutation,
  type WorkflowMutationApplier
} from "./workflow-mutation-applier";

export interface RecordFeedbackCommandInput {
  feedback: FeedbackItem;
}

export interface RecordRevisionJobCommandInput {
  runId: string;
  job: AgentJob;
  taskId?: string;
  feedbackItems: FeedbackItem[];
  now?: Date;
}

export interface FeedbackRevisionCommand {
  recordFeedback(input: RecordFeedbackCommandInput): Promise<void>;
  recordRevisionJob(input: RecordRevisionJobCommandInput): Promise<void>;
}

export interface MysqlFeedbackRevisionCommandOptions {
  idGenerator?: (prefix: string) => string;
  mutationApplier?: WorkflowMutationApplier;
}

export class MysqlFeedbackRevisionCommand implements FeedbackRevisionCommand {
  private readonly mutationApplier: WorkflowMutationApplier;

  constructor(
    database: MysqlDatabase,
    options: MysqlFeedbackRevisionCommandOptions = {}
  ) {
    this.mutationApplier =
      options.mutationApplier ?? new MysqlWorkflowMutationApplier(database, { idGenerator: options.idGenerator });
  }

  async recordFeedback(input: RecordFeedbackCommandInput): Promise<void> {
    await this.mutationApplier.apply({
      feedbackItems: [input.feedback],
      documentEvents: [feedbackRecordedEvent(input.feedback)]
    });
  }

  async recordRevisionJob(input: RecordRevisionJobCommandInput): Promise<void> {
    const now = toIso(input.now);
    const revisionJobMetadata = {
      jobId: input.job.id,
      jobType: input.job.jobType,
      status: input.job.status,
      sourceKey: input.job.primaryJiraKey,
      feedbackItemIds: input.feedbackItems.map((feedback) => feedback.id)
    };
    const mutation: WorkflowMutation = {
      workflowJobs: [
        {
          id: input.job.id,
          runId: input.runId,
          taskId: input.taskId,
          jobType: input.job.jobType,
          status: input.job.status,
          input: input.job.input,
          priority: 0,
          projectId: "prd-confirmation",
          repositoryId: "prd-docs",
          requiredRole: roleForJobType(input.job.jobType),
          requiredCapabilities: capabilitiesForJobType(input.job.jobType),
          executionPolicy: "local_allowed",
          createdAt: now,
          updatedAt: now
        }
      ],
      feedbackItems: input.feedbackItems,
      documentEvents: input.feedbackItems.map(feedbackRecordedEvent),
      events: [
        {
          runId: input.runId,
          jobId: input.job.id,
          type: "workflow.revision_job_recorded",
          message: `Revision job recorded: ${input.job.id}`,
          metadata: revisionJobMetadata,
          createdAt: now
        }
      ]
    };

    await this.mutationApplier.apply(mutation);
  }
}

function feedbackRecordedEvent(feedback: FeedbackItem): NonNullable<WorkflowMutation["documentEvents"]>[number] {
  return {
    documentId: feedback.documentId,
    jobId: feedback.revisionJobId,
    type: "workflow.feedback_recorded",
    message: `Feedback recorded: ${feedback.id}`,
    metadata: {
      feedbackId: feedback.id,
      documentId: feedback.documentId,
      workItemId: feedback.workItemId,
      source: feedback.source,
      author: feedback.author ?? null,
      revisionJobId: feedback.revisionJobId ?? null
    },
    createdAt: feedback.createdAt
  };
}

function capabilitiesForJobType(jobType: AgentJob["jobType"]): string[] {
  if (jobType === "document.revise") {
    return ["document.revise"];
  }

  return ["document.generate"];
}

function roleForJobType(jobType: AgentJob["jobType"]): string {
  if (jobType === "document.revise") {
    return "developer";
  }

  return "planner";
}

function toIso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
