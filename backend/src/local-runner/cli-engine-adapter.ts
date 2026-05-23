import { CliEngine } from "../runner-engines/cli-engine";
import { createCliEngineConfig } from "../runner-engines/engine-config";
import { createJobPromptContractPayload } from "../document-core/prompt-contracts";
import { redactSecrets } from "../runtime/secrets";
import type { LocalRunnerEngine, LocalRunnerEngineInput, LocalRunnerEngineResult } from "./local-runner";
import { normalizeCliRunnerResult } from "./result-schema";

export interface CliLocalRunnerEngineOptions {
  outputLanguage?: string;
  secretEnv?: NodeJS.ProcessEnv;
}

export interface JobTemplateCliLocalRunnerEngineOptions extends CliLocalRunnerEngineOptions {
  env: NodeJS.ProcessEnv;
}

export class CliLocalRunnerEngine implements LocalRunnerEngine {
  constructor(
    private readonly engine: CliEngine,
    private readonly options: CliLocalRunnerEngineOptions = {}
  ) {}

  async run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const documentType =
      typeof input.job.input.documentType === "string" ? input.job.input.documentType : undefined;
    const result = await this.runEngineWithRedactedErrors(input, documentType);
    const normalized = normalizeLocalRunnerCliResult(result.output);
    const logs = [...(normalized.logs ?? [])];
    const stderr = result.stderr.trim();

    if (stderr.length > 0) {
      logs.push({
        level: "debug",
        message: "CLI stderr",
        metadata: {
          stderr: truncate(redactSecrets(stderr, { env: this.options.secretEnv })),
          stderrBytes: result.stderr.length
        }
      });
    }

    logs.push({
      level: "debug",
      message: "CLI stdout parsed",
      metadata: {
        stdoutBytes: result.stdout.length
      }
    });

    return {
      ...normalized,
      logs
    };
  }

  private async runEngineWithRedactedErrors(
    input: LocalRunnerEngineInput,
    documentType: string | undefined
  ): Promise<Awaited<ReturnType<CliEngine["runJsonWithProcessOutput"]>>> {
    try {
      return await this.engine.runJsonWithProcessOutput(
        {
          ...input.job.input,
          jobId: input.job.id,
          jobType: input.job.jobType,
          runnerId: input.runner.id,
          requiredCapabilities: input.job.requiredCapabilities,
          preferredEngine: input.job.preferredEngine,
          requiredEngine: input.job.requiredEngine,
          workspaceDir: input.workspaceDir,
          outputLanguage: this.options.outputLanguage,
          promptContract: createJobPromptContractPayload({
            jobType: input.job.jobType,
            documentType
          })
        },
        {
          signal: input.signal
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactSecrets(message, { env: this.options.secretEnv }));
    }
  }
}

export class JobTemplateCliLocalRunnerEngine implements LocalRunnerEngine {
  constructor(private readonly options: JobTemplateCliLocalRunnerEngineOptions) {}

  async run(input: LocalRunnerEngineInput): Promise<LocalRunnerEngineResult> {
    const config = createCliEngineConfig(this.options.env, {
      job: input.job,
      runner: input.runner,
      workspaceDir: input.workspaceDir
    });
    const engine = new CliLocalRunnerEngine(
      new CliEngine({
        command: config.command,
        args: config.args,
        timeoutMs: config.timeoutMs,
        cwd: config.cwd
      }),
      {
        outputLanguage: this.options.outputLanguage,
        secretEnv: this.options.env
      }
    );

    return engine.run(input);
  }
}

export function normalizeLocalRunnerCliResult(result: Record<string, unknown>): LocalRunnerEngineResult {
  return normalizeCliRunnerResult(result);
}

function truncate(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
}
