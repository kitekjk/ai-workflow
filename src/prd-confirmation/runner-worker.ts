import type { PrdConfirmationStore } from "./domain";
import type { PrdSkillExecutor } from "./ports";
import { createJobResult, StubPrdSkills } from "./runner-skills";

export async function runRunnerWorkerOnce(
  store: PrdConfirmationStore,
  skills: StubPrdSkills | PrdSkillExecutor
): Promise<boolean> {
  const job = store.agentJobs.find((candidate) => candidate.status === "claimed");

  if (!job) {
    return false;
  }

  job.status = "running";
  try {
    const result = await skills.execute(job, store);

    store.artifacts.push(...result.artifacts);
    store.agentJobResults.push(createJobResult(job, result.output));
    job.status = "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.agentJobResults.push(
      createJobResult(job, {
        status: "failed",
        error: message
      })
    );
    job.status = "failed";
  }

  return true;
}
