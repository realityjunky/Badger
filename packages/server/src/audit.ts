import type { ServiceDependencies } from "./dependencies.js";
import type { Queryable } from "./database/database.js";
import type { CredentialKind } from "./identity/identity.js";
import { toIsoString } from "./util.js";

export type AuditChannel = "web" | "mcp" | "worker";

/** The revision or hash a record had on either side of a write. */
export interface AuditBoundary {
  revision: number | null;
  hash: string | null;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorPersonId: string;
  credentialKind: CredentialKind;
  credentialId: string | null;
  channel: AuditChannel;
  action: string;
  targetType: string;
  targetId: string | null;
  before: AuditBoundary | null;
  after: AuditBoundary | null;
  reason: string | null;
  requestId: string;
}

export interface AuditInput {
  actor: {
    personId: string;
    credentialKind: CredentialKind;
    credentialId: string | null;
  };
  channel: AuditChannel;
  action: string;
  target: { type: string; id: string | null };
  before: AuditBoundary | null;
  after: AuditBoundary | null;
  reason: string | null;
  requestId: string;
}

interface AuditRow {
  id: string;
  occurred_at: Date | string;
  actor_person_id: string;
  credential_kind: CredentialKind;
  credential_id: string | null;
  channel: AuditChannel;
  action: string;
  target_type: string;
  target_id: string | null;
  before_boundary: AuditBoundary | null;
  after_boundary: AuditBoundary | null;
  reason: string | null;
  request_id: string;
}

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: toIsoString(row.occurred_at),
    actorPersonId: row.actor_person_id,
    credentialKind: row.credential_kind,
    credentialId: row.credential_id,
    channel: row.channel,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    before: row.before_boundary,
    after: row.after_boundary,
    reason: row.reason,
    requestId: row.request_id,
  };
}

/**
 * Appends one audit record. Callers run this inside the transaction that
 * performs the write, so a write without its audit record cannot commit.
 */
export async function recordAudit(
  database: Queryable,
  dependencies: ServiceDependencies,
  input: AuditInput,
): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: dependencies.ids.next(),
    occurredAt: dependencies.clock.now().toISOString(),
    actorPersonId: input.actor.personId,
    credentialKind: input.actor.credentialKind,
    credentialId: input.actor.credentialId,
    channel: input.channel,
    action: input.action,
    targetType: input.target.type,
    targetId: input.target.id,
    before: input.before,
    after: input.after,
    reason: input.reason,
    requestId: input.requestId,
  };

  await database.query(
    `insert into audit_events (
       id, occurred_at, actor_person_id, credential_kind, credential_id,
       channel, action, target_type, target_id, before_boundary,
       after_boundary, reason, request_id
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      event.id,
      event.occurredAt,
      event.actorPersonId,
      event.credentialKind,
      event.credentialId,
      event.channel,
      event.action,
      event.targetType,
      event.targetId,
      event.before === null ? null : JSON.stringify(event.before),
      event.after === null ? null : JSON.stringify(event.after),
      event.reason,
      event.requestId,
    ],
  );

  return event;
}

export async function listAuditEvents(
  database: Queryable,
  options: { limit: number },
): Promise<AuditEvent[]> {
  const rows = await database.query<AuditRow>(
    `select id, occurred_at, actor_person_id, credential_kind, credential_id,
            channel, action, target_type, target_id, before_boundary,
            after_boundary, reason, request_id
       from audit_events
      order by occurred_at desc, id desc
      limit $1`,
    [options.limit],
  );
  return rows.rows.map(toAuditEvent);
}
