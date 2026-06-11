// app/src/workspace.ts
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface Workspace {
  /** Absolute isolated job directory (resolved from base; may be a symlink on macOS). */
  dir: string;
  /** Absolute path the skill must write its envelope to. */
  outFile: string;
}

/** Reduce an arbitrary jobId to a safe single path segment. */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length > 0 ? safe : "job";
}

/**
 * F10: prepare a fresh, isolated workspace for one job. Creates `<base>/<safeId>/out`,
 * resolves the real path, and asserts it stays inside the base (path-traversal guard).
 */
export async function prepareJobWorkspace(base: string, jobId: string): Promise<Workspace> {
  const baseResolved = resolve(base);
  await mkdir(baseResolved, { recursive: true });
  const realBase = await realpath(baseResolved);

  const safeSegment = sanitizeId(jobId);
  const dir = join(baseResolved, safeSegment);
  await mkdir(join(dir, "out"), { recursive: true });
  const real = await realpath(dir);

  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error(`workspace "${real}" escapes base "${realBase}"`);
  }
  return { dir, outFile: join(dir, "out", "envelope.json") };
}
