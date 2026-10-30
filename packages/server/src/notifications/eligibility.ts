import { accessFor } from "../authorization.js";
import type { ServiceConfig } from "../config.js";
import type { Queryable } from "../database/database.js";
import { readPersonById } from "../people.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { readQuestions } from "../questionnaire/store.js";
import { workflowCapabilities } from "../workflow-access.js";
import { readWorkflow } from "../workflows.js";
import type { NotificationItemRow } from "./events.js";

/** Loads each value once per call, however many items share it. */
function loadOnce() {
  const loaded = new Map<string, Promise<unknown>>();
  return <T>(key: readonly string[], load: () => Promise<T>): Promise<T> => {
    const id = JSON.stringify(key);
    let value = loaded.get(id) as Promise<T> | undefined;
    if (value === undefined) {
      value = load();
      loaded.set(id, value);
    }
    return value;
  };
}

/** Resolve current capabilities through the same authorities as HTTP reads and writes. */
export async function eligibleNotificationItems(
  tx: Queryable,
  config: ServiceConfig,
  items: NotificationItemRow[],
) {
  // A person's access, roles, and answerable questions are resolved once,
  // not once per item: a Round gives each expert an item per question.
  const once = loadOnce();
  const eligible: NotificationItemRow[] = [];
  for (const item of items) {
    // Pending invitations still own their in-app item through a live binding.
    if (item.person_id === null) {
      if (item.binding_id !== null) eligible.push(item);
      continue;
    }
    const personId = item.person_id;
    const person = await once(["person", personId], () =>
      readPersonById(tx, personId),
    );
    if (person === null || person.status !== "active") continue;
    const workflow = await once(["workflow", item.workflow_id], () =>
      readWorkflow(tx, item.workflow_id),
    );
    if (workflow === null) continue;
    const access = await once(["access", personId], () =>
      accessFor(tx, person, null, config),
    );
    const capabilities = await once(
      ["capabilities", personId, workflow.id],
      () => workflowCapabilities(tx, access, person, workflow),
    );
    if (!capabilities.read) continue;
    const questionnaire = await once(
      ["questionnaire", personId, workflow.id],
      () => questionnaireCapabilities(tx, access, person, workflow.id),
    );
    let canAct: boolean;
    switch (item.kind) {
      case "question-assigned":
        canAct =
          questionnaire.answer &&
          item.question_id !== null &&
          (
            await once(
              ["answerable", item.workflow_version_id, personId],
              async () =>
                new Set(
                  (
                    await readQuestions(
                      tx,
                      item.workflow_version_id,
                      personId,
                      false,
                    )
                  )
                    .filter((question) => question.canAnswer)
                    .map((question) => question.id),
                ),
            )
          ).has(item.question_id);
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
            : item.gate === "proposal"
              ? capabilities.approveProposal
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
