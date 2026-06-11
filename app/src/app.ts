import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { systemClock } from "./clock";
import { mysqlConfigFromEnv } from "./config";
import { Db } from "./db";
import { MysqlRepos } from "./mysql-repos";
import { defaultRegistry } from "./registry";
import { loadStrategy } from "./strategy";
import { Runner } from "./runner";
import { stubSkill } from "./stub-skill";
import { engineConfigFromEnv, makeClaudeSkill } from "./cli-engine";
import { normalizeJiraWebhook, RecordingOutbound } from "./jira";
import { Reactor } from "./reactor";

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function buildReactor(): Promise<{ reactor: Reactor; common: ReturnType<typeof loadStrategy>["common"]; db: Db }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const defs = join(here, "../workflows/definitions/");
  const { strategy, common } = loadStrategy(defs, "prd");
  const db = Db.fromConfig(mysqlConfigFromEnv());
  const repos = new MysqlRepos(db);
  const outbound = new RecordingOutbound(); // M0: real Jira client is M0+
  const skill =
    process.env.SKILL_ENGINE === "claude"
      ? makeClaudeSkill(strategy, engineConfigFromEnv())
      : stubSkill; // default: stub (safe for tests and dry runs)
  const runner = new Runner(repos, strategy, skill, systemClock, "local-runner");
  const reactor = new Reactor({
    repos,
    registry: defaultRegistry(),
    strategy,
    common,
    outbound,
    runner,
    clock: systemClock,
    definitionVersion: process.env.DEFINITION_VERSION ?? "dev",
  });
  return { reactor, common, db };
}

async function main(): Promise<void> {
  const { reactor, common } = await buildReactor();
  const port = Number(process.env.PORT ?? "8787");

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/jira/webhook") {
      res.writeHead(404).end();
      return;
    }
    void (async () => {
      try {
        const payload = JSON.parse(await readBody(req));
        const evt = normalizeJiraWebhook(payload, common.trigger.newRunStatus);
        if (evt.kind === "new_run") {
          await reactor.startRun(evt.jiraKey);
          await reactor.drain();
        } else if (evt.kind === "transition") {
          await reactor.onExternalEvent(evt.jiraKey, evt.transition);
          await reactor.drain();
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ handled: evt.kind }),
        );
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    })();
  });

  server.listen(port, () => {
    console.log(`workflow-app M0 listening on :${port} (POST /jira/webhook)`);
  });
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
