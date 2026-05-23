import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { constants } from "node:fs";
import {
  createFileSystemRunnerPackageResolver,
  defaultRunnerPackageRequirementsForCapabilities
} from "./package-resolver";

export type LocalRunnerPreflightStatus = "passed" | "warning" | "failed";

export interface LocalRunnerPreflightCheck {
  id: string;
  status: LocalRunnerPreflightStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface LocalRunnerPreflightReport {
  status: LocalRunnerPreflightStatus;
  runnerId?: string;
  ownerEmail?: string;
  mode: string;
  capabilities: string[];
  checks: LocalRunnerPreflightCheck[];
}

export interface RunLocalRunnerPreflightOptions {
  checkWorkspace?: boolean;
}

export async function runLocalRunnerPreflight(
  env: NodeJS.ProcessEnv,
  options: RunLocalRunnerPreflightOptions = {}
): Promise<LocalRunnerPreflightReport> {
  const mode = env.LOCAL_RUNNER_MODE?.trim() || "local";
  const runnerId = trimmed(env.LOCAL_RUNNER_ID);
  const ownerEmail = firstTrimmed(env.LOCAL_RUNNER_OWNER_EMAIL, env.LOCAL_RUNNER_OWNER_USER_ID);
  const capabilities = parseList(env.LOCAL_RUNNER_CAPABILITIES);
  const runnerEngines = parseList(env.LOCAL_RUNNER_ENGINES, [trimmed(env.RUNNER_ENGINE) ?? "claude"]);
  const selectedEngine = trimmed(env.RUNNER_ENGINE) ?? "claude";
  const checks: LocalRunnerPreflightCheck[] = [];

  checks.push(checkApiBaseUrl(env.WORKFLOW_API_BASE_URL));
  checks.push(checkRunnerIdentity({ runnerId, mode, ownerEmail }));
  checks.push(checkRunnerScope({ capabilities, runnerEngines, selectedEngine }));
  checks.push(await checkCliEngine(env, { capabilities, selectedEngine }));
  checks.push(checkGitHubIntegration(env, capabilities));
  const packageRequirements = defaultRunnerPackageRequirementsForCapabilities(capabilities);
  if (packageRequirements.length > 0) {
    checks.push(await checkRunnerPackages(env, packageRequirements));
  }
  if (requiresGitWorkspace(capabilities)) {
    checks.push(await checkGitCli(env));
  }

  if (options.checkWorkspace !== false) {
    checks.push(await checkWorkspaceRoot(env.LOCAL_RUNNER_WORKSPACE_ROOT));
  }

  return {
    status: summarizeStatus(checks),
    runnerId,
    ownerEmail,
    mode,
    capabilities,
    checks
  };
}

function checkApiBaseUrl(value: string | undefined): LocalRunnerPreflightCheck {
  const baseUrl = trimmed(value);

  if (!baseUrl) {
    return failed("api_base_url", "WORKFLOW_API_BASE_URL is required.");
  }

  try {
    const url = new URL(baseUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return failed("api_base_url", "WORKFLOW_API_BASE_URL must use http or https.", { baseUrl });
    }

    return passed("api_base_url", "Workflow API URL is configured.", { baseUrl });
  } catch {
    return failed("api_base_url", "WORKFLOW_API_BASE_URL must be a valid URL.", { baseUrl });
  }
}

function checkRunnerIdentity(input: {
  runnerId?: string;
  mode: string;
  ownerEmail?: string;
}): LocalRunnerPreflightCheck {
  if (!input.runnerId) {
    return failed("runner_identity", "LOCAL_RUNNER_ID is required.");
  }

  if (input.mode !== "local" && input.mode !== "managed") {
    return failed("runner_identity", 'LOCAL_RUNNER_MODE must be "local" or "managed".', { mode: input.mode });
  }

  if (input.mode === "local" && !input.ownerEmail) {
    return failed("runner_identity", "LOCAL_RUNNER_OWNER_EMAIL is required for local runner mode.", {
      runnerId: input.runnerId
    });
  }

  return passed("runner_identity", "Runner identity is configured.", {
    runnerId: input.runnerId,
    mode: input.mode,
    ownerEmail: input.ownerEmail
  });
}

function checkRunnerScope(input: {
  capabilities: string[];
  runnerEngines: string[];
  selectedEngine: string;
}): LocalRunnerPreflightCheck {
  if (!input.capabilities.length) {
    return failed("runner_scope", "LOCAL_RUNNER_CAPABILITIES must include at least one capability.");
  }

  if (input.selectedEngine !== "claude" && input.selectedEngine !== "codex") {
    return failed("runner_scope", 'RUNNER_ENGINE must be "claude" or "codex".', {
      selectedEngine: input.selectedEngine
    });
  }

  if (input.runnerEngines.length > 0 && !input.runnerEngines.includes(input.selectedEngine)) {
    return failed("runner_scope", "RUNNER_ENGINE must be included in LOCAL_RUNNER_ENGINES.", {
      selectedEngine: input.selectedEngine,
      runnerEngines: input.runnerEngines
    });
  }

  return passed("runner_scope", "Runner capability and engine scope are configured.", {
    capabilities: input.capabilities,
    runnerEngines: input.runnerEngines,
    selectedEngine: input.selectedEngine
  });
}

async function checkCliEngine(
  env: NodeJS.ProcessEnv,
  input: { capabilities: string[]; selectedEngine: string }
): Promise<LocalRunnerPreflightCheck> {
  if (!requiresCliEngine(input.capabilities)) {
    return passed("cli_engine", "CLI engine is not required for the configured capabilities.", {
      capabilities: input.capabilities
    });
  }

  const commandKey = input.selectedEngine === "codex" ? "CODEX_CLI_PATH" : "CLAUDE_CLI_PATH";
  const command = trimmed(env[commandKey]);

  if (!command) {
    return failed("cli_engine", `${commandKey} is required for CLI-backed capabilities.`, {
      selectedEngine: input.selectedEngine
    });
  }

  const resolved = await resolveCommand(command, env);

  if (!resolved) {
    return failed("cli_engine", `${commandKey} does not resolve to an executable command.`, {
      command,
      selectedEngine: input.selectedEngine
    });
  }

  return passed("cli_engine", "Selected CLI engine command is available.", {
    selectedEngine: input.selectedEngine,
    command,
    resolved
  });
}

async function checkGitCli(env: NodeJS.ProcessEnv): Promise<LocalRunnerPreflightCheck> {
  const resolved = await resolveCommand("git", env);

  if (!resolved) {
    return failed("git_cli", "implementation.update_pr requires git to prepare the PR branch workspace.");
  }

  return passed("git_cli", "Git command is available for implementation workspaces.", { command: "git", resolved });
}

function checkGitHubIntegration(env: NodeJS.ProcessEnv, capabilities: string[]): LocalRunnerPreflightCheck {
  const needsGitHub = capabilities.some((capability) => capability.startsWith("implementation."));

  if (!needsGitHub) {
    return passed("github_integration", "GitHub integration is not required for the configured capabilities.");
  }

  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((key) => !trimmed(env[key]));

  if (missing.length > 0) {
    return failed("github_integration", "Implementation capabilities require GitHub token, owner, and repo.", {
      missing
    });
  }

  return passed("github_integration", "GitHub implementation settings are configured.", {
    owner: trimmed(env.GITHUB_OWNER),
    repo: trimmed(env.GITHUB_REPO),
    baseUrl: trimmed(env.GITHUB_BASE_URL) ?? "https://api.github.com"
  });
}

async function checkRunnerPackages(
  env: NodeJS.ProcessEnv,
  requirements: ReturnType<typeof defaultRunnerPackageRequirementsForCapabilities>
): Promise<LocalRunnerPreflightCheck> {
  const resolver = createFileSystemRunnerPackageResolver(env);
  const resolution = await resolver.resolveRequirements(requirements);

  if (resolution.missing.length > 0) {
    return failed("runner_packages", "Required runner skill/plugin packages are not installed.", {
      missing: resolution.missing.map((requirement) => ({
        type: requirement.type,
        id: requirement.id,
        version: requirement.version,
        reason: requirement.reason
      }))
    });
  }

  return passed("runner_packages", "Required runner skill/plugin packages are installed.", {
    installed: resolution.installed.map((requirement) => ({
      type: requirement.type,
      id: requirement.id,
      version: requirement.installedVersion,
      path: requirement.path
    }))
  });
}

async function checkWorkspaceRoot(value: string | undefined): Promise<LocalRunnerPreflightCheck> {
  const root = trimmed(value);

  if (!root) {
    return warning("workspace", "LOCAL_RUNNER_WORKSPACE_ROOT is not configured; jobs will run without isolated workspaces.");
  }

  const rootDir = resolve(root);
  const probe = join(rootDir, `.preflight-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(probe, "ok");
    await rm(probe, { force: true });

    return passed("workspace", "Runner workspace root is writable.", { rootDir });
  } catch (error) {
    return failed("workspace", "LOCAL_RUNNER_WORKSPACE_ROOT must be writable.", {
      rootDir,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function requiresCliEngine(capabilities: string[]): boolean {
  return capabilities.some(
    (capability) =>
      capability.startsWith("document.") ||
      capability.startsWith("prd.") ||
      capability === "implementation.update_pr"
  );
}

function requiresGitWorkspace(capabilities: string[]): boolean {
  return capabilities.includes("implementation.update_pr");
}

export async function resolveCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return (await canExecute(command)) ? command : undefined;
  }

  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = process.platform === "win32" ? parseWindowsPathExtensions(env.PATHEXT) : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${extension}`);

      if (await canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseWindowsPathExtensions(value: string | undefined): string[] {
  const extensions = (value || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);

  return ["", ...extensions];
}

function summarizeStatus(checks: LocalRunnerPreflightCheck[]): LocalRunnerPreflightStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }

  return "passed";
}

function parseList(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstTrimmed(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const result = trimmed(value);

    if (result) {
      return result;
    }
  }

  return undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function passed(
  id: string,
  message: string,
  details?: Record<string, unknown>
): LocalRunnerPreflightCheck {
  return { id, status: "passed", message, details };
}

function warning(
  id: string,
  message: string,
  details?: Record<string, unknown>
): LocalRunnerPreflightCheck {
  return { id, status: "warning", message, details };
}

function failed(
  id: string,
  message: string,
  details?: Record<string, unknown>
): LocalRunnerPreflightCheck {
  return { id, status: "failed", message, details };
}
