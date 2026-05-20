import "dotenv/config";
import { createWorkflowApiRuntimeFromEnv } from "../runtime/create-workflow-api-runtime";
import { createWorkflowApiServer } from "./server";

const port = Number(process.env.WORKFLOW_API_PORT ?? 3000);
const runtime = createWorkflowApiRuntimeFromEnv(process.env);
const restoreResult = await runtime.restorePrdSnapshot?.();
const server = await createWorkflowApiServer({
  fixture: runtime.fixture,
  scheduler: runtime.scheduler,
  documentRepository: runtime.documentRepository,
  wikiFeedbackCollector: runtime.wikiFeedbackCollector,
  snapshotMirror: runtime.snapshotMirror,
  readModel: runtime.readModel,
  prdIntakeCommand: runtime.prdIntakeCommand,
  feedbackRevisionCommand: runtime.feedbackRevisionCommand,
  workflowResultCommand: runtime.workflowResultCommand,
  workflowTransitionCommand: runtime.workflowTransitionCommand
}).listen(port);

console.log(`Workflow API listening at ${server.url}`);
console.log(`Integration mode: ${process.env.INTEGRATION_MODE ?? "stub"}`);
console.log(`Runtime store: ${runtime.runtimeStore}`);
if (restoreResult?.restored) {
  console.log(
    `Restored PRD snapshot from MySQL: ${restoreResult.workItems} work items, ${restoreResult.jobs} jobs`
  );
}
if (process.env.INTEGRATION_MODE !== "real") {
  console.log("Seeded PRD Jira key: PRD-100");
}

const shutdown = async () => {
  await server.close();
  await runtime.close();
};

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
