import { createHash } from "crypto";
import type {
  ActionOutcome,
  EngineAction,
  RunState,
  WorkflowAttemptState,
  WorkflowCycleTransitionState,
  WorkflowRuntimeState,
  WorkflowVisitOutcome,
} from "./types.js";
import { checkAction } from "./guardrails.js";
import {
  prepareDeterministicStep,
  resolveDeterministicTransition,
  resolveDeterministicStep,
  staticDeterministicResolver,
  type DeterministicResolver,
} from "./resolver.js";
import type { SkillPackage, SkillStep } from "../skill-runtime/types.js";
import type { WorkflowDecisionReceipt } from "../types.js";

export interface Decision {
  state: RunState;
  action: EngineAction | null;
  reason?: string;
}

function actionId(
  runId: string,
  iteration: number,
  stepId: string | null,
  attempt: WorkflowAttemptState | null,
): string {
  const context = attempt
    ? `${runId}:${iteration}:${stepId ?? "adaptive"}:${attempt.id}:retry:${attempt.retryOrdinal}`
    : `${runId}:${iteration}:${stepId ?? "adaptive"}`;
  return createHash("sha256").update(context).digest("hex").slice(0, 16);
}

function attemptId(
  runId: string,
  stepId: string,
  visitOrdinal: number,
  cycleId: string | null,
): string {
  return `attempt-${createHash("sha256")
    .update(`${runId}:${stepId}:${visitOrdinal}:cycle:${cycleId ?? "none"}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function applyPreparedWorkflowState(
  state: RunState,
  prepared: WorkflowCycleTransitionState,
): RunState {
  if (!state.workflowRuntime) return state;
  return {
    ...state,
    workflowRuntime: {
      ...state.workflowRuntime,
      currentCycle: prepared.currentCycle,
      cycles: prepared.cycles,
    },
  };
}

function nodeIdForStep(pkg: SkillPackage, stepId: string): string | undefined {
  return Object.entries(pkg.runtime?.nodeToStep ?? {}).find(
    ([, candidate]) => candidate === stepId,
  )?.[0];
}

function enterAttempt(state: RunState, stepId: string): RunState {
  if (!state.workflowRuntime) {
    return state;
  }
  if (state.workflowRuntime.currentAttempt) {
    if (state.workflowRuntime.currentAttempt.stepId !== stepId) {
      throw new Error("WorkflowRuntime current Attempt does not match step");
    }
    return state;
  }
  const workflowRuntime: WorkflowRuntimeState = structuredClone(
    state.workflowRuntime,
  );
  workflowRuntime.decisionReceipts ??= [];
  workflowRuntime.currentCycle ??= null;
  workflowRuntime.cycles ??= [];
  const visitOrdinal = workflowRuntime.nextVisitOrdinal + 1;
  const currentAttempt: WorkflowAttemptState = {
    id: attemptId(
      state.runId,
      stepId,
      visitOrdinal,
      workflowRuntime.currentCycle?.id ?? null,
    ),
    stepId,
    cycleId: workflowRuntime.currentCycle?.id ?? null,
    visitOrdinal,
    retryOrdinal: 0,
  };
  workflowRuntime.nextVisitOrdinal = visitOrdinal;
  workflowRuntime.currentAttempt = currentAttempt;
  workflowRuntime.visits.push({
    attemptId: currentAttempt.id,
    stepId,
    cycleId: currentAttempt.cycleId,
    visitOrdinal,
    outcomes: [],
  });
  return { ...state, workflowRuntime };
}

function recordWorkflowOutcome(
  pkg: SkillPackage,
  state: RunState,
  outcome: ActionOutcome,
): WorkflowRuntimeState | undefined {
  if (!state.workflowRuntime) return undefined;
  const workflowRuntime: WorkflowRuntimeState = structuredClone(
    state.workflowRuntime,
  );
  workflowRuntime.decisionReceipts ??= [];
  workflowRuntime.currentCycle ??= null;
  workflowRuntime.cycles ??= [];
  const attempt = workflowRuntime.currentAttempt;
  if (!attempt) {
    throw new Error("WorkflowRuntime current Attempt is missing");
  }
  const visit = workflowRuntime.visits.find(
    (candidate) => candidate.attemptId === attempt.id,
  );
  if (!visit) {
    throw new Error(
      "WorkflowRuntime current Attempt is not in the visit ledger",
    );
  }
  const receipt = decisionReceipt(pkg, state, outcome);
  const visitOutcome: WorkflowVisitOutcome = {
    actionId: outcome.actionId,
    status: outcome.status,
    summary: outcome.summary,
    retryOrdinal: attempt.retryOrdinal,
    ...(outcome.routing ? { routing: { ...outcome.routing } } : {}),
    ...(outcome.evidence
      ? { evidence: structuredClone(outcome.evidence) }
      : {}),
  };
  visit.outcomes.push(visitOutcome);
  workflowRuntime.revision += 1;
  if (receipt) workflowRuntime.decisionReceipts.push(receipt);
  if (outcome.status === "failed") {
    attempt.retryOrdinal += 1;
  } else {
    workflowRuntime.currentAttempt = null;
  }
  return workflowRuntime;
}

function decisionReceipt(
  pkg: SkillPackage,
  state: RunState,
  outcome: ActionOutcome,
): WorkflowDecisionReceipt | undefined {
  if (outcome.kind !== "decision") return undefined;
  if (outcome.status !== "succeeded") {
    throw new Error("Decision responses must succeed");
  }
  const runtimeState = state.workflowRuntime;
  const attempt = runtimeState?.currentAttempt;
  const identity = state.runtimeIdentity;
  if (!runtimeState || !attempt || !identity || !pkg.runtime) {
    throw new Error(
      "Decision receipt requires WorkflowRuntime identity and Attempt",
    );
  }
  if (outcome.revision !== runtimeState.revision) {
    throw new Error("Decision response revision does not match Run revision");
  }
  const nodeId = outcome.nodeId;
  if (nodeId === undefined || nodeId !== nodeIdForStep(pkg, attempt.stepId)) {
    throw new Error("Decision receipt Node identity is invalid");
  }
  if (outcome.attemptId !== attempt.id) {
    throw new Error("Decision receipt Attempt identity is invalid");
  }
  if ((outcome.cycleId ?? null) !== attempt.cycleId) {
    throw new Error("Decision receipt Cycle identity is invalid");
  }
  if (!outcome.decisionId || !outcome.choiceId || !outcome.reviewer) {
    throw new Error("Decision receipt fields are incomplete");
  }
  return {
    runId: state.runId,
    revision: runtimeState.revision,
    resultingRevision: runtimeState.revision + 1,
    actionId: outcome.actionId,
    decisionId: outcome.decisionId,
    nodeId,
    cycleId: attempt.cycleId,
    attemptId: attempt.id,
    choiceId: outcome.choiceId,
    reviewer: structuredClone(outcome.reviewer),
    inputs: structuredClone(outcome.inputs ?? {}),
    ...(outcome.rationale !== undefined
      ? { rationale: outcome.rationale }
      : {}),
    ...(outcome.evidenceReferences
      ? { evidenceReferences: [...outcome.evidenceReferences] }
      : {}),
    timestamp: new Date().toISOString(),
    protocolHash: identity.protocolHash,
    packageHash: identity.packageHash,
    snapshotHash: identity.snapshotHash,
  };
}

function stepFor(pkg: SkillPackage, id: string | null): SkillStep | undefined {
  return pkg.definition.orchestration.steps?.find((step) => step.id === id);
}

export function startRun(
  pkg: SkillPackage,
  runId: string,
  skillHash: string,
  workflowRuntime?: WorkflowRuntimeState,
): RunState {
  return {
    runId,
    skill: pkg.definition.metadata.name,
    skillVersion: pkg.definition.metadata.version,
    skillHash,
    orchestration: pkg.definition.orchestration.mode,
    currentStep: pkg.definition.orchestration.entry ?? null,
    iteration: 0,
    pending: null,
    pendingRef: ".comet/pending-action.json",
    trajectoryRef: ".comet/trajectory.jsonl",
    contextRef: ".comet/context.md",
    artifactsRef: ".comet/artifacts.json",
    checkpointRef: ".comet/checkpoint.json",
    status: "running",
    retries: {},
    ...(workflowRuntime
      ? { workflowRuntime: structuredClone(workflowRuntime) }
      : {}),
  };
}

export function decide(
  pkg: SkillPackage,
  state: RunState,
  confirmations: ReadonlySet<string>,
): Decision {
  return decideWithResolver(
    pkg,
    state,
    confirmations,
    staticDeterministicResolver,
    undefined,
  );
}

export function decideWithResolver<TContext>(
  pkg: SkillPackage,
  state: RunState,
  confirmations: ReadonlySet<string>,
  resolver: DeterministicResolver<TContext>,
  context: TContext,
): Decision {
  if (state.status !== "running")
    return { state, action: null, reason: `Run is ${state.status}` };
  if (state.pending)
    return {
      state,
      action: null,
      reason: `Action already pending: ${state.pending}`,
    };
  if (state.orchestration === "adaptive") {
    return {
      state,
      action: null,
      reason: "Adaptive orchestration requires an Agent candidate",
    };
  }
  const resolvedStep = resolveDeterministicStep(resolver, pkg, state, context);
  if (!resolvedStep && state.currentStep === null) {
    return { state: { ...state, status: "completed" }, action: null };
  }
  if (!resolvedStep) {
    return {
      state: { ...state, status: "failed" },
      action: null,
      reason: `Unknown current step: ${state.currentStep}`,
    };
  }
  const step = stepFor(pkg, resolvedStep.id);
  if (!step) {
    return {
      state: { ...state, status: "failed" },
      action: null,
      reason: `Resolver returned unknown current step: ${resolvedStep.id}`,
    };
  }
  const resolvedState =
    state.currentStep === step.id ? state : { ...state, currentStep: step.id };
  const prepared = prepareDeterministicStep(
    resolver,
    pkg,
    resolvedState,
    step,
    context,
  );
  const attemptState = enterAttempt(
    prepared
      ? applyPreparedWorkflowState(resolvedState, prepared)
      : resolvedState,
    step.id,
  );
  const action: EngineAction = {
    ...step.action,
    id: actionId(
      attemptState.runId,
      attemptState.iteration,
      step.id,
      attemptState.workflowRuntime?.currentAttempt ?? null,
    ),
    stepId: step.id,
    ...(attemptState.workflowRuntime?.currentAttempt
      ? {
          attemptId: attemptState.workflowRuntime.currentAttempt.id,
          cycleId: attemptState.workflowRuntime.currentAttempt.cycleId,
          visitOrdinal:
            attemptState.workflowRuntime.currentAttempt.visitOrdinal,
          retryOrdinal:
            attemptState.workflowRuntime.currentAttempt.retryOrdinal,
        }
      : {}),
  };
  return acceptAction(pkg, attemptState, action, confirmations, state);
}

function acceptAction(
  pkg: SkillPackage,
  state: RunState,
  action: EngineAction,
  confirmations: ReadonlySet<string>,
  rejectedState: RunState = state,
): Decision {
  const guard = checkAction(action, state, pkg.guardrails, confirmations);
  if (!guard.allowed) {
    return { state: rejectedState, action: null, reason: guard.reason };
  }
  return { state: { ...state, pending: action.id, status: "waiting" }, action };
}

export function acceptAdaptiveAction(
  pkg: SkillPackage,
  state: RunState,
  action: EngineAction,
  confirmations: ReadonlySet<string>,
): Decision {
  if (state.orchestration !== "adaptive") {
    return { state, action: null, reason: "Run is not adaptive" };
  }
  if (state.status !== "running") {
    return { state, action: null, reason: `Run is ${state.status}` };
  }
  if (state.pending) {
    return {
      state,
      action: null,
      reason: `Action already pending: ${state.pending}`,
    };
  }
  return acceptAction(pkg, state, action, confirmations);
}

export function recordOutcome(
  pkg: SkillPackage,
  state: RunState,
  outcome: ActionOutcome,
): RunState {
  return recordOutcomeWithResolver(
    pkg,
    state,
    outcome,
    staticDeterministicResolver,
    undefined,
  );
}

export function recordOutcomeWithResolver<TContext>(
  pkg: SkillPackage,
  state: RunState,
  outcome: ActionOutcome,
  resolver: DeterministicResolver<TContext>,
  context: TContext,
): RunState {
  if (!state.pending || state.pending !== outcome.actionId) {
    throw new Error(
      `Outcome does not match pending action: ${outcome.actionId}`,
    );
  }
  if (state.status === "completed" || state.status === "failed") {
    throw new Error(`Run is ${state.status}`);
  }
  const resolvedStep =
    state.orchestration === "deterministic"
      ? resolveDeterministicStep(resolver, pkg, state, context)
      : undefined;
  const step = resolvedStep ? stepFor(pkg, resolvedStep.id) : undefined;
  if (state.orchestration === "deterministic" && !resolvedStep) {
    throw new Error(
      `Unknown current step: ${state.currentStep ?? "(missing)"}`,
    );
  }
  if (state.orchestration === "deterministic" && !step) {
    throw new Error(
      `Resolver returned unknown current step: ${resolvedStep!.id}`,
    );
  }
  if (step?.action.type === "ask_user" && outcome.kind !== "decision") {
    throw new Error("Decision response required for pending ask_user action");
  }
  if (step?.action.type !== "ask_user" && outcome.kind === "decision") {
    throw new Error(
      `Decision response cannot satisfy ${step?.action.type ?? "unknown"} action`,
    );
  }
  if (outcome.status === "failed") {
    const retryKey =
      state.workflowRuntime?.currentAttempt?.id ?? outcome.actionId;
    const retries = {
      ...state.retries,
      [retryKey]: (state.retries[retryKey] ?? 0) + 1,
    };
    const workflowRuntime = recordWorkflowOutcome(pkg, state, outcome);
    return {
      ...state,
      pending: null,
      status: "running",
      retries,
      ...(workflowRuntime ? { workflowRuntime } : {}),
    };
  }
  const transition =
    state.orchestration === "deterministic"
      ? resolveDeterministicTransition(
          resolver,
          pkg,
          state,
          step!,
          outcome,
          context,
        )
      : { next: state.currentStep };
  const next = transition.next;
  if (
    next !== null &&
    state.orchestration === "deterministic" &&
    !stepFor(pkg, next)
  ) {
    throw new Error(`Resolver returned unknown next step: ${next}`);
  }
  const workflowRuntime = recordWorkflowOutcome(pkg, state, outcome);
  if (workflowRuntime && transition.workflowRuntime) {
    workflowRuntime.currentCycle = structuredClone(
      transition.workflowRuntime.currentCycle,
    );
    workflowRuntime.cycles = structuredClone(transition.workflowRuntime.cycles);
  }
  return {
    ...state,
    currentStep: next,
    iteration: state.iteration + 1,
    pending: null,
    status:
      next === null && state.orchestration === "deterministic"
        ? "completed"
        : "running",
    ...(workflowRuntime ? { workflowRuntime } : {}),
  };
}
