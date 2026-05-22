import type { ArtifactLocation, ArtifactType } from "../document-core/domain";
import type {
  ClaimJobResult,
  Runner,
  RunnerClaimDiagnostics,
  WorkflowEvent,
  WorkflowJob,
  WorkflowJobResult
} from "../workflow-core/domain";
import type { RegisterRunnerInput } from "../workflow-core/scheduler";

export interface RunnerArtifactUpload {
  documentId?: string;
  documentVersionId?: string;
  type: ArtifactType;
  location: ArtifactLocation;
  uri: string;
  externalId?: string;
  externalVersion?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
}

export interface RunnerApiClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface RunnerClaimResponse {
  claim: ClaimJobResult | null;
  diagnostics?: RunnerClaimDiagnostics;
}

export class WorkflowApiRunnerClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RunnerApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async registerRunner(input: Omit<RegisterRunnerInput, "now"> & { now?: Date }): Promise<Runner> {
    const response = await this.postJson<{ runner: Runner }>("/runners/register", {
      ...input,
      now: input.now?.toISOString()
    });

    return response.runner;
  }

  async heartbeat(runnerId: string, now?: Date): Promise<Runner> {
    const response = await this.postJson<{ runner: Runner }>(`/runners/${encodeURIComponent(runnerId)}/heartbeat`, {
      now: now?.toISOString()
    });

    return response.runner;
  }

  async claim(runnerId: string, now?: Date): Promise<ClaimJobResult | undefined> {
    const response = await this.claimWithDiagnostics(runnerId, now);

    return response.claim ?? undefined;
  }

  async claimWithDiagnostics(runnerId: string, now?: Date): Promise<RunnerClaimResponse> {
    return this.postJson<RunnerClaimResponse>(
      `/runners/${encodeURIComponent(runnerId)}/claim`,
      {
        now: now?.toISOString()
      }
    );
  }

  async startJob(jobId: string, runnerId: string, now?: Date): Promise<void> {
    await this.postJson(`/runner-jobs/${encodeURIComponent(jobId)}/start`, {
      runnerId,
      now: now?.toISOString()
    });
  }

  async getJob(jobId: string): Promise<WorkflowJob> {
    const response = await this.getJson<{ job: WorkflowJob }>(`/runner-jobs/${encodeURIComponent(jobId)}`);
    return response.job;
  }

  async completeJob(input: {
    jobId: string;
    runnerId: string;
    output: Record<string, unknown>;
    now?: Date;
  }): Promise<WorkflowJobResult> {
    const response = await this.postJson<{ result: WorkflowJobResult }>(
      `/runner-jobs/${encodeURIComponent(input.jobId)}/results`,
      {
        runnerId: input.runnerId,
        output: input.output,
        now: input.now?.toISOString()
      }
    );

    return response.result;
  }

  async failJob(input: {
    jobId: string;
    runnerId: string;
    output?: Record<string, unknown>;
    errorCode: string;
    errorMessage: string;
    retryable?: boolean;
    now?: Date;
  }): Promise<WorkflowJobResult> {
    const response = await this.postJson<{ result: WorkflowJobResult }>(
      `/runner-jobs/${encodeURIComponent(input.jobId)}/fail`,
      {
        runnerId: input.runnerId,
        output: input.output ?? {},
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        retryable: input.retryable,
        now: input.now?.toISOString()
      }
    );

    return response.result;
  }

  async acknowledgeCancellation(input: {
    jobId: string;
    runnerId: string;
    output?: Record<string, unknown>;
    now?: Date;
  }): Promise<WorkflowJobResult> {
    const response = await this.postJson<{ result: WorkflowJobResult }>(
      `/runner-jobs/${encodeURIComponent(input.jobId)}/canceled`,
      {
        runnerId: input.runnerId,
        output: input.output ?? {
          status: "canceled"
        },
        now: input.now?.toISOString()
      }
    );

    return response.result;
  }

  async requestCancellation(input: {
    jobId: string;
    requestedBy?: string;
    reason?: string;
    now?: Date;
  }): Promise<WorkflowJob> {
    const response = await this.postJson<{ job: WorkflowJob }>(
      `/runner-jobs/${encodeURIComponent(input.jobId)}/cancel`,
      {
        requestedBy: input.requestedBy,
        reason: input.reason,
        now: input.now?.toISOString()
      }
    );

    return response.job;
  }

  async recordLog(input: {
    jobId: string;
    runnerId: string;
    level?: string;
    message: string;
    metadata?: Record<string, unknown>;
    now?: Date;
  }): Promise<WorkflowEvent> {
    const response = await this.postJson<{ event: WorkflowEvent }>(
      `/runner-jobs/${encodeURIComponent(input.jobId)}/logs`,
      {
        runnerId: input.runnerId,
        level: input.level,
        message: input.message,
        metadata: input.metadata,
        now: input.now?.toISOString()
      }
    );

    return response.event;
  }

  async uploadArtifact(input: {
    jobId: string;
    runnerId: string;
    artifact: RunnerArtifactUpload;
    now?: Date;
  }): Promise<void> {
    await this.postJson(`/runner-jobs/${encodeURIComponent(input.jobId)}/artifacts`, {
      runnerId: input.runnerId,
      ...input.artifact,
      now: input.now?.toISOString()
    });
  }

  private async postJson<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Runner API ${path} failed with ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  private async getJson<T = Record<string, unknown>>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.headers()
    });

    if (!response.ok) {
      throw new Error(`Runner API ${path} failed with ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  private headers(headers: Record<string, string> = {}): Record<string, string> {
    return this.token
      ? {
          ...headers,
          authorization: `Bearer ${this.token}`
        }
      : headers;
  }
}
