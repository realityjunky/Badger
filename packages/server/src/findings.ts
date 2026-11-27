import { createHash } from "node:crypto";
import path from "node:path";
import {
  canonicalHash,
  createPackageSnapshot,
  type PackageSnapshot,
  authoringLaneWave,
  type AuthoringLaneId,
  type PlanRepair,
  type PlanRepairReport,
  bindFindingVerifier,
  normalizeWorkflow,
  verifyFindingReceipt,
  type FindingVerifierBinding,
  findingSubjectKey,
  findingTargetLane,
  planFindingTargetHash,
  findingVerificationState,
  findingBlocksGate,
  inPackageImplementationScope,
  validatePackageImplementationFiles,
  packageImplementationPath,
  parseFindingDisposition,
  type AuthoringLaneFinding,
  type AuthoringLaneOutput,
  type FindingDisposition,
  type PackageImplementationFile,
} from "@realityjunky/badger";
import type { Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { RequestError } from "./http/errors.js";
import {
  createDraftingJob,
  auditJob,
  finishInbox,
  type DraftingActor,
  type DraftingJobRow,
} from "./drafting/jobs.js";
import { draftingContext } from "./drafting/context.js";
import type { DraftResult } from "./drafting/schema.js";
import { readPackage } from "./packages.js";
import { readPlanHead } from "./plans.js";
import { readVersion } from "./skills/library.js";
import { applyFileChanges } from "./skills/version-edit.js";
import { inspectUploadFiles } from "./skills/upload.js";
import { normalizeSkillPath } from "./skills/paths.js";
import type { BlobStore } from "./skills/blobs.js";
import type { ServiceConfig } from "./config.js";
import { invalidateGeneratedPackage } from "./package-invalidation.js";
import { requestLaneJobs } from "./authoring.js";
import { workspaceLocation } from "./workflow-source.js";
import { createRound, saveQuestion } from "./questionnaire/store.js";

export interface FindingWorkContext {
  verificationPackage?: PackageSnapshot;
  sourcePin?: {
    skillId: string;
    hash: string;
    purpose: "source" | "upgrade-source";
    revision: number;
  };
  prerequisiteEvidence?: {
    id: string;
    hash: string;
    jobId: string;
    result: DraftResult | null;
  }[];
  verifier?: FindingVerifierBinding;
  verifierProtocolHash?: string;
  findingIds: string[];
  basisHash: string;
  subjectHash: string;
  tasks: {
    id: string;
    problem: string;
    disposition: FindingDisposition | null;
    workRevision: number;
    targetHash: string | null;
  }[];
  observations: Observation[];
  files: { path: string; hash: string; text: string }[];
  packageFiles: (PackageImplementationFile & { hash: string })[];
}
interface FindingRow {
  id: string;
  subject_key: string;
  work_revision: number;
  problem: string;
  disposition: FindingDisposition | null;
  revision: number;
  reviewed: boolean;
  dismissal: string | null;
  adopted_hash: string | null;
  verified_hash: string | null;
  verified_protocol_hash: string | null;
  verified_requirement_hash: string | null;
  candidate_source_hash: string | null;
}
interface Observation {
  id: string;
  job_id: string;
  package_id: string;
  lane: string;
  result_hash: string;
  ordinal: number;
  finding: AuthoringLaneFinding;
  evidenceFiles?: { originalPath: string; path: string; hash: string }[];
  unavailableInputs?: string[];
  priorRepairs?: {
    jobId: string;
    planVersionId: string;
    status: string;
    explanation: string;
  }[];
}
interface WorkRow {
  source_candidate?:
    | (NonNullable<FindingWorkContext["sourcePin"]> & { candidateHash: string })
    | null;
  id: string;
  kind: DraftingJobRow["kind"];
  status: DraftingJobRow["status"];
  revision: number;
  result: DraftResult | null;
  basis_hash: string;
  subject_hash: string;
  finding_ids: string[];
  feedback: DraftingJobRow["repair_feedback"];
}
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export function checkedDisposition(value: unknown) {
  try {
    return parseFindingDisposition(value);
  } catch (error) {
    throw new RequestError(400, String(error));
  }
}
export async function indexFindingReports(tx: Queryable, versionId: string) {
  const rows = await tx.query<{
    id: string;
    package_id: string;
    lane_id: string;
    revision_key: string;
    output: AuthoringLaneOutput;
    guidance: AuthoringLaneOutput | null;
  }>(
    `select j.id,j.package_id,j.lane_id,coalesce(j.decision->>'confirmationHash',j.review_hash,j.result_hash) as revision_key,
      coalesce(j.decision->'decision'->'laneOutput',j.review_result->'laneOutput',j.result->'laneOutput') as output,
      coalesce(j.review_result->'nodeGuidance',j.result->'nodeGuidance') as guidance
    from drafting_jobs j where j.workflow_version_id=$1 and j.lane_id is not null
      and j.status in ('submitted','accepted','cancelled','rejected') and j.result_hash is not null
      and not exists(select 1 from finding_report_versions indexed where indexed.job_id=j.id and indexed.revision_key=coalesce(j.decision->>'confirmationHash',j.review_hash,j.result_hash))
    order by j.created_at,j.id`,
    [versionId],
  );
  for (const row of rows.rows) {
    const resultHash = canonicalHash({
      laneOutput: row.output,
      ...(row.guidance && { nodeGuidance: row.guidance }),
    });
    await tx.query(
      "insert into finding_report_versions values($1,$2,$3) on conflict do nothing",
      [row.id, row.revision_key, resultHash],
    );
    const items = [row.output, row.guidance].flatMap((output) => {
      if (!output) return [];
      const findings = [
        ...(output.findings ?? []),
        ...(output.review?.findings ?? []),
      ];
      if (!findings.length && output.action)
        findings.push({
          severity: "important",
          problem: output.action.requirement,
          fix: output.action.prompt,
        });
      return findings.map((finding) => ({ finding, lane: output.lane }));
    });
    for (const [ordinal, { finding, lane }] of items.entries()) {
      const id = canonicalHash({ job: row.id, result: resultHash, ordinal });
      await tx.query(
        "insert into finding_observations(id,workflow_version_id,job_id,package_id,lane,result_hash,ordinal,finding) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing",
        [
          id,
          versionId,
          row.id,
          row.package_id,
          lane,
          resultHash,
          ordinal,
          JSON.stringify(finding),
        ],
      );
      const disposition = finding.disposition;
      let existing = disposition?.findingId
        ? (
            await tx.query<{ id: string }>(
              "select id from authoring_findings where id=$1 and workflow_version_id=$2",
              [disposition.findingId, versionId],
            )
          ).rows[0]
        : undefined;
      if (!existing) {
        const key = disposition ? findingSubjectKey(disposition) : id;
        const findingId = canonicalHash({ versionId, key, observation: id });
        existing = (
          await tx.query<{ id: string }>(
            "insert into authoring_findings(id,workflow_version_id,subject_key,problem,disposition) values($1,$2,$3,$4,$5) on conflict(workflow_version_id,subject_key) do update set subject_key=excluded.subject_key returning id",
            [
              findingId,
              versionId,
              key,
              finding.problem,
              disposition ? JSON.stringify(disposition) : null,
            ],
          )
        ).rows[0]!;
      }
      await tx.query(
        "insert into finding_observation_links values($1,$2) on conflict do nothing",
        [existing.id, id],
      );
    }
  }
}
async function packageInputs(tx: Queryable, versionId: string) {
  const files = (
    await tx.query<{ path: string; content: string; hash: string }>(
      "select path,content,hash from package_implementation_files where workflow_version_id=$1 order by path",
      [versionId],
    )
  ).rows;
  const pkg = await readPackage(tx, versionId);
  const pins = (
    await tx.query<{
      id: string;
      hash: string;
      name: string;
      inventory: { path: string; hash: string }[];
    }>(
      "select p.skill_id as id,p.skill_version_hash as hash,s.name,v.inventory from workflow_skill_pins p join skills s on s.id=p.skill_id join skill_versions v on v.skill_id=p.skill_id and v.hash=p.skill_version_hash where p.workflow_version_id=$1 order by p.skill_id",
      [versionId],
    )
  ).rows;
  return { files, pkg, pins };
}
function currentSubject(
  row: FindingRow,
  inputs: Awaited<ReturnType<typeof packageInputs>>,
  reviewedRemoval = false,
) {
  const target = row.disposition?.target;
  const missingHash = target ? canonicalHash({ absent: target }) : null;
  const absence =
    reviewedRemoval || row.adopted_hash === missingHash ? missingHash : null;
  if (target && row.disposition?.sourceSkillId) {
    const pin = inputs.pins.find(
      (pin) => pin.id === row.disposition!.sourceSkillId,
    );
    if (!pin) return null;
    const entries = pin.inventory.filter((file) =>
      inPackageImplementationScope(target, file.path),
    );
    return target.endsWith("/")
      ? canonicalHash(entries.map((file) => [file.path, file.hash]).sort())
      : (entries[0]?.hash ??
          (row.candidate_source_hash === pin.hash ? missingHash : absence));
  }
  if (target?.startsWith("implementation/") && target.endsWith("/"))
    return canonicalHash(
      inputs.files
        .filter((file) => inPackageImplementationScope(target, file.path))
        .map((file) => [file.path, file.hash]),
    );
  if (target?.startsWith("implementation/"))
    return inputs.files.find((file) => file.path === target)?.hash ?? absence;
  if (row.disposition?.route === "plan")
    return inputs.pkg?.invalidated_at == null
      ? (inputs.pkg?.plan_version_hash ?? null)
      : null;
  return inputs.pkg && !inputs.pkg.invalidated_at
    ? (inputs.pkg.assembled_hash ?? inputs.pkg.scaffold_hash)
    : null;
}
export async function readFindings(tx: Queryable, versionId: string) {
  await indexFindingReports(tx, versionId);
  const findings = (
    await tx.query<FindingRow>(
      "select * from authoring_findings where workflow_version_id=$1 order by id",
      [versionId],
    )
  ).rows;
  const observations = (
    await tx.query<Observation & { finding_ids: string[]; current: boolean }>(
      `select o.*,array(select l.finding_id from finding_observation_links l where l.observation_id=o.id order by 1) as finding_ids,
     (j.status <> 'rejected' and (j.status <> 'cancelled' or pkg.invalidated_at is not null) and exists(
       select 1 from finding_report_versions indexed where indexed.job_id=j.id and indexed.result_hash=o.result_hash
       and indexed.revision_key=coalesce(j.decision->>'confirmationHash',j.review_hash,j.result_hash))) as current
     from finding_observations o join drafting_jobs j on j.id=o.job_id join workflow_packages pkg on pkg.id=o.package_id where o.workflow_version_id=$1 order by j.created_at,o.ordinal`,
      [versionId],
    )
  ).rows;
  if (observations.length) {
    const repairs = await tx.query<{
      job_id: string;
      plan_id: string;
      reports: { jobId: string; resultHash: string }[];
      resolutions: Record<string, { status: string; explanation: string }>;
    }>(
      `select id as job_id,decision->>'planVersionId' as plan_id,
        (select jsonb_agg(jsonb_build_object('jobId',report->>'jobId','resultHash',report->>'resultHash')) from jsonb_array_elements(context_bundle->'planRepair'->'reports') report) as reports,
        decision->'decision'->'resolutions' as resolutions from drafting_jobs
        where workflow_version_id=$1 and status='accepted' and context_bundle ? 'planRepair'
        and decision->'decision' ? 'resolutions' order by updated_at,id`,
      [versionId],
    );
    for (const repair of repairs.rows) {
      const hashes = new Map(
        (repair.reports ?? []).map((report) => [
          report.jobId,
          report.resultHash,
        ]),
      );
      for (const observation of observations) {
        const resolution =
          repair.resolutions[observation.job_id + "/" + observation.ordinal];
        if (
          resolution &&
          hashes.get(observation.job_id) === observation.result_hash
        ) {
          (observation.priorRepairs ??= []).push({
            jobId: repair.job_id,
            planVersionId: repair.plan_id,
            ...resolution,
          });
        }
      }
    }
  }
  const work = (
    await tx.query<WorkRow>(
      `select j.id,j.kind,j.status,j.revision,coalesce(case when j.status='accepted' then j.decision->'decision' end,j.review_result,j.result) as result,j.repair_feedback as feedback,w.basis_hash,w.subject_hash,w.source_candidate,
    array(select l.finding_id from finding_work_links l where l.job_id=j.id order by 1) as finding_ids
    from finding_work w join drafting_jobs j on j.id=w.job_id where w.workflow_version_id=$1 order by w.created_at,j.id`,
      [versionId],
    )
  ).rows;
  const inputs = await packageInputs(tx, versionId);
  const protocolHash =
    inputs.pkg && inputs.pkg.invalidated_at === null
      ? inputs.pkg.authoring_plan.workflowProtocolHash
      : null;
  const existingRepairs = (
    await tx.query<{ id: string; status: string; revision: number }>(
      "select id,status,revision from drafting_jobs where workflow_version_id=$1 and kind='draft-plan' and context_bundle ? 'planRepair' and not context_bundle ? 'findingWork' and deleted_at is null and status in ('claimed','queued','submitted') order by created_at,id",
      [versionId],
    )
  ).rows;
  const items = findings.map((row) => {
    const subjectHash = currentSubject(row, inputs);
    const adoptedSource =
      !!row.candidate_source_hash &&
      inputs.pins.some(
        (pin) =>
          pin.id === row.disposition?.sourceSkillId &&
          pin.hash === row.candidate_source_hash,
      );
    return {
      ...row,
      subjectHash,
      status: findingVerificationState({
        dismissed:
          !!row.dismissal ||
          (!observations.some(
            (o) => o.current && o.finding_ids.includes(row.id),
          ) &&
            !work.some(
              (w) => w.status === "accepted" && w.finding_ids.includes(row.id),
            )),
        reviewed: row.reviewed,
        adoptedHash: adoptedSource ? subjectHash : row.adopted_hash,
        verifiedHash: row.verified_hash,
        currentHash: subjectHash,
        verifierCurrent:
          row.verified_requirement_hash === canonicalHash(row.disposition) &&
          (!row.disposition?.verifier ||
            (protocolHash !== null &&
              protocolHash === row.verified_protocol_hash)),
      }),
    };
  });
  const questions = (
    await tx.query<{
      findingId: string;
      roundId: string;
      questionId: string;
      workRevision: number;
    }>(
      `select e.finding_id as "findingId",e.payload->>'roundId' as "roundId",e.payload->>'questionId' as "questionId",(e.payload->>'workRevision')::int as "workRevision"
     from finding_events e join authoring_findings f on f.id=e.finding_id where f.workflow_version_id=$1 and e.kind='question-drafted' order by e.created_at,e.id`,
      [versionId],
    )
  ).rows;
  const hash = canonicalHash({
    package: inputs.pkg?.id,
    findings: items.map((row) => [
      row.id,
      row.revision,
      row.status,
      row.subjectHash,
    ]),
    observations: observations.map((o) => [o.id, o.current, o.finding_ids]),
    work: work.map((w) => [w.id, w.revision]),
    existingRepairs,
    questions,
  });
  return {
    hash,
    packageId: inputs.pkg?.id ?? null,
    protocolHash,
    pins: inputs.pins.map(({ id, hash, name }) => ({ id, hash, name })),
    laneTargets:
      inputs.pkg?.authoring_plan.lanes.map(
        ({ id, claims, derivedClaims, contentLeaves }) => ({
          id,
          targets: [
            ...new Set([...claims, ...derivedClaims, ...contentLeaves]),
          ],
        }),
      ) ?? [],
    findings: items,
    observations,
    work,
    existingRepairs,
    questions,
  };
}
export async function findingHandoff(
  tx: Queryable,
  versionId: string,
  lane: AuthoringLaneId,
) {
  const view = await readFindings(tx, versionId);
  const items = view.findings.filter((item) => {
    const linked = view.observations.filter((o) =>
      o.finding_ids.includes(item.id),
    );
    if (item.dismissal || (!linked.some((o) => o.current) && !item.reviewed))
      return false;
    return (
      lane === "skill-review" ||
      linked.some((o) => o.lane === lane) ||
      (item.disposition?.route === "lane" &&
        view.laneTargets.some(
          (def) =>
            def.id === lane &&
            (def.id === item.disposition?.target ||
              def.targets.includes(item.disposition!.target)),
        ))
    );
  });
  const ids = new Set(items.map((item) => item.id));
  const observations = view.observations.filter((o) =>
    o.finding_ids.some((id) => ids.has(id)),
  );
  const files = await observationFiles(tx, observations);
  const history = items.map((item) => ({
    id: item.id,
    problem: item.problem,
    status: item.status,
    disposition: item.disposition,
    subjectHash: item.subjectHash,
    observations: observations
      .filter((o) => o.finding_ids.includes(item.id))
      .map((o) => ({
        jobId: o.job_id,
        resultHash: o.result_hash,
        ordinal: o.ordinal,
        lane: o.lane,
        current: o.current,
        problem: o.finding.problem,
        fix: o.finding.fix,
        citations: o.finding.evidence ?? [],
        evidenceFiles: o.evidenceFiles ?? [],
        unavailableInputs: o.unavailableInputs ?? [],
        ...(o.priorRepairs && { priorRepairs: o.priorRepairs }),
      })),
    work: view.work
      .filter((w) => w.finding_ids.includes(item.id))
      .map((w) => ({
        jobId: w.id,
        kind: w.kind,
        status: w.status,
        subjectHash: w.subject_hash,
        ...(w.status === "accepted" &&
          w.result &&
          ("verification" in w.result
            ? { verification: w.result.verification }
            : "implementation" in w.result
              ? {
                  implementation: {
                    summary: w.result.implementation.summary,
                    tests: w.result.implementation.tests,
                    missing: w.result.implementation.missing,
                  },
                }
              : {})),
      })),
  }));
  return { history, files };
}

export function findingAssignmentCurrent(
  job: DraftingJobRow,
  view: Awaited<ReturnType<typeof readFindings>>,
) {
  const work = job.context_bundle.findingWork;
  if (!work) return true;
  if (
    work.prerequisiteEvidence?.some((e) => {
      const item = view.findings.find((f) => f.id === e.id);
      return (
        !item ||
        item.dismissal ||
        (item.status !== "verified" && item.status !== "awaiting-evidence") ||
        item.subjectHash !== e.hash
      );
    })
  )
    return false;
  if (work.verifier && work.verifierProtocolHash !== view.protocolHash)
    return false;
  if (
    work.sourcePin &&
    view.pins.find((pin) => pin.id === work.sourcePin!.skillId)?.hash !==
      work.sourcePin.hash
  )
    return false;
  const originalObservations = new Set(
    work.observations.map((observation) => observation.id),
  );
  return work.tasks.every((task) => {
    const finding = view.findings.find((candidate) => candidate.id === task.id);
    if (
      !finding ||
      finding.dismissal ||
      finding.work_revision !== task.workRevision
    )
      return false;
    if (
      (job.kind === "verify-finding" || job.kind === "implement-finding") &&
      finding.subjectHash !== task.targetHash
    )
      return false;
    return view.observations.some(
      (observation) =>
        observation.current &&
        originalObservations.has(observation.id) &&
        observation.finding_ids.includes(task.id),
    );
  });
}

export async function findingGate(
  tx: Queryable,
  versionId: string,
  gate: "assembly" | "review",
) {
  const view = await readFindings(tx, versionId);
  const current = view.findings.filter(
    (finding) => finding.reviewed && !finding.dismissal,
  );
  return {
    hash: current.length
      ? canonicalHash(
          current.map((finding) => [
            finding.id,
            finding.revision,
            finding.status,
            finding.subjectHash,
          ]),
        )
      : undefined,
    blockers: current
      .filter((finding) =>
        findingBlocksGate(
          finding.disposition,
          finding.reviewed,
          finding.status,
          gate,
        ),
      )
      .map((finding) => finding.problem),
  };
}

export async function findingSummary(tx: Queryable, versionId: string) {
  const exists = await tx.query(
    "select 1 from authoring_findings where workflow_version_id=$1 and reviewed limit 1",
    [versionId],
  );
  if (!exists.rows.length) return [];
  const view = await readFindings(tx, versionId);
  return view.findings
    .filter(
      (item) =>
        item.reviewed && !["verified", "not-applicable"].includes(item.status),
    )
    .map((item) => ({
      id: item.id,
      problem: item.problem,
      status: item.status,
      route: item.disposition?.route ?? null,
    }));
}
async function event(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  id: string,
  kind: string,
  payload: unknown,
) {
  await tx.query("insert into finding_events values($1,$2,$3,$4,$5,$6)", [
    deps.ids.next(),
    id,
    kind,
    actor.personId,
    JSON.stringify(payload),
    deps.clock.now(),
  ]);
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    value.some((id) => typeof id !== "string") ||
    new Set(value).size !== value.length
  )
    throw new RequestError(400, "Choose one or more distinct items");
  return value as string[];
}
async function group(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  versionId: string,
  observationIds: string[],
  disposition: FindingDisposition,
  view: Awaited<ReturnType<typeof readFindings>>,
  existingId?: string,
) {
  const observations = observationIds.map((id) =>
    view.observations.find((o) => o.id === id),
  );
  if (observations.some((o) => !o?.current))
    throw new RequestError(
      409,
      "Choose current observations from this workflow version",
    );
  const key = findingSubjectKey(disposition);
  const existing = existingId
    ? view.findings.find((f) => f.id === existingId)
    : view.findings.find((f) => f.subject_key === key);
  if (existingId && !existing) throw new RequestError(404, "Unknown finding");
  const suggested = view.findings.find((f) => f.subject_key === key);
  if (existing && suggested && suggested.id !== existing.id) {
    if (suggested.reviewed)
      throw new RequestError(
        409,
        "Link to the reviewed finding that already has this subject and target.",
      );
    await tx.query(
      "insert into finding_observation_links select $1,observation_id from finding_observation_links where finding_id=$2 on conflict do nothing",
      [existing.id, suggested.id],
    );
    await tx.query(
      "delete from finding_observation_links where finding_id=$1",
      [suggested.id],
    );
    await tx.query("update authoring_findings set subject_key=$2 where id=$1", [
      suggested.id,
      "superseded-" + suggested.id,
    ]);
  }
  if (disposition.sourceSkillId) {
    if (!view.pins.some((pin) => pin.id === disposition.sourceSkillId))
      throw new RequestError(400, "Choose a Skill pinned by this workflow");
    const path = disposition.target.endsWith("/")
      ? disposition.target + "file"
      : disposition.target;
    if (normalizeSkillPath(path) !== path)
      throw new RequestError(400, "Use a normalized package Skill path");
  } else if (disposition.route === "implementation") {
    try {
      packageImplementationPath(
        disposition.target.endsWith("/")
          ? disposition.target + "file"
          : disposition.target,
      );
    } catch (error) {
      throw new RequestError(400, String(error));
    }
  }
  if (disposition.route === "plan" && !disposition.target.startsWith("/"))
    throw new RequestError(
      400,
      "Name a Plan field or insertion point using a JSON pointer",
    );
  if (
    disposition.route === "lane" &&
    !view.laneTargets.some(
      (lane) =>
        lane.id === disposition.target ||
        lane.targets.includes(disposition.target),
    )
  )
    throw new RequestError(
      400,
      "Choose a current authoring lane, claim or authored leaf",
    );
  const id = existing?.id ?? canonicalHash({ versionId, key });
  const visited = new Set<string>();
  const checkPrerequisite = (dependencyId: string) => {
    if (dependencyId === id)
      throw new RequestError(
        400,
        "A finding cannot depend on itself or one of its dependants",
      );
    if (visited.has(dependencyId)) return;
    visited.add(dependencyId);
    const dependency = view.findings.find((item) => item.id === dependencyId);
    if (!dependency)
      throw new RequestError(
        400,
        "Choose prerequisites from this workflow version",
      );
    dependency.disposition?.dependsOn?.forEach(checkPrerequisite);
  };
  disposition.dependsOn?.forEach(checkPrerequisite);
  if (!existing) {
    await tx.query(
      "insert into authoring_findings(id,workflow_version_id,subject_key,problem,disposition,reviewed) values($1,$2,$3,$4,$5,true)",
      [id, versionId, key, disposition.subject, JSON.stringify(disposition)],
    );
  } else {
    await tx.query(
      "update authoring_findings set disposition=$2,subject_key=$4,problem=$3,reviewed=true,dismissal=null,adopted_hash=case when subject_key=$4 then adopted_hash else null end,candidate_source_hash=case when subject_key=$4 then candidate_source_hash else null end,work_revision=work_revision+case when disposition is distinct from $2 or dismissal is not null then 1 else 0 end,revision=revision+1 where id=$1",
      [id, JSON.stringify(disposition), disposition.subject, key],
    );
  }
  for (const observation of observations) {
    await tx.query(
      "insert into finding_observation_links values($1,$2) on conflict do nothing",
      [id, observation!.id],
    );
    await tx.query(
      `delete from finding_observation_links l using authoring_findings f where l.finding_id=f.id and l.observation_id=$1 and l.finding_id<>$2 and not f.reviewed`,
      [observation!.id, id],
    );
  }
  await event(tx, deps, actor, id, "reviewed", { observationIds, disposition });
  return id;
}
export async function findingCommand(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  workflowId: string,
  versionId: string,
  value: Record<string, unknown>,
  config: ServiceConfig,
) {
  const request = value.requestId;
  if (
    value.confirmed !== true ||
    typeof request !== "string" ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(request)
  )
    throw new RequestError(400, "Confirm the finding action with a request ID");
  const inputHash = canonicalHash(value);
  const replay = (
    await tx.query<{ input_hash: string; response: unknown }>(
      "select input_hash,response from finding_requests where workflow_version_id=$1 and person_id=$2 and request_id=$3",
      [versionId, actor.personId, request],
    )
  ).rows[0];
  if (replay) {
    if (replay.input_hash !== inputHash)
      throw new RequestError(
        409,
        "This request ID was used for another finding action",
      );
    return replay.response;
  }
  const view = await readFindings(tx, versionId);
  if (value.hash !== view.hash)
    throw new RequestError(
      409,
      "The findings changed. Reload before confirming.",
    );
  let response: unknown;
  if (value.action === "group") {
    const id = await group(
      tx,
      deps,
      actor,
      versionId,
      ids(value.observationIds),
      checkedDisposition(value.disposition),
      view,
      typeof value.findingId === "string" ? value.findingId : undefined,
    );
    response = { findingId: id };
  } else if (value.action === "dismiss" || value.action === "reopen") {
    if (
      typeof value.reason !== "string" ||
      !value.reason.trim() ||
      value.reason.length > 4000
    )
      throw new RequestError(400, "Supply a reason");
    const item = view.findings.find((f) => f.id === value.findingId);
    if (!item) throw new RequestError(404, "Unknown finding");
    await tx.query(
      "update authoring_findings set dismissal=$2,reviewed=true,verified_hash=null,adopted_hash=null,candidate_source_hash=null,work_revision=work_revision+1,revision=revision+1 where id=$1",
      [item.id, value.action === "dismiss" ? value.reason : null],
    );
    await event(tx, deps, actor, item.id, value.action, value.reason);
    response = { findingId: item.id };
  } else if (value.action === "supersede-plan") {
    const prior = view.existingRepairs.find(
      (job) => job.id === value.jobId && job.status !== "claimed",
    );
    if (!prior)
      throw new RequestError(
        409,
        "Choose an available wave repair after its drafting session finishes",
      );
    const job = (
      await tx.query<DraftingJobRow>(
        "update drafting_jobs set status='cancelled',superseded_by_findings=true,revision=revision+1,updated_at=$2 where id=$1 returning *",
        [prior.id, deps.clock.now()],
      )
    ).rows[0]!;
    await finishInbox(tx, deps, job.id);
    await auditJob(
      tx,
      deps,
      actor,
      job,
      "cancelled",
      prior.revision,
      "Engineer chose individual finding assignments",
    );
    response = { jobId: job.id };
  } else if (value.action === "ask-expert") {
    const item = view.findings.find((f) => f.id === value.findingId);
    if (
      !item?.reviewed ||
      item.dismissal ||
      item.disposition?.route !== "question" ||
      !view.observations.some(
        (o) => o.current && o.finding_ids.includes(item.id),
      )
    )
      throw new RequestError(
        409,
        "Review the expert question and its current observations first",
      );
    const prior = view.questions.find(
      (q) => q.findingId === item.id && q.workRevision === item.work_revision,
    );
    if (prior) response = prior;
    else {
      const round = await createRound(
        tx,
        deps,
        actor,
        versionId,
        item.problem.slice(0, 200),
      );
      const question = await saveQuestion(
        tx,
        deps,
        actor,
        versionId,
        round.id,
        {
          text: item.disposition.acceptance,
          rationale: item.disposition.authority,
          topic: "scope",
          targets: [{ kind: "workflow", id: "workflow" }],
          evidence: [],
          assignees: [{ kind: "role", role: "Field expert" }],
          priority: 100,
        },
      );
      response = {
        findingId: item.id,
        roundId: round.id,
        questionId: question.id,
        workRevision: item.work_revision,
      };
      await event(tx, deps, actor, item.id, "question-drafted", response);
    }
  } else if (value.action === "dispatch") {
    response = await dispatchFindingWork(
      tx,
      deps,
      actor,
      workflowId,
      versionId,
      value,
      view,
      config,
    );
  } else throw new RequestError(400, "Unknown finding action");
  await tx.query("insert into finding_requests values($1,$2,$3,$4,$5)", [
    versionId,
    actor.personId,
    request,
    inputHash,
    JSON.stringify(response),
  ]);
  return response;
}
async function dispatchFindingWork(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  workflowId: string,
  versionId: string,
  value: Record<string, unknown>,
  view: Awaited<ReturnType<typeof readFindings>>,
  config: ServiceConfig,
) {
  const selected = ids(value.findingIds).map((id) =>
    view.findings.find((f) => f.id === id),
  );
  if (selected.some((f) => !f || f.dismissal))
    throw new RequestError(
      400,
      "Choose active findings from this workflow version",
    );
  const items = selected.map((f) => f!);
  if (
    value.kind === "verify-finding" &&
    items.some((item) => item.disposition?.route === "badger")
  )
    throw new RequestError(
      400,
      "Track Badger platform defects separately from package verification",
    );
  if (
    value.kind !== undefined &&
    !["verify-finding", "draft-dispositions"].includes(String(value.kind))
  )
    throw new RequestError(400, "Unsupported work dispatch");
  const current = await draftingContext(
    tx,
    workflowId,
    versionId,
    actor.personId,
  );
  const inputs = await packageInputs(tx, versionId);
  const assignments: (typeof items)[] = [];
  const jobIds = new Set<string>();
  const previousWork = (
    await tx.query<DraftingJobRow>(
      `select j.* from drafting_jobs j where j.workflow_version_id=$1 and j.status in ('queued','claimed','submitted','accepted') and j.deleted_at is null
      and exists(select 1 from finding_work_links l where l.job_id=j.id and l.finding_id=any($2::text[])) order by j.created_at desc,j.id desc`,
      [versionId, items.map((item) => item.id)],
    )
  ).rows;
  const waiting: { findingId: string; reason: string }[] = [];
  const prerequisiteEvidenceById = new Map<
    string,
    NonNullable<FindingWorkContext["prerequisiteEvidence"]>[number]
  >();
  if (value.kind === "draft-dispositions") assignments.push(items);
  else {
    for (const item of items) {
      if (!item.reviewed || !item.disposition)
        throw new RequestError(
          409,
          "Review the finding disposition before dispatch",
        );
      const missing: string[] = [];
      for (const id of item.disposition.dependsOn ?? []) {
        const dependency = view.findings.find((f) => f.id === id);
        const evidence = [...view.work]
          .reverse()
          .find(
            (job) =>
              job.status === "accepted" &&
              job.finding_ids.includes(id) &&
              job.result &&
              ("verification" in job.result
                ? job.result.verification.outcome === "passed" &&
                  job.result.verification.subjectHash ===
                    dependency?.subjectHash
                : "implementation" in job.result &&
                  job.result.implementation.changes.length > 0),
          );
        if (
          !dependency?.subjectHash ||
          !["verified", "awaiting-evidence"].includes(dependency.status) ||
          !evidence
        )
          missing.push(dependency?.problem ?? id);
        else
          prerequisiteEvidenceById.set(id, {
            id,
            hash: dependency.subjectHash,
            jobId: evidence.id,
            result: evidence.result,
          });
      }
      if (missing.length) {
        waiting.push({
          findingId: item.id,
          reason: "Waiting for reviewed evidence for " + missing.join(", "),
        });
        continue;
      }
      if (
        value.kind !== "verify-finding" &&
        !["implementation", "verification", "plan", "lane"].includes(
          item.disposition.route,
        )
      )
        throw new RequestError(
          400,
          "Open the stage identified by this finding. Platform defects are reported separately.",
        );
      const kinds =
        value.kind === "verify-finding" ||
        item.disposition.route === "verification"
          ? ["verify-finding"]
          : item.disposition.route === "implementation"
            ? ["implement-finding"]
            : item.disposition.route === "plan"
              ? ["draft-plan"]
              : ["authoring-lane", "review-vote"];
      const previous = previousWork.find((job) => {
        if (!kinds.includes(job.kind)) return false;
        const task = job.context_bundle.findingWork?.tasks.find(
          (t) => t.id === item.id,
        );
        if (!task || task.workRevision !== item.work_revision) return false;
        if (job.status !== "accepted")
          return (
            findingAssignmentCurrent(job, view) &&
            (job.kind !== "draft-plan" ||
              job.context_bundle.planning?.basePlanVersionId ===
                current.bundle.planning?.basePlanVersionId)
          );
        if (job.kind === "implement-finding")
          return (
            item.status === "awaiting-evidence" ||
            item.status === "verified" ||
            Boolean(
              item.candidate_source_hash &&
              job.context_bundle.findingWork?.sourcePin?.hash ===
                view.pins.find((p) => p.id === item.disposition?.sourceSkillId)
                  ?.hash,
            )
          );
        return (
          job.kind === "verify-finding" &&
          item.status === "verified" &&
          task.targetHash === item.subjectHash
        );
      });
      if (previous) {
        jobIds.add(previous.id);
        continue;
      }
      let assignment = assignments.find(
        (list) =>
          list[0].disposition?.route === item.disposition?.route &&
          ((item.disposition?.route === "lane" &&
            value.kind !== "verify-finding" &&
            inputs.pkg &&
            findingTargetLane(
              inputs.pkg.authoring_plan,
              item.disposition.target,
            ) ===
              findingTargetLane(
                inputs.pkg.authoring_plan,
                list[0].disposition!.target,
              )) ||
            (item.disposition?.route === "plan" &&
              value.kind !== "verify-finding") ||
            (list[0].disposition?.target === item.disposition?.target &&
              list[0].disposition?.sourceSkillId ===
                item.disposition?.sourceSkillId &&
              list[0].disposition?.environment ===
                item.disposition?.environment &&
              canonicalHash(list[0].disposition?.verifier ?? null) ===
                canonicalHash(item.disposition?.verifier ?? null))),
      );
      if (!assignment) {
        assignment = [];
        assignments.push(assignment);
      }
      assignment.push(item);
    }
  }
  for (const assignment of assignments) {
    const first = assignment[0]!;
    const prerequisiteEvidence = [
      ...new Set(assignment.flatMap((f) => f.disposition?.dependsOn ?? [])),
    ]
      .sort()
      .flatMap((id) => {
        const evidence = prerequisiteEvidenceById.get(id);
        return evidence ? [evidence] : [];
      });
    const assignedLane =
      value.kind === undefined &&
      first.disposition?.route === "lane" &&
      inputs.pkg
        ? findingTargetLane(inputs.pkg.authoring_plan, first.disposition.target)
        : undefined;
    if (
      value.kind === undefined &&
      first.disposition?.route === "lane" &&
      !assignedLane
    )
      throw new RequestError(
        409,
        "The lane target changed. Review the current generated authoring plan.",
      );
    const kind =
      value.kind === "draft-dispositions"
        ? "draft-dispositions"
        : value.kind === "verify-finding" ||
            first.disposition?.route === "verification"
          ? "verify-finding"
          : first.disposition?.route === "plan"
            ? "draft-plan"
            : assignedLane
              ? assignedLane === "skill-review"
                ? "review-vote"
                : "authoring-lane"
              : "implement-finding";
    const pin = current.bundle.pins.find(
      (p) => p.skillId === first.disposition?.sourceSkillId,
    );
    if (first.disposition?.sourceSkillId && !pin)
      throw new RequestError(409, "The selected Skill is no longer pinned");
    if (kind === "implement-finding" && !pin) {
      try {
        const target = first.disposition!.target;
        packageImplementationPath(
          target.endsWith("/") ? target + "file" : target,
        );
      } catch (error) {
        throw new RequestError(400, String(error));
      }
    }
    const findingIds = assignment.map((f) => f.id).sort();
    const observations = view.observations.filter(
      (o) => o.current && o.finding_ids.some((id) => findingIds.includes(id)),
    );
    if (!observations.length)
      throw new RequestError(409, "The source observations were withdrawn");
    const subjectHash =
      kind === "verify-finding" || assignedLane
        ? currentSubject(first, inputs)
        : kind === "draft-plan"
          ? current.bundle.planning?.basePlanVersionId
          : pin
            ? pin.hash
            : canonicalHash(
                inputs.files.filter(
                  (file) =>
                    first.disposition &&
                    inPackageImplementationScope(
                      first.disposition.target,
                      file.path,
                    ),
                ),
              );
    if (!subjectHash)
      throw new RequestError(
        409,
        "The target must exist before this job can run",
      );
    if (
      kind === "verify-finding" &&
      pin &&
      ((first.candidate_source_hash &&
        first.candidate_source_hash !== pin.hash) ||
        !inputs.pkg ||
        inputs.pkg.invalidated_at ||
        !inputs.pkg.inventory.some((file) =>
          file.path.startsWith("sources/" + pin.hash + "/"),
        ))
    )
      throw new RequestError(
        409,
        "Adopt the reviewed Skill version and regenerate the package before verification",
      );
    if (
      kind === "verify-finding" &&
      first.disposition?.target.startsWith("implementation/") &&
      (inputs.pkg?.invalidated_at !== null ||
        !inputs.files
          .filter((file) =>
            inPackageImplementationScope(first.disposition!.target, file.path),
          )
          .every((file) =>
            inputs.pkg?.inventory.some(
              (entry) => entry.path === file.path && entry.sha256 === file.hash,
            ),
          ))
    )
      throw new RequestError(
        409,
        "Regenerate the package with the adopted file before verifying it.",
      );
    const tasks = assignment
      .map((f) => ({
        id: f.id,
        problem: f.problem,
        disposition: f.disposition,
        workRevision: f.work_revision,
        targetHash: f.subjectHash,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    let verifier: FindingVerifierBinding | undefined;
    if (kind === "verify-finding" && first.disposition?.verifier) {
      const head = await readPlanHead(tx, versionId);
      if (
        !head ||
        head.hash !== inputs.pkg?.plan_version_hash ||
        inputs.pkg.invalidated_at !== null
      )
        throw new RequestError(
          409,
          "Generate the package from the approved verifier binding before verification",
        );
      try {
        verifier = await bindFindingVerifier(
          normalizeWorkflow(head.snapshot.plan.workflow).protocol,
          first.disposition.verifier,
        );
      } catch (error) {
        throw new RequestError(409, String(error));
      }
    }
    const basisHash = canonicalHash({
      kind,
      subjectHash,
      tasks,
      prerequisiteEvidence,
      ...(verifier && { verifier }),
    });
    const previous = (
      await tx.query<{ id: string }>(
        `select j.id from finding_work w join drafting_jobs j on j.id=w.job_id where w.workflow_version_id=$1 and w.basis_hash=$2 and j.status in ('queued','claimed','submitted','accepted') order by w.created_at desc limit 1`,
        [versionId, basisHash],
      )
    ).rows[0];
    if (previous) {
      jobIds.add(previous.id);
      continue;
    }
    const files = await observationFiles(tx, observations);
    let verificationPackage: PackageSnapshot | undefined;
    if (kind === "verify-finding") {
      const pkg = inputs.pkg;
      if (!pkg || pkg.invalidated_at)
        throw new RequestError(
          409,
          "Regenerate the package before checking its files.",
        );
      const inventory = pkg.assembled_inventory ?? pkg.inventory;
      try {
        verificationPackage = await createPackageSnapshot(
          path.join(
            workspaceLocation(config, versionId).root,
            pkg.package_path,
          ),
          inventory,
        );
      } catch {
        throw new RequestError(
          409,
          "The candidate files differ from their recorded inventory. Regenerate or reassemble the current package.",
        );
      }
      if (
        verificationPackage.packageHash !==
        (pkg.assembled_hash ?? pkg.scaffold_hash)
      )
        throw new RequestError(
          409,
          "The verification package differs from the reviewed generation.",
        );
    }
    const work: FindingWorkContext = {
      ...(verificationPackage && { verificationPackage }),
      prerequisiteEvidence,
      ...(verifier && {
        verifier,
        verifierProtocolHash: inputs.pkg!.authoring_plan.workflowProtocolHash,
      }),
      ...(pin && {
        sourcePin: {
          skillId: pin.skillId,
          hash: pin.hash,
          purpose: pin.purpose,
          revision: pin.revision,
        },
      }),
      findingIds,
      basisHash,
      subjectHash,
      tasks,
      observations,
      files,
      packageFiles: inputs.files,
    };
    let repair: PlanRepair | undefined;
    if (kind === "draft-plan") {
      const head = await readPlanHead(tx, versionId);
      if (!head || !current.bundle.planning || !inputs.pkg)
        throw new RequestError(
          409,
          "Approve the current Plan basis before dispatch",
        );
      if (
        tasks.some(
          (task) =>
            !planFindingTargetHash(
              head.snapshot.plan,
              task.disposition!.target,
            ),
        )
      )
        throw new RequestError(
          409,
          "Choose a field or insertion point with a current parent in the Plan.",
        );
      const reports: PlanRepairReport[] = [];
      for (const observation of observations) {
        let report = reports.find(
          (entry) =>
            entry.jobId === observation.job_id &&
            entry.resultHash === observation.result_hash,
        );
        if (!report) {
          report = {
            jobId: observation.job_id,
            lane: observation.lane as AuthoringLaneId,
            resultHash: observation.result_hash,
            action: {
              kind: "repair",
              target: { stage: "plan" },
              requirement: "Apply the Engineer's selected Plan changes",
              prompt:
                "Use the reviewed finding targets, authorities and acceptance examples in findingWork.",
            },
            findings: [],
          };
          reports.push(report);
        }
        report.findings.push(observation.finding);
      }
      const busy = (
        await tx.query<{ id: string }>(
          "select id from drafting_jobs where workflow_version_id=$1 and kind='draft-plan' and context_bundle ? 'planRepair' and deleted_at is null and status in ('queued','claimed','submitted') limit 1",
          [versionId],
        )
      ).rows[0];
      if (busy)
        throw new RequestError(
          409,
          "Finish or supersede the existing Plan repair before dispatching another.",
          { jobId: busy.id },
        );
      repair = {
        basisHash,
        packageId: inputs.pkg.id,
        wave: authoringLaneWave(reports[0].lane),
        basePlan: { id: head.id, hash: head.hash, plan: head.snapshot.plan },
        reports,
        selectedItems: tasks.map((task) => ({
          id: task.id,
          source: "plan",
          description: task.problem,
        })),
      };
    }
    let job: DraftingJobRow;
    if (assignedLane) {
      const [revision] = await requestLaneJobs(
        tx,
        config,
        deps,
        actor,
        workflowId,
        versionId,
        assignedLane,
        undefined,
        undefined,
        work,
      );
      if (!revision)
        throw new RequestError(
          409,
          "The lane needs its current report reviewed or its dependencies accepted before revision",
        );
      job = revision;
    } else
      job = await createDraftingJob(
        tx,
        deps,
        actor,
        versionId,
        {
          kind,
          roundId: null,
          parentQuestionId: null,
          skillId: null,
          questionId: null,
          locale: null,
        },
        current,
        repair,
        work,
      );
    await tx.query(
      "insert into finding_work(job_id,workflow_version_id,basis_hash,subject_hash,created_at) values($1,$2,$3,$4,$5)",
      [job.id, versionId, basisHash, subjectHash, deps.clock.now()],
    );
    for (const id of findingIds) {
      await tx.query("insert into finding_work_links values($1,$2)", [
        job.id,
        id,
      ]);
      await event(tx, deps, actor, id, "dispatched", {
        jobId: job.id,
        kind,
        basisHash,
      });
    }
    jobIds.add(job.id);
  }
  if (!jobIds.size && waiting.length)
    throw new RequestError(409, waiting.map((w) => w.reason).join("\n"), {
      waiting,
    });
  return { jobIds: [...jobIds], waiting };
}
async function observationFiles(tx: Queryable, observations: Observation[]) {
  if (!observations.length) return [];
  const jobs = [...new Set(observations.map((o) => o.job_id))];
  const rows = await tx.query<{
    id: string;
    files: FindingWorkContext["files"];
  }>(
    "select id,context_bundle->'authoring'->'files' as files from drafting_jobs where id=any($1::text[]) order by id",
    [jobs],
  );
  const files: FindingWorkContext["files"] = [];
  const seen = new Set<string>();
  let total = 0;
  const byJob = new Map(rows.rows.map((row) => [row.id, row.files ?? []]));
  for (const observation of observations) {
    const citedPaths = [
      ...new Set(
        (observation.finding.evidence ?? []).flatMap(
          (citation) => citation.match(/\binputs\/[\w./-]+/g) ?? [],
        ),
      ),
    ];
    const original = byJob.get(observation.job_id) ?? [];
    for (const cited of citedPaths) {
      const file = original.find(
        (f) => f.path === cited || f.path === cited.replace(/[.]$/, ""),
      );
      if (!file || digest(file.text) !== file.hash) {
        (observation.unavailableInputs ??= []).push(cited);
        continue;
      }
      const path = "inputs/history/" + file.hash;
      (observation.evidenceFiles ??= []).push({
        originalPath: file.path,
        path,
        hash: file.hash,
      });
      if (seen.has(file.hash)) continue;
      total += Buffer.byteLength(file.text);
      if (total > 16 * 1024 * 1024)
        throw new RequestError(
          413,
          "The cited finding evidence exceeds 16 MiB",
        );
      seen.add(file.hash);
      files.push({ ...file, path });
    }
  }
  return files;
}
export function validateFindingResult(
  job: DraftingJobRow,
  result: DraftResult,
) {
  const work = job.context_bundle.findingWork;
  if (!work) return;
  if ("implementation" in result) {
    const { changes, missing } = result.implementation;
    if (!changes.length && !missing?.trim())
      throw new RequestError(
        400,
        "Return package file changes or identify the missing input",
      );
    if (changes.length && missing)
      throw new RequestError(
        400,
        "Finish the patch or return its missing prerequisite",
      );
    const targets = new Set(work.tasks.map((task) => task.disposition?.target));
    const seen = new Set<string>();
    for (const change of changes) {
      let path: string;
      try {
        path = work.sourcePin
          ? normalizeSkillPath(change.path)
          : packageImplementationPath(change.path);
      } catch (error) {
        throw new RequestError(400, String(error));
      }
      if (
        path !== change.path ||
        ![...targets].some(
          (target) => target && inPackageImplementationScope(target, path),
        ) ||
        seen.has(path.toLowerCase())
      )
        throw new RequestError(
          400,
          "The change must target a distinct file in the reviewed package scope",
        );
      seen.add(path.toLowerCase());
      const base = work.sourcePin
        ? job.context_bundle.pins
            .find((pin) => pin.skillId === work.sourcePin!.skillId)!
            .inventory.find((file) => file.path === path)
        : work.packageFiles.find((file) => file.path === path);
      if (
        (base?.hash ?? null) !== change.previousHash ||
        (change.content === null && !base)
      )
        throw new RequestError(
          409,
          "The patch base differs from the dispatched file",
        );
      if (
        base &&
        change.content !== null &&
        digest(change.content) === base.hash
      )
        throw new RequestError(400, "The patch has no changes");
    }
  }
  if ("verification" in result) {
    if (result.verification.subjectHash !== work.subjectHash)
      throw new RequestError(409, "Verify the exact dispatched target hash");
    if (
      result.verification.outcome === "passed" &&
      work.tasks.some(
        (task) =>
          task.disposition?.environment &&
          task.disposition.environment !== result.verification.environment,
      )
    )
      throw new RequestError(
        409,
        "A passing check must identify the installation and tool versions in the assignment.",
      );
  }
  if (
    "verification" in result &&
    work.verifier &&
    result.verification.outcome === "passed"
  ) {
    try {
      verifyFindingReceipt(
        work.verifier,
        work.subjectHash,
        result.verification.receipt,
      );
    } catch (error) {
      throw new RequestError(400, String(error));
    }
  }
  if ("dispositions" in result) {
    const seen = new Set<string>();
    for (const entry of result.dispositions) {
      checkedDisposition(entry.disposition);
      for (const id of entry.observationIds) {
        if (!work.observations.some((o) => o.id === id))
          throw new RequestError(
            400,
            "Group only the observations in this job",
          );
        seen.add(id);
      }
    }
    if (work.observations.some((o) => !seen.has(o.id)))
      throw new RequestError(400, "Account for each dispatched observation");
  }
}
export async function acceptFindingResult(
  tx: Queryable,
  deps: ServiceDependencies,
  actor: DraftingActor,
  job: DraftingJobRow,
  result: DraftResult,
  blobs: BlobStore,
  config: ServiceConfig,
) {
  const work = job.context_bundle.findingWork;
  if (!work) return;
  validateFindingResult(job, result);
  const version = job.workflow_version_id;
  const view = await readFindings(tx, version);
  if (!findingAssignmentCurrent(job, view))
    throw new RequestError(
      409,
      "The finding assignment changed. Review its current disposition and dispatch fresh work.",
    );
  const items = work.findingIds.map((id) =>
    view.findings.find((f) => f.id === id),
  );
  if (
    items.some(
      (item) =>
        !item ||
        item.dismissal ||
        !view.observations.some(
          (o) => o.current && o.finding_ids.includes(item.id),
        ),
    )
  )
    throw new RequestError(
      409,
      "A finding or its supporting observation is no longer current",
    );
  if ("dispositions" in result) {
    for (const entry of result.dispositions)
      await group(
        tx,
        deps,
        actor,
        version,
        entry.observationIds,
        checkedDisposition(entry.disposition),
        await readFindings(tx, version),
      );
  }
  if (
    "implementation" in result &&
    result.implementation.changes.length &&
    work.sourcePin
  ) {
    const pin = work.sourcePin;
    const skill = job.context_bundle.pins.find(
      (entry) => entry.skillId === pin.skillId,
    )!;
    const base = await readVersion(tx, pin.skillId, pin.hash);
    const edits = new Map(
      result.implementation.changes.map(
        (change) =>
          [
            change.path,
            change.content === null
              ? null
              : Buffer.from(change.content, "utf8"),
          ] as const,
      ),
    );
    const candidate = await inspectUploadFiles(
      config,
      skill.skillName,
      await applyFileChanges(blobs, base, edits),
    );
    await tx.query(
      "update finding_work set source_candidate=$2 where job_id=$1",
      [
        job.id,
        JSON.stringify({ ...pin, candidateHash: candidate.source.hash }),
      ],
    );
    await tx.query(
      "update authoring_findings set candidate_source_hash=$2,verified_hash=null,adopted_hash=null,revision=revision+1 where id=any($1::text[])",
      [work.findingIds, candidate.source.hash],
    );
  } else if (
    "implementation" in result &&
    result.implementation.changes.length
  ) {
    const inputs = await packageInputs(tx, version);
    for (const change of result.implementation.changes) {
      const existing = inputs.files.find(
        (f) => f.path.toLowerCase() === change.path.toLowerCase(),
      );
      if (
        (existing?.hash ?? null) !== change.previousHash ||
        (existing && existing.path !== change.path)
      )
        throw new RequestError(
          409,
          "The package file changed. Dispatch a fresh implementation job.",
        );
      if (change.content === null)
        await tx.query(
          "delete from package_implementation_files where workflow_version_id=$1 and path=$2",
          [version, change.path],
        );
      else
        await tx.query(
          "insert into package_implementation_files values($1,$2,$3,$4,$5) on conflict(workflow_version_id,path) do update set content=excluded.content,hash=excluded.hash,job_id=excluded.job_id",
          [
            version,
            change.path,
            change.content,
            digest(change.content),
            job.id,
          ],
        );
    }
    await invalidateGeneratedPackage(
      tx,
      deps,
      actor,
      version,
      "Reviewed package implementation changed. Regenerate to include the adopted files.",
    );
  }
  const inputs = await packageInputs(tx, version);
  try {
    validatePackageImplementationFiles(inputs.files);
  } catch (error) {
    throw new RequestError(409, String(error));
  }
  for (const item of items) {
    const removed =
      "implementation" in result &&
      result.implementation.changes.some(
        (file) =>
          file.path === item!.disposition?.target && file.content === null,
      );
    const subjectHash = currentSubject(item!, inputs, removed);
    if ("verification" in result && subjectHash !== work.subjectHash)
      throw new RequestError(409, "The verified target has changed");
    if (
      "implementation" in result &&
      result.implementation.changes.length &&
      !work.sourcePin
    )
      await tx.query(
        "update authoring_findings set adopted_hash=$2,verified_hash=null,revision=revision+1 where id=$1",
        [item!.id, subjectHash],
      );
    if ("verification" in result)
      await tx.query(
        "update authoring_findings set verified_hash=$2,verified_protocol_hash=$3,verified_requirement_hash=$4,revision=revision+1 where id=$1",
        [
          item!.id,
          result.verification.outcome === "passed" ? subjectHash : null,
          result.verification.outcome === "passed"
            ? (work.verifierProtocolHash ?? null)
            : null,
          canonicalHash(item!.disposition),
        ],
      );
    await event(tx, deps, actor, item!.id, "accepted", {
      jobId: job.id,
      subjectHash,
      resultHash: canonicalHash(result),
    });
  }
}
