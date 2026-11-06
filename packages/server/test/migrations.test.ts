import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  planningFixture,
  admin,
  engineer,
  owner,
} from "./fixtures/planning.js";
import {
  applyMigrations,
  loadBundledMigrations,
  openTestDatabase,
  startTestService,
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
  it("preserves active Agent claims while adding bounded dashboard session ownership", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0047"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('session-group', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at) values ('session-workflow', 'session-group', 'Sessions', 'Study', 'new-skill', 'en', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at) values ('session-version', 'session-workflow', 1, 'Sessions', 'Study', 'new-skill', 'en', '{}', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into drafting_jobs (id, workflow_version_id, kind, requester_id, context_bundle, context_hash, input_hash, output_schema, status, revision, lease_id, lease_person_id, lease_agent_host, lease_until, created_at, updated_at) values ('session-job', 'session-version', 'draft-plan', 'person-1', '{}', $1, $1, '{}', 'claimed', 2, 'old-lease', 'person-1', 'old-host', $2, $3, $3)",
      [
        "a".repeat(64),
        new Date(clock.now().getTime() + 30 * 60_000),
        clock.now(),
      ],
    );
    const before = (await test.database.query("select * from drafting_jobs"))
      .rows[0];
    await applyMigrations(test.database, migrations, clock);
    const after = (
      await test.database.query<Record<string, unknown>>(
        "select * from drafting_jobs",
      )
    ).rows[0]!;
    const { lease_kind, lease_activity_at, ...original } = after;
    expect(original).toEqual(before);
    expect(lease_kind).toBe("agent");
    expect(new Date(lease_activity_at as string).getTime()).toBe(
      clock.now().getTime(),
    );
    await expect(
      test.database.query("update drafting_jobs set lease_kind = null"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("preserves saved prompt template revisions while allowing the head to advance", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    await insertPerson(test);
    await test.database.query(
      "insert into prompt_template_heads (template_id, revision) values ('source-study', 1)",
    );
    await test.database.query(
      "insert into prompt_template_revisions (template_id, revision, body, content_hash, person_id, created_at) values ('source-study', 1, 'Read the target Skill.', $1, 'person-1', $2)",
      ["a".repeat(64), clock.now()],
    );
    for (const statement of [
      "update prompt_template_revisions set body = 'Changed history'",
      "delete from prompt_template_revisions",
      "truncate prompt_template_revisions",
    ])
      await expect(test.database.query(statement)).rejects.toThrow(
        /immutable/u,
      );
    await test.database.query(
      "update prompt_template_heads set revision = 2 where template_id = 'source-study'",
    );
    expect(
      (await test.database.query("select body from prompt_template_revisions"))
        .rows,
    ).toEqual([{ body: "Read the target Skill." }]);
  });

  it("requires resolving duplicate Engineer assignments before enforcing one assignment including pending invitations", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0042"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('engineer-group', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at) values ('engineer-workflow', 'engineer-group', 'Engineers', 'Study sources', 'new-skill', 'en', $1, $1)",
      [clock.now()],
    );
    for (const bindingId of ["first", "second"])
      await test.database.query(
        "insert into role_bindings (id, scope_type, role, email, invited_by, workflow_id, created_at, updated_at) values ($1, 'workflow', 'Engineer', $2, 'person-1', 'engineer-workflow', $3, $3)",
        [bindingId, `${bindingId}@example.com`, clock.now()],
      );
    const before = (
      await test.database.query<{ id: string }>(
        "select * from role_bindings order by id",
      )
    ).rows;
    await expect(
      applyMigrations(test.database, migrations, clock),
    ).rejects.toThrow(/more than one Engineer/u);
    expect(
      (await test.database.query("select * from role_bindings order by id"))
        .rows,
    ).toEqual(before);
    await test.database.query("delete from role_bindings where id = 'second'");
    await applyMigrations(test.database, migrations, clock);
    expect(
      (await test.database.query("select * from role_bindings order by id"))
        .rows,
    ).toEqual(before.filter((row) => row.id === "first"));
    await expect(
      test.database.query(
        "insert into role_bindings (id, scope_type, role, email, invited_by, workflow_id, created_at, updated_at) values ('third', 'workflow', 'Engineer', 'third@example.com', 'person-1', 'engineer-workflow', $1, $1)",
        [clock.now()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("preserves submitted Agent results during review migration and keeps saved review revisions immutable", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0043"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('review-group', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at) values ('review-workflow', 'review-group', 'Reviews', 'Study sources', 'new-skill', 'en', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at) values ('review-version', 'review-workflow', 1, 'Reviews', 'Study sources', 'new-skill', 'en', '{}', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into question_rounds (id, workflow_version_id, number, title, created_by, created_at) values ('review-round', 'review-version', 1, 'Review', 'person-1', $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into drafting_jobs (id, workflow_version_id, kind, round_id, requester_id, context_bundle, context_hash, input_hash, output_schema, status, revision, result, result_hash, created_at, updated_at) values ('review-job', 'review-version', 'draft-questions', 'review-round', 'person-1', '{}', $1, $1, '{}', 'submitted', 3, '{\"questions\": []}', $1, $2, $2)",
      ["a".repeat(64), clock.now()],
    );
    const before = (await test.database.query("select * from drafting_jobs"))
      .rows[0];
    await applyMigrations(test.database, migrations, clock);
    const after = (
      await test.database.query<Record<string, unknown>>(
        "select * from drafting_jobs",
      )
    ).rows[0]!;
    const {
      review_result,
      review_hash,
      review_person_id,
      review_updated_at,
      review_revision,
      lease_kind,
      lease_activity_at,
      ...original
    } = after;
    expect(original).toEqual(before);
    expect([lease_kind, lease_activity_at]).toEqual([null, null]);
    expect([
      review_result,
      review_hash,
      review_person_id,
      review_updated_at,
      review_revision,
    ]).toEqual([null, null, null, null, 0]);
    await expect(
      test.database.query(
        "update drafting_jobs set review_result = '{}' where id = 'review-job'",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await test.database.query(
      "insert into drafting_job_review_revisions (job_id, revision, result, result_hash, person_id, created_at) values ('review-job', 4, '{\"questions\": []}', $1, 'person-1', $2)",
      ["b".repeat(64), clock.now()],
    );
    for (const statement of [
      "update drafting_job_review_revisions set result = '{}'",
      "delete from drafting_job_review_revisions",
      "truncate drafting_job_review_revisions",
    ])
      await expect(test.database.query(statement)).rejects.toThrow(
        /immutable/u,
      );
  });

  it("adds optional labels without rewriting legacy iterations and enforces their storage constraints", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0041"),
      clock,
    );
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('labels-group', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      "insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at) values ('labels-workflow', 'labels-group', 'labels', 'Review source Skills.', 'new-skill', 'en', $1, $1)",
      [clock.now()],
    );
    for (const number of [1, 2])
      await test.database.query(
        "insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at) values ($1, 'labels-workflow', $2, 'labels', 'Review source Skills.', 'new-skill', 'en', '{}', $3, $3)",
        [`labels-${number}`, number, clock.now()],
      );
    const before = (
      await test.database.query(
        "select * from workflow_versions order by number",
      )
    ).rows;
    await applyMigrations(test.database, migrations, clock);
    const after = (
      await test.database.query<Record<string, unknown>>(
        "select * from workflow_versions order by number",
      )
    ).rows;
    expect(
      after.map(({ semantic_version, label_revision, ...version }) => {
        expect(semantic_version).toBeNull();
        expect(label_revision).toBe(0);
        return version;
      }),
    ).toEqual(before);
    await test.database.query(
      "update workflow_versions set semantic_version = '0.1.0' where id = 'labels-1'",
    );
    await expect(
      test.database.query(
        "update workflow_versions set semantic_version = '0.1.0' where id = 'labels-2'",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    for (const label of [
      "1.2",
      "01.2.3",
      "1.2.03",
      "1.2.3-beta",
      "1.2.3\n",
      "1".repeat(61) + ".0.0",
    ])
      await expect(
        test.database.query(
          "update workflow_versions set semantic_version = $1 where id = 'labels-2'",
          [label],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      test.database.query(
        "update workflow_versions set label_revision = -1 where id = 'labels-1'",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await test.database.query(
      "update workflow_versions set semantic_version = null",
    );
    expect(
      (
        await test.database.query(
          "select semantic_version from workflow_versions",
        )
      ).rows,
    ).toEqual([{ semantic_version: null }, { semantic_version: null }]);
  });

  it("preserves legacy declarations and provider provenance as pending history and retires encrypted configuration without creating attestations", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0039"),
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
    const hash = "a".repeat(64);
    const scripts = [{ path: "scripts/run.sh", sideEffects: ["local-writes"] }];
    await test.database.query(
      "insert into skill_versions (skill_id, hash, description, inventory, scripts, origin, uploaded_by, created_at) values ('skill-1', $1, 'Uploaded', '[]', $2, 'upload', 'person-1', $3)",
      [hash, JSON.stringify(scripts), clock.now()],
    );
    await test.database.query(
      "insert into llm_configuration (revision, configuration, content_hash, updated_at) values (5, $1, $2, $3)",
      [
        JSON.stringify({
          provider: "historical-provider",
          task: "upload-effects",
        }),
        "b".repeat(64),
        clock.now(),
      ],
    );
    await test.database.query(
      "insert into llm_secrets (reference, ciphertext) values ('upload-provider', 'encrypted-upload-secret'), ('unrelated-reference', 'encrypted-other-secret')",
    );
    await test.database.query(
      `insert into skill_suggestion_previews (id, skill_id, person_id, source_hash, configuration_revision, binding, evidence, status, result, expires_at)
       values ('preview-1', 'skill-1', 'person-1', $1, 5, '{}', '{"provider":"historical-provider"}', 'finished', '{"scripts":[]}', $2)`,
      [hash, clock.now()],
    );
    const original = (await test.database.query("select * from skill_versions"))
      .rows;
    const configuration = (
      await test.database.query("select * from llm_configuration")
    ).rows;
    const secrets = (
      await test.database.query("select * from llm_secrets order by reference")
    ).rows;
    const provenance = (
      await test.database.query("select * from skill_suggestion_previews")
    ).rows;
    await applyMigrations(test.database, migrations, clock);
    expect(
      (await test.database.query("select * from skill_versions")).rows,
    ).toEqual(original);
    const history = (
      await test.database.query<{
        kind: string;
        actor_id: string;
        content: {
          scripts: {
            effects: string[];
            reviewed: boolean;
            evidence: unknown[];
          }[];
        };
      }>("select * from script_effect_revisions")
    ).rows;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: "legacy",
      actor_id: "person-1",
      content: {
        scripts: [
          {
            effects: ["local-writes"],
            reviewed: false,
            evidence: [],
            uncertaintyAnswer: "",
          },
        ],
      },
    });
    expect(
      (await test.database.query("select * from script_effect_confirmations"))
        .rows,
    ).toEqual([]);
    expect(
      (await test.database.query("select * from retired_llm_configuration"))
        .rows,
    ).toEqual(configuration);
    expect(
      (
        await test.database.query(
          "select * from retired_llm_secrets order by reference",
        )
      ).rows,
    ).toEqual(secrets);
    expect(
      (
        await test.database.query(
          "select * from retired_skill_suggestion_previews",
        )
      ).rows,
    ).toEqual(provenance);
    for (const table of [
      "script_effect_revisions",
      "script_effect_confirmations",
      "retired_llm_configuration",
      "retired_llm_secrets",
      "retired_skill_suggestion_previews",
    ])
      await expect(test.database.query(`delete from ${table}`)).rejects.toThrow(
        /append-only|offline archive/u,
      );
    await expect(
      test.database.query(
        "insert into retired_llm_secrets (reference, ciphertext) values ('new-provider', 'encrypted-new-key')",
      ),
    ).rejects.toThrow(/offline archive/u);
  });

  it("merges resolved and pending Reviewers into Workflow owners without losing invitation references", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((migration) => migration.version < "0037"),
      clock,
    );
    await insertPerson(test);
    await test.database.query(
      `insert into people (id, issuer, subject, email, display_name, status, revision, created_at, updated_at)
       values ('person-2', 'issuer', 'second', 'second@example.com', 'Second', 'active', 1, $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      "insert into groups (id, name, created_at, updated_at) values ('group-1', 'Research', $1, $1)",
      [clock.now()],
    );
    await test.database.query(
      `insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at)
       values ('workflow-1', 'group-1', 'First', 'Prepare a report', 'new-skill', 'en', $1, $1),
              ('workflow-2', 'group-1', 'Second', 'Prepare a report', 'new-skill', 'en', $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at)
       values ('version-1', 'workflow-1', 1, 'First', 'Prepare a report', 'new-skill', 'en', '{}', $1, $1)`,
      [clock.now()],
    );
    for (const [id, role, personId, email, workflowId] of [
      [
        "resolved-owner",
        "Workflow owner",
        "person-1",
        "a@example.com",
        "workflow-1",
      ],
      [
        "resolved-reviewer",
        "Reviewer",
        "person-1",
        "old@example.com",
        "workflow-1",
      ],
      [
        "other-workflow-reviewer",
        "Reviewer",
        "person-1",
        "a@example.com",
        "workflow-2",
      ],
      [
        "resolved-reviewer-only",
        "Reviewer",
        "person-2",
        "second@example.com",
        "workflow-1",
      ],
      [
        "pending-owner",
        "Workflow owner",
        null,
        "Pending@example.com",
        "workflow-1",
      ],
      [
        "pending-reviewer",
        "Reviewer",
        null,
        "pending@example.com",
        "workflow-1",
      ],
      [
        "pending-reviewer-only",
        "Reviewer",
        null,
        "later@example.com",
        "workflow-1",
      ],
      ["pending-same-email", "Reviewer", null, "a@example.com", "workflow-1"],
      [
        "different-person-same-email",
        "Reviewer",
        "person-2",
        "a@example.com",
        "workflow-2",
      ],
    ]) {
      await test.database.query(
        `insert into role_bindings (id, scope_type, scope_id, workflow_id, role, person_id, email, invited_by, created_at, updated_at)
         values ($1, 'workflow', null, $2, $3, $4, $5, 'person-1', $6, $6)`,
        [id, workflowId, role, personId, email, clock.now()],
      );
    }
    await test.database.query(
      `insert into role_bindings (id, scope_type, scope_id, role, person_id, email, invited_by, created_at, updated_at)
       values ('organization-auditor', 'organization', null, 'Auditor', 'person-1', 'a@example.com', 'person-1', $1, $1),
              ('group-member', 'group', 'group-1', 'Member', 'person-1', 'a@example.com', 'person-1', $1, $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into question_rounds (id, workflow_version_id, number, title, created_by, created_at)
       values ('round-1', 'version-1', 1, 'Questions', 'person-1', $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into questions (id, workflow_version_id, round_id, created_at)
       values ('question-1', 'version-1', 'round-1', $1)`,
      [clock.now()],
    );
    await test.database.query(
      `insert into question_recipients (question_id, binding_id)
       values ('question-1', 'pending-owner'), ('question-1', 'pending-reviewer'),
              ('question-1', 'resolved-reviewer')`,
    );
    for (const [id, bindingId, eventId] of [
      ["owner-inbox", "pending-owner", "shared"],
      ["duplicate-inbox", "pending-reviewer", "shared"],
      ["moved-inbox", "pending-reviewer", "unique"],
      ["retained-inbox", "pending-reviewer-only", "sole"],
    ])
      await test.database.query(
        `insert into inbox_items (id, binding_id, workflow_version_id, gate, kind, event_id, created_at, updated_at)
         values ($1, $2, 'version-1', 'package', 'gate-ready', $3, $4, $4)`,
        [id, bindingId, eventId, clock.now()],
      );

    await applyMigrations(test.database, migrations, clock);
    expect(
      (
        await test.database.query(
          "select id from role_bindings where role='Reviewer'",
        )
      ).rows,
    ).toEqual([]);
    const owners = await test.database.query<{
      id: string;
      role: string;
      revision: number;
      person_id: string | null;
    }>(
      "select id, role, revision, person_id from role_bindings where scope_type='workflow' order by id",
    );
    expect(owners.rows).toEqual([
      {
        id: "different-person-same-email",
        role: "Workflow owner",
        revision: 2,
        person_id: "person-2",
      },
      {
        id: "other-workflow-reviewer",
        role: "Workflow owner",
        revision: 2,
        person_id: "person-1",
      },
      {
        id: "pending-owner",
        role: "Workflow owner",
        revision: 1,
        person_id: null,
      },
      {
        id: "pending-reviewer-only",
        role: "Workflow owner",
        revision: 2,
        person_id: null,
      },
      {
        id: "pending-same-email",
        role: "Workflow owner",
        revision: 2,
        person_id: null,
      },
      {
        id: "resolved-owner",
        role: "Workflow owner",
        revision: 1,
        person_id: "person-1",
      },
      {
        id: "resolved-reviewer-only",
        role: "Workflow owner",
        revision: 2,
        person_id: "person-2",
      },
    ]);
    expect(
      (
        await test.database.query(
          "select binding_id from question_recipients order by binding_id",
        )
      ).rows,
    ).toEqual([
      { binding_id: "pending-owner" },
      { binding_id: "resolved-owner" },
    ]);
    expect(
      (
        await test.database.query(
          "select id, binding_id from inbox_items order by id",
        )
      ).rows,
    ).toEqual([
      { id: "moved-inbox", binding_id: "pending-owner" },
      { id: "owner-inbox", binding_id: "pending-owner" },
      { id: "retained-inbox", binding_id: "pending-reviewer-only" },
    ]);
    expect(
      (
        await test.database.query(
          "select role, revision from role_bindings where scope_type <> 'workflow' order by role",
        )
      ).rows,
    ).toEqual([
      { role: "Auditor", revision: 1 },
      { role: "Member", revision: 1 },
    ]);
    await expect(
      test.database.query(
        `insert into role_bindings (id, scope_type, workflow_id, role, email, invited_by, created_at, updated_at)
       values ('retired', 'workflow', 'workflow-1', 'Reviewer', 'retired@example.com', 'person-1', $1, $1)`,
        [clock.now()],
      ),
    ).rejects.toThrow(/role_bindings_scope_role_check/u);
    await applyMigrations(test.database, migrations, clock);
    expect(
      (
        await test.database.query(
          "select id, role, revision, person_id from role_bindings where scope_type='workflow' order by id",
        )
      ).rows,
    ).toEqual(owners.rows);
  });

  it("rotates historical failed attachment cleanup behind untried blobs", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((m) => m.version < "0036"),
      clock,
    );
    await test.database.query(
      "insert into attachment_blob_cleanup(hash) values ($1),($2)",
      ["a".repeat(64), "b".repeat(64)],
    );
    await applyMigrations(test.database, migrations, clock);
    await test.database.query(
      "update attachment_blob_cleanup set last_attempt_at=$1 where hash=$2",
      [clock.now(), "a".repeat(64)],
    );
    expect(
      (
        await test.database.query<{ hash: string }>(
          "select hash from attachment_blob_cleanup order by last_attempt_at nulls first, hash",
        )
      ).rows.map((r) => r.hash),
    ).toEqual(["b".repeat(64), "a".repeat(64)]);
  });
  it("reads legacy dossier history without storage paths and requires a new approval", async () => {
    const test = await freshDatabase();
    const service = await startTestService({
      database: test,
      environment: {
        BADGER_BOOTSTRAP_ADMINISTRATORS: admin.email,
        BADGER_ALLOWED_ORIGINS: "http://localhost",
      },
    });
    try {
      const { call, base, version, approve } = await planningFixture(service);
      const approved = await approve("dossier", owner);
      const { versions } = await call(`${base}/dossier`);
      const { person } = await call("/me");
      const { secret } = await call(
        "/me/tokens",
        "POST",
        { name: "Legacy planner", scopes: ["engineer"] },
        engineer,
        201,
      );
      const snapshot = versions[0].snapshot;
      snapshot.dossier.sources[0].canonicalPath =
        "/previous-server/private-storage/workflow/skills/prepare";
      const text = JSON.stringify(snapshot);
      const hash = createHash("sha256").update(text).digest("hex");
      await test.database.query(
        `insert into drafting_jobs (id, workflow_version_id, kind, requester_id, context_bundle, context_hash, input_hash, output_schema, created_at, updated_at)
        values ('legacy-job', $1, 'draft-plan', $2, $3::jsonb, $4, $4, '{}', $5, $5)`,
        [
          version.id,
          person.id,
          JSON.stringify({
            planning: { input: { dossier: snapshot.dossier } },
          }),
          "a".repeat(64),
          clock.now(),
        ],
      );
      const planSnapshot = {
        schemaVersion: 1,
        kind: "badger-plan-version",
        workflowVersionId: version.id,
        dossierHash: hash,
        plan: { semanticDossier: snapshot.dossier },
      };
      await test.database.query(
        `insert into dossier_versions (id, workflow_version_id, number, hash, canonical_json, created_by, created_at)
        values ('legacy-dossier', $1, 2, $2, $3, $4, $5)`,
        [version.id, hash, text, versions[0].createdBy, clock.now()],
      );
      await test.database.query(
        `insert into plan_versions (id, workflow_version_id, number, dossier_hash, hash, canonical_json, created_by, created_at)
        values ('legacy-plan', $1, 1, $2, $3, $4, $5, $6)`,
        [
          version.id,
          hash,
          "b".repeat(64),
          JSON.stringify(planSnapshot),
          person.id,
          clock.now(),
        ],
      );
      await test.database.query(
        `insert into dossier_heads (id, workflow_version_id, sequence, dossier_hash, selected_by, selected_at)
        values ('legacy-head', $1, 2, $2, $3, $4)`,
        [version.id, hash, versions[0].createdBy, clock.now()],
      );
      const confirmation = {
        ...approved.confirmation,
        boundHashes: { ...approved.confirmation.boundHashes, dossier: hash },
      };
      await test.database.query(
        "update gate_confirmations set bound_hashes = $2::jsonb, result = $3::jsonb where id = $1",
        [
          confirmation.id,
          JSON.stringify(confirmation.boundHashes),
          JSON.stringify({ confirmation }),
        ],
      );
      const history = await call(`${base}/dossier`);
      expect(history.currentVersionId).toBeNull();
      expect(history.versions[0]).toMatchObject({
        hash,
        canonicalJson: null,
        requiresRecomposition: true,
      });
      expect(
        history.versions[0].snapshot.dossier.sources[0],
      ).not.toHaveProperty("canonicalPath");
      expect(JSON.stringify(history)).not.toContain("/previous-server");
      const plans = await call(`${base}/plan`);
      expect(plans.skeleton).toBeNull();
      expect(plans.versions[0]).toMatchObject({
        canonicalJson: null,
        requiresRecomposition: true,
      });
      expect(JSON.stringify(plans)).not.toContain("/previous-server");
      const claim = await call(
        `${base}/drafting-jobs/legacy-job/claim`,
        "POST",
        { revision: 1 },
        engineer,
        409,
        secret,
      );
      expect(claim.job).toMatchObject({
        status: "cancelled",
        outputLocale: null,
      });
      expect(claim).not.toHaveProperty("contextBundle");
      expect(JSON.stringify(claim)).not.toContain("/previous-server");
      const rejected = await call(
        `${base}/gates/dossier/preview`,
        "POST",
        {},
        owner,
        409,
      );
      expect(JSON.stringify(rejected)).toContain("requires recomposition");
      expect(
        (
          await test.database.query<{ canonical_json: string }>(
            "select canonical_json from dossier_versions where id = 'legacy-dossier'",
          )
        ).rows[0]!.canonical_json,
      ).toBe(text);
    } finally {
      await service.close();
    }
  });
  it("permits deleting only never-referenced attachments after upgrading immutable uploads", async () => {
    const test = await freshDatabase();
    const migrations = await loadBundledMigrations();
    await applyMigrations(
      test.database,
      migrations.filter((m) => m.version < "0032"),
      clock,
    );
    await insertPerson(test);
    await test.database.exec(`
      insert into groups (id, name, created_at, updated_at) values ('group-1', 'Research', now(), now());
      insert into workflows (id, group_id, name, goal, intent, locale, created_at, updated_at) values ('workflow-1', 'group-1', 'example', 'Goal', 'new-skill', 'en', now(), now());
      insert into workflow_versions (id, workflow_id, number, name, goal, intent, locale, stages, created_at, updated_at) values ('version-1', 'workflow-1', 1, 'example', 'Goal', 'new-skill', 'en', '{}', now(), now());
      insert into question_rounds (id, workflow_version_id, number, title, created_by, created_at) values ('round-1', 'version-1', 1, 'Evidence', 'person-1', now());
      insert into questions (id, workflow_version_id, round_id, created_at) values ('question-1', 'version-1', 'round-1', now());
      insert into question_revisions (question_id, revision, content, actor_id, created_at) values ('question-1', 1, '{}', 'person-1', now());
      insert into question_answers (question_id, person_id, revision) values ('question-1', 'person-1', 1);
    `);
    for (const id of ["unused", "used", "inherited"])
      await test.database.query(
        "insert into answer_attachments (id, question_id, person_id, name, media_type, size, hash, created_at) values ($1, 'question-1', 'person-1', 'evidence.txt', 'text/plain', 1, $2, $3)",
        [id, "a".repeat(64), clock.now()],
      );
    await test.database
      .exec(`insert into answer_revisions (question_id, person_id, revision, question_revision, text, state, channel, created_at, attachments)
      values ('question-1', 'person-1', 1, 1, '', 'draft', 'web', now(), '[{"id":"used"}]');
      insert into inherited_answer_attachments (question_id, attachment_id) values ('question-1', 'inherited');`);
    const before = (
      await test.database.query("select * from answer_attachments order by id")
    ).rows;
    await expect(
      test.database.query("delete from answer_attachments where id = 'unused'"),
    ).rejects.toThrow(/immutable/u);
    await applyMigrations(test.database, migrations, clock);
    expect(
      (
        await test.database.query(
          "select * from answer_attachments order by id",
        )
      ).rows,
    ).toEqual(before);
    for (const id of ["unused", "used", "inherited"])
      await expect(
        test.database.query(
          "update answer_attachments set name = 'changed' where id = $1",
          [id],
        ),
      ).rejects.toThrow(/immutable/u);
    for (const id of ["used", "inherited"])
      await expect(
        test.database.query("delete from answer_attachments where id = $1", [
          id,
        ]),
      ).rejects.toThrow(/immutable/u);
    await expect(
      test.database.query("truncate answer_attachments cascade"),
    ).rejects.toThrow(/immutable/u);
    expect(
      (
        await test.database.query(
          "delete from answer_attachments where id = 'unused' returning id",
        )
      ).rows,
    ).toEqual([{ id: "unused" }]);
  });
  it("keeps package reviews and published bytes immutable", async () => {
    const test = await freshDatabase();
    await applyMigrations(test.database, await loadBundledMigrations(), clock);
    for (const table of [
      "package_reviews",
      "published_packages",
      "run_gate_answers",
    ])
      for (const statement of [
        `update ${table} set ${table === "run_gate_answers" ? "confirmation_hash" : "package_hash"}='${"a".repeat(64)}'`,
        `delete from ${table}`,
        `truncate ${table} cascade`,
      ])
        await expect(test.database.query(statement), statement).rejects.toThrow(
          /immutable/u,
        );
  });
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
    await applyMigrations(
      test.database,
      migrations.filter((m) => m.version < "0033"),
      clock,
    );
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
    const origins = (
      await test.database.query("select * from skill_version_git_origins")
    ).rows;
    await applyMigrations(test.database, migrations, clock);
    expect(
      (await test.database.query("select * from skill_version_git_origins"))
        .rows,
    ).toEqual(origins.map((row) => ({ ...row, published_ref: null })));
    await expect(
      test.database.query(
        "insert into skill_version_git_origins (skill_id, hash, repository_id, repository, commit_hash, imported_by, created_at, published_ref) values ('skill-1', $1, 'repo-1', 'https://example.com/skill.git', $2, 'person-1', $3, 'refs/hidden/private')",
        ["a".repeat(64), "c".repeat(40), clock.now()],
      ),
    ).rejects.toThrow(/published_ref/u);
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
      "workflow_run_events",
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

    expect(upgraded.applied.at(-1)).toBe("0047");
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
      "0029",
      "0030",
      "0031",
      "0032",
      "0033",
      "0034",
      "0035",
      "0036",
      "0037",
      "0038",
      "0039",
      "0040",
      "0041",
      "0042",
      "0043",
      "0044",
      "0045",
      "0046",
      "0047",
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
        "0029",
        "0030",
        "0031",
        "0032",
        "0033",
        "0034",
        "0035",
        "0036",
        "0037",
        "0038",
        "0039",
        "0040",
        "0041",
        "0042",
        "0043",
        "0044",
        "0045",
        "0046",
        "0047",
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
      "attachment_blob_cleanup",
      "audit_events",
      "authoring_follow_ups",
      "comment_revisions",
      "concern_resolutions",
      "confirmed_facts",
      "dossier_heads",
      "dossier_versions",
      "drafting_job_decisions",
      "drafting_job_review_revisions",
      "drafting_jobs",
      "evaluation_reports",
      "fact_acknowledgements",
      "fact_answer_revisions",
      "gate_confirmations",
      "groups",
      "identity_sessions",
      "inbox_items",
      "inherited_answer_attachments",
      "notification_actions",
      "notification_bot_leases",
      "notification_channels",
      "notification_deliveries",
      "notification_reminders",
      "notification_robots",
      "oidc_transactions",
      "package_assembly_requests",
      "package_reviews",
      "people",
      "person_notification_preferences",
      "person_preferences",
      "personal_access_tokens",
      "personal_robot_routes",
      "personal_robots",
      "plan_heads",
      "plan_versions",
      "prompt_template_heads",
      "prompt_template_revisions",
      "published_packages",
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
      "retired_llm_configuration",
      "retired_llm_secrets",
      "retired_skill_suggestion_previews",
      "role_bindings",
      "run_gate_answers",
      "run_gates",
      "run_recoveries",
      "run_recovery_notices",
      "schema_migrations",
      "script_effect_confirmations",
      "script_effect_revisions",
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
      "workflow_run_events",
      "workflow_runs",
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
        "0029",
        "0030",
        "0031",
        "0032",
        "0033",
        "0034",
        "0035",
        "0036",
        "0037",
        "0038",
        "0039",
        "0040",
        "0041",
        "0042",
        "0043",
        "0044",
        "0045",
        "0046",
        "0047",
      ],
      pending: [],
      drifted: [],
    });
    const rows = await test.database.query<{ count: number }>(
      "select count(*)::int as count from schema_migrations",
    );
    expect(rows.rows[0]?.count).toBe(47);
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
