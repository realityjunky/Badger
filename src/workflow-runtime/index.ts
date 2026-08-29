import path from "node:path";
import { atomicWriteContainedText } from "../engine/contained-atomic-write.js";
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import { normalizeWorkflowRelativePath } from "../engine/project-config.js";
import {
  hashSkillPackage,
  readSkillSnapshot,
} from "../skill-runtime/snapshot.js";
import { type ManualRunResult } from "../engine/manual-run.js";
import { readPendingAction, readTrajectory } from "../engine/run-store.js";
import type { EngineAction, RunState } from "../engine/types.js";
import type { WorkflowProtocol } from "../types.js";
import { stableValue } from "../util.js";
import { compileWorkflow } from "./compiler.js";
import {
  createCompletionPlan,
  validateSuccessfulSubmission,
} from "./completion.js";
import {
  resolveWorkflowRunLocation,
  resolveWorkflowStartLocation,
  type ResolvedWorkflowRunLocation,
} from "./location.js";
import type {
  RecoverWorkflowRunOptions,
  ResumeWorkflowRunOptions,
  StartWorkflowRunOptions,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowHandoff,
  WorkflowRuntime,
  WorkflowRunTarget,
  WorkflowStateProjection,
  WorkflowStateProjectionStatus,
  Submission,
  WorkflowSubmission,
} from "./types.js";

export type {
  ManualWorkflowRunLocation,
  ResumeWorkflowRunOptions,
  RecoverWorkflowRunOptions,
  StartWorkflowRunOptions,
  StandaloneWorkflowRunLocation,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowHandoff,
  WorkflowRunLocation,
  WorkflowRuntime,
  WorkflowRunTarget,
  WorkflowStateProjection,
  WorkflowStateProjectionStatus,
  Submission,
  WorkflowSubmission,
} from "./types.js";

function identityFromState(state: RunState): WorkflowExecutionIdentity {
  if (!state.runtimeIdentity) {
    throw new Error("Run is not a WorkflowRuntime Run");
  }
  return {
    protocolHash: state.runtimeIdentity.protocolHash,
    packageHash: state.runtimeIdentity.packageHash,
    snapshotHash: state.runtimeIdentity.snapshotHash,
    nodeToStep: { ...state.runtimeIdentity.nodeToStep },
  };
}

function currentNode(
  state: RunState,
  identity: WorkflowExecutionIdentity,
  action: { stepId: string | null } | null,
): string | null {
  const step = action?.stepId ?? state.currentStep;
  if (!step) return null;
  return (
    Object.entries(identity.nodeToStep).find(
      ([, stepId]) => stepId === step,
    )?.[0] ?? null
  );
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function sameExecutionIdentity(
  left: WorkflowExecutionIdentity,
  right: WorkflowExecutionIdentity,
): boolean {
  return (
    left.protocolHash === right.protocolHash &&
    left.packageHash === right.packageHash &&
    left.snapshotHash === right.snapshotHash &&
    sameStringRecord(left.nodeToStep, right.nodeToStep)
  );
}

function validateSubmission(submission: WorkflowSubmission): void {
  if (!submission || typeof submission !== "object") {
    throw new Error("Submission must be an object");
  }
  if (typeof submission.actionId !== "string" || !submission.actionId) {
    throw new Error("Submission actionId must be a non-empty string");
  }
  if (
    submission.nodeId !== undefined &&
    submission.nodeId !== null &&
    (typeof submission.nodeId !== "string" || !submission.nodeId)
  ) {
    throw new Error("Submission nodeId must be a non-empty string or null");
  }
  if (submission.status !== "succeeded" && submission.status !== "failed") {
    throw new Error("Submission status must be succeeded or failed");
  }
  if (typeof submission.summary !== "string" || !submission.summary) {
    throw new Error("Submission summary must be a non-empty string");
  }
  for (const [label, value] of [
    ["Submission artifacts", submission.artifacts],
    ["Submission state", submission.state],
  ] as const) {
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    if (Object.values(value).some((item) => typeof item !== "string")) {
      throw new Error(`${label} values must be strings`);
    }
  }
  if (submission.evidence !== undefined) {
    if (
      !submission.evidence ||
      typeof submission.evidence !== "object" ||
      Array.isArray(submission.evidence)
    ) {
      throw new Error("Submission evidence must be an object");
    }
    try {
      JSON.stringify(submission.evidence);
    } catch (error) {
      throw new Error("Submission evidence must be JSON-serializable", {
        cause: error,
      });
    }
  }
}

function continuation(
  result: ManualRunResult,
  identity: WorkflowExecutionIdentity,
): WorkflowContinuation {
  const disposition = result.action
    ? "continue"
    : result.state.status === "completed"
      ? "done"
      : "blocked";
  return {
    disposition,
    runId: result.state.runId,
    currentNode: currentNode(result.state, identity, result.action),
    pendingAction: result.action,
    execution: structuredClone(identity),
    blockers: disposition === "blocked" && result.reason ? [result.reason] : [],
  };
}

const LEGACY_STATE_MAX_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectionStatus(
  state: RunState,
  pending: EngineAction | null,
  maxRetriesPerAction: number,
): Exclude<WorkflowStateProjectionStatus, "not-started"> {
  const retriesExhausted = Object.values(state.retries).some(
    (count) => count > maxRetriesPerAction,
  );
  return state.status === "failed" || (!pending && retriesExhausted)
    ? "blocked"
    : state.status;
}

export async function projectWorkflowState(
  target: WorkflowRunTarget,
): Promise<WorkflowStateProjection | null> {
  const location = resolveWorkflowRunLocation(target);
  const state = await location.readState();
  if (!state) return null;

  const verified = await verifyStoredRun(location);
  const nodeByStep = new Map(
    Object.entries(verified.identity.nodeToStep).map(([nodeId, stepId]) => [
      stepId,
      nodeId,
    ]),
  );
  const completedNodes: string[] = [];
  const evidence: Record<string, Record<string, unknown>> = {};
  const history: WorkflowStateProjection["history"] = [];
  const trajectory = await readTrajectory(
    location.runRoot,
    state.trajectoryRef,
  );

  for (const event of trajectory) {
    if (event.type !== "action_completed") continue;
    if (!isRecord(event.data.action) || !isRecord(event.data.outcome)) continue;
    const stepId = event.data.action.stepId;
    const node =
      typeof stepId === "string" ? nodeByStep.get(stepId) : undefined;
    const outcomeStatus = event.data.outcome.status;
    if (
      !node ||
      (outcomeStatus !== "succeeded" && outcomeStatus !== "failed")
    ) {
      continue;
    }
    history.push({
      event: "outcome-recorded",
      node,
      status: outcomeStatus,
      at: event.timestamp,
    });
    if (outcomeStatus !== "succeeded") continue;
    if (!completedNodes.includes(node)) completedNodes.push(node);
    const outcomeEvidence = event.data.outcome.evidence;
    evidence[node] = isRecord(outcomeEvidence)
      ? structuredClone(outcomeEvidence)
      : {};
  }

  const protocol = verified.package.runtime!.protocol;
  const status = projectionStatus(
    state,
    verified.pending,
    verified.package.guardrails.maxRetriesPerAction,
  );
  const exhaustedAction = Object.entries(state.retries).find(
    ([, count]) => count > verified.package.guardrails.maxRetriesPerAction,
  )?.[0];
  return {
    schemaVersion: 1,
    workflow: protocol.name,
    statePath: protocol.state.statePath,
    status,
    runId: state.runId,
    currentNode: currentNode(state, verified.identity, verified.pending),
    completedNodes,
    evidence,
    history,
    pendingAction: verified.pending,
    execution: structuredClone(verified.identity),
    blockers:
      status === "blocked"
        ? [
            exhaustedAction
              ? `Retry budget exhausted for action: ${exhaustedAction}`
              : `Run is ${state.status}`,
          ]
        : [],
  };
}

export async function writeWorkflowStateProjection(
  target: WorkflowRunTarget,
  projection: WorkflowStateProjection,
): Promise<void> {
  const projectRoot = resolveWorkflowRunLocation(target).runRoot;
  const label = "Workflow state projection";
  const relativePath = normalizeWorkflowRelativePath(
    projection.statePath,
    `${label} path`,
  );
  const content = JSON.stringify(projection, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > LEGACY_STATE_MAX_BYTES) {
    throw new Error(`${label} exceeds ${LEGACY_STATE_MAX_BYTES} bytes`);
  }

  let inspection = await inspectProtectedProjectPath(
    projectRoot,
    relativePath,
    { label, expected: "file" },
  );
  if (inspection.exists) {
    const existing = await readProtectedProjectFile(
      projectRoot,
      relativePath,
      LEGACY_STATE_MAX_BYTES,
      { label },
    );
    if (Buffer.from(existing.bytes).equals(Buffer.from(content))) return;
  }

  const parent = path.posix.dirname(relativePath);
  if (parent !== ".") {
    await ensureProtectedProjectDirectory(projectRoot, parent, { label });
    inspection = await inspectProtectedProjectPath(projectRoot, relativePath, {
      label,
      expected: "file",
    });
  }
  await atomicWriteContainedText(inspection.target, content, {
    containedRoot: inspection.projectRoot,
  });
}

async function verifyStoredPackage(
  runRoot: string,
  state: RunState,
): Promise<{
  identity: WorkflowExecutionIdentity;
  package: Awaited<ReturnType<typeof readSkillSnapshot>>;
}> {
  const identity = identityFromState(state);
  if (identity.snapshotHash !== state.skillHash) {
    throw new Error(
      "WorkflowRuntime snapshot identity does not match Run state",
    );
  }
  const pkg = await readSkillSnapshot(runRoot, state.skillHash);
  if (!pkg.runtime) {
    throw new Error("WorkflowRuntime Skill snapshot has no compiled protocol");
  }
  if (pkg.runtime.protocolHash !== identity.protocolHash) {
    throw new Error(
      "WorkflowRuntime protocol identity does not match Skill snapshot",
    );
  }
  if (!sameStringRecord(pkg.runtime.nodeToStep, identity.nodeToStep)) {
    throw new Error(
      "WorkflowRuntime Node-to-step identity does not match Skill snapshot",
    );
  }
  const packageHash = await hashSkillPackage(pkg);
  if (packageHash !== identity.packageHash) {
    throw new Error(
      "WorkflowRuntime package identity does not match Skill snapshot",
    );
  }
  return { identity, package: pkg };
}

async function verifyStoredRun(location: ResolvedWorkflowRunLocation): Promise<{
  state: RunState;
  identity: WorkflowExecutionIdentity;
  package: Awaited<ReturnType<typeof readSkillSnapshot>>;
  pending: EngineAction | null;
}> {
  const state = await location.readState();
  if (!state) throw new Error(`No Comet Run found in: ${location.runRoot}`);
  const verified = await verifyStoredPackage(location.runRoot, state);
  const pending = await verifyStoredAction(
    location.runRoot,
    state,
    verified.identity,
    verified.package,
  );
  return { state, ...verified, pending };
}

type VerifiedWorkflowRun = Awaited<ReturnType<typeof verifyStoredRun>>;

function continuationFromVerifiedRun(
  verified: VerifiedWorkflowRun,
): WorkflowContinuation {
  return continuation(
    {
      state: verified.state,
      action: verified.pending,
      evals: [],
      ...(verified.pending
        ? {}
        : {
            reason:
              verified.state.status === "running"
                ? "Run has no pending action"
                : `Run is ${verified.state.status}`,
          }),
    },
    verified.identity,
  );
}

export async function inspectWorkflowRun(
  target: WorkflowRunTarget,
): Promise<WorkflowContinuation | null> {
  const location = resolveWorkflowRunLocation(target);
  try {
    if (!(await location.readState())) return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  return continuationFromVerifiedRun(await verifyStoredRun(location));
}

interface PreparedWorkflowSubmission {
  location: ResolvedWorkflowRunLocation;
  verified: VerifiedWorkflowRun;
  pending: EngineAction;
  node: string | null;
}

async function prepareWorkflowSubmission(
  target: WorkflowRunTarget,
  submission: WorkflowSubmission,
): Promise<PreparedWorkflowSubmission> {
  const location = resolveWorkflowRunLocation(target);
  const verified = await verifyStoredRun(location);
  const pending = verified.pending;
  if (
    !pending ||
    !verified.state.pending ||
    verified.state.status !== "waiting"
  ) {
    throw new Error(`Run is ${verified.state.status}`);
  }
  if (submission.actionId !== pending.id) {
    throw new Error(
      `Outcome does not match pending action: ${submission.actionId}`,
    );
  }
  const node = currentNode(verified.state, verified.identity, pending);
  if (submission.nodeId !== undefined && submission.nodeId !== node) {
    throw new Error(
      `Submission Node does not match pending Node: ${submission.nodeId}`,
    );
  }
  return { location, verified, pending, node };
}

async function completionBlockers(
  prepared: PreparedWorkflowSubmission,
  submission: WorkflowSubmission,
): Promise<string[]> {
  if (submission.status !== "succeeded" || !prepared.node) return [];
  const workflowNode = prepared.verified.package.runtime!.protocol.nodes.find(
    (candidate) => candidate.id === prepared.node,
  );
  if (!workflowNode) {
    throw new Error(`WorkflowRuntime Node is missing: ${prepared.node}`);
  }
  const plan =
    prepared.verified.package.runtime!.completionPlans?.[prepared.node] ??
    createCompletionPlan(workflowNode);
  if (
    JSON.stringify(stableValue(plan)) !==
    JSON.stringify(stableValue(createCompletionPlan(workflowNode)))
  ) {
    throw new Error(
      `WorkflowRuntime completion plan does not match Node: ${prepared.node}`,
    );
  }
  return validateSuccessfulSubmission(
    prepared.location.runRoot,
    prepared.verified.package.runtime!.protocol,
    workflowNode,
    plan,
    submission,
  );
}

export async function validateWorkflowSubmission(
  target: WorkflowRunTarget,
  submission: WorkflowSubmission,
): Promise<WorkflowContinuation> {
  validateSubmission(submission);
  const prepared = await prepareWorkflowSubmission(target, submission);
  const blockers = await completionBlockers(prepared, submission);
  if (blockers.length > 0) {
    return {
      disposition: "blocked",
      runId: prepared.verified.state.runId,
      currentNode: prepared.node,
      pendingAction: prepared.pending,
      execution: structuredClone(prepared.verified.identity),
      blockers,
    };
  }
  return continuationFromVerifiedRun(prepared.verified);
}

export async function verifyWorkflowProtocol(
  protocol: WorkflowProtocol,
): Promise<WorkflowExecutionIdentity> {
  const compiled = await compileWorkflow(protocol);
  return {
    ...compiled.identity,
    snapshotHash: compiled.identity.packageHash,
  };
}

export async function projectWorkflowHandoff(
  protocol: WorkflowProtocol,
  current: WorkflowContinuation | null,
): Promise<WorkflowHandoff> {
  const execution = await verifyWorkflowProtocol(protocol);
  if (current && !sameExecutionIdentity(current.execution, execution)) {
    throw new Error(
      "WorkflowRuntime handoff identity does not match generated protocol",
    );
  }
  return {
    schemaVersion: 1,
    workflow: {
      name: protocol.name,
      goal: protocol.goal,
      protocolHash: execution.protocolHash,
    },
    execution,
    nodes: structuredClone(protocol.nodes),
    outputSchemas: structuredClone(protocol.outputSchemas),
    continuation: current ? structuredClone(current) : null,
  };
}

async function resumeStoredRun(
  location: ResolvedWorkflowRunLocation,
  options: ResumeWorkflowRunOptions,
): Promise<WorkflowContinuation> {
  const verified = await verifyStoredRun(location);
  const result = await location.resume({
    confirmations: options.confirmations ?? [],
  });
  return continuation(result, verified.identity);
}

async function verifyStoredAction(
  runRoot: string,
  state: RunState,
  identity: WorkflowExecutionIdentity,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
): Promise<EngineAction | null> {
  const action = await readPendingAction(runRoot, state.pendingRef);
  if (state.status === "waiting") {
    if (!state.pending || !action || action.id !== state.pending) {
      throw new Error(
        "WorkflowRuntime pending action does not match Run state",
      );
    }
    if (action.type === "invoke_skill") {
      if (
        !action.stepId ||
        !Object.values(identity.nodeToStep).includes(action.stepId)
      ) {
        throw new Error(
          "WorkflowRuntime pending action has an unknown workflow step",
        );
      }
      if (state.currentStep !== action.stepId) {
        throw new Error(
          "WorkflowRuntime current Node does not match pending action",
        );
      }
    } else if (action.type !== "checkpoint") {
      throw new Error(
        "WorkflowRuntime pending action is not a compiled action",
      );
    } else if (state.currentStep !== action.stepId) {
      throw new Error(
        "WorkflowRuntime current Node does not match pending action",
      );
    }
    const step = pkg.definition.orchestration.steps?.find(
      (candidate) => candidate.id === action.stepId,
    );
    if (
      !step ||
      step.action.type !== action.type ||
      step.action.ref !== action.ref ||
      step.action.prompt !== action.prompt ||
      step.action.question !== action.question ||
      JSON.stringify(step.action.options) !== JSON.stringify(action.options)
    ) {
      throw new Error(
        "WorkflowRuntime pending action does not match compiled step",
      );
    }
    return action;
  }
  if (action || state.pending) {
    throw new Error("WorkflowRuntime non-waiting Run has a pending action");
  }
  if (state.status === "completed" && state.currentStep !== null) {
    throw new Error("WorkflowRuntime completed Run has a current step");
  }
  if (
    state.status === "running" &&
    (state.currentStep === null ||
      !Object.values(identity.nodeToStep).includes(state.currentStep))
  ) {
    throw new Error(
      "WorkflowRuntime current Node is not in the compiled route",
    );
  }
  return null;
}

export function createWorkflowRuntime(): WorkflowRuntime {
  return {
    async start(
      options: StartWorkflowRunOptions,
    ): Promise<WorkflowContinuation> {
      const resolved = resolveWorkflowStartLocation(options);
      const compiled = await compileWorkflow(options.protocol);
      const result = await resolved.location.start(compiled.package, {
        runId: resolved.runId,
        confirmations: options.confirmations ?? [],
        runtimeIdentity: {
          ...compiled.identity,
          snapshotHash: compiled.identity.packageHash,
        },
      });
      if (result.state.skillHash !== compiled.identity.packageHash) {
        throw new Error("WorkflowRuntime snapshot identity was not persisted");
      }
      return continuation(result, {
        ...compiled.identity,
        snapshotHash: result.state.skillHash,
      });
    },

    async resume(
      target: WorkflowRunTarget,
      options: ResumeWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      const location = resolveWorkflowRunLocation(target);
      return resumeStoredRun(location, options);
    },

    async submit(
      target: WorkflowRunTarget,
      submission: WorkflowSubmission,
    ): Promise<WorkflowContinuation> {
      validateSubmission(submission);
      const prepared = await prepareWorkflowSubmission(target, submission);
      const blockers = await completionBlockers(prepared, submission);
      if (blockers.length > 0) {
        return {
          disposition: "blocked",
          runId: prepared.verified.state.runId,
          currentNode: prepared.node,
          pendingAction: prepared.pending,
          execution: structuredClone(prepared.verified.identity),
          blockers,
        };
      }
      const result = await prepared.location.resume({
        outcome: {
          actionId: submission.actionId,
          status: submission.status,
          summary: submission.summary,
          ...(submission.artifacts ? { artifacts: submission.artifacts } : {}),
          ...(submission.state ? { state: submission.state } : {}),
          ...(submission.evidence ? { evidence: submission.evidence } : {}),
        },
      });
      return continuation(result, prepared.verified.identity);
    },

    async recover(
      target: WorkflowRunTarget,
      options: RecoverWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      const location = resolveWorkflowRunLocation(target);
      return resumeStoredRun(location, options);
    },
  };
}

const defaultRuntime = createWorkflowRuntime();

export const startWorkflowRun = defaultRuntime.start;
export const resumeWorkflowRun = defaultRuntime.resume;
export const submitWorkflowRun = defaultRuntime.submit;
export const recoverWorkflowRun = defaultRuntime.recover;
