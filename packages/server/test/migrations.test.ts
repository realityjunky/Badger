import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  loadBundledMigrations,
  openTestDatabase,
  type Migration,
  type Queryable,
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
  it("reserves an audit Agent host for token credentials", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    await insertPerson(test);
    await expect(
      test.database.query(
        `insert into audit_events (
          id, occurred_at, actor_person_id, credential_kind, channel, action,
          target_type, request_id, agent_host
        ) values ('spoofed-host', $1, 'person-1', 'session', 'web',
          'person.created', 'person', 'request-1', 'spoofed-agent')`,
        [clock.now()],
      ),
    ).rejects.toThrow(/agent_host/u);
  });

  it("numbers pending sign-ins in start order, existing ones first, and bounds their return path", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version <= "0025"),
      clock,
    );
    const insert = (token: string, returnPath?: string) =>
      test.database.query(
        `insert into oidc_transactions (token_hash, state, nonce, code_verifier, expires_at${returnPath === undefined ? "" : ", return_path"})
         values ($1, 'state', 'nonce', 'verifier', $2${returnPath === undefined ? "" : ", $3"})`,
        [token, clock.now(), ...(returnPath === undefined ? [] : [returnPath])],
      );
    await insert("pending-before-upgrade");
    await applyMigrations(test.database, migrations, clock);
    await insert("started-after-upgrade", `/${"a".repeat(2047)}`);
    await expect(
      insert("oversized-return-path", `/${"a".repeat(2048)}`),
    ).rejects.toThrow(/return_path/u);
    const rows = await test.database.query<{
      token_hash: string;
      sequence: string;
      return_path: string | null;
    }>(
      "select token_hash, sequence::text as sequence, return_path from oidc_transactions order by sequence",
    );
    expect(rows.rows.map((row) => [row.token_hash, row.return_path])).toEqual([
      ["pending-before-upgrade", null],
      ["started-after-upgrade", `/${"a".repeat(2047)}`],
    ]);
    expect(Number(rows.rows[0]!.sequence)).toBeLessThan(
      Number(rows.rows[1]!.sequence),
    );
  });

  it("upgrades uploaded versions unchanged and preserves immutable repository provenance", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version <= "0023"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('group-1', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into skills (id, group_id, name, created_by, created_at) values ('skill-1', 'group-1', 'example', 'person-1', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into skill_versions (skill_id, hash, description, inventory, scripts, origin, uploaded_by, created_at) values ('skill-1', $1, 'Uploaded', '[]', '[]', 'upload', 'person-1', $2)",
      ["a".repeat(64), clock.now()],
    );
    const previous = (await test.database.query("select * from skill_versions"))
      .rows;
    await applyMigrations(test.database, migrations, clock);
    expect(
      (await test.database.query("select * from skill_versions")).rows,
    ).toEqual(previous);
    await test.database.query(
      "insert into skill_repositories (id, skill_id, url, registered_by, created_at) values ('repo-1', 'skill-1', 'https://example.com/skill.git', 'person-1', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into skill_version_git_origins (skill_id, hash, repository_id, repository, commit_hash, imported_by, created_at) values ('skill-1', $1, 'repo-1', 'https://example.com/skill.git', $2, 'person-1', $3)",
      ["a".repeat(64), "b".repeat(40), clock.now()],
    );
    for (const table of [
      "skill_versions",
      "skill_repositories",
      "skill_version_git_origins",
    ]) {
      for (const statement of [
        `delete from ${table}`,
        `truncate ${table} cascade`,
      ])
        await expect(test.database.query(statement)).rejects.toThrow(
          /immutable/u,
        );
    }
    await expect(
      test.database.query(
        "update skill_version_git_origins set commit_hash = $1",
        ["c".repeat(40)],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      test.database.query(
        "update skill_repositories set url = 'https://other.example/repo' ",
      ),
    ).rejects.toThrow(/immutable/u);
  });
  it("upgrades existing versions and keeps inheritance provenance and receipt links immutable", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((m) => m.version <= "0022"),
      clock,
    );
    const previous = await test.database.query(
      "select version, checksum from schema_migrations order by version",
    );
    await applyMigrations(test.database, migrations, clock);
    expect(
      (
        await test.database.query(
          "select version, checksum from schema_migrations where version <= '0022' order by version",
        )
      ).rows,
    ).toEqual(previous.rows);
    for (const table of [
      "workflow_record_origins",
      "inherited_answer_attachments",
    ]) {
      for (const statement of [`delete from ${table}`, `truncate ${table}`])
        await expect(test.database.query(statement)).rejects.toThrow(
          /immutable/u,
        );
    }
    await expect(
      test.database.query(
        "update workflow_record_origins set source_revision = 99",
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      test.database.query(
        "update inherited_answer_attachments set attachment_id = 'other'",
      ),
    ).rejects.toThrow(/immutable/u);
  });
  it("keeps plan artifacts and their heads immutable after upgrading the existing drafting schema", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version <= "0018"),
      clock,
    );
    await applyMigrations(test.database, migrations, clock);
    for (const statement of [
      "update plan_versions set canonical_json = '{}'",
      "delete from plan_versions",
      "truncate plan_versions cascade",
      "update plan_heads set sequence = sequence + 1",
      "delete from plan_heads",
      "truncate plan_heads",
    ])
      await expect(test.database.query(statement), statement).rejects.toThrow(
        /immutable/u,
      );
  });
  it("adds drafting jobs after the applied dossier migration without changing existing audit records", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version <= "0016"),
      clock,
    );
    await insertPerson(test);
    await insertAuditEvent(test, {
      actor: "person-1",
      credentialKind: "session",
      channel: "web",
    });
    const previous = await test.database.query(
      "select version, checksum from schema_migrations order by version",
    );

    const upgraded = await applyMigrations(test.database, migrations, clock);

    expect(upgraded.applied.at(-1)).toBe("0028");
    expect(
      (
        await test.database.query(
          "select version, checksum from schema_migrations where version <= '0016' order by version",
        )
      ).rows,
    ).toEqual(previous.rows);
    expect(
      (
        await test.database.query(
          "select action, actor_person_id, agent_host, notification_action_id from audit_events",
        )
      ).rows,
    ).toEqual([
      {
        action: "person.created",
        actor_person_id: "person-1",
        agent_host: null,
        notification_action_id: null,
      },
    ]);
  });
  it("imports a numbered source question into each workflow version only once", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    await insertPerson(test);
    const hash = "a".repeat(64);
    for (const [sql, params] of [
      [
        "insert into groups (id, name, created_at, updated_at) values ('group-1', 'Research', $1, $1)",
        [clock.now()],
      ],
      [
        "insert into skills (id, group_id, name, created_by, created_at) values ('skill-1', 'group-1', 'example', 'person-1', $1)",
        [clock.now()],
      ],
      [
        "insert into skill_versions (skill_id, hash, description, inventory, scripts, origin, uploaded_by, created_at) values ('skill-1', $1, 'Uploaded', '[]', '[]', 'upload', 'person-1', $2)",
        [hash, clock.now()],
      ],
      [
        "insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at) values ('workflow-1', 'group-1', 'example', 'Goal', 'new-skill', 'en', $1, $1)",
        [clock.now()],
      ],
      ...["version-1", "version-2"].map(
        (id, index) =>
          [
            "insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at) values ($1, 'workflow-1', $2, 'example', 'Goal', 'new-skill', 'en', '{}', $3, $3)",
            [id, index + 1, clock.now()],
          ] as const,
      ),
      ...["version-1", "version-2"].map(
        (version) =>
          [
            "insert into question_rounds (id, workflow_version_id, number, title, created_by, created_at) values ($1, $2, 1, 'Imports', 'person-1', $3)",
            [`round-${version}`, version, clock.now()],
          ] as const,
      ),
      ...["version-1", "version-2"].map(
        (version) =>
          [
            "insert into drafting_jobs (id, workflow_version_id, kind, round_id, skill_id, requester_id, context_bundle, context_hash, input_hash, output_schema, created_at, updated_at) values ($1, $2, 'import-open-questions', $3, 'skill-1', 'person-1', '{}', $4, $4, '{}', $5, $5)",
            [`job-${version}`, version, `round-${version}`, hash, clock.now()],
          ] as const,
      ),
      ...[
        ["question-1", "version-1"],
        ["question-2", "version-1"],
        ["question-3", "version-2"],
      ].flatMap(([id, version]) => [
        [
          "insert into questions (id, workflow_version_id, round_id, created_at) values ($1, $2, $3, $4)",
          [id, version, `round-${version}`, clock.now()],
        ] as const,
        [
          "insert into question_revisions (question_id, revision, content, actor_id, created_at) values ($1, 1, '{}', 'person-1', $2)",
          [id, clock.now()],
        ] as const,
      ]),
    ] as const)
      await test.database.query(sql, [...params]);
    const source = JSON.stringify({
      skillId: "skill-1",
      hash,
      path: "reference/questions.md",
      startLine: 3,
      endLine: 3,
      fileHash: hash,
    });
    const importQuestion = (question: string, version: string, number = 1) =>
      test.database.query(
        "insert into question_imports (question_id, workflow_version_id, question_revision, skill_id, skill_version_hash, source_number, evidence, job_id) values ($1, $2, 1, 'skill-1', $3, $4, $5, $6)",
        [question, version, hash, number, source, `job-${version}`],
      );
    await importQuestion("question-1", "version-1");
    await expect(importQuestion("question-2", "version-1")).rejects.toThrow(
      /question_imports_source_idx/u,
    );
    // An import names its own question's workflow version.
    await expect(importQuestion("question-3", "version-1", 2)).rejects.toThrow(
      /foreign key/u,
    );
    await importQuestion("question-2", "version-1", 2);
    await importQuestion("question-3", "version-2");
  });
  it("refuses rewriting or deleting canonical dossier artifacts and their heads", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    for (const statement of [
      "update dossier_versions set canonical_json = '{}'",
      "delete from dossier_versions",
      "truncate dossier_versions cascade",
      "update dossier_heads set sequence = sequence + 1",
      "delete from dossier_heads",
      "truncate dossier_heads",
    ])
      await expect(test.database.query(statement), statement).rejects.toThrow(
        /immutable/u,
      );
  });
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
      "0017",
      "0018",
      "0019",
      "0020",
      "0021",
      "0022",
      "0023",
      "0024",
      "0025",
      "0026",
      "0027",
      "0028",
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
        "0017",
        "0018",
        "0019",
        "0020",
        "0021",
        "0022",
        "0023",
        "0024",
        "0025",
        "0026",
        "0027",
        "0028",
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
      "accepted_authoring_outputs",
      "answer_attachments",
      "answer_revisions",
      "audit_events",
      "authoring_follow_ups",
      "comment_revisions",
      "concern_resolutions",
      "confirmed_facts",
      "dossier_heads",
      "dossier_versions",
      "drafting_job_decisions",
      "drafting_jobs",
      "fact_acknowledgements",
      "fact_answer_revisions",
      "gate_confirmations",
      "groups",
      "identity_sessions",
      "inbox_items",
      "inherited_answer_attachments",
      "notification_actions",
      "notification_channels",
      "notification_deliveries",
      "notification_reminders",
      "notification_robots",
      "oidc_transactions",
      "package_assembly_requests",
      "people",
      "person_notification_preferences",
      "person_preferences",
      "personal_access_tokens",
      "plan_heads",
      "plan_versions",
      "question_answers",
      "question_comments",
      "question_imports",
      "question_recipients",
      "question_resolutions",
      "question_revisions",
      "question_rounds",
      "question_translations",
      "questionnaire_concerns",
      "questionnaire_draft_revisions",
      "questionnaire_drafts",
      "questionnaire_round_snapshots",
      "questionnaire_settings",
      "questionnaires",
      "questions",
      "role_bindings",
      "schema_migrations",
      "skill_repositories",
      "skill_version_git_origins",
      "skill_versions",
      "skills",
      "source_study_records",
      "source_study_revisions",
      "workflow_jobs",
      "workflow_kernel_states",
      "workflow_packages",
      "workflow_record_origins",
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
        "0017",
        "0018",
        "0019",
        "0020",
        "0021",
        "0022",
        "0023",
        "0024",
        "0025",
        "0026",
        "0027",
        "0028",
      ],
      pending: [],
      drifted: [],
    });
    const rows = await test.database.query<{ count: number }>(
      "select count(*)::int as count from schema_migrations",
    );
    expect(rows.rows[0]?.count).toBe(28);
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

describe("the notification schema", () => {
  it("gives each transaction a fresh action identity that restored records cannot collide with", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    await insertPerson(test);
    await test.database.query(
      `insert into people (
         id, issuer, subject, email, display_name, status, revision,
         created_at, updated_at
       ) values ('person-2', 'issuer', 'subject-2', 'b@example.com', 'B',
                 'active', 1, $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('group-1', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      `insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at)
       values ('workflow-1', 'group-1', 'sample', 'Goal', 'new-skill', 'en', $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at)
       values ('version-1', 'workflow-1', 1, 'sample', 'Goal', 'new-skill', 'en', '{}', $1, $1)`,
      [clock.now()],
    );
    // A restore into a fresh cluster restarts its transaction counter, while
    // restored rows keep the identities their own transactions gave them.
    const { next } = (
      await test.database.query<{ next: string }>(
        "select (txid_current() + 1)::text as next",
      )
    ).rows[0]!;
    const restored = Array.from({ length: 50 }, (_, offset) =>
      (BigInt(next) + BigInt(offset)).toString(),
    );
    await test.database.query(
      `insert into notification_actions (id, created_at, processed_at)
       select id, $2, $2 from unnest($1::text[]) as id`,
      [restored, clock.now()],
    );
    await test.database.query(
      `insert into audit_events (id, occurred_at, actor_person_id, credential_kind, channel,
         action, target_type, target_id, request_id, notification_action_id)
       select 'restored-' || id, $2, 'person-1', 'session', 'web', 'question.published',
         'question', 'question-old', 'request-old', id from unnest($1::text[]) as id`,
      [restored, clock.now()],
    );

    const insertItem = (tx: Queryable, id: string, personId: string) =>
      tx.query(
        `insert into inbox_items (id, person_id, workflow_version_id, gate, kind, event_id, created_at, updated_at)
         values ($1, $2, 'version-1', 'dossier', 'gate-ready', $1, $3, $3)`,
        [id, personId, clock.now()],
      );
    // One action: its audit record and every inbox item it creates.
    await test.database.transaction(async (tx) => {
      await tx.query(
        `insert into audit_events (id, occurred_at, actor_person_id, credential_kind, channel,
           action, target_type, target_id, request_id)
         values ('event-new', $1, 'person-2', 'session', 'web', 'question.published',
           'question', 'question-new', 'request-new')`,
        [clock.now()],
      );
      await insertItem(tx, "item-1", "person-1");
      await insertItem(tx, "item-2", "person-2");
    });
    await insertItem(test.database, "item-3", "person-1");

    const items = (
      await test.database.query<{ id: string; action: string }>(
        "select id, notification_action_id as action from inbox_items order by id",
      )
    ).rows;
    const audited = (
      await test.database.query<{ action: string }>(
        "select notification_action_id as action from audit_events where id = 'event-new'",
      )
    ).rows[0]!;
    expect(items[1]!.action).toBe(items[0]!.action);
    expect(audited.action).toBe(items[0]!.action);
    expect(items[2]!.action).not.toBe(items[0]!.action);
    // Both new actions wait to be routed; neither was mistaken for a restored one.
    expect(
      (
        await test.database.query<{ id: string }>(
          "select id from notification_actions where processed_at is null",
        )
      ).rows
        .map((row) => row.id)
        .sort(),
    ).toEqual([items[0]!.action, items[2]!.action].sort());
    // Only the new action's own actor is its requester.
    expect(
      (
        await test.database.query(
          `select distinct actor_person_id from audit_events
           where notification_action_id = any($1::text[])`,
          [items.map((item) => item.action)],
        )
      ).rows,
    ).toEqual([{ actor_person_id: "person-2" }]);
    for (const item of items) expect(restored).not.toContain(item.action);
  });
});
