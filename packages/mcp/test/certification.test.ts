import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { certifyBadgerMcp } from "../src/certification.js";
it.each(["in-memory", "stdio"] as const)(
  "certifies actual %s MCP tool calls, external-root binding, Completion and routing refusals",
  async (transport) => {
    const result = await certifyBadgerMcp({
      generatedPackageHash: "b".repeat(64),
      transport,
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
  },
  30_000,
);

it("certifies in a JIT-less child without loading the fetch globals unavailable in the Node 22 sandbox", async () => {
  const executable = new URL("../dist/src/certification.js", import.meta.url)
    .href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--jitless",
      "--input-type=module",
      "--eval",
      `
      for (const name of ["fetch", "Response", "Request", "Headers"]) {
        // Node 22 materializes a lazy global when redefining it; delete first
        // so installing the refusal does not itself initialize Undici.
        delete globalThis[name];
        Object.defineProperty(globalThis, name, { get() {
          throw new Error("Certification loaded fetch global: " + name);
        }});
      }
      const { certifyBadgerMcp } = await import(${JSON.stringify(executable)});
      const { rejects } = await import("node:assert/strict");
      await rejects(
        certifyBadgerMcp({ generatedPackageHash: "b".repeat(64), transport: "stdio" }),
        /Stdio host certification requires Node without --jitless/,
      );
      console.log(JSON.stringify(await certifyBadgerMcp({ generatedPackageHash: "b".repeat(64) })));
    `,
    ],
    { timeout: 25_000, maxBuffer: 1024 * 1024 },
  );
  expect(JSON.parse(stdout)).toMatchObject({
    authority: "BadgerMCP",
    completed: true,
    evaluatedPackageStarted: true,
    receiptRootVerified: true,
    missingCompletionRefused: true,
    illegalRouteRefused: true,
    exhaustedCycleRefused: true,
  });
}, 30_000);
