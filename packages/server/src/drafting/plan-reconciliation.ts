import {
  canonicalHash,
  reconcilePlanDraft,
  type PlanConflictChoice,
} from "@realityjunky/badger";
import type { Queryable } from "../database/database.js";
import { objectInput, RequestError } from "../http/errors.js";
import { readPlanHead } from "../plans.js";
import { fields } from "../questionnaire/model.js";
import type { DraftingJobRow } from "./jobs.js";

export interface PlanReconciliation {
  headVersionId: string;
  choices: Record<string, PlanConflictChoice>;
  editedFromHash?: string;
}

export async function reviewPlanReconciliation(
  tx: Queryable,
  job: DraftingJobRow,
  value: unknown,
  decision?: { plan: unknown },
) {
  const input = objectInput(value);
  fields(input, [
    "headVersionId",
    "choices",
    ...(decision ? ["editedFromHash"] : []),
  ]);
  const base = job.context_bundle.authoringFollowUp?.basePlan;
  const result = job.review_result ?? job.result;
  if (
    !job.reconciliationHeadId ||
    input.headVersionId !== job.reconciliationHeadId ||
    !base ||
    !result ||
    !("plan" in result)
  )
    throw new RequestError(
      409,
      "The plan or drafting inputs changed. Reopen the draft against the current plan.",
    );
  const head = await readPlanHead(tx, job.workflow_version_id);
  if (
    !head ||
    head.id !== job.reconciliationHeadId ||
    head.snapshot.dossierHash !== job.context_bundle.planning?.input.dossierHash
  )
    throw new RequestError(
      409,
      "The current plan changed. Review the draft again.",
    );
  const choices: Record<string, PlanConflictChoice> = Object.create(null);
  for (const [path, choice] of Object.entries(objectInput(input.choices))) {
    if (choice === "current" || choice === "draft") choices[path] = choice;
    else {
      const custom = objectInput(choice);
      fields(custom, ["text"]);
      if (typeof custom.text !== "string")
        throw new RequestError(
          400,
          "Choose a conflict value or enter revised text.",
        );
      choices[path] = { text: custom.text };
    }
  }
  const { plan, conflicts } = reconcilePlanDraft(
    base.plan,
    head.snapshot.plan,
    result.plan,
    choices,
  );
  const byPath = new Map(conflicts.map((item) => [item.path, item]));
  for (const [path, choice] of Object.entries(choices)) {
    const conflict = byPath.get(path);
    if (
      !conflict ||
      (typeof choice === "object" &&
        (typeof conflict.current !== "string" ||
          typeof conflict.draft !== "string"))
    )
      throw new RequestError(
        400,
        "Choose a value for a current plan conflict.",
      );
  }
  const combinedPlanHash = canonicalHash(plan);
  if (
    input.editedFromHash !== undefined &&
    input.editedFromHash !== combinedPlanHash
  )
    throw new RequestError(
      409,
      "The combined plan changed. Review it again before editing.",
    );
  if (
    decision &&
    (conflicts.some(({ path }) => !Object.hasOwn(choices, path)) ||
      !decision.plan ||
      (input.editedFromHash === undefined &&
        combinedPlanHash !== canonicalHash(decision.plan)))
  )
    throw new RequestError(
      409,
      "Resolve every conflict and review the exact reconciled plan before accepting.",
    );
  return {
    plan,
    conflicts,
    combinedPlanHash,
    reconciliation: {
      headVersionId: head.id,
      choices,
      ...(input.editedFromHash !== undefined && {
        editedFromHash: combinedPlanHash,
      }),
    },
  };
}
