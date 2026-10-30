import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { notifyQuestionEngineers, notifyRestatement } from "./resolutions.js";
import { notifyQuestion } from "./store.js";

type EngineerKind = "answer-submitted" | "question-reopened";

/**
 * A new version is always copied from the latest one, so work recorded in an
 * earlier version never reaches a later one. Each pending item for a copied
 * question or fact therefore moves to the copy: the questionnaire's own
 * helpers create the new version's items, so notifications route as usual,
 * and the source items close. Called after the records are copied, under the
 * same workflow and version locks. Returns how many items moved.
 */
export async function moveOpenWork(
  tx: Queryable,
  deps: ServiceDependencies,
  sourceId: string,
  versionId: string,
): Promise<number> {
  const pending = (
    await tx.query<{
      id: string;
      kind: "question-assigned" | "restatement-ready" | EngineerKind;
      person_id: string | null;
      binding_id: string | null;
      question_id: string;
      revision: number;
      fact_id: string | null;
    }>(
      `select i.id, i.kind, i.person_id, i.binding_id, q.record_id as question_id, n.revision, f.record_id as fact_id
       from inbox_items i
       join workflow_record_origins q on q.workflow_version_id = $2 and q.record_type = 'question' and q.source_record_id = i.question_id
       join questions n on n.id = q.record_id
       left join workflow_record_origins f on f.workflow_version_id = $2 and f.record_type = 'fact' and f.source_record_id = i.fact_id
       where i.workflow_version_id = $1 and i.state <> 'done' and (i.fact_id is null) = (f.record_id is null)
         and i.kind in ('question-assigned', 'restatement-ready', 'answer-submitted', 'question-reopened')
       order by i.created_at, i.id`,
      [sourceId, versionId],
    )
  ).rows;
  const assigned = new Map<
    string,
    { revision: number; personIds: string[]; bindingIds: string[] }
  >();
  const engineers = new Map<string, Set<EngineerKind>>();
  for (const item of pending) {
    if (item.kind === "question-assigned") {
      const audience = assigned.get(item.question_id) ?? {
        revision: item.revision,
        personIds: [],
        bindingIds: [],
      };
      if (item.person_id !== null) audience.personIds.push(item.person_id);
      if (item.binding_id !== null) audience.bindingIds.push(item.binding_id);
      assigned.set(item.question_id, audience);
    } else if (item.kind === "restatement-ready") {
      await notifyRestatement(
        tx,
        deps,
        versionId,
        item.question_id,
        item.fact_id!,
        item.person_id!,
      );
    } else {
      engineers.set(
        item.question_id,
        (engineers.get(item.question_id) ?? new Set()).add(item.kind),
      );
    }
  }
  // Only the people who still owed an answer are asked again.
  for (const [questionId, { revision, ...audience }] of assigned)
    await notifyQuestion(tx, deps, versionId, questionId, revision, audience);
  for (const [questionId, kinds] of engineers)
    for (const kind of kinds)
      await notifyQuestionEngineers(
        tx,
        deps,
        versionId,
        questionId,
        deps.ids.next(),
        kind,
      );
  await tx.query(
    "update inbox_items set state = 'done', revision = revision + 1, updated_at = $2 where id = any($1::text[])",
    [pending.map((item) => item.id), deps.clock.now()],
  );
  return pending.length;
}
