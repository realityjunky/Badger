import { recordAudit, type WriteContext } from "./audit.js";
import { visibleGroups, type Access } from "./authorization.js";
import type { Database, Queryable } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import type { Person } from "./people.js";
import { toIsoString } from "./util.js";
import type { WorkflowRole } from "./workflow-access.js";

export type InboxState = "unread" | "read" | "done";
export type InboxKind =
  | "gate-ready"
  | "gate-invalidated"
  | "question-assigned"
  | "answer-submitted"
  | "restatement-ready"
  | "question-reopened"
  | "concern-raised"
  | "job-submitted";
export interface InboxItem {
  id: string;
  workflowVersionId: string;
  workflowName: string;
  versionNumber: number;
  gate: string;
  kind: InboxKind;
  state: InboxState;
  revision: number;
  href: string;
  createdAt: string;
  updatedAt: string;
  questionId: string | null;
  questionText: string | null;
  concernId: string | null;
  concernText: string | null;
}

interface InboxRow {
  drafting_job_id: string | null;
  id: string;
  workflow_version_id: string;
  workflow_id: string;
  workflow_name: string;
  version_number: number;
  gate: string;
  kind: InboxKind;
  state: InboxState;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
  question_id: string | null;
  question_text: string | null;
  concern_id: string | null;
  concern_text: string | null;
}

const COLUMNS = `i.id, i.workflow_version_id, v.workflow_id, v.name as workflow_name,
  v.number as version_number, i.gate, i.kind, i.state, i.revision, i.created_at, i.updated_at, i.question_id, qr.content->>'text' as question_text,
  i.concern_id, c.text as concern_text, i.drafting_job_id`;
const FROM = `inbox_items i join workflow_versions v on v.id = i.workflow_version_id
  join workflows w on w.id = v.workflow_id left join questions q on q.id = i.question_id
  left join question_revisions qr on qr.question_id = q.id and qr.revision = q.revision
  left join questionnaire_concerns c on c.id = i.concern_id`;
// The item belongs to the person and is still within their current read roles.
const VISIBLE = `(i.person_id = $1 or exists (select 1 from role_bindings recipient
  where recipient.id = i.binding_id and recipient.person_id = $1))
  and ($2::boolean or w.group_id = any($3::text[])
  or exists (select 1 from role_bindings b where b.workflow_id = w.id and b.person_id = $1))`;

/** A monotone revision sum also detects changes outside the displayed page. */
export async function inboxFingerprint(
  database: Queryable,
  access: Access,
  person: Person,
) {
  const visibility = await visibleGroups(database, access, person);
  const result = await database.query<{ count: string; revision: string }>(
    `select count(*)::text as count, coalesce(sum(i.revision), 0)::text as revision from ${FROM} where ${VISIBLE}`,
    [
      person.id,
      visibility.everything,
      visibility.everything ? [] : [...visibility.groupIds],
    ],
  );
  return result.rows[0];
}

function toItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    workflowName: row.workflow_name,
    versionNumber: row.version_number,
    gate: row.gate,
    kind: row.kind,
    questionId: row.question_id,
    questionText: row.question_text,
    concernId: row.concern_id,
    concernText: row.concern_text,
    state: row.state,
    revision: row.revision,
    href:
      row.gate === "plan"
        ? `/workflows/${encodeURIComponent(row.workflow_id)}/versions/${encodeURIComponent(row.workflow_version_id)}#plan`
        : row.drafting_job_id !== null
          ? `/questionnaire?workflow=${encodeURIComponent(row.workflow_id)}&version=${encodeURIComponent(row.workflow_version_id)}&panel=suggestions`
          : row.concern_id !== null
            ? `/questionnaire/concerns/${encodeURIComponent(row.concern_id)}`
            : row.question_id === null
              ? `/workflows/${encodeURIComponent(row.workflow_id)}/versions/${encodeURIComponent(row.workflow_version_id)}#${encodeURIComponent(row.gate)}`
              : `/questionnaire/questions/${encodeURIComponent(row.question_id)}`,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/** Called in the transaction producing the event; duplicate delivery is harmless. */
export async function notifyWorkflowRoles(
  database: Queryable,
  dependencies: ServiceDependencies,
  versionId: string,
  gate: string,
  kind: InboxKind,
  eventId: string,
  roles: readonly WorkflowRole[],
  concernId: string | null = null,
): Promise<void> {
  const people = await database.query<{
    person_id: string | null;
    binding_id: string | null;
  }>(
    `select b.person_id, case when b.person_id is null then min(b.id) else null end as binding_id from role_bindings b
      join workflow_versions v on v.workflow_id = b.workflow_id
      where v.id = $1 and b.role = any($2::text[])
      group by b.person_id, case when b.person_id is null then lower(b.email) else '' end`,
    [versionId, roles],
  );
  for (const { person_id: personId, binding_id: bindingId } of people.rows) {
    await database.query(
      `insert into inbox_items (id, person_id, workflow_version_id, gate, kind, event_id, created_at, updated_at, binding_id, concern_id)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9) on conflict do nothing`,
      [
        dependencies.ids.next(),
        personId,
        versionId,
        gate,
        kind,
        eventId,
        dependencies.clock.now(),
        bindingId,
        concernId,
      ],
    );
  }
}

export async function closeGateInbox(
  database: Queryable,
  versionId: string,
  gate: string,
  now: Date,
  kind?: InboxKind,
): Promise<void> {
  await database.query(
    `update inbox_items set state = 'done', revision = revision + 1, updated_at = $3
      where workflow_version_id = $1 and gate = $2 and state <> 'done'
        and ($4::text is null or kind = $4)`,
    [versionId, gate, now, kind ?? null],
  );
}

interface InboxPosition {
  createdAt: string;
  id: string;
}
export function decodeInboxCursor(cursor: string): InboxPosition | null {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<InboxPosition>;
    if (
      typeof value.id === "string" &&
      value.id.length > 0 &&
      typeof value.createdAt === "string" &&
      !Number.isNaN(Date.parse(value.createdAt))
    )
      return { id: value.id, createdAt: value.createdAt };
  } catch {
    /* A malformed cursor is an input error. */
  }
  return null;
}

export async function listInbox(
  database: Queryable,
  access: Access,
  person: Person,
  limit: number,
  after: InboxPosition | null,
) {
  const visibility = await visibleGroups(database, access, person);
  const params: unknown[] = [
    person.id,
    visibility.everything,
    visibility.everything ? [] : [...visibility.groupIds],
  ];
  const counts = await database.query<{
    unread_count: number;
    pending_count: number;
    question_count: number;
    gate_count: number;
  }>(
    `select count(*) filter (where i.state = 'unread')::int as unread_count,
            count(distinct (i.workflow_version_id, i.gate, i.question_id, i.concern_id)) filter (where i.state <> 'done')::int as pending_count,
            count(distinct i.question_id) filter (where i.state <> 'done')::int as question_count,
            count(distinct (i.workflow_version_id, i.gate)) filter (where i.state <> 'done' and i.question_id is null and i.concern_id is null)::int as gate_count from ${FROM} where ${VISIBLE}`,
    params,
  );
  const older =
    after === null
      ? ""
      : " and (i.created_at, i.id) < ($4::timestamptz, $5::text)";
  if (after !== null) params.push(after.createdAt, after.id);
  params.push(limit + 1);
  const rows = await database.query<InboxRow>(
    `select ${COLUMNS} from ${FROM} where ${VISIBLE}${older}
      order by i.created_at desc, i.id desc limit $${params.length}`,
    params,
  );
  const items = rows.rows.slice(0, limit).map(toItem);
  const last = items.at(-1);
  return {
    items,
    unreadCount: counts.rows[0]!.unread_count,
    pendingCount: counts.rows[0]!.pending_count,
    pendingQuestionCount: counts.rows[0]!.question_count,
    pendingGateCount: counts.rows[0]!.gate_count,
    nextCursor:
      rows.rows.length > limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({ createdAt: last.createdAt, id: last.id }),
          ).toString("base64url")
        : null,
  };
}

export async function markInboxItem(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  access: Access,
  person: Person,
  id: string,
  state: "read" | "unread",
  revision: number,
) {
  return database.transaction(async (tx) => {
    const visibility = await visibleGroups(tx, access, person);
    const result = await tx.query<InboxRow>(
      `select ${COLUMNS} from ${FROM} where ${VISIBLE} and i.id = $4 for update of i`,
      [
        person.id,
        visibility.everything,
        visibility.everything ? [] : [...visibility.groupIds],
        id,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return { kind: "missing" } as const;
    if (row.revision !== revision || row.state === "done")
      return { kind: "conflict", item: toItem(row) } as const;
    await tx.query(
      "update inbox_items set state = $2, revision = revision + 1, updated_at = $3 where id = $1",
      [id, state, dependencies.clock.now()],
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "inbox_item.updated",
      target: { type: "inbox_item", id },
      before: { revision, hash: null },
      after: { revision: revision + 1, hash: null },
      reason: `Marked ${state}`,
      requestId: context.requestId,
    });
    return {
      kind: "updated",
      item: {
        ...toItem(row),
        state,
        revision: revision + 1,
        updatedAt: dependencies.clock.now().toISOString(),
      },
    } as const;
  });
}
