import { canonicalHash, type WorkflowRunReport } from "@realityjunky/badger";
import { verifyWorkflowProtocol } from "@realityjunky/badger/workflow-runtime";
import { readPublishedPackage } from "../publications.js";
import { readWorkflow } from "../workflows.js";
import { workflowCapabilities } from "../workflow-access.js";
import { isAdministrator } from "../authorization.js";
import type { Queryable } from "../database/database.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { RequestError, objectInput } from "./errors.js";
import { readJsonBody } from "./body.js";
import { fields } from "../questionnaire/model.js";
import { recordAudit } from "../audit.js";
import { toIsoString } from "../util.js";
import { validateRunReadModels } from "../run-report.js";
import { syncRunGate } from "../run-gates.js";
import { handleRunGates, readRunGateAnswer } from "./run-gates.js";
import {
  flagRunIntegrity,
  hasMatchingRunGateAnswer,
  needsRunRecovery,
  reconcileRunIntegrity,
  recordRunRecoveries,
  RunIntegrityError,
  type RunIntegrityRow,
} from "../run-integrity.js";

const ID = /^[A-Za-z0-9_-]{1,200}$/u;
const RUN =
  /^\/api\/v1\/runs\/([^/]+)(?:\/(events|access|gate-answer|gates|recovery)(?:\/([^/]+)\/(preview|answer))?)?$/u;
const LIST = /^\/api\/v1\/workflows\/([^/]+)\/runs$/u;
const ACCESS = /^\/api\/v1\/workflows\/([^/]+)\/runs\/access$/u;
export function runMethods(path: string) {
  const run = RUN.exec(path);
  if (run?.[3] !== undefined && run[2] !== "gates") return null;
  return path === "/api/v1/me/runs" || LIST.test(path) || ACCESS.test(path)
    ? "GET, HEAD"
    : run
      ? run[4] !== undefined || ["events", "recovery"].includes(run[2])
        ? "POST"
        : ["access", "gates", "gate-answer"].includes(run[2])
          ? "GET, HEAD"
          : "GET, HEAD, POST"
      : null;
}
interface Row extends RunIntegrityRow {
  id: string;
  workflow_id: string;
  publication_id: string;
  package_hash: string;
  person_id: string;
  person_name: string;
  local_run_id: string;
  host_label: string;
  agent_host: string;
  test_run: boolean;
  execution: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  last_sequence: number;
  projection: WorkflowRunReport["projection"] | null;
  continuation: WorkflowRunReport["continuation"] | null;
}
const view = (r: Row) => ({
  id: r.id,
  workflowId: r.workflow_id,
  publicationId: r.publication_id,
  packageHash: r.package_hash,
  personId: r.person_id,
  personName: r.person_name,
  localRunId: r.local_run_id,
  hostLabel: r.host_label,
  agentHost: r.agent_host,
  testRun: r.test_run,
  execution: r.execution,
  createdAt: toIsoString(r.created_at),
  updatedAt: toIsoString(r.updated_at),
  lastSequence: r.last_sequence,
  projection: r.projection,
  continuation: r.continuation,
  integrityFindings: r.integrity_findings,
  needsRecovery: needsRunRecovery(r),
  recovery: r.recovery,
});
async function authorize(
  input: AuthorizedRequest,
  tx: Queryable,
  workflowId: string,
  write = false,
  test = false,
) {
  const workflow = await readWorkflow(tx, workflowId);
  if (!workflow) throw new RequestError(404, "No such workflow");
  const caps = await workflowCapabilities(
    tx,
    input.access,
    input.person,
    workflow,
  );
  if (!caps.read)
    throw new RequestError(403, "This workflow is outside your roles");
  if (!write) {
    if (input.access.tokenScopes !== undefined && !caps.readPublished)
      throw new RequestError(
        403,
        "Run reads require an Operator or test Engineer role and matching token scope",
      );
    return;
  }
  if (write || input.access.tokenScopes !== undefined) {
    const grants = await tx.query<{ role: string }>(
      "select role from role_bindings where workflow_id=$1 and person_id=$2",
      [workflowId, input.person.id],
    );
    const roles = new Set(grants.rows.map((r) => r.role));
    const scopes = input.access.tokenScopes;
    const allowed = test
      ? (isAdministrator(input.access) || roles.has("Engineer")) &&
        (scopes === undefined || scopes.includes("engineer"))
      : (isAdministrator(input.access) || roles.has("Operator")) &&
        (scopes === undefined || scopes.includes("operator"));
    if (!allowed)
      throw new RequestError(
        403,
        test
          ? "Test Runs require an Engineer role and engineer token scope"
          : "Runs require an Operator role and operator token scope",
      );
  }
}
function text(value: unknown, label: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new RequestError(400, `${label} must contain 1 to ${max} characters`);
  return value;
}
export async function handleRuns(input: AuthorizedRequest) {
  const methods = runMethods(input.path)!;
  if (!methods.split(", ").includes(input.method))
    return input.reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const access = ACCESS.exec(input.path);
  if (access) {
    await authorize(
      input,
      input.database,
      decodeURIComponent(access[1]),
      true,
      input.url.searchParams.get("testRun") === "true",
    );
    return input.reply.json(200, {
      personId: input.person.id,
      agentHost: input.context.credential.agentHost ?? "Badger dashboard",
    });
  }
  const list = LIST.exec(input.path);
  if (list || input.path === "/api/v1/me/runs") {
    const workflowId = list ? decodeURIComponent(list[1]) : null;
    const result = await input.database.transaction(async (tx) => {
      if (workflowId) await authorize(input, tx, workflowId);
      const rows = await tx.query<Row>(
        `select * from workflow_runs where ($1::text is null or workflow_id=$1) and ($2::text is null or person_id=$2) order by created_at desc,id desc limit 100`,
        [workflowId, workflowId ? null : input.person.id],
      );
      const visible = [];
      for (const row of rows.rows) {
        try {
          await authorize(input, tx, row.workflow_id, false, row.test_run);
          visible.push(view(row));
        } catch (error) {
          if (!(error instanceof RequestError) || error.status !== 403)
            throw error;
        }
      }
      return { runs: visible };
    });
    return input.reply.json(200, result);
  }
  const match = RUN.exec(input.path)!;
  const id = decodeURIComponent(match[1]);
  if (!ID.test(id)) throw new RequestError(400, "Invalid Run ID");
  let body: Record<string, unknown> = {};
  if (input.method === "POST") {
    const parsed = await readJsonBody(input.request, 2 * 1024 * 1024);
    if (!parsed.ok)
      throw new RequestError(parsed.status ?? 400, parsed.message);
    body = objectInput(parsed.value);
  }
  const result = await input.database.transaction(async (tx) => {
    let row = (
      await tx.query<Row>(
        `select * from workflow_runs where id=$1${input.method === "POST" ? " for update" : ""}`,
        [id],
      )
    ).rows[0];
    if (input.method === "POST" && !match[2]) {
      fields(body, [
        "workflowId",
        "publicationId",
        "packageHash",
        "localRunId",
        "hostLabel",
        "testRun",
        "execution",
      ]);
      const workflowId = text(body.workflowId, "Workflow ID"),
        publicationId = text(body.publicationId, "Publication ID");
      const localRunId = text(body.localRunId, "Local Run ID"),
        hostLabel = text(body.hostLabel, "Host label");
      if (!ID.test(localRunId) || typeof body.testRun !== "boolean")
        throw new RequestError(400, "Invalid local Run identity");
      await authorize(input, tx, workflowId, true, body.testRun);
      const { publication, snapshot } = await readPublishedPackage(
        tx,
        workflowId,
        publicationId,
        text(body.packageHash, "Package hash"),
      );
      const execution = objectInput(body.execution);
      if (
        ![
          execution.protocolHash,
          execution.packageHash,
          execution.snapshotHash,
        ].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v))
      )
        throw new RequestError(400, "Invalid runtime execution identity");
      const protocolFile = snapshot.files.find(
        (file) => file.path === "reference/workflow-protocol.json",
      );
      if (!protocolFile)
        throw new RequestError(409, "Published protocol is missing");
      const expectedExecution = await verifyWorkflowProtocol(
        JSON.parse(
          Buffer.from(protocolFile.content, "base64").toString("utf8"),
        ),
      );
      if (canonicalHash(execution) !== canonicalHash(expectedExecution))
        throw new RequestError(
          409,
          "Runtime execution does not match the published package",
        );
      const agentHost =
        input.context.credential.agentHost ?? "Badger dashboard";
      const identity = {
        workflowId,
        publicationId,
        packageHash: publication.packageHash,
        personId: input.person.id,
        localRunId,
        hostLabel,
        agentHost,
        testRun: body.testRun,
        execution,
      };
      if (row) {
        const saved = view(row);
        if (
          Object.entries(identity).some(
            ([key, v]) =>
              canonicalHash(v) !==
              canonicalHash(saved[key as keyof typeof saved]),
          )
        )
          throw new RequestError(
            409,
            "The Run registration belongs to another person, host, or package",
          );
      } else {
        const now = input.dependencies.clock.now().toISOString();
        const inserted = await tx.query(
          `insert into workflow_runs(id,workflow_id,publication_id,package_hash,person_id,person_name,local_run_id,host_label,agent_host,test_run,execution,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12) on conflict(id) do nothing`,
          [
            id,
            workflowId,
            publicationId,
            publication.packageHash,
            input.person.id,
            input.person.displayName,
            localRunId,
            hostLabel,
            agentHost,
            body.testRun,
            JSON.stringify(execution),
            now,
          ],
        );
        row = (
          await tx.query<Row>(
            "select * from workflow_runs where id=$1 for update",
            [id],
          )
        ).rows[0];
        const saved = view(row);
        if (
          Object.entries(identity).some(
            ([key, v]) =>
              canonicalHash(v) !==
              canonicalHash(saved[key as keyof typeof saved]),
          )
        )
          throw new RequestError(
            409,
            "The Run registration belongs to another person, host, or package",
          );
        if (inserted.rowCount > 0)
          await recordAudit(tx, input.dependencies, {
            actor: {
              personId: input.person.id,
              credential: input.context.credential,
            },
            channel: input.context.channel,
            action: "run.registered",
            target: { type: "run", id, label: localRunId },
            before: null,
            after: { revision: null, hash: publication.packageHash },
            reason: null,
            requestId: input.context.requestId,
          });
      }
    }
    if (!row) throw new RequestError(404, "No such Run");
    await authorize(
      input,
      tx,
      row.workflow_id,
      (input.method === "POST" && match[2] !== "gates") ||
        match[2] === "access" ||
        match[2] === "gate-answer",
      row.test_run,
    );
    if (match[2] === "gates")
      return handleRunGates(
        input,
        tx,
        row,
        match[3] && decodeURIComponent(match[3]),
        match[4],
        body,
      );
    if (
      (input.method === "POST" ||
        match[2] === "access" ||
        match[2] === "gate-answer") &&
      (row.person_id !== input.person.id ||
        row.agent_host !==
          (input.context.credential.agentHost ?? "Badger dashboard"))
    )
      throw new RequestError(
        403,
        "Only the registered person and Agent host may operate this Run",
      );
    if (match[2] === "gate-answer") return readRunGateAnswer(tx, row);
    if (match[2] === "recovery") {
      fields(body, ["required"]);
      if (body.required !== true)
        throw new RequestError(
          400,
          "Only a complete report can settle recovery",
        );
      if (!row.recovery_required) {
        await tx.query(
          "update workflow_runs set recovery_required=true,updated_at=$2 where id=$1",
          [id, input.dependencies.clock.now()],
        );
        await recordAudit(tx, input.dependencies, {
          actor: {
            personId: input.person.id,
            credential: input.context.credential,
          },
          channel: input.context.channel,
          action: "run.recovery_required",
          target: { type: "run", id },
          before: null,
          after: { revision: null, hash: canonicalHash({ required: true }) },
          reason: "The local WorkflowRuntime requires explicit recovery.",
          requestId: input.context.requestId,
        });
      }
      return { needsRecovery: true };
    }
    if (match[2] === "events") {
      const context = { ...input.context, personId: input.person.id };
      await tx.exec("savepoint run_report");
      try {
        fields(body, [
          "events",
          "projection",
          "continuation",
          "lastSequence",
          "recoveryRequired",
          "recoveries",
        ]);
        if (
          body.recoveryRequired !== undefined &&
          typeof body.recoveryRequired !== "boolean"
        )
          throw new RequestError(400, "Invalid recovery status");
        if (
          body.recoveries !== undefined &&
          (!Array.isArray(body.recoveries) ||
            body.recoveries.length > 64 ||
            !body.recoveries.every(
              (id) => typeof id === "string" && ID.test(id),
            ))
        )
          throw new RequestError(
            400,
            "Send at most 64 bounded recovery request IDs",
          );
        if (!Array.isArray(body.events) || body.events.length > 64)
          throw new RequestError(400, "Send at most 64 ordered Run events");
        let sequence = row.last_sequence;
        for (const value of body.events) {
          const event = objectInput(value);
          const seq = event.sequence;
          if (
            !Number.isSafeInteger(seq) ||
            Number(seq) < 1 ||
            event.runId !== row.local_run_id ||
            ![
              "run_started",
              "action_proposed",
              "action_completed",
              "eval_completed",
              "checkpoint",
              "state_migrated",
              "state_transitioned",
              "command_check_recorded",
              "recovery_reconciled",
            ].includes(String(event.type)) ||
            typeof event.timestamp !== "string" ||
            !Number.isFinite(Date.parse(event.timestamp)) ||
            !event.data ||
            typeof event.data !== "object" ||
            Buffer.byteLength(JSON.stringify(event)) > 256 * 1024
          )
            throw new RequestError(400, "Invalid bounded Run event");
          const digest = canonicalHash(event);
          if (Number(seq) <= sequence) {
            const saved = (
              await tx.query<{ payload_hash: string }>(
                "select payload_hash from workflow_run_events where run_id=$1 and sequence=$2",
                [id, seq],
              )
            ).rows[0];
            if (saved?.payload_hash !== digest)
              throw new RequestError(
                409,
                "A Run event sequence already has different bytes",
              );
            continue;
          }
          if (seq !== sequence + 1)
            throw new RunIntegrityError("event-sequence-gap", {
              expected: sequence + 1,
              received: seq,
            });
          const data = event.data as Record<string, unknown>;
          if (
            data.runtimeIdentity &&
            canonicalHash(data.runtimeIdentity) !== canonicalHash(row.execution)
          )
            throw new RunIntegrityError("package-hash-mismatch", {
              sequence: seq,
              expected: canonicalHash(row.execution),
              received: canonicalHash(data.runtimeIdentity),
            });
          if (!(await hasMatchingRunGateAnswer(tx, id, event)))
            await flagRunIntegrity(
              tx,
              input.dependencies,
              context,
              row,
              "unattested-decision",
              { sequence: seq, eventHash: digest },
            );
          await tx.query(
            "insert into workflow_run_events(run_id,sequence,payload,payload_hash,received_at) values($1,$2,$3::jsonb,$4,$5)",
            [
              id,
              seq,
              JSON.stringify(event),
              digest,
              input.dependencies.clock.now().toISOString(),
            ],
          );
          sequence = Number(seq);
        }
        const projection =
            body.projection === undefined ? null : objectInput(body.projection),
          continuation =
            body.continuation === undefined
              ? null
              : objectInput(body.continuation);
        if ((projection === null) !== (continuation === null))
          throw new RequestError(400, "Send the complete runtime report");
        if (projection && continuation) {
          validateRunReadModels(projection, continuation, row.local_run_id);
          if (
            canonicalHash(projection.execution) !==
              canonicalHash(row.execution) ||
            canonicalHash(continuation.execution) !==
              canonicalHash(row.execution)
          )
            throw new RunIntegrityError("package-hash-mismatch", {
              expected: canonicalHash(row.execution),
              projection: canonicalHash(projection.execution),
              continuation: canonicalHash(continuation.execution),
            });
          if (
            body.lastSequence !== sequence ||
            projection.runId !== row.local_run_id ||
            continuation.runId !== row.local_run_id ||
            projection.revision !== continuation.revision ||
            !Number.isSafeInteger(projection.revision) ||
            !["running", "waiting", "blocked", "completed"].includes(
              String(projection.status),
            ) ||
            Buffer.byteLength(JSON.stringify({ projection, continuation })) >
              1024 * 1024
          )
            throw new RequestError(
              409,
              "Run snapshot does not match its registered identity or event sequence",
            );
          if (
            row.projection &&
            Number(projection.revision) < row.projection.revision
          )
            throw new RequestError(
              409,
              "Run snapshot revision moved backwards",
            );
          await reconcileRunIntegrity(
            tx,
            input.dependencies,
            context,
            row,
            sequence,
          );
          const recoveryRequests = (body.recoveries ?? []) as string[];
          const existingRecoveries = await tx.query<{ request_id: string }>(
            "select request_id from run_recoveries where run_id=$1 and request_id=any($2::text[])",
            [id, recoveryRequests],
          );
          const newRecoveries = recoveryRequests.filter(
            (request) =>
              !existingRecoveries.rows.some(
                (saved) => saved.request_id === request,
              ),
          );
          row.recovery_required =
            body.recoveryRequired === true ||
            (row.recovery_required && newRecoveries.length === 0) ||
            (
              continuation.findings as {
                code?: string;
                operation?: { id?: string };
              }[]
            ).some(
              (f) =>
                f.code === "recovery-required" ||
                f.operation?.id === "workflow.recover",
            );
          await recordRunRecoveries(
            tx,
            input.dependencies,
            context,
            row,
            newRecoveries,
            {
              lastSequence: sequence,
              continuation:
                continuation as unknown as WorkflowRunReport["continuation"],
            },
          );
        } else if (
          body.recoveries !== undefined ||
          body.recoveryRequired !== undefined
        )
          throw new RequestError(
            400,
            "Recovery status requires the complete runtime report",
          );
        await tx.query(
          "update workflow_runs set last_sequence=$2,updated_at=$3,projection=coalesce($4::jsonb,projection),continuation=coalesce($5::jsonb,continuation),integrity_findings=$6::jsonb,recovery_required=$7,recovery=$8::jsonb where id=$1",
          [
            id,
            sequence,
            input.dependencies.clock.now().toISOString(),
            projection ? JSON.stringify(projection) : null,
            continuation ? JSON.stringify(continuation) : null,
            JSON.stringify(row.integrity_findings),
            row.recovery_required,
            row.recovery ? JSON.stringify(row.recovery) : null,
          ],
        );
        if (continuation)
          await syncRunGate(
            tx,
            input.dependencies,
            row,
            continuation as unknown as WorkflowRunReport["continuation"],
          );
        return { lastSequence: sequence };
      } catch (error) {
        if (!(error instanceof RunIntegrityError)) throw error;
        await tx.exec("rollback to savepoint run_report");
        // Restore the in-memory row as well as the rejected report's SQL writes.
        row = (
          await tx.query<Row>("select * from workflow_runs where id=$1", [id])
        ).rows[0];
        await flagRunIntegrity(
          tx,
          input.dependencies,
          context,
          row,
          error.code,
          error.evidence,
        );
        return error;
      }
    }
    if (match[2] === "access") return { run: view(row) };
    const after = input.url.searchParams.get("afterSequence") ?? "0";
    if (!/^\d+$/u.test(after) || !Number.isSafeInteger(Number(after)))
      throw new RequestError(
        400,
        "afterSequence must be a non-negative safe integer",
      );
    const events = await tx.query<{ payload: { sequence: number } }>(
      "select payload from workflow_run_events where run_id=$1 and sequence > $2 order by sequence limit 500",
      [id, Number(after)],
    );
    return {
      run: {
        ...view(row),
        events: events.rows.map((e) => e.payload),
        eventsTruncated:
          (events.rows.at(-1)?.payload.sequence ?? Number(after)) <
          Number(row.last_sequence),
      },
    };
  });
  if (result instanceof RequestError) throw result;
  return input.reply.json(200, result);
}
