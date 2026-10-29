import {
  createQuestionnaireHandoff,
  questionnaireLedgerChanges,
  type QuestionnaireTopic,
  type QuestionnaireLedgerItem,
} from "@realityjunky/badger";
import type { Queryable } from "../database/database.js";
import { readQuestions } from "./store.js";
import { readDrafts } from "./drafts.js";
import { readFacts, readResolutions } from "./resolutions.js";
import { readSourceStudy } from "../source-study.js";
import { RequestError } from "../http/errors.js";

async function recordHandoff(
  tx: Queryable,
  versionId: string,
  personId: string,
  compose: boolean,
) {
  const questions = await readQuestions(tx, versionId, personId, compose);
  const resolutions = await readResolutions(tx, versionId);
  const study = await readSourceStudy(tx, versionId);
  return createQuestionnaireHandoff({
    records: {
      questions: questions.map((q) => ({
        ...q,
        topic: q.topic as QuestionnaireTopic,
        resolution: resolutions.find(
          (r) => r.questionId === q.id && r.revision === q.resolutionRevision,
        ),
      })),
      drafts: await readDrafts(tx, versionId),
      facts: (await readFacts(tx, versionId))
        .filter((f) => questions.some((q) => q.id === f.questionId))
        .map((f) => ({
          ...f,
          statement: f.text,
          current:
            questions.find((q) => q.id === f.questionId)!.resolutionRevision ===
            resolutions.find((r) => r.id === f.resolutionId)!.revision,
        })),
      sourceRecords: [...study.facts, ...study.interfaces].map((r) => ({
        ...r,
        statement:
          "statement" in r.content ? r.content.statement : r.content.artifact,
      })),
      pins: study.studies,
    },
  });
}

export async function readLedger(
  tx: Queryable,
  versionId: string,
  personId: string,
  compose: boolean,
  sinceRound: string | null = null,
) {
  const handoff = await recordHandoff(tx, versionId, personId, compose);
  const baselines = (
    await tx.query<{ id: string; number: number; title: string }>(
      `select r.id, r.number, r.title from question_rounds r join questionnaire_round_snapshots s on s.round_id = r.id
    where r.workflow_version_id = $1 order by r.number`,
      [versionId],
    )
  ).rows;
  let changes: ReturnType<typeof questionnaireLedgerChanges> | null = null;
  if (sinceRound !== null) {
    const round = (
      await tx.query<{
        state: string;
        items: QuestionnaireLedgerItem[] | null;
      }>(
        `select r.state, s.items from question_rounds r left join questionnaire_round_snapshots s on s.round_id = r.id
      where r.id = $1 and r.workflow_version_id = $2`,
        [sinceRound, versionId],
      )
    ).rows[0];
    if (!round)
      throw new RequestError(404, "No such round in this workflow version");
    if (round.state !== "published" || round.items === null)
      throw new RequestError(
        409,
        "This round has no publication baseline; choose a round published after ledger history became available",
      );
    const visible = compose
      ? round.items
      : round.items.filter(
          (i) => i.record.type !== "question" || i.state !== "draft",
        );
    changes = questionnaireLedgerChanges(visible, handoff.items);
  }
  return { handoff, baselines, sinceRound, changes };
}

export async function snapshotRoundLedger(
  tx: Queryable,
  versionId: string,
  roundId: string,
  personId: string,
) {
  const existing = await tx.query(
    "select round_id from questionnaire_round_snapshots where round_id = $1",
    [roundId],
  );
  if (existing.rows.length) return;
  const handoff = await recordHandoff(tx, versionId, personId, true);
  await tx.query(
    "insert into questionnaire_round_snapshots (round_id, items) values ($1, $2::jsonb)",
    [roundId, JSON.stringify(handoff.items)],
  );
}
