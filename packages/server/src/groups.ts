import { recordAudit, type WriteContext } from "./audit.js";
import type {
  Access,
  GroupRole,
  OrganizationRole,
  ScopeType,
  Visibility,
} from "./authorization.js";
import { configuredAdministratorFor, visibleGroups } from "./authorization.js";
import type { ServiceConfig } from "./config.js";
import type { Database, Queryable } from "./database/database.js";
import { isInside, lockGroupTree, withAncestors } from "./group-tree.js";
import type { ServiceDependencies } from "./dependencies.js";
import type { Person } from "./people.js";
import type { BindingRole } from "./bindings.js";
import { toIsoString } from "./util.js";

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  parent_id: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const GROUP_COLUMNS = "id, name, parent_id, revision, created_at, updated_at";

function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export interface CreateGroupInput {
  name: string;
  parentId: string | null;
}

export type GroupParseResult<T> =
  { ok: true; value: T } | { ok: false; message: string };

function readName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  return name.length >= 1 && name.length <= 120 ? name : null;
}

function objectBody(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function parseCreateGroupInput(
  body: unknown,
): GroupParseResult<CreateGroupInput> {
  const input = objectBody(body);
  if (input === null) {
    return { ok: false, message: "The request body must be a JSON object" };
  }
  const unknown = Object.keys(input).filter(
    (key) => !["name", "parentId"].includes(key),
  );
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown field ${unknown.join(", ")}` };
  }
  const name = readName(input["name"]);
  if (name === null) {
    return {
      ok: false,
      message: "name must be text of 1 to 120 characters",
    };
  }
  const parentId = input["parentId"] ?? null;
  if (parentId !== null && (typeof parentId !== "string" || parentId === "")) {
    return { ok: false, message: "parentId must name a group or be null" };
  }
  return { ok: true, value: { name, parentId } };
}

export interface UpdateGroupInput {
  revision: number;
  name: string | null;
  parentId: string | null | undefined;
}

export function parseUpdateGroupInput(
  body: unknown,
): GroupParseResult<UpdateGroupInput> {
  const input = objectBody(body);
  if (input === null) {
    return { ok: false, message: "The request body must be a JSON object" };
  }
  const unknown = Object.keys(input).filter(
    (key) => !["revision", "name", "parentId"].includes(key),
  );
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown field ${unknown.join(", ")}` };
  }
  const revision = input["revision"];
  if (!Number.isInteger(revision) || (revision as number) < 1) {
    return { ok: false, message: "revision must be a whole number from 1" };
  }

  let name: string | null = null;
  if (input["name"] !== undefined) {
    name = readName(input["name"]);
    if (name === null) {
      return {
        ok: false,
        message: "name must be text of 1 to 120 characters",
      };
    }
  }

  const parent = input["parentId"];
  if (
    parent !== undefined &&
    parent !== null &&
    (typeof parent !== "string" || parent === "")
  ) {
    return { ok: false, message: "parentId must name a group or be null" };
  }

  return {
    ok: true,
    value: {
      revision: revision as number,
      name,
      parentId: parent === undefined ? undefined : (parent as string | null),
    },
  };
}

async function readGroupRow(
  database: Queryable,
  id: string,
): Promise<GroupRow | null> {
  const rows = await database.query<GroupRow>(
    `select ${GROUP_COLUMNS} from groups where id = $1`,
    [id],
  );
  return rows.rows[0] ?? null;
}

/** The groups a person may see, by name. */
export async function listGroups(
  database: Queryable,
  access: Access,
  person: Person,
  visibility?: Visibility,
): Promise<Group[]> {
  const visible = visibility ?? (await visibleGroups(database, access, person));
  const rows = visible.everything
    ? await database.query<GroupRow>(
        `select ${GROUP_COLUMNS} from groups order by name, id`,
      )
    : await database.query<GroupRow>(
        `select ${GROUP_COLUMNS}
           from groups
          where id = any($1::text[])
          order by name, id`,
        [[...visible.groupIds]],
      );
  return rows.rows.map(toGroup);
}

export interface GroupMember {
  id: string;
  email: string;
  displayName: string;
}

export async function listGroupMembers(
  database: Queryable,
  groupId: string,
): Promise<GroupMember[]> {
  const groupIds = await withAncestors(database, [groupId]);
  const result = await database.query<{
    id: string;
    email: string;
    display_name: string;
  }>(
    `select p.id, p.email, p.display_name
       from people p
      where exists (
        select 1 from role_bindings b
         where b.person_id = p.id and b.scope_type = 'group'
           and b.scope_id = any($1::text[])
      )
      order by p.display_name, p.id`,
    [[...groupIds]],
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
  }));
}

export type CreateGroupResult =
  | { kind: "created"; group: Group }
  | { kind: "missing-parent" }
  | { kind: "conflict" };

/** Creates a group under an existing parent, or at the top level. */
export async function createGroup(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  input: CreateGroupInput,
): Promise<CreateGroupResult> {
  return database.transaction(async (tx) => {
    if (
      input.parentId !== null &&
      (await readGroupRow(tx, input.parentId)) === null
    ) {
      return { kind: "missing-parent" };
    }
    const now = dependencies.clock.now();
    const inserted = await tx.query<GroupRow>(
      `insert into groups (id, parent_id, name, revision, created_at, updated_at)
       values ($1, $2, $3, 1, $4, $4)
       on conflict do nothing
       returning ${GROUP_COLUMNS}`,
      [dependencies.ids.next(), input.parentId, input.name, now],
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
      action: "group.created",
      target: { type: "group", id: row.id, label: row.name },
      before: null,
      after: { revision: row.revision, hash: null },
      reason: "Group created",
      requestId: context.requestId,
    });
    return { kind: "created", group: toGroup(row) };
  });
}

export type UpdateGroupResult =
  | { kind: "updated"; group: Group }
  | { kind: "missing" }
  | { kind: "stale"; group: Group }
  | { kind: "missing-parent" }
  | { kind: "cycle" }
  | { kind: "conflict" };

export async function updateGroup(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  id: string,
  input: UpdateGroupInput,
): Promise<UpdateGroupResult> {
  return database.transaction(async (tx) => {
    if (input.parentId !== undefined) {
      await lockGroupTree(tx);
    }
    const current = await readGroupRow(tx, id);
    if (current === null) {
      return { kind: "missing" };
    }
    if (current.revision !== input.revision) {
      return { kind: "stale", group: toGroup(current) };
    }

    if (input.parentId !== undefined && input.parentId !== null) {
      if ((await readGroupRow(tx, input.parentId)) === null) {
        return { kind: "missing-parent" };
      }
      if (await isInside(tx, id, input.parentId)) {
        return { kind: "cycle" };
      }
    }

    const name = input.name ?? current.name;
    const parentId =
      input.parentId === undefined ? current.parent_id : input.parentId;
    const sibling = await tx.query<{ id: string }>(
      `select id
         from groups
        where id <> $1
          and coalesce(parent_id, '') = coalesce($2::text, '')
          and lower(name) = lower($3)
        limit 1`,
      [id, parentId, name],
    );
    if (sibling.rows.length > 0) {
      return { kind: "conflict" };
    }
    const now = dependencies.clock.now();
    const updated = await tx.query<GroupRow>(
      `update groups
          set name = $2, parent_id = $3, revision = $4, updated_at = $5
        where id = $1 and revision = $6
        returning ${GROUP_COLUMNS}`,
      [id, name, parentId, current.revision + 1, now, current.revision],
    );
    const row = updated.rows[0];
    if (row === undefined) {
      const reread = await readGroupRow(tx, id);
      return reread === null ? { kind: "missing" } : { kind: "conflict" };
    }

    await recordAudit(tx, dependencies, {
      actor: {
        personId: context.personId,
        credential: context.credential,
      },
      channel: context.channel,
      action: "group.updated",
      target: {
        type: "group",
        id,
        label:
          row.name === current.name
            ? row.name
            : `${current.name} → ${row.name}`,
      },
      before: { revision: current.revision, hash: null },
      after: { revision: row.revision, hash: null },
      reason: "Group changed",
      requestId: context.requestId,
    });
    return { kind: "updated", group: toGroup(row) };
  });
}

export interface MemberBinding {
  id: string;
  revision: number;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeName: string | null;
  role: BindingRole;
}

export interface MemberSummary {
  person: { id: string; email: string; displayName: string };
  organizationRoles: OrganizationRole[];
  groups: { id: string; name: string; role: GroupRole }[];
  /** Every binding in view, with the revision a removal quotes. */
  bindings: MemberBinding[];
}

interface MemberRow {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  email_verified: boolean;
  display_name: string;
}

interface MemberBindingRow {
  id: string;
  revision: number;
  person_id: string;
  scope_type: ScopeType;
  role: BindingRole;
  group_id: string | null;
  group_name: string | null;
  scope_id: string | null;
  scope_name: string | null;
}

/**
 * Lists people with the roles Badger records for them, within what the reader
 * may see (managementVisibility): everyone for an organization-wide reader,
 * otherwise the people bound in the visible groups.
 */
export async function listMembers(
  database: Queryable,
  config: ServiceConfig,
  visibility: Visibility,
): Promise<MemberSummary[]> {
  const groupIds = visibility.everything ? [] : [...visibility.groupIds];
  const workflowGroupIds = visibility.everything
    ? []
    : [...(visibility.workflowGroupIds ?? [])];
  const rows = await database.query<MemberRow>(
    `select p.id, p.issuer, p.subject, p.email, p.email_verified,
            p.display_name
       from people p
      where $1::boolean
         or exists (
           select 1
             from role_bindings b
             left join workflows w on w.id = b.workflow_id
            where b.person_id = p.id
              and ((b.scope_type = 'group' and b.scope_id = any($2::text[]))
                or (b.scope_type = 'workflow' and w.group_id = any($3::text[])))
         )
      order by p.display_name, p.id`,
    [visibility.everything, groupIds, workflowGroupIds],
  );
  if (rows.rows.length === 0) {
    return [];
  }

  const ids = rows.rows.map((row) => row.id);
  const bindings = await database.query<MemberBindingRow>(
    `select b.id, b.revision, b.person_id, b.scope_type, b.role,
            g.id as group_id, g.name as group_name,
            coalesce(b.scope_id, b.workflow_id) as scope_id,
            coalesce(g.name, w.name) as scope_name
       from role_bindings b
       left join groups g on g.id = b.scope_id
       left join workflows w on w.id = b.workflow_id
      where b.person_id = any($1::text[])
        and (
          $2::boolean
          or (b.scope_type = 'group' and b.scope_id = any($3::text[]))
          or (b.scope_type = 'workflow' and w.group_id = any($4::text[]))
        )`,
    [ids, visibility.everything, groupIds, workflowGroupIds],
  );

  return rows.rows.map((row) => {
    const organizationRoles = new Set<OrganizationRole>();
    if (
      configuredAdministratorFor(
        {
          issuer: row.issuer,
          subject: row.subject,
          email: row.email,
          emailVerified: row.email_verified,
        },
        config,
      )
    ) {
      organizationRoles.add("Administrator");
    }
    const groups: { id: string; name: string; role: GroupRole }[] = [];
    const visibleBindings: MemberBinding[] = [];
    for (const binding of bindings.rows) {
      if (binding.person_id !== row.id) {
        continue;
      }
      if (binding.scope_type === "organization") {
        organizationRoles.add(binding.role as OrganizationRole);
      } else if (
        binding.scope_type === "group" &&
        binding.group_id !== null &&
        binding.group_name !== null
      ) {
        groups.push({
          id: binding.group_id,
          name: binding.group_name,
          role: binding.role as GroupRole,
        });
      }
      visibleBindings.push({
        id: binding.id,
        revision: binding.revision,
        scopeType: binding.scope_type,
        scopeId: binding.scope_id,
        scopeName: binding.scope_name,
        role: binding.role,
      });
    }
    return {
      person: { id: row.id, email: row.email, displayName: row.display_name },
      organizationRoles: [...organizationRoles].sort(),
      groups,
      bindings: visibleBindings,
    };
  });
}
