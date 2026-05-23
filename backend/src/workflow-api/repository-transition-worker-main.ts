import "dotenv/config";
import { createWorkflowApiRuntimeFromEnv, type WorkflowApiRuntime } from "../runtime/create-workflow-api-runtime";
import { runRepositoryTransitionWorkerOnce } from "./repository-transition-worker";

async function main(): Promise<void> {
  const runtime = createWorkflowApiRuntimeFromEnv(process.env);

  try {
    const dependencies = requireRepositoryTransitionWorkerDependencies(runtime);

    if (process.env.WORKFLOW_REPOSITORY_TRANSITION_ONCE === "true") {
      const result = await runRepositoryTransitionWorkerOnce({
        ...dependencies,
        now: new Date()
      });
      console.log(JSON.stringify(result));
      return;
    }

    const intervalMs = requireRepositoryTransitionInterval(runtime);
    let stopped = false;
    const stop = () => {
      stopped = true;
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    while (!stopped) {
      const result = await runRepositoryTransitionWorkerOnce({
        ...dependencies,
        now: new Date()
      });
      console.log(JSON.stringify(result));
      await delay(intervalMs);
    }
  } finally {
    await runtime.close();
  }
}

function requireRepositoryTransitionWorkerDependencies(runtime: WorkflowApiRuntime) {
  if (
    !runtime.readModel ||
    !runtime.workflowTransitionCommand ||
    !runtime.repositoryTransitionResultReader
  ) {
    throw new Error(
      "Repository transition worker requires the MySQL no-fixture runtime, which is the default when WORKFLOW_RUNTIME_STORE is unset or set to mysql"
    );
  }

  return {
    readModel: runtime.readModel,
    workflowTransitionCommand: runtime.workflowTransitionCommand,
    repositoryTransitionResultReader: runtime.repositoryTransitionResultReader
  };
}

function requireRepositoryTransitionInterval(runtime: WorkflowApiRuntime): number {
  if (runtime.repositoryTransitionIntervalMs === undefined) {
    throw new Error("WORKFLOW_REPOSITORY_TRANSITION_MS must be enabled for continuous worker mode");
  }

  return runtime.repositoryTransitionIntervalMs;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
