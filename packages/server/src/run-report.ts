import { RequestError } from "./http/errors.js";
import { WORKFLOW_RUN_SNAPSHOT_BOUNDS as bounds } from "@realityjunky/badger/workflow-runtime";
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number = bounds.maxTextLength) =>
  typeof value === "string" && value.length <= max;
const array = (
  value: unknown,
  max: number = bounds.maxListEntries,
): value is unknown[] => Array.isArray(value) && value.length <= max;
const hash = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function receipt(value: unknown, runId: string) {
  if (
    !object(value) ||
    !text(value.artifactId, bounds.maxIdentifierLength) ||
    !text(value.path) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    !hash(value.sha256) ||
    !Number.isFinite(value.mtimeMs) ||
    !object(value.producer) ||
    value.producer.runId !== runId ||
    !text(value.producer.attemptId, bounds.maxIdentifierLength) ||
    !text(value.producer.nodeId, bounds.maxIdentifierLength)
  )
    return false;
  return (
    value.root === undefined ||
    (object(value.root) &&
      text(value.root.name, bounds.maxIdentifierLength) &&
      text(value.root.path))
  );
}
/** Structural bounds only. Runtime checks, routes, Attempts and Completion are
 * never recreated by the observer service; integrity/gate attestation is a
 * separate workflow. Reject malformed models before storing or rendering them. */
export function validateRunReadModels(
  projection: Record<string, unknown>,
  continuation: Record<string, unknown>,
  runId: string,
) {
  for (const value of [projection, continuation]) {
    if (
      !["currentNode", "cycleId", "attemptId"].every(
        (key) =>
          value[key] === null || text(value[key], bounds.maxIdentifierLength),
      ) ||
      !object(value.execution) ||
      !(
        value.pendingAction === null ||
        (object(value.pendingAction) &&
          text(value.pendingAction.id, bounds.maxIdentifierLength) &&
          text(value.pendingAction.type, bounds.maxActionTypeLength))
      ) ||
      !array(value.findings) ||
      !value.findings.every(
        (f) =>
          object(f) &&
          text(f.message, bounds.maxFindingMessageLength) &&
          ["info", "warning", "error"].includes(String(f.severity)),
      ) ||
      ![
        "visits",
        "cycles",
        "decisionReceipts",
        "verificationReceipts",
        "artifactVersions",
        "artifactSelections",
        "contentSnapshots",
        "receiptOutputs",
        "blockers",
      ].every((key) => array(value[key]))
    )
      throw new RequestError(400, "Malformed bounded runtime read model");
    for (const visit of value.visits as unknown[]) {
      if (
        !object(visit) ||
        !text(visit.attemptId, bounds.maxIdentifierLength) ||
        !array(visit.outcomes) ||
        !visit.outcomes.every(
          (outcome) =>
            object(outcome) &&
            text(outcome.summary, bounds.maxOutcomeSummaryLength) &&
            ["succeeded", "failed"].includes(String(outcome.status)),
        )
      )
        throw new RequestError(400, "Malformed runtime Attempts");
    }
  }
  if (
    !array(projection.artifactReceipts) ||
    !projection.artifactReceipts.every((value) => receipt(value, runId))
  )
    throw new RequestError(400, "Malformed runtime artifact receipts");
  if (
    !array(projection.completedNodes) ||
    !array(projection.history) ||
    !object(projection.evidence) ||
    !["continue", "await-user", "blocked", "done"].includes(
      String(continuation.disposition),
    )
  )
    throw new RequestError(400, "Malformed runtime state projection");
  const summary = projection.historySummary;
  if (
    summary !== undefined &&
    (!object(summary) ||
      ![summary.total, summary.returned, summary.omitted].every(
        (count) => Number.isSafeInteger(count) && Number(count) >= 0,
      ) ||
      summary.returned !== (projection.history as unknown[]).length ||
      Number(summary.total) !==
        Number(summary.returned) + Number(summary.omitted))
  )
    throw new RequestError(400, "Malformed runtime outcome history summary");
}
