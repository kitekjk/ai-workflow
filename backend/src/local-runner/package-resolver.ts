import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Runner, WorkflowJob } from "../workflow-core/domain";

export type RunnerPackageType = "skill" | "plugin";

const execFileAsync = promisify(execFile);

export interface RunnerPackageRequirement {
  type: RunnerPackageType;
  id: string;
  version?: string;
  installSource?: string;
  sourceSubdir?: string;
  source?: string;
}

export interface RunnerPackageResolutionEntry extends RunnerPackageRequirement {
  installedVersion?: string;
  path?: string;
  reason?: string;
}

export interface RunnerPackageResolution {
  requirements: RunnerPackageRequirement[];
  installed: RunnerPackageResolutionEntry[];
  missing: RunnerPackageResolutionEntry[];
}

export interface LocalRunnerPackageResolver {
  resolve(input: { job: WorkflowJob; runner: Runner }): Promise<RunnerPackageResolution>;
  resolveRequirements(requirements: RunnerPackageRequirement[]): Promise<RunnerPackageResolution>;
  prepare(input: { job: WorkflowJob; runner: Runner }): Promise<RunnerPackageResolution>;
  prepareRequirements(requirements: RunnerPackageRequirement[]): Promise<RunnerPackageResolution>;
}

export interface CreateFileSystemRunnerPackageResolverOptions {
  allowInstall?: boolean;
}

export class MissingRunnerPackagesError extends Error {
  readonly errorCode = "runner_package_missing";
  readonly retryable = false;

  constructor(readonly resolution: RunnerPackageResolution) {
    super(`Runner package requirements are not installed: ${formatRunnerPackageList(resolution.missing)}`);
  }
}

export function createFileSystemRunnerPackageResolver(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateFileSystemRunnerPackageResolverOptions = {}
): LocalRunnerPackageResolver {
  const installedSkills = parseInstalledPackageList(env.LOCAL_RUNNER_INSTALLED_SKILLS, "skill");
  const installedPlugins = parseInstalledPackageList(env.LOCAL_RUNNER_INSTALLED_PLUGINS, "plugin");
  const skillRoots = packageRoots(env.LOCAL_RUNNER_SKILL_ROOTS, [
    resolve("skills"),
    env.CODEX_HOME ? join(env.CODEX_HOME, "skills") : undefined,
    join(homedir(), ".codex", "skills")
  ]);
  const pluginRoots = packageRoots(env.LOCAL_RUNNER_PLUGIN_ROOTS, [
    resolve("plugins"),
    env.CODEX_HOME ? join(env.CODEX_HOME, "plugins") : undefined,
    env.CODEX_HOME ? join(env.CODEX_HOME, "plugins", "cache") : undefined,
    join(homedir(), ".codex", "plugins")
  ]);
  const skillRegistryRoots = packageRoots(env.LOCAL_RUNNER_SKILL_REGISTRY_ROOTS, [resolve("skills")]);
  const pluginRegistryRoots = packageRoots(env.LOCAL_RUNNER_PLUGIN_REGISTRY_ROOTS, [
    resolve("plugins"),
    env.CODEX_HOME ? join(env.CODEX_HOME, "plugins") : undefined,
    env.CODEX_HOME ? join(env.CODEX_HOME, "plugins", "cache") : undefined,
    join(homedir(), ".codex", "plugins")
  ]);
  const skillInstallRoot = resolve(env.LOCAL_RUNNER_SKILL_INSTALL_ROOT ?? skillRoots[0] ?? join(homedir(), ".codex", "skills"));
  const pluginInstallRoot = resolve(
    env.LOCAL_RUNNER_PLUGIN_INSTALL_ROOT ?? pluginRoots[0] ?? join(homedir(), ".codex", "plugins")
  );
  const allowInstall = options.allowInstall ?? env.LOCAL_RUNNER_PACKAGE_AUTO_INSTALL === "true";
  const context = {
    installedSkills,
    installedPlugins,
    skillRoots,
    pluginRoots,
    skillRegistryRoots,
    pluginRegistryRoots,
    skillInstallRoot,
    pluginInstallRoot,
    allowInstall
  };

  return {
    async resolve(input: { job: WorkflowJob; runner: Runner }): Promise<RunnerPackageResolution> {
      return this.resolveRequirements(runnerPackageRequirementsForJob(input.job));
    },

    async resolveRequirements(requirements: RunnerPackageRequirement[]): Promise<RunnerPackageResolution> {
      const uniqueRequirements = dedupeRequirements(requirements);
      const entries = await Promise.all(
        uniqueRequirements.map((requirement) =>
          resolveRequirement(requirement, {
            installedSkills,
            installedPlugins,
            skillRoots,
            pluginRoots
          })
        )
      );
      const missing = entries.filter((entry) => entry.reason);

      return {
        requirements: uniqueRequirements,
        installed: entries.filter((entry) => !entry.reason),
        missing
      };
    },

    async prepare(input: { job: WorkflowJob; runner: Runner }): Promise<RunnerPackageResolution> {
      return this.prepareRequirements(runnerPackageRequirementsForJob(input.job));
    },

    async prepareRequirements(requirements: RunnerPackageRequirement[]): Promise<RunnerPackageResolution> {
      const initial = await this.resolveRequirements(requirements);

      if (initial.missing.length === 0 || !allowInstall) {
        return initial;
      }

      await installMissingRequirements(initial.missing, context);
      return this.resolveRequirements(requirements);
    }
  };
}

export function runnerPackageRequirementsForJob(job: WorkflowJob): RunnerPackageRequirement[] {
  const input = job.input ?? {};
  const requirements: RunnerPackageRequirement[] = [];

  collectPackageRequirement(requirements, "skill", input.runnerSkill, "runnerSkill");
  collectPackageRequirements(requirements, "skill", input.runnerSkills, "runnerSkills");
  collectPackageRequirements(requirements, "skill", input.requiredSkills, "requiredSkills");
  collectPackageRequirement(requirements, "plugin", input.runnerPlugin, "runnerPlugin");
  collectPackageRequirements(requirements, "plugin", input.runnerPlugins, "runnerPlugins");
  collectPackageRequirements(requirements, "plugin", input.requiredPlugins, "requiredPlugins");

  const runnerRequirements = recordOrUndefined(input.runnerRequirements);
  if (runnerRequirements) {
    collectPackageRequirements(requirements, "skill", runnerRequirements.skills, "runnerRequirements.skills");
    collectPackageRequirements(requirements, "plugin", runnerRequirements.plugins, "runnerRequirements.plugins");
  }

  collectTypedPackageRequirements(requirements, input.runnerPackages, "runnerPackages");
  collectTypedPackageRequirements(requirements, input.requiredRunnerPackages, "requiredRunnerPackages");

  return dedupeRequirements(requirements);
}

export function defaultRunnerPackageRequirementsForCapabilities(capabilities: string[]): RunnerPackageRequirement[] {
  const requirements: RunnerPackageRequirement[] = [];

  if (capabilities.includes("implementation.open_pr")) {
    requirements.push({
      type: "skill",
      id: "implementation.pr-author",
      version: "0.1.0",
      source: "capability:implementation.open_pr"
    });
  }

  if (capabilities.includes("implementation.update_pr")) {
    requirements.push({
      type: "skill",
      id: "implementation.pr-updater",
      version: "0.1.0",
      source: "capability:implementation.update_pr"
    });
  }

  return requirements;
}

export function assertRunnerPackagesInstalled(resolution: RunnerPackageResolution): void {
  if (resolution.missing.length > 0) {
    throw new MissingRunnerPackagesError(resolution);
  }
}

function collectPackageRequirement(
  requirements: RunnerPackageRequirement[],
  type: RunnerPackageType,
  value: unknown,
  source: string
): void {
  const requirement = parsePackageRequirement(type, value, source);

  if (requirement) {
    requirements.push(requirement);
  }
}

function collectPackageRequirements(
  requirements: RunnerPackageRequirement[],
  type: RunnerPackageType,
  value: unknown,
  source: string
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    collectPackageRequirement(requirements, type, item, source);
  }
}

function collectTypedPackageRequirements(
  requirements: RunnerPackageRequirement[],
  value: unknown,
  source: string
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    const typed = parseTypedPackageRequirement(item, source);

    if (typed) {
      requirements.push(typed);
    }
  }
}

function parsePackageRequirement(
  type: RunnerPackageType,
  value: unknown,
  source: string
): RunnerPackageRequirement | undefined {
  if (typeof value === "string" && value.trim()) {
    return { type, ...parsePackageIdAndVersion(value), source };
  }

  const record = recordOrUndefined(value);
  if (!record) {
    return undefined;
  }

  const id = stringOrUndefined(record.id) ?? stringOrUndefined(record.name) ?? stringOrUndefined(record.packageId);
  if (!id) {
    return undefined;
  }

  return {
    type,
    id,
    version: stringOrUndefined(record.version),
    installSource:
      stringOrUndefined(record.installSource) ??
      stringOrUndefined(record.packageSource) ??
      stringOrUndefined(record.sourceUrl) ??
      stringOrUndefined(record.sourcePath) ??
      stringOrUndefined(record.source),
    sourceSubdir: stringOrUndefined(record.sourceSubdir) ?? stringOrUndefined(record.subdir),
    source
  };
}

function parseTypedPackageRequirement(value: unknown, source: string): RunnerPackageRequirement | undefined {
  const record = recordOrUndefined(value);
  if (!record) {
    return undefined;
  }

  const type = stringOrUndefined(record.type);
  if (type !== "skill" && type !== "plugin") {
    return undefined;
  }

  return parsePackageRequirement(type, record, source);
}

async function resolveRequirement(
  requirement: RunnerPackageRequirement,
  context: {
    installedSkills: Map<string, string | undefined>;
    installedPlugins: Map<string, string | undefined>;
    skillRoots: string[];
    pluginRoots: string[];
  }
): Promise<RunnerPackageResolutionEntry> {
  const installed = requirement.type === "skill" ? context.installedSkills : context.installedPlugins;
  const installedVersion = installed.get(requirement.id);

  if (installed.has(requirement.id)) {
    return versionMatches(requirement, installedVersion)
      ? { ...requirement, installedVersion }
      : {
          ...requirement,
          installedVersion,
          reason: `installed version ${installedVersion ?? "unknown"} does not match required version ${requirement.version}`
        };
  }

  const roots = requirement.type === "skill" ? context.skillRoots : context.pluginRoots;
  const found = await findPackage(requirement, roots);

  if (!found) {
    return { ...requirement, reason: `${requirement.type} package was not found` };
  }

  if (!versionMatches(requirement, found.version)) {
    return {
      ...requirement,
      installedVersion: found.version,
      path: found.path,
      reason: `installed version ${found.version ?? "unknown"} does not match required version ${requirement.version}`
    };
  }

  return {
    ...requirement,
    installedVersion: found.version,
    path: found.path
  };
}

async function findPackage(
  requirement: RunnerPackageRequirement,
  roots: string[]
): Promise<{ path: string; version?: string } | undefined> {
  let firstFound: { path: string; version?: string } | undefined;

  for (const root of roots) {
    const found = await readPackageCandidate(requirement, root);

    if (!found) {
      continue;
    }

    if (versionMatches(requirement, found.version)) {
      return found;
    }

    firstFound ??= found;
  }

  return firstFound;
}

async function installMissingRequirements(
  requirements: RunnerPackageResolutionEntry[],
  context: {
    skillRegistryRoots: string[];
    pluginRegistryRoots: string[];
    skillInstallRoot: string;
    pluginInstallRoot: string;
  }
): Promise<void> {
  for (const requirement of requirements) {
    await installRequirement(requirement, context);
  }
}

async function installRequirement(
  requirement: RunnerPackageRequirement,
  context: {
    skillRegistryRoots: string[];
    pluginRegistryRoots: string[];
    skillInstallRoot: string;
    pluginInstallRoot: string;
  }
): Promise<void> {
  const registryRoots = requirement.type === "skill" ? context.skillRegistryRoots : context.pluginRegistryRoots;
  const installRoot = requirement.type === "skill" ? context.skillInstallRoot : context.pluginInstallRoot;
  const explicitSource = requirement.installSource
    ? await resolveInstallSourcePackage(requirement, requirement.installSource)
    : undefined;
  const source = explicitSource?.package ?? (await findPackage(requirement, registryRoots));

  try {
    if (!source || !versionMatches(requirement, source.version)) {
      return;
    }

    const target = join(installRoot, requirement.id);
    if (resolve(source.path) === resolve(target) || (await exists(target))) {
      return;
    }

    await mkdir(installRoot, { recursive: true });
    await cp(source.path, target, { recursive: true, errorOnExist: true, force: false });
  } finally {
    await explicitSource?.cleanup?.();
  }
}

async function resolveInstallSourcePackage(
  requirement: RunnerPackageRequirement,
  source: string
): Promise<{ package?: { path: string; version?: string }; cleanup?: () => Promise<void> }> {
  const localPath = localInstallSourcePath(source);

  if (localPath) {
    const packageRoot = requirement.sourceSubdir ? join(localPath, requirement.sourceSubdir) : localPath;

    return {
      package: await readSourcePackageCandidate(requirement, packageRoot)
    };
  }

  const gitSource = gitInstallSource(source);

  if (!gitSource) {
    return {};
  }

  const checkoutDir = await mkdtemp(join(tmpdir(), "ai-workflow-runner-package-"));
  const cloneArgs = ["clone", "--depth", "1"];

  if (gitSource.ref) {
    cloneArgs.push("--branch", gitSource.ref);
  }

  cloneArgs.push(gitSource.url, checkoutDir);
  await execFileAsync("git", cloneArgs, { windowsHide: true });

  const packageRoot = requirement.sourceSubdir ? join(checkoutDir, requirement.sourceSubdir) : checkoutDir;

  return {
    package: await readSourcePackageCandidate(requirement, packageRoot),
    cleanup: () => rm(checkoutDir, { recursive: true, force: true })
  };
}

async function readPackageCandidate(
  requirement: RunnerPackageRequirement,
  root: string
): Promise<{ path: string; version?: string } | undefined> {
  return readPackageDirectory(requirement, join(root, requirement.id));
}

async function readSourcePackageCandidate(
  requirement: RunnerPackageRequirement,
  rootOrPackageDir: string
): Promise<{ path: string; version?: string } | undefined> {
  return (
    (await readPackageDirectory(requirement, rootOrPackageDir)) ??
    (await readPackageCandidate(requirement, rootOrPackageDir))
  );
}

async function readPackageDirectory(
  requirement: RunnerPackageRequirement,
  packageDir: string
): Promise<{ path: string; version?: string } | undefined> {
  const metadataPath = metadataPathForPackage(requirement, packageDir);
  const fallbackPluginPath = join(packageDir, "plugin.json");
  const metadata = await readJsonFile(metadataPath).catch(() =>
    requirement.type === "plugin" ? readJsonFile(fallbackPluginPath).catch(() => undefined) : undefined
  );

  if (metadata) {
    const metadataId = stringOrUndefined(metadata.id) ?? stringOrUndefined(metadata.name);

    if (metadataId && metadataId !== requirement.id) {
      return undefined;
    }

    return {
      path: packageDir,
      version: stringOrUndefined(metadata.version)
    };
  }

  if (basename(packageDir) === requirement.id && (await exists(packageDir))) {
    return { path: packageDir };
  }

  return undefined;
}

function metadataPathForPackage(requirement: RunnerPackageRequirement, packageDir: string): string {
  return requirement.type === "skill"
    ? join(packageDir, "skill.json")
    : join(packageDir, ".codex-plugin", "plugin.json");
}

function parseInstalledPackageList(value: string | undefined, type: RunnerPackageType): Map<string, string | undefined> {
  const packages = new Map<string, string | undefined>();

  for (const item of parseList(value)) {
    const parsed = parsePackageRequirement(type, item, "environment");

    if (parsed) {
      packages.set(parsed.id, parsed.version);
    }
  }

  return packages;
}

function packageRoots(value: string | undefined, fallback: Array<string | undefined>): string[] {
  const roots = parsePathList(value);
  const normalized = (roots.length > 0 ? roots : fallback)
    .filter((root): root is string => Boolean(root))
    .map((root) => resolve(root));

  return [...new Set(normalized)];
}

function versionMatches(requirement: RunnerPackageRequirement, installedVersion: string | undefined): boolean {
  return !requirement.version || requirement.version === installedVersion;
}

function dedupeRequirements(requirements: RunnerPackageRequirement[]): RunnerPackageRequirement[] {
  const seen = new Set<string>();
  const unique: RunnerPackageRequirement[] = [];

  for (const requirement of requirements) {
    const key = `${requirement.type}:${requirement.id}:${requirement.version ?? ""}:${requirement.installSource ?? ""}:${
      requirement.sourceSubdir ?? ""
    }`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(requirement);
    }
  }

  return unique;
}

function formatRunnerPackageList(requirements: RunnerPackageRequirement[]): string {
  return requirements
    .map((requirement) => `${requirement.type} ${requirement.id}${requirement.version ? `@${requirement.version}` : ""}`)
    .join(", ");
}

function parsePackageIdAndVersion(value: string): { id: string; version?: string } {
  const normalized = value.trim();
  const separatorIndex = normalized.lastIndexOf("@");

  if (separatorIndex > 0) {
    return {
      id: normalized.slice(0, separatorIndex),
      version: normalized.slice(separatorIndex + 1) || undefined
    };
  }

  return { id: normalized };
}

function localInstallSourcePath(source: string): string | undefined {
  if (source.startsWith("path:")) {
    return resolve(source.slice("path:".length));
  }

  if (source.startsWith("file://")) {
    return fileURLToPath(source);
  }

  if (source.startsWith("git+") || source.startsWith("github:") || source.startsWith("git@")) {
    return undefined;
  }

  if (/^https?:\/\//.test(source) || /^ssh:\/\//.test(source)) {
    return undefined;
  }

  return resolve(source);
}

function gitInstallSource(source: string): { url: string; ref?: string } | undefined {
  let normalized = source.startsWith("git+") ? source.slice("git+".length) : source;

  if (normalized.startsWith("github:")) {
    const [repo, ref] = splitOnce(normalized.slice("github:".length), "#");
    normalized = `https://github.com/${repo}.git${ref ? `#${ref}` : ""}`;
  }

  if (!isGitInstallSource(normalized)) {
    return undefined;
  }

  const [url, ref] = splitOnce(normalized, "#");

  return {
    url,
    ref: ref || undefined
  };
}

function isGitInstallSource(source: string): boolean {
  return (
    source.startsWith("git@") ||
    source.startsWith("ssh://") ||
    source.startsWith("file://") ||
    source.endsWith(".git") ||
    /^https?:\/\/.+\.git(?:#.*)?$/.test(source)
  );
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);

  if (index < 0) {
    return [value, undefined];
  }

  return [value.slice(0, index), value.slice(index + separator.length)];
}

function parsePathList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  const content = await readFile(path, "utf8");
  return recordOrUndefined(JSON.parse(content));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
