import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalGitPrdRepository } from "../../src/integrations/local-git-prd-repository";

describe("LocalGitPrdRepository", () => {
  it("commits PRD markdown directly to the current branch", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "prd-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: repoPath });

    const repository = new LocalGitPrdRepository({
      repoPath,
      publicBaseUrl: "https://git.example.com/org/prd-repo/blob/main"
    });

    const result = await repository.commitPrd({
      jiraKey: "PRD-100",
      markdown: "# PRD-100\n\nGenerated content.",
      message: "docs: update PRD-100"
    });

    expect(result).toMatchObject({
      type: "prd_markdown",
      location: "git",
      path: "prds/PRD-100.md",
      url: "https://git.example.com/org/prd-repo/blob/main/prds/PRD-100.md"
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(repoPath, "prds", "PRD-100.md"), "utf8")).toContain("Generated content.");
  });

  it("returns the current commit when the PRD content is unchanged", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "prd-repo-noop-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
    execFileSync("git", ["config", "user.email", "workflow@example.com"], { cwd: repoPath });
    execFileSync("git", ["config", "user.name", "AI Workflow"], { cwd: repoPath });

    const repository = new LocalGitPrdRepository({ repoPath });
    const first = await repository.commitPrd({
      jiraKey: "PRD-100",
      markdown: "# PRD-100\n\nGenerated content.",
      message: "docs: update PRD-100"
    });
    const second = await repository.commitPrd({
      jiraKey: "PRD-100",
      markdown: "# PRD-100\n\nGenerated content.",
      message: "docs: update PRD-100"
    });

    expect(second.commit).toBe(first.commit);
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoPath }).toString().trim()).toBe("1");
  });
});
