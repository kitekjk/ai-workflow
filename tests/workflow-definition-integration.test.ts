import { describe, test, expect } from "vitest";
import { loadTestPrdDefinition } from "./fixtures/prd-definition";
import { interpretWorkflowEvent } from "../backend/src/workflow-definition/interpreter";
import type { WorkflowInterpreterEvent } from "../backend/src/workflow-definition/interpreter";

describe("workflow-definition integration (in-process)", () => {
  test("PRD definition loaded from YAML has the correct structural shape", () => {
    const definition = loadTestPrdDefinition();
    expect(definition.id).toBe("prd-confirmation");
    expect(definition.version).toBe(1);
    expect(definition.documentTypes).toContain("prd");
    expect(definition.entryStage).toBe("prd.draft");
    expect(Object.keys(definition.stages).length).toBe(9);
  });

  test("PRD definition stage graph is reachable end-to-end through interpreter", () => {
    const definition = loadTestPrdDefinition();
    const visited: string[] = ["prd.draft"];
    let stage = "prd.draft";

    function step(event: WorkflowInterpreterEvent, attempts: number = 0) {
      const out = interpretWorkflowEvent({
        definition,
        runState: {
          runId: "run_int",
          currentStageId: stage,
          currentTaskId: "task_int",
          attemptCounts: { [stage]: attempts },
          metadata: { sourceKey: "PRD-INT-1" }
        },
        event
      });
      if (out.transitions[0]) {
        stage = out.transitions[0].toStageId;
        visited.push(stage);
      }
      return out;
    }

    // Happy path: draft → quality → approval → routing → completed
    step({ type: "job.completed", jobType: "prd.generate_draft" as never, result: { id: "r1", jobId: "j1", status: "succeeded", output: { status: "succeeded" } } as never });
    step({ type: "job.completed", jobType: "prd.evaluate_quality" as never, result: { id: "r2", jobId: "j2", status: "succeeded", output: { status: "passed" } } as never });
    step({ type: "approval.changed", status: "approved" });
    step({ type: "job.completed", jobType: "prd.route_downstream" as never, result: { id: "r3", jobId: "j3", status: "succeeded", output: { status: "route_decided" } } as never });

    expect(visited).toEqual(["prd.draft", "prd.quality", "prd.approval", "prd.routing", "completed"]);
  });

  test("PRD definition can describe the feedback-revision loop", () => {
    const definition = loadTestPrdDefinition();
    // prd.quality → needs_revision → prd.needs_revision → feedback received → prd.revise → success → prd.quality
    let stage = "prd.quality";
    const visited: string[] = [stage];

    function step(event: WorkflowInterpreterEvent, attempts: number = 0) {
      const out = interpretWorkflowEvent({
        definition,
        runState: {
          runId: "run_int",
          currentStageId: stage,
          currentTaskId: "task_int",
          attemptCounts: { [stage]: attempts },
          metadata: { sourceKey: "PRD-INT-2" }
        },
        event
      });
      if (out.transitions[0]) {
        stage = out.transitions[0].toStageId;
        visited.push(stage);
      }
      return out;
    }

    step({ type: "job.completed", jobType: "prd.evaluate_quality" as never, result: { id: "r4", jobId: "j4", status: "succeeded", output: { status: "needs_revision", score: 60 } } as never });
    step({ type: "feedback.received", feedback: { id: "fb1", source: "app", body: "fix" } as never });
    step({ type: "job.completed", jobType: "prd.apply_feedback_revision" as never, result: { id: "r5", jobId: "j5", status: "succeeded", output: { status: "succeeded" } } as never });

    expect(visited).toEqual(["prd.quality", "prd.needs_revision", "prd.revise", "prd.quality"]);
  });
});
