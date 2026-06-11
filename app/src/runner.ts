import type { Clock } from "./clock";
import type { Job } from "./domain";
import { validateEnvelope } from "./envelope";
import type { Repos } from "./repos";
import type { Skill } from "./stub-skill";
import type { StrategyDef } from "./strategy";

export type RunResult =
  | { kind: "idle" }
  | { kind: "finished"; job: Job }
  | { kind: "failed"; job: Job; reason: string };

/**
 * Single local runner (M0). Claims one pending job, invokes the skill, validates the
 * envelope shape, and stores the result. git/wiki/PR writes are the skill's job — the
 * runner only relays the envelope. Returns a RunResult: idle (no pending), finished
 * (succeeded job), or failed (job marked failed + reason for the reactor to propagate).
 */
export class Runner {
  constructor(
    private readonly repos: Repos,
    private readonly strategy: StrategyDef,
    private readonly skill: Skill,
    private readonly clock: Clock,
    private readonly runnerId: string,
  ) {}

  async runOnce(): Promise<RunResult> {
    const claimed = await this.repos.jobs.claimNextPending(this.runnerId);
    if (!claimed) return { kind: "idle" };

    const startedAt = this.clock.now();
    const jobDef = this.strategy.jobs[claimed.jobType];
    if (!jobDef) {
      return this.fail(claimed, startedAt, `no jobDef for job type "${claimed.jobType}"`);
    }

    let envelope;
    try {
      envelope = await this.skill(claimed.jobType, {
        jobId: claimed.id,
        inlineInputs: claimed.inlineInputs,
        inputRefs: claimed.inputRefs,
      });
    } catch (err) {
      return this.fail(claimed, startedAt, `skill threw: ${String(err)}`);
    }

    const result = validateEnvelope(envelope, jobDef.outputSchema);
    if (!result.ok) {
      return this.fail(claimed, startedAt, `envelope shape invalid: ${result.errors}`);
    }

    const succeeded: Job = {
      ...claimed,
      status: "succeeded",
      envelope,
      startedAt,
      endedAt: this.clock.now(),
    };
    await this.repos.jobs.update(succeeded);
    return { kind: "finished", job: succeeded };
  }

  private async fail(job: Job, startedAt: string, reason: string): Promise<RunResult> {
    // F9 lesson: never swallow the failure cause silently. M0 has no per-job error
    // column, so surface the reason to the runner log at minimum.
    console.error(`[runner] job ${job.id} (${job.jobType}) failed: ${reason}`);
    const failed: Job = {
      ...job,
      status: "failed",
      startedAt,
      endedAt: this.clock.now(),
    };
    await this.repos.jobs.update(failed);
    return { kind: "failed", job: failed, reason };
  }
}
