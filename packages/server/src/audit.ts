import type { ServiceDependencies } from "./dependencies.js";
import type { Queryable } from "./database/database.js";
import type { Credential, CredentialKind } from "./identity/identity.js";
import { toIsoString } from "./util.js";

export type AuditChannel = "web" | "mcp" | "worker";

export type AuditCredentialKind = CredentialKind | "worker";

/**
 * A record's revision, or the content hash of a record that has none, on one
 * side of a write.
 */
export interface RevisionOrHash {
  revision: number | null;
  hash: string | null;
}

/**
 * Who wrote: a person through the credential they used, or the worker acting
 * on its own. Only the worker channel may carry the worker.
 */
export type AuditActor =
  | { personId: string; credential: Credential }
  | { personId: null; credential: { kind: "worker"; id: string | null } };

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorPersonId: string | null;
  credentialKind: AuditCredentialKind;
  credentialId: string | null;
  channel: AuditChannel;
  action: string;
  targetType: string;
  targetId: string | null;
  before: RevisionOrHash | null;
  after: RevisionOrHash | null;
  reason: string | null;
  requestId: string;
}

export interface AuditInput {
  actor: AuditActor;
  channel: AuditChannel;
  action: string;
  target: { type: string; id: string | null };
  before: RevisionOrHash | null;
  after: RevisionOrHash | null;
  reason: string | null;
  requestId: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Pass it back to read the next, older page; null on the last page. */
  nextCursor: string | null;
}

interface AuditRow {
  id: string;
  occurred_at: Date | string;
  actor_person_id: string | null;
  credential_kind: AuditCredentialKind;
  credential_id: string | null;
  channel: AuditChannel;
  action: string;
  target_type: string;
  target_id: string | null;
  revision_before: number | null;
  hash_before: string | null;
  revision_after: number | null;
  hash_after: string | null;
  reason: string | null;
  request_id: string;
}

const AUDIT_COLUMNS = `id, occurred_at, actor_person_id, credential_kind, credential_id,
       channel, action, target_type, target_id, revision_before, hash_before,
       revision_after, hash_after, reason, request_id`;

function revisionOrHash(
  revision: number | null,
  hash: string | null,
): RevisionOrHash | null {
  return revision === null && hash === null ? null : { revision, hash };
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
    before: revisionOrHash(row.revision_before, row.hash_before),
    after: revisionOrHash(row.revision_after, row.hash_after),
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
    credentialKind: input.actor.credential.kind,
    credentialId: input.actor.credential.id,
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
    `insert into audit_events (${AUDIT_COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
      event.before?.revision ?? null,
      event.before?.hash ?? null,
      event.after?.revision ?? null,
      event.after?.hash ?? null,
      event.reason,
      event.requestId,
    ],
  );

  return event;
}

interface AuditPosition {
  occurredAt: string;
  id: string;
}

function encodeCursor(event: AuditEvent): string {
  const position: AuditPosition = {
    occurredAt: event.occurredAt,
    id: event.id,
  };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

/** Reads a cursor this service issued; anything else is null. */
export function decodeAuditCursor(cursor: string): AuditPosition | null {
  try {
    const position = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<AuditPosition>;
    if (
      typeof position.id === "string" &&
      typeof position.occurredAt === "string" &&
      !Number.isNaN(Date.parse(position.occurredAt))
    ) {
      return { occurredAt: position.occurredAt, id: position.id };
    }
  } catch {
    // Not a cursor this service issued.
  }
  return null;
}

/** Lists audit events newest first, one page at a time. */
export async function listAuditEvents(
  database: Queryable,
  options: { limit: number; after: AuditPosition | null },
): Promise<AuditPage> {
  const rows =
    options.after === null
      ? await database.query<AuditRow>(
          `select ${AUDIT_COLUMNS}
             from audit_events
            order by occurred_at desc, id desc
            limit $1`,
          [options.limit + 1],
        )
      : await database.query<AuditRow>(
          `select ${AUDIT_COLUMNS}
             from audit_events
            where (occurred_at, id) < ($1::timestamptz, $2::text)
            order by occurred_at desc, id desc
            limit $3`,
          [options.after.occurredAt, options.after.id, options.limit + 1],
        );
  const events = rows.rows.slice(0, options.limit).map(toAuditEvent);
  const last = events.at(-1);
  return {
    events,
    nextCursor:
      rows.rows.length > options.limit && last !== undefined
        ? encodeCursor(last)
        : null,
  };
}
