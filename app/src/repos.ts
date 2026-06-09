import type { Job, JobStatus, RunStatus, Task, WorkflowRun } from "./domain";

export interface RunRepo {
  create(run: WorkflowRun): Promise<void>;
  get(id: string): Promise<WorkflowRun | null>;
  setStatus(id: string, status: RunStatus, completedAt: string | null): Promise<void>;
}

export interface TaskRepo {
  create(task: Task): Promise<void>;
  get(id: string): Promise<Task | null>;
  getByJiraKey(jiraKey: string): Promise<Task | null>;
  update(task: Task): Promise<void>;
}

export interface JobRepo {
  create(job: Job): Promise<void>;
  get(id: string): Promise<Job | null>;
  /** Atomically claim the oldest pending job (FIFO by insertion). */
  claimNextPending(runnerId: string): Promise<Job | null>;
  update(job: Job): Promise<void>;
}

export interface Repos {
  runs: RunRepo;
  tasks: TaskRepo;
  jobs: JobRepo;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class InMemoryRepos implements Repos {
  private runMap = new Map<string, WorkflowRun>();
  private taskMap = new Map<string, Task>();
  private jobMap = new Map<string, Job>();
  private jobOrder: string[] = [];

  runs: RunRepo = {
    create: async (run) => {
      this.runMap.set(run.id, clone(run));
    },
    get: async (id) => {
      const r = this.runMap.get(id);
      return r ? clone(r) : null;
    },
    setStatus: async (id, status, completedAt) => {
      const r = this.runMap.get(id);
      if (!r) throw new Error(`run ${id} not found`);
      r.status = status;
      r.completedAt = completedAt;
    },
  };

  tasks: TaskRepo = {
    create: async (task) => {
      this.taskMap.set(task.id, clone(task));
    },
    get: async (id) => {
      const t = this.taskMap.get(id);
      return t ? clone(t) : null;
    },
    getByJiraKey: async (jiraKey) => {
      for (const t of this.taskMap.values()) {
        if (t.jiraKey === jiraKey) return clone(t);
      }
      return null;
    },
    update: async (task) => {
      this.taskMap.set(task.id, clone(task));
    },
  };

  jobs: JobRepo = {
    create: async (job) => {
      this.jobMap.set(job.id, clone(job));
      this.jobOrder.push(job.id);
    },
    get: async (id) => {
      const j = this.jobMap.get(id);
      return j ? clone(j) : null;
    },
    claimNextPending: async (runnerId) => {
      for (const id of this.jobOrder) {
        const j = this.jobMap.get(id);
        if (j && j.status === "pending") {
          j.status = "claimed";
          j.runnerId = runnerId;
          return clone(j);
        }
      }
      return null;
    },
    update: async (job) => {
      this.jobMap.set(job.id, clone(job));
    },
  };
}
