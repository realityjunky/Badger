import { recordAudit } from "../audit.js";
import { isAdministrator, mayManageGroup } from "../authorization.js";
import type { Queryable } from "../database/database.js";
import type { AuthorizedRequest } from "../http/authorized-request.js";
import { objectInput, RequestError } from "../http/errors.js";
import { encryptWebhook, robotKey, validateWebhook } from "./secrets.js";

export interface ChannelRow {
  id: string;
  workflow_id: string | null;
  group_id: string | null;
  label: string;
  language: "en" | "zh";
  revision: number;
  robot_key: string;
  webhook_ciphertext: string;
}
export interface ChannelScope {
  type: "group" | "workflow";
  id: string;
}

export function maskedChannel(row: ChannelRow | undefined) {
  return row === undefined
    ? null
    : {
        id: row.id,
        label: row.label,
        language: row.language,
        revision: row.revision,
        webhookUrl: "••••••••",
      };
}

export async function readChannel(
  tx: Queryable,
  scope: ChannelScope,
): Promise<ChannelRow | undefined> {
  return (
    await tx.query<ChannelRow>(
      `select * from notification_channels where ${scope.type === "group" ? "group_id" : "workflow_id"} = $1`,
      [scope.id],
    )
  ).rows[0];
}

/** A workflow override wins; otherwise use its nearest ancestor Group default. */
export async function workflowChannel(
  tx: Queryable,
  workflowId: string,
): Promise<ChannelRow | undefined> {
  const own = await readChannel(tx, { type: "workflow", id: workflowId });
  if (own !== undefined) return own;
  return (
    await tx.query<ChannelRow>(
      `with recursive ancestors as (
    select g.id, g.parent_id, 0 as depth from groups g join workflows w on w.group_id = g.id where w.id = $1
    union all select g.id, g.parent_id, a.depth + 1 from groups g join ancestors a on a.parent_id = g.id
  ) select c.* from ancestors a join notification_channels c on c.group_id = a.id order by a.depth limit 1`,
      [workflowId],
    )
  ).rows[0];
}

export async function mayManageChannel(
  input: AuthorizedRequest,
  scope: ChannelScope,
): Promise<boolean> {
  if (input.access.tokenScopes !== undefined) return false;
  if (isAdministrator(input.access)) return true;
  if (scope.type === "group")
    return mayManageGroup(input.database, input.access, input.person, scope.id);
  return (
    (
      await input.database.query(
        "select 1 from role_bindings where workflow_id = $1 and person_id = $2 and role = 'Workflow owner'",
        [scope.id, input.person.id],
      )
    ).rows.length > 0
  );
}

export async function saveChannel(
  input: AuthorizedRequest,
  scope: ChannelScope,
  value: unknown,
) {
  const body = objectInput(value);
  if (body.confirmed !== true)
    throw new RequestError(
      400,
      "Confirm saving the robot and sending a test post",
    );
  if (
    !Number.isInteger(body.revision) ||
    (body.revision as number) < 0 ||
    typeof body.label !== "string" ||
    body.label.trim().length === 0 ||
    body.label.length > 80 ||
    !["en", "zh"].includes(body.language as string)
  )
    throw new RequestError(
      400,
      "Provide revision, a label up to 80 characters, and language en or zh",
    );
  const key = input.config.notifications.encryptionKey;
  if (key === null || input.config.notifications.publicUrl === null)
    throw new RequestError(
      409,
      "The deployment must configure BADGER_NOTIFICATION_KEY and BADGER_PUBLIC_URL",
    );
  const { database, dependencies: deps, context } = input;
  return database.transaction(async (tx) => {
    // Lock the scope even before its first channel exists.
    const target = await tx.query(
      `select id from ${scope.type === "group" ? "groups" : "workflows"} where id = $1 for update`,
      [scope.id],
    );
    if (target.rows.length === 0)
      throw new RequestError(404, "No such channel scope");
    const current = await readChannel(tx, scope);
    if ((current?.revision ?? 0) !== body.revision)
      throw new RequestError(
        409,
        "The robot settings changed; reload before saving",
      );
    const url =
      body.webhookUrl === undefined && current !== undefined
        ? null
        : validateWebhook(body.webhookUrl);
    const encrypted =
      url === null ? current!.webhook_ciphertext : encryptWebhook(url, key);
    const robot = url === null ? current!.robot_key : robotKey(url, key);
    const id = current?.id ?? deps.ids.next();
    const revision = (current?.revision ?? 0) + 1;
    const channel = (
      await tx.query<ChannelRow>(
        `insert into notification_channels
      (id, scope_type, group_id, workflow_id, label, language, webhook_ciphertext, robot_key, revision, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (id) do update set label = excluded.label, language = excluded.language,
        webhook_ciphertext = excluded.webhook_ciphertext, robot_key = excluded.robot_key,
        revision = excluded.revision, updated_at = excluded.updated_at returning *`,
        [
          id,
          scope.type,
          scope.type === "group" ? scope.id : null,
          scope.type === "workflow" ? scope.id : null,
          (body.label as string).trim(),
          body.language,
          encrypted,
          robot,
          revision,
          deps.clock.now(),
        ],
      )
    ).rows[0]!;
    const testDeliveryId = deps.ids.next();
    const content = {
      msgtype: "text",
      text: {
        content:
          body.language === "zh"
            ? "Badger：群机器人连接测试。"
            : "Badger: group robot connection test.",
        mentioned_list: [],
        mentioned_mobile_list: [],
      },
    };
    await tx.query(
      `insert into notification_deliveries (id, workflow_id, channel_id, robot_key, robot_label,
      webhook_ciphertext, recipients, content, available_at, created_at) values ($1,$2,$3,$4,$5,$6,'[]',$7,$8,$8)`,
      [
        testDeliveryId,
        channel.workflow_id,
        id,
        robot,
        channel.label,
        encrypted,
        JSON.stringify(content),
        deps.clock.now(),
      ],
    );
    await recordAudit(tx, deps, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "notification_channel.saved",
      target: { type: "notification_channel", id, label: channel.label },
      before: current ? { revision: current.revision, hash: null } : null,
      after: { revision, hash: null },
      reason: "Robot settings saved; test post queued",
      requestId: context.requestId,
    });
    return { channel: maskedChannel(channel), testDeliveryId };
  });
}

export async function deleteChannel(
  input: AuthorizedRequest,
  scope: ChannelScope,
  value: unknown,
) {
  const body = objectInput(value);
  if (body.confirmed !== true || !Number.isInteger(body.revision))
    throw new RequestError(400, "Confirm disconnecting the current robot");
  const { dependencies: deps, context } = input;
  return input.database.transaction(async (tx) => {
    await tx.query(
      `select id from ${scope.type === "group" ? "groups" : "workflows"} where id = $1 for update`,
      [scope.id],
    );
    const current = await readChannel(tx, scope);
    if (current === undefined || current.revision !== body.revision)
      throw new RequestError(
        409,
        "The robot settings changed; reload before disconnecting",
      );
    await tx.query(
      "update notification_deliveries set status = 'cancelled' where channel_id = $1 and status in ('queued', 'retry')",
      [current.id],
    );
    await tx.query("delete from notification_channels where id = $1", [
      current.id,
    ]);
    await recordAudit(tx, deps, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "notification_channel.disconnected",
      target: {
        type: "notification_channel",
        id: current.id,
        label: current.label,
      },
      before: { revision: current.revision, hash: null },
      after: null,
      reason: "Robot disconnected; pending posts cancelled",
      requestId: context.requestId,
    });
    return { channel: null };
  });
}
