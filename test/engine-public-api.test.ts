import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("public Engine package boundary", () => {
  it("exports the coherent runtime while hiding storage implementation details", () => {
    expect(api.loadSkillPackage).toBeTypeOf("function");
    expect(api.validateSkillPackage).toBeTypeOf("function");
    expect(api.startManualRun).toBeTypeOf("function");
    expect(api.resumeManualRun).toBeTypeOf("function");
    expect(api.startStandaloneRun).toBeTypeOf("function");
    expect(api.resumeStandaloneRun).toBeTypeOf("function");
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
  });
});
