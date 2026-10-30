import { canonicalHash } from "@realityjunky/badger";
import {
  workflowGateBinding,
  type WorkflowContinuation,
  type WorkflowGateAnswer,
  type WorkflowDecisionSubmission,
} from "@realityjunky/badger/workflow-runtime";
import type { Queryable } from "../database/database.js";
import {
  answerRunGate,
  previewRunGateAnswer,
  runGateReviewer,
  type RunGateRow,
} from "../run-gates.js";
import { fields } from "../questionnaire/model.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { RequestError } from "./errors.js";

export async function handleRunGates(
  input: AuthorizedRequest,
  tx: Queryable,
  run: {
    id: string;
    workflow_id: string;
    continuation: WorkflowContinuation | null;
  },
  gateId: string | undefined,
  action: string | undefined,
  body: Record<string, unknown>,
) {
  const gates = (
    await tx.query<RunGateRow & { answer: unknown }>(
      "select g.*,a.answer from run_gates g left join run_gate_answers a on a.gate_id=g.id where g.run_id=$1 and ($2::text is null or g.id=$2) order by g.created_at desc,g.id desc limit 100",
      [run.id, gateId ?? null],
    )
  ).rows;
  if (!action) {
    const result = [];
    for (const gate of gates)
      result.push({
        id: gate.id,
        state: gate.state,
        bindingHash: gate.binding_hash,
        revision: gate.context.revision,
        actionId: gate.context.pendingAction!.id,
        pendingAction: gate.context.pendingAction,
        finalizationPreview: gate.context.finalizationPreview ?? null,
        policy: gate.policy,
        answer: gate.answer,
        canAnswer:
          input.access.tokenScopes === undefined &&
          gate.state === "open" &&
          (await runGateReviewer(
            tx,
            run.workflow_id,
            input.person,
            gate.policy,
          )) !== null,
      });
    return { gates: result };
  }
  if (input.access.tokenScopes !== undefined)
    throw new RequestError(
      403,
      "Only a signed-in person may answer a Run gate",
    );
  const gate = gates.find((gate) => gate.id === gateId);
  if (!gate) throw new RequestError(404, "No such Run gate");
  fields(
    body,
    action === "preview"
      ? ["choiceId", "inputs", "rationale"]
      : [
          "choiceId",
          "inputs",
          "rationale",
          "confirmed",
          "confirmationHash",
          "requestId",
        ],
  );
  const answer = Object.fromEntries(
    Object.entries(body).filter(([key]) =>
      ["choiceId", "inputs", "rationale"].includes(key),
    ),
  ) as unknown as WorkflowGateAnswer;
  if (action === "answer") {
    if (
      body.confirmed !== true ||
      typeof body.confirmationHash !== "string" ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(body.requestId)
    )
      throw new RequestError(
        400,
        "Confirm the preview hash with a client requestId",
      );
    const previous = (
      await tx.query<{
        gate_id: string;
        confirmation_hash: string;
        answer: { submission: WorkflowDecisionSubmission };
      }>(
        "select gate_id,confirmation_hash,answer from run_gate_answers where actor_id=$1 and request_id=$2",
        [input.person.id, body.requestId],
      )
    ).rows[0];
    if (previous) {
      const submittedAnswer = Object.fromEntries(
        Object.entries(previous.answer.submission).filter(([key]) =>
          ["choiceId", "inputs", "rationale"].includes(key),
        ),
      );
      if (
        previous.gate_id !== gate.id ||
        previous.confirmation_hash !== body.confirmationHash ||
        canonicalHash(submittedAnswer) !== canonicalHash(answer)
      )
        throw new RequestError(
          409,
          "The request ID already binds a different answer",
        );
      return { answer: previous.answer };
    }
  }
  const preview = await previewRunGateAnswer(
    tx,
    run.workflow_id,
    gate,
    input.person,
    answer,
  );
  if (action === "answer" && preview.confirmationHash !== body.confirmationHash)
    throw new RequestError(409, "The answer changed; review it again");
  if (
    gate.state !== "open" ||
    !run.continuation ||
    canonicalHash(workflowGateBinding(run.continuation)) !== gate.binding_hash
  )
    throw new RequestError(409, "This gate is no longer waiting for an answer");
  return action === "preview"
    ? { preview }
    : answerRunGate(
        tx,
        input.dependencies,
        input.context,
        gate,
        preview,
        body.requestId as string,
      );
}

export async function readRunGateAnswer(
  tx: Queryable,
  run: { id: string; continuation: WorkflowContinuation | null },
) {
  if (!run.continuation) return { answer: null };
  const row = (
    await tx.query<{ answer: unknown }>(
      "select a.answer from run_gate_answers a join run_gates g on g.id=a.gate_id where g.run_id=$1 and g.binding_hash=$2 and g.state='answered'",
      [run.id, canonicalHash(workflowGateBinding(run.continuation))],
    )
  ).rows[0];
  return { answer: row?.answer ?? null };
}
