import { toMysqlDatetime, fromMysqlDatetime, safeLimit } from "../src/db";

describe("datetime boundary (F5)", () => {
  it("converts ISO 8601 'Z' to MySQL DATETIME (UTC, no Z)", () => {
    expect(toMysqlDatetime("2026-06-09T01:02:03.000Z")).toBe("2026-06-09 01:02:03");
  });

  it("round-trips MySQL DATETIME back to ISO", () => {
    expect(fromMysqlDatetime("2026-06-09 01:02:03")).toBe("2026-06-09T01:02:03.000Z");
  });

  it("accepts a Date object from the driver", () => {
    const d = new Date("2026-06-09T01:02:03.000Z");
    expect(fromMysqlDatetime(d)).toBe("2026-06-09T01:02:03.000Z");
  });

  it("passes null through", () => {
    expect(toMysqlDatetime(null)).toBeNull();
    expect(fromMysqlDatetime(null)).toBeNull();
  });
});

describe("safeLimit (F6)", () => {
  it("returns an inlinable integer for valid input", () => {
    expect(safeLimit(5)).toBe(5);
  });

  it("rejects non-integer/negative to avoid SQL injection via inlining", () => {
    expect(() => safeLimit(-1)).toThrow();
    expect(() => safeLimit(1.5)).toThrow();
    expect(() => safeLimit(Number("x"))).toThrow();
  });
});
