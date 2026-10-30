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
import { notificationMessage, recordedRecipients } from "./messages.js";
import { eligibleNotificationItems } from "./eligibility.js";

function itemKey(item: NotificationItemRow): string {
  return `${item.kind}:${item.evaluation_report_id ?? item.fact_id ?? item.drafting_job_id ?? item.question_id ?? item.concern_id ?? `${item.workflow_version_id}:${item.gate}`}`;
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

/** A workflow's open items, or one logical item's, before eligibility. */
async function waitingRows(
  tx: Queryable,
  workflowId: string,
  item?: NotificationItemRow,
) {
  const rows = (
    await tx.query<NotificationItemRow>(
      `${NOTIFICATION_ITEM_SELECT}
    where v.workflow_id = $1 and ($2::text is null or i.kind = $2) and i.state <> 'done'
      and (p.id is null or p.status = 'active') order by i.created_at, i.id`,
      [workflowId, item?.kind ?? null],
    )
  ).rows;
  return item === undefined
    ? rows
    : rows.filter((row) => itemKey(row) === itemKey(item));
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
  const records = await eligibleNotificationItems(
    input.database,
    input.config,
    await waitingRows(input.database, workflowId),
  );
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
  const initial = (
    await database.query<NotificationItemRow>(
      `${NOTIFICATION_ITEM_SELECT} where i.id = $1 and v.workflow_id = $2`,
      [body.itemId, workflowId],
    )
  ).rows[0];
  if (initial === undefined)
    throw new RequestError(404, "No such waiting item");
  // Resolving capabilities is the slow part, so it runs before the lock. Role
  // changes never took that lock, and the writers that do take it close the
  // items they supersede, which the locked re-read below sees.
  const scanned = await waitingRows(database, workflowId, initial);
  const eligible = new Set(
    (await eligibleNotificationItems(database, config, scanned)).map(
      (item) => item.id,
    ),
  );
  return database.transaction(async (tx) => {
    // This is the same version lock held by questionnaire and gate writers.
    // The waiting check and hourly limit cannot race completion or another
    // nudge. Like every transaction that takes both, it locks the workflow
    // row first.
    await tx.query("select id from workflows where id = $1 for no key update", [
      workflowId,
    ]);
    await tx.query(
      "select id from workflow_versions where id = $1 for no key update",
      [initial.workflow_version_id],
    );
    const rows = await waitingRows(tx, workflowId, initial);
    // Items a writer created since the scan are resolved under the lock.
    const seen = new Set(scanned.map((row) => row.id));
    for (const item of await eligibleNotificationItems(
      tx,
      config,
      rows.filter((row) => !seen.has(row.id)),
    ))
      eligible.add(item.id);
    const items = rows.filter((row) => eligible.has(row.id));
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
    const waiting = notificationRecipients(items, false);
    const href = itemHref(items[0]!);
    // Copy reminder's parts. The dashboard writes the text in the viewer's
    // language, linking from its own origin and base path.
    const copy = {
      workflowName: initial.workflow_name,
      event: initial.kind,
      recipients: waiting.map(({ name, count }) => ({ name, count })),
      href,
    };
    const recipients =
      robot === undefined ? waiting : notificationRecipients(items);
    // A post that would mention or name nobody is no reminder: offer the text
    // to paste instead, and leave the hour for a reminder that reaches someone.
    if (robot !== undefined && recipients.length === 0)
      return { reminder: null, copy, deliveryId: null, remindAfter: null };
    const id = deps.ids.next();
    let deliveryId: string | null = null;
    if (robot !== undefined) {
      const message = notificationMessage({
        workflowNames: [initial.workflow_name],
        events: [initial.kind],
        recipients,
        href: `${config.notifications.publicUrl ?? ""}${href}`,
        language: robot.language,
        reminder: true,
      });
      deliveryId = deps.ids.next();
      await tx.query(
        `insert into notification_deliveries (id, workflow_id, group_id, channel_id, robot_key, robot_label, webhook_ciphertext,
        recipients, content, available_at, created_at, item_ids, language, reminder) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,true)`,
        [
          deliveryId,
          workflowId,
          robot.group_id,
          robot.id,
          robot.robot_key,
          robot.label,
          robot.webhook_ciphertext,
          JSON.stringify(recordedRecipients(recipients)),
          JSON.stringify(message),
          now,
          items.map((item) => item.id),
          robot.language,
        ],
      );
    }
    // Whoever reminds learns names and counts, never how the chat mentions people.
    const reminded = recipients.map(({ personId, name, count }) => ({
      personId,
      name,
      count,
    }));
    await tx.query(
      `insert into notification_reminders (id, workflow_id, item_key, actor_id, recipients, delivery_id, created_at)
      values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        workflowId,
        key,
        person.id,
        JSON.stringify(reminded),
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
      reminder: {
        id,
        recipients: reminded.map(({ name, count }) => ({ name, count })),
        createdAt: now.toISOString(),
      },
      copy: robot === undefined ? copy : null,
      deliveryId,
      remindAfter: new Date(now.getTime() + 3_600_000).toISOString(),
    };
  });
}
