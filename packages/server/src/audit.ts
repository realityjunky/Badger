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
  /** The actor's name and address, when the actor is a person. */
  actorDisplayName: string | null;
  actorEmail: string | null;
  agentHost: string | null;
  credentialKind: AuditCredentialKind;
  credentialId: string | null;
  channel: AuditChannel;
  action: string;
  targetType: string;
  targetId: string | null;
  /** What the target was at the time, for a reader once it has changed. */
  targetLabel: string | null;
  before: RevisionOrHash | null;
  after: RevisionOrHash | null;
  reason: string | null;
  requestId: string;
}

export interface AuditInput {
  agentHost?: string | null;
  actor: AuditActor;
  channel: AuditChannel;
  action: string;
  target: { type: string; id: string | null; label?: string };
  before: RevisionOrHash | null;
  after: RevisionOrHash | null;
  reason: string | null;
  requestId: string;
}

/** Who is writing, and through which credential, channel, and request. */
export interface WriteContext {
  personId: string;
  credential: Credential;
  channel: AuditChannel;
  requestId: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Pass it back to read the next, older page; null on the last page. */
  nextCursor: string | null;
}

interface AuditRow {
  agent_host: string | null;
  id: string;
  occurred_at: Date | string;
  actor_person_id: string | null;
  actor_display_name: string | null;
  actor_email: string | null;
  credential_kind: AuditCredentialKind;
  credential_id: string | null;
  channel: AuditChannel;
  action: string;
  target_type: string;
  target_id: string | null;
  target_label: string | null;
  revision_before: number | null;
  hash_before: string | null;
  revision_after: number | null;
  hash_after: string | null;
  reason: string | null;
  request_id: string;
}

const AUDIT_INSERT_COLUMNS = `id, occurred_at, actor_person_id, credential_kind,
       credential_id, channel, action, target_type, target_id, target_label,
       revision_before, hash_before, revision_after, hash_after, reason,
       request_id, agent_host`;
const AUDIT_SELECT_COLUMNS = `a.id, a.occurred_at, a.actor_person_id,
       a.credential_kind, a.credential_id, a.channel, a.action, a.target_type,
       a.target_id, a.target_label, a.revision_before, a.hash_before, a.revision_after,
       a.hash_after, a.reason, a.request_id, a.agent_host, p.display_name as actor_display_name,
       p.email as actor_email`;
const AUDIT_FROM =
  "audit_events a left join people p on p.id = a.actor_person_id";

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
    actorDisplayName: row.actor_display_name,
    actorEmail: row.actor_email,
    agentHost: row.agent_host,
    credentialKind: row.credential_kind,
    credentialId: row.credential_id,
    channel: row.channel,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
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
    actorDisplayName: null,
    actorEmail: null,
    agentHost: input.agentHost ?? null,
    credentialKind: input.actor.credential.kind,
    credentialId: input.actor.credential.id,
    channel: input.channel,
    action: input.action,
    targetType: input.target.type,
    targetId: input.target.id,
    targetLabel: input.target.label ?? null,
    before: input.before,
    after: input.after,
    reason: input.reason,
    requestId: input.requestId,
  };

  await database.query(
    `insert into audit_events (${AUDIT_INSERT_COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17)`,
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
      event.targetLabel,
      event.before?.revision ?? null,
      event.before?.hash ?? null,
      event.after?.revision ?? null,
      event.after?.hash ?? null,
      event.reason,
      event.requestId,
      event.agentHost,
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

export interface AuditFilters {
  actorPersonId?: string;
  actorEmail?: string;
  action?: string;
  channel?: AuditChannel;
  targetType?: string;
  targetId?: string;
  /** Inclusive lower bound, as an ISO timestamp. */
  from?: string;
  /** Exclusive upper bound, as an ISO timestamp. */
  to?: string;
}

function filterConditions(filters: AuditFilters): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (clause: (parameter: string) => string, value: unknown): void => {
    params.push(value);
    conditions.push(clause(`$${params.length}`));
  };

  if (filters.actorPersonId !== undefined) {
    add(
      (parameter) => `a.actor_person_id = ${parameter}`,
      filters.actorPersonId,
    );
  }
  if (filters.actorEmail !== undefined) {
    add(
      (parameter) => `lower(p.email) = lower(${parameter})`,
      filters.actorEmail,
    );
  }
  if (filters.action !== undefined) {
    add((parameter) => `a.action = ${parameter}`, filters.action);
  }
  if (filters.channel !== undefined) {
    add((parameter) => `a.channel = ${parameter}`, filters.channel);
  }
  if (filters.targetType !== undefined) {
    add((parameter) => `a.target_type = ${parameter}`, filters.targetType);
  }
  if (filters.targetId !== undefined) {
    add((parameter) => `a.target_id = ${parameter}`, filters.targetId);
  }
  if (filters.from !== undefined) {
    add(
      (parameter) => `a.occurred_at >= ${parameter}::timestamptz`,
      filters.from,
    );
  }
  if (filters.to !== undefined) {
    add((parameter) => `a.occurred_at < ${parameter}::timestamptz`, filters.to);
  }

  return { conditions, params };
}

/** Lists audit events newest first, one page at a time, optionally filtered. */
export async function listAuditEvents(
  database: Queryable,
  options: {
    limit: number;
    after: AuditPosition | null;
    filters?: AuditFilters;
  },
): Promise<AuditPage> {
  const { conditions, params } = filterConditions(options.filters ?? {});
  if (options.after !== null) {
    params.push(options.after.occurredAt, options.after.id);
    conditions.push(
      `(a.occurred_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`,
    );
  }

  params.push(options.limit + 1);
  const rows = await database.query<AuditRow>(
    `select ${AUDIT_SELECT_COLUMNS}
       from ${AUDIT_FROM}
      where ${conditions.length > 0 ? conditions.join(" and ") : "true"}
      order by a.occurred_at desc, a.id desc
      limit $${params.length}`,
    params,
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
