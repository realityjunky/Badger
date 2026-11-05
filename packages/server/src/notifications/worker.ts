import type { Database } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { ServiceConfig } from "../config.js";
import {
  routeNotificationAction,
  NOTIFICATION_ITEM_SELECT,
  notificationRecipients,
  notificationHref,
  type NotificationItemRow,
} from "./events.js";
import type { Logger } from "../log.js";
import { missingNotificationSettings } from "./channels.js";
import type {
  NotificationChannel,
  NotificationTarget,
  RobotMessage,
} from "./port.js";
import { decryptTarget } from "./secrets.js";
import { eligibleNotificationItems } from "./eligibility.js";
import { notificationMessage, recordedRecipients } from "./messages.js";
import { personalRoutes } from "./personal-routing.js";
import type { PersonalRobotRow } from "./robots.js";

interface DeliveryClaim {
  id: string;
  robot_key: string;
  target_ciphertext: string;
  transport: NotificationTarget["transport"];
  bot_key: string | null;
  personal_robot_id: string | null;
  person_id: string | null;
  content: RobotMessage;
  attempts: number;
  rate_limited_attempts: number;
  claim_id: string;
  item_ids: string[];
  language: "en" | "zh";
  reminder: boolean;
}

/** A post to send, or one this worker's settings leave unusable. */
type Claim =
  | { kind: "send"; delivery: DeliveryClaim; target: NotificationTarget }
  | { kind: "unusable"; id: string; error: string }
  | null;

/** WeCom allows a group robot about 20 posts a minute. */
const PACE_MILLISECONDS = 3100;
/** A rate-limited robot waits until its one-minute window has surely reset. */
const RATE_LIMIT_WINDOW_MILLISECONDS = 60_000;
const FAILED_ATTEMPT_LIMIT = 5;
/** An hour of rate limiting ends the post, however few its failures. */
const RATE_LIMITED_ATTEMPT_LIMIT = 60;

/** A failure that is not rate limiting backs off, and the fifth is final. */
function afterFailure(failures: number, now: Date, retryAfter = 0) {
  return {
    status: failures >= FAILED_ATTEMPT_LIMIT ? "failed" : "retry",
    availableAt: new Date(
      now.getTime() +
        Math.max(PACE_MILLISECONDS * 2 ** (failures - 1), retryAfter),
    ),
  };
}

/** Durable claims and webhook-wide reservations are shared by all worker processes. */
export class NotificationWorker {
  constructor(
    private readonly options: {
      database: Database;
      dependencies: ServiceDependencies;
      config: ServiceConfig;
      channel: NotificationChannel;
      connectionOwner?: string;
      logger?: Logger;
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
    const missing = missingNotificationSettings(config);
    const claim = await database.transaction(async (tx): Promise<Claim> => {
      const now = deps.clock.now();
      const pending = (
        await tx.query<DeliveryClaim & { robot_key: string }>(
          `select d.* from notification_deliveries d
        left join notification_robots r on r.robot_key = coalesce(d.bot_key, d.robot_key)
        where ((d.status in ('queued', 'retry') and d.available_at <= $1)
          or (d.status = 'sending' and d.lease_until <= $1))
          and (r.robot_key is null or r.available_at <= $1)
          and (d.transport = 'webhook' or $3::boolean or exists (
            select 1 from notification_bot_leases b where b.bot_key = d.bot_key
              and b.holder = $2 and b.lease_until > $1
          ))
        order by d.created_at, d.id limit 1 for update of d skip locked`,
          [now, this.options.connectionOwner ?? null, missing.length > 0],
        )
      ).rows[0];
      if (pending === undefined) return null;
      if (pending.person_id !== null) {
        const robot = (
          await tx.query<PersonalRobotRow>(
            "select r.* from personal_robots r join people p on p.id=r.person_id where r.id=$1 and r.person_id=$2 and r.enabled and not r.suspended and r.verified_at is not null and p.status='active'",
            [pending.personal_robot_id, pending.person_id],
          )
        ).rows[0];
        if (robot === undefined || robot.robot_key !== pending.robot_key) {
          await tx.query(
            "update notification_deliveries set status='cancelled',claim_id=null,lease_until=null where id=$1",
            [pending.id],
          );
          return null;
        }
        pending.target_ciphertext = robot.target_ciphertext;
      }
      // A worker that cannot link or read a post says so where the owner
      // looks, instead of leaving the post queued or dropping it unseen. It
      // counts as a failed attempt, so a worker with its settings can still
      // send the post before the last one.
      let unusable =
        missing.length > 0 ? `Worker lacks ${missing.join(" and ")}` : null;
      let target: NotificationTarget | undefined;
      if (unusable === null)
        try {
          target = decryptTarget(
            pending.target_ciphertext,
            pending.transport,
            config.notifications.encryptionKey!,
          );
        } catch {
          unusable =
            "Worker cannot decrypt the robot with its BADGER_NOTIFICATION_KEY";
        }
      if (unusable !== null) {
        const next = afterFailure(
          pending.attempts + 1 - pending.rate_limited_attempts,
          now,
        );
        await tx.query(
          `update notification_deliveries set status = $2, attempts = attempts + 1, error = $3,
          available_at = $4, lease_until = null, claim_id = null where id = $1`,
          [pending.id, next.status, unusable, next.availableAt],
        );
        return { kind: "unusable", id: pending.id, error: unusable };
      }
      if (pending.item_ids.length > 0) {
        let records = await eligibleNotificationItems(
          tx,
          config,
          (
            await tx.query<NotificationItemRow>(
              `${NOTIFICATION_ITEM_SELECT} where i.id = any($1::text[]) and i.state <> 'done' order by i.id`,
              [pending.item_ids],
            )
          ).rows,
        );
        if (pending.person_id !== null)
          records =
            (
              await personalRoutes(
                tx,
                records.filter((item) => item.person_id === pending.person_id),
              )
            ).get(pending.personal_robot_id!)?.items ?? [];
        const recipients = notificationRecipients(records);
        if (recipients.length === 0) {
          await tx.query(
            "update notification_deliveries set status = 'cancelled', lease_until = null, claim_id = null where id = $1",
            [pending.id],
          );
          return null;
        }
        const href = notificationHref(records);
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
          [
            pending.id,
            JSON.stringify(
              recordedRecipients(recipients, pending.transport === "webhook"),
            ),
            JSON.stringify(content),
          ],
        );
      }
      await tx.query(
        "insert into notification_robots (robot_key, available_at) values ($1,$2) on conflict do nothing",
        [pending.bot_key ?? pending.robot_key, now],
      );
      const reservation = await tx.query(
        `update notification_robots set available_at = $3 where robot_key = $1 and available_at <= $2 returning robot_key`,
        [
          pending.bot_key ?? pending.robot_key,
          now,
          new Date(now.getTime() + PACE_MILLISECONDS),
        ],
      );
      if (reservation.rows.length === 0) return null;
      const claimId = deps.ids.next();
      const delivery = (
        await tx.query<DeliveryClaim>(
          `update notification_deliveries set status = 'sending', attempts = attempts + 1,
        lease_until = $2, claim_id = $3 where id = $1 returning *`,
          [pending.id, new Date(now.getTime() + 30_000), claimId],
        )
      ).rows[0]!;
      return { kind: "send", delivery, target: target! };
    });
    if (claim === null) return null;
    if (claim.kind === "unusable") {
      this.options.logger?.error({
        event: "worker.notification-settings",
        delivery: claim.id,
        error: claim.error,
      });
      return claim.id;
    }
    const { delivery, target } = claim;
    let result;
    try {
      result = await channel.post(target, delivery.content);
    } catch {
      result = { ok: false as const, error: "Notification channel failed" };
    }
    const now = deps.clock.now();
    const rateLimited = !result.ok && result.rateLimited === true;
    const rateLimitedAttempts =
      delivery.rate_limited_attempts + (rateLimited ? 1 : 0);
    const { status, availableAt: nextAttempt } = result.ok
      ? { status: "sent", availableAt: now }
      : rateLimited
        ? {
            status:
              rateLimitedAttempts >= RATE_LIMITED_ATTEMPT_LIMIT
                ? "failed"
                : "retry",
            availableAt: new Date(
              now.getTime() +
                Math.max(
                  RATE_LIMIT_WINDOW_MILLISECONDS,
                  result.retryAfterMilliseconds ?? 0,
                ),
            ),
          }
        : afterFailure(
            delivery.attempts - rateLimitedAttempts,
            now,
            result.retryAfterMilliseconds,
          );
    await database.transaction(async (tx) => {
      if (rateLimited)
        await tx.query(
          "update notification_robots set available_at = greatest(available_at, $2) where robot_key = $1",
          [delivery.bot_key ?? delivery.robot_key, nextAttempt],
        );
      await tx.query(
        `update notification_deliveries set status = $3, error = $4, available_at = $5,
      sent_at = $6, rate_limited_attempts = $7, lease_until = null, claim_id = null
      where id = $1 and claim_id = $2`,
        [
          delivery.id,
          delivery.claim_id,
          status,
          result.ok ? null : result.error,
          nextAttempt,
          result.ok ? now : null,
          rateLimitedAttempts,
        ],
      );
    });
    return delivery.id;
  }
}
