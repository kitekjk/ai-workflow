import type { PrdConfirmationStore } from "./domain";

export async function runSchedulerOnce(store: PrdConfirmationStore): Promise<boolean> {
  const job = store.agentJobs.find((candidate) => candidate.status === "pending");

  if (!job) {
    return false;
  }

  job.status = "claimed";
  return true;
}
