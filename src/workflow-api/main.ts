import "dotenv/config";
import { createRuntimeFromEnv } from "../runtime/create-runtime";
import { createWorkflowApiServer } from "./server";

const port = Number(process.env.WORKFLOW_API_PORT ?? 3000);
const fixture = createRuntimeFromEnv(process.env);
const server = await createWorkflowApiServer({ fixture }).listen(port);

console.log(`Workflow API listening at ${server.url}`);
console.log(`Integration mode: ${process.env.INTEGRATION_MODE ?? "stub"}`);
if (process.env.INTEGRATION_MODE !== "real") {
  console.log("Seeded PRD Jira key: PRD-100");
}
