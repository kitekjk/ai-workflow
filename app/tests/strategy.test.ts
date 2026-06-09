import { loadStrategy } from "../src/strategy";

const DEFS = new URL("../workflows/definitions/", import.meta.url).pathname;

describe("loadStrategy", () => {
  it("loads prd strategy + common with camelCased keys", () => {
    const { strategy, common } = loadStrategy(DEFS, "prd");
    expect(strategy.type).toBe("prd");
    expect(strategy.version).toBe(1);
    expect(strategy.jobs.quality.threshold).toBe(85);
    expect(strategy.jobs.generate.skill).toBe("prd.generate");
    expect(common.trigger.newRunStatus).toBe("PRD 요청");
    expect(common.inbound["승인"]).toBe("approved");
    expect(common.outbound.quality_passed[0]).toEqual({
      action: "jira_status",
      status: "승인대기",
    });
  });

  it("throws when type does not match filename", () => {
    expect(() => loadStrategy(DEFS, "nope")).toThrow();
  });
});
