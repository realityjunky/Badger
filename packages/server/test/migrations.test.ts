import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import {
  applyMigrations,
  inspectMigrations,
  loadBundledMigrations,
  type Migration,
} from "../src/database/migrations.js";
import { openPgliteDatabase } from "../src/database/pglite.js";

const clock = { now: () => new Date("2026-10-27T00:00:00.000Z") };

describe("reviewed SQL migrations", () => {
  it("applies the bundled reviewed SQL and reports what ran", async () => {
    const database = await openPgliteDatabase();
    try {
      const migrations = await loadBundledMigrations();
      expect(migrations.map((migration) => migration.version)).toEqual([
        "0001",
      ]);

      const state = await applyMigrations(database, migrations, clock);

      expect(state).toEqual({
        state: "applied",
        applied: ["0001"],
        pending: [],
        drifted: [],
      });

      const tables = await database.query<{ table_name: string }>(
        `select table_name
           from information_schema.tables
          where table_schema = 'public'
          order by table_name`,
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "audit_events",
        "people",
        "schema_migrations",
      ]);
    } finally {
      await database.close();
    }
  });

  it("applies the bundled reviewed SQL only once", async () => {
    const database = await openPgliteDatabase();
    try {
      const migrations = await loadBundledMigrations();
      await applyMigrations(database, migrations, clock);

      const secondRun = await applyMigrations(database, migrations, clock);

      expect(secondRun).toEqual({
        state: "applied",
        applied: ["0001"],
        pending: [],
        drifted: [],
      });
      const rows = await database.query<{ count: number }>(
        "select count(*)::int as count from schema_migrations",
      );
      expect(rows.rows[0]?.count).toBe(1);
    } finally {
      await database.close();
    }
  });

  it("refuses a reviewed migration whose SQL changed after it was applied", async () => {
    const database = await openPgliteDatabase();
    try {
      const migrations = await loadBundledMigrations();
      await applyMigrations(database, migrations, clock);

      const edited = migrations.map((migration): Migration => ({
        ...migration,
        sql: `${migration.sql}\n-- edited after review\n`,
      }));

      await expect(applyMigrations(database, edited, clock)).rejects.toThrow(
        /0001/u,
      );
    } finally {
      await database.close();
    }
  });

  it("applies pending migrations in version order", async () => {
    const database = await openPgliteDatabase();
    try {
      const migrations: Migration[] = [
        { version: "0002", name: "second", sql: "select 2;" },
        { version: "0001", name: "first", sql: "select 1;" },
      ];

      const state = await applyMigrations(database, migrations, clock);

      expect(state.applied).toEqual(["0001", "0002"]);
    } finally {
      await database.close();
    }
  });

  it("refuses a migration that arrives after a later one was applied", async () => {
    const database = await openPgliteDatabase();
    try {
      const first: Migration[] = [
        { version: "0001", name: "first", sql: "select 1;" },
        { version: "0002", name: "second", sql: "select 2;" },
      ];
      await applyMigrations(database, first, clock);

      await expect(
        applyMigrations(
          database,
          [{ version: "0001", name: "first", sql: "select 1;" }],
          clock,
        ),
      ).rejects.toThrow(/0002/u);
    } finally {
      await database.close();
    }
  });

  it("keeps local single-user mode's PGlite state on disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-pglite-"));
    const dataDir = path.join(root, "pglite");
    try {
      const first = await openPgliteDatabase(dataDir);
      await applyMigrations(first, await loadBundledMigrations(), clock);
      await first.close();

      const reopened = await openPgliteDatabase(dataDir);
      try {
        expect(
          await inspectMigrations(reopened, await loadBundledMigrations()),
        ).toEqual({
          state: "applied",
          applied: ["0001"],
          pending: [],
          drifted: [],
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the audit trail append-only", async () => {
    const database = await openPgliteDatabase();
    try {
      await applyMigrations(database, await loadBundledMigrations(), clock);
      await database.query(
        `insert into people (
           id, issuer, subject, email, display_name, status, revision,
           created_at, updated_at
         ) values ('person-1', 'issuer', 'subject', 'a@example.com', 'A',
                   'active', 1, $1, $1)`,
        [clock.now()],
      );
      await database.query(
        `insert into audit_events (
           id, occurred_at, actor_person_id, credential_kind, channel, action,
           target_type, target_id, request_id
         ) values ('event-1', $1, 'person-1', 'session', 'web', 'person.created',
                   'person', 'person-1', 'request-1')`,
        [clock.now()],
      );

      await expect(
        database.query("update audit_events set reason = 'changed'"),
      ).rejects.toThrow(/append-only/u);
      await expect(database.query("delete from audit_events")).rejects.toThrow(
        /append-only/u,
      );
    } finally {
      await database.close();
    }
  });
});
