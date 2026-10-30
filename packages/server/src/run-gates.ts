import {
  canonicalHash,
  type WorkflowProtocol,
  type WorkflowReviewerPolicy,
} from "@realityjunky/badger";
import {
  prepareWorkflowGateAnswer,
  workflowGateBinding,
  workflowGatePolicy,
  parseWorkflowFinalizationPreview,
  type WorkflowContinuation,
  type WorkflowGateAnswer,
} from "@realityjunky/badger/workflow-runtime";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import type { Person } from "./people.js";
import { readPersonById } from "./people.js";
import { readPublishedPackage } from "./publications.js";
import { RequestError } from "./http/errors.js";
import { recordAudit, type WriteContext } from "./audit.js";

export interface RunGateRow {
  id: string;
  run_id: string;
  workflow_version_id: string;
  binding_hash: string;
  context: WorkflowContinuation;
  policy: WorkflowReviewerPolicy;
  state: "open" | "answered" | "superseded";
  created_at: Date | string;
}
const AUTHORITIES: Record<string, string> = {
  "Workflow owner": "workflow-owner",
  Engineer: "engineer",
  "Field expert": "field-expert",
  Reviewer: "reviewer",
  Operator: "operator",
};

function attestRoles(
  roles: string[],
  policy: WorkflowReviewerPolicy,
  subject?: string,
) {
  const authorities = [
    ...new Set(
      roles.flatMap((role) => (AUTHORITIES[role] ? [AUTHORITIES[role]] : [])),
    ),
  ].sort();
  const required = policy.authorities?.length
    ? policy.authorities
    : ["operator"];
  if (
    authorities.length === 0 ||
    required.some((authority) => !authorities.includes(authority)) ||
    (policy.subjects?.length &&
      (subject === undefined || !policy.subjects.includes(subject)))
  )
    return null;
  return { subject, authorities };
}

/** Only Badger's current workflow roles confer a review authority. Subjects are
 * stable Badger person IDs, never an email or a provider's unscoped subject. */
export async function runGateReviewer(
  tx: Queryable,
  workflowId: string,
  person: Person,
  policy: WorkflowReviewerPolicy,
) {
  if (person.status !== "active") return null;
  const roles = await tx.query<{ role: string }>(
    "select role from role_bindings where workflow_id=$1 and person_id=$2",
    [workflowId, person.id],
  );
  const reviewer = attestRoles(
    roles.rows.map(({ role }) => role),
    policy,
    person.id,
  );
  return reviewer === null ? null : { ...reviewer, subject: person.id };
}

export async function eligibleRunGateInvitation(
  tx: Queryable,
  gateId: string,
  bindingId: string,
) {
  const row = (
    await tx.query<{ policy: WorkflowReviewerPolicy; roles: string[] }>(
      `select g.policy,array_agg(distinct roles.role) as roles from run_gates g
     join workflow_runs r on r.id=g.run_id join role_bindings binding on binding.id=$2 and binding.workflow_id=r.workflow_id
     join role_bindings roles on roles.workflow_id=r.workflow_id and roles.person_id is null and lower(roles.email)=lower(binding.email)
     where g.id=$1 and g.state='open' and binding.person_id is null group by g.policy`,
      [gateId, bindingId],
    )
  ).rows[0];
  return row !== undefined && attestRoles(row.roles, row.policy) !== null;
}

export async function eligibleRunGateRecipient(
  tx: Queryable,
  gateId: string,
  person: Person,
) {
  const row = (
    await tx.query<RunGateRow & { workflow_id: string }>(
      "select g.*,r.workflow_id from run_gates g join workflow_runs r on r.id=g.run_id where g.id=$1",
      [gateId],
    )
  ).rows[0];
  return (
    row?.state === "open" &&
    (await runGateReviewer(tx, row.workflow_id, person, row.policy)) !== null
  );
}

/** Called while the reporting transaction holds the Run row lock. */
export async function syncRunGate(
  tx: Queryable,
  deps: ServiceDependencies,
  run: {
    id: string;
    workflow_id: string;
    publication_id: string;
    package_hash: string;
  },
  current: WorkflowContinuation,
) {
  const action = current.pendingAction;
  if (action?.finalization) {
    try {
      const preview = parseWorkflowFinalizationPreview(
        current.finalizationPreview,
      );
      if (
        preview.planHash !== action.finalization.planHash ||
        preview.runId !== current.runId ||
        canonicalHash(preview.execution) !== canonicalHash(current.execution)
      )
        throw new Error("The finalization preview does not bind this Run gate");
    } catch (error) {
      throw new RequestError(
        400,
        error instanceof Error ? error.message : "Invalid finalization preview",
      );
    }
  }
  const bindingHash = canonicalHash(workflowGateBinding(current));
  const closed = await tx.query<{ id: string }>(
    "update run_gates set state='superseded' where run_id=$1 and state='open' and binding_hash<>$2 returning id",
    [run.id, bindingHash],
  );
  for (const gate of closed.rows) await closeRunGateInbox(tx, deps, gate.id);
  if (action?.type !== "ask_user" || !action.decisionId) return;
  if (
    (
      await tx.query(
        "select id from run_gates where run_id=$1 and binding_hash=$2",
        [run.id, bindingHash],
      )
    ).rows.length
  )
    return;
  const published = await readPublishedPackage(
    tx,
    run.workflow_id,
    run.publication_id,
    run.package_hash,
  );
  const file = published.snapshot.files.find(
    (file) => file.path === "reference/workflow-protocol.json",
  );
  if (!file) throw new RequestError(409, "Published protocol is missing");
  const protocol = JSON.parse(
    Buffer.from(file.content, "base64").toString("utf8"),
  ) as WorkflowProtocol;
  const policy = workflowGatePolicy(protocol, current);
  // The package owns authority. A client report cannot widen the policy.
  const normalized = (value: WorkflowReviewerPolicy) => ({
    subjects: [...(value.subjects ?? [])].sort(),
    authorities: [...(value.authorities ?? [])].sort(),
  });
  if (
    canonicalHash(normalized(policy)) !==
    canonicalHash(normalized(action.reviewer ?? {}))
  )
    throw new RequestError(
      409,
      "The reported gate reviewer policy differs from the published package",
    );
  const id = deps.ids.next();
  await tx.query(
    "insert into run_gates(id,run_id,workflow_version_id,binding_hash,context,policy,state,created_at) values($1,$2,$3,$4,$5::jsonb,$6::jsonb,'open',$7)",
    [
      id,
      run.id,
      published.publication.workflowVersionId,
      bindingHash,
      JSON.stringify(current),
      JSON.stringify(policy),
      deps.clock.now(),
    ],
  );
  const people = await tx.query<{ person_id: string }>(
    "select distinct person_id from role_bindings where workflow_id=$1 and person_id is not null",
    [run.workflow_id],
  );
  for (const { person_id } of people.rows) {
    const person = await readPersonById(tx, person_id);
    if (person && (await runGateReviewer(tx, run.workflow_id, person, policy)))
      await tx.query(
        "insert into inbox_items(id,person_id,workflow_version_id,gate,kind,event_id,run_gate_id,created_at,updated_at) values($1,$2,$3,$4,'gate-ready',$5,$5,$6,$6) on conflict do nothing",
        [
          deps.ids.next(),
          person.id,
          published.publication.workflowVersionId,
          `run:${id}`,
          id,
          deps.clock.now(),
        ],
      );
  }
  const invitations = await tx.query<{ binding_id: string; roles: string[] }>(
    "select min(id) as binding_id,array_agg(distinct role) as roles from role_bindings where workflow_id=$1 and person_id is null group by lower(email)",
    [run.workflow_id],
  );
  for (const invitation of invitations.rows) {
    if (attestRoles(invitation.roles, policy) === null) continue;
    await tx.query(
      "insert into inbox_items(id,binding_id,workflow_version_id,gate,kind,event_id,run_gate_id,created_at,updated_at) values($1,$2,$3,$4,'gate-ready',$5,$5,$6,$6) on conflict do nothing",
      [
        deps.ids.next(),
        invitation.binding_id,
        published.publication.workflowVersionId,
        `run:${id}`,
        id,
        deps.clock.now(),
      ],
    );
  }
}

async function closeRunGateInbox(
  tx: Queryable,
  deps: ServiceDependencies,
  gateId: string,
) {
  await tx.query(
    "update inbox_items set state='done',revision=revision+1,updated_at=$2 where run_gate_id=$1 and state<>'done'",
    [gateId, deps.clock.now()],
  );
}

export async function previewRunGateAnswer(
  tx: Queryable,
  workflowId: string,
  gate: RunGateRow,
  person: Person,
  answer: WorkflowGateAnswer,
) {
  const reviewer = await runGateReviewer(tx, workflowId, person, gate.policy);
  if (!reviewer)
    throw new RequestError(
      403,
      "This person does not hold the gate's required authority",
    );
  let submission;
  try {
    submission = prepareWorkflowGateAnswer(gate.context, answer, reviewer);
  } catch (error) {
    throw new RequestError(
      400,
      error instanceof Error ? error.message : "Invalid gate answer",
    );
  }
  return {
    gateId: gate.id,
    bindingHash: gate.binding_hash,
    submission,
    confirmationHash: canonicalHash({
      gateId: gate.id,
      bindingHash: gate.binding_hash,
      actorId: person.id,
      submission,
    }),
  };
}

export async function answerRunGate(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  gate: RunGateRow,
  preview: Awaited<ReturnType<typeof previewRunGateAnswer>>,
  requestId: string,
) {
  const answer = {
    gateId: gate.id,
    actorId: context.personId,
    answeredAt: deps.clock.now().toISOString(),
    bindingHash: gate.binding_hash,
    submission: preview.submission,
  };
  const inserted = await tx.query(
    "insert into run_gate_answers(gate_id,actor_id,request_id,confirmation_hash,answer,answered_at) values($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing returning gate_id",
    [
      gate.id,
      context.personId,
      requestId,
      preview.confirmationHash,
      JSON.stringify(answer),
      deps.clock.now(),
    ],
  );
  if (inserted.rowCount === 0)
    throw new RequestError(
      409,
      "This gate or request ID already has an answer",
    );
  await tx.query("update run_gates set state='answered' where id=$1", [
    gate.id,
  ]);
  await closeRunGateInbox(tx, deps, gate.id);
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "run_gate.answered",
    target: { type: "run_gate", id: gate.id },
    before: { revision: null, hash: gate.binding_hash },
    after: { revision: 1, hash: preview.confirmationHash },
    reason: preview.submission.rationale ?? null,
    requestId: context.requestId,
  });
  return { answer };
}
