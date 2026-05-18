import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LocalGitPrdRepositoryOptions {
  repoPath: string;
  publicBaseUrl?: string;
}

export interface CommitPrdInput {
  jiraKey: string;
  markdown: string;
  message: string;
}

export interface CommitPrdResult {
  type: "prd_markdown";
  location: "git";
  path: string;
  url: string;
  commit: string;
}

export class LocalGitPrdRepository {
  constructor(private readonly options: LocalGitPrdRepositoryOptions) {}

  async commitPrd(input: CommitPrdInput): Promise<CommitPrdResult> {
    const path = `prds/${input.jiraKey}.md`;
    const absolutePath = join(this.options.repoPath, path);

    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.markdown, "utf8");
    await execFileAsync("git", ["add", path], { cwd: this.options.repoPath });
    if (await hasStagedChanges(this.options.repoPath)) {
      await execFileAsync("git", ["commit", "-m", input.message], { cwd: this.options.repoPath });
    }

    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: this.options.repoPath });
    const commit = stdout.trim();

    return {
      type: "prd_markdown",
      location: "git",
      path,
      url: this.publicUrlFor(path),
      commit
    };
  }

  private publicUrlFor(path: string): string {
    if (!this.options.publicBaseUrl) {
      return `file://${join(this.options.repoPath, path)}`;
    }

    return `${this.options.publicBaseUrl.replace(/\/$/, "")}/${path}`;
  }
}

async function hasStagedChanges(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: repoPath });
    return false;
  } catch (error: any) {
    if (typeof error?.code === "number" && error.code === 1) {
      return true;
    }

    throw error;
  }
}
