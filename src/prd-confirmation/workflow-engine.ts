import type { AgentJob, AgentJobResult, PrdConfirmationStore, WorkItem } from "./domain";

export async function runEngineOnce(store: PrdConfirmationStore): Promise<boolean> {
  const result = store.agentJobResults.find((candidate) => !candidate.processed);

  if (!result) {
    return false;
  }

  const workItem = findWorkItemForResult(store, result);

  if (result.output.status === "failed") {
    workItem.state = "failed";
    result.processed = true;
    return true;
  }

  if (result.jobType === "prd.generate_draft") {
    store.agentJobs.push(createJob(store, workItem, "prd.evaluate_quality", {}));
    workItem.state = "evaluating";
  }

  if (result.jobType === "prd.evaluate_quality") {
    const issue = store.externalIssues.get(result.primaryJiraKey);

    if (result.output.status === "passed") {
      workItem.state = "awaiting_approval";
      if (issue) {
        issue.status = "awaiting_approval";
      }
    } else {
      workItem.state = "needs_revision";
      if (issue) {
        issue.status = "needs_revision";
      }
    }
  }

  if (result.jobType === "prd.apply_feedback_revision") {
    workItem.state = "evaluating";
    store.agentJobs.push(createJob(store, workItem, "prd.evaluate_quality", {}));
  }

  result.processed = true;
  return true;
}

function findWorkItemForResult(store: PrdConfirmationStore, result: AgentJobResult): WorkItem {
  const job = store.agentJobs.find((candidate) => candidate.id === result.jobId);
  const workItem = job ? store.workItems.find((candidate) => candidate.id === job.workItemId) : undefined;

  if (!workItem) {
    throw new Error(`No work item found for job result: ${result.jobId}`);
  }

  return workItem;
}

function createJob(
  store: PrdConfirmationStore,
  workItem: WorkItem,
  jobType: AgentJob["jobType"],
  input: Record<string, unknown>
): AgentJob {
  return {
    id: `job_${store.agentJobs.length + 1}`,
    workItemId: workItem.id,
    jobType,
    primaryJiraKey: workItem.primaryJiraKey,
    status: "pending",
    input
  };
}
