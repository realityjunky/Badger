import type { DeterministicResolver } from "../engine/resolver.js";
import type { ActionOutcome, RunState } from "../engine/types.js";
import type { SkillPackage, SkillStep } from "../skill-runtime/types.js";
import {
  isRevisionedWorkflowProtocol,
  prepareWorkflowCycleEntry,
  resolveWorkflowTransition,
} from "./routing.js";

function stepFor(
  pkg: Readonly<SkillPackage>,
  stepId: string | null,
): SkillStep | undefined {
  return pkg.definition.orchestration.steps?.find((step) => step.id === stepId);
}

function nodeForStep(
  pkg: Readonly<SkillPackage>,
  stepId: string | null,
): string | undefined {
  if (!pkg.runtime || !stepId) return undefined;
  return Object.entries(pkg.runtime.nodeToStep).find(
    ([, compiledStepId]) => compiledStepId === stepId,
  )?.[0];
}

export const workflowDeterministicResolver: DeterministicResolver<undefined> = {
  resolveStep({
    pkg,
    state,
  }: {
    pkg: Readonly<SkillPackage>;
    state: Readonly<RunState>;
  }) {
    return stepFor(pkg, state.currentStep);
  },

  prepareStep({ pkg, state, step }) {
    if (!pkg.runtime?.protocol.cycles || !state.workflowRuntime) {
      return undefined;
    }
    const nodeId = nodeForStep(pkg, step.id);
    if (!nodeId) {
      throw new Error(`WorkflowRuntime step has no Node identity: ${step.id}`);
    }
    return prepareWorkflowCycleEntry(
      pkg.runtime.protocol,
      state.runId,
      state.workflowRuntime,
      nodeId,
    );
  },

  resolveTransition({
    pkg,
    state,
    step,
    outcome,
  }: {
    pkg: Readonly<SkillPackage>;
    state: Readonly<RunState>;
    step: Readonly<SkillStep>;
    outcome: Readonly<ActionOutcome>;
    context: Readonly<undefined>;
  }) {
    if (!pkg.runtime || !isRevisionedWorkflowProtocol(pkg.runtime.protocol)) {
      return { next: step.next ?? null };
    }
    const nodeId = nodeForStep(pkg, step.id);
    if (!nodeId) {
      if (step.action.type === "checkpoint") return { next: null };
      throw new Error(`WorkflowRuntime step has no Node identity: ${step.id}`);
    }
    const resolved = resolveWorkflowTransition(
      pkg.runtime.protocol,
      nodeId,
      outcome,
      state.workflowRuntime,
      state.runId,
    );
    const nextNode = resolved.next;
    const workflowRuntime = resolved.workflowRuntime;
    if (nextNode === null) {
      return {
        next: null,
        ...(workflowRuntime ? { workflowRuntime } : {}),
      };
    }
    const nextStep = pkg.runtime.nodeToStep[nextNode];
    if (!nextStep) {
      throw new Error(
        `WorkflowRuntime next Node has no step identity: ${nextNode}`,
      );
    }
    return {
      next: nextStep,
      ...(workflowRuntime ? { workflowRuntime } : {}),
    };
  },

  resolveNext({ pkg, state, step, outcome }) {
    const transition = this.resolveTransition!({
      pkg,
      state,
      step,
      outcome,
      context: undefined,
    });
    return transition.next;
  },
};

export function resolverForPackage(): DeterministicResolver<undefined> {
  return workflowDeterministicResolver;
}
