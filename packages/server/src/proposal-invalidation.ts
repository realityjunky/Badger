import { recordAudit, type WriteContext } from "./audit.js";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import {
  invalidateGate,
  type GateConfirmation,
  type GateState,
} from "./gates.js";

/**
 * Writers of earlier stages hold the version lock before withdrawing
 * dependent work.
 * Each withdrawn job is recorded once: a cancelled job is final, so the worker
 * that claimed it finds it finished and records nothing more.
 */
export async function invalidateProposal(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  reason: string,
) {
  await invalidateGate(tx, deps, context, versionId, "proposal", reason, [
    "Engineer",
    "Workflow owner",
  ]);
  const cancelled = await tx.query<{ id: string; revision: number }>(
    `update workflow_jobs set status = 'cancelled', error = $3, finished_at = $2,
    lease_until = null, revision = revision + 1
    where workflow_version_id = $1 and kind = 'init' and status in ('queued', 'running')
    returning id, revision`,
    [versionId, deps.clock.now(), reason],
  );
  for (const job of cancelled.rows)
    await recordAudit(tx, deps, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "workflow_initialization.cancelled",
      target: { type: "workflow_job", id: job.id },
      before: { revision: job.revision - 1, hash: null },
      after: { revision: job.revision, hash: null },
      reason,
      requestId: context.requestId,
    });
}

/**
 * The kernel derives the proposal, so its hash can change while the plan,
 * dossier, and pins stay the same, as after a kernel upgrade. An active
 * approval of another proposal hash then approves nothing current; the owner's
 * new approval supersedes it like any other invalidation.
 */
export async function supersedeStaleProposalApproval(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  active: GateConfirmation,
  current: GateState,
) {
  if (active.boundHashes.proposal === current.preview.boundHashes.proposal)
    return false;
  await invalidateProposal(
    tx,
    deps,
    context,
    versionId,
    "The kernel's proposal changed after its approval",
  );
  return true;
}
