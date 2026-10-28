import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createWorkflowRuntime,
  normalizeWorkflow,
} from "../../packages/kernel/dist/src/index.js";

const [operation, directory] = process.argv.slice(2);
assert.ok(
  ["start", "resume"].includes(operation) && directory,
  "Usage: node docs/examples/restore-smoke.mjs <start|resume> <scratch-run-root>",
);
const runRoot = path.resolve(directory);
const expectedPath = path.join(runRoot, "restore-expected.json");
const runtime = createWorkflowRuntime();

if (operation === "start") {
  await fs.mkdir(runRoot);
  const protocol = normalizeWorkflow({
    kind: "workflow-kernel",
    name: "restore-smoke",
    goal: "Verify that a synthetic Run survives backup and restore.",
    customNodes: [
      {
        id: "verify",
        label: "Verify restore",
        kind: "action",
        responsibility: "Record the successful synthetic restore check.",
        implementation: {
          skill: "restore-check",
          operation: "default",
          scope: "main",
        },
        operations: ["require", "augment", "disable"],
        outputSchemas: [],
        guardrails: [],
      },
    ],
  }).protocol;
  const started = await runtime.start({
    protocol,
    runRoot,
    runId: "restore-smoke",
  });
  assert.equal(started.disposition, "continue");
  await fs.writeFile(expectedPath, JSON.stringify(started), { flag: "wx" });
  console.log(JSON.stringify({ runId: started.runId, status: "persisted" }));
} else {
  const expected = JSON.parse(await fs.readFile(expectedPath, "utf8"));
  const recovered = await runtime.recover(runRoot);
  assert.deepEqual(recovered, expected);
  const completed = await runtime.submit(runRoot, {
    actionId: recovered.pendingAction.id,
    nodeId: "verify",
    status: "succeeded",
    summary: "Recovered the same pending action from restored files.",
  });
  assert.equal(completed.disposition, "done");
  console.log(
    JSON.stringify({
      runId: completed.runId,
      recoveredSameAction: true,
      status: "done",
    }),
  );
}
