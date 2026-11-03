import { recordAudit } from "../audit.js";
import type { Queryable } from "../database/database.js";
import type { AuthorizedRequest } from "../http/authorized-request.js";
import { objectInput, RequestError } from "../http/errors.js";

export const NOTIFICATION_EVENTS = [
  "gate-ready",
  "gate-invalidated",
  "question-assigned",
  "answer-submitted",
  "restatement-ready",
  "question-reopened",
  "concern-raised",
  "job-submitted",
  "evaluation-finished",
  "script-effect-review",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * WeCom's userid rule: up to 64 letters, digits, and "_-@.", starting with a
 * letter or digit. WeCom ignores case, and "@all" in a post's mention list
 * mentions the whole chat, so neither it nor "all" is anyone's userid.
 */
export function isWeComUserId(value: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_@.-]{0,63}$/u.test(value) &&
    !["@all", "all"].includes(value.toLowerCase())
  );
}
export interface NotificationPreferences {
  revision: number;
  wecomUserId: string | null;
  mobile: string | null;
  mentionEvents: NotificationEvent[];
}

export async function readNotificationPreferences(
  tx: Queryable,
  personId: string,
): Promise<NotificationPreferences> {
  const row = (
    await tx.query<{
      revision: number;
      wecom_user_id: string | null;
      mobile: string | null;
      mention_events: NotificationEvent[];
    }>("select * from person_notification_preferences where person_id = $1", [
      personId,
    ])
  ).rows[0];
  return row === undefined
    ? {
        revision: 0,
        wecomUserId: null,
        mobile: null,
        mentionEvents: [...NOTIFICATION_EVENTS],
      }
    : {
        revision: row.revision,
        wecomUserId: row.wecom_user_id,
        mobile: row.mobile,
        mentionEvents: row.mention_events,
      };
}

export async function saveNotificationPreferences(
  input: AuthorizedRequest,
  value: unknown,
) {
  const body = objectInput(value);
  const { revision, wecomUserId, mobile, mentionEvents } = body;
  if (
    !Number.isInteger(revision) ||
    (revision as number) < 0 ||
    !(
      wecomUserId === null ||
      (typeof wecomUserId === "string" && isWeComUserId(wecomUserId))
    ) ||
    !(
      mobile === null ||
      (typeof mobile === "string" && /^\+?[0-9]{7,20}$/u.test(mobile))
    ) ||
    !Array.isArray(mentionEvents) ||
    !mentionEvents.every((event) =>
      NOTIFICATION_EVENTS.includes(event as NotificationEvent),
    ) ||
    new Set(mentionEvents).size !== mentionEvents.length ||
    Object.keys(body).some(
      (key) =>
        !["revision", "wecomUserId", "mobile", "mentionEvents"].includes(key),
    )
  )
    throw new RequestError(
      400,
      "Provide revision, a WeCom userid or mobile (or null), and distinct supported mentionEvents",
    );
  const { database, person, dependencies: deps, context } = input;
  return database.transaction(async (tx) => {
    await tx.query("select id from people where id = $1 for update", [
      person.id,
    ]);
    const current = await readNotificationPreferences(tx, person.id);
    if (current.revision !== revision)
      throw new RequestError(
        409,
        "Your notification preferences changed; reload before saving",
      );
    await tx.query(
      `insert into person_notification_preferences (person_id, wecom_user_id, mobile, mention_events, revision)
      values ($1,$2,$3,$4,$5) on conflict (person_id) do update set wecom_user_id = excluded.wecom_user_id,
      mobile = excluded.mobile, mention_events = excluded.mention_events, revision = excluded.revision`,
      [
        person.id,
        wecomUserId,
        mobile,
        JSON.stringify(mentionEvents),
        current.revision + 1,
      ],
    );
    await recordAudit(tx, deps, {
      actor: { personId: person.id, credential: context.credential },
      channel: context.channel,
      action: "person.notification_preferences_updated",
      target: { type: "person_notification_preferences", id: person.id },
      before:
        current.revision === 0
          ? null
          : { revision: current.revision, hash: null },
      after: { revision: current.revision + 1, hash: null },
      reason: "Personal mention preferences saved",
      requestId: context.requestId,
    });
    return { preferences: await readNotificationPreferences(tx, person.id) };
  });
}
