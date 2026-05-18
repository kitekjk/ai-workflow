import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExternalIssue } from "../src/prd-confirmation/domain";
import { createEmptyStore } from "../src/prd-confirmation/domain";
import { AdapterBackedPrdSkills } from "../src/prd-confirmation/adapter-backed-skills";
import { runRunnerWorkerOnce } from "../src/prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../src/prd-confirmation/scheduler";
import { PrdConfirmationWorkflow } from "../src/prd-confirmation/workflow";
import { runEngineOnce } from "../src/prd-confirmation/workflow-engine";
import { LocalGitPrdRepository } from "../src/integrations/local-git-prd-repository";

describe("PRD confirmation with real adapter boundaries", () => {
  it("hydrates an unseeded PRD Jira key through Jira reader during manual intake", async () => {
    const store = createEmptyStore();
    const workflow = new PrdConfirmationWorkflow(store, {
      jiraReader: new FakeJiraReader()
    });

    await workflow.intakePrdTicket("PRD-200");

    expect(store.externalIssues.get("PRD-200")).toMatchObject({
      key: "PRD-200",
      linkedSourceKeys: ["OPS-20"]
    });
    expect(store.externalIssues.get("OPS-20")).toMatchObject({
      summary: "Reduce manual reporting work"
    });
    expect(store.agentJobs).toMatchObject([
      {
        jobType: "prd.generate_draft",
        primaryJiraKey: "PRD-200"
      }
    ]);
  });

  it("uses PRD repo and wiki adapters when generating a draft", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "prd-real-slice-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: repoPath });

    const wiki = new FakeWikiPublisher();
    const store = createEmptyStore();
    const workflow = new PrdConfirmationWorkflow(store, {
      jiraReader: new FakeJiraReader()
    });
    const skills = new AdapterBackedPrdSkills({
      qualityPasses: true,
      prdRepository: new LocalGitPrdRepository({
        repoPath,
        publicBaseUrl: "https://git.example.com/org/prd-repo/blob/main"
      }),
      wikiPublisher: wiki
    });

    await workflow.intakePrdTicket("PRD-200");
    await runSchedulerOnce(store);
    await runRunnerWorkerOnce(store, skills);
    await runEngineOnce(store);

    expect(store.artifacts).toMatchObject([
      {
        type: "prd_markdown",
        location: "git",
        url: "https://git.example.com/org/prd-repo/blob/main/prds/PRD-200.md"
      },
      {
        type: "prd_wiki_page",
        location: "wiki",
        url: "https://wiki.example.com/prd/PRD-200"
      }
    ]);
    expect(wiki.published[0]).toMatchObject({
      jiraKey: "PRD-200",
      title: "PRD-200 Generated PRD"
    });
  });

  it("marks a runner job failed when an adapter throws", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "prd-failed-slice-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: repoPath });

    const store = createEmptyStore();
    const workflow = new PrdConfirmationWorkflow(store, {
      jiraReader: new FakeJiraReader()
    });
    const skills = new AdapterBackedPrdSkills({
      qualityPasses: true,
      prdRepository: new LocalGitPrdRepository({ repoPath }),
      wikiPublisher: new ThrowingWikiPublisher()
    });

    await workflow.intakePrdTicket("PRD-200");
    await runSchedulerOnce(store);
    await runRunnerWorkerOnce(store, skills);
    await runEngineOnce(store);

    expect(store.agentJobs[0]).toMatchObject({
      jobType: "prd.generate_draft",
      status: "failed"
    });
    expect(store.agentJobs).toHaveLength(1);
    expect(store.agentJobResults[0].output).toMatchObject({
      status: "failed",
      error: "wiki exploded"
    });
  });
});

class FakeJiraReader {
  async loadPrdWithSources(prdJiraKey: string): Promise<{
    prd: ExternalIssue;
    sources: ExternalIssue[];
  }> {
    return {
      prd: {
        key: prdJiraKey,
        issueType: "prd",
        status: "prd_requested",
        summary: "Reporting automation PRD",
        linkedSourceKeys: ["OPS-20"]
      },
      sources: [
        {
          key: "OPS-20",
          issueType: "operational_request",
          status: "open",
          summary: "Reduce manual reporting work",
          description: "Operations wants weekly reporting to be automated."
        }
      ]
    };
  }
}

class FakeWikiPublisher {
  readonly published: Array<Record<string, unknown>> = [];

  async publishPrd(input: { jiraKey: string; title: string; markdown: string }): Promise<{
    type: "prd_wiki_page";
    location: "wiki";
    url: string;
  }> {
    this.published.push(input);
    return {
      type: "prd_wiki_page",
      location: "wiki",
      url: `https://wiki.example.com/prd/${input.jiraKey}`
    };
  }
}

class ThrowingWikiPublisher {
  async publishPrd(): Promise<never> {
    throw new Error("wiki exploded");
  }
}
