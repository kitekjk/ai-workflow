import { fillTemplate } from "../src/handler-types";

describe("fillTemplate", () => {
  it("substitutes scalar vars", () => {
    expect(fillTemplate("품질 {score}점 — {summary}", { score: 90, summary: "ok" })).toBe(
      "품질 90점 — ok",
    );
  });

  it("renders array vars as bullet lines", () => {
    expect(fillTemplate("보완: {missing_items}", { missing_items: ["a", "b"] })).toBe(
      "보완: \n- a\n- b",
    );
  });

  it("leaves unknown vars as empty string", () => {
    expect(fillTemplate("x={nope}", {})).toBe("x=");
  });
});
