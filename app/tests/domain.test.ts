import { newId } from "../src/domain";
import { systemClock } from "../src/clock";

describe("domain primitives", () => {
  it("newId returns a unique uuid each call", () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("systemClock.now returns an ISO 8601 string", () => {
    const t = systemClock.now();
    expect(new Date(t).toISOString()).toBe(t);
  });
});
