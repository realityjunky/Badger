import { createHash, randomBytes } from "node:crypto";
import { recordAudit } from "../audit.js";
import { isAdministrator, visibleGroups } from "../authorization.js";
import type { Queryable } from "../database/database.js";
import type { AuthorizedRequest } from "../http/authorized-request.js";
import { objectInput, RequestError } from "../http/errors.js";
import { listWorkflows } from "../workflows.js";
import { toIsoString } from "../util.js";
import { missingNotificationSettings } from "./channels.js";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "./preferences.js";
import {
  decryptTarget,
  encryptTarget,
  targetBotKey,
  targetRobotKey,
  validateLongConnection,
} from "./secrets.js";

export interface PersonalRobotRow {
  id: string;
  person_id: string;
  label: string;
  language: "en" | "zh";
  enabled: boolean;
  suspended: boolean;
  replies_enabled: boolean;
  target_ciphertext: string;
  bot_key: string;
  robot_key: string;
  revision: number;
  verified_at: Date | string | null;
  verification_hash: string | null;
  verification_expires_at: Date | string | null;
  connection_state: "connecting" | "connected" | "disconnected" | "error";
  connection_checked_at: Date | string | null;
}

export interface RobotRouteRow {
  id: string;
  person_id: string;
  event: NotificationEvent;
  scope_type: "all" | "group" | "workflow";
  scope_id: string;
  robot_id: string | null;
  revision: number;
}

export function requireRobotSession(input: AuthorizedRequest): void {
  if (input.access.tokenScopes !== undefined)
    throw new RequestError(403, "Robot management requires a signed-in person");
}

export function publicRobot(row: PersonalRobotRow, now: Date) {
  return {
    id: row.id,
    label: row.label,
    language: row.language,
    enabled: row.enabled,
    suspended: row.suspended,
    repliesEnabled: row.replies_enabled,
    revision: row.revision,
    verified: row.verified_at !== null,
    connectionState:
      !row.enabled ||
      row.suspended ||
      row.connection_checked_at === null ||
      now.getTime() - new Date(row.connection_checked_at).getTime() > 30_000
        ? "disconnected"
        : row.connection_state,
    connectionCheckedAt:
      row.connection_checked_at === null
        ? null
        : toIsoString(row.connection_checked_at),
    botId: "••••••••",
    botSecret: "••••••••",
    recipientUserId: "••••••••",
  };
}

export async function ownedRobot(tx: Queryable, personId: string, id: string) {
  const row = (
    await tx.query<PersonalRobotRow>(
      "select * from personal_robots where id = $1 and person_id = $2",
      [id, personId],
    )
  ).rows[0];
  if (row === undefined) throw new RequestError(404, "No such personal robot");
  return row;
}

async function cancelPersonalPosts(tx: Queryable, personId: string) {
  await tx.query(
    "update notification_deliveries set status = 'cancelled' where person_id = $1 and status in ('queued','retry')",
    [personId],
  );
}

function confirmRevision(body: Record<string, unknown>, revision: number) {
  if (body.confirmed !== true)
    throw new RequestError(400, "Confirm this robot settings change");
  if (body.revision !== revision)
    throw new RequestError(409, "Robot settings changed; reload before saving");
}

export function verificationHash(command: string) {
  return createHash("sha256").update(command).digest("hex");
}

async function auditRobot(
  input: AuthorizedRequest,
  tx: Queryable,
  action: string,
  id: string,
  before: number | null,
  after: number | null,
) {
  await recordAudit(tx, input.dependencies, {
    actor: { personId: input.person.id, credential: input.context.credential },
    channel: input.context.channel,
    action,
    target: { type: "personal_robot", id },
    before: before === null ? null : { revision: before, hash: null },
    after: after === null ? null : { revision: after, hash: null },
    reason: "Personal robot settings changed",
    requestId: input.context.requestId,
  });
}

export async function listPersonalRobots(input: AuthorizedRequest) {
  requireRobotSession(input);
  const rows = await input.database.query<PersonalRobotRow>(
    "select * from personal_robots where person_id = $1 order by created_at, id",
    [input.person.id],
  );
  return {
    robots: rows.rows.map((row) =>
      publicRobot(row, input.dependencies.clock.now()),
    ),
    missingSettings: missingNotificationSettings(input.config),
  };
}

export async function savePersonalRobot(
  input: AuthorizedRequest,
  id: string | null,
  value: unknown,
) {
  requireRobotSession(input);
  const body = objectInput(value);
  const missing = missingNotificationSettings(input.config);
  if (missing.length > 0)
    throw new RequestError(
      409,
      `This deployment must set ${missing.join(" and ")} before a robot can be saved`,
    );
  if (
    typeof body.label !== "string" ||
    !body.label.trim() ||
    body.label.length > 80 ||
    !["en", "zh"].includes(body.language as string) ||
    typeof body.enabled !== "boolean" ||
    typeof body.repliesEnabled !== "boolean"
  )
    throw new RequestError(
      400,
      "Provide a label up to 80 characters, language en or zh, enabled, and repliesEnabled",
    );
  return input.database.transaction(async (tx) => {
    await tx.query("select id from people where id = $1 for update", [
      input.person.id,
    ]);
    const current =
      id === null ? undefined : await ownedRobot(tx, input.person.id, id);
    confirmRevision(body, current?.revision ?? 0);
    const key = input.config.notifications.encryptionKey!;
    let previous;
    if (
      current !== undefined &&
      [body.botId, body.botSecret, body.recipientUserId].some(
        (field) => field === undefined,
      )
    ) {
      try {
        previous = decryptTarget(
          current.target_ciphertext,
          "long-connection",
          key,
        );
      } catch {
        throw new RequestError(
          409,
          "Saved credentials cannot be decrypted; enter all three credential fields again",
        );
      }
    }
    const target = validateLongConnection({
      botId:
        body.botId === undefined && previous?.transport === "long-connection"
          ? previous.botId
          : body.botId,
      botSecret:
        body.botSecret === undefined &&
        previous?.transport === "long-connection"
          ? previous.botSecret
          : body.botSecret,
      recipientUserId:
        body.recipientUserId === undefined &&
        previous?.transport === "long-connection"
          ? previous.recipientUserId
          : body.recipientUserId,
    });
    const botKey = targetBotKey(target, key)!;
    const robotKey = targetRobotKey(target, key);
    const duplicate = await tx.query(
      "select 1 from personal_robots where bot_key = $1 and id <> $2",
      [botKey, id ?? ""],
    );
    if (duplicate.rows.length > 0)
      throw new RequestError(
        409,
        "This robot is already registered; use a different WeCom robot",
      );
    const needsLink =
      current === undefined ||
      current.robot_key !== robotKey ||
      current.verified_at === null;
    const command = needsLink
      ? `link ${randomBytes(12).toString("hex")}`
      : null;
    const now = input.dependencies.clock.now();
    const robotId = id ?? input.dependencies.ids.next();
    const row = (
      await tx.query<PersonalRobotRow>(
        `insert into personal_robots (id, person_id, label, language, enabled, replies_enabled, target_ciphertext, bot_key, robot_key, revision, verified_at, verification_hash, verification_expires_at, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      on conflict (id) do update set label=excluded.label, language=excluded.language, enabled=excluded.enabled, replies_enabled=excluded.replies_enabled,
        target_ciphertext=excluded.target_ciphertext, bot_key=excluded.bot_key, robot_key=excluded.robot_key, revision=excluded.revision, verified_at=excluded.verified_at,
        verification_hash=excluded.verification_hash, verification_expires_at=excluded.verification_expires_at, connection_state='disconnected', connection_checked_at=null, updated_at=excluded.updated_at returning *`,
        [
          robotId,
          input.person.id,
          (body.label as string).trim(),
          body.language,
          body.enabled,
          body.repliesEnabled,
          encryptTarget(target, key),
          botKey,
          robotKey,
          (current?.revision ?? 0) + 1,
          needsLink ? null : current!.verified_at,
          command === null ? null : verificationHash(command),
          command === null ? null : new Date(now.getTime() + 600_000),
          now,
        ],
      )
    ).rows[0]!;
    await cancelPersonalPosts(tx, input.person.id);
    await auditRobot(
      input,
      tx,
      "personal_robot.saved",
      robotId,
      current?.revision ?? null,
      row.revision,
    );
    return {
      robot: publicRobot(row, now),
      linkCommand: command,
      linkExpiresAt:
        command === null
          ? null
          : new Date(now.getTime() + 600_000).toISOString(),
    };
  });
}

export async function deletePersonalRobot(
  input: AuthorizedRequest,
  id: string,
  value: unknown,
) {
  requireRobotSession(input);
  return input.database.transaction(async (tx) => {
    await tx.query("select id from people where id = $1 for update", [
      input.person.id,
    ]);
    const current = await ownedRobot(tx, input.person.id, id);
    confirmRevision(objectInput(value), current.revision);
    await cancelPersonalPosts(tx, input.person.id);
    await tx.query(
      "update personal_robot_routes set revision = revision + 1 where robot_id = $1",
      [id],
    );
    await tx.query("delete from personal_robots where id = $1", [id]);
    await auditRobot(
      input,
      tx,
      "personal_robot.removed",
      id,
      current.revision,
      null,
    );
    return { removed: true };
  });
}

export async function testPersonalRobot(
  input: AuthorizedRequest,
  id: string,
  value: unknown,
) {
  requireRobotSession(input);
  return input.database.transaction(async (tx) => {
    await tx.query("select id from people where id = $1 for update", [
      input.person.id,
    ]);
    const row = await ownedRobot(tx, input.person.id, id);
    confirmRevision(objectInput(value), row.revision);
    if (!row.enabled || row.suspended || row.verified_at === null)
      throw new RequestError(
        409,
        "Enable and link this robot before sending a test",
      );
    const deliveryId = input.dependencies.ids.next();
    await tx.query(
      `insert into notification_deliveries (id, channel_id, robot_key, robot_label, target_ciphertext, transport, bot_key, person_id, personal_robot_id, recipients, content, available_at, created_at)
      values ($1,$2,$3,$4,$5,'long-connection',$6,$7,$2,'[]',$8,$9,$9)`,
      [
        deliveryId,
        id,
        row.robot_key,
        row.label,
        row.target_ciphertext,
        row.bot_key,
        input.person.id,
        JSON.stringify({
          msgtype: "text",
          text: {
            content:
              row.language === "zh"
                ? "Badger：个人机器人连接测试。"
                : "Badger: personal robot connection test.",
            mentioned_list: [],
            mentioned_mobile_list: [],
          },
        }),
        input.dependencies.clock.now(),
      ],
    );
    await auditRobot(
      input,
      tx,
      "personal_robot.test_queued",
      id,
      row.revision,
      row.revision,
    );
    return { deliveryId };
  });
}

export async function robotRouteOptions(input: AuthorizedRequest) {
  requireRobotSession(input);
  const workflows = await listWorkflows(
    input.database,
    input.access,
    input.person,
  );
  const visibility = await visibleGroups(
    input.database,
    input.access,
    input.person,
  );
  const groups = (
    await input.database.query<{ id: string; name: string }>(
      "select id,name from groups order by name,id",
    )
  ).rows.filter(
    (group) =>
      visibility.everything ||
      visibility.groupIds.has(group.id) ||
      workflows.some((workflow) => workflow.groupId === group.id),
  );
  return {
    workflows: workflows.map(({ id, name }) => ({ id, name })),
    groups,
    events: NOTIFICATION_EVENTS,
  };
}

export function publicRoute(row: RobotRouteRow) {
  return {
    id: row.id,
    event: row.event,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    robotId: row.robot_id,
    revision: row.revision,
  };
}

export async function saveRobotRoute(
  input: AuthorizedRequest,
  id: string | null,
  value: unknown,
) {
  requireRobotSession(input);
  const body = objectInput(value);
  const events = Array.isArray(body.events)
    ? body.events
    : body.event === undefined
      ? []
      : [body.event];
  if (
    events.length === 0 ||
    events.some(
      (event) => !NOTIFICATION_EVENTS.includes(event as NotificationEvent),
    ) ||
    new Set(events).size !== events.length ||
    (id !== null && events.length !== 1) ||
    !["all", "group", "workflow"].includes(body.scopeType as string) ||
    typeof body.scopeId !== "string" ||
    !(body.robotId === null || typeof body.robotId === "string")
  )
    throw new RequestError(
      400,
      "Choose one or more distinct events, a scope, and a personal robot or inbox only",
    );
  const options = await robotRouteOptions(input);
  if (
    (body.scopeType === "all" && body.scopeId !== "") ||
    (body.scopeType === "group" &&
      !options.groups.some((group) => group.id === body.scopeId)) ||
    (body.scopeType === "workflow" &&
      !options.workflows.some((workflow) => workflow.id === body.scopeId))
  )
    throw new RequestError(403, "Choose a scope you can currently access");
  return input.database.transaction(async (tx) => {
    await tx.query("select id from people where id = $1 for update", [
      input.person.id,
    ]);
    const current =
      id === null
        ? undefined
        : (
            await tx.query<RobotRouteRow>(
              "select * from personal_robot_routes where id=$1 and person_id=$2",
              [id, input.person.id],
            )
          ).rows[0];
    if (id !== null && current === undefined)
      throw new RequestError(404, "No such personal route");
    confirmRevision(body, current?.revision ?? 0);
    if (body.robotId !== null)
      await ownedRobot(tx, input.person.id, body.robotId as string);
    const duplicate = await tx.query<{ event: NotificationEvent }>(
      "select event from personal_robot_routes where person_id=$1 and event=any($2::text[]) and scope_type=$3 and scope_id=$4 and id<>$5",
      [input.person.id, events, body.scopeType, body.scopeId, id ?? ""],
    );
    if (duplicate.rows.length > 0)
      throw new RequestError(
        409,
        `A route already exists for ${duplicate.rows
          .map(({ event }) => event)
          .join(", ")} in this scope; edit that route`,
      );
    const routes: RobotRouteRow[] = [];
    for (const event of events as NotificationEvent[]) {
      const routeId = id ?? input.dependencies.ids.next();
      const route = (
        await tx.query<RobotRouteRow>(
          `insert into personal_robot_routes (id,person_id,event,scope_type,scope_id,robot_id,revision) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set event=excluded.event, scope_type=excluded.scope_type, scope_id=excluded.scope_id, robot_id=excluded.robot_id, revision=excluded.revision returning *`,
          [
            routeId,
            input.person.id,
            event,
            body.scopeType,
            body.scopeId,
            body.robotId,
            (current?.revision ?? 0) + 1,
          ],
        )
      ).rows[0]!;
      routes.push(route);
    }
    await cancelPersonalPosts(tx, input.person.id);
    for (const route of routes)
      await auditRobot(
        input,
        tx,
        "personal_robot.route_saved",
        route.id,
        current?.revision ?? null,
        route.revision,
      );
    return id === null
      ? { routes: routes.map(publicRoute) }
      : { route: publicRoute(routes[0]!) };
  });
}

export async function deleteRobotRoute(
  input: AuthorizedRequest,
  id: string,
  value: unknown,
) {
  requireRobotSession(input);
  return input.database.transaction(async (tx) => {
    await tx.query("select id from people where id=$1 for update", [
      input.person.id,
    ]);
    const row = (
      await tx.query<RobotRouteRow>(
        "select * from personal_robot_routes where id=$1 and person_id=$2",
        [id, input.person.id],
      )
    ).rows[0];
    if (row === undefined)
      throw new RequestError(404, "No such personal route");
    confirmRevision(objectInput(value), row.revision);
    await tx.query("delete from personal_robot_routes where id=$1", [id]);
    await cancelPersonalPosts(tx, input.person.id);
    await auditRobot(
      input,
      tx,
      "personal_robot.route_removed",
      id,
      row.revision,
      null,
    );
    return { removed: true };
  });
}

export async function suspendPersonalRobot(
  input: AuthorizedRequest,
  id: string,
  value: unknown,
) {
  requireRobotSession(input);
  if (!isAdministrator(input.access))
    throw new RequestError(403, "Only Administrators may suspend robots");
  const body = objectInput(value);
  if (typeof body.suspended !== "boolean")
    throw new RequestError(400, "Provide suspended true or false");
  return input.database.transaction(async (tx) => {
    const row = (
      await tx.query<PersonalRobotRow>(
        "select * from personal_robots where id=$1 for update",
        [id],
      )
    ).rows[0];
    if (row === undefined)
      throw new RequestError(404, "No such personal robot");
    confirmRevision(body, row.revision);
    await tx.query(
      "update personal_robots set suspended=$2, revision=revision+1 where id=$1",
      [id, body.suspended],
    );
    await cancelPersonalPosts(tx, row.person_id);
    await auditRobot(
      input,
      tx,
      "personal_robot.suspension_changed",
      id,
      row.revision,
      row.revision + 1,
    );
    return { updated: true };
  });
}
