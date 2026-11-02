import type { WorkflowContinuation } from "./types.js";

/** Recovery semantics belong to WorkflowRuntime, including its operation hints. */
export function workflowContinuationRequiresRecovery(
  current: Pick<WorkflowContinuation, "findings">,
): boolean {
  return current.findings.some(
    (finding) =>
      finding.code === "recovery-required" ||
      finding.operation?.id === "workflow.recover",
  );
}
