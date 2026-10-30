import { expect, it } from "vitest";
import { certifyBadgerMcp } from "../src/certification.js";
it("certifies actual MCP tool calls, external-root binding, Completion and routing refusals", async () => {
  const result = await certifyBadgerMcp({
    generatedPackageHash: "b".repeat(64),
  });
  expect(result).toMatchObject({
    authority: "BadgerMCP",
    mode: "mcp",
    generatedPackageHash: "b".repeat(64),
    completed: true,
    rootBindingRequired: true,
    refusedStartRegisteredNothing: true,
    receiptRootVerified: true,
    skippedNodeRefused: true,
    missingCompletionRefused: true,
    illegalRouteRefused: true,
    exhaustedCycleRefused: true,
  });
  expect(result.toolCalls).toEqual(
    expect.arrayContaining([
      "status",
      "start",
      "next",
      "submit",
      "recover",
      "my_runs",
    ]),
  );
}, 30_000);
