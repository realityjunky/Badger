import type { AuditWriteContext } from "./audit.js";
import { recordAudit } from "./audit.js";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { invalidateGate } from "./gates.js";
import { notifyWorkflowRoles } from "./inbox.js";

/** The caller holds the Workflow version lock, as every upstream writer does. */
export async function invalidatePackage(
  tx: Queryable,
  deps: ServiceDependencies,
  context: AuditWriteContext,
  versionId: string,
  reason: string,
) {
  await invalidateGate(tx, deps, context, versionId, "generation", reason, [
    "Engineer",
  ]);
  await invalidateGeneratedPackage(tx, deps, context, versionId, reason);
  const cancelled = await tx.query<{ id: string; revision: number }>(
    `update workflow_jobs set status = 'cancelled', error = $3, finished_at = $2,
      lease_until = null, revision = revision + 1
      where workflow_version_id = $1 and kind = 'generate' and status in ('queued','running')
      returning id, revision`,
    [versionId, deps.clock.now(), reason],
  );
  for (const job of cancelled.rows)
    await recordAudit(tx, deps, {
      actor: context,
      channel: context.channel,
      action: "workflow_generation.cancelled",
      target: { type: "workflow_job", id: job.id },
      before: { revision: job.revision - 1, hash: null },
      after: { revision: job.revision, hash: null },
      reason,
      requestId: context.requestId,
    });
}

/** Generation supersedes its old package while retaining its own confirmation. */
export async function invalidateGeneratedPackage(
  tx: Queryable,
  deps: ServiceDependencies,
  context: AuditWriteContext,
  versionId: string,
  reason: string,
) {
  for (const gate of ["package", "publication"])
    await invalidateGate(tx, deps, context, versionId, gate, reason, [
      "Reviewer",
      "Workflow owner",
    ]);
  const withdrawn = await tx.query<{ id: string }>(
    `update workflow_packages set invalidated_at = $2, invalidation_reason = $3
      where workflow_version_id = $1 and invalidated_at is null returning id`,
    [versionId, deps.clock.now(), reason],
  );
  const cancelledDrafts = await tx.query<{ id: string; revision: number }>(
    `update drafting_jobs set status='cancelled', revision=revision+1, lease_id=null, lease_person_id=null, lease_token_id=null, lease_agent_host=null, lease_until=null, updated_at=$2 where workflow_version_id=$1 and kind in ('authoring-lane','review-vote') and status in ('queued','claimed','submitted') and id not in (select job_id from accepted_authoring_outputs) returning id,revision`,
    [versionId, deps.clock.now()],
  );
  for (const job of cancelledDrafts.rows) {
    await tx.query(
      "update inbox_items set state='done',revision=revision+1,updated_at=$2 where drafting_job_id=$1 and state<>'done'",
      [job.id, deps.clock.now()],
    );
    await recordAudit(tx, deps, {
      actor: context,
      channel: context.channel,
      action: "drafting-job.cancelled",
      target: { type: "drafting-job", id: job.id },
      before: { revision: job.revision - 1, hash: null },
      after: { revision: job.revision, hash: null },
      reason,
      requestId: context.requestId,
    });
  }
  for (const { id } of withdrawn.rows)
    await notifyWorkflowRoles(
      tx,
      deps,
      versionId,
      "package",
      "gate-invalidated",
      id,
      ["Engineer", "Reviewer", "Workflow owner"],
    );
}
