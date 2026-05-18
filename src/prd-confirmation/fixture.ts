import { createEmptyStore, type PrdConfirmationStore } from "./domain";
import { runRunnerWorkerOnce } from "./runner-worker";
import { StubPrdSkills } from "./runner-skills";
import { runSchedulerOnce } from "./scheduler";
import { PrdConfirmationWorkflow } from "./workflow";
import { runEngineOnce } from "./workflow-engine";

export interface FixtureOptions {
  qualityPasses?: boolean;
}

export function createPrdConfirmationFixture(options: FixtureOptions = {}): {
  store: PrdConfirmationStore;
  skills: StubPrdSkills;
  workflow: PrdConfirmationWorkflow;
  runUntilIdle: () => Promise<void>;
} {
  const store = createEmptyStore();
  const skills = new StubPrdSkills(options.qualityPasses ?? true);
  const workflow = new PrdConfirmationWorkflow(store);

  store.externalIssues.set("OPS-1", {
    key: "OPS-1",
    issueType: "operational_request",
    status: "open",
    summary: "Reduce repeated FAQ handling",
    description: "Operations wants fewer repeated FAQ responses."
  });
  store.externalIssues.set("OPS-2", {
    key: "OPS-2",
    issueType: "operational_request",
    status: "open",
    summary: "Improve answer consistency",
    description: "Operators need consistent answers for common customer questions."
  });
  store.externalIssues.set("PRD-100", {
    key: "PRD-100",
    issueType: "prd",
    status: "prd_requested",
    summary: "FAQ automation PRD",
    linkedSourceKeys: ["OPS-1", "OPS-2"]
  });

  return {
    store,
    skills,
    workflow,
    runUntilIdle: async () => {
      for (let i = 0; i < 20; i += 1) {
        const progressed = [
          await runSchedulerOnce(store),
          await runRunnerWorkerOnce(store, skills),
          await runEngineOnce(store)
        ].some(Boolean);

        if (!progressed) {
          return;
        }
      }

      throw new Error("PRD confirmation fixture did not become idle");
    }
  };
}
