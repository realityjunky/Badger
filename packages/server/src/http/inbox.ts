import {
  decodeInboxCursor,
  listInbox,
  markInboxItem,
  type InboxState,
} from "../inbox.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput } from "./errors.js";

const ROOT = "/api/v1/me/inbox";
const ITEM = /^\/api\/v1\/me\/inbox\/([^/]+)$/u;

function validTimestamp(value: string): boolean {
  return (
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).getUTCFullYear() > 0 &&
    new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
      .toISOString()
      .slice(0, 10) === value.slice(0, 10)
  );
}

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
    const workflowIds = url.searchParams.getAll("workflowId");
    const states = url.searchParams.getAll("state");
    const createdFrom = url.searchParams.get("createdFrom");
    const createdBefore = url.searchParams.get("createdBefore");
    if (
      workflowIds.some((id) => id.trim().length === 0) ||
      states.some((state) => !["unread", "read", "done"].includes(state)) ||
      [createdFrom, createdBefore].some(
        (date) => date !== null && !validTimestamp(date),
      ) ||
      (createdFrom !== null &&
        createdBefore !== null &&
        Date.parse(createdFrom) >= Date.parse(createdBefore))
    )
      return reply.error(
        400,
        "invalid",
        "Use workflow IDs, states unread, read or done, and increasing ISO 8601 timestamps with time zones",
      );
    return reply.json(
      200,
      await listInbox(database, access, person, limit, after, {
        workflowIds,
        states: states as InboxState[],
        createdFrom:
          createdFrom === null ? null : new Date(createdFrom).toISOString(),
        createdBefore:
          createdBefore === null ? null : new Date(createdBefore).toISOString(),
      }),
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
