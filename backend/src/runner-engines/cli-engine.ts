import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export interface CliEngineOptions {
  command: string;
  args?: string[];
  timeoutMs: number;
  cwd?: string;
}

export interface CliEngineJsonResult {
  output: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

export interface CliEngineRunOptions {
  signal?: AbortSignal;
}

export class CliEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliEngineError";
  }
}

export class CliEngine {
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly cwd?: string;

  constructor(options: CliEngineOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs;
    this.cwd = options.cwd;
  }

  async runJson(input: Record<string, unknown>, options: CliEngineRunOptions = {}): Promise<Record<string, unknown>> {
    return (await this.runJsonWithProcessOutput(input, options)).output;
  }

  async runJsonWithProcessOutput(
    input: Record<string, unknown>,
    options: CliEngineRunOptions = {}
  ): Promise<CliEngineJsonResult> {
    const processOutput = await this.runProcess(input, options);
    const { stdout } = processOutput;

    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (!isRecord(parsed)) {
        throw new CliEngineError(`${this.commandName()} did not return a JSON object`);
      }

      return {
        output: parsed,
        stdout: processOutput.stdout,
        stderr: processOutput.stderr
      };
    } catch (error) {
      if (error instanceof CliEngineError) {
        throw error;
      }

      throw new CliEngineError(
        `${this.commandName()} did not return valid JSON on stdout. stdout: ${formatOutput(stdout)}`
      );
    }
  }

  private async runProcess(input: Record<string, unknown>, options: CliEngineRunOptions): Promise<{
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CliEngineError(`${this.commandName()} canceled: ${abortSignalReason(options.signal)}`));
        return;
      }

      const spawnCommand = resolveSpawnCommand(this.command, this.args);
      const child = spawn(spawnCommand.command, spawnCommand.args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => {
        settle(() => {
          child.kill("SIGTERM");
          reject(new CliEngineError(`${this.commandName()} canceled: ${abortSignalReason(options.signal)}`));
        });
      };
      const timeout = setTimeout(() => {
        settle(() => {
          child.kill("SIGTERM");
          reject(new CliEngineError(`${this.commandName()} timed out after ${this.timeoutMs}ms`));
        });
      }, this.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        settle(() => {
          reject(new CliEngineError(`${this.commandName()} failed to start: ${error.message}`));
        });
      });
      child.on("close", (code, signal) => {
        settle(() => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }

          const reason = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
          reject(
            new CliEngineError(
              `${this.commandName()} exited with ${reason}. stderr: ${formatOutput(
                stderr
              )} stdout: ${formatOutput(stdout)}`
            )
          );
        });
      });

      child.stdin.end(JSON.stringify(input));
    });
  }

  private commandName(): string {
    return basename(this.command);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "<empty>";
}

function abortSignalReason(signal: AbortSignal | undefined): string {
  if (!signal) {
    return "canceled";
  }

  const reason = signal.reason;

  if (reason instanceof Error) {
    return reason.message;
  }

  return typeof reason === "string" && reason.length > 0 ? reason : "canceled";
}

function resolveSpawnCommand(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !existsSync(command)) {
    return { command, args };
  }

  const firstLine = readFileSync(command, "utf8").split(/\r?\n/, 1)[0] ?? "";

  if (!firstLine.startsWith("#!") || !firstLine.includes("node")) {
    return { command, args };
  }

  return {
    command: process.execPath,
    args: [command, ...args]
  };
}
