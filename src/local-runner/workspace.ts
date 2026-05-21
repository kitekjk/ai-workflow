import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ArtifactType } from "../document-core/domain";
import type { WorkflowJob } from "../workflow-core/domain";
import type { RunnerArtifactUpload } from "./runner-client";

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
