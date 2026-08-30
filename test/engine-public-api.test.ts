import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import * as workflowRuntime from "../src/workflow-runtime/public.js";

describe("public Engine package boundary", () => {
  it("exports the coherent runtime while hiding storage implementation details", () => {
    expect(api.loadSkillPackage).toBeTypeOf("function");
    expect(api.validateSkillPackage).toBeTypeOf("function");
    expect(api.startManualRun).toBeTypeOf("function");
    expect(api.resumeManualRun).toBeTypeOf("function");
    expect(api.startStandaloneRun).toBeTypeOf("function");
    expect(api.resumeStandaloneRun).toBeTypeOf("function");
    expect(api.createWorkflowRuntime).toBeTypeOf("function");
    expect(api.startWorkflowRun).toBeTypeOf("function");
    expect(api.resumeWorkflowRun).toBeTypeOf("function");
    expect(api.submitWorkflowRun).toBeTypeOf("function");
    expect(api.recoverWorkflowRun).toBeTypeOf("function");
    expect(api.runEngineDifferential).toBeTypeOf("function");
    expect(api.getEngineParityCoverage).toBeTypeOf("function");
    expect(api.certifyEngineDifferential).toBeTypeOf("function");

    const publicApi = api as Record<string, unknown>;
    for (const operation of [
      "startRun",
      "decide",
      "decideWithResolver",
      "acceptAdaptiveAction",
      "recordOutcome",
      "recordOutcomeWithResolver",
      "checkAction",
      "evaluateRuntime",
      "resolveDeterministicStep",
      "resolveDeterministicNext",
      "evaluateManualRun",
      "upgradeManualRun",
      "evaluateStandaloneRun",
      "upgradeStandaloneRun",
    ]) {
      expect(publicApi[operation], operation).toBeTypeOf("function");
    }
    expect(publicApi.readRunState).toBeUndefined();
    expect(publicApi.writeRunState).toBeUndefined();
    expect(publicApi.readTrajectory).toBeUndefined();
    expect(publicApi.atomicWriteContainedText).toBeUndefined();
    expect(publicApi.readFileRaceSafe).toBeUndefined();
    expect(publicApi.readCheckpoint).toBeUndefined();
    expect(publicApi.writeCheckpoint).toBeUndefined();
    expect(publicApi.compileWorkflow).toBeUndefined();
    expect(publicApi.resolveWorkflowRunLocation).toBeUndefined();
    for (const operation of [
      "inspectWorkflowRun",
      "projectWorkflowHandoff",
      "projectWorkflowState",
      "validateWorkflowSubmission",
      "verifyWorkflowProtocol",
      "writeWorkflowStateProjection",
    ]) {
      expect(publicApi[operation], operation).toBeUndefined();
    }
  });

  it("keeps the WorkflowRuntime package seam limited to core operations", () => {
    const runtimeApi = workflowRuntime as Record<string, unknown>;
    for (const operation of [
      "createWorkflowRuntime",
      "startWorkflowRun",
      "resumeWorkflowRun",
      "submitWorkflowRun",
      "recoverWorkflowRun",
    ]) {
      expect(runtimeApi[operation], operation).toBeTypeOf("function");
    }
    for (const operation of [
      "inspectWorkflowRun",
      "projectWorkflowHandoff",
      "projectWorkflowState",
      "validateWorkflowSubmission",
      "verifyWorkflowProtocol",
      "writeWorkflowStateProjection",
    ]) {
      expect(
        (workflowRuntime as Record<string, unknown>)[operation],
        operation,
      ).toBeUndefined();
    }
  });
});
