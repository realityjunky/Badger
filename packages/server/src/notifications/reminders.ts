import { recordAudit } from "../audit.js";
import { isAdministrator } from "../authorization.js";
import type { Queryable } from "../database/database.js";
import type { AuthorizedRequest } from "../http/authorized-request.js";
import { objectInput, RequestError } from "../http/errors.js";
import { workflowCapabilities } from "../workflow-access.js";
import { readWorkflow } from "../workflows.js";
import { mayManageChannel, workflowChannel } from "./channels.js";
import {
  NOTIFICATION_ITEM_SELECT,
  itemHref,
  notificationRecipients,
  type NotificationItemRow,
} from "./events.js";
import { notificationMessage } from "./messages.js";
import { eligibleNotificationItems } from "./eligibility.js";
import type { ServiceConfig } from "../config.js";

function itemKey(item: NotificationItemRow): string {
  return `${item.kind}:${item.fact_id ?? item.drafting_job_id ?? item.question_id ?? item.concern_id ?? `${item.workflow_version_id}:${item.gate}`}`;
}

async function requireWorkflowRead(
  input: AuthorizedRequest,
  workflowId: string,
) {
  const workflow = await readWorkflow(input.database, workflowId);
  if (workflow === null) throw new RequestError(404, "No such workflow");
  if (
    !(
      await workflowCapabilities(
        input.database,
        input.access,
        input.person,
        workflow,
      )
    ).read
  )
    throw new RequestError(403, "A current workflow role is required");
}

async function waitingItems(
  tx: Queryable,
  workflowId: string,
  config: ServiceConfig,
) {
  return eligibleNotificationItems(
    tx,
    config,
    (
      await tx.query<NotificationItemRow>(
        `${NOTIFICATION_ITEM_SELECT}
    where v.workflow_id = $1 and i.state <> 'done' and (p.id is null or p.status = 'active') order by i.created_at, i.id`,
        [workflowId],
      )
    ).rows,
  );
}

export async function listWaiting(
  input: AuthorizedRequest,
  workflowId: string,
) {
  await requireWorkflowRead(input, workflowId);
  const owner = await mayManageChannel(input, {
    type: "workflow",
    id: workflowId,
  });
  const records = await waitingItems(input.database, workflowId, input.config);
  const grouped = new Map<string, NotificationItemRow[]>();
  for (const row of records)
    grouped.set(itemKey(row), [...(grouped.get(itemKey(row)) ?? []), row]);
  const reminders = (
    await input.database.query<{
      item_key: string;
      last_reminded_at: Date | string;
    }>(
      "select item_key, max(created_at) as last_reminded_at from notification_reminders where workflow_id = $1 group by item_key",
      [workflowId],
    )
  ).rows;
  return {
    items: [...grouped].map(([key, items]) => {
      const item = items[0]!;
      const last = reminders.find(
        (row) => row.item_key === key,
      )?.last_reminded_at;
      return {
        id: item.id,
        kind: item.kind,
        questionId: item.question_id,
        href: itemHref(item),
        recipients: notificationRecipients(items, false).map(
          ({ personId, name, count }) => ({ personId, name, count }),
        ),
        canRemind:
          input.access.tokenScopes === undefined &&
          (owner ||
            items.some((record) =>
              record.requester_ids.includes(input.person.id),
            )),
        remindAfter:
          last === undefined
            ? null
            : new Date(new Date(last).getTime() + 3_600_000).toISOString(),
      };
    }),
  };
}

export async function remind(
  input: AuthorizedRequest,
  workflowId: string,
  value: unknown,
) {
  await requireWorkflowRead(input, workflowId);
  const body = objectInput(value);
  if (body.confirmed !== true || typeof body.itemId !== "string")
    throw new RequestError(
      400,
      "Choose a waiting item and confirm the reminder",
    );
  const owner = await mayManageChannel(input, {
    type: "workflow",
    id: workflowId,
  });
  const { database, dependencies: deps, context, person, config } = input;
  return database.transaction(async (tx) => {
    const initial = (
      await tx.query<NotificationItemRow>(
        `${NOTIFICATION_ITEM_SELECT} where i.id = $1 and v.workflow_id = $2`,
        [body.itemId, workflowId],
      )
    ).rows[0];
    if (initial === undefined)
      throw new RequestError(404, "No such waiting item");
    // This is the same lock held by questionnaire and gate writers. The
    // waiting check and hourly limit cannot race completion or another nudge.
    await tx.query(
      "select id from workflow_versions where id = $1 for update",
      [initial.workflow_version_id],
    );
    const items = (await waitingItems(tx, workflowId, config)).filter(
      (item) => itemKey(item) === itemKey(initial),
    );
    if (
      !owner &&
      !isAdministrator(input.access) &&
      !items.some((item) => item.requester_ids.includes(person.id))
    )
      throw new RequestError(
        403,
        "Only the requester, Workflow owner, or an Administrator may remind",
      );
    if (items.length === 0)
      throw new RequestError(409, "This item no longer waits for anyone");
    const key = itemKey(initial);
    const now = deps.clock.now();
    const previous = (
      await tx.query<{ created_at: Date | string }>(
        "select created_at from notification_reminders where item_key = $1 order by created_at desc limit 1",
        [key],
      )
    ).rows[0];
    if (
      previous !== undefined &&
      now.getTime() - new Date(previous.created_at).getTime() < 3_600_000
    )
      throw new RequestError(
        409,
        "This item was reminded within the last hour",
        {
          remindAfter: new Date(
            new Date(previous.created_at).getTime() + 3_600_000,
          ).toISOString(),
        },
      );
    const robot = await workflowChannel(tx, workflowId);
    const recipients = notificationRecipients(items, robot !== undefined);
    const href = `${config.notifications.publicUrl ?? (config.basePath === "/" ? "" : config.basePath)}${itemHref(items[0]!)}`;
    const message = notificationMessage({
      workflowNames: [initial.workflow_name],
      events: [initial.kind],
      recipients,
      href,
      language: robot?.language ?? "en",
      reminder: true,
    });
    const id = deps.ids.next();
    let deliveryId: string | null = null;
    if (robot !== undefined && recipients.length > 0) {
      deliveryId = deps.ids.next();
      await tx.query(
        `insert into notification_deliveries (id, workflow_id, channel_id, robot_key, robot_label, webhook_ciphertext,
        recipients, content, available_at, created_at, item_ids, language, reminder) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,true)`,
        [
          deliveryId,
          workflowId,
          robot.id,
          robot.robot_key,
          robot.label,
          robot.webhook_ciphertext,
          JSON.stringify(recipients),
          JSON.stringify(message),
          now,
          items.map((item) => item.id),
          robot.language,
        ],
      );
    }
    const copyText = robot === undefined ? message.text.content : null;
    await tx.query(
      `insert into notification_reminders (id, workflow_id, item_key, actor_id, recipients, copy_text, delivery_id, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        workflowId,
        key,
        person.id,
        JSON.stringify(recipients),
        copyText,
        deliveryId,
        now,
      ],
    );
    await recordAudit(tx, deps, {
      actor: { personId: person.id, credential: context.credential },
      channel: context.channel,
      action: "reminder.created",
      target: { type: "reminder", id },
      before: null,
      after: { revision: 1, hash: null },
      reason: `Reminded ${recipients.map((recipient) => `${recipient.name} (${recipient.count})`).join(", ")}; item ${key}`,
      requestId: context.requestId,
    });
    return {
      reminder: { id, recipients, createdAt: now.toISOString() },
      copyText,
      deliveryId,
      remindAfter: new Date(now.getTime() + 3_600_000).toISOString(),
    };
  });
}
