import type { WriteContext } from "./audit.js";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { invalidateGate } from "./gates.js";

/** Upstream writers hold the version lock before withdrawing dependent work. */
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
  await tx.query(
    `update workflow_jobs set status = 'cancelled', error = $3, finished_at = $2,
    lease_until = null, revision = revision + 1
    where workflow_version_id = $1 and kind = 'init' and status in ('queued', 'running')`,
    [versionId, deps.clock.now(), reason],
  );
}
