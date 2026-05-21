import type { WorkflowApiReadModel } from "./mysql-read-model";
import {
  RepositoryTransitionProcessor,
  type ProcessRepositoryJobResultOutput,
  type RepositoryTransitionPendingResultReader
} from "./repository-transition-processor";
import type { WorkflowTransitionCommand } from "./workflow-transition-command";

export interface RunRepositoryTransitionWorkerOnceInput {
  readModel: WorkflowApiReadModel;
  workflowTransitionCommand: WorkflowTransitionCommand;
  repositoryTransitionResultReader: RepositoryTransitionPendingResultReader;
  repositoryTransitionClaimStore?: RepositoryTransitionClaimStore;
  now: Date;
}

export interface RepositoryTransitionClaimStore {
  markJobResultProcessed(input: { jobResultId: string; now: Date }): Promise<void>;
}

export async function runRepositoryTransitionWorkerOnce(
  input: RunRepositoryTransitionWorkerOnceInput
): Promise<ProcessRepositoryJobResultOutput> {
  const pending = await input.repositoryTransitionResultReader.nextPendingJobResult({
    now: input.now
  });

  if (!pending) {
    return { processed: false };
  }

  const result = await new RepositoryTransitionProcessor({
    readModel: input.readModel,
    workflowTransitionCommand: input.workflowTransitionCommand
  }).processJobResult({
    job: pending.job,
    jobResult: pending.jobResult,
    now: input.now
  });

  const claimStore = input.repositoryTransitionClaimStore ?? claimStoreFromReader(input.repositoryTransitionResultReader);

  if (result.processed && claimStore) {
    await claimStore.markJobResultProcessed({
      jobResultId: pending.jobResult.id,
      now: input.now
    });
  }

  return result;
}

function claimStoreFromReader(reader: RepositoryTransitionPendingResultReader): RepositoryTransitionClaimStore | undefined {
  const candidate = reader as Partial<RepositoryTransitionClaimStore>;
  return typeof candidate.markJobResultProcessed === "function"
    ? candidate as RepositoryTransitionClaimStore
    : undefined;
}
