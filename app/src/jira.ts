import type { ExternalAction } from "./handler-types";

export type InboundEvent =
  | { kind: "new_run"; jiraKey: string }
  | { kind: "transition"; jiraKey: string; transition: string }
  | { kind: "ignore" };

interface JiraWebhookPayload {
  issue?: { key?: string };
  status?: string;
}

/** Source-agnostic normalize: a trigger-status issue starts a run; anything else is a transition. */
export function normalizeJiraWebhook(
  payload: JiraWebhookPayload,
  triggerStatus: string,
): InboundEvent {
  const jiraKey = payload.issue?.key;
  if (!jiraKey) return { kind: "ignore" };
  if (payload.status === triggerStatus) return { kind: "new_run", jiraKey };
  return { kind: "transition", jiraKey, transition: payload.status ?? "" };
}

/** Outbound port. M0 ships a recorder (tests + dry-run); real Jira client is M0+. */
export interface Outbound {
  apply(action: ExternalAction): Promise<void>;
}

export class RecordingOutbound implements Outbound {
  applied: ExternalAction[] = [];
  async apply(action: ExternalAction): Promise<void> {
    this.applied.push(action);
  }
}
