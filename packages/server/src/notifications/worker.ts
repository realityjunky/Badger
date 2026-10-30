import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { ServiceConfig } from "../config.js";
import {
  routeNotificationAction,
  NOTIFICATION_ITEM_SELECT,
  notificationRecipients,
  itemHref,
  type NotificationItemRow,
} from "./events.js";
import type { NotificationChannel, RobotMessage } from "./port.js";
import { decryptWebhook } from "./secrets.js";
import { eligibleNotificationItems } from "./eligibility.js";
import { notificationMessage } from "./messages.js";

interface DeliveryClaim {
  id: string;
  robot_key: string;
  webhook_ciphertext: string;
  content: RobotMessage;
  attempts: number;
  claim_id: string;
  item_ids: string[];
  language: "en" | "zh";
  reminder: boolean;
}

/** Durable claims and webhook-wide reservations are shared by all worker processes. */
export class NotificationWorker {
  constructor(
    private readonly options: {
      database: Database;
      dependencies: ServiceDependencies;
      config: ServiceConfig;
      channel: NotificationChannel;
    },
  ) {}

  async routePending(): Promise<void> {
    for (let count = 0; count < 100; count++) {
      if (
        !(await this.options.database.transaction((tx) =>
          routeNotificationAction(
            tx,
            this.options.dependencies,
            this.options.config,
          ),
        ))
      )
        break;
    }
  }

  async runOnce(): Promise<string | null> {
    const { database, dependencies: deps, config, channel } = this.options;
    if (config.notifications.encryptionKey === null) return null;
    const delivery = await database.transaction(async (tx) => {
      const now = deps.clock.now();
      const pending = (
        await tx.query<DeliveryClaim & { robot_key: string }>(
          `select d.* from notification_deliveries d
        left join notification_robots r on r.robot_key = d.robot_key
        where ((d.status in ('queued', 'retry') and d.available_at <= $1)
          or (d.status = 'sending' and d.lease_until <= $1))
          and (r.robot_key is null or r.available_at <= $1)
        order by d.created_at, d.id limit 1 for update of d skip locked`,
          [now],
        )
      ).rows[0];
      if (pending === undefined) return null;
      if (pending.item_ids.length > 0) {
        const records = await eligibleNotificationItems(
          tx,
          config,
          (
            await tx.query<NotificationItemRow>(
              `${NOTIFICATION_ITEM_SELECT} where i.id = any($1::text[]) and i.state <> 'done' order by i.id`,
              [pending.item_ids],
            )
          ).rows,
        );
        const recipients = notificationRecipients(records);
        if (recipients.length === 0) {
          await tx.query(
            "update notification_deliveries set status = 'cancelled', lease_until = null, claim_id = null where id = $1",
            [pending.id],
          );
          return null;
        }
        const first = records[0]!;
        const href =
          pending.reminder || records.length === 1
            ? itemHref(first)
            : `/workflows/${encodeURIComponent(first.workflow_id)}/versions/${encodeURIComponent(first.workflow_version_id)}`;
        const content = notificationMessage({
          workflowNames: [
            ...new Set(records.map((item) => item.workflow_name)),
          ],
          events: records.map((item) => item.kind),
          recipients,
          href: `${config.notifications.publicUrl}${href}`,
          language: pending.language,
          reminder: pending.reminder,
        });
        await tx.query(
          "update notification_deliveries set recipients = $2, content = $3 where id = $1",
          [pending.id, JSON.stringify(recipients), JSON.stringify(content)],
        );
      }
      await tx.query(
        "insert into notification_robots (robot_key, available_at) values ($1,$2) on conflict do nothing",
        [pending.robot_key, now],
      );
      const reservation = await tx.query(
        `update notification_robots set available_at = $3 where robot_key = $1 and available_at <= $2 returning robot_key`,
        [pending.robot_key, now, new Date(now.getTime() + 3100)],
      );
      if (reservation.rows.length === 0) return null;
      const claimId = deps.ids.next();
      return (
        await tx.query<DeliveryClaim>(
          `update notification_deliveries set status = 'sending', attempts = attempts + 1,
        lease_until = $2, claim_id = $3 where id = $1 returning *`,
          [pending.id, new Date(now.getTime() + 30_000), claimId],
        )
      ).rows[0]!;
    });
    if (delivery === null) return null;
    let result;
    try {
      result = await channel.post(
        decryptWebhook(
          delivery.webhook_ciphertext,
          config.notifications.encryptionKey,
        ),
        delivery.content,
      );
    } catch {
      result = { ok: false as const, error: "Notification channel failed" };
    }
    const now = deps.clock.now();
    const status = result.ok
      ? "sent"
      : delivery.attempts >= 5
        ? "failed"
        : "retry";
    const nextAttempt = new Date(
      now.getTime() +
        (result.ok
          ? 0
          : Math.max(
              3100 * 2 ** (delivery.attempts - 1),
              result.retryAfterMilliseconds ?? 0,
            )),
    );
    await database.transaction(async (tx) => {
      if (!result.ok && result.rateLimited)
        await tx.query(
          "update notification_robots set available_at = greatest(available_at, $2) where robot_key = $1",
          [delivery.robot_key, nextAttempt],
        );
      await tx.query(
        `update notification_deliveries set status = $3, error = $4, available_at = $5,
      sent_at = $6, lease_until = null, claim_id = null where id = $1 and claim_id = $2`,
        [
          delivery.id,
          delivery.claim_id,
          status,
          result.ok ? null : result.error,
          nextAttempt,
          result.ok ? now : null,
        ],
      );
    });
    return delivery.id;
  }
}
