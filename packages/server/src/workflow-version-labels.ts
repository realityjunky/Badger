import { recordAudit, type WriteContext } from "./audit.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import type { ParseResult } from "./workflows.js";

export interface WorkflowVersionLabel {
  semanticVersion: string | null;
  labelRevision: number;
}

interface LabelRow {
  id: string;
  number: number;
  name: string;
  semantic_version: string | null;
  label_revision: number;
}

export function parseSemanticVersion(
  input: unknown,
): ParseResult<string | null> {
  if (input === null) return { ok: true, value: null };
  if (typeof input === "string") {
    const value = input.trim();
    if (
      value.length <= 64 &&
      /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value)
    )
      return { ok: true, value };
  }
  return {
    ok: false,
    message:
      "semanticVersion must be major.minor.patch with no leading zeroes, at most 64 characters, or null to use the numbered version",
  };
}

export async function withVersionLabels<T extends { id: string }>(
  database: Queryable,
  versions: readonly T[],
): Promise<(T & WorkflowVersionLabel)[]> {
  if (versions.length === 0) return [];
  const result = await database.query<LabelRow>(
    "select id, semantic_version, label_revision from workflow_versions where id = any($1::text[])",
    [versions.map((version) => version.id)],
  );
  const labels = new Map(result.rows.map((row) => [row.id, row]));
  return versions.map((version) => ({
    ...version,
    semanticVersion: labels.get(version.id)?.semantic_version ?? null,
    labelRevision: labels.get(version.id)?.label_revision ?? 0,
  }));
}

export async function versionLabelExists(
  database: Queryable,
  workflowId: string,
  semanticVersion: string | null,
  exceptVersionId: string | null = null,
): Promise<boolean> {
  if (semanticVersion === null) return false;
  const result = await database.query(
    `select 1 from workflow_versions where workflow_id = $1 and semantic_version = $2
       and ($3::text is null or id <> $3)`,
    [workflowId, semanticVersion, exceptVersionId],
  );
  return result.rows.length > 0;
}

export async function updateWorkflowVersionLabel(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  workflowId: string,
  versionId: string,
  labelRevision: number,
  semanticVersion: string | null,
): Promise<
  | { kind: "updated"; label: WorkflowVersionLabel }
  | { kind: "stale"; label: WorkflowVersionLabel }
  | { kind: "missing" }
  | { kind: "duplicate-label" }
> {
  return database.transaction(async (tx) => {
    await tx.query("select id from workflows where id = $1 for no key update", [
      workflowId,
    ]);
    const result = await tx.query<LabelRow>(
      `select id, name, number, semantic_version, label_revision from workflow_versions
       where id = $1 and workflow_id = $2 for no key update`,
      [versionId, workflowId],
    );
    const current = result.rows[0];
    if (current === undefined) return { kind: "missing" };
    const label = {
      semanticVersion: current.semantic_version,
      labelRevision: current.label_revision,
    };
    if (labelRevision !== current.label_revision)
      return { kind: "stale", label };
    if (semanticVersion === current.semantic_version)
      return { kind: "updated", label };
    if (await versionLabelExists(tx, workflowId, semanticVersion, versionId))
      return { kind: "duplicate-label" };
    await tx.query(
      `update workflow_versions set semantic_version = $2, label_revision = label_revision + 1
       where id = $1`,
      [versionId, semanticVersion],
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "workflow_version.label_updated",
      target: {
        type: "workflow_version_label",
        id: versionId,
        label: `${current.name} · ${semanticVersion ?? `v${current.number}`}`,
      },
      before:
        labelRevision === 0 ? null : { revision: labelRevision, hash: null },
      after: { revision: labelRevision + 1, hash: null },
      reason: `Version label changed from ${current.semantic_version ?? `v${current.number}`} to ${semanticVersion ?? `v${current.number}`}`,
      requestId: context.requestId,
    });
    return {
      kind: "updated",
      label: { semanticVersion, labelRevision: labelRevision + 1 },
    };
  });
}
