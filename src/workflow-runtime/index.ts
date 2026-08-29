import { randomUUID } from "node:crypto";
import {
  hashSkillPackage,
  readSkillSnapshot,
} from "../skill-runtime/snapshot.js";
import {
  resumeManualRun,
  startManualRun,
  type ManualRunResult,
} from "../engine/manual-run.js";
import { readPendingAction } from "../engine/run-store.js";
import { readRunState } from "../engine/state.js";
import type { RunState } from "../engine/types.js";
import { stableValue } from "../util.js";
import { compileWorkflow } from "./compiler.js";
import {
  createCompletionPlan,
  validateSuccessfulSubmission,
} from "./completion.js";
import type {
  ResumeWorkflowRunOptions,
  StartWorkflowRunOptions,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowRuntime,
  Submission,
  WorkflowSubmission,
} from "./types.js";

export type {
  ResumeWorkflowRunOptions,
  StartWorkflowRunOptions,
  WorkflowContinuation,
  WorkflowExecutionIdentity,
  WorkflowRuntime,
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

async function verifyStoredAction(
  runRoot: string,
  state: RunState,
  identity: WorkflowExecutionIdentity,
  pkg: Awaited<ReturnType<typeof readSkillSnapshot>>,
): Promise<void> {
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
    return;
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
}

export function createWorkflowRuntime(): WorkflowRuntime {
  return {
    async start(
      options: StartWorkflowRunOptions,
    ): Promise<WorkflowContinuation> {
      const compiled = await compileWorkflow(options.protocol);
      const result = await startManualRun(compiled.package, options.runRoot, {
        runId: options.runId ?? randomUUID(),
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
      runRoot: string,
      options: ResumeWorkflowRunOptions = {},
    ): Promise<WorkflowContinuation> {
      const stored = await readRunState(runRoot);
      if (!stored) throw new Error(`No Comet Run found in: ${runRoot}`);
      const verified = await verifyStoredPackage(runRoot, stored);
      await verifyStoredAction(
        runRoot,
        stored,
        verified.identity,
        verified.package,
      );
      const result = await resumeManualRun(runRoot, {
        confirmations: options.confirmations ?? [],
      });
      return continuation(result, verified.identity);
    },

    async submit(
      runRoot: string,
      submission: WorkflowSubmission,
    ): Promise<WorkflowContinuation> {
      validateSubmission(submission);
      const stored = await readRunState(runRoot);
      if (!stored) throw new Error(`No Comet Run found in: ${runRoot}`);
      const verified = await verifyStoredPackage(runRoot, stored);
      await verifyStoredAction(
        runRoot,
        stored,
        verified.identity,
        verified.package,
      );
      const pending = await readPendingAction(runRoot, stored.pendingRef);
      if (!pending || !stored.pending || stored.status !== "waiting") {
        throw new Error(`Run is ${stored.status}`);
      }
      if (submission.actionId !== pending.id) {
        throw new Error(
          `Outcome does not match pending action: ${submission.actionId}`,
        );
      }
      const node = currentNode(stored, verified.identity, pending);
      if (submission.nodeId !== undefined && submission.nodeId !== node) {
        throw new Error(
          `Submission Node does not match pending Node: ${submission.nodeId}`,
        );
      }
      if (submission.status === "succeeded" && node) {
        const workflowNode = verified.package.runtime!.protocol.nodes.find(
          (candidate) => candidate.id === node,
        );
        if (!workflowNode) {
          throw new Error(`WorkflowRuntime Node is missing: ${node}`);
        }
        const plan =
          verified.package.runtime!.completionPlans?.[node] ??
          createCompletionPlan(workflowNode);
        if (
          JSON.stringify(stableValue(plan)) !==
          JSON.stringify(stableValue(createCompletionPlan(workflowNode)))
        ) {
          throw new Error(
            `WorkflowRuntime completion plan does not match Node: ${node}`,
          );
        }
        const blockers = await validateSuccessfulSubmission(
          runRoot,
          verified.package.runtime!.protocol,
          workflowNode,
          plan,
          submission,
        );
        if (blockers.length > 0) {
          return {
            disposition: "blocked",
            runId: stored.runId,
            currentNode: node,
            pendingAction: pending,
            execution: structuredClone(verified.identity),
            blockers,
          };
        }
      }
      const result = await resumeManualRun(runRoot, {
        outcome: {
          actionId: submission.actionId,
          status: submission.status,
          summary: submission.summary,
          ...(submission.artifacts ? { artifacts: submission.artifacts } : {}),
          ...(submission.state ? { state: submission.state } : {}),
          ...(submission.evidence ? { evidence: submission.evidence } : {}),
        },
      });
      return continuation(result, verified.identity);
    },
  };
}

const defaultRuntime = createWorkflowRuntime();

export const startWorkflowRun = defaultRuntime.start;
export const resumeWorkflowRun = defaultRuntime.resume;
export const submitWorkflowRun = defaultRuntime.submit;
