import type { Clock } from "./clock";
import { newId, type Job, type JobType, type Task } from "./domain";
import type { Action, Event } from "./handler-types";
import type { Outbound } from "./jira";
import type { HandlerRegistry } from "./registry";
import type { Repos } from "./repos";
import type { Runner } from "./runner";
import type { CommonDef, StrategyDef } from "./strategy";

export interface ReactorDeps {
  repos: Repos;
  registry: HandlerRegistry;
  strategy: StrategyDef;
  common: CommonDef;
  outbound: Outbound;
  runner: Runner;
  clock: Clock;
  definitionVersion: string;
}

export class Reactor {
  constructor(public readonly deps: ReactorDeps) {}

  /** Inbound: a new PRD request ticket → run + prd task + first event. */
  async startRun(jiraKey: string): Promise<Task> {
    const { repos, clock, definitionVersion } = this.deps;
    const now = clock.now();
    const runId = newId();
    await repos.runs.create({
      id: runId,
      definitionVersion,
      sourceRequestRef: jiraKey,
      status: "running",
      createdAt: now,
      completedAt: null,
    });
    const task: Task = {
      id: newId(),
      runId,
      parentTaskId: null,
      type: "prd",
      jiraKey,
      assigneeEmail: null,
      status: "in_progress",
      refs: [],
      createdAt: now,
      terminatedAt: null,
    };
    await repos.tasks.create(task);
    await this.applyEvent({ kind: "task_spawned", taskId: task.id });
    return task;
  }

  /** Inbound: a human Jira transition routed to its owning task. */
  async onExternalEvent(jiraKey: string, transition: string): Promise<void> {
    const task = await this.deps.repos.tasks.getByJiraKey(jiraKey);
    if (!task) return;
    await this.applyEvent({ kind: "external_event", taskId: task.id, transition });
  }

  /** Runner reports a finished job → accumulate refs, then react. */
  async onJobFinished(job: Job): Promise<void> {
    const { repos } = this.deps;
    const task = await repos.tasks.get(job.taskId);
    if (!task || !job.envelope) return;
    task.refs = [...task.refs, ...job.envelope.refs];
    await repos.tasks.update(task);
    await this.applyEvent({
      kind: "job_finished",
      taskId: task.id,
      jobType: job.jobType,
      envelope: job.envelope,
    });
  }

  /** Drive the single runner until no pending jobs remain, reacting to each result. */
  async drain(): Promise<void> {
    for (;;) {
      const result = await this.deps.runner.runOnce();
      if (result.kind === "idle") break;
      if (result.kind === "finished") {
        await this.onJobFinished(result.job);
      } else {
        await this.onJobFailed(result.job, result.reason);
      }
    }
  }

  /** Runner reports a failed job → terminate its task (policy via handler, F7). */
  async onJobFailed(job: Job, reason: string): Promise<void> {
    await this.applyEvent({
      kind: "job_failed",
      taskId: job.taskId,
      jobType: job.jobType,
      reason,
    });
  }

  private async applyEvent(event: Event): Promise<void> {
    const { repos, registry, strategy, common } = this.deps;
    const taskId = event.taskId;
    const task = await repos.tasks.get(taskId);
    if (!task) return;
    const handler = registry.get(task.type);
    if (!handler) throw new Error(`no handler for task type "${task.type}"`);

    const actions = handler.onEvent(event, { task, strategy, common });
    for (const action of actions) {
      await this.applyAction(action, task);
    }
  }

  private async applyAction(action: Action, task: Task): Promise<void> {
    const { repos, outbound, clock } = this.deps;
    switch (action.kind) {
      case "spawn_job": {
        const job: Job = {
          id: newId(),
          taskId: task.id,
          jobType: action.jobType as JobType,
          inlineInputs: action.inlineInputs ?? {},
          inputRefs: action.inputRefs ?? task.refs,
          status: "pending",
          envelope: null,
          runnerId: null,
          startedAt: null,
          endedAt: null,
        };
        await repos.jobs.create(job);
        return;
      }
      case "outbound": {
        for (const ext of action.actions) await outbound.apply(ext);
        return;
      }
      case "await_human": {
        const fresh = (await repos.tasks.get(task.id))!;
        fresh.status = "awaiting_human";
        await repos.tasks.update(fresh);
        return;
      }
      case "terminate": {
        const now = clock.now();
        const fresh = (await repos.tasks.get(task.id))!;
        fresh.status = action.outcome;
        fresh.terminatedAt = now;
        await repos.tasks.update(fresh);
        // M0: single task per run → task terminal = run terminal (orchestrator inline).
        const runStatus = action.outcome === "succeeded" ? "completed" : "failed";
        await repos.runs.setStatus(fresh.runId, runStatus, now);
        return;
      }
    }
  }
}
