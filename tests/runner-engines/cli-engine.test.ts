import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliEngine, CliEngineError } from "../../backend/src/runner-engines/cli-engine";

describe("CliEngine", () => {
  it("runs a CLI command and parses JSON stdout", async () => {
    const bin = createFakeCli("console.log(JSON.stringify({ status: 'ok', text: 'hello' }));");
    const engine = new CliEngine({ command: bin, timeoutMs: 5000 });

    const result = await engine.runJson({ prompt: "generate PRD" });

    expect(result).toEqual({ status: "ok", text: "hello" });
  });

  it("sends JSON input to the CLI process stdin", async () => {
    const bin = createFakeCli(`
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const input = JSON.parse(body);
  console.log(JSON.stringify({ received: input.prompt }));
});
`);
    const engine = new CliEngine({ command: bin, timeoutMs: 5000 });

    const result = await engine.runJson({ prompt: "generate PRD" });

    expect(result).toEqual({ received: "generate PRD" });
  });

  it("returns parsed JSON with raw stdout and stderr for log retention", async () => {
    const bin = createFakeCli(`
console.error("model warmed up");
console.log(JSON.stringify({ status: "ok" }));
`);
    const engine = new CliEngine({ command: bin, timeoutMs: 5000 });

    const result = await engine.runJsonWithProcessOutput({ prompt: "generate PRD" });

    expect(result).toEqual({
      output: { status: "ok" },
      stdout: '{"status":"ok"}\n',
      stderr: "model warmed up\n"
    });
  });

  it("runs the CLI process inside the configured working directory", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cli-engine-cwd-"));
    const bin = createFakeCli(`
console.log(JSON.stringify({ cwd: process.cwd().replace(/\\\\/g, "/") }));
`);
    const engine = new CliEngine({ command: bin, timeoutMs: 5000, cwd });

    const result = await engine.runJson({});

    expect(result).toEqual({
      cwd: portableRealPath(cwd)
    });
  });

  it("includes stderr when the CLI exits non-zero", async () => {
    const bin = createFakeCli(`
console.error("missing auth token");
process.exit(42);
`);
    const engine = new CliEngine({ command: bin, timeoutMs: 5000 });

    await expect(engine.runJson({ prompt: "generate PRD" })).rejects.toThrow(
      /fake-cli.*exited with code 42.*missing auth token/s
    );
  });

  it("throws a clear error when stdout is not valid JSON", async () => {
    const bin = createFakeCli('console.log("not-json");');
    const engine = new CliEngine({ command: bin, timeoutMs: 5000 });

    await expect(engine.runJson({ prompt: "generate PRD" })).rejects.toThrow(
      /fake-cli.*valid JSON.*not-json/s
    );
  });

  it("times out a long-running CLI process", async () => {
    const bin = createFakeCli("setTimeout(() => {}, 10000);");
    const engine = new CliEngine({ command: bin, timeoutMs: 50 });

    await expect(engine.runJson({ prompt: "generate PRD" })).rejects.toThrow(
      /fake-cli.*timed out after 50ms/
    );
  });
});

function createFakeCli(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-engine-"));
  const bin = join(dir, "fake-cli");
  writeFileSync(bin, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function portableRealPath(path: string): string {
  return realpathSync(path).replace(/\\/g, "/");
}
