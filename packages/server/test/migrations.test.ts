import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadBundledMigrations,
  openTestDatabase,
  type Migration,
  type TestDatabase,
} from "../src/testing/index.js";

const clock = { now: () => new Date("2026-10-27T00:00:00.000Z") };
const onPostgres = process.env["BADGER_TEST_DATABASE_URL"] !== undefined;

let testDatabase: TestDatabase | undefined;

afterEach(async () => {
  await testDatabase?.drop();
  testDatabase = undefined;
});

async function freshDatabase(): Promise<TestDatabase> {
  testDatabase = await openTestDatabase();
  return testDatabase;
}

async function insertPerson(test: TestDatabase): Promise<void> {
  await test.database.query(
    `insert into people (
       id, issuer, subject, email, display_name, status, revision,
       created_at, updated_at
     ) values ('person-1', 'issuer', 'subject', 'a@example.com', 'A',
               'active', 1, $1, $1)`,
    [clock.now()],
  );
}

async function insertAuditEvent(
  test: TestDatabase,
  values: { actor: string | null; credentialKind: string; channel: string },
): Promise<void> {
  await test.database.query(
    `insert into audit_events (
       id, occurred_at, actor_person_id, credential_kind, channel, action,
       target_type, target_id, request_id
     ) values ($1, $2, $3, $4, $5, 'person.created', 'person', 'person-1',
               'request-1')`,
    [
      `event-${values.channel}-${values.credentialKind}`,
      clock.now(),
      values.actor,
      values.credentialKind,
      values.channel,
    ],
  );
}

describe("reviewed SQL migrations", () => {
  it("applies the bundled reviewed SQL and reports what ran", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
      "0007",
      "0008",
      "0009",
      "0010",
      "0011",
      "0012",
      "0013",
      "0014",
      "0015",
      "0016",
    ]);

    const state = await applyMigrations(test.database, migrations, clock);

    expect(state).toEqual({
      state: "applied",
      applied: [
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "0010",
        "0011",
        "0012",
        "0013",
        "0014",
        "0015",
        "0016",
      ],
      pending: [],
      drifted: [],
    });
    const tables = await test.database.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
        order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "answer_revisions",
      "audit_events",
      "comment_revisions",
      "concern_resolutions",
      "confirmed_facts",
      "drafting_job_decisions",
      "drafting_jobs",
      "fact_acknowledgements",
      "fact_answer_revisions",
      "gate_confirmations",
      "groups",
      "identity_sessions",
      "inbox_items",
      "oidc_transactions",
      "people",
      "person_preferences",
      "personal_access_tokens",
      "question_answers",
      "question_comments",
      "question_recipients",
      "question_resolutions",
      "question_revisions",
      "question_rounds",
      "questionnaire_concerns",
      "questionnaire_draft_revisions",
      "questionnaire_drafts",
      "questionnaire_round_snapshots",
      "questionnaire_settings",
      "questionnaires",
      "questions",
      "role_bindings",
      "schema_migrations",
      "skill_versions",
      "skills",
      "source_study_records",
      "source_study_revisions",
      "workflow_jobs",
      "workflow_skill_pins",
      "workflow_source_checks",
      "workflow_versions",
      "workflows",
    ]);
  });

  it("applies the bundled reviewed SQL only once", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(test.database, migrations, clock);

    const secondRun = await applyMigrations(test.database, migrations, clock);

    expect(secondRun).toEqual({
      state: "applied",
      applied: [
        "0001",
        "0002",
        "0003",
        "0004",
        "0005",
        "0006",
        "0007",
        "0008",
        "0009",
        "0010",
        "0011",
        "0012",
        "0013",
        "0014",
        "0015",
        "0016",
      ],
      pending: [],
      drifted: [],
    });
    const rows = await test.database.query<{ count: number }>(
      "select count(*)::int as count from schema_migrations",
    );
    expect(rows.rows[0]?.count).toBe(16);
  });

  it("adds workflow scopes without changing existing Group bindings", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0005"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      `insert into groups (id, name, created_at, updated_at) values ('group-1', 'Research', $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into role_bindings (id, scope_type, scope_id, role, person_id, email, invited_by, created_at, updated_at)
      values ('binding-1', 'group', 'group-1', 'Group lead', 'person-1', 'a@example.com', 'person-1', $1, $1)`,
      [clock.now()],
    );

    await applyMigrations(test.database, migrations, clock);

    const bindings = await test.database.query(
      `select id, scope_type, scope_id, workflow_id, role, person_id, revision from role_bindings`,
    );
    expect(bindings.rows).toEqual([
      {
        id: "binding-1",
        scope_type: "group",
        scope_id: "group-1",
        workflow_id: null,
        role: "Group lead",
        person_id: "person-1",
        revision: 1,
      },
    ]);
  });

  it("refuses a reviewed migration whose SQL changed after it was applied", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(test.database, migrations, clock);

    const edited = migrations.map((migration): Migration => ({
      ...migration,
      sql: `${migration.sql}\n-- edited after review\n`,
    }));

    await expect(applyMigrations(test.database, edited, clock)).rejects.toThrow(
      /0001/u,
    );
  });

  it("applies pending migrations in version order", async () => {
    const test = await freshDatabase();
    const migrations: Migration[] = [
      { version: "0002", name: "second", sql: "select 2;" },
      { version: "0001", name: "first", sql: "select 1;" },
    ];

    const state = await applyMigrations(test.database, migrations, clock);

    expect(state.applied).toEqual(["0001", "0002"]);
  });

  it("refuses a migration that arrives after a later one was applied", async () => {
    const test = await freshDatabase();
    await applyMigrations(
      test.database,
      [
        { version: "0001", name: "first", sql: "select 1;" },
        { version: "0002", name: "second", sql: "select 2;" },
      ],
      clock,
    );

    await expect(
      applyMigrations(
        test.database,
        [{ version: "0001", name: "first", sql: "select 1;" }],
        clock,
      ),
    ).rejects.toThrow(/0002/u);
  });

  it.skipIf(!onPostgres)(
    "applies migrations once when several servers start at once",
    async () => {
      const test = await freshDatabase();
      const servers = await Promise.all(
        Array.from({ length: 4 }, () => test.connect()),
      );
      // A slow first migration keeps every start inside it at the same time.
      const migrations: Migration[] = [
        {
          version: "0001",
          name: "slow",
          sql: "select pg_sleep(0.3); create table lock_probe (id integer);",
        },
      ];

      const states = await Promise.all(
        servers.map((server) => applyMigrations(server, migrations, clock)),
      );

      expect(states.map((state) => state.state)).toEqual([
        "applied",
        "applied",
        "applied",
        "applied",
      ]);
      const rows = await test.database.query<{ count: number }>(
        "select count(*)::int as count from schema_migrations",
      );
      expect(rows.rows[0]?.count).toBe(1);
    },
  );
});

describe("the discussion schema", () => {
  it("upgrades an existing questionnaire and keeps comment edits, concern sources, and outcomes immutable", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((m) => m.version < "0013"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('g', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      `insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at)
      values ('w', 'g', 'Workflow', 'Understand storage.', 'new-skill', 'en', $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at)
      values ('v', 'w', 1, 'Workflow', 'Understand storage.', 'new-skill', 'en', '{}', $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      "insert into question_rounds (id, workflow_version_id, number, title, created_by, created_at) values ('r', 'v', 1, 'Storage', 'person-1', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into questions (id, workflow_version_id, round_id, created_at) values ('q', 'v', 'r', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into question_revisions (question_id, revision, content, actor_id, created_at) values ('q', 1, '{\"text\":\"Original question\"}', 'person-1', $1)",
      [clock.now()],
    );
    for (const kind of ["restatement-ready", "question-reopened"]) {
      await test.database.query(
        `insert into inbox_items (id, person_id, workflow_version_id, gate, kind, event_id, question_id, created_at, updated_at)
        values ($1, 'person-1', 'v', 'questionnaire', $1, $1, 'q', $2, $2)`,
        [kind, clock.now()],
      );
    }

    await applyMigrations(test.database, migrations, clock);
    expect(
      (await test.database.query("select kind from inbox_items order by kind"))
        .rows,
    ).toEqual([{ kind: "question-reopened" }, { kind: "restatement-ready" }]);
    expect(
      (
        await test.database.query(
          "select content from question_revisions where question_id = 'q'",
        )
      ).rows,
    ).toEqual([{ content: { text: "Original question" } }]);
    await test.database.query(
      "insert into question_comments (id, question_id, person_id, position, created_at) values ('c', 'q', 'person-1', 1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into comment_revisions (comment_id, revision, text, actor_id, created_at) values ('c', 1, 'Original comment', 'person-1', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into questionnaire_concerns (id, workflow_version_id, person_id, text, created_at) values ('k', 'v', 'person-1', 'Original concern', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into concern_resolutions (concern_id, outcome, reason, actor_id, confirmation_hash, created_at) values ('k', 'declined', 'Outside scope', 'person-1', $1, $2)",
      ["a".repeat(64), clock.now()],
    );
    for (const [table, column] of [
      ["comment_revisions", "text"],
      ["questionnaire_concerns", "text"],
      ["concern_resolutions", "reason"],
    ]) {
      for (const statement of [
        `update ${table} set ${column} = 'Changed'`,
        `delete from ${table}`,
        `truncate ${table} cascade`,
      ]) {
        await expect(test.database.query(statement), statement).rejects.toThrow(
          /immutable/u,
        );
      }
    }
  });
});

describe("the audit schema", () => {
  it("keeps the audit trail append-only", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    await insertPerson(test);
    await insertAuditEvent(test, {
      actor: "person-1",
      credentialKind: "session",
      channel: "web",
    });

    for (const statement of [
      "update audit_events set reason = 'changed'",
      "delete from audit_events",
      "truncate audit_events",
    ]) {
      await expect(test.database.query(statement), statement).rejects.toThrow(
        /append-only/u,
      );
    }
  });

  it("records the worker acting on its own, and only the worker, without a person", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    await insertPerson(test);

    await insertAuditEvent(test, {
      actor: null,
      credentialKind: "worker",
      channel: "worker",
    });
    await insertAuditEvent(test, {
      actor: "person-1",
      credentialKind: "session",
      channel: "worker",
    });
    await expect(
      insertAuditEvent(test, {
        actor: null,
        credentialKind: "session",
        channel: "web",
      }),
    ).rejects.toThrow(/audit_events_actor_check/u);
    await expect(
      insertAuditEvent(test, {
        actor: "person-1",
        credentialKind: "worker",
        channel: "web",
      }),
    ).rejects.toThrow(/audit_events_worker_credential_check/u);
  });
});
