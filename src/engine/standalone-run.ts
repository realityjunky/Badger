import path from "path";
import {
  evaluateManualRun,
  resumeManualRun,
  startManualRun,
  upgradeManualRun,
  type ManualRunEvaluation,
  type ManualRunResult,
  type ManualRunUpgrade,
  type ResumeManualRunOptions,
} from "./manual-run.js";
import { readRunState } from "./state.js";
import type {
  RuntimeEvalDefinition,
  SkillPackage,
} from "../skill-runtime/types.js";

export interface StartStandaloneRunOptions {
  projectRoot: string;
  runId: string;
  confirmations?: Iterable<string>;
}

function validateRunId(runId: unknown): asserts runId is string {
  if (
    typeof runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)
  ) {
    throw new Error(`Invalid standalone Run id: ${String(runId)}`);
  }
}

export function standaloneRunDir(projectRoot: string, runId: string): string {
  validateRunId(runId);
  return path.resolve(projectRoot, ".comet", "runs", runId);
}

async function checkedStandaloneRunDir(
  projectRoot: string,
  runId: string,
): Promise<string> {
  const runDir = standaloneRunDir(projectRoot, runId);
  const state = await readRunState(runDir);
  if (state && state.runId !== runId) {
    throw new Error(
      `Standalone Run state does not match requested Run id: ${runId}`,
    );
  }
  return runDir;
}

export async function startStandaloneRun(
  pkg: SkillPackage,
  options: StartStandaloneRunOptions,
): Promise<ManualRunResult> {
  return startManualRun(
    pkg,
    standaloneRunDir(options.projectRoot, options.runId),
    {
      runId: options.runId,
      confirmations: options.confirmations ?? [],
    },
  );
}

export async function resumeStandaloneRun(
  projectRoot: string,
  runId: string,
  options: ResumeManualRunOptions = {},
): Promise<ManualRunResult> {
  return resumeManualRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    options,
  );
}

export async function evaluateStandaloneRun(
  projectRoot: string,
  runId: string,
  scope: RuntimeEvalDefinition["scope"],
): Promise<ManualRunEvaluation> {
  return evaluateManualRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    scope,
  );
}

export async function upgradeStandaloneRun(
  projectRoot: string,
  runId: string,
  pkg: SkillPackage,
): Promise<ManualRunUpgrade> {
  return upgradeManualRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    pkg,
  );
}
