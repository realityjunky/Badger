import { canonicalHash, deriveFactoryPlan } from "@realityjunky/badger";
import { planInputs, readPlanVersions } from "../plans.js";
import type { Queryable } from "../database/database.js";
import { listWorkflowPins } from "../workflow-source.js";
import { readVersion } from "../skills/library.js";
import { readSourceStudy } from "../source-study.js";
import { readQuestions, readSettings } from "../questionnaire/store.js";
import { readConcerns } from "../questionnaire/concerns.js";
import { readComments } from "../questionnaire/comments.js";
import { readLedger } from "../questionnaire/ledger.js";
import { readWorkflow, listWorkflowVersions } from "../workflows.js";

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
  const answers = await tx.query(
    `select a.question_id, a.person_id, a.revision, a.question_revision, a.text, a.value, a.attachments
     from answer_revisions a join questions q on q.id = a.question_id
     where q.workflow_version_id = $1 and a.state = 'submitted' order by a.question_id, a.person_id, a.revision`,
    [versionId],
  );
  const rounds = await tx.query(
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
