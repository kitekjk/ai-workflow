import { execFile } from "node:child_process";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GitHubRestClient } from "../integrations/github-client";
import type { WorkflowJob } from "../workflow-core/domain";
import type { LocalRunnerEngine, LocalRunnerEngineInput, LocalRunnerEngineResult } from "./local-runner";

const execFileAsync = promisify(execFile);

export interface GitHubImplementationLocalRunnerEngineOptions {
  client: Pick<GitHubRestClient, "createBranch" | "createPullRequest" | "readPullRequestStatus">;
  owner: string;
  repo: string;
  defaultBaseBranch?: string;
}

export class GitHubImplementationLocalRunnerEngine implements LocalRunnerEngine {
  constructor(private readonly options: GitHubImplementationLocalRunnerEngineOptions) {}

  canRun(input: LocalRunnerEngineInput): boolean {
    return isGitHubImplementationJobType(input.job.jobType);
  }

  async run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    if (input.job.jobType === "implementation.open_pr") {
      return this.openPullRequest(input);
    }

    if (input.job.jobType === "implementation.collect_pr_status") {
      return this.collectPullRequestStatus(input);
    }

    throw new Error(`Unsupported GitHub implementation job type: ${input.job.jobType}`);
  }

  private async openPullRequest(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const documentId = optionalString(input.job.input.documentId);
    const documentVersionId = optionalString(input.job.input.documentVersionId);
    const branchName = requireString(input.job.input.branchName, "branchName");
    const baseBranch = optionalString(input.job.input.baseBranch) ?? this.options.defaultBaseBranch ?? "main";
    const title = requireString(input.job.input.title, "title");
    const body = requireString(input.job.input.body, "body");
    const draft = optionalBoolean(input.job.input.draft) ?? true;

    const branch = await this.options.client.createBranch({
      branchName,
      fromBranch: baseBranch
    });
    const pullRequest = await this.options.client.createPullRequest({
      title,
      body,
      head: branchName,
      base: baseBranch,
      draft
    });

    return {
      output: {
        status: "pull_request_opened",
        provider: "github",
        repository: `${this.options.owner}/${this.options.repo}`,
        branchName,
        baseBranch,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        pullRequestState: pullRequest.state,
        draft: pullRequest.draft
      },
      artifacts: [
        {
          documentId,
          documentVersionId,
          type: "pull_request",
          location: "external",
          uri: pullRequest.url,
          externalId: String(pullRequest.number),
          externalVersion: branch.sha,
          metadata: {
            provider: "github",
            owner: this.options.owner,
            repo: this.options.repo,
            branchName,
            baseBranch,
            state: pullRequest.state,
            draft: pullRequest.draft,
            reviewStatus: "pending",
            ciStatus: "pending"
          }
        }
      ],
      logs: [
        {
          level: "info",
          message: "GitHub pull request opened",
          metadata: {
            pullRequestNumber: pullRequest.number,
            branchName
          }
        }
      ]
    };
  }

  private async collectPullRequestStatus(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const documentId = optionalString(input.job.input.documentId);
    const documentVersionId = optionalString(input.job.input.documentVersionId);
    const pullNumber = requirePositiveInteger(input.job.input.pullNumber, "pullNumber");
    const status = await this.options.client.readPullRequestStatus(pullNumber);
    const revisionRequired = status.reviewStatus === "changes_requested";
    const reworkRequired = !revisionRequired && status.ciStatus === "failure";

    return {
      output: {
        status: "pull_request_status_collected",
        provider: "github",
        repository: `${this.options.owner}/${this.options.repo}`,
        pullRequestNumber: status.number,
        pullRequestUrl: status.url,
        pullRequestState: status.state,
        draft: status.draft,
        merged: status.merged,
        branchName: status.branchName,
        baseBranch: status.baseBranch,
        repositoryCloneUrl: status.repositoryCloneUrl,
        latestCommitSha: status.latestCommitSha,
        reviewStatus: status.reviewStatus,
        ciStatus: status.ciStatus,
        checkRuns: status.checkRuns,
        revisionRequired,
        reworkRequired,
        failureScope: revisionRequired ? "document" : reworkRequired ? "implementation" : undefined,
        feedback: revisionRequired
          ? implementationRevisionFeedbackFor(status)
          : reworkRequired
            ? implementationReworkFeedbackFor(status)
            : undefined
      },
      artifacts: [
        {
          documentId,
          documentVersionId,
          type: "pull_request",
          location: "external",
          uri: status.url,
          externalId: String(status.number),
          externalVersion: status.latestCommitSha,
          metadata: {
            provider: "github",
            owner: this.options.owner,
            repo: this.options.repo,
            branchName: status.branchName,
            baseBranch: status.baseBranch,
            repositoryCloneUrl: status.repositoryCloneUrl,
            state: status.state,
            draft: status.draft,
            merged: status.merged,
            reviewStatus: status.reviewStatus,
            ciStatus: status.ciStatus,
            checkRuns: status.checkRuns
          }
        }
      ],
      logs: [
        {
          level: "info",
          message: "GitHub pull request status collected",
          metadata: {
            pullRequestNumber: status.number,
            reviewStatus: status.reviewStatus,
            ciStatus: status.ciStatus
          }
        }
      ]
    };
  }
}

export interface ImplementationPullRequestLocalRunnerEngineOptions {
  client: Pick<GitHubRestClient, "createPullRequest">;
  cliEngine: LocalRunnerEngine;
  owner: string;
  repo: string;
  repositoryCloneUrl?: string;
  defaultBaseBranch?: string;
}

export class ImplementationPullRequestLocalRunnerEngine implements LocalRunnerEngine {
  constructor(private readonly options: ImplementationPullRequestLocalRunnerEngineOptions) {}

  canRun(input: LocalRunnerEngineInput): boolean {
    return (
      input.job.jobType === "implementation.open_pr" &&
      Boolean(input.workspaceDir) &&
      Boolean(this.repositoryCloneUrlFor(input.job))
    );
  }

  async run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const documentId = optionalString(input.job.input.documentId);
    const documentVersionId = optionalString(input.job.input.documentVersionId);
    const branchName = requireString(input.job.input.branchName, "branchName");
    const baseBranch = optionalString(input.job.input.baseBranch) ?? this.options.defaultBaseBranch ?? "main";
    const title = requireString(input.job.input.title, "title");
    const body = requireString(input.job.input.body, "body");
    const draft = optionalBoolean(input.job.input.draft) ?? true;
    const repositoryCloneUrl = requireString(this.repositoryCloneUrlFor(input.job), "repositoryCloneUrl");
    const implementationDir = await prepareImplementationBranchWorkspace({
      workspaceDir: requireString(input.workspaceDir, "workspaceDir"),
      repositoryCloneUrl,
      baseBranch,
      branchName
    });
    const implementationJob = {
      ...input.job,
      input: {
        ...input.job.input,
        repository: `${this.options.owner}/${this.options.repo}`,
        repositoryCloneUrl,
        baseBranch,
        branchName,
        runnerJobTemplate: {
          ...recordOrEmpty(input.job.input.runnerJobTemplate),
          runner: {
            ...recordOrEmpty(recordOrEmpty(input.job.input.runnerJobTemplate).runner),
            sandbox: optionalString(recordOrEmpty(recordOrEmpty(input.job.input.runnerJobTemplate).runner).sandbox) ?? "workspace-write",
            workdir: optionalString(recordOrEmpty(recordOrEmpty(input.job.input.runnerJobTemplate).runner).workdir) ?? "implementation"
          }
        }
      }
    };
    const implementationResult = await this.options.cliEngine.run({
      ...input,
      job: implementationJob
    });
    const latestCommitSha =
      optionalString(implementationResult.output.latestCommitSha) ?? (await currentGitCommit(implementationDir));
    await pushImplementationBranch(implementationDir, branchName);
    const pullRequest = await this.options.client.createPullRequest({
      title,
      body,
      head: branchName,
      base: baseBranch,
      draft
    });

    return {
      output: {
        ...implementationResult.output,
        status: "pull_request_opened",
        provider: "github",
        repository: `${this.options.owner}/${this.options.repo}`,
        repositoryCloneUrl,
        branchName,
        baseBranch,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        pullRequestState: pullRequest.state,
        draft: pullRequest.draft,
        latestCommitSha
      },
      artifacts: [
        ...(implementationResult.artifacts ?? []),
        {
          documentId,
          documentVersionId,
          type: "pull_request",
          location: "external",
          uri: pullRequest.url,
          externalId: String(pullRequest.number),
          externalVersion: latestCommitSha,
          metadata: {
            provider: "github",
            owner: this.options.owner,
            repo: this.options.repo,
            repositoryCloneUrl,
            branchName,
            baseBranch,
            state: pullRequest.state,
            draft: pullRequest.draft,
            reviewStatus: "pending",
            ciStatus: "pending",
            implementationSummary: optionalString(implementationResult.output.summary)
          }
        }
      ],
      generatedFiles: implementationResult.generatedFiles,
      logs: [
        ...(implementationResult.logs ?? []),
        {
          level: "info",
          message: "Implementation branch pushed",
          metadata: {
            branchName,
            latestCommitSha
          }
        },
        {
          level: "info",
          message: "Implementation pull request opened",
          metadata: {
            pullRequestNumber: pullRequest.number,
            branchName
          }
        }
      ]
    };
  }

  private repositoryCloneUrlFor(job: WorkflowJob): string | undefined {
    return optionalString(job.input.repositoryCloneUrl) ?? this.options.repositoryCloneUrl;
  }
}

export interface ImplementationUpdateLocalRunnerEngineOptions {
  cliEngine: LocalRunnerEngine;
}

export class ImplementationUpdateLocalRunnerEngine implements LocalRunnerEngine {
  constructor(private readonly options: ImplementationUpdateLocalRunnerEngineOptions) {}

  canRun(input: LocalRunnerEngineInput): boolean {
    return input.job.jobType === "implementation.update_pr" && Boolean(input.workspaceDir) && Boolean(branchNameForJob(input.job));
  }

  async run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const result = await this.options.cliEngine.run(input);
    const branchName = requireString(branchNameForJob(input.job), "branchName");
    const implementationDir = await implementationWorkdirFor({
      workspaceDir: requireString(input.workspaceDir, "workspaceDir"),
      workdir: optionalString(recordOrEmpty(recordOrEmpty(input.job.input.runnerJobTemplate).runner).workdir) ?? "implementation"
    });
    const latestCommitSha = optionalString(result.output.latestCommitSha) ?? (await currentGitCommit(implementationDir));
    await pushImplementationBranch(implementationDir, branchName);

    return {
      ...result,
      output: {
        ...result.output,
        latestCommitSha
      },
      logs: [
        ...(result.logs ?? []),
        {
          level: "info",
          message: "Implementation update branch pushed",
          metadata: {
            branchName,
            latestCommitSha
          }
        }
      ]
    };
  }
}

export class RoutedLocalRunnerEngine implements LocalRunnerEngine {
  constructor(
    private readonly routes: Array<{ canRun(input: LocalRunnerEngineInput): boolean; engine: LocalRunnerEngine }>,
    private readonly fallback: LocalRunnerEngine
  ) {}

  async run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const route = this.routes.find((candidate) => candidate.canRun(input));
    return (route?.engine ?? this.fallback).run(input);
  }
}

export function isGitHubImplementationJobType(jobType: string): boolean {
  return jobType === "implementation.open_pr" || jobType === "implementation.collect_pr_status";
}

function implementationRevisionFeedbackFor(status: Awaited<ReturnType<GitHubRestClient["readPullRequestStatus"]>>): string {
  return implementationStatusFeedbackFor("Implementation PR requires document revision", status);
}

function implementationReworkFeedbackFor(status: Awaited<ReturnType<GitHubRestClient["readPullRequestStatus"]>>): string {
  return implementationStatusFeedbackFor("Implementation PR requires a code update", status);
}

function implementationStatusFeedbackFor(
  headline: string,
  status: Awaited<ReturnType<GitHubRestClient["readPullRequestStatus"]>>
): string {
  const failedChecks = status.checkRuns.filter(
    (checkRun) => checkRun.status === "completed" && !["success", "neutral", "skipped"].includes(checkRun.conclusion ?? "")
  );
  const lines = [
    `${headline}: ${status.url}`,
    `Review status: ${status.reviewStatus}`,
    `CI status: ${status.ciStatus}`,
    failedChecks.length > 0
      ? `Failing checks: ${failedChecks.map((checkRun) => checkRun.name).join(", ")}`
      : undefined
  ];

  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required for GitHub implementation jobs`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error("draft must be a boolean for GitHub implementation jobs");
  }

  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer for GitHub implementation jobs`);
  }

  return parsed;
}

async function prepareImplementationBranchWorkspace(input: {
  workspaceDir: string;
  repositoryCloneUrl: string;
  baseBranch: string;
  branchName: string;
}): Promise<string> {
  const workspaceDir = await realpath(resolve(input.workspaceDir));
  const implementationDir = await implementationWorkdirFor({ workspaceDir, workdir: "implementation", mustExist: false });
  await mkdir(implementationDir, { recursive: true });
  const entries = await readdir(implementationDir);

  if (entries.length === 0) {
    await execGit(["clone", "--branch", input.baseBranch, "--single-branch", input.repositoryCloneUrl, implementationDir]);
  } else if (!entries.includes(".git")) {
    throw new Error("implementation.open_pr workdir must be empty or an existing git checkout");
  }

  const remoteBranchExists = await gitRemoteBranchExists(implementationDir, input.branchName);

  if (remoteBranchExists) {
    await execGit(["-C", implementationDir, "fetch", "origin", input.branchName]);
    await execGit(["-C", implementationDir, "checkout", "-B", input.branchName, "FETCH_HEAD"]);
  } else {
    await execGit(["-C", implementationDir, "checkout", "-B", input.branchName]);
  }

  const canonicalImplementationDir = await realpath(implementationDir);
  assertPathInside(workspaceDir, canonicalImplementationDir, "implementation workdir");
  return canonicalImplementationDir;
}

async function implementationWorkdirFor(input: {
  workspaceDir: string;
  workdir: string;
  mustExist?: boolean;
}): Promise<string> {
  const workspaceDir = await realpath(resolve(input.workspaceDir));
  const implementationDir = resolve(workspaceDir, input.workdir);
  assertPathInside(workspaceDir, implementationDir, "implementation workdir");
  const canonicalImplementationDir = input.mustExist === false
    ? implementationDir
    : await realpath(implementationDir);
  assertPathInside(workspaceDir, canonicalImplementationDir, "implementation workdir");
  return canonicalImplementationDir;
}

async function pushImplementationBranch(workdir: string, branchName: string): Promise<void> {
  await execGit(["-C", workdir, "push", "--set-upstream", "origin", branchName]);
}

async function gitRemoteBranchExists(workdir: string, branchName: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["-C", workdir, "ls-remote", "--heads", "origin", branchName], {
    windowsHide: true
  });
  return stdout.trim().length > 0;
}

async function currentGitCommit(workdir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workdir, "rev-parse", "HEAD"], { windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function execGit(args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { windowsHide: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0]} failed while preparing implementation PR workspace: ${message}`);
  }
}

function assertPathInside(rootDir: string, candidatePath: string, label: string): void {
  const normalizedRoot = withTrailingSeparator(resolve(rootDir));
  const normalizedCandidate = resolve(candidatePath);

  if (normalizedCandidate !== resolve(rootDir) && !normalizedCandidate.startsWith(normalizedRoot)) {
    throw new Error(`${label} must stay inside runner workspace`);
  }
}

function withTrailingSeparator(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function branchNameForJob(job: WorkflowJob): string | undefined {
  return optionalString(job.input.branchName) ?? optionalString(job.input.pullRequestBranch) ?? optionalString(job.input.headBranch);
}
