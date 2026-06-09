import { randomUUID } from "node:crypto";

export type RunStatus = "running" | "completed" | "canceled" | "failed";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "awaiting_human"
  | "succeeded"
  | "failed"
  | "canceled";
export type JobStatus =
  | "pending"
  | "claimed"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "canceled";
export type JobType = "generate" | "quality" | "routing";

/** Opaque external reference. App stores + renders; never reads/verifies (D4 bare claim). */
export interface Ref {
  system: string; // "git" | "wiki" | ...
  key: string;
  url?: string;
  label?: string;
}

/** Skill result (skill → app). domainOutput shape is validated; refs are opaque. */
export interface Envelope {
  domainOutput: Record<string, unknown>;
  refs: Ref[];
  nextTaskCandidates?: string[];
}

export interface WorkflowRun {
  id: string;
  definitionVersion: string;
  sourceRequestRef: string; // Jira issue key of the operating request
  status: RunStatus;
  createdAt: string; // ISO
  completedAt: string | null;
}

export interface Task {
  id: string;
  runId: string;
  parentTaskId: string | null;
  type: string; // "prd"
  jiraKey: string;
  assigneeEmail: string | null;
  status: TaskStatus;
  refs: Ref[]; // accumulated from envelopes; opaque metadata
  createdAt: string;
  terminatedAt: string | null;
}

export interface Job {
  id: string;
  taskId: string;
  jobType: JobType;
  inlineInputs: Record<string, unknown>;
  inputRefs: Ref[];
  status: JobStatus;
  envelope: Envelope | null;
  runnerId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export function newId(): string {
  return randomUUID();
}
