import { isAdministrator, type Access } from "../authorization.js";
import type { Queryable } from "../database/database.js";
import type { Person } from "../people.js";

/** Shared by questionnaire views and the MCP's discovery endpoint. */
export async function questionnaireCapabilities(
  database: Queryable,
  access: Access,
  person: Person,
  workflowId: string | null,
) {
  const grants = await database.query<{ role: string }>(
    "select role from role_bindings where scope_type = 'workflow' and person_id = $1 and ($2::text is null or workflow_id = $2)",
    [person.id, workflowId],
  );
  const roles = new Set(grants.rows.map((grant) => grant.role));
  const administrator = isAdministrator(access);
  const expertScope =
    access.tokenScopes === undefined || access.tokenScopes.includes("expert");
  const compose =
    (administrator || roles.has("Engineer")) &&
    (access.tokenScopes === undefined ||
      access.tokenScopes.includes("engineer"));
  return {
    compose,
    reviewSuggestions:
      access.tokenScopes === undefined &&
      (administrator || roles.has("Engineer") || roles.has("Field expert")),
    answer:
      expertScope && (roles.has("Field expert") || roles.has("Workflow owner")),
    comment:
      (administrator || [...roles].some((role) => role !== "Observer")) &&
      (access.tokenScopes === undefined ||
        access.tokenScopes.includes("expert") ||
        access.tokenScopes.includes("engineer")),
    raiseConcern: expertScope && (administrator || roles.has("Field expert")),
    resolveConcern: compose && access.tokenScopes === undefined,
    resolve: compose && access.tokenScopes === undefined,
    acknowledge:
      access.tokenScopes === undefined &&
      (roles.has("Field expert") || roles.has("Workflow owner")),
  };
}
