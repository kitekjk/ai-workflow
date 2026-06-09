import { validateEnvelope } from "../src/envelope";

const qualitySchema = {
  type: "object",
  required: ["score", "missing_items"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    missing_items: { type: "array", items: { type: "string" } },
  },
};

describe("validateEnvelope", () => {
  it("accepts a well-shaped envelope", () => {
    const r = validateEnvelope(
      {
        domainOutput: { score: 90, missing_items: [] },
        refs: [{ system: "git", key: "r@abc", url: "https://x/abc" }],
      },
      qualitySchema,
    );
    expect(r.ok).toBe(true);
  });

  it("rejects domainOutput that violates output_schema", () => {
    const r = validateEnvelope(
      { domainOutput: { score: 200, missing_items: [] }, refs: [] },
      qualitySchema,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a ref missing required key", () => {
    const r = validateEnvelope(
      // deliberately malformed ref (missing required `key`) to exercise runtime rejection
      { domainOutput: { score: 90, missing_items: [] }, refs: [{ system: "git" } as any] },
      qualitySchema,
    );
    expect(r.ok).toBe(false);
  });

  it("does NOT verify ref reachability (bare claim) — fake but well-shaped ref passes", () => {
    const r = validateEnvelope(
      {
        domainOutput: { score: 90, missing_items: [] },
        refs: [{ system: "git", key: "does-not-exist@deadbeef" }],
      },
      qualitySchema,
    );
    expect(r.ok).toBe(true);
  });
});
