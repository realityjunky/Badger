import { canonicalHash, type WorkflowRunReport } from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import { RequestError } from "./http/errors.js";
import { createHash } from "node:crypto";

export type RunIntegrityCode =
  "unattested-decision" | "event-sequence-gap" | "package-hash-mismatch";
export interface RunIntegrityFinding {
  code: RunIntegrityCode;
  message: string;
  evidence: Record<string, unknown>;
  detectedAt: string;
}
export interface RunRecovery {
  requestId: string;
  noticeId: string | null;
  outcome: "settled" | "blocked";
  revision: number;
  lastSequence: number;
  reportedAt: string;
}
export interface RunIntegrityRow {
  id: string;
  integrity_findings: RunIntegrityFinding[];
  recovery_required: boolean;
  recovery: RunRecovery | null;
  recovery_notice_id: string | null;
}
export interface RunRecoveryRequest {
  requestId: string;
  noticeId: string | null;
}
export function runRecoveryRequests(value: unknown): RunRecoveryRequest[] {
  if (value === undefined) return [];
  const id = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(
      (r) =>
        r &&
        typeof r === "object" &&
        !Array.isArray(r) &&
        id(r.requestId) &&
        (r.noticeId === null || id(r.noticeId)) &&
        Object.keys(r).every((key) => ["requestId", "noticeId"].includes(key)),
    )
  )
    throw new RequestError(
      400,
      "Send at most 64 bounded recovery requests bound to their notice",
    );
  return value as RunRecoveryRequest[];
}
const messages: Record<RunIntegrityCode, string> = {
  "unattested-decision":
    "A Run decision has no matching dashboard gate answer.",
  "event-sequence-gap": "The reported Run events have a sequence gap.",
  "package-hash-mismatch":
    "The reported execution differs from the published package.",
};
export class RunIntegrityError extends RequestError {
  constructor(
    public readonly code: RunIntegrityCode,
    public readonly evidence: Record<string, unknown>,
  ) {
    super(409, messages[code]);
  }
}

async function auditIntegrity(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  runId: string,
  action: string,
  before: unknown,
  after: unknown,
  reason: string,
) {
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action,
    target: { type: "run", id: runId },
    before:
      before === null ? null : { revision: null, hash: canonicalHash(before) },
    after:
      after === null ? null : { revision: null, hash: canonicalHash(after) },
    reason,
    requestId: context.requestId,
  });
}

/** The caller holds the Run row lock. Retries do not duplicate findings/audit. */
export async function flagRunIntegrity(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  row: RunIntegrityRow,
  code: RunIntegrityCode,
  evidence: Record<string, unknown>,
) {
  const previous = row.integrity_findings.find((f) => f.code === code);
  if (
    previous &&
    code === "event-sequence-gap" &&
    Number(previous.evidence.received) >= Number(evidence.received)
  )
    return;
  if (previous && canonicalHash(previous.evidence) === canonicalHash(evidence))
    return;
  const finding = {
    code,
    message: messages[code],
    evidence,
    detectedAt: deps.clock.now().toISOString(),
  };
  row.integrity_findings = [
    ...row.integrity_findings.filter((f) => f.code !== code),
    finding,
  ];
  await tx.query(
    "update workflow_runs set integrity_findings=$2::jsonb,updated_at=$3 where id=$1",
    [row.id, JSON.stringify(row.integrity_findings), deps.clock.now()],
  );
  await auditIntegrity(
    tx,
    deps,
    context,
    row.id,
    "run.integrity_detected",
    previous ?? null,
    finding,
    `${finding.message} ${JSON.stringify(evidence)}`,
  );
}

export async function reconcileRunIntegrity(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  row: RunIntegrityRow,
  lastSequence: number,
) {
  const resolved = row.integrity_findings.filter(
    (f) =>
      f.code === "package-hash-mismatch" ||
      (f.code === "event-sequence-gap" &&
        lastSequence >= Number(f.evidence.received)),
  );
  for (const finding of resolved)
    await auditIntegrity(
      tx,
      deps,
      context,
      row.id,
      "run.integrity_resolved",
      finding,
      null,
      finding.message,
    );
  row.integrity_findings = row.integrity_findings.filter(
    (f) => !resolved.includes(f),
  );
}

export function needsRunRecovery(row: RunIntegrityRow) {
  return row.recovery_required || row.integrity_findings.length > 0;
}

export async function recordRunRecoveries(
  tx: Queryable,
  deps: ServiceDependencies,
  context: WriteContext,
  row: RunIntegrityRow,
  requests: RunRecoveryRequest[],
  report: Pick<WorkflowRunReport, "lastSequence" | "continuation">,
) {
  for (const { requestId, noticeId } of requests) {
    const recovery: RunRecovery = {
      requestId,
      noticeId,
      outcome: needsRunRecovery(row) ? "blocked" : "settled",
      revision: report.continuation.revision,
      lastSequence: report.lastSequence,
      reportedAt: deps.clock.now().toISOString(),
    };
    const inserted = await tx.query(
      "insert into run_recoveries(run_id,request_id,result) values($1,$2,$3::jsonb) on conflict do nothing",
      [row.id, requestId, JSON.stringify(recovery)],
    );
    if (inserted.rowCount === 0) continue;
    await auditIntegrity(
      tx,
      deps,
      context,
      row.id,
      "run.recovered",
      row.recovery,
      recovery,
      `Local recovery ${recovery.outcome}.`,
    );
    row.recovery = recovery;
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Compare service-owned answer evidence with the original trajectory. This
 * checks provenance only; WorkflowRuntime still owns every legal transition. */
export async function hasMatchingRunGateAnswer(
  tx: Queryable,
  runId: string,
  event: Record<string, unknown>,
) {
  const data = object(event.data);
  const outcome = object(data?.outcome);
  const action = object(data?.action);
  if (event.type !== "action_completed") return true;
  if (!outcome) return action?.type !== "ask_user" && !data?.decisionReceipt;
  const repair = object(outcome.repairDecision);
  if (
    outcome.kind !== "decision" &&
    !repair &&
    !data?.decisionReceipt &&
    action?.type !== "ask_user"
  )
    return true;
  const answers = await tx.query<{
    context: WorkflowRunReport["continuation"];
    answer: { submission: Record<string, unknown> };
  }>(
    "select g.context,a.answer from run_gates g join run_gate_answers a on a.gate_id=g.id where g.run_id=$1 and g.context->'pendingAction'->>'id'=$2",
    [runId, outcome.actionId],
  );
  return answers.rows.some(({ context, answer }) => {
    const submission = answer.submission;
    if (canonicalHash(action) !== canonicalHash(context.pendingAction))
      return false;
    if (outcome.actionId !== submission.actionId) return false;
    if (
      repair &&
      ["revision", "nodeId", "cycleId", "attemptId"].some(
        (key) =>
          canonicalHash(outcome[key] ?? null) !==
          canonicalHash(submission[key] ?? null),
      )
    )
      return false;
    const finalizationConfirmation = object(data?.finalizationConfirmation);
    if (finalizationConfirmation) {
      const rationaleHash =
        submission.rationale == null
          ? null
          : createHash("sha256")
              .update(String(submission.rationale).trim())
              .digest("hex");
      if (
        !context.pendingAction?.finalization ||
        finalizationConfirmation.actionId !== submission.actionId ||
        finalizationConfirmation.revision !== submission.revision ||
        finalizationConfirmation.planHash !==
          context.pendingAction.finalization.planHash ||
        finalizationConfirmation.decisionId !== submission.decisionId ||
        finalizationConfirmation.choiceId !== submission.choiceId ||
        (outcome.rationale !== undefined &&
          outcome.rationale !== submission.rationale) ||
        canonicalHash(finalizationConfirmation.reviewer) !==
          canonicalHash(submission.reviewer) ||
        finalizationConfirmation.rationaleHash !== rationaleHash
      )
        return false;
    }
    const receipt = object(data?.decisionReceipt);
    if (
      receipt &&
      (receipt.runId !== context.runId ||
        ["protocolHash", "packageHash", "snapshotHash"].some(
          (key) =>
            receipt[key] !==
            context.execution[key as keyof typeof context.execution],
        ) ||
        [
          "revision",
          "nodeId",
          "cycleId",
          "attemptId",
          "actionId",
          "decisionId",
          "choiceId",
          "reviewer",
          "inputs",
          "rationale",
          "scope",
          "evidenceReferences",
        ].some(
          (key) =>
            canonicalHash(receipt[key] ?? (key === "inputs" ? {} : null)) !==
            canonicalHash(submission[key] ?? (key === "inputs" ? {} : null)),
        ))
    )
      return false;
    if (
      repair &&
      (repair.decisionId !== submission.decisionId ||
        repair.signatureHash !== context.pendingAction?.repair?.signatureHash ||
        canonicalHash(repair.hypothesis ?? null) !==
          canonicalHash(object(submission.repair)?.hypothesis ?? null))
    )
      return false;
    const evidence = repair ?? outcome;
    const keys = repair
      ? ["choiceId", "reviewer", "rationale"]
      : context.pendingAction?.finalization
        ? [
            "decisionId",
            "reviewer",
            ...(finalizationConfirmation ? [] : ["rationale"]),
            "finalization",
          ]
        : [
            "revision",
            "nodeId",
            "cycleId",
            "attemptId",
            "decisionId",
            "choiceId",
            "reviewer",
            "inputs",
            "rationale",
            "scope",
            "evidenceReferences",
          ];
    return (
      outcome.status === "succeeded" &&
      keys.every(
        (key) =>
          canonicalHash(evidence[key] ?? (key === "inputs" ? {} : null)) ===
          canonicalHash(submission[key] ?? (key === "inputs" ? {} : null)),
      )
    );
  });
}
