import type { Queryable } from "./database/database.js";

// Both walks use `union`, not `union all`, so each group is visited once and
// a walk ends even if the tree ever held a cycle. Moves are serialized by
// lockGroupTree, so none should.

/** The groups and every group above them. */
export async function withAncestors(
  database: Queryable,
  groupIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...groupIds];
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await database.query<{ id: string }>(
    `with recursive chain as (
       select id, parent_id from groups where id = any($1::text[])
       union
       select g.id, g.parent_id
         from groups g
         join chain c on g.id = c.parent_id
     )
     select id from chain`,
    [ids],
  );
  return new Set(rows.rows.map((row) => row.id));
}

/** The groups and every group inside them. */
export async function withDescendants(
  database: Queryable,
  groupIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...groupIds];
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await database.query<{ id: string }>(
    `with recursive inside as (
       select id from groups where id = any($1::text[])
       union
       select g.id from groups g join inside i on g.parent_id = i.id
     )
     select id from inside`,
    [ids],
  );
  return new Set(rows.rows.map((row) => row.id));
}

/** Whether `candidate` is `groupId` or lives inside it. */
export async function isInside(
  database: Queryable,
  groupId: string,
  candidate: string,
): Promise<boolean> {
  return (await withDescendants(database, [groupId])).has(candidate);
}

/** Distinct from the migration lock, so a move never waits on startup. */
const GROUP_TREE_LOCK_KEY = "8231130000000002";

/**
 * Serializes the writes that move a group, until the transaction ends. Two
 * moves checked against the same tree at once could otherwise each pass the
 * cycle check and together close a loop.
 */
export async function lockGroupTree(database: Queryable): Promise<void> {
  await database.query(`select pg_advisory_xact_lock(${GROUP_TREE_LOCK_KEY})`);
}
