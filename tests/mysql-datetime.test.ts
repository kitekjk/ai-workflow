import { describe, expect, it } from "vitest";
import { fromMysqlDateTime, toMysqlDateTime, toNullableMysqlDateTime } from "../backend/src/mysql/datetime";

describe("MySQL datetime formatting", () => {
  it("formats ISO timestamps for DATETIME(3) parameters", () => {
    expect(toMysqlDateTime("2026-05-21T15:18:44.160Z")).toBe("2026-05-21 15:18:44.160");
    expect(toMysqlDateTime(new Date("2026-05-21T15:18:44.160Z"))).toBe("2026-05-21 15:18:44.160");
  });

  it("keeps nullable DATETIME values null", () => {
    expect(toNullableMysqlDateTime(undefined)).toBeNull();
    expect(toNullableMysqlDateTime(null)).toBeNull();
  });

  it("normalizes MySQL DATETIME strings back to ISO timestamps", () => {
    expect(fromMysqlDateTime("2026-05-21 15:18:44.160")).toBe("2026-05-21T15:18:44.160Z");
    expect(fromMysqlDateTime("2026-05-21T15:18:44.160Z")).toBe("2026-05-21T15:18:44.160Z");
  });
});
