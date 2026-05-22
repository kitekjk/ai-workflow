import "dotenv/config";
import { runLocalRunnerPreflight } from "./preflight";

async function main(): Promise<void> {
  const report = await runLocalRunnerPreflight(process.env);
  console.log(JSON.stringify(report, null, 2));

  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
