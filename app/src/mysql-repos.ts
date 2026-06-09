import type { Db } from "./db";
import { fromMysqlDatetime, safeLimit, toMysqlDatetime } from "./db";
import type {
  Envelope,
  Job,
  JobStatus,
  Ref,
  RunStatus,
  Task,
  WorkflowRun,
} from "./domain";
import type { JobRepo, Repos, RunRepo, TaskRepo } from "./repos";
import type { RowDataPacket } from "mysql2";

const j = (v: unknown): string => JSON.stringify(v);
const p = <T>(v: unknown, fallback: T): T =>
  typeof v === "string" && v.length > 0 ? (JSON.parse(v) as T) : fallback;

export class MysqlRepos implements Repos {
  constructor(private readonly db: Db) {}

  runs: RunRepo = {
    create: async (r: WorkflowRun) => {
      await this.db.execute(
        `INSERT INTO workflow_run (id, definition_version, source_request_ref, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          r.id,
          r.definitionVersion,
          r.sourceRequestRef,
          r.status,
          toMysqlDatetime(r.createdAt),
          toMysqlDatetime(r.completedAt),
        ],
      );
    },
    get: async (id) => {
      const rows = await this.db.query<RowDataPacket>(
        `SELECT * FROM workflow_run WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        definitionVersion: row.definition_version,
        sourceRequestRef: row.source_request_ref,
        status: row.status as RunStatus,
        createdAt: fromMysqlDatetime(row.created_at)!,
        completedAt: fromMysqlDatetime(row.completed_at),
      };
    },
    setStatus: async (id, status, completedAt) => {
      await this.db.execute(
        `UPDATE workflow_run SET status = ?, completed_at = ? WHERE id = ?`,
        [status, toMysqlDatetime(completedAt), id],
      );
    },
  };

  tasks: TaskRepo = {
    create: async (t: Task) => {
      await this.db.execute(
        `INSERT INTO task (id, run_id, parent_task_id, type, jira_key, assignee_email, status, refs, created_at, terminated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id,
          t.runId,
          t.parentTaskId,
          t.type,
          t.jiraKey,
          t.assigneeEmail,
          t.status,
          j(t.refs),
          toMysqlDatetime(t.createdAt),
          toMysqlDatetime(t.terminatedAt),
        ],
      );
    },
    get: async (id) => this.mapTask(await this.firstTask(`WHERE id = ?`, [id])),
    getByJiraKey: async (jiraKey) =>
      this.mapTask(await this.firstTask(`WHERE jira_key = ? ORDER BY created_at DESC LIMIT ${safeLimit(1)}`, [jiraKey])),
    update: async (t: Task) => {
      await this.db.execute(
        `UPDATE task SET status = ?, refs = ?, terminated_at = ? WHERE id = ?`,
        [t.status, j(t.refs), toMysqlDatetime(t.terminatedAt), t.id],
      );
    },
  };

  jobs: JobRepo = {
    create: async (job: Job) => {
      await this.db.execute(
        `INSERT INTO job (id, task_id, job_type, inline_inputs, input_refs, status, envelope, runner_id, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.taskId,
          job.jobType,
          j(job.inlineInputs),
          j(job.inputRefs),
          job.status,
          job.envelope ? j(job.envelope) : null,
          job.runnerId,
          toMysqlDatetime(job.startedAt),
          toMysqlDatetime(job.endedAt),
        ],
      );
    },
    get: async (id) => this.mapJob(await this.firstJob(`WHERE id = ?`, [id])),
    claimNextPending: async (runnerId) => {
      // M0 SINGLE-RUNNER ONLY. Two caveats that are safe now but unsafe to scale:
      //  (1) Not FIFO: `id` is a random UUID, so order among pending jobs is arbitrary
      //      (M0 never has >1 pending job per run, so it never manifests). Multi-job
      //      ordering needs a monotonic insertion column (e.g. AUTO_INCREMENT seq).
      //  (2) Not atomic: SELECT-then-UPDATE is a race. The UPDATE is guarded by
      //      `status = 'pending'` but we don't check affectedRows, so under concurrent
      //      runners this could return a job another runner won. Add an affectedRows
      //      check (return null on 0) before introducing a second runner.
      const rows = await this.db.query<RowDataPacket>(
        `SELECT * FROM job WHERE status = 'pending' ORDER BY started_at IS NOT NULL, id ASC LIMIT ${safeLimit(1)}`,
      );
      const row = rows[0];
      if (!row) return null;
      await this.db.execute(
        `UPDATE job SET status = 'claimed', runner_id = ? WHERE id = ? AND status = 'pending'`,
        [runnerId, row.id],
      );
      const claimed = this.mapJob(row);
      return claimed ? { ...claimed, status: "claimed", runnerId } : null;
    },
    update: async (job: Job) => {
      await this.db.execute(
        `UPDATE job SET status = ?, envelope = ?, runner_id = ?, started_at = ?, ended_at = ? WHERE id = ?`,
        [
          job.status,
          job.envelope ? j(job.envelope) : null,
          job.runnerId,
          toMysqlDatetime(job.startedAt),
          toMysqlDatetime(job.endedAt),
          job.id,
        ],
      );
    },
  };

  private async firstTask(where: string, params: unknown[]): Promise<RowDataPacket | undefined> {
    const rows = await this.db.query<RowDataPacket>(`SELECT * FROM task ${where}`, params);
    return rows[0];
  }
  private async firstJob(where: string, params: unknown[]): Promise<RowDataPacket | undefined> {
    const rows = await this.db.query<RowDataPacket>(`SELECT * FROM job ${where}`, params);
    return rows[0];
  }

  private mapTask(row?: RowDataPacket): Task | null {
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      parentTaskId: row.parent_task_id,
      type: row.type,
      jiraKey: row.jira_key,
      assigneeEmail: row.assignee_email,
      status: row.status,
      refs: p<Ref[]>(row.refs, []),
      createdAt: fromMysqlDatetime(row.created_at)!,
      terminatedAt: fromMysqlDatetime(row.terminated_at),
    };
  }

  private mapJob(row?: RowDataPacket): Job | null {
    if (!row) return null;
    return {
      id: row.id,
      taskId: row.task_id,
      jobType: row.job_type,
      inlineInputs: p<Record<string, unknown>>(row.inline_inputs, {}),
      inputRefs: p<Ref[]>(row.input_refs, []),
      status: row.status as JobStatus,
      envelope: row.envelope ? p<Envelope>(row.envelope, null as unknown as Envelope) : null,
      runnerId: row.runner_id,
      startedAt: fromMysqlDatetime(row.started_at),
      endedAt: fromMysqlDatetime(row.ended_at),
    };
  }
}
