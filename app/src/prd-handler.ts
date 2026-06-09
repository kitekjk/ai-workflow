import type { Action, EventHandler, ExternalAction, TaskContext } from "./handler-types";
import { fillTemplate } from "./handler-types";

function outboundFor(
  key: string,
  ctx: TaskContext,
  vars: Record<string, unknown>,
): Action {
  const entries = ctx.common.outbound[key] ?? [];
  const actions: ExternalAction[] = entries.map((e) => {
    if (e.action === "jira_status") {
      return { kind: "jira_status", issueKey: ctx.task.jiraKey, status: e.status ?? "" };
    }
    return {
      kind: "jira_comment",
      issueKey: ctx.task.jiraKey,
      body: fillTemplate(e.template ?? "", vars),
    };
  });
  return { kind: "outbound", actions };
}

export const prdHandler: EventHandler = {
  onEvent(event, ctx): Action[] {
    switch (event.kind) {
      case "task_spawned":
        return [{ kind: "spawn_job", jobType: "generate" }];

      case "job_finished": {
        if (event.jobType === "generate") {
          return [{ kind: "spawn_job", jobType: "quality" }];
        }
        if (event.jobType === "quality") {
          const out = event.envelope.domainOutput;
          const score = Number(out.score ?? 0);
          const threshold = ctx.strategy.jobs.quality?.threshold ?? 0;
          const vars = { ...out, threshold };
          if (score >= threshold) {
            return [outboundFor("quality_passed", ctx, vars), { kind: "await_human" }];
          }
          return [
            outboundFor("quality_failed", ctx, vars),
            { kind: "terminate", outcome: "failed" },
          ];
        }
        if (event.jobType === "routing") {
          return [
            {
              kind: "terminate",
              outcome: "succeeded",
              nextTaskCandidates: event.envelope.nextTaskCandidates,
            },
          ];
        }
        return [];
      }

      case "external_event": {
        const semantic = ctx.common.inbound[event.transition];
        if (semantic === "approved") {
          return [{ kind: "spawn_job", jobType: "routing" }];
        }
        return [];
      }
    }
  },
};
