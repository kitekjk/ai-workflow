import { normalizeJiraWebhook, RecordingOutbound } from "../src/jira";

describe("normalizeJiraWebhook", () => {
  it("classifies a trigger-status issue as a new_run", () => {
    const evt = normalizeJiraWebhook(
      { issue: { key: "PAIR-7" }, status: "PRD 요청" },
      "PRD 요청",
    );
    expect(evt).toEqual({ kind: "new_run", jiraKey: "PAIR-7" });
  });

  it("classifies a non-trigger status as a transition", () => {
    const evt = normalizeJiraWebhook(
      { issue: { key: "PAIR-7" }, status: "승인" },
      "PRD 요청",
    );
    expect(evt).toEqual({ kind: "transition", jiraKey: "PAIR-7", transition: "승인" });
  });

  it("returns ignore when no issue key present", () => {
    const evt = normalizeJiraWebhook({ status: "승인" }, "PRD 요청");
    expect(evt).toEqual({ kind: "ignore" });
  });
});

describe("RecordingOutbound", () => {
  it("records applied actions in order", async () => {
    const out = new RecordingOutbound();
    await out.apply({ kind: "jira_status", issueKey: "PAIR-7", status: "승인대기" });
    await out.apply({ kind: "jira_comment", issueKey: "PAIR-7", body: "hi" });
    expect(out.applied).toEqual([
      { kind: "jira_status", issueKey: "PAIR-7", status: "승인대기" },
      { kind: "jira_comment", issueKey: "PAIR-7", body: "hi" },
    ]);
  });
});
