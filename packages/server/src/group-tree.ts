import type { Queryable } from "./database/database.js";

/** The group and its ancestors, nearest first. */
export async function ancestorIds(
  database: Queryable,
  groupId: string,
): Promise<string[]> {
  const rows = await database.query<{ id: string }>(
    `with recursive chain as (
       select id, parent_id from groups where id = $1
       union all
       select g.id, g.parent_id
         from groups g
         join chain c on g.id = c.parent_id
     )
     select id from chain`,
    [groupId],
  );
  return rows.rows.map((row) => row.id);
}

/** The group and every group inside it. */
export async function descendantIds(
  database: Queryable,
  groupId: string,
): Promise<string[]> {
  const rows = await database.query<{ id: string }>(
    `with recursive inside as (
       select id from groups where id = $1
       union
       select g.id from groups g join inside i on g.parent_id = i.id
     )
     select id from inside`,
    [groupId],
  );
  return rows.rows.map((row) => row.id);
}

/** Whether `candidate` is `groupId` or lives inside it. */
export async function isInside(
  database: Queryable,
  groupId: string,
  candidate: string,
): Promise<boolean> {
  return (await descendantIds(database, groupId)).includes(candidate);
}
