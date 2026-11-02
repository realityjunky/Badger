import { isGroupRole } from "../authorization.js";
import { changeGroupRole, readBindingById } from "../bindings.js";
import { mayManageRoleScope } from "../workflow-access.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

export async function handleGroupRoleChange(
  input: AuthorizedRequest,
): Promise<void> {
  const {
    request,
    reply,
    path,
    database,
    dependencies,
    context,
    access,
    person,
  } = input;
  const id = decodeURIComponent(path.slice("/api/v1/bindings/".length));
  const binding = await readBindingById(database, id);
  if (binding === null) throw new RequestError(404, "No such role binding");
  if (!(await mayManageRoleScope(database, access, person, binding)))
    throw new RequestError(
      403,
      "Only an Administrator or the Group lead changes group roles",
    );
  const body = await readJsonBody(request);
  if (!body.ok) throw new RequestError(400, body.message);
  const value = objectInput(body.value);
  if (
    Object.keys(value).some((key) => !["role", "revision"].includes(key)) ||
    typeof value.role !== "string" ||
    !isGroupRole(value.role) ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 1
  )
    throw new RequestError(
      400,
      "Supply a group role and the binding's positive revision",
    );
  const changed = await changeGroupRole(
    database,
    dependencies,
    context,
    id,
    value.revision as number,
    value.role,
  );
  return reply.json(200, { binding: changed });
}
