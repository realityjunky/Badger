import { recordAudit, type WriteContext } from "./audit.js";
import {
  GROUP_ROLES,
  isGroupRole,
  isOrganizationRole,
  ORGANIZATION_ROLES,
  type GroupRole,
  type OrganizationRole,
  type ScopeType,
  type Visibility,
} from "./authorization.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { RequestError } from "./http/errors.js";
import type { Person } from "./people.js";
import { toIsoString } from "./util.js";
import {
  isWorkflowRole,
  WORKFLOW_ROLES,
  type WorkflowRole,
} from "./workflow-access.js";

export type BindingRole = OrganizationRole | GroupRole | WorkflowRole;

export interface RoleBinding {
  id: string;
  scopeType: ScopeType;
  scopeId: string | null;
  role: BindingRole;
  personId: string | null;
  email: string;
  invitedBy: string;
  /** A binding with no person yet is an invitation, applied at first sign-in. */
  pending: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface BindingRow {
  id: string;
  scope_type: ScopeType;
  scope_id: string | null;
  workflow_id: string | null;
  role: BindingRole;
  person_id: string | null;
  email: string;
  invited_by: string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const BINDING_COLUMNS = `id, scope_type, scope_id, workflow_id, role, person_id, email,
       invited_by, revision, created_at, updated_at`;
const QUALIFIED_BINDING_COLUMNS = BINDING_COLUMNS.split(",")
  .map((column) => `b.${column.trim()}`)
  .join(", ");

function toBinding(row: BindingRow): RoleBinding {
  return {
    id: row.id,
    scopeType: row.scope_type,
    scopeId: row.workflow_id ?? row.scope_id,
    role: row.role,
    personId: row.person_id,
    email: row.email,
    invitedBy: row.invited_by,
    pending: row.person_id === null,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export interface BindingInput {
  scopeType: ScopeType;
  scopeId: string | null;
  email: string;
  role: BindingRole;
  /** A known identity for internal writes, never accepted from an HTTP body. */
  personId?: string;
}

export type BindingParseResult =
  | {
      ok: true;
      value: {
        scopeType: ScopeType;
        scopeId: string | null;
        email: string;
        role: BindingRole;
        overrideReason: string | null;
      };
    }
  | { ok: false; message: string };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/u;

/** Validates an invitation or direct role binding. Unknown keys are refused. */
export function parseBindingInput(body: unknown): BindingParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "The request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter(
    (key) =>
      !["scopeType", "scopeId", "email", "role", "overrideReason"].includes(
        key,
      ),
  );
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown field ${unknown.join(", ")}` };
  }

  const scopeType = input["scopeType"];
  if (
    scopeType !== "organization" &&
    scopeType !== "group" &&
    scopeType !== "workflow"
  ) {
    return {
      ok: false,
      message: "scopeType must be organization, group, or workflow",
    };
  }
  const scopeId = input["scopeId"] ?? null;
  if (scopeType === "organization" && scopeId !== null) {
    return { ok: false, message: "An organization binding names no group" };
  }
  if (
    scopeType !== "organization" &&
    (typeof scopeId !== "string" || scopeId.trim() === "")
  ) {
    return {
      ok: false,
      message: "A group or workflow binding names its scope",
    };
  }

  const email = typeof input["email"] === "string" ? input["email"].trim() : "";
  if (!EMAIL_PATTERN.test(email)) {
    return { ok: false, message: "email must be an email address" };
  }

  const role = input["role"];
  if (typeof role !== "string") {
    return { ok: false, message: "role must be a role name" };
  }
  if (scopeType === "organization" && !isOrganizationRole(role)) {
    return {
      ok: false,
      message: `An organization role is one of ${ORGANIZATION_ROLES.join(", ")}`,
    };
  }
  if (scopeType === "group" && !isGroupRole(role)) {
    return {
      ok: false,
      message: `A group role is one of ${GROUP_ROLES.join(", ")}`,
    };
  }

  const reason = input["overrideReason"];
  if (scopeType === "workflow" && !isWorkflowRole(role)) {
    return {
      ok: false,
      message: `A workflow role is one of ${WORKFLOW_ROLES.join(", ")}`,
    };
  }
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.trim().length > 1000)
  ) {
    return {
      ok: false,
      message: "overrideReason must be text of at most 1000 characters",
    };
  }

  return {
    ok: true,
    value: {
      scopeType,
      scopeId: scopeType === "organization" ? null : (scopeId as string),
      email,
      role: role as BindingRole,
      overrideReason:
        typeof reason === "string" && reason.trim() !== ""
          ? reason.trim()
          : null,
    },
  };
}

/**
 * The person whose verified address this is. An unverified address names
 * nobody. If the provider has reassigned an address, more than one record may
 * still carry it; the one that took it last is its holder.
 */
async function personByVerifiedEmail(
  database: Queryable,
  email: string,
): Promise<string | null> {
  const rows = await database.query<{ id: string }>(
    `select id
       from people
      where lower(email) = lower($1) and email_verified
      order by updated_at desc, id desc
      limit 1`,
    [email],
  );
  return rows.rows[0]?.id ?? null;
}

/**
 * How the Activity log names a binding: its role, its scope, and its address,
 * so the entry still reads once the binding is removed.
 */
async function bindingLabel(
  database: Queryable,
  row: Pick<BindingRow, "role" | "scope_id" | "workflow_id" | "email">,
): Promise<string> {
  if (row.workflow_id !== null) {
    const workflow = await database.query<{ name: string }>(
      `select name from workflows where id = $1`,
      [row.workflow_id],
    );
    return `${row.role} · ${workflow.rows[0]?.name ?? row.workflow_id} · ${row.email}`;
  }
  if (row.scope_id === null) {
    return `${row.role} · Organization · ${row.email}`;
  }
  const group = await database.query<{ name: string }>(
    `select name from groups where id = $1`,
    [row.scope_id],
  );
  return `${row.role} · ${group.rows[0]?.name ?? row.scope_id} · ${row.email}`;
}

async function readBinding(
  database: Queryable,
  id: string,
  lock = false,
): Promise<BindingRow | null> {
  const rows = await database.query<BindingRow>(
    `select ${BINDING_COLUMNS} from role_bindings where id = $1${lock ? " for update" : ""}`,
    [id],
  );
  return rows.rows[0] ?? null;
}

export type CreateBindingResult =
  | { kind: "created"; binding: RoleBinding }
  | { kind: "conflict" }
  | { kind: "missing-group" }
  | { kind: "missing-workflow" };

/**
 * Records a role binding. A binding for an address no signed-in person has
 * verified is an invitation: it waits, person-less, until a sign-in presents
 * that address as verified. A binding for a person already known by that
 * verified address applies at once, and a waiting invitation for the same
 * address is resolved rather than duplicated.
 */
export async function createBinding(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  input: BindingInput,
  reason: string,
): Promise<CreateBindingResult> {
  return database.transaction((tx) =>
    recordBinding(tx, dependencies, context, input, reason),
  );
}

/** Also used inside the transaction that creates a workflow and its owner. */
export async function recordBinding(
  tx: Queryable,
  dependencies: ServiceDependencies,
  context: WriteContext,
  input: BindingInput,
  reason: string,
): Promise<CreateBindingResult> {
  if (input.scopeId !== null) {
    const scope = await tx.query(
      input.scopeType === "workflow"
        ? `select 1 from workflows where id = $1`
        : `select 1 from groups where id = $1`,
      [input.scopeId],
    );
    if (scope.rows.length === 0) {
      return {
        kind:
          input.scopeType === "workflow" ? "missing-workflow" : "missing-group",
      };
    }
  }
  const now = dependencies.clock.now();
  const personId =
    input.personId ?? (await personByVerifiedEmail(tx, input.email));

  if (personId !== null) {
    const resolved = await tx.query<BindingRow>(
      `update role_bindings
            set person_id = $1, revision = revision + 1, updated_at = $2
          where person_id is null
            and scope_type = $3
            and coalesce(scope_id, workflow_id, '') = coalesce($4, '')
            and role = $5
            and lower(email) = lower($6)
          returning ${BINDING_COLUMNS}`,
      [personId, now, input.scopeType, input.scopeId, input.role, input.email],
    );
    const row = resolved.rows[0];
    if (row !== undefined) {
      await recordAudit(tx, dependencies, {
        actor: {
          personId: context.personId,
          credential: context.credential,
        },
        channel: context.channel,
        action: "role_binding.resolved",
        target: {
          type: "role_binding",
          id: row.id,
          label: await bindingLabel(tx, row),
        },
        before: { revision: row.revision - 1, hash: null },
        after: { revision: row.revision, hash: null },
        reason,
        requestId: context.requestId,
      });
      return { kind: "created", binding: toBinding(row) };
    }
  }

  const id = dependencies.ids.next();
  const inserted = await tx.query<BindingRow>(
    `insert into role_bindings (
         id, scope_type, scope_id, role, person_id, email, invited_by,
         workflow_id, revision, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $9, 1, $8, $8)
       on conflict do nothing
       returning ${BINDING_COLUMNS}`,
    [
      id,
      input.scopeType,
      input.scopeType === "workflow" ? null : input.scopeId,
      input.role,
      personId,
      input.email.toLowerCase(),
      context.personId,
      now,
      input.scopeType === "workflow" ? input.scopeId : null,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    return { kind: "conflict" };
  }

  await recordAudit(tx, dependencies, {
    actor: {
      personId: context.personId,
      credential: context.credential,
    },
    channel: context.channel,
    action: personId === null ? "role_binding.invited" : "role_binding.granted",
    target: {
      type: "role_binding",
      id: row.id,
      label: await bindingLabel(tx, row),
    },
    before: null,
    after: { revision: 1, hash: null },
    reason,
    requestId: context.requestId,
  });

  return { kind: "created", binding: toBinding(row) };
}

/**
 * Applies every waiting invitation for the person's address, if the provider
 * verified it. A binding with the role already held for that person is
 * superseded instead of duplicated. Each resolution is audited in the
 * sign-in's transaction.
 */
export async function resolvePendingBindings(
  database: Queryable,
  dependencies: ServiceDependencies,
  person: Person,
  context: Omit<WriteContext, "personId">,
): Promise<void> {
  if (!person.emailVerified) {
    return;
  }
  const pending = await database.query<BindingRow>(
    `select ${BINDING_COLUMNS}
       from role_bindings
      where person_id is null and lower(email) = lower($1)
      order by created_at, id`,
    [person.email],
  );
  const now = dependencies.clock.now();

  for (const row of pending.rows) {
    const existing = await database.query<{ id: string }>(
      `select id
         from role_bindings
        where person_id = $1
          and scope_type = $2
          and coalesce(scope_id, workflow_id, '') = coalesce($3, '')
          and role = $4
        limit 1`,
      [person.id, row.scope_type, row.workflow_id ?? row.scope_id, row.role],
    );

    if (existing.rows.length > 0) {
      await recordAudit(database, dependencies, {
        actor: { personId: person.id, credential: context.credential },
        channel: context.channel,
        action: "role_binding.superseded",
        target: {
          type: "role_binding",
          id: row.id,
          label: await bindingLabel(database, row),
        },
        before: { revision: row.revision, hash: null },
        after: null,
        reason: "A binding for the same role already exists",
        requestId: context.requestId,
      });
      await database.query(`delete from role_bindings where id = $1`, [row.id]);
      continue;
    }

    const updated = await database.query<BindingRow>(
      `update role_bindings
          set person_id = $1, revision = revision + 1, updated_at = $2
        where id = $3 and person_id is null
        returning ${BINDING_COLUMNS}`,
      [person.id, now, row.id],
    );
    const resolved = updated.rows[0];
    if (resolved === undefined) {
      continue;
    }

    await recordAudit(database, dependencies, {
      actor: {
        personId: person.id,
        credential: context.credential,
      },
      channel: context.channel,
      action: "role_binding.resolved",
      target: {
        type: "role_binding",
        id: resolved.id,
        label: await bindingLabel(database, resolved),
      },
      before: { revision: resolved.revision - 1, hash: null },
      after: { revision: resolved.revision, hash: null },
      reason: "Email binding applied at sign-in with a verified address",
      requestId: context.requestId,
    });
  }
}

interface InvitationRow extends BindingRow {
  scope_name: string | null;
  invited_by_name: string;
}

export interface Invitation extends RoleBinding {
  scopeName: string | null;
  invitedByName: string;
}

/**
 * Lists every binding still waiting for its person to sign in, within what
 * the reader may see (managementVisibility).
 */
export async function listInvitations(
  database: Queryable,
  visibility: Visibility,
): Promise<Invitation[]> {
  const rows = await database.query<InvitationRow>(
    `select ${QUALIFIED_BINDING_COLUMNS},
            coalesce(g.name, w.name) as scope_name, p.display_name as invited_by_name
       from role_bindings b
       left join groups g on g.id = b.scope_id
       left join workflows w on w.id = b.workflow_id
       join people p on p.id = b.invited_by
      where b.person_id is null
        and (
          $1::boolean
          or (
            (b.scope_type = 'group' and b.scope_id = any($2::text[]))
            or (b.scope_type = 'workflow' and w.group_id = any($3::text[]))
          )
        )
      order by b.created_at, b.id`,
    [
      visibility.everything,
      visibility.everything ? [] : [...visibility.groupIds],
      visibility.everything ? [] : [...(visibility.workflowGroupIds ?? [])],
    ],
  );
  return rows.rows.map((row) => ({
    ...toBinding(row),
    scopeName: row.scope_name,
    invitedByName: row.invited_by_name,
  }));
}

export type RemoveBindingResult =
  | { kind: "removed"; binding: RoleBinding }
  | { kind: "stale"; binding: RoleBinding }
  | { kind: "missing" };

export async function changeGroupRole(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  id: string,
  revision: number,
  role: GroupRole,
): Promise<RoleBinding> {
  try {
    return await database.transaction(async (tx) => {
      const current = await readBinding(tx, id, true);
      if (current === null) throw new RequestError(404, "No such role binding");
      if (current.scope_type !== "group" || current.person_id === null)
        throw new RequestError(
          400,
          "Only an accepted group role can be changed",
        );
      if (current.revision !== revision)
        throw new RequestError(409, "The binding changed since you read it", {
          binding: toBinding(current),
        });
      if (current.role === role) return toBinding(current);
      const changed = await tx.query<BindingRow>(
        `update role_bindings set role = $1, revision = revision + 1, updated_at = $2
          where id = $3 returning ${BINDING_COLUMNS}`,
        [role, dependencies.clock.now(), id],
      );
      const binding = changed.rows[0]!;
      await recordAudit(tx, dependencies, {
        actor: { personId: context.personId, credential: context.credential },
        channel: context.channel,
        action: "role_binding.changed",
        target: {
          type: "role_binding",
          id,
          label: await bindingLabel(tx, binding),
        },
        before: { revision, hash: null },
        after: { revision: binding.revision, hash: null },
        reason: `Group role changed from ${current.role} to ${role}`,
        requestId: context.requestId,
      });
      return toBinding(binding);
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    )
      throw new RequestError(
        409,
        "This person already holds that role in the group",
      );
    throw error;
  }
}

/**
 * Removes a binding against the revision the caller read. The write and its
 * audit record commit together; the reason carries any recorded override.
 */
export async function removeBinding(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  id: string,
  revision: number,
  reason: string,
): Promise<RemoveBindingResult> {
  return database.transaction(async (tx) => {
    const current = await readBinding(tx, id, true);
    if (current === null) {
      return { kind: "missing" };
    }
    if (current.revision !== revision) {
      return { kind: "stale", binding: toBinding(current) };
    }
    const removed = await tx.query(
      `delete from role_bindings where id = $1 and revision = $2`,
      [id, revision],
    );
    if (removed.rowCount === 0) {
      return { kind: "missing" };
    }

    await recordAudit(tx, dependencies, {
      actor: {
        personId: context.personId,
        credential: context.credential,
      },
      channel: context.channel,
      action: "role_binding.removed",
      target: {
        type: "role_binding",
        id,
        label: await bindingLabel(tx, current),
      },
      before: { revision: current.revision, hash: null },
      after: null,
      reason,
      requestId: context.requestId,
    });

    return { kind: "removed", binding: toBinding(current) };
  });
}

export async function readBindingById(
  database: Queryable,
  id: string,
): Promise<RoleBinding | null> {
  const row = await readBinding(database, id);
  return row === null ? null : toBinding(row);
}
