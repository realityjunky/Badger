import {
  authoringLaneWave,
  readyPlanFinding,
  planFindingTargetHash,
  canonicalHash,
  reconcilePlanDraft,
  type PlanRepair,
  type PlanRepairReport,
  type AuthoringLaneOutput,
  type AuthoringWaveId,
} from "@realityjunky/badger";
import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { RequestError } from "../http/errors.js";
import { readPackage } from "../packages.js";
import { readPlanHead } from "../plans.js";
import { indexFindingReports } from "../findings.js";
import type { draftingContext } from "./context.js";
import {
  auditJob,
  createDraftingJob,
  finishInbox,
  type DraftingActor,
  type DraftingJobRow,
} from "./jobs.js";

type Context = Awaited<ReturnType<typeof draftingContext>>;
const active = (job: DraftingJobRow) =>
  ["queued", "claimed", "submitted"].includes(job.status);
const target = {
  kind: "draft-plan" as const,
  roundId: null,
  parentQuestionId: null,
  skillId: null,
  questionId: null,
  locale: null,
};

function laneReport(job: DraftingJobRow): PlanRepairReport | undefined {
  const accepted = job.decision as {
    decision?: { laneOutput?: AuthoringLaneOutput };
  } | null;
  const result = job.review_result ?? job.result;
  const output =
    accepted?.decision?.laneOutput ??
    (result && "laneOutput" in result ? result.laneOutput : undefined);
  if (output?.schemaVersion === 2) {
    const findings = output.findings ?? [];
    if (
      !job.lane_id ||
      !["BLOCKED", "DONE_WITH_CONCERNS"].includes(output.status) ||
      !findings.length ||
      !findings.every(readyPlanFinding)
    )
      return;
    return {
      jobId: job.id,
      lane: job.lane_id,
      resultHash: canonicalHash({ laneOutput: output }),
      findings,
      action: {
        kind: "repair",
        target: { stage: "plan" },
        requirement: findings.map((item) => item.problem).join("\n"),
        prompt: findings.map((item) => item.fix).join("\n"),
      },
    };
  }
  if (
    !output ||
    !job.lane_id ||
    output.action?.target?.stage !== "plan" ||
    output.action.kind !== "repair" ||
    !["DONE_WITH_CONCERNS", "BLOCKED"].includes(output.status)
  )
    return;
  return {
    jobId: job.id,
    lane: job.lane_id,
    resultHash: canonicalHash({ laneOutput: output }),
    action: output.action,
    findings: output.findings ?? [],
  };
}

async function enqueue(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  versionId: string,
  current: Context,
  packageId: string,
  wave: AuthoringWaveId,
  reports: PlanRepairReport[],
  sources: DraftingJobRow[],
  jobs: DraftingJobRow[],
  explicit = false,
) {
  const head = await readPlanHead(tx, versionId);
  if (
    !head ||
    !current.bundle.planning ||
    head.snapshot.dossierHash !== current.bundle.planning.input.dossierHash
  )
    return;
  const basisHash = canonicalHash({
    packageId,
    wave,
    head: head.id,
    reports: reports.map(({ jobId, resultHash }) => [jobId, resultHash]),
    sources: sources.map((job) => [job.id, job.review_hash ?? job.result_hash]),
  });
  const prior = [...jobs]
    .reverse()
    .find((job) => job.context_bundle.planRepair?.basisHash === basisHash);
  if (prior && prior.status !== "cancelled") return prior;
  if (prior?.superseded_by_findings && !explicit) return;
  const busy = jobs.find((job) => job.context_bundle.planRepair && active(job));
  if (busy) {
    if (explicit)
      throw new RequestError(
        409,
        "Finish the current Plan repair before requesting another.",
        { jobId: busy.id },
      );
    if (
      busy.context_bundle.planRepair!.packageId !== packageId ||
      busy.context_bundle.planRepair!.wave !== wave
    )
      await tx.query(
        `insert into pending_plan_repairs (workflow_version_id,package_id,wave,planning_input_hash,reports,source_draft_ids,requested_at)
        values ($1,$2,$3,$4,$5::jsonb,$6,$7)
        on conflict (workflow_version_id,package_id,wave) do update set planning_input_hash=excluded.planning_input_hash,reports=excluded.reports,source_draft_ids=excluded.source_draft_ids
        where pending_plan_repairs.reports <> excluded.reports or pending_plan_repairs.source_draft_ids <> excluded.source_draft_ids or pending_plan_repairs.planning_input_hash <> excluded.planning_input_hash`,
        [
          versionId,
          packageId,
          wave,
          canonicalHash(current.bundle.planning.input),
          JSON.stringify(reports),
          sources.map((source) => source.id),
          deps.clock.now(),
        ],
      );
    return;
  }
  if (
    !explicit &&
    !prior &&
    (
      await tx.query(
        "select 1 from drafting_jobs where workflow_version_id=$1 and deleted_at is not null and context_bundle->'planRepair'->>'basisHash'=$2 limit 1",
        [versionId, basisHash],
      )
    ).rows.length
  )
    return;
  const repair: PlanRepair = {
    basisHash,
    packageId,
    wave,
    basePlan: { id: head.id, hash: head.hash, plan: head.snapshot.plan },
    reports,
  };
  if (sources.length) {
    let startingPlan = head.snapshot.plan;
    const conflicts = new Map<
      string,
      NonNullable<PlanRepair["recovery"]>["conflicts"][number]
    >();
    const draftIds = new Set<string>();
    for (const source of sources) {
      const previous = source.context_bundle.planRepair?.recovery;
      for (const id of previous?.draftIds ?? []) draftIds.add(id);
      draftIds.add(source.id);
      for (const conflict of previous?.conflicts ?? [])
        conflicts.set(conflict.draftId + conflict.path, conflict);
      if (source.status === "accepted") continue;
      const result = source.review_result ?? source.result;
      const proposed =
        result && "plan" in result ? result.plan : previous?.startingPlan;
      const basis =
        source.context_bundle.planRepair?.basePlan ??
        source.context_bundle.authoringFollowUp?.basePlan;
      if (!proposed || !basis) continue;
      const merged = reconcilePlanDraft(basis.plan, startingPlan, proposed);
      startingPlan = merged.plan;
      for (const conflict of merged.conflicts)
        conflicts.set(source.id + conflict.path, {
          ...conflict,
          draftId: source.id,
        });
    }
    repair.recovery = {
      draftIds: [...draftIds],
      startingPlan,
      conflicts: [...conflicts.values()],
    };
  }
  const job = await createDraftingJob(
    tx,
    deps,
    actor,
    versionId,
    target,
    current,
    repair,
  );
  jobs.push(job);
  await tx.query(
    "update authoring_follow_ups set plan_draft_job_id=$1 where target_stage='plan' and job_id=any($2::text[]) and (plan_draft_job_id is null or not exists (select 1 from drafting_jobs old where old.id=authoring_follow_ups.plan_draft_job_id and old.context_bundle ? 'authoringFollowUp'))",
    [job.id, reports.map((report) => report.jobId)],
  );
  return job;
}

async function cancelRepair(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
) {
  const before = job.revision;
  const updated = (
    await tx.query<DraftingJobRow>(
      `update drafting_jobs set status='cancelled',revision=revision+1,lease_id=null,lease_person_id=null,lease_token_id=null,lease_agent_host=null,lease_kind=null,lease_until=null,lease_activity_at=null,updated_at=$2 where id=$1 returning *`,
      [job.id, deps.clock.now()],
    )
  ).rows[0]!;
  Object.assign(job, updated);
  await finishInbox(tx, deps, job.id);
  await auditJob(
    tx,
    deps,
    actor,
    job,
    "cancelled",
    before,
    "A source lane report changed.",
  );
}

export async function syncWavePlanRepairs(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  versionId: string,
  current: Context,
  jobs: DraftingJobRow[],
) {
  if (!current.bundle.planning || !jobs.some((job) => job.lane_id)) return;
  await indexFindingReports(tx, versionId);
  const pkg = await readPackage(tx, versionId);
  if (!pkg) return;
  const laneJobs = jobs.filter(
    (job) => job.package_id === pkg.id && job.lane_id,
  );
  const latest = new Map(laneJobs.map((job) => [job.lane_id!, job]));
  for (const wave of (pkg.invalidated_at
    ? []
    : Object.keys(pkg.authoring_plan.dag)) as AuthoringWaveId[]) {
    const members = pkg.authoring_plan.dag[wave].map((id) => latest.get(id));
    const completed = members.every(
      (job) =>
        job && ["submitted", "accepted", "rejected"].includes(job.status),
    );
    const reports = members.flatMap((job) =>
      job && job.status !== "rejected" ? (laneReport(job) ?? []) : [],
    );
    const previous = jobs.filter(
      (job) =>
        job.context_bundle.planRepair?.packageId === pkg.id &&
        job.context_bundle.planRepair.wave === wave,
    );
    const running = previous.find(active);
    // Explicitly grouped work has its own observation, finding and Plan revision fences.
    if (
      running?.context_bundle.findingWork ||
      previous.some(
        (job) =>
          job.superseded_by_findings ||
          (job.context_bundle.findingWork && job.status === "accepted"),
      )
    )
      continue;
    if (
      !previous.length &&
      members.some((job) => {
        const result = job?.review_result ?? job?.result;
        if (!result || !("laneOutput" in result)) return false;
        const output = result.laneOutput;
        return (
          (output.schemaVersion === 2 &&
            output.findings?.some((f) => !readyPlanFinding(f))) ||
          ((output.findings?.length ?? 0) > 1 && output.schemaVersion !== 2)
        );
      })
    )
      continue;
    if (running) running.waveReportsOpen = !completed;
    if (
      running &&
      (!running.context_bundle.planRepair!.reports.every((report) =>
        reports.some(
          (item) =>
            item.jobId === report.jobId &&
            item.resultHash === report.resultHash,
        ),
      ) ||
        (completed &&
          running.context_bundle.planRepair!.reports.length !== reports.length))
    )
      await cancelRepair(tx, deps, actor, running);
    if (!completed || !reports.length) {
      if (
        previous.length ||
        jobs.some((job) => job.context_bundle.planRepair && active(job))
      )
        await tx.query(
          "delete from pending_plan_repairs where workflow_version_id=$1 and package_id=$2 and wave=$3",
          [versionId, pkg.id, wave],
        );
      continue;
    }
    if (
      jobs.some(
        (job) =>
          job.context_bundle.authoringFollowUp?.packageId === pkg.id &&
          authoringLaneWave(job.context_bundle.authoringFollowUp.lane) === wave,
      )
    )
      continue;
    const head = await readPlanHead(tx, versionId);
    if (head?.hash !== pkg.plan_version_hash) break;
    const priorItems = new Set<string>();
    for (const job of jobs) {
      const repair = job.context_bundle.planRepair;
      if (!repair || job.status !== "accepted" || repair.packageId === pkg.id)
        continue;
      for (const report of repair.reports) {
        for (const finding of report.findings) {
          if (!readyPlanFinding(finding)) continue;
          const target = finding.disposition!.target;
          priorItems.add(
            canonicalHash({
              disposition: finding.disposition,
              fix: finding.fix,
              field: planFindingTargetHash(repair.basePlan.plan, target),
            }),
          );
        }
      }
    }
    // A fresh package alone supplies no new Plan inputs. Its observations remain available in Findings.
    if (
      reports.some((report) =>
        report.findings.some((finding) => {
          if (!readyPlanFinding(finding)) return false;
          const field = planFindingTargetHash(
            head.snapshot.plan,
            finding.disposition!.target,
          );
          return (
            !field ||
            priorItems.has(
              canonicalHash({
                disposition: finding.disposition,
                fix: finding.fix,
                field,
              }),
            )
          );
        }),
      )
    )
      continue;
    const source = [...previous]
      .reverse()
      .find(
        (job) =>
          job.status === "cancelled" &&
          job.result &&
          job.context_bundle.planRepair?.basePlan.id === head.id,
      );
    const scheduled = await enqueue(
      tx,
      deps,
      actor,
      versionId,
      current,
      pkg.id,
      wave,
      reports,
      source ? [source] : [],
      jobs,
    );
    if (scheduled)
      await tx.query(
        "delete from pending_plan_repairs where workflow_version_id=$1 and package_id=$2 and wave=$3",
        [versionId, pkg.id, wave],
      );
  }
  if (jobs.some((job) => job.context_bundle.planRepair && active(job))) return;
  const pending = await tx.query<{
    package_id: string;
    wave: AuthoringWaveId;
    reports: PlanRepairReport[];
    source_draft_ids: string[];
  }>(
    "select package_id,wave,reports,source_draft_ids from pending_plan_repairs where workflow_version_id=$1 and planning_input_hash=$2 order by requested_at,package_id,wave",
    [versionId, canonicalHash(current.bundle.planning.input)],
  );
  for (const waiting of pending.rows) {
    const sources = jobs.filter((job) =>
      waiting.source_draft_ids.includes(job.id),
    );
    const job = await enqueue(
      tx,
      deps,
      actor,
      versionId,
      current,
      waiting.package_id,
      waiting.wave,
      waiting.reports,
      sources,
      jobs,
    );
    await tx.query(
      "delete from pending_plan_repairs where workflow_version_id=$1 and package_id=$2 and wave=$3",
      [versionId, waiting.package_id, waiting.wave],
    );
    if (job && active(job)) break;
  }
}

export async function requestHistoricalPlanRepair(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  current: Context,
  jobs: DraftingJobRow[],
  source: DraftingJobRow,
) {
  const existing = [...jobs]
    .reverse()
    .find(
      (job) =>
        job.context_bundle.planRepair?.recovery?.draftIds.includes(source.id) &&
        job.status !== "cancelled",
    );
  if (existing) return existing;
  const old = source.context_bundle.authoringFollowUp;
  const repair = source.context_bundle.planRepair;
  if (
    !source.reconciliationHeadId ||
    (!old && !repair) ||
    !["submitted", "cancelled"].includes(source.status)
  )
    throw new RequestError(
      409,
      "This draft has no current Plan repair to request.",
    );
  if (
    old &&
    jobs.some((job) => {
      const item = job.context_bundle.authoringFollowUp;
      return (
        item?.packageId === old.packageId &&
        item.basePlan.id === old.basePlan.id &&
        authoringLaneWave(item.lane) === authoringLaneWave(old.lane) &&
        job.status === "claimed"
      );
    })
  )
    throw new RequestError(
      409,
      "An Agent is still editing a source Plan draft. Finish or release that claim before reconciliation.",
    );
  const sources = old
    ? jobs.filter((job) => {
        const item = job.context_bundle.authoringFollowUp;
        return (
          item?.packageId === old.packageId &&
          item.basePlan.id === old.basePlan.id &&
          authoringLaneWave(item.lane) === authoringLaneWave(old.lane) &&
          (job.status === "accepted" ||
            (!!job.reconciliationHeadId &&
              ["submitted", "cancelled"].includes(job.status))) &&
          job.result
        );
      })
    : [source];
  const reports =
    repair?.reports ??
    sources.map((job) => {
      const { jobId, resultHash, lane, action, findings } =
        job.context_bundle.authoringFollowUp!;
      return { jobId, resultHash, lane, action, findings };
    });
  const job = await enqueue(
    tx,
    deps,
    actor,
    source.workflow_version_id,
    current,
    repair?.packageId ?? old!.packageId,
    repair?.wave ?? authoringLaneWave(old!.lane),
    reports,
    sources,
    jobs,
    true,
  );
  if (!job)
    throw new RequestError(
      409,
      "The approved inputs changed. Reload the Plan before requesting a repair.",
    );
  return job;
}
