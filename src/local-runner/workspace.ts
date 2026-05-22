import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ArtifactType } from "../document-core/domain";
import type { WorkflowJob } from "../workflow-core/domain";
import type { RunnerArtifactUpload } from "./runner-client";

const execFileAsync = promisify(execFile);

export interface LocalRunnerWorkspaceOptions {
  rootDir: string;
  clean?: boolean;
}

export interface PreparedJobWorkspace {
  rootDir: string;
  workspaceDir: string;
}

export interface GeneratedFileReference {
  path: string;
  documentId?: string;
  documentVersionId?: string;
  type?: ArtifactType;
  metadata?: Record<string, unknown>;
}

export async function prepareJobWorkspace(input: {
  job: WorkflowJob;
  workspace: LocalRunnerWorkspaceOptions;
}): Promise<PreparedJobWorkspace> {
  const requestedRootDir = resolve(input.workspace.rootDir);
  await mkdir(requestedRootDir, { recursive: true });
  const rootDir = await realpath(requestedRootDir);
  const workspaceDir = resolve(rootDir, sanitizePathSegment(input.job.id));

  assertPathInside(rootDir, workspaceDir, "workspaceDir");
  if (input.workspace.clean ?? true) {
    await rm(workspaceDir, { recursive: true, force: true });
  }

  await mkdir(workspaceDir, { recursive: true });
  const canonicalWorkspaceDir = await realpath(workspaceDir);
  const templateWorkdir = readRunnerJobTemplateWorkdir(input.job.input);
  const executionDir = templateWorkdir
    ? await prepareTemplateWorkdir(canonicalWorkspaceDir, templateWorkdir)
    : canonicalWorkspaceDir;

  await prepareRepositoryCheckout(input.job, executionDir);

  return {
    rootDir,
    workspaceDir: canonicalWorkspaceDir
  };
}

export async function collectGeneratedFileArtifacts(input: {
  workspaceDir: string;
  files: GeneratedFileReference[];
}): Promise<RunnerArtifactUpload[]> {
  const workspaceDir = await realpath(resolve(input.workspaceDir));
  const artifacts: RunnerArtifactUpload[] = [];

  for (const file of input.files) {
    const filePath = await resolveWorkspaceFile(workspaceDir, file.path);
    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      throw new Error(`Generated artifact is not a file: ${file.path}`);
    }

    const relativePath = toPortablePath(relative(workspaceDir, filePath));
    const content = await readFile(filePath);

    artifacts.push({
      documentId: file.documentId,
      documentVersionId: file.documentVersionId,
      type: file.type ?? "generated_file",
      location: "local_workspace",
      uri: `local-workspace:${relativePath}`,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      metadata: {
        ...(file.metadata ?? {}),
        relativePath,
        sizeBytes: fileStat.size
      }
    });
  }

  return artifacts;
}

export async function listWorkspaceFiles(workspaceDir: string): Promise<string[]> {
  const rootDir = await realpath(resolve(workspaceDir));
  const files: string[] = [];
  await walk(rootDir, rootDir, files);
  return files.sort();
}

async function resolveWorkspaceFile(workspaceDir: string, requestedPath: string): Promise<string> {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("Generated file path is required");
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceDir, requestedPath);

  assertPathInside(workspaceDir, resolvedPath, requestedPath);
  const canonicalPath = await realpath(resolvedPath);
  assertPathInside(workspaceDir, canonicalPath, requestedPath);
  return canonicalPath;
}

async function walk(rootDir: string, currentDir: string, files: string[]): Promise<void> {
  assertPathInside(rootDir, currentDir, "currentDir");

  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const entryPath = resolve(currentDir, entry.name);

    if (entry.isDirectory()) {
      await walk(rootDir, entryPath, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(toPortablePath(relative(rootDir, entryPath)));
    }
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

async function prepareTemplateWorkdir(workspaceDir: string, workdir: string): Promise<string> {
  const resolvedWorkdir = isAbsolute(workdir) ? resolve(workdir) : resolve(workspaceDir, workdir);
  assertPathInside(workspaceDir, resolvedWorkdir, "runnerJobTemplate.workdir");
  await mkdir(resolvedWorkdir, { recursive: true });
  const canonicalWorkdir = await realpath(resolvedWorkdir);
  assertPathInside(workspaceDir, canonicalWorkdir, "runnerJobTemplate.workdir");
  return canonicalWorkdir;
}

async function prepareRepositoryCheckout(job: WorkflowJob, targetDir: string): Promise<void> {
  if (job.jobType !== "implementation.update_pr") {
    return;
  }

  const cloneUrl =
    optionalString(job.input.repositoryCloneUrl) ?? optionalString(job.input.implementationRepositoryCloneUrl);
  const branchName =
    optionalString(job.input.branchName) ?? optionalString(job.input.pullRequestBranch) ?? optionalString(job.input.headBranch);

  if (!cloneUrl && !branchName) {
    return;
  }

  if (!cloneUrl || !branchName) {
    throw new Error("implementation.update_pr requires repositoryCloneUrl and branchName to prepare a git workspace");
  }

  const entries = await readdir(targetDir);

  if (entries.length === 0) {
    await execGit(["clone", "--branch", branchName, "--single-branch", cloneUrl, targetDir]);
    return;
  }

  if (entries.includes(".git")) {
    await execGit(["-C", targetDir, "fetch", "origin", branchName]);
    await execGit(["-C", targetDir, "checkout", branchName]);
    return;
  }

  throw new Error("implementation.update_pr workdir must be empty or an existing git checkout");
}

async function execGit(args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { windowsHide: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0]} failed while preparing runner workspace: ${message}`);
  }
}

function readRunnerJobTemplateWorkdir(input: Record<string, unknown> | undefined): string | undefined {
  const rawTemplate = firstRecord(input?.runnerJobTemplate, input?.jobTemplate);
  const rawConfig = firstRecord(rawTemplate?.runner, rawTemplate?.cli, rawTemplate);
  return optionalString(rawConfig?.workdir) ?? optionalString(rawConfig?.cwd);
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
