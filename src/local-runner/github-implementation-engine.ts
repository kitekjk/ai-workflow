import type { GitHubRestClient } from "../integrations/github-client";
import type { LocalRunnerEngine, LocalRunnerEngineInput, LocalRunnerEngineResult } from "./local-runner";

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
        latestCommitSha: status.latestCommitSha,
        reviewStatus: status.reviewStatus,
        ciStatus: status.ciStatus,
        checkRuns: status.checkRuns
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
