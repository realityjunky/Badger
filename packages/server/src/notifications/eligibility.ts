import { accessFor } from "../authorization.js";
import type { ServiceConfig } from "../config.js";
import type { Queryable } from "../database/database.js";
import { readPersonById } from "../people.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { readQuestions } from "../questionnaire/store.js";
import { workflowCapabilities } from "../workflow-access.js";
import { readWorkflow } from "../workflows.js";
import type { NotificationItemRow } from "./events.js";

/** Resolve current capabilities through the same authorities as HTTP reads and writes. */
export async function eligibleNotificationItems(
  tx: Queryable,
  config: ServiceConfig,
  items: NotificationItemRow[],
) {
  const eligible: NotificationItemRow[] = [];
  for (const item of items) {
    // Pending invitations still own their in-app item through a live binding.
    if (item.person_id === null) {
      if (item.binding_id !== null) eligible.push(item);
      continue;
    }
    const person = await readPersonById(tx, item.person_id);
    if (person === null || person.status !== "active") continue;
    const workflow = await readWorkflow(tx, item.workflow_id);
    if (workflow === null) continue;
    const access = await accessFor(tx, person, null, config);
    const capabilities = await workflowCapabilities(
      tx,
      access,
      person,
      workflow,
    );
    if (!capabilities.read) continue;
    const questionnaire = await questionnaireCapabilities(
      tx,
      access,
      person,
      workflow.id,
    );
    let canAct: boolean;
    switch (item.kind) {
      case "question-assigned":
        canAct =
          questionnaire.answer &&
          (
            await readQuestions(tx, item.workflow_version_id, person.id, false)
          ).some(
            (question) =>
              question.id === item.question_id && question.canAnswer,
          );
        break;
      case "restatement-ready":
        canAct = questionnaire.acknowledge;
        break;
      case "answer-submitted":
      case "question-reopened":
      case "concern-raised":
      case "job-submitted":
        canAct = questionnaire.compose;
        break;
      case "gate-ready":
        canAct =
          item.gate === "dossier"
            ? capabilities.approveDossier
            : item.gate === "plan"
              ? capabilities.approvePlan
              : capabilities.confirmSources;
        break;
      case "gate-invalidated":
        canAct = questionnaire.compose || capabilities.approveDossier;
        break;
    }
    if (canAct) eligible.push(item);
  }
  return eligible;
}
