import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  evaluatePackage,
  hashDirectory,
  reviewState,
  type CreatorState,
  type EvalReport,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceConfig } from "./config.js";
import type { ServiceDependencies } from "./dependencies.js";
import { recordAudit, type WriteContext } from "./audit.js";
import { loadAuthoring } from "./authoring.js";
import { generationInputs } from "./packages.js";
import { publicKernelMessage } from "./proposals.js";
import {
  listWorkflowJobs,
  type SourceCheckWorkerOptions,
  type WorkflowJob,
  workspaceLocation,
} from "./workflow-source.js";
import { RequestError } from "./http/errors.js";
import { toIsoString } from "./util.js";

export const EVALUATION_LIMITS = {
  timeLimitMilliseconds: 180_000,
  childTimeLimitMilliseconds: 15_000,
  memoryLimitBytes: 512 * 1024 * 1024,
  outputLimitBytes: 4 * 1024 * 1024,
} as const;
interface ReportRow {
  id: string;
  workflow_version_id: string;
  job_id: string;
  package_id: string;
  package_hash: string;
  creator_state_hash: string;
  starter_id: string;
  starter_name: string;
  started_at: Date | string;
  finished_at: Date | string;
  duration_milliseconds: number;
  report: EvalReport;
  report_path: string;
  sandbox: typeof EVALUATION_LIMITS;
}
const reports = async (tx: Queryable, versionId: string) =>
  (
    await tx.query<ReportRow>(
      "select * from evaluation_reports where workflow_version_id=$1 order by finished_at desc,id desc",
      [versionId],
    )
  ).rows;

/** Readiness always delegates to kernel evidence validation, using the committed Authoring state. */
export async function loadEvaluationState(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
) {
  const loaded = await loadAuthoring(tx, config, versionId);
  const history = await reports(tx, versionId);
  const passing =
    loaded.saved.invalidated_at === null
      ? history.find(
          (entry) =>
            entry.package_id === loaded.saved.id &&
            entry.package_hash === loaded.saved.assembled_hash &&
            entry.report.passed,
        )
      : undefined;
  const state: CreatorState = structuredClone(loaded.state);
  delete state.eval;
  state.currentHash = loaded.saved.assembled_hash;
  if (passing && state.status === "generated") state.status = "evaluated";
  if (passing)
    state.eval = {
      hash: passing.report.hash,
      passed: passing.report.passed,
      resultPath: path.join(loaded.root, passing.report_path),
      ...(passing.report.runtime ? { runtime: passing.report.runtime } : {}),
      ...(passing.report.authoringCrossValidation
        ? { authoringCrossValidation: passing.report.authoringCrossValidation }
        : {}),
    };
  return {
    ...loaded,
    state,
    history,
    passing,
    publicationReadiness: reviewState(state, loaded.readiness),
  };
}

export async function evaluationView(
  tx: Queryable,
  config: ServiceConfig,
  versionId: string,
) {
  const history = await reports(tx, versionId);
  let current: Awaited<ReturnType<typeof loadEvaluationState>> | null = null;
  try {
    current = await loadEvaluationState(tx, config, versionId);
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
  }
  return {
    currentPackageHash:
      current?.saved.invalidated_at === null
        ? current.saved.assembled_hash
        : null,
    passingReportId:
      current?.publicationReadiness.runtime.state === "ready"
        ? (current.passing?.id ?? null)
        : null,
    readiness: current?.publicationReadiness ?? null,
    reports: history.map((entry) => ({
      id: entry.id,
      jobId: entry.job_id,
      packageId: entry.package_id,
      packageHash: entry.package_hash,
      starterId: entry.starter_id,
      starterName: entry.starter_name,
      startedAt: toIsoString(entry.started_at),
      finishedAt: toIsoString(entry.finished_at),
      durationMilliseconds: entry.duration_milliseconds,
      report: entry.report,
      sandbox: entry.sandbox,
    })),
    jobs: (await listWorkflowJobs(tx, versionId)).filter(
      (job) => job.kind === "evaluate",
    ),
  };
}

export async function enqueueEvaluation(
  tx: Queryable,
  config: ServiceConfig,
  deps: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  input: { packageHash: string; requestId: string },
) {
  const replay = (await listWorkflowJobs(tx, versionId)).find(
    (job) =>
      job.requesterId === context.personId && job.requestId === input.requestId,
  );
  if (replay) {
    if (
      replay.kind !== "evaluate" ||
      replay.evaluationPackageHash !== input.packageHash
    )
      throw new RequestError(
        409,
        "The evaluation request ID was already used for different inputs",
      );
    return replay;
  }
  const loaded = await loadAuthoring(tx, config, versionId);
  const inputs = await generationInputs(
    tx,
    config,
    versionId,
    context.personId,
  );
  if (
    !inputs.current ||
    loaded.saved.invalidated_at !== null ||
    loaded.readiness.status !== "assembled" ||
    loaded.saved.assembled_hash !== input.packageHash ||
    (await hashDirectory(loaded.state.generated!.packageRoot)) !==
      input.packageHash
  )
    throw new RequestError(
      409,
      "Assemble the current approved package before evaluating its exact hash",
    );
  const id = deps.ids.next();
  await tx.query(
    `insert into workflow_jobs (id,kind,workflow_version_id,requester_id,status,requested_at,pins_hash,request_id,creator_state_hash,evaluation_package_id,evaluation_package_hash,progress)
    values ($1,'evaluate',$2,$3,'queued',$4,$5,$6,$7,$8,$9,'{"phase":"queued"}'::jsonb)`,
    [
      id,
      versionId,
      context.personId,
      deps.clock.now(),
      inputs.loaded!.pinsHash,
      input.requestId,
      loaded.persisted.hash,
      loaded.saved.id,
      input.packageHash,
    ],
  );
  await recordAudit(tx, deps, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "workflow_evaluation.requested",
    target: { type: "workflow_job", id },
    before: null,
    after: { revision: 1, hash: input.packageHash },
    reason: "Confirmed evaluation of the assembled package",
    requestId: context.requestId,
  });
  return (await listWorkflowJobs(tx, versionId)).find((job) => job.id === id)!;
}

/** Long certification work holds no database lock; only its final evidence commits. */
export async function runEvaluation(
  options: SourceCheckWorkerOptions,
  job: WorkflowJob,
): Promise<WorkflowJob> {
  const { database, config, dependencies: deps, workerId } = options;
  const started = performance.now();
  const { root } = workspaceLocation(config, job.workflowVersionId);
  const directory = path.join(
    root,
    ".badger",
    "evaluations",
    job.id,
    randomUUID(),
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(directory, "report.json");
  const progress = async (phase: string) => {
    await database.query(
      "update workflow_jobs set progress=$4::jsonb where id=$1 and worker_id=$2 and revision=$3 and status='running'",
      [job.id, workerId, job.revision, JSON.stringify({ phase })],
    );
  };
  let report: EvalReport;
  try {
    const loaded = await loadAuthoring(database, config, job.workflowVersionId);
    if (
      loaded.saved.id !== job.evaluationPackageId ||
      loaded.saved.invalidated_at !== null ||
      loaded.persisted.hash !== job.creatorStateHash ||
      loaded.saved.assembled_hash !== job.evaluationPackageHash ||
      (await hashDirectory(loaded.state.generated!.packageRoot)) !==
        job.evaluationPackageHash
    )
      throw new Error("The assembled package changed before evaluation");
    report = await evaluatePackage(structuredClone(loaded.state), {
      reportPath,
      persistState: false,
      onProgress: progress,
      sandbox: {
        ...EVALUATION_LIMITS,
        tempDirectory: path.join(directory, "tmp"),
      },
    });
  } catch (error) {
    report = {
      schemaVersion: 1,
      hash: job.evaluationPackageHash!,
      passed: false,
      checks: [
        {
          id: "evaluation-execution",
          passed: false,
          detail: publicKernelMessage(
            config,
            error instanceof Error ? error.message : String(error),
          ),
        },
      ],
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  report.checks = report.checks.map((check) => ({
    ...check,
    detail: publicKernelMessage(config, check.detail),
  }));
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await fs.chmod(reportPath, 0o400);
  const duration = Math.round(performance.now() - started);
  return database.transaction(async (tx) => {
    await tx.query(
      "select id from workflow_versions where id=$1 for no key update",
      [job.workflowVersionId],
    );
    await tx.query("select id from workflow_jobs where id=$1 for update", [
      job.id,
    ]);
    const current = (await listWorkflowJobs(tx, job.workflowVersionId)).find(
      (entry) => entry.id === job.id,
    )!;
    if (
      current.workerId !== workerId ||
      !(
        (current.status === "running" && current.revision === job.revision) ||
        (current.status === "cancelled" &&
          current.revision === job.revision + 1)
      )
    )
      return current;
    const latest = await loadAuthoring(tx, config, job.workflowVersionId).catch(
      (error: unknown) => {
        if (error instanceof RequestError) return null;
        throw error;
      },
    );
    const same =
      latest !== null &&
      current.status === "running" &&
      latest.saved.id === job.evaluationPackageId &&
      latest.saved.invalidated_at === null &&
      latest.persisted.hash === job.creatorStateHash &&
      latest.saved.assembled_hash === report.hash &&
      (await hashDirectory(latest.state.generated!.packageRoot)) ===
        report.hash;
    const reportId = deps.ids.next();
    await tx.query(
      `insert into evaluation_reports (id,workflow_version_id,job_id,package_id,package_hash,creator_state_hash,starter_id,starter_name,started_at,finished_at,duration_milliseconds,report,report_path,sandbox)
      values ($1,$2,$3,$4,$5,$6,$7,(select display_name from people where id=$7),$8,$9,$10,$11::jsonb,$12,$13::jsonb)`,
      [
        reportId,
        job.workflowVersionId,
        job.id,
        job.evaluationPackageId,
        job.evaluationPackageHash,
        job.creatorStateHash,
        job.requesterId,
        job.startedAt!,
        deps.clock.now(),
        duration,
        JSON.stringify(report),
        path.relative(root, reportPath),
        JSON.stringify(EVALUATION_LIMITS),
      ],
    );
    const status = same
      ? report.passed
        ? "succeeded"
        : "failed"
      : "cancelled";
    await tx.query(
      "update workflow_jobs set status=$2,outcome=$3::jsonb,error=$4,finished_at=$5,lease_until=null,progress=$6::jsonb,revision=revision+1 where id=$1",
      [
        job.id,
        status,
        JSON.stringify({
          status: "evaluated",
          blockers: report.checks
            .filter((check) => !check.passed)
            .map((check) => check.detail),
          reportId,
        }),
        same ? null : "The package changed during evaluation",
        deps.clock.now(),
        JSON.stringify({ phase: "finished" }),
      ],
    );
    if (same)
      await tx.query(
        "update workflow_versions set stages=stages || jsonb_build_object('evaluation',$2::text),revision=revision+1,updated_at=$3 where id=$1",
        [
          job.workflowVersionId,
          report.passed ? "done" : "active",
          deps.clock.now(),
        ],
      );
    await tx.query(
      "insert into inbox_items(id,person_id,workflow_version_id,gate,kind,event_id,evaluation_report_id,created_at,updated_at) values($1,$2,$3,'evaluation','evaluation-finished',$4,$4,$5,$5) on conflict do nothing",
      [
        deps.ids.next(),
        job.requesterId,
        job.workflowVersionId,
        reportId,
        deps.clock.now(),
      ],
    );
    await recordAudit(tx, deps, {
      actor: { personId: null, credential: { kind: "worker", id: workerId } },
      channel: "worker",
      action: `workflow_evaluation.${status}`,
      target: { type: "evaluation-report", id: reportId },
      before: { revision: job.revision, hash: job.evaluationPackageHash },
      after: { revision: job.revision + 1, hash: report.hash },
      reason: same
        ? "Retained immutable evaluation report"
        : "Retained evaluation of a superseded package",
      requestId: job.id,
    });
    return (await listWorkflowJobs(tx, job.workflowVersionId)).find(
      (entry) => entry.id === job.id,
    )!;
  });
}
