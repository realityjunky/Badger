import { canonicalHash, type WorkflowFinding } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "./audit.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { toIsoString } from "./util.js";
import type { WorkflowStage } from "./workflows.js";
import { closeGateInbox, notifyWorkflowRoles } from "./inbox.js";
import type { WorkflowRole } from "./workflow-access.js";

export interface GatePreview {
  gate: string;
  workflowVersionId: string;
  boundHashes: Record<string, string>;
  records: { type: string; id: string; label: string; hash: string }[];
  effects: WorkflowStage[];
  confirmationHash: string;
}

export interface GateFinding extends Pick<
  WorkflowFinding,
  "severity" | "requiredAction" | "message" | "requiresUserDecision"
> {
  code: string;
}

export interface GateState {
  preview: GatePreview;
  findings: GateFinding[];
}

export interface GateConfirmation {
  id: string;
  gate: string;
  workflowVersionId: string;
  actorId: string;
  confirmedAt: string;
  boundHashes: Record<string, string>;
  confirmationHash: string;
  requestId: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  supersededBy: string | null;
  revision: number;
}

interface ConfirmationRow {
  revision: number;
  result: { confirmation: GateConfirmation };
  invalidated_at: Date | string | null;
  invalidation_reason: string | null;
  superseded_by: string | null;
}

export function gatePreview(
  input: Omit<GatePreview, "confirmationHash">,
): GatePreview {
  return { ...input, confirmationHash: canonicalHash(input) };
}

export async function readGateConfirmations(
  database: Queryable,
  versionId: string,
  gate: string,
): Promise<GateConfirmation[]> {
  const result = await database.query<ConfirmationRow>(
    `select result, invalidated_at, invalidation_reason, superseded_by, revision
       from gate_confirmations where workflow_version_id = $1 and gate = $2
      order by confirmed_at desc, id desc`,
    [versionId, gate],
  );
  return result.rows.map((row) => ({
    ...row.result.confirmation,
    invalidatedAt:
      row.invalidated_at === null ? null : toIsoString(row.invalidated_at),
    invalidationReason: row.invalidation_reason,
    supersededBy: row.superseded_by,
    revision: row.revision,
  }));
}

export type GateCommitResult =
  | { kind: "confirmed"; result: { confirmation: GateConfirmation } }
  | { kind: "conflict" }
  | { kind: "rejected"; findings: GateFinding[] };

export interface GateCommitInput {
  confirmationHash: string;
  requestId: string;
}

/**
 * All gate commits share the version lock, hashing, replay, and audit rules.
 * A gate whose bound state can change without a writer passes `supersede`,
 * which invalidates an active confirmation that no longer binds the current
 * state and returns true, so the new confirmation can replace it.
 */
export async function commitGate(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  gate: string,
  input: GateCommitInput,
  loadState: (tx: Queryable) => Promise<GateState>,
  supersede?: (
    tx: Queryable,
    active: GateConfirmation,
    state: GateState,
  ) => Promise<boolean>,
): Promise<GateCommitResult> {
  const replay = async (tx: Queryable): Promise<GateCommitResult | null> => {
    const previous = await tx.query<{
      workflow_version_id: string;
      gate: string;
      confirmation_hash: string;
      result: { confirmation: GateConfirmation };
    }>(
      `select workflow_version_id, gate, confirmation_hash, result from gate_confirmations
        where actor_id = $1 and request_id = $2`,
      [context.personId, input.requestId],
    );
    const row = previous.rows[0];
    if (row === undefined) return null;
    return row.workflow_version_id === versionId &&
      row.gate === gate &&
      row.confirmation_hash === input.confirmationHash
      ? { kind: "confirmed", result: row.result }
      : { kind: "conflict" };
  };
  try {
    return await database.transaction(async (tx) => {
      await tx.query(
        "select id from workflow_versions where id = $1 for update",
        [versionId],
      );
      const previous = await replay(tx);
      if (previous !== null) return previous;
      const state = await loadState(tx);
      if (state.preview.confirmationHash !== input.confirmationHash)
        return { kind: "conflict" };
      if (state.findings.length > 0)
        return { kind: "rejected", findings: state.findings };
      const active = (await readGateConfirmations(tx, versionId, gate)).find(
        (confirmation) => confirmation.invalidatedAt === null,
      );
      if (
        active !== undefined &&
        !((await supersede?.(tx, active, state)) ?? false)
      )
        return { kind: "conflict" };
      const now = dependencies.clock.now();
      const confirmation: GateConfirmation = {
        id: dependencies.ids.next(),
        gate,
        workflowVersionId: versionId,
        actorId: context.personId,
        confirmedAt: now.toISOString(),
        boundHashes: state.preview.boundHashes,
        confirmationHash: input.confirmationHash,
        requestId: input.requestId,
        invalidatedAt: null,
        invalidationReason: null,
        supersededBy: null,
        revision: 1,
      };
      const result = { confirmation };
      await tx.query(
        `insert into gate_confirmations
          (id, workflow_version_id, gate, actor_id, confirmed_at, bound_hashes, confirmation_hash, request_id, result)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb)`,
        [
          confirmation.id,
          versionId,
          gate,
          context.personId,
          now,
          JSON.stringify(confirmation.boundHashes),
          input.confirmationHash,
          input.requestId,
          JSON.stringify(result),
        ],
      );
      await tx.query(
        `update gate_confirmations set superseded_by = $3, revision = revision + 1
          where workflow_version_id = $1 and gate = $2 and invalidated_at is not null and superseded_by is null`,
        [versionId, gate, confirmation.id],
      );
      await tx.query(
        `update workflow_versions set stages = stages || $2::jsonb, revision = revision + 1, updated_at = $3 where id = $1`,
        [
          versionId,
          JSON.stringify(
            Object.fromEntries(
              state.preview.effects.map((effect) => [effect.id, effect.state]),
            ),
          ),
          now,
        ],
      );
      await recordAudit(tx, dependencies, {
        actor: { personId: context.personId, credential: context.credential },
        channel: context.channel,
        action: "gate.confirmed",
        target: { type: "gate_confirmation", id: confirmation.id, label: gate },
        before: null,
        after: { revision: 1, hash: input.confirmationHash },
        reason: `Confirmed ${gate}`,
        requestId: context.requestId,
      });
      await closeGateInbox(tx, versionId, gate, now);
      if (gate === "plan")
        await notifyWorkflowRoles(
          tx,
          dependencies,
          versionId,
          "proposal",
          "gate-ready",
          confirmation.id,
          ["Workflow owner"],
        );
      return { kind: "confirmed", result };
    });
  } catch (error) {
    // The same person's request ID may race on different workflow versions.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    )
      return (await replay(database)) ?? { kind: "conflict" };
    throw error;
  }
}

/** Pin changes call this inside their version-locked transaction. */
export async function invalidateGate(
  database: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  gate: string,
  reason: string,
  recipients: readonly WorkflowRole[],
): Promise<void> {
  const invalidated = await database.query<{
    id: string;
    confirmation_hash: string;
    revision: number;
  }>(
    `update gate_confirmations set invalidated_at = $3, invalidation_reason = $4, revision = revision + 1
      where workflow_version_id = $1 and gate = $2 and invalidated_at is null
      returning id, confirmation_hash, revision`,
    [versionId, gate, dependencies.clock.now(), reason],
  );
  await closeGateInbox(
    database,
    versionId,
    gate,
    dependencies.clock.now(),
    "gate-ready",
  );
  for (const row of invalidated.rows) {
    await notifyWorkflowRoles(
      database,
      dependencies,
      versionId,
      gate,
      "gate-invalidated",
      row.id,
      recipients,
    );
    await recordAudit(database, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "gate.invalidated",
      target: { type: "gate_confirmation", id: row.id, label: gate },
      before: { revision: row.revision - 1, hash: row.confirmation_hash },
      after: { revision: row.revision, hash: null },
      reason,
      requestId: context.requestId,
    });
  }
}
