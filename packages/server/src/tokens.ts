import { createHash, randomBytes } from "node:crypto";
import { recordAudit, type WriteContext } from "./audit.js";
import type { Database } from "./database/database.js";
import type { ServiceDependencies } from "./dependencies.js";
import { objectInput, RequestError } from "./http/errors.js";
import type { Principal } from "./identity/identity.js";
import { readPersonById, type Person } from "./people.js";
import { toIsoString } from "./util.js";

export const TOKEN_SCOPES = ["engineer", "expert", "operator"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
const DEFAULT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;

export interface PersonalAccessToken {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  revision: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedChannel: "mcp" | null;
}

interface TokenRow {
  id: string;
  person_id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  revision: number;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  last_used_at: Date | string | null;
  last_used_channel: "mcp" | null;
}

interface TokenUseRow extends TokenRow {
  rate_window_started_at: Date | string | null;
  rate_window_count: number;
}

const TOKEN_COLUMNS = `id, person_id, name, prefix, scopes, revision, created_at,
  expires_at, revoked_at, last_used_at, last_used_channel`;

function toToken(row: TokenRow): PersonalAccessToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    revision: row.revision,
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
    revokedAt: row.revoked_at === null ? null : toIsoString(row.revoked_at),
    lastUsedAt:
      row.last_used_at === null ? null : toIsoString(row.last_used_at),
    lastUsedChannel: row.last_used_channel,
  };
}

export async function authenticateToken(
  database: Database,
  dependencies: ServiceDependencies,
  authorization: string,
  requestId: string,
): Promise<{
  person: Person;
  principal: Principal;
  retryAfter: number | null;
} | null> {
  const match = /^Bearer[ \t]+(bdg_[a-f0-9]{16}_[A-Za-z0-9_-]{43})$/iu.exec(
    authorization,
  );
  if (match === null) return null;
  const hash = createHash("sha256").update(match[1]).digest("hex");
  return database.transaction(async (tx) => {
    const result = await tx.query<TokenUseRow>(
      `select ${TOKEN_COLUMNS}, rate_window_started_at, rate_window_count from personal_access_tokens
        where secret_hash = $1 for update`,
      [hash],
    );
    const row = result.rows[0];
    const now = dependencies.clock.now();
    if (
      row === undefined ||
      row.revoked_at !== null ||
      new Date(row.expires_at) <= now
    )
      return null;
    const person = await readPersonById(tx, row.person_id);
    if (person === null || person.status !== "active") return null;
    const previousWindow =
      row.rate_window_started_at === null
        ? null
        : new Date(row.rate_window_started_at);
    const reset =
      previousWindow === null ||
      now.getTime() - previousWindow.getTime() >= RATE_WINDOW_MS;
    const windowStart = reset ? now : previousWindow!;
    const count = reset
      ? 1
      : Math.min(row.rate_window_count + 1, RATE_LIMIT + 1);
    const retryAfter =
      count <= RATE_LIMIT
        ? null
        : Math.max(
            1,
            Math.ceil(
              (windowStart.getTime() + RATE_WINDOW_MS - now.getTime()) / 1000,
            ),
          );
    const principal: Principal = {
      issuer: person.issuer,
      subject: person.subject,
      email: person.email,
      emailVerified: person.emailVerified,
      displayName: person.displayName,
      status: "active",
      platformAdministrator: false,
      credential: { kind: "token", id: row.id, scopes: row.scopes },
    };
    await tx.query(
      `update personal_access_tokens set last_used_at = $1, last_used_channel = 'mcp',
         rate_window_started_at = $2, rate_window_count = $3 where id = $4`,
      [now, windowStart, count, row.id],
    );
    await recordAudit(tx, dependencies, {
      actor: { personId: person.id, credential: principal.credential },
      channel: "mcp",
      action: "token.used",
      target: {
        type: "token",
        id: row.id,
        label: `${row.name} (${row.prefix})`,
      },
      before: null,
      after: null,
      reason:
        retryAfter === null
          ? "Personal access token authenticated"
          : "Personal access token rate limit exceeded",
      requestId,
    });
    return { person, principal, retryAfter };
  });
}

export async function listTokens(
  database: Database,
  personId: string,
): Promise<PersonalAccessToken[]> {
  const rows = await database.query<TokenRow>(
    `select ${TOKEN_COLUMNS} from personal_access_tokens
      where person_id = $1 order by created_at desc, id desc`,
    [personId],
  );
  return rows.rows.map(toToken);
}

export async function createToken(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  value: unknown,
): Promise<{ token: PersonalAccessToken; secret: string }> {
  const input = objectInput(value);
  const unknown = Object.keys(input).find(
    (key) => !["name", "scopes", "expiresAt"].includes(key),
  );
  if (unknown !== undefined) throw new RequestError(400, "Unknown token field");
  const name = input["name"];
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.trim().length > 120
  )
    throw new RequestError(400, "name must contain 1 to 120 characters");
  const scopes = input["scopes"];
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > TOKEN_SCOPES.length ||
    !scopes.every((scope: unknown) =>
      TOKEN_SCOPES.includes(scope as TokenScope),
    ) ||
    new Set(scopes).size !== scopes.length
  )
    throw new RequestError(
      400,
      "Choose distinct engineer, expert, or operator scopes",
    );
  const now = dependencies.clock.now();
  const expiresAt =
    input["expiresAt"] === undefined
      ? new Date(now.getTime() + DEFAULT_LIFETIME_MS)
      : typeof input["expiresAt"] === "string"
        ? new Date(input["expiresAt"])
        : new Date(NaN);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)
    throw new RequestError(400, "expiresAt must be a timestamp in the future");

  const prefix = `bdg_${randomBytes(8).toString("hex")}`;
  const secret = `${prefix}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(secret).digest("hex");
  return database.transaction(async (tx) => {
    const result = await tx.query<TokenRow>(
      `insert into personal_access_tokens (
         id, person_id, name, prefix, secret_hash, scopes, created_at, expires_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${TOKEN_COLUMNS}`,
      [
        dependencies.ids.next(),
        context.personId,
        name.trim(),
        prefix,
        hash,
        scopes,
        now,
        expiresAt,
      ],
    );
    const token = toToken(result.rows[0]);
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "token.created",
      target: {
        type: "token",
        id: token.id,
        label: `${token.name} (${token.prefix})`,
      },
      before: null,
      after: { revision: token.revision, hash: null },
      reason: "Personal access token created",
      requestId: context.requestId,
    });
    return { token, secret };
  });
}

export async function revokeToken(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  id: string,
  value: unknown,
): Promise<PersonalAccessToken> {
  const input = objectInput(value);
  if (
    Object.keys(input).some((key) => key !== "revision") ||
    !Number.isInteger(input["revision"]) ||
    (input["revision"] as number) < 1
  )
    throw new RequestError(400, "revision must be a whole number from 1");
  return database.transaction(async (tx) => {
    const current = await tx.query<TokenRow>(
      `select ${TOKEN_COLUMNS} from personal_access_tokens
        where id = $1 and person_id = $2 for update`,
      [id, context.personId],
    );
    const row = current.rows[0];
    if (row === undefined)
      throw new RequestError(404, "No such personal access token");
    if (row.revision !== input["revision"])
      throw new RequestError(409, "The token changed since you read it", {
        token: toToken(row),
      });
    if (row.revoked_at !== null) return toToken(row);
    const updated = await tx.query<TokenRow>(
      `update personal_access_tokens set revoked_at = $1, revision = revision + 1
        where id = $2 returning ${TOKEN_COLUMNS}`,
      [dependencies.clock.now(), id],
    );
    const token = toToken(updated.rows[0]);
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "token.revoked",
      target: { type: "token", id, label: `${token.name} (${token.prefix})` },
      before: { revision: row.revision, hash: null },
      after: { revision: token.revision, hash: null },
      reason: "Personal access token revoked",
      requestId: context.requestId,
    });
    return token;
  });
}
