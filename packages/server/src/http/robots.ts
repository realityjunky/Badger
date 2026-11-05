import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import {
  requireRobotSession,
  listPersonalRobots,
  savePersonalRobot,
  deletePersonalRobot,
  testPersonalRobot,
  robotRouteOptions,
  saveRobotRoute,
  deleteRobotRoute,
  publicRoute,
  suspendPersonalRobot,
  type RobotRouteRow,
  type PersonalRobotRow,
} from "../notifications/robots.js";
import { isAdministrator } from "../authorization.js";
import { RequestError } from "./errors.js";
import { toIsoString } from "../util.js";
import { readWorkflow } from "../workflows.js";
import { workflowCapabilities } from "../workflow-access.js";

const ROBOT = /^\/api\/v1\/me\/robots\/([^/]+)(\/test)?$/u;
const ROUTE = /^\/api\/v1\/me\/robot-routes\/([^/]+)$/u;
const ADMIN = /^\/api\/v1\/admin\/robots\/([^/]+)$/u;

export function robotMethods(path: string): string | null {
  if (path === "/api/v1/me/robots" || path === "/api/v1/me/robot-routes")
    return "GET, HEAD, POST";
  if (path === "/api/v1/me/robot-deliveries" || path === "/api/v1/admin/robots")
    return "GET, HEAD";
  const robot = ROBOT.exec(path);
  if (robot !== null) return robot[2] ? "POST" : "PUT, DELETE";
  if (ROUTE.test(path)) return "PUT, DELETE";
  if (ADMIN.test(path)) return "PUT";
  return null;
}

export async function handleRobots(input: AuthorizedRequest) {
  requireRobotSession(input);
  const reads = input.method === "GET" || input.method === "HEAD";
  if (input.path === "/api/v1/me/robots" && reads)
    return input.reply.json(200, await listPersonalRobots(input));
  if (input.path === "/api/v1/me/robot-routes" && reads) {
    const rows = await input.database.query<RobotRouteRow>(
      "select * from personal_robot_routes where person_id=$1 order by event,scope_type,scope_id",
      [input.person.id],
    );
    return input.reply.json(200, {
      routes: rows.rows.map(publicRoute),
      ...(await robotRouteOptions(input)),
    });
  }
  if (input.path === "/api/v1/me/robot-deliveries") {
    const rows = (
      await input.database.query<{
        id: string;
        workflow_id: string | null;
        robot_label: string;
        recipients: { name: string; count: number; mention: "name" }[];
        content: { text: { content: string } };
        status: string;
        attempts: number;
        error: string | null;
        created_at: Date | string;
      }>(
        "select id,workflow_id,robot_label,recipients,content,status,attempts,error,created_at from notification_deliveries where person_id=$1 order by created_at desc,id desc limit 100",
        [input.person.id],
      )
    ).rows;
    const deliveries = [];
    for (const row of rows) {
      if (row.workflow_id !== null) {
        const workflow = await readWorkflow(input.database, row.workflow_id);
        if (
          workflow === null ||
          !(
            await workflowCapabilities(
              input.database,
              input.access,
              input.person,
              workflow,
            )
          ).read
        )
          continue;
      }
      deliveries.push({
        id: row.id,
        robotLabel: row.robot_label,
        recipients: row.recipients.map(({ name, count, mention }) => ({
          name,
          count,
          mention,
        })),
        content: { text: { content: row.content.text.content } },
        status: row.status,
        attempts: row.attempts,
        error: row.error,
        createdAt: toIsoString(row.created_at),
      });
    }
    return input.reply.json(200, { deliveries });
  }
  if (input.path === "/api/v1/admin/robots") {
    if (!isAdministrator(input.access))
      throw new RequestError(
        403,
        "Only Administrators may read robot oversight",
      );
    const rows = await input.database.query<
      Pick<PersonalRobotRow, "id" | "label" | "revision" | "suspended"> & {
        owner_name: string;
      }
    >(
      "select r.id,r.label,r.revision,r.suspended,p.display_name as owner_name from personal_robots r join people p on p.id=r.person_id order by p.display_name,r.label,r.id",
    );
    return input.reply.json(200, {
      robots: rows.rows.map((row) => ({
        id: row.id,
        label: row.label,
        revision: row.revision,
        suspended: row.suspended,
        ownerName: row.owner_name,
      })),
    });
  }
  const parsed = await readJsonBody(input.request);
  if (!parsed.ok)
    return input.reply.error(parsed.status ?? 400, "invalid", parsed.message);
  if (input.path === "/api/v1/me/robots")
    return input.reply.json(
      201,
      await savePersonalRobot(input, null, parsed.value),
    );
  if (input.path === "/api/v1/me/robot-routes")
    return input.reply.json(
      201,
      await saveRobotRoute(input, null, parsed.value),
    );
  const robot = ROBOT.exec(input.path);
  if (robot !== null) {
    const id = decodeURIComponent(robot[1]);
    return input.reply.json(
      200,
      robot[2]
        ? await testPersonalRobot(input, id, parsed.value)
        : input.method === "DELETE"
          ? await deletePersonalRobot(input, id, parsed.value)
          : await savePersonalRobot(input, id, parsed.value),
    );
  }
  const route = ROUTE.exec(input.path);
  if (route !== null)
    return input.reply.json(
      200,
      input.method === "DELETE"
        ? await deleteRobotRoute(
            input,
            decodeURIComponent(route[1]),
            parsed.value,
          )
        : await saveRobotRoute(
            input,
            decodeURIComponent(route[1]),
            parsed.value,
          ),
    );
  const admin = ADMIN.exec(input.path)!;
  return input.reply.json(
    200,
    await suspendPersonalRobot(
      input,
      decodeURIComponent(admin[1]),
      parsed.value,
    ),
  );
}
