import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalGitPrdRepository } from "../backend/src/integrations/local-git-prd-repository";
import { createPrdConfirmationFixture } from "../backend/src/legacy/prd-confirmation/fixture";
import { CliPrdSkills } from "../backend/src/legacy/prd-confirmation/cli-prd-skills";
import { runRunnerWorkerOnce } from "../backend/src/legacy/prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../backend/src/legacy/prd-confirmation/scheduler";
import { runEngineOnce } from "../backend/src/legacy/prd-confirmation/workflow-engine";
import { CliEngine } from "../backend/src/runner-engines/cli-engine";

describe("CliPrdSkills", () => {
  it("generates a PRD draft through CLI output and publishes artifacts", async () => {
    const prdRepoPath = createGitRepo("prd-cli-skill-");
    const wiki = new FakeWikiPublisher();
    const bin = createFakeCli(`
const input = await readInput();
if (input.jobType !== "prd.generate_draft") {
  throw new Error("Unexpected job type: " + input.jobType);
}
if (input.promptContract?.documentType !== "prd") {
  throw new Error("Missing PRD prompt contract");
}
if (!input.promptContract?.outputSchema?.required?.includes("markdown")) {
  throw new Error("Missing markdown output schema");
}
console.log(JSON.stringify({
  status: "succeeded",
  markdown: "# PAIR-2 Generated PRD\\n\\nGenerated through CLI.\\n\\n" + input.sourceRequests[0].summary,
  summary: "Generated PRD draft"
}));
`);
    const fixture = createPrdConfirmationFixture();
    const skills = new CliPrdSkills({
      engine: new CliEngine({ command: bin, timeoutMs: 5000 }),
      prdRepository: new LocalGitPrdRepository({
        repoPath: prdRepoPath,
        publicBaseUrl: "https://git.example.com/org/prd-repo/blob/main"
      }),
      wikiPublisher: wiki
    });

    await fixture.workflow.intakePrdTicket("PRD-100");
    await runSchedulerOnce(fixture.store);
    await runRunnerWorkerOnce(fixture.store, skills);
    await runEngineOnce(fixture.store);

    expect(readFileSync(join(prdRepoPath, "prds", "PRD-100.md"), "utf8")).toContain(
      "Generated through CLI"
    );
    expect(wiki.published[0]).toMatchObject({
      jiraKey: "PRD-100",
      title: "PRD-100 Generated PRD"
    });
    expect(wiki.publishedMarkdownPages[0]).toMatchObject({
      documentType: "prd",
      sourceKey: "PRD-100",
      title: "PRD-100 Generated PRD"
    });
    expect(fixture.store.artifacts).toMatchObject([
      {
        type: "prd_markdown",
        location: "git",
        url: "https://git.example.com/org/prd-repo/blob/main/prds/PRD-100.md"
      },
      {
        type: "prd_wiki_page",
        location: "wiki",
        url: "https://wiki.example.com/prd/PRD-100"
      }
    ]);
    expect(fixture.store.agentJobResults[0].output).toMatchObject({
      status: "succeeded",
      summary: "Generated PRD draft"
    });
  });

  it("converts CLI quality JSON to a standard quality gate result", async () => {
    const wiki = new FakeWikiPublisher();
    const bin = createFakeCli(`
const input = await readInput();
if (input.jobType !== "prd.evaluate_quality") {
  throw new Error("Unexpected job type: " + input.jobType);
}
console.log(JSON.stringify({
  status: "needs_revision",
  score: 72,
  missingInformation: ["Success metric is missing"],
  clarificationQuestions: ["What measurable outcome should this target?"],
  riskItems: ["Scope may be unclear"]
}));
`);
    const fixture = createPrdConfirmationFixture();
    const skills = new CliPrdSkills({
      engine: new CliEngine({ command: bin, timeoutMs: 5000 }),
      prdRepository: new LocalGitPrdRepository({ repoPath: createGitRepo("prd-cli-quality-") }),
      wikiPublisher: wiki
    });
    await fixture.workflow.intakePrdTicket("PRD-100");
    fixture.store.agentJobs[0].status = "succeeded";
    fixture.store.agentJobs.push({
      id: "job_2",
      workItemId: "wi_1",
      jobType: "prd.evaluate_quality",
      primaryJiraKey: "PRD-100",
      status: "claimed",
      input: {}
    });

    await runRunnerWorkerOnce(fixture.store, skills);

    expect(fixture.store.agentJobResults[0].output).toEqual({
      status: "needs_revision",
      score: 72,
      missingInformation: ["Success metric is missing"],
      clarificationQuestions: ["What measurable outcome should this target?"],
      riskItems: ["Scope may be unclear"]
    });
    expect(fixture.store.artifacts).toHaveLength(0);
    expect(wiki.published).toHaveLength(0);
  });

  it("passes the generated document markdown and output language into quality evaluation", async () => {
    const bin = createFakeCli(`
const input = await readInput();
if (input.jobType === "prd.generate_draft") {
  console.log(JSON.stringify({
    status: "succeeded",
    markdown: "# PRD-100\\n\\n## 1. 개요\\n\\n한국어 PRD 본문",
    summary: "초안 생성"
  }));
} else if (input.jobType === "prd.evaluate_quality") {
  if (!input.currentDocumentMarkdown?.includes("한국어 PRD 본문")) {
    throw new Error("Missing generated document markdown");
  }
  if (!input.promptContract?.outputSchema?.required?.includes("score")) {
    throw new Error("Missing evaluation output schema");
  }
  if (input.documentType !== "prd") {
    throw new Error("Missing generic document type");
  }
  if (input.outputLanguage !== "ko") {
    throw new Error("Missing Korean output language");
  }
  console.log(JSON.stringify({
    status: "passed",
    score: 91,
    summary: "품질 게이트 통과"
  }));
} else {
  throw new Error("Unexpected job type: " + input.jobType);
}
`);
    const fixture = createPrdConfirmationFixture();
    const skills = new CliPrdSkills({
      engine: new CliEngine({ command: bin, timeoutMs: 5000 }),
      prdRepository: new LocalGitPrdRepository({ repoPath: createGitRepo("prd-cli-language-") }),
      wikiPublisher: new FakeWikiPublisher(),
      outputLanguage: "ko"
    });

    await fixture.workflow.intakePrdTicket("PRD-100");
    await runSchedulerOnce(fixture.store);
    await runRunnerWorkerOnce(fixture.store, skills);
    await runEngineOnce(fixture.store);
    await runSchedulerOnce(fixture.store);
    await runRunnerWorkerOnce(fixture.store, skills);

    expect(fixture.store.agentJobResults.at(-1)?.output).toMatchObject({
      status: "passed",
      summary: "품질 게이트 통과"
    });
  });

  it("applies feedback revision through CLI output and republishes artifacts", async () => {
    const prdRepoPath = createGitRepo("prd-cli-revision-");
    const wiki = new FakeWikiPublisher();
    const bin = createFakeCli(`
const input = await readInput();
if (input.jobType !== "prd.apply_feedback_revision") {
  throw new Error("Unexpected job type: " + input.jobType);
}
console.log(JSON.stringify({
  status: "succeeded",
  markdown: "# PRD-100 Revised PRD\\n\\nMetric: reduce FAQ handling time by 30%.",
  summary: "Applied planner feedback",
  revisionSummary: input.feedback
}));
`);
    const fixture = createPrdConfirmationFixture();
    const skills = new CliPrdSkills({
      engine: new CliEngine({ command: bin, timeoutMs: 5000 }),
      prdRepository: new LocalGitPrdRepository({ repoPath: prdRepoPath }),
      wikiPublisher: wiki
    });
    await fixture.workflow.intakePrdTicket("PRD-100");
    await fixture.workflow.requestFeedbackRevision("PRD-100", {
      requestedBy: "planner@example.com",
      feedback: "Add success metric."
    });
    fixture.store.agentJobs[0].status = "succeeded";
    fixture.store.agentJobs[1].status = "claimed";

    await runRunnerWorkerOnce(fixture.store, skills);

    expect(readFileSync(join(prdRepoPath, "prds", "PRD-100.md"), "utf8")).toContain(
      "reduce FAQ handling time by 30%"
    );
    expect(wiki.publishedMarkdownPages[0]?.markdown).toContain("Revised PRD");
    expect(fixture.store.agentJobResults[0].output).toMatchObject({
      status: "succeeded",
      summary: "Applied planner feedback",
      revisionSummary: "Add success metric."
    });
    expect(fixture.store.artifacts).toMatchObject([
      { type: "prd_markdown", location: "git" },
      { type: "prd_wiki_page", location: "wiki" }
    ]);
  });
});

class FakeWikiPublisher {
  readonly published: Array<{ jiraKey: string; title: string; markdown: string }> = [];
  readonly publishedMarkdownPages: Array<{
    documentType: string;
    sourceKey: string;
    title: string;
    markdown: string;
  }> = [];

  async publishMarkdownPage(input: {
    documentType: string;
    sourceKey: string;
    title: string;
    markdown: string;
  }): Promise<{
    type: "wiki_page";
    documentType: string;
    location: "wiki";
    url: string;
  }> {
    this.publishedMarkdownPages.push(input);
    if (input.documentType === "prd") {
      this.published.push({
        jiraKey: input.sourceKey,
        title: input.title,
        markdown: input.markdown
      });
    }
    return {
      type: "wiki_page",
      documentType: input.documentType,
      location: "wiki",
      url: `https://wiki.example.com/${input.documentType}/${input.sourceKey}`
    };
  }

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

function createGitRepo(prefix: string): string {
  const repoPath = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: repoPath });
  return repoPath;
}

function createFakeCli(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prd-cli-skill-"));
  const bin = join(dir, "fake-cli");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
async function readInput() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
  }
  return JSON.parse(body);
}

${source}
`
  );
  chmodSync(bin, 0o755);
  return bin;
}
