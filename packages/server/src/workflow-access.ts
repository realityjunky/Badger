import {
  isAdministrator,
  mayManageGroup,
  visibleGroups,
  type Access,
  type ScopeType,
} from "./authorization.js";
import type { Queryable } from "./database/database.js";
import type { Person } from "./people.js";

export const WORKFLOW_ROLES = [
  "Workflow owner",
  "Engineer",
  "Field expert",
  "Reviewer",
  "Operator",
  "Observer",
] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export function isWorkflowRole(value: string): value is WorkflowRole {
  return (WORKFLOW_ROLES as readonly string[]).includes(value);
}

/** Capabilities for the workflow catalog, versions, and role bindings. */
export interface WorkflowCapabilities {
  read: boolean;
  editWorkflow: boolean;
  manageRoles: boolean;
  createVersion: boolean;
  managePins: boolean;
  confirmSources: boolean;
  manageSourceStudy: boolean;
  composeDossier: boolean;
  approveDossier: boolean;
}

/** Every workflow role reads; only the responsible roles may write. */
export async function workflowCapabilities(
  database: Queryable,
  access: Access,
  person: Person,
  workflow: { id: string; groupId: string },
): Promise<WorkflowCapabilities> {
  const grants = await database.query<{ role: WorkflowRole }>(
    `select role from role_bindings where scope_type = 'workflow'
       and workflow_id = $1 and person_id = $2`,
    [workflow.id, person.id],
  );
  const roles = new Set(grants.rows.map((row) => row.role));
  const managesGroup = await mayManageGroup(
    database,
    access,
    person,
    workflow.groupId,
  );
  const owner = roles.has("Workflow owner");
  const engineer = isAdministrator(access) || roles.has("Engineer");
  const visibility = await visibleGroups(database, access, person);
  return {
    read:
      visibility.everything ||
      visibility.groupIds.has(workflow.groupId) ||
      roles.size > 0,
    editWorkflow: access.tokenScopes === undefined && (managesGroup || owner),
    manageRoles: access.tokenScopes === undefined && (managesGroup || owner),
    createVersion:
      (access.tokenScopes === undefined ||
        access.tokenScopes.includes("engineer")) &&
      engineer,
    managePins: access.tokenScopes === undefined && engineer,
    confirmSources: access.tokenScopes === undefined && engineer,
    manageSourceStudy: access.tokenScopes === undefined && engineer,
    composeDossier: access.tokenScopes === undefined && engineer,
    approveDossier:
      access.tokenScopes === undefined && (isAdministrator(access) || owner),
  };
}

/** Organization and Group bindings keep their existing scope rules. */
export async function mayManageRoleScope(
  database: Queryable,
  access: Access,
  person: Person,
  scope: { scopeType: ScopeType; scopeId: string | null },
): Promise<boolean> {
  if (scope.scopeType === "organization") return isAdministrator(access);
  if (scope.scopeId === null) return false;
  if (scope.scopeType === "group")
    return mayManageGroup(database, access, person, scope.scopeId);
  const rows = await database.query<{ group_id: string }>(
    `select group_id from workflows where id = $1`,
    [scope.scopeId],
  );
  const row = rows.rows[0];
  return (
    row !== undefined &&
    (
      await workflowCapabilities(database, access, person, {
        id: scope.scopeId,
        groupId: row.group_id,
      })
    ).manageRoles
  );
}
