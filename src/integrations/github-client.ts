export interface GitHubRestClientOptions {
  baseUrl?: string;
  token: string;
  owner: string;
  repo: string;
  apiVersion?: string;
}

export interface GitHubCreateBranchInput {
  branchName: string;
  fromBranch: string;
}

export interface GitHubBranchResult {
  ref: string;
  sha: string;
}

export interface GitHubCreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
}

export interface GitHubPullRequestResult {
  number: number;
  url: string;
  state: string;
  draft: boolean;
}

export type GitHubReviewStatus = "pending" | "approved" | "changes_requested" | "commented";
export type GitHubCiStatus = "pending" | "success" | "failure";

export interface GitHubCheckRunStatus {
  name: string;
  status: string;
  conclusion?: string | null;
  url?: string;
}

export interface GitHubPullRequestStatus {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  branchName?: string;
  baseBranch?: string;
  repositoryCloneUrl?: string;
  latestCommitSha: string;
  reviewStatus: GitHubReviewStatus;
  ciStatus: GitHubCiStatus;
  checkRuns: GitHubCheckRunStatus[];
}

interface GitHubRefResponse {
  ref: string;
  object: {
    sha: string;
  };
}

interface GitHubPullResponse {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  head: {
    sha: string;
    ref?: string;
    repo?: {
      clone_url?: string;
      full_name?: string;
    } | null;
  };
  base?: {
    ref?: string;
  };
}

interface GitHubReviewResponse {
  state: string;
  submitted_at?: string;
  user?: {
    login?: string;
  };
}

interface GitHubCheckRunsResponse {
  check_runs?: Array<{
    name: string;
    status: string;
    conclusion?: string | null;
    html_url?: string;
  }>;
}

export class GitHubRestClient {
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(private readonly options: GitHubRestClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? "2022-11-28";
  }

  async createBranch(input: GitHubCreateBranchInput): Promise<GitHubBranchResult> {
    const sourceRef = await this.getRef(`heads/${input.fromBranch}`);
    const response = await fetch(`${this.repoUrl()}/git/refs`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        ref: `refs/heads/${input.branchName}`,
        sha: sourceRef.object.sha
      })
    });

    const body = await requireJson<GitHubRefResponse>(response, `GitHub branch create failed for ${input.branchName}`);
    return {
      ref: body.ref,
      sha: body.object.sha
    };
  }

  async createPullRequest(input: GitHubCreatePullRequestInput): Promise<GitHubPullRequestResult> {
    const response = await fetch(`${this.repoUrl()}/pulls`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft ?? false,
        maintainer_can_modify: input.maintainerCanModify ?? true
      })
    });

    const body = await requireJson<GitHubPullResponse>(response, `GitHub pull request create failed for ${input.head}`);
    return {
      number: body.number,
      url: body.html_url,
      state: body.state,
      draft: body.draft ?? false
    };
  }

  async readPullRequestStatus(pullNumber: number): Promise<GitHubPullRequestStatus> {
    const pull = await this.getPullRequest(pullNumber);
    const [reviews, checks] = await Promise.all([
      this.listPullRequestReviews(pullNumber),
      this.listCheckRuns(pull.head.sha)
    ]);

    return {
      number: pull.number,
      url: pull.html_url,
      state: pull.state,
      draft: pull.draft ?? false,
      merged: pull.merged ?? false,
      ...(pull.head.ref ? { branchName: pull.head.ref } : {}),
      ...(pull.base?.ref ? { baseBranch: pull.base.ref } : {}),
      ...(pull.head.repo?.clone_url ? { repositoryCloneUrl: pull.head.repo.clone_url } : {}),
      latestCommitSha: pull.head.sha,
      reviewStatus: reviewStatusFor(reviews),
      ciStatus: ciStatusFor(checks),
      checkRuns: checks.map((checkRun) => ({
        name: checkRun.name,
        status: checkRun.status,
        conclusion: checkRun.conclusion,
        url: checkRun.html_url
      }))
    };
  }

  private async getRef(ref: string): Promise<GitHubRefResponse> {
    const response = await fetch(`${this.repoUrl()}/git/ref/${encodePath(ref)}`, {
      headers: this.getHeaders()
    });

    return requireJson<GitHubRefResponse>(response, `GitHub ref read failed for ${ref}`);
  }

  private async getPullRequest(pullNumber: number): Promise<GitHubPullResponse> {
    const response = await fetch(`${this.repoUrl()}/pulls/${pullNumber}`, {
      headers: this.getHeaders()
    });

    return requireJson<GitHubPullResponse>(response, `GitHub pull request read failed for ${pullNumber}`);
  }

  private async listPullRequestReviews(pullNumber: number): Promise<GitHubReviewResponse[]> {
    const response = await fetch(`${this.repoUrl()}/pulls/${pullNumber}/reviews`, {
      headers: this.getHeaders()
    });

    return requireJson<GitHubReviewResponse[]>(response, `GitHub pull request reviews read failed for ${pullNumber}`);
  }

  private async listCheckRuns(commitSha: string): Promise<NonNullable<GitHubCheckRunsResponse["check_runs"]>> {
    const response = await fetch(`${this.repoUrl()}/commits/${encodeURIComponent(commitSha)}/check-runs`, {
      headers: this.getHeaders()
    });

    const body = await requireJson<GitHubCheckRunsResponse>(
      response,
      `GitHub check runs read failed for ${commitSha}`
    );
    return body.check_runs ?? [];
  }

  private repoUrl(): string {
    return `${this.baseUrl}/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.options.token}`,
      "x-github-api-version": this.apiVersion
    };
  }

  private jsonHeaders(): Record<string, string> {
    return {
      ...this.getHeaders(),
      "content-type": "application/json"
    };
  }
}

async function requireJson<T>(response: Response, message: string): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>;
  }

  const body = await response.text();
  throw new Error(`${message}: HTTP ${response.status} ${body}`);
}

function reviewStatusFor(reviews: GitHubReviewResponse[]): GitHubReviewStatus {
  const latestByUser = new Map<string, GitHubReviewResponse>();

  for (const review of reviews) {
    const user = review.user?.login ?? "unknown";
    const current = latestByUser.get(user);
    if (!current || submittedAt(review) >= submittedAt(current)) {
      latestByUser.set(user, review);
    }
  }

  const latestStates = [...latestByUser.values()].map((review) => review.state.toUpperCase());

  if (latestStates.includes("CHANGES_REQUESTED")) {
    return "changes_requested";
  }

  if (latestStates.includes("APPROVED")) {
    return "approved";
  }

  if (latestStates.some((state) => state === "COMMENTED" || state === "COMMENT")) {
    return "commented";
  }

  return "pending";
}

function ciStatusFor(checkRuns: NonNullable<GitHubCheckRunsResponse["check_runs"]>): GitHubCiStatus {
  if (checkRuns.length === 0 || checkRuns.some((checkRun) => checkRun.status !== "completed")) {
    return "pending";
  }

  return checkRuns.every((checkRun) => ["success", "neutral", "skipped"].includes(checkRun.conclusion ?? ""))
    ? "success"
    : "failure";
}

function submittedAt(review: GitHubReviewResponse): number {
  return review.submitted_at ? Date.parse(review.submitted_at) : 0;
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
