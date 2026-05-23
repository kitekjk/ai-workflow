import "dotenv/config";
import {
  assertRunnerPackagesInstalled,
  createFileSystemRunnerPackageResolver,
  defaultRunnerPackageRequirementsForCapabilities,
  runnerPackageRequirementsForJob,
  type RunnerPackageRequirement
} from "./package-resolver";

async function main(): Promise<void> {
  const requirements = requirementsFromEnv(process.env);
  const resolver = createFileSystemRunnerPackageResolver(process.env, { allowInstall: true });
  const resolution = await resolver.prepareRequirements(requirements);

  console.log(JSON.stringify(resolution, null, 2));
  assertRunnerPackagesInstalled(resolution);
}

function requirementsFromEnv(env: NodeJS.ProcessEnv): RunnerPackageRequirement[] {
  const explicit = parseExplicitRequirements(env.LOCAL_RUNNER_REQUIRED_PACKAGES);

  if (explicit.length > 0) {
    return explicit;
  }

  return defaultRunnerPackageRequirementsForCapabilities(parseList(env.LOCAL_RUNNER_CAPABILITIES));
}

function parseExplicitRequirements(value: string | undefined): RunnerPackageRequirement[] {
  if (!value) {
    return [];
  }

  return runnerPackageRequirementsForJob({
    id: "package-prepare",
    runId: "package-prepare",
    jobType: "package.prepare",
    status: "pending",
    input: {
      requiredRunnerPackages: parseList(value).map((item) => {
        const [packageSpec, installSource] = splitOnce(item, "=");
        const [type, idAndVersion] = packageSpec.includes(":") ? packageSpec.split(":", 2) : ["skill", packageSpec];
        const [id, version] = idAndVersion.split("@", 2);

        return {
          type,
          id,
          version,
          installSource
        };
      })
    },
    priority: 0,
    requiredCapabilities: [],
    executionPolicy: "local_allowed",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);

  if (index < 0) {
    return [value, undefined];
  }

  return [value.slice(0, index), value.slice(index + separator.length)];
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
