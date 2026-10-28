import type { ServiceDependencies } from "./dependencies.js";
import type { Queryable } from "./database/database.js";
import type { Principal } from "./identity/identity.js";
import { recordAudit, type AuditChannel } from "./audit.js";
import { resolvePendingBindings } from "./bindings.js";
import { toIsoString } from "./util.js";

const PROFILE_ATTEMPTS = 3;

export interface Person {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  /** Whether the identity provider vouched for `email` at the latest sign-in. */
  emailVerified: boolean;
  displayName: string;
  status: "active" | "disabled";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface PersonRow {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  email_verified: boolean;
  display_name: string;
  status: "active" | "disabled";
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    emailVerified: row.email_verified,
    displayName: row.display_name,
    status: row.status,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function findPerson(
  database: Queryable,
  issuer: string,
  subject: string,
): Promise<PersonRow | null> {
  const rows = await database.query<PersonRow>(
    `select id, issuer, subject, email, email_verified, display_name, status,
            revision, created_at, updated_at
       from people
      where issuer = $1 and subject = $2`,
    [issuer, subject],
  );
  return rows.rows[0] ?? null;
}

export async function readPersonById(
  database: Queryable,
  id: string,
): Promise<Person | null> {
  const rows = await database.query<PersonRow>(
    `select id, issuer, subject, email, email_verified, display_name, status,
            revision, created_at, updated_at from people where id = $1`,
    [id],
  );
  return rows.rows[0] === undefined ? null : toPerson(rows.rows[0]);
}

/**
 * Binds the signed-in principal to a person record and keeps their profile
 * current. Every write it makes is audited in the same transaction. Updates
 * carry the revision they read, so a concurrent sign-in is re-read instead of
 * silently overwritten.
 */
export async function signInPerson(
  database: Queryable,
  dependencies: ServiceDependencies,
  principal: Principal,
  context: { channel: AuditChannel; requestId: string },
): Promise<Person> {
  const now = dependencies.clock.now();
  let current = await findPerson(database, principal.issuer, principal.subject);

  // A waiting invitation applies, in the sign-in's transaction, once a
  // sign-in presents its address as verified: usually the first one, or a
  // later one after the provider verifies the address or the person moves to
  // it. Bindings already applied follow issuer and subject, so an address
  // change moves none of them.
  const finish = async (person: Person): Promise<Person> => {
    await resolvePendingBindings(database, dependencies, person, {
      credential: principal.credential,
      channel: context.channel,
      requestId: context.requestId,
    });
    return person;
  };

  for (let attempt = 0; attempt < PROFILE_ATTEMPTS; attempt += 1) {
    if (current === null) {
      const person: Person = {
        id: dependencies.ids.next(),
        issuer: principal.issuer,
        subject: principal.subject,
        email: principal.email,
        emailVerified: principal.emailVerified,
        displayName: principal.displayName,
        status: "active",
        revision: 1,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      const inserted = await database.query<PersonRow>(
        `insert into people (
           id, issuer, subject, email, email_verified, display_name, status,
           revision, created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (issuer, subject) do nothing
         returning id, issuer, subject, email, email_verified, display_name,
                   status, revision, created_at, updated_at`,
        [
          person.id,
          person.issuer,
          person.subject,
          person.email,
          person.emailVerified,
          person.displayName,
          person.status,
          person.revision,
          person.createdAt,
          person.updatedAt,
        ],
      );

      if (inserted.rows.length > 0) {
        await recordAudit(database, dependencies, {
          actor: { personId: person.id, credential: principal.credential },
          channel: context.channel,
          action: "person.created",
          target: { type: "person", id: person.id, label: person.email },
          before: null,
          after: { revision: person.revision, hash: null },
          reason: "First sign-in",
          requestId: context.requestId,
        });
        return finish(person);
      }

      // Another process recorded this person first; read what it wrote.
      current = await findPerson(database, principal.issuer, principal.subject);
      if (current === null) {
        throw new Error("Could not record the signed-in person");
      }
      continue;
    }

    if (
      current.email === principal.email &&
      current.email_verified === principal.emailVerified &&
      current.display_name === principal.displayName
    ) {
      return finish(toPerson(current));
    }

    const revision = current.revision + 1;
    const updated = await database.query(
      `update people
          set email = $1, email_verified = $2, display_name = $3,
              revision = $4, updated_at = $5
        where id = $6 and revision = $7`,
      [
        principal.email,
        principal.emailVerified,
        principal.displayName,
        revision,
        now,
        current.id,
        current.revision,
      ],
    );

    if (updated.rowCount > 0) {
      await recordAudit(database, dependencies, {
        actor: { personId: current.id, credential: principal.credential },
        channel: context.channel,
        action: "person.updated",
        target: { type: "person", id: current.id, label: principal.email },
        before: { revision: current.revision, hash: null },
        after: { revision, hash: null },
        reason: "Profile changed at sign-in",
        requestId: context.requestId,
      });

      return finish(
        toPerson({
          ...current,
          email: principal.email,
          email_verified: principal.emailVerified,
          display_name: principal.displayName,
          revision,
          updated_at: now,
        }),
      );
    }

    // A concurrent sign-in moved the revision; retry against what is stored.
    current = await findPerson(database, principal.issuer, principal.subject);
  }

  throw new Error(
    "Could not update the signed-in person after concurrent changes",
  );
}
