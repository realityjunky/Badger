import type { WorkflowContinuation, WorkflowStateProjection } from "./types.js";

/** Shared wire limits for observer snapshots. Original evidence stays in events. */
export const WORKFLOW_RUN_SNAPSHOT_BOUNDS = Object.freeze({
  maxBytes: 1024 * 1024,
  maxListEntries: 256,
  maxTextLength: 4096,
  maxIdentifierLength: 256,
  maxActionTypeLength: 100,
  maxFindingMessageLength: 16384,
  maxOutcomeSummaryLength: 50000,
  maxFinalizationPreviewBytes: 16 * 1024 * 1024,
  maxReportRequestBytes: 18 * 1024 * 1024,
});

const ledgerKeys = [
  "visits",
  "cycles",
  "decisionReceipts",
  "verificationReceipts",
  "artifactVersions",
  "artifactSelections",
  "contentSnapshots",
  "receiptOutputs",
  "blockers",
  "findings",
  "history",
  "completedNodes",
  "artifactReceipts",
] as const;

function observedLists(
  model: Record<string, unknown>,
): { path: string; values: unknown[] }[] {
  const lists: { path: string; values: unknown[] }[] = ledgerKeys.flatMap(
    (key) =>
      Array.isArray(model[key])
        ? [{ path: key, values: model[key] as unknown[] }]
        : [],
  );
  if (Array.isArray(model.visits))
    for (const [index, visit] of model.visits.entries()) {
      if (visit && typeof visit === "object" && Array.isArray(visit.outcomes))
        lists.push({
          path: `visits[${index}].outcomes`,
          values: visit.outcomes,
        });
    }
  const repair = model.repair as { history?: unknown[] } | undefined;
  if (Array.isArray(repair?.history))
    lists.push({ path: "repair.history", values: repair.history });
  return lists;
}

export function workflowRunSnapshotBoundViolation(
  projection: unknown,
  continuation: unknown,
): string | null {
  const bounds = WORKFLOW_RUN_SNAPSHOT_BOUNDS;
  if (
    Buffer.byteLength(JSON.stringify({ projection, continuation })) >
    bounds.maxBytes
  )
    return `Run snapshot exceeds maxBytes (${bounds.maxBytes})`;
  for (const [name, model] of Object.entries({ projection, continuation })) {
    if (!model || typeof model !== "object") continue;
    const value = model as Record<string, unknown>;
    const text = (item: unknown, limit: number, at: string) =>
      typeof item === "string" && item.length > limit
        ? `Run snapshot exceeds text length (${limit}) at ${name}.${at}`
        : null;
    for (const key of ["currentNode", "cycleId", "attemptId"])
      if (text(value[key], bounds.maxIdentifierLength, key))
        return text(value[key], bounds.maxIdentifierLength, key);
    const pending = value.pendingAction as {
      id?: unknown;
      type?: unknown;
    } | null;
    if (pending) {
      const failure =
        text(pending.id, bounds.maxIdentifierLength, "pendingAction.id") ??
        text(pending.type, bounds.maxActionTypeLength, "pendingAction.type");
      if (failure) return failure;
    }
    if (Array.isArray(value.findings))
      for (const finding of value.findings) {
        const failure = text(
          finding?.message,
          bounds.maxFindingMessageLength,
          "findings.message",
        );
        if (failure) return failure;
      }
    if (Array.isArray(value.visits))
      for (const visit of value.visits) {
        const failure = text(
          visit?.attemptId,
          bounds.maxIdentifierLength,
          "visits.attemptId",
        );
        if (failure) return failure;
        if (Array.isArray(visit?.outcomes))
          for (const outcome of visit.outcomes) {
            const failure = text(
              outcome?.summary,
              bounds.maxOutcomeSummaryLength,
              "visits.outcomes.summary",
            );
            if (failure) return failure;
          }
      }
    if (Array.isArray(value.artifactReceipts))
      for (const receipt of value.artifactReceipts) {
        for (const [item, max, at] of [
          [
            receipt?.artifactId,
            bounds.maxIdentifierLength,
            "artifactReceipts.artifactId",
          ],
          [receipt?.path, bounds.maxTextLength, "artifactReceipts.path"],
          [
            receipt?.producer?.attemptId,
            bounds.maxIdentifierLength,
            "artifactReceipts.producer.attemptId",
          ],
          [
            receipt?.producer?.nodeId,
            bounds.maxIdentifierLength,
            "artifactReceipts.producer.nodeId",
          ],
          [
            receipt?.root?.name,
            bounds.maxIdentifierLength,
            "artifactReceipts.root.name",
          ],
          [
            receipt?.root?.path,
            bounds.maxTextLength,
            "artifactReceipts.root.path",
          ],
        ] as const) {
          const failure = text(item, max, at);
          if (failure) return failure;
        }
      }
    for (const list of observedLists(model as Record<string, unknown>))
      if (list.values.length > bounds.maxListEntries)
        return `Run snapshot exceeds maxListEntries (${bounds.maxListEntries}) at ${name}.${list.path}`;
  }
  return null;
}

/** Compact observation only. Gate context and the authoritative events stay intact. */
export function boundWorkflowRunSnapshot(
  projection: WorkflowStateProjection,
  continuation: WorkflowContinuation,
) {
  const result = structuredClone({ projection, continuation });
  const bounds = WORKFLOW_RUN_SNAPSHOT_BOUNDS;
  let compacted = false;
  let finalizationPreview;
  if (
    result.continuation.finalizationPreview &&
    Buffer.byteLength(JSON.stringify(result.continuation.finalizationPreview)) >
      bounds.maxBytes / 4
  ) {
    finalizationPreview = result.continuation.finalizationPreview;
    result.continuation.finalizationPreviewRef = {
      planHash: finalizationPreview.planHash,
      operationCount: finalizationPreview.operations.length,
    };
    delete result.continuation.finalizationPreview;
    compacted = true;
  }
  for (const model of [result.projection, result.continuation]) {
    for (const list of observedLists(
      model as unknown as Record<string, unknown>,
    )) {
      if (list.values.length > bounds.maxListEntries) {
        list.values.splice(0, list.values.length - bounds.maxListEntries);
        compacted = true;
      }
    }
    for (const visit of model.visits)
      for (const outcome of visit.outcomes) {
        if (outcome.summary.length > bounds.maxOutcomeSummaryLength) {
          outcome.summary = outcome.summary.slice(
            0,
            bounds.maxOutcomeSummaryLength,
          );
          compacted = true;
        }
      }
  }

  // Preserve execution, pending human decisions, previews, and findings. Halve
  // the largest observation ledger until the pair fits, leaving marker room.
  const collections: { size(): number; shrink(): void }[] = [];
  for (const model of [result.projection, result.continuation]) {
    const record = model as unknown as Record<string, unknown>;
    for (const key of [
      "visits",
      "cycles",
      "decisionReceipts",
      "verificationReceipts",
      "artifactVersions",
      "artifactSelections",
      "contentSnapshots",
      "receiptOutputs",
      "currentArtifactVersions",
      "evidence",
      "history",
      "completedNodes",
      "artifactReceipts",
      "completion",
    ]) {
      if (!(key in record)) continue;
      collections.push({
        size: () => Buffer.byteLength(JSON.stringify(record[key]) ?? "null"),
        shrink: () => {
          const value = record[key];
          if (Array.isArray(value))
            value.splice(0, Math.ceil(value.length / 2));
          else if (key === "evidence" || key === "currentArtifactVersions") {
            const entries = Object.entries(value as object);
            record[key] = Object.fromEntries(
              entries.slice(Math.ceil(entries.length / 2)),
            );
          } else record[key] = null;
        },
      });
    }
    if (model.repair) {
      const history = model.repair.history;
      collections.push({
        size: () => Buffer.byteLength(JSON.stringify(history)),
        shrink: () => {
          history.splice(0, Math.ceil(history.length / 2));
        },
      });
    }
  }
  while (Buffer.byteLength(JSON.stringify(result)) > bounds.maxBytes - 256) {
    const largest = collections
      .filter((c) => c.size() > 4)
      .sort((a, b) => b.size() - a.size())[0];
    if (!largest)
      throw new Error(
        `Run snapshot essential context exceeds maxBytes (${bounds.maxBytes})`,
      );
    largest.shrink();
    compacted = true;
  }
  if (result.projection.historySummary) {
    result.projection.historySummary.returned =
      result.projection.history.length;
    result.projection.historySummary.omitted =
      result.projection.historySummary.total - result.projection.history.length;
  }
  if (compacted) {
    result.projection.snapshotCompacted = true;
    result.continuation.snapshotCompacted = true;
  }
  return { ...result, ...(finalizationPreview ? { finalizationPreview } : {}) };
}
