import { invalidateSkillFactEvidence } from "./questionnaire/resolutions.js";
import { reconcileDossier } from "./dossier.js";
import { runGeneration } from "./generation.js";
import { runEvaluation } from "./evaluations.js";
import { runInitialization } from "./initialization.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  canonicalHash,
  checkSkillSources,
  type SkillScriptSideEffect,
  type SkillScriptSideEffects,
  type SkillSourceFile,
} from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "./audit.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { expireAnswerAttachments } from "./questionnaire/attachment-expiry.js";
import type { ServiceConfig } from "./config.js";
import type { BlobStore } from "./skills/blobs.js";
import { toIsoString } from "./util.js";
import type { StageState } from "./workflows.js";
import { invalidateGate } from "./gates.js";
import { notifyWorkflowRoles } from "./inbox.js";
import { invalidateStudyGates } from "./source-study-invalidation.js";

export type SkillPinPurpose = "source" | "upgrade-source";
export type SourceCheckStatus =
  "queued" | "running" | "passed" | "blocked" | "failed";
export type JobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** The notification channel a new job is announced on. */
export const WORKFLOW_JOB_CHANNEL = "badger_workflow_jobs";

const SUPERSEDED = "A later pin change superseded this check";

export interface WorkflowSkillPin {
  workflowVersionId: string;
  skillId: string;
  skillName: string;
  hash: string;
  purpose: SkillPinPurpose;
  revision: number;
  pinnedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSource {
  name: string;
  purpose: SkillPinPurpose;
  status: "available" | "missing" | "invalid" | "unsafe" | "ambiguous";
  hash: string | null;
  inventory: SkillSourceFile[];
  scripts: Array<{ path: string; sideEffects: SkillScriptSideEffects }>;
  ignored: string[];
  blockers: string[];
}

export interface SourceCheck {
  id: string;
  workflowVersionId: string;
  jobId: string | null;
  pinsHash: string;
  status: SourceCheckStatus;
  sources: PublicSource[];
  blockers: string[];
  workspacePath: string | null;
  revision: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * What a finished check found. A job keeps its full outcome; a job list shows
 * its status and blockers, and the latest check's sources are in its read
 * model, so a version's history stays small.
 */
export interface JobOutcome {
  status: SourceCheckStatus | "initialized" | "generated" | "evaluated";
  blockers: string[];
  stateHash?: string;
  scaffoldHash?: string;
  reportId?: string;
}

export interface WorkflowJob {
  id: string;
  kind: "source-check" | "init" | "generate" | "evaluate";
  workflowVersionId: string;
  requesterId: string;
  status: JobStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
  workerId: string | null;
  pinsHash: string;
  planVersionHash: string | null;
  proposalHash: string | null;
  proposalConfirmationId: string | null;
  replaceStateHash: string | null;
  requestId: string | null;
  generationConfirmationId: string | null;
  creatorStateHash: string | null;
  evaluationPackageId: string | null;
  evaluationPackageHash: string | null;
  progress: { phase: string } | null;
  outcome: JobOutcome | null;
  error: string | null;
  revision: number;
}

type SourceDeclaration = {
  name: string;
  location: string;
  scripts?: Record<string, SkillScriptSideEffect | SkillScriptSideEffect[]>;
};

interface PinRow {
  workflow_version_id: string;
  skill_id: string;
  skill_name: string;
  skill_version_hash: string;
  purpose: SkillPinPurpose;
  revision: number;
  pinned_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  inventory?: SkillSourceFile[];
  scripts?: Array<{ path: string; sideEffects: SkillScriptSideEffects }>;
}

interface SourceCheckRow {
  id: string;
  workflow_version_id: string;
  job_id: string | null;
  pins_hash: string;
  status: SourceCheckStatus;
  sources: PublicSource[];
  blockers: string[];
  workspace_path: string | null;
  revision: number;
  requested_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

interface JobRow {
  id: string;
  kind: WorkflowJob["kind"];
  workflow_version_id: string;
  requester_id: string;
  status: JobStatus;
  requested_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  lease_until: Date | string | null;
  worker_id: string | null;
  pins_hash: string;
  plan_version_hash: string | null;
  proposal_hash: string | null;
  proposal_confirmation_id: string | null;
  replace_state_hash: string | null;
  request_id: string | null;
  generation_confirmation_id: string | null;
  creator_state_hash: string | null;
  evaluation_package_id: string | null;
  evaluation_package_hash: string | null;
  progress: { phase: string } | null;
  outcome: JobOutcome | null;
  error: string | null;
  revision: number;
}

const PIN_COLUMNS = `p.workflow_version_id, p.skill_id, s.name as skill_name,
  p.skill_version_hash, p.purpose, p.revision, p.pinned_by,
  p.created_at, p.updated_at`;
const JOB_COLUMNS = `id, kind, workflow_version_id, requester_id, status,
  requested_at, started_at, finished_at, lease_until, worker_id, pins_hash,
  outcome - 'sources' as outcome, error, revision, plan_version_hash,
  proposal_hash, proposal_confirmation_id, replace_state_hash, request_id, generation_confirmation_id, creator_state_hash, evaluation_package_id, evaluation_package_hash, progress`;
const JOB_CLAIM_COLUMNS = `j.id, j.kind, j.workflow_version_id, j.requester_id,
  j.status, j.requested_at, j.started_at, j.finished_at, j.lease_until,
  j.worker_id, j.pins_hash, j.outcome - 'sources' as outcome, j.error,
  j.revision, j.plan_version_hash, j.proposal_hash, j.proposal_confirmation_id,
  j.replace_state_hash, j.request_id, j.generation_confirmation_id, j.creator_state_hash, j.evaluation_package_id, j.evaluation_package_hash, j.progress`;

function toPin(row: PinRow): WorkflowSkillPin {
  return {
    workflowVersionId: row.workflow_version_id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    hash: row.skill_version_hash,
    purpose: row.purpose,
    revision: row.revision,
    pinnedBy: row.pinned_by,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function toCheck(row: SourceCheckRow): SourceCheck {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    jobId: row.job_id,
    pinsHash: row.pins_hash,
    status: row.status,
    sources: row.sources,
    blockers: row.blockers,
    workspacePath: row.workspace_path,
    revision: row.revision,
    requestedAt: toIsoString(row.requested_at),
    startedAt: row.started_at === null ? null : toIsoString(row.started_at),
    finishedAt: row.finished_at === null ? null : toIsoString(row.finished_at),
  };
}

function toJob(row: JobRow): WorkflowJob {
  return {
    id: row.id,
    kind: row.kind,
    workflowVersionId: row.workflow_version_id,
    requesterId: row.requester_id,
    status: row.status,
    requestedAt: toIsoString(row.requested_at),
    startedAt: row.started_at === null ? null : toIsoString(row.started_at),
    finishedAt: row.finished_at === null ? null : toIsoString(row.finished_at),
    leaseUntil: row.lease_until === null ? null : toIsoString(row.lease_until),
    workerId: row.worker_id,
    pinsHash: row.pins_hash,
    planVersionHash: row.plan_version_hash,
    proposalHash: row.proposal_hash,
    proposalConfirmationId: row.proposal_confirmation_id,
    replaceStateHash: row.replace_state_hash,
    requestId: row.request_id,
    generationConfirmationId: row.generation_confirmation_id,
    creatorStateHash: row.creator_state_hash,
    evaluationPackageId: row.evaluation_package_id,
    evaluationPackageHash: row.evaluation_package_hash,
    progress: row.progress,
    outcome: row.outcome,
    error: row.error,
    revision: row.revision,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export async function listWorkflowPins(
  database: Queryable,
  workflowVersionId: string,
): Promise<WorkflowSkillPin[]> {
  const result = await database.query<PinRow>(
    `select ${PIN_COLUMNS}
       from workflow_skill_pins p join skills s on s.id = p.skill_id
      where p.workflow_version_id = $1
      order by p.purpose, s.name, p.skill_id`,
    [workflowVersionId],
  );
  return result.rows.map(toPin);
}

export async function readSourceCheck(
  database: Queryable,
  workflowVersionId: string,
): Promise<SourceCheck | null> {
  const result = await database.query<SourceCheckRow>(
    `select id, workflow_version_id, job_id, pins_hash, status, sources,
            blockers, workspace_path, revision, requested_at, started_at,
            finished_at
       from workflow_source_checks where workflow_version_id = $1`,
    [workflowVersionId],
  );
  return result.rows[0] === undefined ? null : toCheck(result.rows[0]);
}

export async function listWorkflowJobs(
  database: Queryable,
  workflowVersionId: string,
): Promise<WorkflowJob[]> {
  const result = await database.query<JobRow>(
    `select ${JOB_COLUMNS} from workflow_jobs
      where workflow_version_id = $1 order by requested_at desc, id desc`,
    [workflowVersionId],
  );
  return result.rows.map(toJob);
}

/** The pin set's identity; rows must be ordered by purpose, then Skill. */
function pinSetHash(rows: readonly PinRow[]): string {
  return canonicalHash(
    rows.map((row) => ({
      skillId: row.skill_id,
      hash: row.skill_version_hash,
      purpose: row.purpose,
    })),
  );
}

async function pinsForHash(
  database: Queryable,
  workflowVersionId: string,
): Promise<string> {
  const result = await database.query<PinRow>(
    `select ${PIN_COLUMNS}
       from workflow_skill_pins p join skills s on s.id = p.skill_id
      where p.workflow_version_id = $1
      order by p.purpose, p.skill_id`,
    [workflowVersionId],
  );
  return pinSetHash(result.rows);
}

async function versionGroup(
  database: Queryable,
  workflowVersionId: string,
  lock = false,
): Promise<{ workflowId: string; groupId: string; intent: string } | null> {
  const result = await database.query<{
    workflow_id: string;
    group_id: string;
    intent: string;
  }>(
    `select v.workflow_id, w.group_id, v.intent
       from workflow_versions v join workflows w on w.id = v.workflow_id
      where v.id = $1${lock ? " for no key update of v" : ""}`,
    [workflowVersionId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        workflowId: row.workflow_id,
        groupId: row.group_id,
        intent: row.intent,
      };
}

export function workspaceLocation(
  config: ServiceConfig,
  versionId: string,
): { root: string; relative: string } {
  const relative = path.posix.join("workflow-versions", versionId);
  return {
    relative,
    root: path.join(config.storage.workspaceDirectory, ...relative.split("/")),
  };
}

/**
 * A pin change reopens Sources. A later stage that had progressed is
 * invalidated; one that never started stays to do.
 */
async function invalidateSourcesStage(
  database: Queryable,
  workflowVersionId: string,
  now: Date,
): Promise<void> {
  const current = await database.query<{
    stages: Record<string, StageState>;
  }>("select stages from workflow_versions where id = $1", [workflowVersionId]);
  const stages = Object.fromEntries(
    Object.entries(current.rows[0]?.stages ?? {}).map(([id, state]) => [
      id,
      id === "sources" ? "active" : state === "todo" ? "todo" : "invalidated",
    ]),
  );
  await database.query(
    `update workflow_versions
        set revision = revision + 1, stages = $2::jsonb, updated_at = $3
      where id = $1`,
    [workflowVersionId, JSON.stringify(stages), now],
  );
}

export async function enqueueSourceCheck(
  database: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  workflowVersionId: string,
  pinsHash?: string,
): Promise<WorkflowJob> {
  pinsHash ??= await pinsForHash(database, workflowVersionId);
  const now = dependencies.clock.now();
  // A queued check of the previous pin set could only be discarded; the new
  // job replaces it. A running one finishes, and its result is not shown.
  // Initialization is withdrawn by proposal invalidation, or by the worker's
  // recheck of its pins, and each records its outcome.
  await database.query(
    `update workflow_jobs
        set status = 'cancelled', finished_at = $2, error = $3,
            revision = revision + 1
      where workflow_version_id = $1 and kind = 'source-check' and status = 'queued'`,
    [workflowVersionId, now, SUPERSEDED],
  );
  const job = await database.query<JobRow>(
    `insert into workflow_jobs
       (id, kind, workflow_version_id, requester_id, status, requested_at,
        pins_hash, revision)
     values ($1, 'source-check', $2, $3, 'queued', $4, $5, 1)
     returning ${JOB_COLUMNS}`,
    [
      dependencies.ids.next(),
      workflowVersionId,
      context.personId,
      now,
      pinsHash,
    ],
  );
  const row = job.rows[0]!;
  await database.query(
    `insert into workflow_source_checks
       (id, workflow_version_id, job_id, pins_hash, status, sources, blockers,
        revision, requested_at)
     values ($1, $2, $3, $4, 'queued', '[]'::jsonb, '[]'::jsonb, 1, $5)
     on conflict (workflow_version_id) do update set
       job_id = excluded.job_id,
       pins_hash = excluded.pins_hash,
       status = 'queued',
       sources = '[]'::jsonb,
       blockers = '[]'::jsonb,
       workspace_path = null,
       revision = workflow_source_checks.revision + 1,
       requested_at = excluded.requested_at,
       started_at = null,
       finished_at = null`,
    [dependencies.ids.next(), workflowVersionId, row.id, pinsHash, now],
  );
  return toJob(row);
}

export interface PinInput {
  skillId: string;
  hash: string;
  purpose: SkillPinPurpose;
  /** The revision of the pin being replaced; omitted for a new pin. */
  revision?: number;
}

export type PinResult =
  | {
      kind: "created" | "updated";
      pin: WorkflowSkillPin;
      job: WorkflowJob;
      pinsHash: string;
    }
  | { kind: "missing-version" }
  | { kind: "missing-skill-version" }
  | { kind: "unchanged"; pin: WorkflowSkillPin }
  | { kind: "stale"; pin: WorkflowSkillPin | null }
  | { kind: "upgrade-source-taken"; pin: WorkflowSkillPin }
  | { kind: "conflict" }
  | { kind: "invalid"; message: string };

export async function pinSkillVersion(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  value: PinInput,
): Promise<PinResult> {
  return database
    .transaction<PinResult>(async (tx) => {
      const version = await versionGroup(tx, versionId, true);
      if (version === null) return { kind: "missing-version" };
      if (
        value.purpose === "upgrade-source" &&
        version.intent !== "upgrade-existing"
      ) {
        return {
          kind: "invalid",
          message: "An upgrade source is only valid for an upgrade workflow",
        };
      }
      const skill = await tx.query<{ name: string }>(
        `select s.name from skills s join skill_versions v on v.skill_id = s.id
          where s.id = $1 and s.group_id = $2 and v.hash = $3`,
        [value.skillId, version.groupId, value.hash],
      );
      const skillName = skill.rows[0]?.name;
      if (skillName === undefined) return { kind: "missing-skill-version" };
      const existing = await tx.query<PinRow>(
        `select ${PIN_COLUMNS} from workflow_skill_pins p join skills s on s.id = p.skill_id
          where p.workflow_version_id = $1 and p.skill_id = $2 for update of p`,
        [versionId, value.skillId],
      );
      const previous =
        existing.rows[0] === undefined ? null : toPin(existing.rows[0]);
      // Replacing a pin quotes the revision that was read, like every other
      // write; a new pin quotes none.
      if (
        previous === null
          ? value.revision !== undefined
          : value.revision !== previous.revision
      )
        return { kind: "stale", pin: previous };
      if (previous?.hash === value.hash && previous.purpose === value.purpose)
        return { kind: "unchanged", pin: previous };
      if (value.purpose === "upgrade-source") {
        const upgrade = await tx.query<PinRow>(
          `select ${PIN_COLUMNS} from workflow_skill_pins p join skills s on s.id = p.skill_id
            where p.workflow_version_id = $1 and p.purpose = 'upgrade-source'
              and p.skill_id <> $2`,
          [versionId, value.skillId],
        );
        if (upgrade.rows[0] !== undefined)
          return { kind: "upgrade-source-taken", pin: toPin(upgrade.rows[0]) };
      }
      const now = dependencies.clock.now();
      if (previous === null)
        await tx.query(
          `insert into workflow_skill_pins
             (workflow_version_id, skill_id, skill_version_hash, purpose,
              revision, pinned_by, created_at, updated_at)
           values ($1, $2, $3, $4, 1, $5, $6, $6)`,
          [
            versionId,
            value.skillId,
            value.hash,
            value.purpose,
            context.personId,
            now,
          ],
        );
      else
        await tx.query(
          `update workflow_skill_pins
              set skill_version_hash = $3, purpose = $4, revision = revision + 1,
                  pinned_by = $5, updated_at = $6
            where workflow_version_id = $1 and skill_id = $2`,
          [
            versionId,
            value.skillId,
            value.hash,
            value.purpose,
            context.personId,
            now,
          ],
        );
      const pinRow = await tx.query<PinRow>(
        `select ${PIN_COLUMNS} from workflow_skill_pins p join skills s on s.id = p.skill_id
          where p.workflow_version_id = $1 and p.skill_id = $2`,
        [versionId, value.skillId],
      );
      const pin = toPin(pinRow.rows[0]!);
      await invalidateSkillFactEvidence(
        tx,
        dependencies,
        context,
        versionId,
        value.skillId,
      );
      await invalidateSourcesStage(tx, versionId, now);
      await invalidateStudyGates(
        tx,
        dependencies,
        context,
        versionId,
        "The Skill pins changed",
      );
      await invalidateGate(
        tx,
        dependencies,
        context,
        versionId,
        "sources",
        "The Skill pins changed",
        ["Engineer", "Workflow owner"],
      );
      await reconcileDossier(tx, dependencies, context, versionId);
      const pinsHash = await pinsForHash(tx, versionId);
      const job = await enqueueSourceCheck(
        tx,
        dependencies,
        context,
        versionId,
        pinsHash,
      );
      await recordAudit(tx, dependencies, {
        actor: { personId: context.personId, credential: context.credential },
        channel: context.channel,
        action:
          previous === null
            ? "workflow_skill_pin.created"
            : "workflow_skill_pin.updated",
        target: {
          type: "workflow_skill_pin",
          id: `${versionId}:${value.skillId}`,
          label: `${skillName} · ${value.hash}`,
        },
        before:
          previous === null
            ? null
            : { revision: previous.revision, hash: previous.hash },
        after: { revision: pin.revision, hash: pin.hash },
        reason:
          previous === null
            ? "Skill version pinned; source check queued"
            : "Skill version pin changed; source check queued",
        requestId: context.requestId,
      });
      return {
        kind: previous === null ? "created" : "updated",
        pin,
        job,
        pinsHash,
      };
    })
    .catch((error: unknown): PinResult => {
      // Two people pinned the same Skill, or two upgrade sources, at once.
      if (isUniqueViolation(error)) return { kind: "conflict" };
      throw error;
    });
}

export type UnpinResult =
  | { kind: "removed"; job: WorkflowJob; pinsHash: string }
  | { kind: "missing-version" | "missing-pin" }
  | { kind: "stale"; pin: WorkflowSkillPin };

export async function unpinSkillVersion(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  skillId: string,
  revision: number,
): Promise<UnpinResult> {
  return database.transaction(async (tx) => {
    if ((await versionGroup(tx, versionId, true)) === null)
      return { kind: "missing-version" };
    const current = await tx.query<PinRow>(
      `select ${PIN_COLUMNS} from workflow_skill_pins p join skills s on s.id = p.skill_id
       where p.workflow_version_id = $1 and p.skill_id = $2 for update of p`,
      [versionId, skillId],
    );
    if (current.rows[0] === undefined) return { kind: "missing-pin" };
    const pin = toPin(current.rows[0]);
    if (pin.revision !== revision) return { kind: "stale", pin };
    await tx.query(
      `delete from workflow_skill_pins where workflow_version_id = $1 and skill_id = $2`,
      [versionId, skillId],
    );
    await invalidateSkillFactEvidence(
      tx,
      dependencies,
      context,
      versionId,
      skillId,
    );
    await invalidateSourcesStage(tx, versionId, dependencies.clock.now());
    await invalidateStudyGates(
      tx,
      dependencies,
      context,
      versionId,
      "A Skill pin was removed",
    );
    await invalidateGate(
      tx,
      dependencies,
      context,
      versionId,
      "sources",
      "A Skill pin was removed",
      ["Engineer", "Workflow owner"],
    );
    await reconcileDossier(tx, dependencies, context, versionId);
    const pinsHash = await pinsForHash(tx, versionId);
    const job = await enqueueSourceCheck(
      tx,
      dependencies,
      context,
      versionId,
      pinsHash,
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "workflow_skill_pin.removed",
      target: {
        type: "workflow_skill_pin",
        id: `${versionId}:${skillId}`,
        label: `${pin.skillName} · ${pin.hash}`,
      },
      before: { revision: pin.revision, hash: pin.hash },
      after: null,
      reason: "Skill version unpinned; source check queued",
      requestId: context.requestId,
    });
    return { kind: "removed", job, pinsHash };
  });
}

function publicSource(
  candidate: Awaited<ReturnType<typeof checkSkillSources>>[number],
  purpose: SkillPinPurpose,
): PublicSource {
  const source = candidate.sources[0];
  return {
    name: candidate.name,
    purpose,
    status: candidate.status,
    hash: source?.hash ?? null,
    inventory: source?.inventory ?? [],
    scripts: source?.scripts ?? [],
    ignored: source?.ignored ?? [],
    blockers: [...(candidate.blockers ?? [])],
  };
}

async function materializeWorkspace(
  config: ServiceConfig,
  blobs: BlobStore,
  versionId: string,
  pins: readonly PinRow[],
): Promise<{
  root: string;
  relative: string;
  declarations: SourceDeclaration[];
}> {
  const { root, relative } = workspaceLocation(config, versionId);
  await fs.rm(path.join(root, "skills"), { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const declarations: SourceDeclaration[] = [];
  let upgradeSource: string | undefined;
  for (const pin of pins) {
    const location = path.posix.join("skills", pin.skill_name);
    const destination = path.join(root, ...location.split("/"));
    await fs.mkdir(destination, { recursive: true });
    for (const file of pin.inventory ?? []) {
      const target = path.join(destination, ...file.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await blobs.get(file.hash), { flag: "wx" });
    }
    const scripts = Object.fromEntries(
      (pin.scripts ?? [])
        .filter((script) => script.sideEffects !== "undeclared")
        .map((script) => [script.path, script.sideEffects]),
    );
    declarations.push({
      name: pin.skill_name,
      location,
      ...(Object.keys(scripts).length > 0
        ? {
            scripts: scripts as Record<
              string,
              SkillScriptSideEffect | SkillScriptSideEffect[]
            >,
          }
        : {}),
    });
    if (pin.purpose === "upgrade-source") upgradeSource = location;
  }
  // The kernel needs the upgrade source declared like any other source; the
  // manifest also names it, for the plan's source root.
  await fs.writeFile(
    path.join(root, "source-manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        sources: declarations,
        ...(upgradeSource === undefined ? {} : { upgradeSource }),
      },
      null,
      2,
    ) + "\n",
  );
  return { root, relative, declarations };
}

export interface SourceCheckWorkerOptions {
  database: Database;
  dependencies: ServiceDependencies;
  config: ServiceConfig;
  blobs: BlobStore;
  workerId: string;
  /** How long a claim lasts unless renewed; another worker may then take it. */
  leaseMilliseconds?: number;
  /** The longest wait between two looks at the queue. */
  pollMilliseconds?: number;
}

type FinalStatus = Exclude<JobStatus, "queued" | "running">;
type FullOutcome = {
  status: SourceCheckStatus;
  blockers: string[];
  sources: PublicSource[];
};

export class SourceCheckWorker {
  private readonly options: Required<SourceCheckWorkerOptions>;

  constructor(options: SourceCheckWorkerOptions) {
    this.options = {
      ...options,
      leaseMilliseconds: options.leaseMilliseconds ?? 60_000,
      // A notification wakes a listening worker at once. The poll also
      // reclaims an abandoned lease and covers a notification sent while the
      // worker was busy, so it runs even with LISTEN.
      pollMilliseconds:
        options.pollMilliseconds ??
        (options.database.waitForNotification === undefined ? 1_000 : 15_000),
    };
  }

  /** Claims the next runnable job and runs it; null when none can start. */
  async runOnce(): Promise<WorkflowJob | null> {
    await expireAnswerAttachments(this.options);
    const job = await this.claim();
    return job === null ? null : this.process(job);
  }

  /**
   * Claims the oldest queued job, or one whose lease lapsed, unless its
   * workflow version already has a running job: one version's kernel
   * transitions run one at a time.
   */
  async claim(): Promise<WorkflowJob | null> {
    const { database, dependencies, workerId, leaseMilliseconds } =
      this.options;
    try {
      const claimed = await database.transaction(async (tx) => {
        const now = dependencies.clock.now();
        const lease = new Date(now.getTime() + leaseMilliseconds);
        const result = await tx.query<JobRow>(
          `with candidate as (
             select j.id from workflow_jobs j
              where (j.status = 'queued' or (j.status = 'running' and j.lease_until <= $1))
                and not exists (
                  select 1 from workflow_jobs active
                   where active.workflow_version_id = j.workflow_version_id
                     and active.status = 'running' and active.id <> j.id
                )
              order by j.requested_at, j.id
              for update skip locked limit 1
           )
           update workflow_jobs j
              set status = 'running', started_at = coalesce(j.started_at, $1),
                  lease_until = $2, worker_id = $3, revision = j.revision + 1
             from candidate where j.id = candidate.id
           returning ${JOB_CLAIM_COLUMNS}`,
          [now, lease, workerId],
        );
        const row = result.rows[0];
        if (row === undefined) return null;
        await tx.query(
          `update workflow_source_checks set status = 'running', started_at = $2,
              revision = revision + 1 where job_id = $1`,
          [row.id, now],
        );
        return row;
      });
      return claimed === null ? null : toJob(claimed);
    } catch (error) {
      // Another worker started a job of the same version in the meantime; the
      // running-job index refused this claim.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** Runs a claimed job, renewing its lease while it works. */
  async process(job: WorkflowJob): Promise<WorkflowJob> {
    const heartbeat = setInterval(
      () => void this.renew(job).catch(() => undefined),
      Math.max(1_000, Math.floor(this.options.leaseMilliseconds / 3)),
    );
    heartbeat.unref();
    try {
      if (job.kind === "init")
        return await runInitialization(this.options, job);
      if (job.kind === "evaluate")
        return await runEvaluation(this.options, job);
      if (job.kind === "generate")
        return await runGeneration(this.options, job);
      return await this.check(job);
    } catch (error) {
      if (job.kind !== "source-check") throw error;
      return await this.finish(
        job,
        "failed",
        { status: "failed", sources: [], blockers: [] },
        this.publicError(error),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Waits for a new job's notification, or one poll interval at most. */
  async waitForWork(signal?: AbortSignal): Promise<void> {
    const { database, pollMilliseconds } = this.options;
    const wait = new AbortController();
    const timer = setTimeout(() => wait.abort(), pollMilliseconds);
    const stop = () => wait.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
      if (database.waitForNotification !== undefined) {
        try {
          // Ends on a notification, a dropped listener, or the interval.
          await database.waitForNotification(WORKFLOW_JOB_CHANNEL, wait.signal);
          return;
        } catch {
          // No listener could be opened; the interval still bounds the wait.
        }
      }
      await new Promise<void>((resolve) => {
        if (wait.signal.aborted) resolve();
        else
          wait.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  }

  private async check(job: WorkflowJob): Promise<WorkflowJob> {
    const { database, config, blobs } = this.options;
    const version = await versionGroup(database, job.workflowVersionId);
    if (version === null) throw new Error("The workflow version is missing");
    const pins = await database.query<PinRow>(
      `select ${PIN_COLUMNS}, sv.inventory, sv.scripts
         from workflow_skill_pins p join skills s on s.id = p.skill_id
         join skill_versions sv on sv.skill_id = p.skill_id and sv.hash = p.skill_version_hash
        where p.workflow_version_id = $1 order by p.purpose, p.skill_id`,
      [job.workflowVersionId],
    );
    if (pinSetHash(pins.rows) !== job.pinsHash)
      return this.finish(job, "cancelled", null, SUPERSEDED);
    if (pins.rows.length === 0) {
      await fs.rm(
        path.join(
          workspaceLocation(config, job.workflowVersionId).root,
          "skills",
        ),
        {
          recursive: true,
          force: true,
        },
      );
      return this.finish(job, "succeeded", {
        status: "blocked",
        sources: [],
        blockers: ["Pin at least one Skill version before continuing"],
      });
    }
    const materialized = await materializeWorkspace(
      config,
      blobs,
      job.workflowVersionId,
      pins.rows,
    );
    const candidates = await checkSkillSources({
      projectRoot: materialized.root,
      sources: materialized.declarations,
    });
    const pinned = new Map(pins.rows.map((row) => [row.skill_name, row]));
    const sources = candidates.map((candidate) => {
      const pin = pinned.get(candidate.name);
      const source = publicSource(candidate, pin?.purpose ?? "source");
      // The check hashes the files it was given. Any hash but the pinned one
      // means the stored files are not the pinned version's.
      if (source.hash !== null && source.hash !== pin?.skill_version_hash)
        source.blockers.push(
          `The files checked for ${candidate.name} differ from its pinned version`,
        );
      return source;
    });
    const blockers = sources.flatMap((source) => source.blockers);
    if (
      version.intent === "upgrade-existing" &&
      !pins.rows.some((row) => row.purpose === "upgrade-source")
    )
      blockers.push("Pin the upgrade source before continuing");
    const status: SourceCheckStatus =
      blockers.length === 0 &&
      sources.every((source) => source.status === "available")
        ? "passed"
        : "blocked";
    return this.finish(
      job,
      "succeeded",
      { status, sources, blockers },
      undefined,
      materialized.relative,
    );
  }

  private async renew(job: WorkflowJob): Promise<void> {
    const { database, dependencies, workerId, leaseMilliseconds } =
      this.options;
    await database.query(
      `update workflow_jobs set lease_until = $4
        where id = $1 and worker_id = $2 and revision = $3
          and status = 'running'`,
      [
        job.id,
        workerId,
        job.revision,
        new Date(dependencies.clock.now().getTime() + leaseMilliseconds),
      ],
    );
  }

  private async finish(
    job: WorkflowJob,
    status: FinalStatus,
    outcome: FullOutcome | null,
    error?: string,
    workspacePath?: string,
  ): Promise<WorkflowJob> {
    const { database, dependencies, workerId } = this.options;
    const now = dependencies.clock.now();
    return database.transaction(async (tx) => {
      const current = await tx.query<JobRow>(
        `select ${JOB_COLUMNS} from workflow_jobs where id = $1 for update`,
        [job.id],
      );
      const row = current.rows[0];
      if (row === undefined) return job;
      // A worker whose lease lapsed must not overwrite the result of the
      // worker that took its job over.
      if (
        row.status !== "running" ||
        row.worker_id !== workerId ||
        row.revision !== job.revision
      )
        return toJob(row);
      // Pin changes lock the version first. Locking it here too keeps the pin
      // set read below from changing before the stage is written.
      await tx.query(
        "select id from workflow_versions where id = $1 for no key update",
        [job.workflowVersionId],
      );
      // The pin content can change away and back while this job runs. Its
      // hash alone cannot make a superseded check current again.
      const latestCheck = await readSourceCheck(tx, job.workflowVersionId);
      if (latestCheck?.jobId !== job.id) {
        status = "cancelled";
        outcome = null;
        error = SUPERSEDED;
      }
      const updated = await tx.query<JobRow>(
        `update workflow_jobs set status = $2, finished_at = $3, lease_until = null,
            outcome = $4::jsonb, error = $5, revision = revision + 1
          where id = $1 returning ${JOB_COLUMNS}`,
        [
          job.id,
          status,
          now,
          outcome === null ? null : JSON.stringify(outcome),
          error ?? null,
        ],
      );
      if (
        outcome !== null &&
        (await pinsForHash(tx, job.workflowVersionId)) === job.pinsHash
      ) {
        await tx.query(
          `update workflow_source_checks set status = $2, sources = $3::jsonb,
              blockers = $4::jsonb, workspace_path = $5, finished_at = $6,
              revision = revision + 1
            where job_id = $1 and pins_hash = $7`,
          [
            job.id,
            outcome.status,
            JSON.stringify(outcome.sources),
            JSON.stringify(outcome.blockers),
            workspacePath ?? null,
            now,
            job.pinsHash,
          ],
        );
        // Blockers block Sources. A passed check leaves it active: the
        // Engineer still confirms the source set at the Sources gate (#44).
        // A failed check decided nothing and leaves it active too.
        if (status === "succeeded")
          await tx.query(
            `update workflow_versions set revision = revision + 1,
                stages = jsonb_set(stages, '{sources}', to_jsonb($2::text)),
                updated_at = $3
              where id = $1`,
            [
              job.workflowVersionId,
              outcome.status === "passed" ? "active" : "blocked",
              now,
            ],
          );
        await recordAudit(tx, dependencies, {
          actor: {
            personId: null,
            credential: { kind: "worker", id: workerId },
          },
          channel: "worker",
          action: "workflow_source_check.completed",
          target: {
            type: "workflow_source_check",
            id: job.workflowVersionId,
            label: outcome.status,
          },
          before: null,
          after: { revision: null, hash: job.pinsHash },
          reason: error ?? "Source check completed",
          requestId: job.id,
        });
        if (outcome.status === "passed")
          await notifyWorkflowRoles(
            tx,
            dependencies,
            job.workflowVersionId,
            "sources",
            "gate-ready",
            job.id,
            ["Engineer"],
          );
      }
      return toJob(updated.rows[0]!);
    });
  }

  /** An error as workflow readers see it: storage paths are named, not shown. */
  private publicError(error: unknown): string {
    const { storage } = this.options.config;
    let message = error instanceof Error ? error.message : String(error);
    for (const [directory, name] of [
      [storage.workspaceDirectory, "<workspaces>"],
      [storage.blobDirectory, "<blobs>"],
      [storage.root, "<storage>"],
    ] as const) {
      message = message
        .replaceAll(path.resolve(directory), name)
        .replaceAll(directory, name);
    }
    return message;
  }
}

export function parsePinInput(
  value: unknown,
): { ok: true; value: PinInput } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, message: "The request body must be a JSON object" };
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(
    (key) => !["skillId", "hash", "purpose", "revision"].includes(key),
  );
  if (unknown !== undefined)
    return { ok: false, message: `Unknown field ${unknown}` };
  if (typeof input.skillId !== "string" || input.skillId.trim() === "")
    return { ok: false, message: "skillId must name a Skill" };
  if (typeof input.hash !== "string" || !/^[a-f0-9]{64}$/u.test(input.hash))
    return {
      ok: false,
      message: "hash must be a 64-character lowercase SHA-256",
    };
  const purpose = input.purpose ?? "source";
  if (purpose !== "source" && purpose !== "upgrade-source")
    return { ok: false, message: "purpose must be source or upgrade-source" };
  const revision = input.revision;
  if (
    revision !== undefined &&
    (!Number.isInteger(revision) || (revision as number) < 1)
  )
    return { ok: false, message: "revision must be a whole number from 1" };
  return {
    ok: true,
    value: {
      skillId: input.skillId,
      hash: input.hash,
      purpose,
      ...(revision === undefined ? {} : { revision: revision as number }),
    },
  };
}

export function parseUnpinInput(
  value: unknown,
): { ok: true; revision: number } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, message: "The request body must be a JSON object" };
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "revision"))
    return { ok: false, message: "Unknown field in request body" };
  if (!Number.isInteger(input.revision) || (input.revision as number) < 1)
    return { ok: false, message: "revision must be a whole number from 1" };
  return { ok: true, revision: input.revision as number };
}
