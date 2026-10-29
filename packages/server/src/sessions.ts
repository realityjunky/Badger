import { randomBytes } from "node:crypto";
import { recordAudit } from "./audit.js";
import type { OidcSettings } from "./config.js";
import type { Database } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { hashCredential } from "./identity/cookies.js";
import type { Principal } from "./identity/identity.js";
import { signInPerson } from "./people.js";

/** Bind the proved identity and issue its session in one audited transaction. */
export async function issueSession(
  database: Database,
  dependencies: ServiceDependencies,
  settings: OidcSettings,
  identity: Principal,
  requestId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const key = hashCredential(token);
  const principal: Principal = {
    ...identity,
    credential: { kind: "session", id: key },
  };
  const now = dependencies.clock.now();
  await database.transaction(async (tx) => {
    const person = await signInPerson(tx, dependencies, principal, {
      channel: "web",
      requestId,
    });
    // Each request signs its session's principal in again, so the person's
    // older sessions take the profile just proved; otherwise two devices
    // would rewrite the person back and forth. Resolution replaces the
    // stored credential with each session's own.
    await tx.query(
      "update identity_sessions set principal = $1 where person_id = $2 and expires_at > $3",
      [JSON.stringify(principal), person.id, now],
    );
    await tx.query(
      "insert into identity_sessions (token_hash, person_id, principal, created_at, expires_at) values ($1, $2, $3, $4, $5)",
      [
        key,
        person.id,
        JSON.stringify(principal),
        now,
        new Date(now.getTime() + settings.sessionSeconds * 1000),
      ],
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: person.id, credential: principal.credential },
      channel: "web",
      action: "session.created",
      target: { type: "session", id: key, label: "OpenID Connect session" },
      before: null,
      after: { revision: null, hash: key },
      reason: "OpenID Connect sign-in",
      requestId,
    });
  });
  return token;
}

/** A repeated logout changes nothing; a live credential is revoked with its audit. */
export async function revokeSession(
  database: Database,
  dependencies: ServiceDependencies,
  issuer: string,
  token: string | null,
  requestId: string,
): Promise<void> {
  if (token === null) return;
  const key = hashCredential(token);
  await database.transaction(async (tx) => {
    const deleted = await tx.query<{ person_id: string }>(
      "delete from identity_sessions where token_hash = $1 and principal->>'issuer' = $2 and expires_at > $3 returning person_id",
      [key, issuer, dependencies.clock.now()],
    );
    const session = deleted.rows[0];
    if (session === undefined) return;
    await recordAudit(tx, dependencies, {
      actor: {
        personId: session.person_id,
        credential: { kind: "session", id: key },
      },
      channel: "web",
      action: "session.revoked",
      target: { type: "session", id: key, label: "OpenID Connect session" },
      before: { revision: null, hash: key },
      after: null,
      reason: "Signed out",
      requestId,
    });
  });
}
