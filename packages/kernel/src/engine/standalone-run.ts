import { promises as fs } from "node:fs";
import path from "path";
import {
  evaluateManualRun,
  resumeManualRun,
  resumeManualWorkflowRun,
  startManualRun,
  upgradeManualRun,
  type ManualRunEvaluation,
  type PreparePendingAction,
  type ManualRunResult,
  type ManualRunUpgrade,
  type ResumeManualRunOptions,
} from "./manual-run.js";
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
} from "./protected-project-path.js";
import { readRunState } from "./state.js";
import type { RuntimeEvalDefinition } from "../skill-runtime/types.js";
import type { SkillPackage } from "../skill-runtime/types.js";
import type { RunState, RuntimeIdentity } from "./types.js";
import type { WorkflowArtifactMutation } from "./runtime-types.js";
import type { WorkflowRuntimeState } from "./types.js";
import type { DeterministicResolver } from "./resolver.js";

export interface StartStandaloneRunOptions {
  projectRoot: string;
  runId: string;
  confirmations?: Iterable<string>;
  runtimeIdentity?: RuntimeIdentity;
  workflowRuntime?: WorkflowRuntimeState;
  resolver?: DeterministicResolver<undefined>;
  prepareAction?: PreparePendingAction;
}

function validateRunId(runId: unknown): asserts runId is string {
  if (
    typeof runId !== "string" ||
    runId.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId) ||
    runId.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(runId)
  ) {
    throw new Error(`Invalid standalone Run id: ${String(runId)}`);
  }
}

function validateProjectRoot(
  projectRoot: unknown,
): asserts projectRoot is string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error(`Invalid standalone project root: ${String(projectRoot)}`);
  }
}

export function standaloneRunDir(projectRoot: string, runId: string): string {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  return path.resolve(projectRoot, ".badger", "runs", runId);
}

function pathSegments(projectRoot: string): string[] {
  const lexicalRoot = path.resolve(projectRoot);
  const root = path.parse(lexicalRoot).root;
  const relative = path.relative(root, lexicalRoot);
  return relative.length === 0 ? [] : relative.split(path.sep);
}

function runRootRelativePath(projectRoot: string, runRoot: string): string {
  return path.relative(projectRoot, runRoot).replaceAll("\\", "/");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolveStandaloneProjectRoot(
  projectRoot: string,
  createMissing: boolean,
): Promise<string> {
  validateProjectRoot(projectRoot);
  const lexicalRoot = path.resolve(projectRoot);
  let cursor = path.parse(lexicalRoot).root;
  for (const segment of pathSegments(lexicalRoot)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!createMissing) return lexicalRoot;
      try {
        await fs.mkdir(cursor);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      stat = await fs.lstat(cursor);
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Standalone project root cannot cross a symbolic link");
    }
    if (!stat.isDirectory()) {
      throw new Error("Standalone project root must be a real directory");
    }
  }
  return lexicalRoot;
}

export async function ensureStandaloneRunDir(
  projectRoot: string,
  runId: string,
): Promise<string> {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  const validatedRoot = await resolveStandaloneProjectRoot(projectRoot, true);
  const runDir = standaloneRunDir(validatedRoot, runId);
  await ensureProtectedProjectDirectory(
    validatedRoot,
    runRootRelativePath(validatedRoot, runDir),
    { label: "Standalone Run root" },
  );
  return runDir;
}

async function checkedStandaloneRunDir(
  projectRoot: string,
  runId: string,
  options: { allowMalformedState?: boolean } = {},
): Promise<string> {
  validateRunId(runId);
  validateProjectRoot(projectRoot);
  const validatedRoot = await resolveStandaloneProjectRoot(projectRoot, false);
  const runDir = standaloneRunDir(validatedRoot, runId);
  await inspectProtectedProjectPath(
    validatedRoot,
    runRootRelativePath(validatedRoot, runDir),
    { label: "Standalone Run root", expected: "directory" },
  );
  let state: RunState | null;
  try {
    state = await readRunState(runDir);
  } catch (error) {
    if (!options.allowMalformedState) throw error;
    state = null;
  }
  if (state && state.runId !== runId) {
    throw new Error(
      `Standalone Run state does not match requested Run id: ${runId}`,
    );
  }
  return runDir;
}

export async function readStandaloneRunState(
  projectRoot: string,
  runId: string,
  options: { allowMalformedState?: boolean } = {},
): Promise<RunState | null> {
  const runDir = await checkedStandaloneRunDir(projectRoot, runId, options);
  try {
    return await readRunState(runDir);
  } catch (error) {
    if (!options.allowMalformedState) throw error;
    return null;
  }
}

export async function startStandaloneRun(
  pkg: SkillPackage,
  options: StartStandaloneRunOptions,
): Promise<ManualRunResult> {
  const runDir = await ensureStandaloneRunDir(
    options.projectRoot,
    options.runId,
  );
  return startManualRun(pkg, runDir, {
    runId: options.runId,
    confirmations: options.confirmations ?? [],
    runtimeIdentity: options.runtimeIdentity,
    workflowRuntime: options.workflowRuntime,
    resolver: options.resolver,
    prepareAction: options.prepareAction,
  });
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

export async function resumeStandaloneWorkflowRun(
  projectRoot: string,
  runId: string,
  options: ResumeManualRunOptions,
  artifactMutation: WorkflowArtifactMutation,
): Promise<ManualRunResult> {
  return resumeManualWorkflowRun(
    await checkedStandaloneRunDir(projectRoot, runId),
    options,
    artifactMutation,
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
