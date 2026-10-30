import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizeWorkflow } from "../src/index.js";
import { createWorkflowRuntime } from "../src/workflow-runtime/public.js";

let root: string;
afterEach(async () => root && fs.rm(root, { recursive: true, force: true }));
it("exports committed ordered events and the runtime-owned Completion plan without changing the Run", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-run-report-"));
  const protocol = normalizeWorkflow({
    kind: "workflow-kernel",
    name: "report-workflow",
    goal: "Report local Runs.",
    customNodes: [
      {
        id: "produce",
        label: "Produce",
        kind: "action",
        responsibility: "Produce evidence.",
        implementation: {
          skill: "producer",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: ["result.v1"],
        guardrails: [],
      },
    ],
    outputSchemas: [
      {
        id: "result.v1",
        description: "Result.",
        artifacts: [],
        evidence: [{ id: "summary", required: true }],
      },
    ],
  }).protocol;
  const runtime = createWorkflowRuntime();
  const location = {
    kind: "standalone" as const,
    projectRoot: root,
    runId: "run-one",
  };
  expect(await runtime.readReport(location)).toBeNull();
  const started = await runtime.start({ protocol, location });
  expect(started.completion).toMatchObject({
    outputSchemas: [
      { id: "result.v1", evidence: [{ id: "summary", required: true }] },
    ],
  });
  const first = (await runtime.readReport(location))!;
  expect(first.continuation).toEqual(await runtime.inspect(location));
  expect(first.projection).toEqual(await runtime.projectState(location));
  expect(first.events[0]).toMatchObject({
    sequence: 1,
    type: "run_started",
    runId: "run-one",
  });
  expect(first.events.map((e) => e.sequence)).toEqual(
    first.events.map((_, i) => i + 1),
  );
  const submission = {
    actionId: started.pendingAction!.id,
    runId: started.runId,
    revision: started.revision,
    execution: started.execution,
    nodeId: started.currentNode,
    status: "succeeded" as const,
    summary: "Done.",
  };
  const missing = await runtime.submit(location, submission);
  expect(missing.blockers.join("; ")).toContain(
    "Missing Output Schema evidence: result.v1.summary",
  );
  expect((await runtime.readReport(location))!.events).toEqual(first.events);
  const done = await runtime.submit(location, {
    ...submission,
    evidence: { summary: "Ready." },
  });
  expect(done.disposition).toBe("done");
  expect(done.completion).toBeNull();
  const after = (await runtime.readReport(
    location,
    first.events.at(-1)!.sequence,
  ))!;
  expect(after.events.length).toBeGreaterThan(0);
  expect(after.events[0].sequence).toBe(first.events.length + 1);
  expect(after.projection.status).toBe("completed");
});
