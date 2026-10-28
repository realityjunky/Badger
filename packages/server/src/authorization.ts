import type { ServiceConfig } from "./config.js";
import type { Queryable } from "./database/database.js";
import { ancestorIds } from "./group-tree.js";
import { LOCAL_IDENTITY_ISSUER } from "./identity/local.js";
import type { Principal } from "./identity/identity.js";
import type { Person } from "./people.js";

export type OrganizationRole = "Administrator" | "Auditor";
export type GroupRole = "Group lead" | "Member";
export type ScopeType = "organization" | "group";

export const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  "Administrator",
  "Auditor",
];
export const GROUP_ROLES: readonly GroupRole[] = ["Group lead", "Member"];

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

export function isGroupRole(value: string): value is GroupRole {
  return (GROUP_ROLES as readonly string[]).includes(value);
}

/** A group the person is bound to, with the role held there. */
export interface GroupGrant {
  id: string;
  name: string;
  role: GroupRole;
}

/**
 * What Badger decides a signed-in person may do. Organization roles come from
 * configuration and from organization bindings; group roles come from bindings
 * on the group, and a binding on a group applies to the groups inside it.
 */
export interface Access {
  organization: OrganizationRole[];
  /** Direct group bindings; inheritance is resolved when a group is checked. */
  groups: GroupGrant[];
}

export function isAdministrator(access: Access): boolean {
  return access.organization.includes("Administrator");
}

export function mayReadAudit(access: Access): boolean {
  return (
    access.organization.includes("Administrator") ||
    access.organization.includes("Auditor")
  );
}

interface OrganizationBindingRow {
  role: OrganizationRole;
}

interface GroupBindingRow {
  id: string;
  name: string;
  role: GroupRole;
}

/**
 * Whether configuration alone makes this person an Administrator: local
 * mode's implicit one, or an address the deployment lists.
 */
export function configuredAdministratorFor(
  person: Pick<Person, "email" | "issuer" | "subject">,
  config: ServiceConfig,
): boolean {
  if (
    config.identity.kind === "local" &&
    person.issuer === LOCAL_IDENTITY_ISSUER &&
    person.subject === config.identity.administrator.subject
  ) {
    return true;
  }
  return config.bootstrapAdministrators.includes(person.email.toLowerCase());
}

/**
 * The configured Administrators: local mode's implicit one, the emails the
 * deployment lists, and, when the deployment switches the mapping on, people
 * the platform calls administrators. A principal grants nothing by itself
 * (ADR 0003); this function reads Badger's own decision.
 */
function configuredAdministrator(
  person: Person,
  principal: Principal | null,
  config: ServiceConfig,
): boolean {
  if (configuredAdministratorFor(person, config)) {
    return true;
  }
  return config.platformAdministratorMapping && principal !== null
    ? principal.platformAdministrator
    : false;
}

/** Reads every role the person holds directly. */
export async function accessFor(
  database: Queryable,
  person: Person,
  principal: Principal | null,
  config: ServiceConfig,
): Promise<Access> {
  const organization = new Set<OrganizationRole>();
  if (configuredAdministrator(person, principal, config)) {
    organization.add("Administrator");
  }

  const organizationRows = await database.query<OrganizationBindingRow>(
    `select role
       from role_bindings
      where scope_type = 'organization' and person_id = $1
      order by role`,
    [person.id],
  );
  for (const row of organizationRows.rows) {
    organization.add(row.role);
  }

  const groupRows = await database.query<GroupBindingRow>(
    `select g.id, g.name, b.role
       from role_bindings b
       join groups g on g.id = b.scope_id
      where b.scope_type = 'group' and b.person_id = $1
      order by g.name, g.id`,
    [person.id],
  );

  return {
    organization: [...organization],
    groups: groupRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
    })),
  };
}

/** Whether the person holds one of `roles` on the group or one above it. */
async function holdsGroupRole(
  database: Queryable,
  person: Person,
  groupId: string,
  roles: readonly GroupRole[],
): Promise<boolean> {
  const ids = await ancestorIds(database, groupId);
  if (ids.length === 0) {
    return false;
  }
  const rows = await database.query(
    `select 1
       from role_bindings
      where scope_type = 'group'
        and person_id = $1
        and scope_id = any($2::text[])
        and role = any($3::text[])
      limit 1`,
    [person.id, ids, roles],
  );
  return rows.rows.length > 0;
}

/** Managing a group's members and bindings: an Administrator or its Group lead. */
export async function mayManageGroup(
  database: Queryable,
  access: Access,
  person: Person,
  groupId: string,
): Promise<boolean> {
  if (isAdministrator(access)) {
    return true;
  }
  return holdsGroupRole(database, person, groupId, ["Group lead"]);
}

/** The groups where the person holds `role`, plus everything inside them. */
async function groupIdsFromBindings(
  database: Queryable,
  personId: string,
  role: GroupRole | null,
): Promise<Set<string>> {
  const rows = await database.query<{ id: string }>(
    `with recursive reached as (
       select g.id
         from groups g
        where exists (
          select 1 from role_bindings b
           where b.scope_type = 'group'
             and b.person_id = $1
             and b.scope_id = g.id
             and ($2::text is null or b.role = $2)
        )
       union
       select g.id
         from groups g
         join reached r on g.parent_id = r.id
     )
     select id from reached`,
    [personId, role],
  );
  return new Set(rows.rows.map((row) => row.id));
}

/**
 * The groups themselves plus every ancestor, so a binding recorded above a
 * managed group is visible in its member and invitation lists.
 */
export async function withAncestorGroups(
  database: Queryable,
  groupIds: Set<string>,
): Promise<Set<string>> {
  if (groupIds.size === 0) {
    return new Set();
  }
  const rows = await database.query<{ id: string }>(
    `with recursive chain as (
       select id, parent_id from groups where id = any($1::text[])
       union
       select g.id, g.parent_id
         from groups g
         join chain c on g.id = c.parent_id
     )
     select id from chain`,
    [[...groupIds]],
  );
  return new Set(rows.rows.map((row) => row.id));
}

/**
 * The groups a person may see: all of them for an Administrator or Auditor;
 * otherwise the groups they are bound to and everything inside them. Null
 * means every group.
 */
export async function visibleGroupIds(
  database: Queryable,
  access: Access,
  person: Person,
): Promise<Set<string> | null> {
  if (mayReadAudit(access)) {
    return null;
  }
  return groupIdsFromBindings(database, person.id, null);
}

/**
 * The groups whose members and bindings a person may manage: all of them for
 * an Administrator; otherwise the groups they lead and everything inside them.
 * Null means every group.
 */
export async function managedGroupIds(
  database: Queryable,
  access: Access,
  person: Person,
): Promise<Set<string> | null> {
  if (isAdministrator(access)) {
    return null;
  }
  return groupIdsFromBindings(database, person.id, "Group lead");
}
