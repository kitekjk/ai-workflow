import { createPrdConfirmationFixture } from "../prd-confirmation/fixture";

const fixture = createPrdConfirmationFixture({ qualityPasses: false });

await fixture.workflow.intakePrdTicket("PRD-100");
await fixture.runUntilIdle();

console.log("After initial quality gate:");
console.log(JSON.stringify(summarize(fixture), null, 2));

await fixture.workflow.requestFeedbackRevision("PRD-100", {
  requestedBy: "planner@example.com",
  feedback: "Add success metric: reduce repeated FAQ handling time by 30%."
});
fixture.skills.qualityPasses = true;
await fixture.runUntilIdle();

console.log("After feedback revision:");
console.log(JSON.stringify(summarize(fixture), null, 2));

function summarize(fixtureValue: typeof fixture): Record<string, unknown> {
  return {
    prdStatus: fixtureValue.store.externalIssues.get("PRD-100")?.status,
    jobs: fixtureValue.store.agentJobs.map((job) => ({
      id: job.id,
      type: job.jobType,
      jira: job.primaryJiraKey,
      status: job.status
    })),
    artifacts: fixtureValue.store.artifacts.map((artifact) => ({
      type: artifact.type,
      location: artifact.location,
      url: artifact.url
    })),
    latestResult: fixtureValue.store.agentJobResults.at(-1)?.output
  };
}
