import type { ServiceConfig } from "./config.js";
import type { Queryable } from "./database/database.js";
import { withAncestors, withDescendants } from "./group-tree.js";
import { LOCAL_IDENTITY_ISSUER } from "./identity/local.js";
import type { Principal } from "./identity/identity.js";
import type { Person } from "./people.js";

export type OrganizationRole = "Administrator" | "Auditor";
export type GroupRole = "Group lead" | "Member";
export type ScopeType = "organization" | "group" | "workflow";

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

/** Administrators and Auditors read everything, the Activity log included. */
export function readsEverything(access: Access): boolean {
  return (
    access.organization.includes("Administrator") ||
    access.organization.includes("Auditor")
  );
}

/**
 * The records a person may read: everything, or only those of the listed
 * groups. The Organization's own bindings are in view only with everything.
 */
export type Visibility =
  | { everything: true }
  | {
      everything: false;
      groupIds: ReadonlySet<string>;
      workflowGroupIds?: ReadonlySet<string>;
    };

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
 * mode's implicit one, or an address the deployment lists. A listed address
 * counts only when the provider verified it, as for any binding by email.
 */
export function configuredAdministratorFor(
  person: Pick<Person, "email" | "emailVerified" | "issuer" | "subject">,
  config: ServiceConfig,
): boolean {
  if (
    config.identity.kind === "local" &&
    person.issuer === LOCAL_IDENTITY_ISSUER &&
    person.subject === config.identity.administrator.subject
  ) {
    return true;
  }
  return (
    person.emailVerified &&
    config.bootstrapAdministrators.includes(person.email.toLowerCase())
  );
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
  const ids = await withAncestors(database, [groupId]);
  if (ids.size === 0) {
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
    [person.id, [...ids], roles],
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
  const rows = await database.query<{ scope_id: string }>(
    `select scope_id
       from role_bindings
      where scope_type = 'group'
        and person_id = $1
        and ($2::text is null or role = $2)`,
    [personId, role],
  );
  return withDescendants(
    database,
    rows.rows.map((row) => row.scope_id),
  );
}

/**
 * The groups a person may see: all of them for an Administrator or Auditor;
 * otherwise the groups they are bound to and everything inside them.
 */
export async function visibleGroups(
  database: Queryable,
  access: Access,
  person: Person,
): Promise<Visibility> {
  if (readsEverything(access)) {
    return { everything: true };
  }
  return {
    everything: false,
    groupIds: await groupIdsFromBindings(database, person.id, null),
  };
}

/**
 * What a person may read of members and pending invitations: everything for
 * an Administrator or Auditor; for a Group lead, the groups they lead, those
 * inside them, and those above them, since a binding above a led group
 * reaches into it. Null for a person who leads no group.
 */
export async function managementVisibility(
  database: Queryable,
  access: Access,
  person: Person,
): Promise<Visibility | null> {
  if (readsEverything(access)) {
    return { everything: true };
  }
  const led = await groupIdsFromBindings(database, person.id, "Group lead");
  if (led.size === 0) {
    return null;
  }
  return {
    everything: false,
    groupIds: await withAncestors(database, led),
    workflowGroupIds: led,
  };
}
