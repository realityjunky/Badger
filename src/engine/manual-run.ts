import { randomUUID } from "crypto";
import { evaluateRuntime } from "./evals.js";
import {
  decideWithResolver,
  recordOutcomeWithResolver,
  startRun,
} from "./loop.js";
import {
  staticDeterministicResolver,
  type DeterministicResolver,
} from "./resolver.js";
import {
  appendTrajectory,
  clearPendingAction,
  readArtifacts,
  readPendingAction,
  readTrajectory,
  writeArtifacts,
  writePendingAction,
} from "./run-store.js";
import { readRunState, writeRunState } from "./state.js";
import type {
  ActionOutcome,
  EngineAction,
  EvalResult,
  RunState,
  RuntimeIdentity,
  TrajectoryEvent,
  WorkflowRuntimeState,
} from "./types.js";
import {
  createSkillSnapshot,
  readSkillSnapshot,
} from "../skill-runtime/snapshot.js";
import type {
  RuntimeEvalDefinition,
  SkillPackage,
} from "../skill-runtime/types.js";
import { validateSkillPackage } from "../skill-runtime/validate.js";

export interface ManualRunResult {
  state: RunState;
  action: EngineAction | null;
  evals: EvalResult[];
  reason?: string;
}

export interface StartManualRunOptions {
  confirmations?: Iterable<string>;
  runId?: string;
  runtimeIdentity?: RuntimeIdentity;
  workflowRuntime?: WorkflowRuntimeState;
  resolver?: DeterministicResolver<undefined>;
}

export interface ResumeManualRunOptions {
  outcome?: Omit<ActionOutcome, "actionId"> & { actionId?: string };
  confirmations?: Iterable<string>;
  resolver?: DeterministicResolver<undefined>;
}

export interface ManualRunEvaluation {
  state: RunState;
  scope: RuntimeEvalDefinition["scope"];
  evals: EvalResult[];
}

export interface ManualRunUpgrade {
  state: RunState;
  changed: boolean;
}

async function existingRun(changeDir: string): Promise<RunState | null> {
  try {
    return await readRunState(changeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function requiredRun(changeDir: string): Promise<RunState> {
  const state = await existingRun(changeDir);
  if (!state) throw new Error(`No Comet Run found in: ${changeDir}`);
  return state;
}

function validateStringRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw new Error(`${label} values must be strings`);
    }
  }
}

function validateEvidenceRecord(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable`, { cause: error });
  }
}

function validateOutcome(outcome: ResumeManualRunOptions["outcome"]): void {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("Outcome must be an object");
  }
  if (outcome.actionId !== undefined && typeof outcome.actionId !== "string") {
    throw new Error("Outcome actionId must be a string");
  }
  if (outcome.status !== "succeeded" && outcome.status !== "failed") {
    throw new Error("Outcome status must be succeeded or failed");
  }
  if (typeof outcome.summary !== "string" || outcome.summary.length === 0) {
    throw new Error("Outcome summary must be a non-empty string");
  }
  validateStringRecord(outcome.artifacts, "Outcome artifacts");
  validateStringRecord(outcome.state, "Outcome state");
  validateStringRecord(outcome.routing, "Outcome routing");
  validateEvidenceRecord(outcome.evidence, "Outcome evidence");
}

function validatePendingState(
  state: RunState,
  pending: EngineAction | null,
): void {
  if (pending) {
    if (!state.pending || state.pending !== pending.id) {
      throw new Error("Pending action file does not match Run state");
    }
    if (state.status !== "waiting") {
      throw new Error(
        `Run state cannot have a pending action while status is ${state.status}`,
      );
    }
    return;
  }
  if (state.pending || state.status === "waiting") {
    throw new Error("Run state references a missing pending action");
  }
}

function validateSnapshotState(pkg: SkillPackage, state: RunState): void {
  if (
    pkg.definition.metadata.name !== state.skill ||
    pkg.definition.metadata.version !== state.skillVersion ||
    pkg.definition.orchestration.mode !== state.orchestration
  ) {
    throw new Error("Run state does not match Skill snapshot");
  }
}

async function appendEvent(
  changeDir: string,
  state: RunState,
  type: TrajectoryEvent["type"],
  data: Record<string, unknown>,
): Promise<void> {
  const trajectory = await readTrajectory(changeDir, state.trajectoryRef);
  await appendTrajectory(changeDir, state.trajectoryRef, {
    sequence: trajectory.length + 1,
    timestamp: new Date().toISOString(),
    type,
    runId: state.runId,
    data,
  });
}

async function persistDecision(
  changeDir: string,
  state: RunState,
  pkg: SkillPackage,
  confirmations: Iterable<string>,
  resolver: DeterministicResolver<undefined> = staticDeterministicResolver,
): Promise<ManualRunResult> {
  const decision = decideWithResolver(
    pkg,
    state,
    new Set(confirmations),
    resolver,
    undefined,
  );
  if (decision.action) {
    await writePendingAction(
      changeDir,
      decision.state.pendingRef,
      decision.action,
    );
  }
  await writeRunState(changeDir, decision.state);
  if (decision.action) {
    await appendEvent(changeDir, decision.state, "action_proposed", {
      action: decision.action,
    });
  }
  return {
    state: decision.state,
    action: decision.action,
    evals: [],
    reason: decision.reason,
  };
}

async function evaluateAndRecord(
  changeDir: string,
  pkg: SkillPackage,
  state: RunState,
  scope: RuntimeEvalDefinition["scope"],
  artifacts: Record<string, string>,
): Promise<EvalResult[]> {
  const results = evaluateRuntime(pkg.evals, scope, state, artifacts);
  if (results.length > 0) {
    await appendEvent(changeDir, state, "eval_completed", { scope, results });
  }
  return results;
}

function normalizeStartOptions(
  value: Iterable<string> | StartManualRunOptions,
): StartManualRunOptions {
  if (
    value &&
    typeof value === "object" &&
    ("confirmations" in value ||
      "runId" in value ||
      "runtimeIdentity" in value ||
      "workflowRuntime" in value ||
      "resolver" in value)
  ) {
    return value;
  }
  return { confirmations: value as Iterable<string> };
}

export async function startManualRun(
  pkg: SkillPackage,
  changeDir: string,
  options: Iterable<string> | StartManualRunOptions = [],
): Promise<ManualRunResult> {
  const startOptions = normalizeStartOptions(options);
  if (pkg.definition.orchestration.mode === "adaptive") {
    throw new Error("Adaptive orchestration requires an Agent candidate");
  }
  if (await existingRun(changeDir)) {
    throw new Error(`A Comet Run already exists in: ${changeDir}`);
  }

  const snapshot = await createSkillSnapshot(pkg, changeDir);
  if (
    startOptions.runtimeIdentity &&
    (startOptions.runtimeIdentity.snapshotHash !== snapshot.hash ||
      startOptions.runtimeIdentity.packageHash !== snapshot.hash)
  ) {
    throw new Error("Runtime identity hashes do not match the Skill snapshot");
  }
  const state = startRun(
    pkg,
    startOptions.runId ?? randomUUID(),
    snapshot.hash,
    startOptions.workflowRuntime,
  );
  if (startOptions.runtimeIdentity) {
    state.runtimeIdentity = structuredClone(startOptions.runtimeIdentity);
  }
  await writeRunState(changeDir, state);
  await appendEvent(changeDir, state, "run_started", {
    skill: state.skill,
    skillVersion: state.skillVersion,
    skillHash: state.skillHash,
    ...(state.runtimeIdentity
      ? { runtimeIdentity: structuredClone(state.runtimeIdentity) }
      : {}),
  });
  return persistDecision(
    changeDir,
    state,
    pkg,
    startOptions.confirmations ?? [],
    startOptions.resolver,
  );
}

export async function resumeManualRun(
  changeDir: string,
  options: ResumeManualRunOptions = {},
): Promise<ManualRunResult> {
  const state = await requiredRun(changeDir);
  const pkg = await readSkillSnapshot(changeDir, state.skillHash);
  validateSnapshotState(pkg, state);
  if (pkg.definition.orchestration.mode === "adaptive") {
    throw new Error("Adaptive orchestration requires an Agent candidate");
  }
  const resolver = options.resolver ?? staticDeterministicResolver;

  const pending = await readPendingAction(changeDir, state.pendingRef);
  if (!options.outcome) {
    validatePendingState(state, pending);
    if (pending) {
      return { state, action: pending, evals: [] };
    }
    if (state.status !== "running") {
      return {
        state,
        action: null,
        evals: [],
        reason: `Run is ${state.status}`,
      };
    }
    return persistDecision(
      changeDir,
      state,
      pkg,
      options.confirmations ?? [],
      resolver,
    );
  }

  if (!pending || !state.pending) {
    throw new Error("No pending action accepts an outcome");
  }
  if (state.pending !== pending.id) {
    throw new Error("Pending action file does not match Run state");
  }
  validatePendingState(state, pending);

  validateOutcome(options.outcome);
  if (
    options.outcome.actionId !== undefined &&
    options.outcome.actionId !== pending.id
  ) {
    throw new Error(
      `Outcome does not match pending action: ${options.outcome.actionId}`,
    );
  }
  const outcome: ActionOutcome = { ...options.outcome, actionId: pending.id };
  const advanced = recordOutcomeWithResolver(
    pkg,
    state,
    outcome,
    resolver,
    undefined,
  );
  const artifacts = {
    ...(await readArtifacts(changeDir, state.artifactsRef)),
    ...(outcome.artifacts ?? {}),
  };
  await writeArtifacts(changeDir, state.artifactsRef, artifacts);
  await appendEvent(changeDir, state, "action_completed", {
    action: pending,
    outcome,
  });

  await clearPendingAction(changeDir, advanced.pendingRef);
  await writeRunState(changeDir, advanced);

  const evals = await evaluateAndRecord(
    changeDir,
    pkg,
    advanced,
    "step",
    artifacts,
  );
  if (advanced.status === "completed") {
    evals.push(
      ...(await evaluateAndRecord(
        changeDir,
        pkg,
        advanced,
        "completion",
        artifacts,
      )),
    );
    return { state: advanced, action: null, evals };
  }
  if (advanced.status !== "running") {
    return {
      state: advanced,
      action: null,
      evals,
      reason: `Run is ${advanced.status}`,
    };
  }

  const next = await persistDecision(
    changeDir,
    advanced,
    pkg,
    options.confirmations ?? [],
    resolver,
  );
  return { ...next, evals };
}

export async function evaluateManualRun(
  changeDir: string,
  scope: RuntimeEvalDefinition["scope"],
): Promise<ManualRunEvaluation> {
  const state = await requiredRun(changeDir);
  const pkg = await readSkillSnapshot(changeDir, state.skillHash);
  validateSnapshotState(pkg, state);
  const artifacts = await readArtifacts(changeDir, state.artifactsRef);
  return {
    state,
    scope,
    evals: evaluateRuntime(pkg.evals, scope, state, artifacts),
  };
}

export async function upgradeManualRun(
  changeDir: string,
  pkg: SkillPackage,
): Promise<ManualRunUpgrade> {
  const errors = validateSkillPackage(pkg);
  if (errors.length > 0) {
    throw new Error(
      `Invalid replacement Skill:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
    );
  }

  const state = await requiredRun(changeDir);
  const current = await readSkillSnapshot(changeDir, state.skillHash);
  validateSnapshotState(current, state);
  const pending = await readPendingAction(changeDir, state.pendingRef);
  if (state.pending || pending || state.status === "waiting") {
    throw new Error("Cannot upgrade while an action is pending");
  }
  if (pkg.definition.metadata.name !== current.definition.metadata.name) {
    throw new Error(
      `Skill name is incompatible: ${current.definition.metadata.name} -> ${pkg.definition.metadata.name}`,
    );
  }
  if (
    pkg.definition.orchestration.mode !== current.definition.orchestration.mode
  ) {
    throw new Error(
      `Orchestration mode is incompatible: ${current.definition.orchestration.mode} -> ${pkg.definition.orchestration.mode}`,
    );
  }
  if (
    state.currentStep !== null &&
    !pkg.definition.orchestration.steps?.some(
      (step) => step.id === state.currentStep,
    )
  ) {
    throw new Error(
      `Current step is missing from replacement Skill: ${state.currentStep}`,
    );
  }

  const snapshot = await createSkillSnapshot(pkg, changeDir);
  if (snapshot.hash === state.skillHash) return { state, changed: false };

  const upgraded: RunState = {
    ...state,
    skillVersion: pkg.definition.metadata.version,
    skillHash: snapshot.hash,
  };
  await writeRunState(changeDir, upgraded);
  await appendEvent(changeDir, upgraded, "state_migrated", {
    kind: "manual-skill-upgrade",
    fromVersion: state.skillVersion,
    toVersion: upgraded.skillVersion,
    fromHash: state.skillHash,
    toHash: upgraded.skillHash,
  });
  return { state: upgraded, changed: true };
}
