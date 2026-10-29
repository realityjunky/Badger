import {
  createQuestionnaireHandoff,
  questionnaireLedgerChanges,
  type QuestionnaireTopic,
  type QuestionnaireLedgerItem,
  type QuestionnaireRecordHandoff,
  type QuestionnaireRecords,
} from "@realityjunky/badger";
import type { Queryable } from "../database/database.js";
import { readQuestions } from "./store.js";
import { readDrafts } from "./drafts.js";
import { readFacts, readResolutions } from "./resolutions.js";
import { readSourceStudy } from "../source-study.js";
import { RequestError } from "../http/errors.js";
import { readAnswers } from "./answers.js";

function visibleItems(items: QuestionnaireLedgerItem[], compose: boolean) {
  if (compose) return items;
  const hidden = new Set(
    items
      .filter((i) => i.record.type === "question" && i.state === "draft")
      .map((i) => i.record.id),
  );
  return items
    .filter((i) => i.record.type !== "question" || !hidden.has(i.record.id))
    .map((i) => ({
      ...i,
      relatedRecords: i.relatedRecords.filter(
        (r) => r.type !== "question" || !hidden.has(r.id),
      ),
    }));
}

/** Readiness keeps all blockers; authorization only redacts private details. */
function visibleHandoff(
  handoff: QuestionnaireRecordHandoff,
  compose: boolean,
): QuestionnaireRecordHandoff {
  if (compose) return handoff;
  const hidden = new Set(
    handoff.items
      .filter((i) => i.record.type === "question" && i.state === "draft")
      .map((i) => i.record.id),
  );
  const items = visibleItems(handoff.items, compose);
  const byId = new Map(
    items.map((i) => [`${i.record.type}:${i.record.id}`, i]),
  );
  return {
    ...handoff,
    items,
    ledger: Object.fromEntries(
      Object.entries(handoff.ledger).map(([key, entries]) => [
        key,
        entries.flatMap((entry) => {
          const visible = byId.get(`${entry.record.type}:${entry.record.id}`);
          return visible ? [visible] : [];
        }),
      ]),
    ) as QuestionnaireRecordHandoff["ledger"],
    readiness: handoff.readiness.map((r) => ({
      ...r,
      blockers: r.blockers.map((b) => ({
        ...b,
        record:
          b.record?.type === "question" && hidden.has(b.record.id)
            ? null
            : b.record,
      })),
    })),
  };
}

export async function readQuestionnaireRecords(
  tx: Queryable,
  versionId: string,
  personId: string,
): Promise<QuestionnaireRecords> {
  const questions = await readQuestions(tx, versionId, personId, true);
  const resolutions = await readResolutions(tx, versionId);
  const answers = await readAnswers(tx, versionId, personId);
  const study = await readSourceStudy(tx, versionId);
  return {
    questions: questions.map((q) => ({
      ...q,
      topic: q.topic as QuestionnaireTopic,
      resolution: resolutions.find(
        (r) => r.questionId === q.id && r.revision === q.resolutionRevision,
      ),
      answers: answers
        .filter((a) => a.questionId === q.id)
        .flatMap((a) => {
          const submitted = a.revisions
            .filter((r) => r.state === "submitted")
            .at(-1);
          return submitted
            ? [{ personId: a.personId, revision: submitted.revision }]
            : [];
        })
        .sort((a, b) => a.personId.localeCompare(b.personId)),
    })),
    drafts: await readDrafts(tx, versionId),
    facts: (await readFacts(tx, versionId))
      .filter((f) => questions.some((q) => q.id === f.questionId))
      .map((f) => ({
        ...f,
        resolutionRevision: resolutions.find((r) => r.id === f.resolutionId)!
          .revision,
        questionRevision: resolutions.find((r) => r.id === f.resolutionId)!
          .questionRevision,
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
  };
}

async function recordHandoff(
  tx: Queryable,
  versionId: string,
  personId: string,
  compose: boolean,
) {
  return visibleHandoff(
    createQuestionnaireHandoff({
      records: await readQuestionnaireRecords(tx, versionId, personId),
    }),
    compose,
  );
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
    const visible = visibleItems(round.items, compose);
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
