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
import type { ServiceConfig } from "./config.js";
import type { BlobStore } from "./skills/blobs.js";
import { toIsoString } from "./util.js";

export type SkillPinPurpose = "source" | "upgrade-source";
export type SourceCheckStatus =
  "queued" | "running" | "passed" | "blocked" | "failed";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

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

export interface WorkflowJob {
  id: string;
  kind: "source-check";
  workflowVersionId: string;
  requesterId: string;
  status: JobStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseUntil: string | null;
  workerId: string | null;
  pinsHash: string;
  outcome: {
    status: SourceCheckStatus;
    sources: PublicSource[];
    blockers: string[];
  } | null;
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
  kind: "source-check";
  workflow_version_id: string;
  requester_id: string;
  status: JobStatus;
  requested_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  lease_until: Date | string | null;
  worker_id: string | null;
  pins_hash: string;
  outcome: WorkflowJob["outcome"];
  error: string | null;
  revision: number;
}

const PIN_COLUMNS = `p.workflow_version_id, p.skill_id, s.name as skill_name,
  p.skill_version_hash, p.purpose, p.revision, p.pinned_by,
  p.created_at, p.updated_at`;
const JOB_COLUMNS = `id, kind, workflow_version_id, requester_id, status,
  requested_at, started_at, finished_at, lease_until, worker_id, pins_hash,
  outcome, error, revision`;
const JOB_CLAIM_COLUMNS = `j.id, j.kind, j.workflow_version_id, j.requester_id,
  j.status, j.requested_at, j.started_at, j.finished_at, j.lease_until,
  j.worker_id, j.pins_hash, j.outcome, j.error, j.revision`;

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
    outcome: row.outcome,
    error: row.error,
    revision: row.revision,
  };
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

async function pinsForHash(
  database: Queryable,
  workflowVersionId: string,
): Promise<{ rows: PinRow[]; hash: string }> {
  const result = await database.query<PinRow>(
    `select ${PIN_COLUMNS}
       from workflow_skill_pins p join skills s on s.id = p.skill_id
      where p.workflow_version_id = $1
      order by p.purpose, p.skill_id`,
    [workflowVersionId],
  );
  const pins = result.rows.map((row) => ({
    skillId: row.skill_id,
    hash: row.skill_version_hash,
    purpose: row.purpose,
  }));
  return { rows: result.rows, hash: canonicalHash(pins) };
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
      where v.id = $1${lock ? " for update of v" : ""}`,
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

async function invalidateSourcesStage(
  database: Queryable,
  workflowVersionId: string,
  now: Date,
): Promise<void> {
  const current = await database.query<{
    stages: Record<string, string>;
  }>("select stages from workflow_versions where id = $1", [workflowVersionId]);
  const hasProgress = Object.entries(current.rows[0]?.stages ?? {}).some(
    ([id, state]) => id !== "sources" && state !== "todo",
  );
  const downstream = hasProgress ? "invalidated" : "todo";
  await database.query(
    `update workflow_versions
        set revision = revision + 1,
            stages = jsonb_build_object(
              'sources', 'active',
              'source-study', $3::text,
              'questionnaire', $3::text,
              'dossier', $3::text,
              'plan-proposal', $3::text,
              'package', $3::text,
              'evaluation', $3::text,
              'review-publication', $3::text
            ),
            updated_at = $2
      where id = $1`,
    [workflowVersionId, now, downstream],
  );
}

async function enqueueSourceCheck(
  database: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  workflowVersionId: string,
  pinsHash: string,
): Promise<WorkflowJob> {
  const now = dependencies.clock.now();
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

export type PinResult =
  | {
      kind: "created";
      pin: WorkflowSkillPin;
      job: WorkflowJob;
      pinsHash: string;
    }
  | {
      kind: "updated";
      pin: WorkflowSkillPin;
      job: WorkflowJob;
      pinsHash: string;
    }
  | { kind: "missing-version" }
  | { kind: "missing-skill-version" }
  | { kind: "conflict" }
  | { kind: "invalid"; message: string };

export async function pinSkillVersion(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  versionId: string,
  value: { skillId: string; hash: string; purpose: SkillPinPurpose },
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
      const skill = await tx.query<{ id: string }>(
        `select s.id from skills s join skill_versions v on v.skill_id = s.id
        where s.id = $1 and s.group_id = $2 and v.hash = $3`,
        [value.skillId, version.groupId, value.hash],
      );
      if (skill.rows[0] === undefined) return { kind: "missing-skill-version" };
      const existing = await tx.query<PinRow>(
        `select ${PIN_COLUMNS} from workflow_skill_pins p join skills s on s.id = p.skill_id
       where p.workflow_version_id = $1 and p.skill_id = $2 for update`,
        [versionId, value.skillId],
      );
      const previous =
        existing.rows[0] === undefined ? null : toPin(existing.rows[0]);
      if (previous?.hash === value.hash && previous.purpose === value.purpose)
        return { kind: "conflict" };
      const now = dependencies.clock.now();
      const inserted =
        previous === null
          ? await tx.query<PinRow>(
              `insert into workflow_skill_pins
        (workflow_version_id, skill_id, skill_version_hash, purpose,
         revision, pinned_by, created_at, updated_at)
       values ($1, $2, $3, $4, 1, $5, $6, $6)
       returning workflow_version_id, skill_id, skill_version_hash, purpose,
                 revision, pinned_by, created_at, updated_at`,
              [
                versionId,
                value.skillId,
                value.hash,
                value.purpose,
                context.personId,
                now,
              ],
            )
          : await tx.query<PinRow>(
              `update workflow_skill_pins
              set skill_version_hash = $3, purpose = $4, revision = revision + 1,
                  pinned_by = $5, updated_at = $6
            where workflow_version_id = $1 and skill_id = $2
            returning workflow_version_id, skill_id, skill_version_hash, purpose,
                      revision, pinned_by, created_at, updated_at`,
              [
                versionId,
                value.skillId,
                value.hash,
                value.purpose,
                context.personId,
                now,
              ],
            );
      if (inserted.rows[0] === undefined) return { kind: "conflict" };
      const pinRow = await tx.query<PinRow>(
        `select ${PIN_COLUMNS} from workflow_skill_pins p join skills s on s.id = p.skill_id
       where p.workflow_version_id = $1 and p.skill_id = $2`,
        [versionId, value.skillId],
      );
      await invalidateSourcesStage(tx, versionId, now);
      const current = await pinsForHash(tx, versionId);
      const job = await enqueueSourceCheck(
        tx,
        dependencies,
        context,
        versionId,
        current.hash,
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
          label: `${value.skillId}:${value.hash}`,
        },
        before:
          previous === null
            ? null
            : { revision: previous.revision, hash: previous.hash },
        after: { revision: toPin(pinRow.rows[0]!).revision, hash: value.hash },
        reason:
          previous === null
            ? "Skill version pinned; source check queued"
            : "Skill version pin changed; source check queued",
        requestId: context.requestId,
      });
      return {
        kind: previous === null ? "created" : "updated",
        pin: toPin(pinRow.rows[0]!),
        job,
        pinsHash: current.hash,
      };
    })
    .catch((error: unknown): PinResult => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        return { kind: "conflict" as const };
      }
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
       where p.workflow_version_id = $1 and p.skill_id = $2 for update`,
      [versionId, skillId],
    );
    if (current.rows[0] === undefined) return { kind: "missing-pin" };
    const pin = toPin(current.rows[0]);
    if (pin.revision !== revision) return { kind: "stale", pin };
    await tx.query(
      `delete from workflow_skill_pins where workflow_version_id = $1 and skill_id = $2`,
      [versionId, skillId],
    );
    await invalidateSourcesStage(tx, versionId, dependencies.clock.now());
    const pins = await pinsForHash(tx, versionId);
    const job = await enqueueSourceCheck(
      tx,
      dependencies,
      context,
      versionId,
      pins.hash,
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "workflow_skill_pin.removed",
      target: {
        type: "workflow_skill_pin",
        id: `${versionId}:${skillId}`,
        label: `${pin.skillName}:${pin.hash}`,
      },
      before: { revision: pin.revision, hash: pin.hash },
      after: null,
      reason: "Skill version unpinned; source check queued",
      requestId: context.requestId,
    });
    return { kind: "removed", job, pinsHash: pins.hash };
  });
}

function publicSource(
  candidate: Awaited<ReturnType<typeof checkSkillSources>>[number],
): PublicSource {
  const source = candidate.sources[0];
  return {
    name: candidate.name,
    status: candidate.status,
    hash: source?.hash ?? null,
    inventory: source?.inventory ?? [],
    scripts: source?.scripts ?? [],
    ignored: source?.ignored ?? [],
    blockers: candidate.blockers ?? [],
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
  const relative = path.posix.join("workflow-versions", versionId);
  const root = path.join(
    config.storage.workspaceDirectory,
    ...relative.split("/"),
  );
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const declarations: SourceDeclaration[] = [];
  for (const pin of pins) {
    const location = path.posix.join("skills", pin.skill_name);
    const destination = path.join(root, ...location.split("/"));
    await fs.mkdir(destination, { recursive: true });
    const rows = await blobsForPin(blobs, pin);
    for (const file of rows) {
      const target = path.join(destination, ...file.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await blobs.get(file.hash), { flag: "wx" });
    }
    const scripts = Object.fromEntries(
      rows.scripts
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
  }
  await fs.writeFile(
    path.join(root, "source-manifest.json"),
    JSON.stringify({ schemaVersion: 1, sources: declarations }, null, 2),
  );
  return { root, relative, declarations };
}

async function blobsForPin(
  blobs: BlobStore,
  pin: PinRow,
): Promise<
  SkillSourceFile[] & {
    scripts: Array<{ path: string; sideEffects: SkillScriptSideEffects }>;
  }
> {
  const files = pin.inventory ?? [];
  const result = files.map((file) => ({ ...file })) as SkillSourceFile[] & {
    scripts: Array<{ path: string; sideEffects: SkillScriptSideEffects }>;
  };
  result.scripts = pin.scripts ?? [];
  return result;
}

export interface SourceCheckWorkerOptions {
  database: Database;
  dependencies: ServiceDependencies;
  config: ServiceConfig;
  blobs: BlobStore;
  workerId: string;
  leaseMilliseconds?: number;
}

export class SourceCheckWorker {
  private readonly options: Required<SourceCheckWorkerOptions>;

  constructor(options: SourceCheckWorkerOptions) {
    this.options = { leaseMilliseconds: 60_000, ...options };
  }

  async runOnce(): Promise<WorkflowJob | null> {
    const { database, dependencies, workerId, leaseMilliseconds } =
      this.options;
    const claimed = await database.transaction(async (tx) => {
      const now = dependencies.clock.now();
      const lease = new Date(now.getTime() + leaseMilliseconds);
      const result = await tx.query<JobRow>(
        `with candidate as (
           select j.id from workflow_jobs j
            join workflow_versions v on v.id = j.workflow_version_id
            where (j.status = 'queued' or (j.status = 'running' and j.lease_until <= $1))
              and not exists (
                select 1 from workflow_jobs active
                 where active.workflow_version_id = j.workflow_version_id
                   and active.status = 'running' and active.id <> j.id
              )
            order by j.requested_at, j.id
            for update of j, v skip locked limit 1
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
    if (claimed === null) return null;
    const job = toJob(claimed);
    try {
      const pins = await database.query<PinRow>(
        `select ${PIN_COLUMNS}, sv.inventory, sv.scripts
           from workflow_skill_pins p join skills s on s.id = p.skill_id
           join skill_versions sv on sv.skill_id = p.skill_id and sv.hash = p.skill_version_hash
          where p.workflow_version_id = $1 order by p.purpose, p.skill_id`,
        [job.workflowVersionId],
      );
      const current = await pinsForHash(database, job.workflowVersionId);
      if (current.hash !== job.pinsHash)
        return this.finish(
          job,
          {
            status: "failed",
            sources: [],
            blockers: [
              "The pinned source set changed while this check was running",
            ],
          },
          "superseded",
        );
      if (pins.rows.length === 0)
        await fs.rm(
          path.join(
            this.options.config.storage.workspaceDirectory,
            "workflow-versions",
            job.workflowVersionId,
          ),
          { recursive: true, force: true },
        );
      if (pins.rows.length === 0)
        return this.finish(job, {
          status: "blocked",
          sources: [],
          blockers: ["Pin at least one Skill version before continuing"],
        });
      const materialized = await materializeWorkspace(
        this.options.config,
        this.options.blobs,
        job.workflowVersionId,
        pins.rows,
      );
      const candidates = await checkSkillSources({
        projectRoot: materialized.root,
        sources: materialized.declarations,
      });
      const sources = candidates.map(publicSource);
      const blockers = candidates.flatMap(
        (candidate) => candidate.blockers ?? [],
      );
      const status: SourceCheckStatus =
        blockers.length === 0 &&
        candidates.every((candidate) => candidate.status === "available")
          ? "passed"
          : "blocked";
      return this.finish(
        job,
        { status, sources, blockers },
        undefined,
        materialized.relative,
      );
    } catch (error) {
      return this.finish(
        job,
        { status: "failed", sources: [], blockers: [] },
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async waitForWork(signal?: AbortSignal): Promise<void> {
    if (this.options.database.waitForNotification !== undefined) {
      await this.options.database.waitForNotification(
        "badger_workflow_jobs",
        signal,
      );
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async finish(
    job: WorkflowJob,
    outcome: {
      status: SourceCheckStatus;
      sources: PublicSource[];
      blockers: string[];
    },
    error?: string,
    workspacePath?: string,
  ): Promise<WorkflowJob> {
    const { database, dependencies, workerId } = this.options;
    const now = dependencies.clock.now();
    const result = await database.transaction(async (tx) => {
      const current = await tx.query<JobRow>(
        `select ${JOB_COLUMNS} from workflow_jobs where id = $1 for update`,
        [job.id],
      );
      if (current.rows[0] === undefined) return job;
      const updated = await tx.query<JobRow>(
        `update workflow_jobs set status = $2, finished_at = $3, lease_until = null,
            worker_id = $4, outcome = $5::jsonb, error = $6, revision = revision + 1
          where id = $1 returning ${JOB_COLUMNS}`,
        [
          job.id,
          error === undefined ? "succeeded" : "failed",
          now,
          workerId,
          JSON.stringify(outcome),
          error ?? null,
        ],
      );
      const pins = await pinsForHash(tx, job.workflowVersionId);
      if (pins.hash === job.pinsHash) {
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
        await tx.query(
          `update workflow_versions set revision = revision + 1,
              stages = jsonb_set(stages, '{sources}', to_jsonb($2::text)), updated_at = $3
            where id = $1 and $4 = true`,
          [
            job.workflowVersionId,
            outcome.status === "passed"
              ? "done"
              : outcome.status === "blocked"
                ? "blocked"
                : "active",
            now,
            error === undefined,
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
      }
      return updated.rows[0] === undefined ? job : toJob(updated.rows[0]);
    });
    return result;
  }
}

export function parsePinInput(value: unknown):
  | {
      ok: true;
      value: { skillId: string; hash: string; purpose: SkillPinPurpose };
    }
  | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, message: "The request body must be a JSON object" };
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(
    (key) => !["skillId", "hash", "purpose"].includes(key),
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
  return {
    ok: true,
    value: { skillId: input.skillId, hash: input.hash, purpose },
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
