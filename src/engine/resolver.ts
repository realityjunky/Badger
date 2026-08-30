import type {
  ActionOutcome,
  RunState,
  WorkflowCycleTransitionState,
} from "./types.js";
import type { SkillPackage, SkillStep } from "../skill-runtime/types.js";

export interface DeterministicResolver<TContext> {
  resolveStep(input: {
    pkg: Readonly<SkillPackage>;
    state: Readonly<RunState>;
    context: Readonly<TContext>;
  }): SkillStep | undefined;

  prepareStep?(input: {
    pkg: Readonly<SkillPackage>;
    state: Readonly<RunState>;
    step: Readonly<SkillStep>;
    context: Readonly<TContext>;
  }): WorkflowCycleTransitionState | undefined;

  resolveNext(input: {
    pkg: Readonly<SkillPackage>;
    state: Readonly<RunState>;
    step: Readonly<SkillStep>;
    outcome: Readonly<ActionOutcome>;
    context: Readonly<TContext>;
  }): string | null;

  resolveTransition?(input: {
    pkg: Readonly<SkillPackage>;
    state: Readonly<RunState>;
    step: Readonly<SkillStep>;
    outcome: Readonly<ActionOutcome>;
    context: Readonly<TContext>;
  }): DeterministicTransition;
}

export interface DeterministicTransition {
  next: string | null;
  workflowRuntime?: WorkflowCycleTransitionState;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}

function readonlyCopy<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

export function resolveDeterministicStep<TContext>(
  resolver: DeterministicResolver<TContext>,
  pkg: SkillPackage,
  state: RunState,
  context: TContext,
): SkillStep | undefined {
  return resolver.resolveStep({
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    context: readonlyCopy(context),
  });
}

export function resolveDeterministicNext<TContext>(
  resolver: DeterministicResolver<TContext>,
  pkg: SkillPackage,
  state: RunState,
  step: SkillStep,
  outcome: ActionOutcome,
  context: TContext,
): string | null {
  return resolver.resolveNext({
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    step: readonlyCopy(step),
    outcome: readonlyCopy(outcome),
    context: readonlyCopy(context),
  });
}

export function prepareDeterministicStep<TContext>(
  resolver: DeterministicResolver<TContext>,
  pkg: SkillPackage,
  state: RunState,
  step: SkillStep,
  context: TContext,
): WorkflowCycleTransitionState | undefined {
  if (!resolver.prepareStep) return undefined;
  return resolver.prepareStep({
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    step: readonlyCopy(step),
    context: readonlyCopy(context),
  });
}

export function resolveDeterministicTransition<TContext>(
  resolver: DeterministicResolver<TContext>,
  pkg: SkillPackage,
  state: RunState,
  step: SkillStep,
  outcome: ActionOutcome,
  context: TContext,
): DeterministicTransition {
  const input = {
    pkg: readonlyCopy(pkg),
    state: readonlyCopy(state),
    step: readonlyCopy(step),
    outcome: readonlyCopy(outcome),
    context: readonlyCopy(context),
  };
  return resolver.resolveTransition
    ? resolver.resolveTransition(input)
    : { next: resolver.resolveNext(input) };
}

export const staticDeterministicResolver: DeterministicResolver<undefined> = {
  resolveStep({ pkg, state }) {
    return pkg.definition.orchestration.steps?.find(
      (step) => step.id === state.currentStep,
    );
  },
  resolveNext({ step }) {
    return step.next ?? null;
  },
};
