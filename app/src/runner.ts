import type { Clock } from "./clock";
import type { Job } from "./domain";
import { validateEnvelope } from "./envelope";
import type { Repos } from "./repos";
import type { Skill } from "./stub-skill";
import type { StrategyDef } from "./strategy";

/**
 * Single local runner (M0). Claims one pending job, invokes the skill, validates the
 * envelope shape, and stores the result. git/wiki/PR writes are the skill's job — the
 * runner only relays the envelope. Returns the finished job on success, null otherwise.
 */
export class Runner {
  constructor(
    private readonly repos: Repos,
    private readonly strategy: StrategyDef,
    private readonly skill: Skill,
    private readonly clock: Clock,
    private readonly runnerId: string,
  ) {}

  async runOnce(): Promise<Job | null> {
    const claimed = await this.repos.jobs.claimNextPending(this.runnerId);
    if (!claimed) return null;

    const startedAt = this.clock.now();
    const jobDef = this.strategy.jobs[claimed.jobType];
    if (!jobDef) {
      return this.fail(claimed, startedAt);
    }

    let envelope;
    try {
      envelope = await this.skill(claimed.jobType, {
        inlineInputs: claimed.inlineInputs,
        inputRefs: claimed.inputRefs,
      });
    } catch {
      return this.fail(claimed, startedAt);
    }

    const result = validateEnvelope(envelope, jobDef.outputSchema);
    if (!result.ok) {
      return this.fail(claimed, startedAt);
    }

    const succeeded: Job = {
      ...claimed,
      status: "succeeded",
      envelope,
      startedAt,
      endedAt: this.clock.now(),
    };
    await this.repos.jobs.update(succeeded);
    return succeeded;
  }

  private async fail(job: Job, startedAt: string): Promise<null> {
    await this.repos.jobs.update({
      ...job,
      status: "failed",
      startedAt,
      endedAt: this.clock.now(),
    });
    return null;
  }
}
