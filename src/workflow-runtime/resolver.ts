import type { DeterministicResolver } from "../engine/resolver.js";
import type { ActionOutcome, RunState } from "../engine/types.js";
import type { SkillPackage, SkillStep } from "../skill-runtime/types.js";
import {
  isRevisionedWorkflowProtocol,
  resolveWorkflowNext,
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

  resolveNext({
    pkg,
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
      return step.next ?? null;
    }
    const nodeId = nodeForStep(pkg, step.id);
    if (!nodeId) {
      if (step.action.type === "checkpoint") return null;
      throw new Error(`WorkflowRuntime step has no Node identity: ${step.id}`);
    }
    const nextNode = resolveWorkflowNext(pkg.runtime.protocol, nodeId, outcome);
    if (nextNode === null) return null;
    const nextStep = pkg.runtime.nodeToStep[nextNode];
    if (!nextStep) {
      throw new Error(
        `WorkflowRuntime next Node has no step identity: ${nextNode}`,
      );
    }
    return nextStep;
  },
};

export function resolverForPackage(): DeterministicResolver<undefined> {
  return workflowDeterministicResolver;
}
