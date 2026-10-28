import { expect, it } from "vitest";
import { createWorkflowRuntime } from "/home/hugo/AI/Badger/.claude/worktrees/fix-36-review/packages/kernel/src/workflow-runtime/public.ts";

it("recovers the artifact ledger", async () => {
  const location = JSON.parse(process.env.WORKFLOW_ARTIFACT_LOCATION!);
  const expected = JSON.parse(process.env.WORKFLOW_ARTIFACT_EXPECTED!);
  await expect(createWorkflowRuntime().recover(location)).resolves.toEqual(expected);
});
