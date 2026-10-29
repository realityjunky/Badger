import { canonicalHash } from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import { gatePreview, type GateState } from "./gates.js";
import { listWorkflowPins, readSourceCheck } from "./workflow-source.js";

/** Sources delegates inspection to the worker's kernel result. */
export async function sourcesGateState(
  database: Queryable,
  versionId: string,
): Promise<GateState> {
  const frame = await database.query<{
    name: string;
    goal: string;
    intent: string;
    locale: string;
  }>("select name, goal, intent, locale from workflow_versions where id = $1", [
    versionId,
  ]);
  const check = await readSourceCheck(database, versionId);
  const pins = await listWorkflowPins(database, versionId);
  return {
    preview: gatePreview({
      gate: "sources",
      workflowVersionId: versionId,
      records: pins.map((pin) => ({
        type: pin.purpose,
        id: pin.skillId,
        label: pin.skillName,
        hash: pin.hash,
      })),
      boundHashes: {
        workflowVersion: canonicalHash(frame.rows[0]),
        pins: check?.pinsHash ?? canonicalHash([]),
        sourceCheck: canonicalHash(check),
      },
      effects: [
        { id: "sources", state: "done" },
        { id: "source-study", state: "active" },
      ],
    }),
    findings:
      check?.status === "passed"
        ? []
        : [
            {
              code: "SOURCE_CHECK_NOT_PASSED",
              severity: "error",
              requiresUserDecision: false,
              requiredAction: "repair",
              message:
                "Pin the source set and wait for its source check to pass before confirming Sources",
            },
          ],
  };
}
