// app/tests/workspace.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { prepareJobWorkspace } from "../src/workspace";

const base = () => mkdtempSync(join(tmpdir(), "wsbase-"));

describe("prepareJobWorkspace", () => {
  it("creates an isolated dir with an out/ subdir and returns the envelope path", async () => {
    const ws = await prepareJobWorkspace(base(), "job-123");
    const s = await stat(join(ws.dir, "out"));
    expect(s.isDirectory()).toBe(true);
    expect(ws.outFile).toBe(join(ws.dir, "out", "envelope.json"));
  });

  it("sanitizes a jobId with path separators so it cannot escape the base", async () => {
    const b = base();
    const ws = await prepareJobWorkspace(b, "../../etc/passwd");
    expect(ws.dir.startsWith(b)).toBe(true);
    expect(ws.dir).not.toContain("..");
  });

  it("gives different jobIds different directories", async () => {
    const b = base();
    const a = await prepareJobWorkspace(b, "job-a");
    const c = await prepareJobWorkspace(b, "job-c");
    expect(a.dir).not.toBe(c.dir);
  });
});
