import { decodeInboxCursor, listInbox, markInboxItem } from "../inbox.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput } from "./errors.js";

const ROOT = "/api/v1/me/inbox";
const ITEM = /^\/api\/v1\/me\/inbox\/([^/]+)$/u;
export function inboxMethods(path: string): string | null {
  return path === ROOT ? "GET, HEAD" : ITEM.test(path) ? "PATCH" : null;
}

export async function handleInbox(input: AuthorizedRequest): Promise<void> {
  const {
    path,
    method,
    reply,
    database,
    access,
    person,
    url,
    request,
    dependencies,
    context,
  } = input;
  const methods = inboxMethods(path)!;
  if (!methods.split(", ").includes(method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  if (path === ROOT) {
    const limit = url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : 50;
    const raw = url.searchParams.get("cursor");
    const after = raw === null ? null : decodeInboxCursor(raw);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (raw !== null && after === null)
    )
      return reply.error(
        400,
        "invalid",
        "Use a limit from 1 to 200 and a cursor issued by this service",
      );
    return reply.json(
      200,
      await listInbox(database, access, person, limit, after),
    );
  }
  const body = await readJsonBody(request);
  if (!body.ok) return reply.error(400, "invalid", body.message);
  const value = objectInput(body.value);
  if (
    Object.keys(value).some((key) => !["state", "revision"].includes(key)) ||
    (value.state !== "read" && value.state !== "unread") ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 1
  )
    return reply.error(
      400,
      "invalid",
      "Quote the item's revision and state read or unread; done is set when its gate closes",
    );
  const result = await markInboxItem(
    database,
    dependencies,
    context,
    access,
    person,
    decodeURIComponent(ITEM.exec(path)![1]),
    value.state,
    value.revision as number,
  );
  if (result.kind === "missing")
    return reply.error(404, "invalid", "No such inbox item");
  if (result.kind === "conflict")
    return reply.json(409, {
      error: { code: "conflict", message: "The inbox item changed or is done" },
      item: result.item,
      requestId: reply.requestId,
    });
  return reply.json(200, { item: result.item });
}
