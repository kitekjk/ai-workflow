import { createEmptyStore } from "../prd-confirmation/domain";
import { createPrdConfirmationFixture } from "../prd-confirmation/fixture";
import { PrdConfirmationWorkflow } from "../prd-confirmation/workflow";
import { AdapterBackedPrdSkills } from "../prd-confirmation/adapter-backed-skills";
import { ConfluenceWikiPublisher } from "../integrations/confluence-wiki";
import { JiraRestClient } from "../integrations/jira-client";
import { LocalGitPrdRepository } from "../integrations/local-git-prd-repository";
import { runRunnerWorkerOnce } from "../prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../prd-confirmation/scheduler";
import { runEngineOnce } from "../prd-confirmation/workflow-engine";

export type RuntimeFixture = ReturnType<typeof createPrdConfirmationFixture>;

export function createRuntimeFromEnv(env: NodeJS.ProcessEnv): RuntimeFixture {
  if (env.INTEGRATION_MODE !== "real") {
    return createPrdConfirmationFixture({
      qualityPasses: env.STUB_QUALITY_PASSES !== "false"
    });
  }

  const store = createEmptyStore();
  const jiraReader = new JiraRestClient({
    baseUrl: requireEnv(env, "JIRA_BASE_URL"),
    email: env.JIRA_EMAIL,
    apiToken: requireEnv(env, "JIRA_API_TOKEN"),
    authMode: parseJiraAuthMode(env.JIRA_AUTH_MODE),
    apiVersion: parseJiraApiVersion(env.JIRA_API_VERSION)
  });
  const skills = new AdapterBackedPrdSkills({
    qualityPasses: env.STUB_QUALITY_PASSES !== "false",
    prdRepository: new LocalGitPrdRepository({
      repoPath: requireEnv(env, "PRD_REPO_PATH"),
      publicBaseUrl: env.PRD_REPO_PUBLIC_BASE_URL
    }),
    wikiPublisher: new ConfluenceWikiPublisher({
      baseUrl: requireEnv(env, "CONFLUENCE_BASE_URL"),
      email: requireEnv(env, "CONFLUENCE_EMAIL"),
      apiToken: requireEnv(env, "CONFLUENCE_API_TOKEN"),
      spaceKey: requireEnv(env, "CONFLUENCE_SPACE_KEY"),
      parentPageId: requireEnv(env, "CONFLUENCE_PARENT_PAGE_ID")
    })
  });
  const workflow = new PrdConfirmationWorkflow(store, { jiraReader });

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

      throw new Error("Runtime did not become idle");
    }
  };
}

function parseJiraAuthMode(value: string | undefined): "basic" | "bearer" {
  if (value === "bearer") {
    return "bearer";
  }

  return "basic";
}

function parseJiraApiVersion(value: string | undefined): "2" | "3" {
  if (value === "2") {
    return "2";
  }

  return "3";
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} is required when INTEGRATION_MODE=real`);
  }

  return value;
}
