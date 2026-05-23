import type { createPrdConfirmationFixture } from "../legacy/prd-confirmation/fixture";
import {
  createGenericPrdSnapshot,
  type GenericPrdSnapshot
} from "../legacy/prd-confirmation/generic-adapter";
import {
  MysqlPrdSnapshotLoader,
  type PrdSnapshotLoadResult
} from "../legacy/prd-confirmation/mysql-snapshot-loader";
import type { PrdSnapshotMirror } from "../legacy/prd-confirmation/mysql-snapshot-mirror";
import { MysqlPrdSnapshotMirror } from "../legacy/prd-confirmation/mysql-snapshot-mirror";
import { runRunnerWorkerOnce } from "../legacy/prd-confirmation/runner-worker";
import { runSchedulerOnce } from "../legacy/prd-confirmation/scheduler";
import {
  runEngineStep,
  type WorkflowEngineStepResult
} from "../legacy/prd-confirmation/workflow-engine";
import type { MysqlDatabase } from "../workflow-core/mysql-repository";
import { workflowCompatibilityDisabledMessage } from "./compatibility-actions";
export {
  createLegacyPrdEngineTransitionCommandInput,
  legacyPrdWorkflowJobCommandInputForFixtureJob
} from "./legacy-prd-engine-transition-projection";

export type LegacyPrdFixture = ReturnType<typeof createPrdConfirmationFixture>;
export type LegacyPrdSnapshot = GenericPrdSnapshot;
export type LegacyPrdSnapshotMirror = PrdSnapshotMirror;
export type LegacyPrdSnapshotLoadResult = PrdSnapshotLoadResult;
export type LegacyWorkflowEngineStepResult = WorkflowEngineStepResult;

export interface LegacyPrdTickResult {
  schedulerProgressed: boolean;
  runnerProgressed: boolean;
  engineStep: WorkflowEngineStepResult;
  progressed: boolean;
}

export interface LegacyPrdSnapshotPersistence {
  snapshotMirror: LegacyPrdSnapshotMirror;
  restorePrdSnapshot(): Promise<LegacyPrdSnapshotLoadResult>;
}

export interface LegacyPrdCompatibility {
  fixture: LegacyPrdFixture;
  snapshotMirror?: LegacyPrdSnapshotMirror;
}

export const legacyPrdFixtureDisabledMessage = workflowCompatibilityDisabledMessage;

export function createLegacyPrdCompatibility(input: {
  fixture?: LegacyPrdFixture;
  snapshotMirror?: LegacyPrdSnapshotMirror;
}): LegacyPrdCompatibility | undefined {
  return input.fixture
    ? {
        fixture: input.fixture,
        snapshotMirror: input.snapshotMirror
      }
    : undefined;
}

export function createLegacyPrdSnapshot(store: LegacyPrdFixture["store"]): GenericPrdSnapshot {
  return createGenericPrdSnapshot(store);
}

export function createLegacyPrdSnapshotPersistence(
  database: MysqlDatabase,
  fixture: LegacyPrdFixture
): LegacyPrdSnapshotPersistence {
  const snapshotLoader = new MysqlPrdSnapshotLoader(database);

  return {
    snapshotMirror: new MysqlPrdSnapshotMirror(database),
    restorePrdSnapshot: () => snapshotLoader.loadInto(fixture.store)
  };
}

export async function runLegacyPrdTick(fixture: LegacyPrdFixture): Promise<LegacyPrdTickResult> {
  const schedulerProgressed = await runSchedulerOnce(fixture.store);
  const runnerProgressed = await runRunnerWorkerOnce(fixture.store, fixture.skills);
  const engineStep = await runEngineStep(fixture.store);

  return {
    schedulerProgressed,
    runnerProgressed,
    engineStep,
    progressed: schedulerProgressed || runnerProgressed || engineStep.progressed
  };
}

export function setLegacyPrdQuality(
  fixture: LegacyPrdFixture,
  qualityPasses: boolean
): { qualityPasses: boolean } {
  fixture.skills.qualityPasses = qualityPasses;
  return { qualityPasses: fixture.skills.qualityPasses };
}
