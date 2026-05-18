import type { AgentJob, PrdConfirmationStore, WorkItem } from "./domain";
import type { JiraIssueReader } from "./ports";

export interface FeedbackRevisionRequest {
  requestedBy: string;
  feedback: string;
}

export class PrdConfirmationWorkflow {
  constructor(
    private readonly store: PrdConfirmationStore,
    private readonly options: { jiraReader?: JiraIssueReader } = {}
  ) {}

  async intakePrdTicket(prdJiraKey: string): Promise<{ status: "accepted" }> {
    let issue = this.store.externalIssues.get(prdJiraKey);

    if (!issue && this.options.jiraReader) {
      const loaded = await this.options.jiraReader.loadPrdWithSources(prdJiraKey);
      this.store.externalIssues.set(loaded.prd.key, loaded.prd);
      for (const source of loaded.sources) {
        this.store.externalIssues.set(source.key, source);
      }
      issue = loaded.prd;
    }

    if (!issue || issue.issueType !== "prd") {
      throw new Error(`PRD Jira ticket is not readable: ${prdJiraKey}`);
    }

    if (!issue.linkedSourceKeys?.length) {
      throw new Error(`PRD Jira ticket has no linked source requests: ${prdJiraKey}`);
    }

    for (const sourceKey of issue.linkedSourceKeys) {
      if (!this.store.externalIssues.has(sourceKey)) {
        throw new Error(`Linked source request is not readable: ${sourceKey}`);
      }
    }

    if (this.store.workItems.some((item) => item.primaryJiraKey === prdJiraKey)) {
      return { status: "accepted" };
    }

    const workItem: WorkItem = {
      id: this.nextWorkItemId(),
      runId: this.nextRunId(),
      artifactType: "prd",
      primaryJiraKey: prdJiraKey,
      state: "draft_requested"
    };

    this.store.workItems.push(workItem);
    this.store.workItemJiraLinks.push({ workItemId: workItem.id, jiraKey: prdJiraKey, role: "primary" });

    for (const sourceKey of issue.linkedSourceKeys) {
      this.store.workItemJiraLinks.push({
        workItemId: workItem.id,
        jiraKey: sourceKey,
        role: "source_request"
      });
    }

    this.store.agentJobs.push(this.createJob(workItem, "prd.generate_draft", {}));
    issue.status = "drafting";

    return { status: "accepted" };
  }

  async requestFeedbackRevision(
    prdJiraKey: string,
    request: FeedbackRevisionRequest
  ): Promise<{ status: "accepted" }> {
    const workItem = this.findWorkItem(prdJiraKey);
    const issue = this.store.externalIssues.get(prdJiraKey);

    this.store.agentJobs.push(
      this.createJob(workItem, "prd.apply_feedback_revision", {
        requestedBy: request.requestedBy,
        feedback: request.feedback
      })
    );

    if (issue) {
      issue.status = "revision_requested";
    }

    return { status: "accepted" };
  }

  private findWorkItem(primaryJiraKey: string): WorkItem {
    const workItem = this.store.workItems.find((item) => item.primaryJiraKey === primaryJiraKey);

    if (!workItem) {
      throw new Error(`No work item found for PRD Jira ticket: ${primaryJiraKey}`);
    }

    return workItem;
  }

  private createJob(workItem: WorkItem, jobType: AgentJob["jobType"], input: Record<string, unknown>): AgentJob {
    return {
      id: this.nextJobId(),
      workItemId: workItem.id,
      jobType,
      primaryJiraKey: workItem.primaryJiraKey,
      status: "pending",
      input
    };
  }

  private nextWorkItemId(): string {
    return `wi_${this.store.workItems.length + 1}`;
  }

  private nextRunId(): string {
    return `run_${this.store.workItems.length + 1}`;
  }

  private nextJobId(): string {
    return `job_${this.store.agentJobs.length + 1}`;
  }
}
