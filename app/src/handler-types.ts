import type { Envelope, JobType, Ref, Task } from "./domain";
import type { CommonDef, StrategyDef } from "./strategy";

export type Event =
  | { kind: "task_spawned"; taskId: string }
  | { kind: "job_finished"; taskId: string; jobType: JobType; envelope: Envelope }
  | { kind: "job_failed"; taskId: string; jobType: JobType; reason: string }
  | { kind: "external_event"; taskId: string; transition: string };

export type ExternalAction =
  | { kind: "jira_status"; issueKey: string; status: string }
  | { kind: "jira_comment"; issueKey: string; body: string };

export type Action =
  | { kind: "spawn_job"; jobType: JobType; inlineInputs?: Record<string, unknown>; inputRefs?: Ref[] }
  | { kind: "outbound"; actions: ExternalAction[] }
  | { kind: "await_human" }
  | { kind: "terminate"; outcome: "succeeded" | "failed"; nextTaskCandidates?: string[] };

export interface TaskContext {
  task: Task;
  strategy: StrategyDef;
  common: CommonDef;
}

export interface EventHandler {
  onEvent(event: Event, ctx: TaskContext): Action[];
}

/** Substitutes {var}. Arrays render as markdown bullet lines; unknown vars → "". */
export function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) return "\n" + v.map((x) => `- ${x}`).join("\n");
    return String(v);
  });
}
