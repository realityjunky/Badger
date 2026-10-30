import { isWorkflowName, type CreatorIntent } from "@realityjunky/badger";
import { recordAudit, type WriteContext } from "./audit.js";
import { visibleGroups, type Access } from "./authorization.js";
import { recordBinding, type RoleBinding } from "./bindings.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import type { Person } from "./people.js";
import { toIsoString } from "./util.js";
import { moveOpenWork } from "./questionnaire/inheritance.js";
import {
  describeInheritance,
  inheritVersionRecords,
} from "./version-inheritance.js";
import { enqueueSourceCheck } from "./workflow-source.js";

export const WORKFLOW_STAGES = [
  "sources",
  "source-study",
  "questionnaire",
  "dossier",
  "plan-proposal",
  "package",
  "evaluation",
  "review-publication",
] as const;
export type WorkflowStageId = (typeof WORKFLOW_STAGES)[number];
export type StageState = "active" | "todo" | "done" | "blocked" | "invalidated";
export interface WorkflowStage {
  id: WorkflowStageId;
  state: StageState;
}

export interface WorkflowFrame {
  name: string;
  goal: string;
  intent: CreatorIntent;
  locale: string;
}
export interface Workflow extends WorkflowFrame {
  id: string;
  groupId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowVersion extends WorkflowFrame {
  inheritedFromVersionId: string | null;
  id: string;
  workflowId: string;
  number: number;
  stages: WorkflowStage[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}
interface FrameRow extends WorkflowFrame {
  id: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}
interface WorkflowRow extends FrameRow {
  group_id: string;
}
interface VersionRow extends FrameRow {
  inherited_from_version_id: string | null;
  workflow_id: string;
  number: number;
  stages: Record<WorkflowStageId, StageState>;
}

const FRAME_COLUMNS =
  "id, name, goal, intent, locale, revision, created_at, updated_at";
const WORKFLOW_COLUMNS = `${FRAME_COLUMNS}, group_id`;
const VERSION_COLUMNS = `${FRAME_COLUMNS}, workflow_id, number, stages, inherited_from_version_id`;

function frameRecord(row: FrameRow) {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    intent: row.intent,
    locale: row.locale,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}
function toWorkflow(row: WorkflowRow): Workflow {
  return { ...frameRecord(row), groupId: row.group_id };
}
function toVersion(row: VersionRow): WorkflowVersion {
  return {
    ...frameRecord(row),
    workflowId: row.workflow_id,
    inheritedFromVersionId: row.inherited_from_version_id,
    number: row.number,
    stages: WORKFLOW_STAGES.map((id) => ({ id, state: row.stages[id] })),
  };
}

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; message: string };

/** Validate at the kernel's name seam, without inventing a service naming rule. */
export function parseWorkflowFrame(
  input: Record<string, unknown>,
): ParseResult<WorkflowFrame> {
  if (!isWorkflowName(input["name"])) {
    return {
      ok: false,
      message:
        "name must be 2 to 64 lowercase letters, digits, or hyphens, beginning with a letter",
    };
  }
  const goal = typeof input["goal"] === "string" ? input["goal"].trim() : "";
  if (goal.length === 0 || goal.length > 4000) {
    return { ok: false, message: "goal must be text of 1 to 4000 characters" };
  }
  const intent = input["intent"];
  if (intent !== "new-skill" && intent !== "upgrade-existing") {
    return {
      ok: false,
      message: "intent must be new-skill or upgrade-existing",
    };
  }
  let locale: string | undefined;
  try {
    if (typeof input["locale"] === "string" && input["locale"].length <= 100) {
      locale = Intl.getCanonicalLocales(input["locale"])[0];
    }
  } catch {
    /* Invalid language tags are input errors. */
  }
  if (locale === undefined) {
    return {
      ok: false,
      message: "locale must be a valid language tag, such as en or zh-CN",
    };
  }
  return { ok: true, value: { name: input["name"], goal, intent, locale } };
}

export async function readWorkflow(
  database: Queryable,
  id: string,
): Promise<Workflow | null> {
  const result = await database.query<WorkflowRow>(
    `select ${WORKFLOW_COLUMNS} from workflows where id = $1`,
    [id],
  );
  return result.rows[0] === undefined ? null : toWorkflow(result.rows[0]);
}

export async function listWorkflows(
  database: Queryable,
  access: Access,
  person: Person,
): Promise<Workflow[]> {
  const visibility = await visibleGroups(database, access, person);
  const result = await database.query<WorkflowRow>(
    `select ${WORKFLOW_COLUMNS} from workflows w
      where $1::boolean or group_id = any($2::text[])
        or exists (select 1 from role_bindings b
                    where b.workflow_id = w.id and b.person_id = $3)
      order by name, id`,
    [
      visibility.everything,
      visibility.everything ? [] : [...visibility.groupIds],
      person.id,
    ],
  );
  return result.rows.map(toWorkflow);
}

export async function listWorkflowVersions(
  database: Queryable,
  workflowId: string,
): Promise<WorkflowVersion[]> {
  const result = await database.query<VersionRow>(
    `select ${VERSION_COLUMNS} from workflow_versions where workflow_id = $1 order by number desc`,
    [workflowId],
  );
  return result.rows.map(toVersion);
}

async function recordVersion(
  database: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  workflow: Workflow,
  number: number,
  inheritedFromVersionId: string | null = null,
): Promise<WorkflowVersion> {
  const stages = Object.fromEntries(
    WORKFLOW_STAGES.map((id, index) => [id, index === 0 ? "active" : "todo"]),
  );
  const result = await database.query<VersionRow>(
    `insert into workflow_versions
       (id, workflow_id, number, name, goal, intent, locale, stages, revision, created_at, updated_at, inherited_from_version_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $9, $9, $10)
     returning ${VERSION_COLUMNS}`,
    [
      dependencies.ids.next(),
      workflow.id,
      number,
      workflow.name,
      workflow.goal,
      workflow.intent,
      workflow.locale,
      JSON.stringify(stages),
      dependencies.clock.now(),
      inheritedFromVersionId,
    ],
  );
  const version = toVersion(result.rows[0]!);
  await recordAudit(database, dependencies, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "workflow_version.created",
    target: {
      type: "workflow_version",
      id: version.id,
      label: `${workflow.name} · v${number}`,
    },
    before: null,
    after: { revision: version.revision, hash: null },
    reason: "Workflow version created",
    requestId: context.requestId,
  });
  return version;
}

export type CreateWorkflowResult =
  | { kind: "created"; workflow: Workflow; version: WorkflowVersion }
  | { kind: "missing-group" }
  | { kind: "conflict" };

/** Creates the workflow, first version, and creator's owner binding atomically. */
export async function createWorkflow(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  input: WorkflowFrame & { groupId: string },
  person: Person,
): Promise<CreateWorkflowResult> {
  return database.transaction(async (tx) => {
    const group = await tx.query(`select 1 from groups where id = $1`, [
      input.groupId,
    ]);
    if (group.rows.length === 0) return { kind: "missing-group" };
    const result = await tx.query<WorkflowRow>(
      `insert into workflows (id, group_id, name, goal, intent, locale, revision, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 1, $7, $7)
       on conflict (group_id, name) do nothing returning ${WORKFLOW_COLUMNS}`,
      [
        dependencies.ids.next(),
        input.groupId,
        input.name,
        input.goal,
        input.intent,
        input.locale,
        dependencies.clock.now(),
      ],
    );
    if (result.rows[0] === undefined) return { kind: "conflict" };
    const workflow = toWorkflow(result.rows[0]);
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "workflow.created",
      target: { type: "workflow", id: workflow.id, label: workflow.name },
      before: null,
      after: { revision: workflow.revision, hash: null },
      reason: "Workflow created",
      requestId: context.requestId,
    });
    const owner = await recordBinding(
      tx,
      dependencies,
      context,
      {
        scopeType: "workflow",
        scopeId: workflow.id,
        email: person.email,
        role: "Workflow owner",
        personId: person.id,
      },
      "Workflow creator assigned as Workflow owner",
    );
    if (owner.kind !== "created")
      throw new Error("Could not assign the workflow's owner");
    return {
      kind: "created",
      workflow,
      version: await recordVersion(tx, dependencies, context, workflow, 1),
    };
  });
}

type WorkflowConflict =
  { kind: "missing" } | { kind: "stale"; workflow: Workflow };

/**
 * The row lock also serializes metadata edits with version creation. A frame
 * edit may rename the workflow, changing its (group_id, name) key, so it locks
 * FOR UPDATE. Version creation keeps the key and takes FOR NO KEY UPDATE, like
 * every other workflow lock, which foreign-key checks do not wait for.
 */
async function lockedWorkflow(
  database: Queryable,
  id: string,
  mode: "update" | "no key update",
): Promise<Workflow | null> {
  const result = await database.query<WorkflowRow>(
    `select ${WORKFLOW_COLUMNS} from workflows where id = $1 for ${mode}`,
    [id],
  );
  return result.rows[0] === undefined ? null : toWorkflow(result.rows[0]);
}

async function recordWorkflowChange(
  database: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  before: Workflow,
  after: Workflow,
  reason: string,
): Promise<void> {
  await recordAudit(database, dependencies, {
    actor: { personId: context.personId, credential: context.credential },
    channel: context.channel,
    action: "workflow.updated",
    target: { type: "workflow", id: after.id, label: after.name },
    before: { revision: before.revision, hash: null },
    after: { revision: after.revision, hash: null },
    reason,
    requestId: context.requestId,
  });
}

/** Edits affect the next version's frame; existing versions keep their snapshot. */
export async function updateWorkflow(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  id: string,
  revision: number,
  frame: WorkflowFrame,
): Promise<
  | { kind: "updated"; workflow: Workflow }
  | WorkflowConflict
  | { kind: "duplicate" }
> {
  try {
    return await database.transaction(async (tx) => {
      const current = await lockedWorkflow(tx, id, "update");
      if (current === null) return { kind: "missing" };
      if (current.revision !== revision)
        return { kind: "stale", workflow: current };
      const result = await tx.query<WorkflowRow>(
        `update workflows set name = $2, goal = $3, intent = $4, locale = $5,
           revision = revision + 1, updated_at = $6 where id = $1 returning ${WORKFLOW_COLUMNS}`,
        [
          id,
          frame.name,
          frame.goal,
          frame.intent,
          frame.locale,
          dependencies.clock.now(),
        ],
      );
      const workflow = toWorkflow(result.rows[0]!);
      await recordWorkflowChange(
        tx,
        dependencies,
        context,
        current,
        workflow,
        "Workflow frame updated for future versions",
      );
      return { kind: "updated", workflow };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      return { kind: "duplicate" };
    }
    throw error;
  }
}

/** Quoting the parent revision prevents two people starting the same next version. */
export async function createWorkflowVersion(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  id: string,
  revision: number,
): Promise<
  | { kind: "created"; workflow: Workflow; version: WorkflowVersion }
  | WorkflowConflict
> {
  return database.transaction(async (tx) => {
    const current = await lockedWorkflow(tx, id, "no key update");
    if (current === null) return { kind: "missing" };
    if (current.revision !== revision)
      return { kind: "stale", workflow: current };
    const result = await tx.query<WorkflowRow>(
      `update workflows set revision = revision + 1, updated_at = $2
        where id = $1 returning ${WORKFLOW_COLUMNS}`,
      [id, dependencies.clock.now()],
    );
    const workflow = toWorkflow(result.rows[0]!);
    const versions = await tx.query<{ id: string; number: number }>(
      `select id, number from workflow_versions where workflow_id = $1 order by number desc limit 1 for no key update`,
      [id],
    );
    const version = await recordVersion(
      tx,
      dependencies,
      context,
      workflow,
      (versions.rows[0]?.number ?? 0) + 1,
      versions.rows[0]?.id ?? null,
    );
    const sourceId = version.inheritedFromVersionId;
    if (sourceId !== null) {
      const inherited = await inheritVersionRecords(
        tx,
        dependencies,
        sourceId,
        version.id,
      );
      const moved = await moveOpenWork(tx, dependencies, sourceId, version.id);
      await recordAudit(tx, dependencies, {
        actor: { personId: context.personId, credential: context.credential },
        channel: context.channel,
        action: "workflow_version.inherited",
        target: {
          type: "workflow_version",
          id: version.id,
          label: `${workflow.name} · v${version.number}`,
        },
        before: null,
        after: { revision: version.revision, hash: inherited.hash },
        reason: describeInheritance(sourceId, inherited, moved),
        requestId: context.requestId,
      });
      if (
        (
          await tx.query(
            "select 1 from workflow_skill_pins where workflow_version_id = $1",
            [version.id],
          )
        ).rows.length > 0
      )
        await enqueueSourceCheck(tx, dependencies, context, version.id);
    }
    await recordWorkflowChange(
      tx,
      dependencies,
      context,
      current,
      workflow,
      "Workflow version added",
    );
    return { kind: "created", workflow, version };
  });
}

/** Role holders and pending invitations, visible only inside this workflow. */
export async function listWorkflowBindings(
  database: Queryable,
  workflowId: string,
): Promise<(RoleBinding & { displayName: string | null })[]> {
  const result = await database.query<{
    id: string;
    role: RoleBinding["role"];
    person_id: string | null;
    email: string;
    invited_by: string;
    revision: number;
    created_at: Date | string;
    updated_at: Date | string;
    display_name: string | null;
  }>(
    `select b.id, b.role, b.person_id, b.email, b.invited_by, b.revision,
            b.created_at, b.updated_at, p.display_name
       from role_bindings b left join people p on p.id = b.person_id
      where b.workflow_id = $1 order by b.role, b.email, b.id`,
    [workflowId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    scopeType: "workflow",
    scopeId: workflowId,
    role: row.role,
    personId: row.person_id,
    email: row.email,
    invitedBy: row.invited_by,
    pending: row.person_id === null,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    displayName: row.display_name,
  }));
}
