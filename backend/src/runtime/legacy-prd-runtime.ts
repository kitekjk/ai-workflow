import type { WikiFeedbackCollector } from "../integrations/workflow-ports";
import { createEmptyStore } from "../legacy/prd-confirmation/domain";
import { createPrdConfirmationFixture } from "../legacy/prd-confirmation/fixture";
import { PrdConfirmationWorkflow } from "../legacy/prd-confirmation/workflow";
import { AdapterBackedPrdSkills } from "../legacy/prd-confirmation/adapter-backed-skills";
import { CliPrdSkills } from "../legacy/prd-confirmation/cli-prd-skills";
import type { PrdSkillExecutor, WikiPublisher } from "../legacy/prd-confirmation/ports";
import { StubPrdSkills } from "../legacy/prd-confirmation/runner-skills";
import { LocalGitPrdRepository } from "../integrations/local-git-prd-repository";
import { runRunnerWorkerOnce } from "../legacy/prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../legacy/prd-confirmation/scheduler";
import { runEngineOnce } from "../legacy/prd-confirmation/workflow-engine";
import { CliEngine } from "../runner-engines/cli-engine";
import { createCliEngineConfig } from "../runner-engines/engine-config";
import {
  createConfluenceWikiPublisher,
  createJiraIssueReaderFromEnv,
  maybeCreateConfluenceWikiPublisher,
  requireEnv
} from "./integration-config";

export interface LegacyPrdRuntimeFixture {
  store: ReturnType<typeof createPrdConfirmationFixture>["store"];
  skills: StubPrdSkills | PrdSkillExecutor;
  workflow: PrdConfirmationWorkflow;
  wikiFeedbackCollector?: WikiFeedbackCollector;
  runUntilIdle: () => Promise<void>;
}

export function createLegacyPrdRuntimeFromEnv(env: NodeJS.ProcessEnv): LegacyPrdRuntimeFixture {
  if (env.INTEGRATION_MODE !== "real") {
    return createPrdConfirmationFixture({
      qualityPasses: env.STUB_QUALITY_PASSES !== "false"
    });
  }

  const store = createEmptyStore();
  const jiraReader = createJiraIssueReaderFromEnv(env);
  const wikiPublisher = maybeCreateConfluenceWikiPublisher(env);
  const skills = createLegacyPrdSkills(env, wikiPublisher);
  const workflow = new PrdConfirmationWorkflow(store, { jiraReader });

  return {
    store,
    skills,
    workflow,
    wikiFeedbackCollector: wikiPublisher,
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

      throw new Error("Runtime did not become idle");
    }
  };
}

function createLegacyPrdSkills(env: NodeJS.ProcessEnv, wikiPublisher?: WikiPublisher): StubPrdSkills | PrdSkillExecutor {
  const mode = parseRunnerSkillMode(env.RUNNER_SKILL_MODE);

  if (mode === "stub") {
    return new StubPrdSkills(env.STUB_QUALITY_PASSES !== "false");
  }

  const prdRepository = new LocalGitPrdRepository({
    repoPath: requireEnv(env, "PRD_REPO_PATH"),
    publicBaseUrl: env.PRD_REPO_PUBLIC_BASE_URL
  });
  const publisher = wikiPublisher ?? createConfluenceWikiPublisher(env);

  if (mode === "cli") {
    const config = createCliEngineConfig(env);
    return new CliPrdSkills({
      engine: new CliEngine({
        command: config.command,
        args: config.args,
        timeoutMs: config.timeoutMs,
        cwd: config.cwd
      }),
      prdRepository,
      wikiPublisher: publisher,
      outputLanguage: env.RUNNER_OUTPUT_LANGUAGE ?? "ko"
    });
  }

  return new AdapterBackedPrdSkills({
    qualityPasses: env.STUB_QUALITY_PASSES !== "false",
    prdRepository,
    wikiPublisher: publisher
  });
}

function parseRunnerSkillMode(value: string | undefined): "stub" | "adapter" | "cli" {
  if (!value || value === "adapter") {
    return "adapter";
  }

  if (value === "stub" || value === "cli") {
    return value;
  }

  throw new Error(`RUNNER_SKILL_MODE must be "stub", "adapter", or "cli", got: ${value}`);
}
