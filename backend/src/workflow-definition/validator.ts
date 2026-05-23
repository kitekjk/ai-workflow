import type { WorkflowDefinition, WorkflowStage } from "./schema";
import { isTerminalStage } from "./schema";

const KNOWN_STAGE_TYPES = new Set(["runnable", "approval_gate", "feedback_wait", "manual_decision", "terminal"]);

export class WorkflowDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDefinitionValidationError";
  }
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  // 1. entryStage must exist
  if (!(definition.entryStage in definition.stages)) {
    throw new WorkflowDefinitionValidationError(
      `entryStage '${definition.entryStage}' is not defined in stages`
    );
  }

  // 2. Each stage.type must be known (undefined defaults to runnable)
  for (const [stageId, stage] of Object.entries(definition.stages)) {
    const stageType = stage.type ?? "runnable";
    if (!KNOWN_STAGE_TYPES.has(stageType)) {
      throw new WorkflowDefinitionValidationError(
        `Stage '${stageId}' has unknown type: '${stageType}'`
      );
    }
  }

  // 3. All `on:` targets must exist
  for (const [stageId, stage] of Object.entries(definition.stages)) {
    if (isTerminalStage(stage)) continue;

    const onMap = (stage as { on?: Record<string, string> }).on ?? {};
    for (const [key, target] of Object.entries(onMap)) {
      if (typeof target !== "string") continue;
      if (!(target in definition.stages)) {
        throw new WorkflowDefinitionValidationError(
          `Stage '${stageId}.on.${key}' points to undefined target stage '${target}'`
        );
      }
    }
  }

  // 4. Reachability: all stages must be reachable from entryStage
  const reachable = new Set<string>();
  const queue: string[] = [definition.entryStage];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const stage = definition.stages[current];
    if (!stage || isTerminalStage(stage)) continue;

    const onMap = (stage as { on?: Record<string, string> }).on ?? {};
    for (const target of Object.values(onMap)) {
      if (typeof target === "string" && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const stageId of Object.keys(definition.stages)) {
    if (!reachable.has(stageId)) {
      throw new WorkflowDefinitionValidationError(
        `Stage '${stageId}' is unreachable from entryStage '${definition.entryStage}'`
      );
    }
  }
}
