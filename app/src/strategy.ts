import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export interface JobDef {
  skill: string;
  outputSchema: Record<string, unknown>; // JSON Schema (consumed by ajv as-is)
  threshold?: number;
}

export interface StrategyDef {
  version: number;
  type: string;
  meta: { approverRole?: string };
  jobs: Record<string, JobDef>;
}

export interface OutboundEntry {
  action: "jira_status" | "jira_comment";
  status?: string;
  template?: string;
}

export interface CommonDef {
  trigger: { newRunStatus: string };
  outbound: Record<string, OutboundEntry[]>; // keys: quality_passed | quality_failed | ...
  inbound: Record<string, string>; // "승인" -> "approved"
}

export interface LoadedStrategy {
  strategy: StrategyDef;
  common: CommonDef;
}

function readYaml(path: string): any {
  return parse(readFileSync(path, "utf8"));
}

/**
 * On Windows, `new URL(...).pathname` returns a leading-slash path like
 * `/C:/Users/...`. Node's `path.join` then produces `C:\C:\...`.
 * Strip the leading slash when running on Windows so `join` works correctly.
 */
function normaliseDirPath(p: string): string {
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(p)) {
    return p.slice(1);
  }
  return p;
}

export function loadStrategy(defsDir: string, type: string): LoadedStrategy {
  const resolvedDir = normaliseDirPath(defsDir);
  const raw = readYaml(join(resolvedDir, `${type}.yaml`));
  if (raw?.type !== type) {
    throw new Error(
      `strategy file type "${raw?.type}" does not match requested "${type}"`,
    );
  }
  if (typeof raw.version !== "number") {
    throw new Error(`strategy "${type}" missing numeric version`);
  }
  const jobs: Record<string, JobDef> = {};
  for (const [jobType, def] of Object.entries<any>(raw.jobs ?? {})) {
    if (!def?.skill) throw new Error(`job "${jobType}" missing skill`);
    if (!def?.output_schema) throw new Error(`job "${jobType}" missing output_schema`);
    jobs[jobType] = {
      skill: def.skill,
      outputSchema: def.output_schema,
      threshold: def.threshold,
    };
  }

  const commonRaw = readYaml(join(resolvedDir, `_common.yaml`));
  const newRunStatus = commonRaw?.trigger?.new_run_status;
  if (!newRunStatus) throw new Error(`_common.yaml missing trigger.new_run_status`);

  const strategy: StrategyDef = {
    version: raw.version,
    type: raw.type,
    meta: { approverRole: raw.meta?.approver_role },
    jobs,
  };
  const common: CommonDef = {
    trigger: { newRunStatus },
    outbound: commonRaw.outbound ?? {},
    inbound: commonRaw.inbound ?? {},
  };
  return { strategy, common };
}
