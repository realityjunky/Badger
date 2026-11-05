import type { Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import type { ServiceConfig } from "../config.js";
import {
  notificationHref,
  notificationRecipients,
  type NotificationItemRow,
} from "./events.js";
import { notificationMessage, recordedRecipients } from "./messages.js";
import type { PersonalRobotRow, RobotRouteRow } from "./robots.js";

export async function personalRoutes(
  tx: Queryable,
  items: NotificationItemRow[],
) {
  const selected = new Map<
    string,
    { robot: PersonalRobotRow; items: NotificationItemRow[] }
  >();
  if (items.length === 0) return selected;
  const routes = (
    await tx.query<RobotRouteRow>(
      "select * from personal_robot_routes where person_id = any($1::text[])",
      [
        [
          ...new Set(
            items.flatMap((item) =>
              item.person_id === null ? [] : [item.person_id],
            ),
          ),
        ],
      ],
    )
  ).rows;
  if (routes.length === 0) return selected;
  const robots = (
    await tx.query<PersonalRobotRow>(
      "select r.* from personal_robots r join people p on p.id=r.person_id where r.enabled and not r.suspended and r.verified_at is not null and p.status='active'",
    )
  ).rows;
  const groups = routes.some((route) => route.scope_type === "group")
    ? (
        await tx.query<{
          workflow_id: string;
          group_id: string;
          depth: number;
        }>(
          `with recursive ancestors as (
      select w.id as workflow_id, g.id as group_id, g.parent_id, 0 as depth from workflows w join groups g on g.id=w.group_id where w.id=any($1::text[])
      union all select a.workflow_id,g.id,g.parent_id,a.depth+1 from ancestors a join groups g on g.id=a.parent_id
    ) select workflow_id,group_id,depth from ancestors`,
          [[...new Set(items.map((item) => item.workflow_id))]],
        )
      ).rows
    : [];
  for (const item of items) {
    if (
      item.person_id === null ||
      (item.mention_events !== null && !item.mention_events.includes(item.kind))
    )
      continue;
    const ranked = routes
      .filter(
        (route) =>
          route.person_id === item.person_id && route.event === item.kind,
      )
      .flatMap((route) => {
        if (route.scope_type === "all") return [{ route, rank: 1_000_000 }];
        if (route.scope_type === "workflow")
          return route.scope_id === item.workflow_id
            ? [{ route, rank: -1 }]
            : [];
        const ancestor = groups.find(
          (group) =>
            group.workflow_id === item.workflow_id &&
            group.group_id === route.scope_id,
        );
        return ancestor === undefined ? [] : [{ route, rank: ancestor.depth }];
      })
      .sort((left, right) => left.rank - right.rank);
    const winning = ranked[0]?.route;
    const robot = robots.find(
      (candidate) =>
        candidate.id === winning?.robot_id &&
        candidate.person_id === item.person_id,
    );
    if (robot === undefined) continue;
    const batch = selected.get(robot.id) ?? { robot, items: [] };
    batch.items.push(item);
    selected.set(robot.id, batch);
  }
  return selected;
}

export async function queuePersonalPosts(
  tx: Queryable,
  deps: ServiceDependencies,
  config: ServiceConfig,
  items: NotificationItemRow[],
  actionId: string | null,
  reminder = false,
) {
  const ids: string[] = [];
  const batches = await personalRoutes(tx, items);
  for (const { robot, items: records } of batches.values()) {
    const id = deps.ids.next();
    const recipients = notificationRecipients(records);
    const content = notificationMessage({
      workflowNames: [...new Set(records.map((item) => item.workflow_name))],
      events: records.map((item) => item.kind),
      recipients,
      href: `${config.notifications.publicUrl ?? ""}${notificationHref(records)}`,
      language: robot.language,
      reminder,
    });
    await tx.query(
      `insert into notification_deliveries (id,workflow_id,channel_id,robot_key,robot_label,target_ciphertext,recipients,content,available_at,created_at,action_id,item_ids,language,reminder,transport,bot_key,person_id,personal_robot_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,'long-connection',$14,$15,$3) on conflict do nothing`,
      [
        id,
        records[0].workflow_id,
        robot.id,
        robot.robot_key,
        robot.label,
        robot.target_ciphertext,
        JSON.stringify(recordedRecipients(recipients, false)),
        JSON.stringify(content),
        deps.clock.now(),
        actionId,
        records.map((item) => item.id),
        robot.language,
        reminder,
        robot.bot_key,
        robot.person_id,
      ],
    );
    ids.push(id);
  }
  return { ids, batches };
}
