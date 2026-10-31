import { describe, expect, it } from "vitest";
import type { WorkflowMcpCertificationEvidence } from "@realityjunky/badger";
import { isRuntimeCheck, mcpPhaseEvidence } from "../src/api/evaluations.js";

describe("an evaluation report's Badger MCP certification", () => {
  const mcp: WorkflowMcpCertificationEvidence = {
    authority: "BadgerMCP",
    mode: "mcp",
    generatedPackageHash: "a".repeat(64),
    toolCalls: ["status", "start"],
    evaluatedPackageStarted: true,
    completed: true,
    rootBindingRequired: true,
    refusedStartRegisteredNothing: true,
    receiptRootVerified: true,
    skippedNodeRefused: true,
    missingCompletionRefused: true,
    illegalRouteRefused: false,
    exhaustedCycleRefused: true,
  };

  it("is a phase whose refusals are its negative cases", () => {
    expect(mcpPhaseEvidence(mcp)).toEqual({
      authority: "BadgerMCP",
      mode: "mcp",
      generatedPackageHash: "a".repeat(64),
      toolCalls: ["status", "start"],
      evaluatedPackageStarted: true,
      completed: true,
      receiptRootVerified: true,
      negativeCases: {
        rootBindingRequired: true,
        refusedStartRegisteredNothing: true,
        skippedNodeRefused: true,
        missingCompletionRefused: true,
        illegalRouteRefused: false,
        exhaustedCycleRefused: true,
      },
    });
  });

  it("groups its check with runtime certification, not the package checks", () => {
    expect(
      [
        "entry-skill",
        "workflow-runtime-certification",
        "package-integrity",
        "mcp-runtime-certification",
      ].filter(isRuntimeCheck),
    ).toEqual(["workflow-runtime-certification", "mcp-runtime-certification"]);
  });
});
