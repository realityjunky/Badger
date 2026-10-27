import { describe, expect, it } from "vitest";
import {
  acceptAdaptiveAction,
  decide,
  decideWithResolver,
  recordOutcome,
  recordOutcomeWithResolver,
  startRun,
} from "../src/engine/loop.js";
import type { DeterministicResolver } from "../src/engine/resolver.js";
import type { SkillPackage } from "../src/skill-runtime/types.js";

function deterministic(): SkillPackage {
  return {
    root: "/repo/demo",
    definition: {
      apiVersion: "badger/v1alpha1",
      kind: "Skill",
      metadata: { name: "demo", version: "1", description: "Demo" },
      goal: { statement: "Done", inputs: [], outputs: [], success: ["done"] },
      orchestration: {
        mode: "deterministic",
        entry: "plan",
        steps: [
          {
            id: "plan",
            action: { type: "invoke_skill", ref: "writing-plans" },
            next: "finish",
          },
          { id: "finish", action: { type: "checkpoint" } },
        ],
      },
      skills: [{ id: "writing-plans" }],
      agents: [],
      tools: [],
    },
    guardrails: {
      allowedSkills: ["writing-plans"],
      allowedAgents: [],
      allowedTools: [],
      maxIterations: 10,
      maxRetriesPerAction: 1,
      confirmationRequiredFor: [],
    },
    evals: [],
  };
}

describe("Skill Engine loop", () => {
  it("uses one loop for deterministic steps", () => {
    const pkg = deterministic();
    let state = startRun(pkg, "run-1", "a".repeat(64));
    const first = decide(pkg, state, new Set());
    expect(first.action).toMatchObject({
      type: "invoke_skill",
      ref: "writing-plans",
      stepId: "plan",
    });
    state = first.state;
    state = recordOutcome(pkg, state, {
      actionId: first.action!.id,
      status: "succeeded",
      summary: "plan written",
    });
    expect(state.currentStep).toBe("finish");
    expect(state.iteration).toBe(1);
  });

  it("keeps failed actions resumable until the retry budget is exhausted", () => {
    const pkg = deterministic();
    let state = startRun(pkg, "run-retry", "r".repeat(64));
    const first = decide(pkg, state, new Set());
    const action = first.action!;

    state = recordOutcome(pkg, first.state, {
      actionId: action.id,
      status: "failed",
      summary: "transient failure",
    });
    expect(state).toMatchObject({
      status: "running",
      pending: null,
      retries: { [action.id]: 1 },
    });

    const retry = decide(pkg, state, new Set());
    expect(retry.action).toEqual(action);
    state = recordOutcome(pkg, retry.state, {
      actionId: action.id,
      status: "failed",
      summary: "retry failed",
    });

    const exhausted = decide(pkg, state, new Set());
    expect(exhausted.action).toBeNull();
    expect(exhausted.reason).toBe(
      `Retry budget exhausted for action: ${action.id}`,
    );
    expect(exhausted.state).toEqual(state);
  });

  it("completes when an injected resolver returns no next step", () => {
    const pkg = deterministic();
    const state = startRun(pkg, "run-resolver-complete", "c".repeat(64));
    const resolver: DeterministicResolver<undefined> = {
      resolveStep: ({ pkg: resolvedPackage, state: resolvedState }) =>
        resolvedPackage.definition.orchestration.steps?.find(
          (step) => step.id === resolvedState.currentStep,
        ),
      resolveNext: () => null,
    };
    const decision = decideWithResolver(
      pkg,
      state,
      new Set(),
      resolver,
      undefined,
    );

    const completed = recordOutcomeWithResolver(
      pkg,
      decision.state,
      {
        actionId: decision.action!.id,
        status: "succeeded",
        summary: "completed by resolver",
      },
      resolver,
      undefined,
    );

    expect(completed).toMatchObject({
      currentStep: null,
      iteration: 1,
      pending: null,
      status: "completed",
    });
  });

  it("accepts a guardrail-checked adaptive candidate", () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: "adaptive" };
    const state = startRun(pkg, "run-2", "b".repeat(64));
    const result = acceptAdaptiveAction(
      pkg,
      state,
      {
        id: "candidate",
        stepId: null,
        type: "invoke_skill",
        ref: "writing-plans",
      },
      new Set(),
    );
    expect(result.action?.id).toBe("candidate");
    expect(result.state.pending).toBe("candidate");
  });

  it("fails closed when a candidate violates guardrails", () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: "adaptive" };
    const state = startRun(pkg, "run-3", "c".repeat(64));
    const result = acceptAdaptiveAction(
      pkg,
      state,
      { id: "candidate", stepId: null, type: "invoke_skill", ref: "unknown" },
      new Set(),
    );
    expect(result.action).toBeNull();
    expect(result.reason).toBe("Skill is not allowed: unknown");
  });

  it("fails closed when a deterministic Run references an unknown step", () => {
    const pkg = deterministic();
    const state = startRun(pkg, "run-4", "d".repeat(64));
    state.currentStep = "missing";

    const result = decide(pkg, state, new Set());

    expect(result.action).toBeNull();
    expect(result.state.status).toBe("failed");
    expect(result.reason).toBe("Unknown current step: missing");
  });

  it("preserves the original state when resolver action acceptance is rejected", () => {
    const pkg = deterministic();
    pkg.guardrails.confirmationRequiredFor = ["writing-plans"];
    const state = startRun(pkg, "run-guarded-resolver", "g".repeat(64));
    state.currentStep = "finish";
    const resolver: DeterministicResolver<undefined> = {
      resolveStep: ({ pkg: resolvedPackage }) =>
        resolvedPackage.definition.orchestration.steps?.find(
          (step) => step.id === "plan",
        ),
      resolveNext: () => null,
    };

    const result = decideWithResolver(
      pkg,
      state,
      new Set(),
      resolver,
      undefined,
    );

    expect(result.action).toBeNull();
    expect(result.reason).toBe("User confirmation required for: writing-plans");
    expect(result.state).toEqual(state);
  });

  it("rejects outcomes when the deterministic current step is corrupt", () => {
    const pkg = deterministic();
    const state = startRun(pkg, "run-5", "e".repeat(64));
    const decision = decide(pkg, state, new Set());
    decision.state.currentStep = "missing";

    expect(() =>
      recordOutcome(pkg, decision.state, {
        actionId: decision.action!.id,
        status: "succeeded",
        summary: "done",
      }),
    ).toThrow("Unknown current step: missing");
  });

  it("does not accept adaptive candidates after the Run stops", () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: "adaptive" };
    const state = startRun(pkg, "run-6", "f".repeat(64));
    state.status = "completed";

    const result = acceptAdaptiveAction(
      pkg,
      state,
      {
        id: "candidate",
        stepId: null,
        type: "invoke_skill",
        ref: "writing-plans",
      },
      new Set(),
    );

    expect(result.action).toBeNull();
    expect(result.reason).toBe("Run is completed");
  });

  it("rejects outcomes for terminal Runs with stale pending state", () => {
    const pkg = deterministic();
    const state = startRun(pkg, "run-terminal-pending", "t".repeat(64));
    state.status = "completed";
    state.pending = "stale-action";

    expect(() =>
      recordOutcome(pkg, state, {
        actionId: "stale-action",
        status: "succeeded",
        summary: "must not reopen",
      }),
    ).toThrow("Run is completed");
  });

  it("does not overwrite an existing pending adaptive action", () => {
    const pkg = deterministic();
    pkg.definition.orchestration = { mode: "adaptive" };
    const state = startRun(pkg, "run-7", "0".repeat(64));
    state.pending = "existing";

    const result = acceptAdaptiveAction(
      pkg,
      state,
      {
        id: "candidate",
        stepId: null,
        type: "invoke_skill",
        ref: "writing-plans",
      },
      new Set(),
    );

    expect(result.action).toBeNull();
    expect(result.reason).toBe("Action already pending: existing");
    expect(result.state.pending).toBe("existing");
  });
});
