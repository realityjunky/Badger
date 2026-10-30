import { canonicalHash, deriveFactoryPlan } from "@realityjunky/badger";
import { planInputs, readPlanVersions } from "../plans.js";
import type { Queryable } from "../database/database.js";
import { listWorkflowPins } from "../workflow-source.js";
import { readVersion } from "../skills/library.js";
import { readSourceStudy, studyReferences } from "../source-study.js";
import { readQuestions, readSettings } from "../questionnaire/store.js";
import { readConcerns } from "../questionnaire/concerns.js";
import { readComments } from "../questionnaire/comments.js";
import { readLedger } from "../questionnaire/ledger.js";
import { readWorkflow, listWorkflowVersions } from "../workflows.js";
import type { DraftingKind } from "./schema.js";

/** Only submitted answers enter Agent context; private answer drafts never do. */
export async function draftingContext(
  tx: Queryable,
  workflowId: string,
  versionId: string,
  personId: string,
) {
  const workflow = await readWorkflow(tx, workflowId);
  const version = (await listWorkflowVersions(tx, workflowId)).find(
    (v) => v.id === versionId,
  )!;
  const pins = [];
  for (const pin of await listWorkflowPins(tx, versionId)) {
    const skill = await readVersion(tx, pin.skillId, pin.hash);
    pins.push({ ...pin, inventory: skill.inventory, scripts: skill.scripts });
  }
  const questions = (await readQuestions(tx, versionId, personId, true)).map(
    ({ canAnswer: _canAnswer, ...q }) => q,
  );
  const answers = await tx.query<{
    question_id: string;
    person_id: string;
    revision: number;
    question_revision: number;
    text: string;
    value: unknown;
    attachments: unknown;
  }>(
    `select a.question_id, a.person_id, a.revision, a.question_revision, a.text, a.value, a.attachments
     from answer_revisions a join questions q on q.id = a.question_id
     where q.workflow_version_id = $1 and a.state = 'submitted' order by a.question_id, a.person_id, a.revision`,
    [versionId],
  );
  const rounds = await tx.query<{
    id: string;
    revision: number;
    state: string;
    title: string;
    number: number;
  }>(
    "select id, revision, state, title, number from question_rounds where workflow_version_id = $1 order by number",
    [versionId],
  );
  const bindings = await tx.query(
    "select id, person_id, email, role from role_bindings where workflow_id = $1 and role in ('Field expert', 'Workflow owner') order by id",
    [workflowId],
  );
  const planningInput = await planInputs(tx, versionId, personId);
  const currentPlan = (await readPlanVersions(tx, versionId))[0];
  const bundle = {
    planning: planningInput
      ? {
          input: planningInput,
          skeleton: deriveFactoryPlan(planningInput),
          basePlanVersionId: currentPlan?.id ?? null,
        }
      : null,
    workflow: { id: workflow!.id, name: workflow!.name, goal: workflow!.goal },
    version,
    pins,
    questions,
    answers: answers.rows,
    rounds: rounds.rows,
    assignees: bindings.rows,
    settings: await readSettings(tx, workflowId),
    sourceStudy: await readSourceStudy(tx, versionId),
    ledger: (await readLedger(tx, versionId, personId, true)).handoff,
    concerns: await readConcerns(tx, versionId),
    comments: await readComments(tx, versionId, true),
  };
  return { bundle, hash: canonicalHash(bundle) };
}

export type DraftingBundle = Awaited<
  ReturnType<typeof draftingContext>
>["bundle"];
export interface DraftingTarget {
  kind: DraftingKind;
  roundId: string | null;
  parentQuestionId: string | null;
  skillId: string | null;
  questionId: string | null;
  locale: string | null;
}

/** The pinned Skill versions whose files a kind's Agent reads. */
export function draftingSkills(bundle: DraftingBundle, target: DraftingTarget) {
  if (target.kind === "source-study" || target.kind === "import-open-questions")
    return bundle.pins.filter((pin) => pin.skillId === target.skillId);
  if (target.kind === "restate-answer" || target.kind === "translate-question")
    return [];
  return bundle.pins;
}

// Code-point order, so a hash never depends on a locale or a collation.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a: { id: string }, b: { id: string }) => compare(a.id, b.id);

/**
 * The part of the context a kind's result depends on. Only a change to it
 * cancels a pending job; the whole bundle's hash guards what the Agent read.
 */
export function draftingInputs(bundle: DraftingBundle, target: DraftingTarget) {
  const pinned = (skills: DraftingBundle["pins"]) =>
    skills
      .map(({ skillId, hash }) => ({ skillId, hash }))
      .sort((a, b) => compare(a.skillId, b.skillId));
  const pin = pinned(draftingSkills(bundle, target))[0] ?? null;
  // A round's state decides whether drafts may join it; the questions in it
  // count only for the kinds that read them.
  const round = bundle.rounds.find((r) => r.id === target.roundId);
  const draftRound = round ? { id: round.id, state: round.state } : null;
  const question = (id: string | null) => {
    const q = bundle.questions.find((q) => q.id === id);
    return q
      ? {
          id: q.id,
          revision: q.revision,
          state: q.state,
          resolutionRevision: q.resolutionRevision,
        }
      : null;
  };
  // Each person's latest submitted answer revision to the question.
  const answerHeads = (id: string | null) => {
    const heads = new Map<
      string,
      { personId: string; revision: number; questionRevision: number }
    >();
    for (const a of bundle.answers)
      if (
        a.question_id === id &&
        a.revision > (heads.get(a.person_id)?.revision ?? 0)
      )
        heads.set(a.person_id, {
          personId: a.person_id,
          revision: a.revision,
          questionRevision: a.question_revision,
        });
    return [...heads.values()].sort((a, b) => compare(a.personId, b.personId));
  };
  switch (target.kind) {
    case "source-study":
      return {
        pin,
        records: [...bundle.sourceStudy.facts, ...bundle.sourceStudy.interfaces]
          .filter((r) =>
            studyReferences(r.content).some(
              (ref) => ref.skillId === target.skillId,
            ),
          )
          .map(({ id, revision, status }) => ({ id, revision, status }))
          .sort(byId),
      };
    case "import-open-questions":
      return {
        pin,
        round: draftRound,
        imports: bundle.questions
          .flatMap(({ id, source }) =>
            pin &&
            source &&
            source.skillId === pin.skillId &&
            source.hash === pin.hash
              ? [{ id, path: source.path, number: source.number }]
              : [],
          )
          .sort(byId),
      };
    case "translate-question": {
      const translated = question(target.questionId);
      return {
        question: translated && {
          id: translated.id,
          revision: translated.revision,
        },
        locale: target.locale,
      };
    }
    case "restate-answer":
      return {
        question: question(target.questionId),
        answers: answerHeads(target.questionId),
      };
    case "draft-follow-ups":
      // Follow-ups may cite any pinned file, as their claim ships them all.
      return {
        pins: pinned(bundle.pins),
        round: draftRound,
        parent: question(target.parentQuestionId),
        answers: answerHeads(target.parentQuestionId),
      };
    case "draft-questions":
      return {
        pins: pinned(bundle.pins),
        round: draftRound,
        questions: bundle.questions.map(({ id, revision, state }) => ({
          id,
          revision,
          state,
        })),
      };
    case "draft-plan":
      return {
        planning: bundle.planning && {
          input: bundle.planning.input,
          basePlanVersionId: bundle.planning.basePlanVersionId,
        },
      };
  }
}

export function draftingInputHash(
  bundle: DraftingBundle,
  target: DraftingTarget,
) {
  return canonicalHash(draftingInputs(bundle, target));
}
