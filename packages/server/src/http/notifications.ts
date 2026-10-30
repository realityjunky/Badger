import {
  mayManageChannel,
  maskedChannel,
  readChannel,
  saveChannel,
  deleteChannel,
  workflowChannel,
} from "../notifications/channels.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { RequestError } from "./errors.js";
import {
  NOTIFICATION_EVENTS,
  readNotificationPreferences,
  saveNotificationPreferences,
} from "../notifications/preferences.js";
import { listWaiting, remind } from "../notifications/reminders.js";

const CHANNEL =
  /^\/api\/v1\/(workflows|groups)\/([^/]+)\/notifications\/channel$/u;
const DELIVERIES =
  /^\/api\/v1\/workflows\/([^/]+)\/notifications\/deliveries$/u;
const WAITING =
  /^\/api\/v1\/workflows\/([^/]+)\/notifications\/(waiting|remind)$/u;
export function notificationMethods(path: string): string | null {
  const waiting = WAITING.exec(path);
  if (waiting !== null) return waiting[2] === "waiting" ? "GET, HEAD" : "POST";
  if (DELIVERIES.test(path)) return "GET, HEAD";
  if (path === "/api/v1/me/notifications") return "GET, HEAD, PUT";
  return CHANNEL.test(path) ? "GET, HEAD, PUT, DELETE" : null;
}

export async function handleNotifications(
  input: AuthorizedRequest,
): Promise<void> {
  const waiting = WAITING.exec(input.path);
  if (waiting !== null) {
    const id = decodeURIComponent(waiting[1]);
    if (waiting[2] === "waiting")
      return input.reply.json(200, await listWaiting(input, id));
    const body = await readJsonBody(input.request);
    if (!body.ok)
      return input.reply.error(body.status ?? 400, "invalid", body.message);
    return input.reply.json(200, await remind(input, id, body.value));
  }
  const deliveries = DELIVERIES.exec(input.path);
  if (deliveries !== null) {
    const id = decodeURIComponent(deliveries[1]);
    if (!(await mayManageChannel(input, { type: "workflow", id })))
      throw new RequestError(
        403,
        "Only the Workflow owner and Administrators may read deliveries",
      );
    const rows = await input.database.query(
      `select id, robot_label as "robotLabel", recipients, content, status, attempts, error,
      created_at as "createdAt", sent_at as "sentAt" from notification_deliveries where workflow_id = $1 order by created_at desc, id desc limit 100`,
      [id],
    );
    return input.reply.json(200, { deliveries: rows.rows });
  }
  if (input.path === "/api/v1/me/notifications") {
    if (input.method === "GET" || input.method === "HEAD")
      return input.reply.json(200, {
        preferences: await readNotificationPreferences(
          input.database,
          input.person.id,
        ),
        events: NOTIFICATION_EVENTS,
      });
    const body = await readJsonBody(input.request);
    if (!body.ok)
      return input.reply.error(body.status ?? 400, "invalid", body.message);
    return input.reply.json(
      200,
      await saveNotificationPreferences(input, body.value),
    );
  }
  const match = CHANNEL.exec(input.path)!;
  const scope = {
    type: match[1] === "groups" ? ("group" as const) : ("workflow" as const),
    id: decodeURIComponent(match[2]),
  };
  if (!(await mayManageChannel(input, scope)))
    throw new RequestError(
      403,
      "Only the Workflow owner, Group lead, or an Administrator may manage this robot",
    );
  if (input.method === "GET" || input.method === "HEAD") {
    const own = await readChannel(input.database, scope);
    return input.reply.json(200, {
      channel: maskedChannel(own),
      inheritedChannel:
        scope.type === "workflow" && own === undefined
          ? maskedChannel(await workflowChannel(input.database, scope.id))
          : null,
    });
  }
  const body = await readJsonBody(input.request);
  if (!body.ok)
    return input.reply.error(body.status ?? 400, "invalid", body.message);
  return input.reply.json(
    200,
    input.method === "DELETE"
      ? await deleteChannel(input, scope, body.value)
      : await saveChannel(input, scope, body.value),
  );
}
