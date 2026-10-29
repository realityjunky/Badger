import type { WriteContext } from "./audit.js";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { invalidateGate } from "./gates.js";

export function studyGateName(skillId: string): string {
  return `source-study/${skillId}`;
}

/** Called under the workflow-version lock by both pin and study writes. */
export async function invalidateStudyGates(
  database: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  reason: string,
  skillIds?: readonly string[],
): Promise<void> {
  const gates = await database.query<{ gate: string }>(
    `select distinct gate from gate_confirmations
      where workflow_version_id = $1 and gate like 'source-study/%'
        and invalidated_at is null`,
    [versionId],
  );
  for (const { gate } of gates.rows) {
    if (
      skillIds !== undefined &&
      !skillIds.some((id) => studyGateName(id) === gate)
    )
      continue;
    await invalidateGate(
      database,
      dependencies,
      context,
      versionId,
      gate,
      reason,
      [],
    );
  }
}
