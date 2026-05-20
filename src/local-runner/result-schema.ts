import type { ArtifactLocation, ArtifactType } from "../document-core/domain";
import type { LocalRunnerEngineResult } from "./local-runner";
import type { RunnerArtifactUpload } from "./runner-client";
import type { GeneratedFileReference } from "./workspace";

const artifactTypes = new Set<ArtifactType>([
  "document_markdown",
  "wiki_page",
  "runner_log",
  "generated_file",
  "pull_request"
]);
const artifactLocations = new Set<ArtifactLocation>(["git", "wiki", "database", "local_workspace", "external"]);

export class RunnerResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerResultValidationError";
  }
}

export function normalizeCliRunnerResult(payload: Record<string, unknown>): LocalRunnerEngineResult {
  const output = isRecord(payload.output) ? payload.output : withoutRunnerEnvelope(payload);

  return validateLocalRunnerEngineResult({
    output,
    artifacts: payload.artifacts,
    generatedFiles: payload.generatedFiles,
    logs: payload.logs
  });
}

export function validateLocalRunnerEngineResult(value: unknown): LocalRunnerEngineResult {
  if (!isRecord(value)) {
    throw new RunnerResultValidationError("Runner result must be an object");
  }

  const output = requireRecord(value.output, "output");
  const status = output.status;

  if (typeof status !== "string" || status.length === 0) {
    throw new RunnerResultValidationError("output.status must be a non-empty string");
  }

  const normalized: LocalRunnerEngineResult = { output };

  if (value.artifacts !== undefined) {
    normalized.artifacts = requireArray(value.artifacts, "artifacts").map((artifact, index) =>
      parseArtifactUpload(artifact, `artifacts[${index}]`)
    );
  }

  if (value.generatedFiles !== undefined) {
    normalized.generatedFiles = requireArray(value.generatedFiles, "generatedFiles").map((file, index) =>
      parseGeneratedFileReference(file, `generatedFiles[${index}]`)
    );
  }

  if (value.logs !== undefined) {
    normalized.logs = requireArray(value.logs, "logs").map((log, index) => parseRunnerLog(log, `logs[${index}]`));
  }

  return normalized;
}

function parseArtifactUpload(value: unknown, path: string): RunnerArtifactUpload {
  const artifact = requireRecord(value, path);
  const type = requireEnum(artifact.type, artifactTypes, `${path}.type`);
  const location = requireEnum(artifact.location, artifactLocations, `${path}.location`);

  return {
    documentId: optionalString(artifact.documentId, `${path}.documentId`),
    documentVersionId: optionalString(artifact.documentVersionId, `${path}.documentVersionId`),
    type,
    location,
    uri: requireNonEmptyString(artifact.uri, `${path}.uri`),
    externalId: optionalString(artifact.externalId, `${path}.externalId`),
    externalVersion: optionalString(artifact.externalVersion, `${path}.externalVersion`),
    contentHash: optionalString(artifact.contentHash, `${path}.contentHash`),
    metadata: optionalRecord(artifact.metadata, `${path}.metadata`)
  };
}

function parseGeneratedFileReference(value: unknown, path: string): GeneratedFileReference {
  const file = requireRecord(value, path);
  const type = file.type === undefined ? undefined : requireEnum(file.type, artifactTypes, `${path}.type`);

  return {
    path: requireNonEmptyString(file.path, `${path}.path`),
    documentId: optionalString(file.documentId, `${path}.documentId`),
    documentVersionId: optionalString(file.documentVersionId, `${path}.documentVersionId`),
    type,
    metadata: optionalRecord(file.metadata, `${path}.metadata`)
  };
}

function parseRunnerLog(value: unknown, path: string): {
  level?: string;
  message: string;
  metadata?: Record<string, unknown>;
} {
  const log = requireRecord(value, path);

  return {
    level: optionalString(log.level, `${path}.level`),
    message: requireNonEmptyString(log.message, `${path}.message`),
    metadata: optionalRecord(log.metadata, `${path}.metadata`)
  };
}

function withoutRunnerEnvelope(payload: Record<string, unknown>): Record<string, unknown> {
  const { artifacts, generatedFiles, logs, ...output } = payload;
  return output;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RunnerResultValidationError(`${path} must be an object`);
  }

  return value;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireRecord(value, path);
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RunnerResultValidationError(`${path} must be an array`);
  }

  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RunnerResultValidationError(`${path} must be a non-empty string`);
  }

  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RunnerResultValidationError(`${path} must be a string`);
  }

  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new RunnerResultValidationError(`${path} has unsupported value: ${String(value)}`);
  }

  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
