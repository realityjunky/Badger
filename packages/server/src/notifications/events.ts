import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { ServiceConfig } from "../config.js";
import { workflowChannel, type ChannelRow } from "./channels.js";
import { notificationMessage, recordedRecipients } from "./messages.js";
import type { NotificationRecipient } from "./port.js";
import type { NotificationEvent } from "./preferences.js";
import { eligibleNotificationItems } from "./eligibility.js";

export interface NotificationItemRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  workflow_name: string;
  kind: NotificationEvent;
  person_id: string | null;
  binding_id: string | null;
  name: string;
  wecom_user_id: string | null;
  mobile: string | null;
  mention_events: NotificationEvent[] | null;
  question_id: string | null;
  concern_id: string | null;
  gate: string;
  fact_id: string | null;
  drafting_job_id: string | null;
  requester_ids: string[];
}

// Posts never carry an email address, so a pending invitation stays unnamed.
export const NOTIFICATION_ITEM_SELECT = `select i.id, i.workflow_version_id, v.workflow_id, w.name as workflow_name,
  i.kind, coalesce(i.person_id, b.person_id) as person_id, i.binding_id,
  coalesce(p.display_name, 'Invited person') as name,
  prefs.wecom_user_id, prefs.mobile, prefs.mention_events, i.question_id, i.concern_id, i.gate, i.fact_id, i.drafting_job_id,
  array(select distinct a.actor_person_id from audit_events a where a.notification_action_id = i.notification_action_id and a.actor_person_id is not null) as requester_ids
  from inbox_items i join workflow_versions v on v.id = i.workflow_version_id
  join workflows w on w.id = v.workflow_id left join role_bindings b on b.id = i.binding_id
  left join people p on p.id = coalesce(i.person_id, b.person_id)
  left join person_notification_preferences prefs on prefs.person_id = p.id`;

export function itemHref(item: NotificationItemRow): string {
  if (item.gate === "plan")
    return `/workflows/${encodeURIComponent(item.workflow_id)}/versions/${encodeURIComponent(item.workflow_version_id)}#plan`;
  if (item.drafting_job_id !== null)
    return `/questionnaire?workflow=${encodeURIComponent(item.workflow_id)}&version=${encodeURIComponent(item.workflow_version_id)}&panel=suggestions`;
  if (item.question_id !== null)
    return `/questionnaire/questions/${encodeURIComponent(item.question_id)}`;
  if (item.concern_id !== null)
    return `/questionnaire/concerns/${encodeURIComponent(item.concern_id)}`;
  return `/workflows/${encodeURIComponent(item.workflow_id)}/versions/${encodeURIComponent(item.workflow_version_id)}#${encodeURIComponent(item.gate)}`;
}

/** Several recipients of the same item share its exact destination. */
export function notificationHref(items: NotificationItemRow[]): string {
  const first = items[0]!;
  const href = itemHref(first);
  return items.every((item) => itemHref(item) === href)
    ? href
    : `/workflows/${encodeURIComponent(first.workflow_id)}/versions/${encodeURIComponent(first.workflow_version_id)}`;
}

export function notificationRecipients(
  items: NotificationItemRow[],
  respectPreferences = true,
): NotificationRecipient[] {
  const people = new Map<string, NotificationRecipient>();
  for (const item of items) {
    if (
      respectPreferences &&
      item.mention_events !== null &&
      !item.mention_events.includes(item.kind)
    )
      continue;
    const key = item.person_id ?? item.binding_id!;
    const person = people.get(key);
    if (person !== undefined) person.count += 1;
    else
      people.set(key, {
        personId: item.person_id,
        name: item.name,
        count: 1,
        wecomUserId: item.wecom_user_id,
        mobile: item.mobile,
      });
  }
  return [...people.values()];
}

/** Routes one committed action atomically. Its many inbox inserts become one post per chat. */
export async function routeNotificationAction(
  tx: Queryable,
  deps: ServiceDependencies,
  config: ServiceConfig,
): Promise<boolean> {
  const action = (
    await tx.query<{ id: string }>(
      "select id from notification_actions where processed_at is null order by created_at, id limit 1 for update skip locked",
    )
  ).rows[0];
  if (action === undefined) return false;
  const items = await eligibleNotificationItems(
    tx,
    config,
    (
      await tx.query<NotificationItemRow>(
        `${NOTIFICATION_ITEM_SELECT}
    where i.notification_action_id = $1 and i.state <> 'done' order by w.id, i.id`,
        [action.id],
      )
    ).rows,
  );
  const chats = new Map<
    string,
    { channel: ChannelRow; items: NotificationItemRow[] }
  >();
  for (const workflowId of new Set(items.map((item) => item.workflow_id))) {
    const channel = await workflowChannel(tx, workflowId);
    if (channel === undefined) continue;
    const chat = chats.get(channel.robot_key) ?? { channel, items: [] };
    chat.items.push(...items.filter((item) => item.workflow_id === workflowId));
    chats.set(channel.robot_key, chat);
  }
  // Without BADGER_PUBLIC_URL the link stays relative. The post is queued all
  // the same: no worker sends it unlinked, and failing it keeps it visible.
  for (const { channel, items: records } of chats.values()) {
    const recipients = notificationRecipients(records);
    if (recipients.length === 0) continue;
    const first = records[0]!;
    const href = notificationHref(records);
    const content = notificationMessage({
      workflowNames: [...new Set(records.map((item) => item.workflow_name))],
      events: records.map((item) => item.kind),
      recipients,
      href: `${config.notifications.publicUrl ?? ""}${href}`,
      language: channel.language,
    });
    await tx.query(
      `insert into notification_deliveries (id, workflow_id, group_id, channel_id, robot_key, robot_label, webhook_ciphertext,
      recipients, content, available_at, created_at, action_id, item_ids, language) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13) on conflict do nothing`,
      [
        deps.ids.next(),
        first.workflow_id,
        channel.group_id,
        channel.id,
        channel.robot_key,
        channel.label,
        channel.webhook_ciphertext,
        JSON.stringify(recordedRecipients(recipients)),
        JSON.stringify(content),
        deps.clock.now(),
        action.id,
        records.map((item) => item.id),
        channel.language,
      ],
    );
  }
  await tx.query(
    "update notification_actions set processed_at = $2 where id = $1",
    [action.id, deps.clock.now()],
  );
  return true;
}
