import { canonicalHash } from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import { gatePreview, type GateFinding, type GateState } from "./gates.js";
import { readSourceStudy, studyReferences } from "./source-study.js";
import { studyGateName } from "./source-study-invalidation.js";

/** Study completion is a human gate over one pin and its exact record revisions. */
export async function sourceStudyGateState(
  database: Queryable,
  versionId: string,
  skillId: string,
): Promise<GateState> {
  const study = await readSourceStudy(database, versionId);
  const pin = study.studies.find((entry) => entry.skillId === skillId);
  const records = [...study.facts, ...study.interfaces]
    .filter((r) =>
      studyReferences(r.content).some((ref) => ref.skillId === skillId),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const version = await database.query<{ stages: Record<string, string> }>(
    "select stages from workflow_versions where id = $1",
    [versionId],
  );
  const findings: GateFinding[] = [];
  function reject(code: string, message: string) {
    findings.push({
      code,
      message,
      severity: "error",
      requiresUserDecision: false,
      requiredAction: "repair",
    });
  }
  if (version.rows[0]?.stages.sources !== "done")
    reject(
      "SOURCE_SET_NOT_CONFIRMED",
      "Confirm the current Sources gate before marking a Skill version studied",
    );
  if (pin === undefined)
    reject(
      "SKILL_VERSION_NOT_PINNED",
      "Select a currently pinned Skill version",
    );
  const complete = study.studies.every(
    (entry) => entry.skillId === skillId || entry.studied,
  );
  // The completion that opens Questionnaire also waits for records that cite
  // only Skills no longer pinned, which no remaining pin's study covers.
  const checked = complete ? [...study.facts, ...study.interfaces] : records;
  if (checked.some((r) => r.status === "active" && r.stale))
    reject(
      "SOURCE_STUDY_EVIDENCE_STALE",
      "Update or retire records citing Skill versions that are no longer pinned",
    );
  return {
    preview: gatePreview({
      gate: studyGateName(skillId),
      workflowVersionId: versionId,
      records: [
        ...(pin === undefined
          ? []
          : [
              {
                type: "skill-version",
                id: pin.skillId,
                label: pin.skillName,
                hash: pin.hash,
              },
            ]),
        ...records.map((r) => ({
          type: r.kind,
          id: r.id,
          label:
            "statement" in r.content ? r.content.statement : r.content.artifact,
          hash: canonicalHash({
            revision: r.revision,
            status: r.status,
            content: r.content,
          }),
        })),
      ],
      boundHashes: {
        pin: canonicalHash(
          pin === undefined
            ? null
            : {
                skillId: pin.skillId,
                hash: pin.hash,
                purpose: pin.purpose,
                revision: pin.revision,
              },
        ),
        records: canonicalHash(
          records.map((r) => ({
            id: r.id,
            revision: r.revision,
            status: r.status,
            content: r.content,
          })),
        ),
      },
      effects: complete
        ? [
            { id: "source-study", state: "done" },
            { id: "questionnaire", state: "active" },
          ]
        : [{ id: "source-study", state: "active" }],
    }),
    findings,
  };
}
