import { describe, test, expect } from "vitest";
import { interpretWorkflowEvent, type WorkflowInterpreterEvent, type WorkflowRunState } from "../../backend/src/workflow-definition/interpreter";
import { loadTestPrdDefinition } from "../fixtures/prd-definition";

const definition = loadTestPrdDefinition();

function state(currentStageId: string, attempts: number = 0): WorkflowRunState {
  return {
    runId: "run_test",
    currentStageId,
    currentTaskId: "task_test",
    attemptCounts: { [currentStageId]: attempts },
    metadata: { sourceKey: "PRD-TEST-1", prdJiraKey: "PRD-TEST-1" }
  };
}

function jobCompleted(jobType: string, outputStatus: string): WorkflowInterpreterEvent {
  return {
    type: "job.completed",
    jobType: jobType as never,
    result: { id: "res_x", jobId: "job_x", status: "succeeded", output: { status: outputStatus } } as never
  };
}

describe("interpretWorkflowEvent (PRD)", () => {
  test("1. prd.draft + job.completed(succeeded) -> prd.quality + prd.evaluate_quality job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.draft"),
      event: jobCompleted("prd.generate_draft", "succeeded")
    });
    expect(out.transitions[0].toStageId).toBe("prd.quality");
    expect(out.jobsToCreate[0].jobType).toBe("prd.evaluate_quality");
  });

  test("2. prd.draft + job.completed(failed, attempts=0) -> retry same stage", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.draft", 0),
      event: jobCompleted("prd.generate_draft", "failed")
    });
    expect(out.transitions).toHaveLength(0);
    expect(out.jobsToCreate[0].jobType).toBe("prd.generate_draft");
  });

  test("3. prd.draft + job.completed(failed, attempts=3 max) -> prd.failed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.draft", 3),
      event: jobCompleted("prd.generate_draft", "failed")
    });
    expect(out.transitions[0].toStageId).toBe("prd.failed");
    expect(out.terminal?.kind).toBe("failed");
  });

  test("4. prd.quality + job.completed(passed) -> prd.approval + jira to pending", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.quality"),
      event: jobCompleted("prd.evaluate_quality", "passed")
    });
    expect(out.transitions[0].toStageId).toBe("prd.approval");
    const jiraAction = out.externalActions.find((a) => a.type === "jira.transition");
    expect(jiraAction).toBeDefined();
    if (jiraAction && jiraAction.type === "jira.transition") {
      expect(jiraAction.toStatus).toBe("승인 대기");
    }
  });

  test("5. prd.quality + job.completed(needs_revision) -> prd.needs_revision", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.quality"),
      event: jobCompleted("prd.evaluate_quality", "needs_revision")
    });
    expect(out.transitions[0].toStageId).toBe("prd.needs_revision");
  });

  test("6. prd.needs_revision + feedback.received -> prd.revise + prd.apply_feedback_revision job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.needs_revision"),
      event: { type: "feedback.received", feedback: { id: "fb1", source: "app", body: "fix" } as never }
    });
    expect(out.transitions[0].toStageId).toBe("prd.revise");
    expect(out.jobsToCreate[0].jobType).toBe("prd.apply_feedback_revision");
  });

  test("7. prd.revise + job.completed(succeeded) -> prd.quality + prd.evaluate_quality job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.revise"),
      event: jobCompleted("prd.apply_feedback_revision", "succeeded")
    });
    expect(out.transitions[0].toStageId).toBe("prd.quality");
    expect(out.jobsToCreate[0].jobType).toBe("prd.evaluate_quality");
  });

  test("8. prd.approval + approval.changed(approved) -> prd.routing + prd.route_downstream job", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.approval"),
      event: { type: "approval.changed", status: "approved" }
    });
    expect(out.transitions[0].toStageId).toBe("prd.routing");
    expect(out.jobsToCreate[0].jobType).toBe("prd.route_downstream");
  });

  test("9. prd.approval + approval.changed(rejected) -> prd.failed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.approval"),
      event: { type: "approval.changed", status: "rejected" }
    });
    expect(out.transitions[0].toStageId).toBe("prd.failed");
    expect(out.terminal?.kind).toBe("failed");
  });

  test("10. prd.routing + job.completed(route_decided) -> completed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.routing"),
      event: jobCompleted("prd.route_downstream", "route_decided")
    });
    expect(out.transitions[0].toStageId).toBe("completed");
    expect(out.terminal?.kind).toBe("completed");
  });

  test("11. prd.routing + job.completed(needs_scope_confirmation) -> prd.scale_clarification", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.routing"),
      event: jobCompleted("prd.route_downstream", "needs_scope_confirmation")
    });
    expect(out.transitions[0].toStageId).toBe("prd.scale_clarification");
  });

  test("12. prd.scale_clarification + manual.decision('HLD') -> completed terminal", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.scale_clarification"),
      event: { type: "manual.decision", decision: "HLD" }
    });
    expect(out.transitions[0].toStageId).toBe("completed");
    expect(out.terminal?.kind).toBe("completed");
  });

  test("13. prd.quality + feedback.received (mismatch) -> noop, unmatchedEvent populated", () => {
    const out = interpretWorkflowEvent({
      definition,
      runState: state("prd.quality"),
      event: { type: "feedback.received", feedback: { id: "fb1", source: "app", body: "x" } as never }
    });
    expect(out.transitions).toHaveLength(0);
    expect(out.jobsToCreate).toHaveLength(0);
    expect(out.unmatchedEvent).toBeDefined();
    expect(out.unmatchedEvent?.stageId).toBe("prd.quality");
  });
});
