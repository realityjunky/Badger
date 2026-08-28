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

    const publicApi = api as Record<string, unknown>;
    expect(publicApi.readRunState).toBeUndefined();
    expect(publicApi.writeRunState).toBeUndefined();
    expect(publicApi.readTrajectory).toBeUndefined();
    expect(publicApi.atomicWriteContainedText).toBeUndefined();
    expect(publicApi.readFileRaceSafe).toBeUndefined();
  });
});
