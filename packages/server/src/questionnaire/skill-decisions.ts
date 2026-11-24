import type { Queryable } from "../database/database.js";

export interface ReviewedSkillAnswerReference {
  questionId: string;
  resolutionRevision: number;
  personId: string;
  revision: number;
}

export interface ReviewedSkillAnswer extends ReviewedSkillAnswerReference {
  groupId: string;
  skillId: string;
  versionHash: string;
  resolutionId: string;
  topic: string;
  questionText: string;
  text: string;
  kind: "clarification" | "change";
  applicabilityVersionHash: string | null;
  state: "acknowledged" | "pending-acknowledgement" | "stale";
}

// A decision is reusable when all of its restatements are current and
// acknowledged. The selected Answer must be one the decision restates.
const REVIEWED_ANSWERS = `
  select distinct s.group_id as "groupId", o.skill_id as "skillId", o.version_hash as "versionHash",
    o.applicability_version_hash as "applicabilityVersionHash", o.kind,
    r.id as "resolutionId", r.revision as "resolutionRevision", q.id as "questionId",
    a.person_id as "personId", a.revision, a.text, qr.content->>'topic' as topic,
    qr.content->>'text' as "questionText",
    case when q.state <> 'confirmed' or q.resolution_revision <> r.revision or q.revision <> r.question_revision
      then 'stale'
    when exists (
      select 1 from confirmed_facts restatement join fact_answer_revisions answered on answered.fact_id = restatement.id
      where restatement.resolution_id = r.id and not exists (
        select 1 from fact_acknowledgements acknowledgement where acknowledgement.fact_id = restatement.id
          and acknowledgement.person_id = answered.person_id and acknowledgement.decision = 'acknowledged'
      )
    ) then 'pending-acknowledgement' else 'acknowledged' end as state
  from effective_skill_question_outcomes o
  join skills s on s.id = o.skill_id
  join question_resolutions r on r.id = o.resolution_id
  join questions q on q.id = r.question_id
  join question_revisions qr on qr.question_id = q.id and qr.revision = r.question_revision
  join confirmed_facts f on f.resolution_id = r.id
  join fact_answer_revisions used on used.fact_id = f.id and used.question_id = q.id
  join answer_revisions a on a.question_id = used.question_id and a.person_id = used.person_id and a.revision = used.revision
  where r.kind = 'confirmed' and a.state = 'submitted'`;

/** The caller supplies a Group the reader can access and its actual pins. */
export async function listReviewedSkillAnswers(
  database: Queryable,
  groupId: string,
  pins: readonly { skillId: string; hash: string }[],
): Promise<ReviewedSkillAnswer[]> {
  if (pins.length === 0) return [];
  const result = await database.query<ReviewedSkillAnswer>(
    `select * from (${REVIEWED_ANSWERS}
      and s.group_id = $1 and q.state = 'confirmed' and q.resolution_revision = r.revision
      and exists (
        select 1 from jsonb_to_recordset($2::jsonb) as pin("skillId" text, hash text)
        where pin."skillId" = o.skill_id and pin.hash = o.applicability_version_hash
      )) answer
     where answer.state = 'acknowledged' order by "skillId", "questionId", "personId", revision`,
    [groupId, JSON.stringify(pins)],
  );
  return result.rows;
}
