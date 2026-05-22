export const CREDENTIAL_ENV_ALLOWLIST = [
  "JIRA_API_TOKEN",
  "CONFLUENCE_API_TOKEN",
  "GITHUB_TOKEN",
  "WORKFLOW_APP_API_TOKEN",
  "WORKFLOW_RUNNER_TOKENS",
  "LOCAL_RUNNER_TOKEN",
  "WORKFLOW_MYSQL_PASSWORD",
  "WORKFLOW_MYSQL_ROOT_PASSWORD"
] as const;

export type CredentialEnvKey = (typeof CREDENTIAL_ENV_ALLOWLIST)[number];

export interface RedactSecretsOptions {
  env?: NodeJS.ProcessEnv;
  secretValues?: string[];
}

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|api[_-]?token|token|secret|password|authorization|credential)/i;
const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const WELL_KNOWN_TOKEN_PATTERN = /\b(?:gh[pousr]_|sk-|xox[baprs]-)[A-Za-z0-9._-]+/g;
const QUERY_SECRET_PATTERN = /([?&](?:token|api[_-]?key|apikey|password|secret)=)[^&\s]+/gi;

export function credentialEnvAllowlist(): CredentialEnvKey[] {
  return [...CREDENTIAL_ENV_ALLOWLIST];
}

export function configuredCredentialEnvKeys(env: NodeJS.ProcessEnv): CredentialEnvKey[] {
  return credentialEnvAllowlist().filter((key) => Boolean(env[key]?.trim()));
}

export function redactSecrets<T>(value: T, options: RedactSecretsOptions = {}): T {
  return redactValue(value, collectSecretValues(options), new WeakSet<object>()) as T;
}

function collectSecretValues(options: RedactSecretsOptions): string[] {
  const values = new Set<string>();

  for (const value of options.secretValues ?? []) {
    addSecretValue(values, value);
  }

  if (options.env) {
    for (const key of CREDENTIAL_ENV_ALLOWLIST) {
      addSecretValue(values, options.env[key]);

      if (key === "WORKFLOW_RUNNER_TOKENS") {
        addRunnerTokenValues(values, options.env[key]);
      }
    }
  }

  return [...values].sort((left, right) => right.length - left.length);
}

function addRunnerTokenValues(values: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();

  if (!trimmed) {
    return;
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const token of Object.values(parsed)) {
          if (typeof token === "string") {
            addSecretValue(values, token);
          }
        }
      }
    } catch {
      return;
    }

    return;
  }

  for (const pair of trimmed.split(",")) {
    const separatorIndex = pair.indexOf(":");

    if (separatorIndex > 0) {
      addSecretValue(values, pair.slice(separatorIndex + 1));
    }
  }
}

function addSecretValue(values: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();

  if (trimmed && trimmed.length >= 4) {
    values.add(trimmed);
  }
}

function redactValue(value: unknown, secretValues: string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value, secretValues);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues, seen));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(child, secretValues, seen);
  }

  return output;
}

function redactString(value: string, secretValues: string[]): string {
  let redacted = value
    .replace(AUTH_HEADER_PATTERN, "$1 [REDACTED]")
    .replace(WELL_KNOWN_TOKEN_PATTERN, "[REDACTED]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]");

  for (const secret of secretValues) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }

  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}
