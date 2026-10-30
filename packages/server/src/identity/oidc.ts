import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { setClockTimer, type Clock } from "../clock.js";
import type { OidcSettings } from "../config.js";
import type { Database } from "../database/database.js";
import { silentLogger, type Logger } from "../log.js";
import { hashCredential, readCookie } from "./cookies.js";
import type { IdentityAdapter, Principal } from "./identity.js";

export const OIDC_TRANSACTION_SECONDS = 600;
/** A longer destination falls back to My work; migration 0026 checks it too. */
const MAX_RETURN_PATH_BYTES = 2048;
const EVICTION_LOG_MILLISECONDS = 60_000;

interface Transaction {
  state: string;
  nonce: string;
  code_verifier: string;
  return_path: string | null;
}

/**
 * Canonicalize a dashboard destination without permitting another origin or
 * app. A reverse proxy may decode the path before it routes the request, so
 * the path must pass these checks decoded once, too.
 */
function dashboardReturnPath(value: string | null, publicUrl: string): string {
  const ownUrl = new URL(publicUrl);
  const basePath = ownUrl.pathname.replace(/\/$/u, "");
  const fallback = `${basePath}/`;
  const underBase = (path: string) =>
    basePath === "" || path === basePath || path.startsWith(`${basePath}/`);
  if (
    value === null ||
    Buffer.byteLength(value) > MAX_RETURN_PATH_BYTES ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(value)
  )
    return fallback;
  const destination = new URL(value, ownUrl);
  const canonical = `${destination.pathname}${destination.search}${destination.hash}`;
  let decoded: string;
  try {
    decoded = decodeURIComponent(destination.pathname);
  } catch {
    return fallback;
  }
  if (
    destination.origin !== ownUrl.origin ||
    !underBase(destination.pathname) ||
    // Encoded separators and dots (%2F, %5C, %2E) and a second encoding
    // (%25) would change the path that a decoding proxy routes.
    /[\\%\u0000-\u001f\u007f]/u.test(decoded) ||
    decoded.includes("//") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..") ||
    !underBase(decoded) ||
    Buffer.byteLength(canonical) > MAX_RETURN_PATH_BYTES
  )
    return fallback;
  return canonical;
}

/**
 * What went wrong, for the operator's log: the error's class, its OAuth or
 * transport code, and the provider's status and description. Library and
 * provider messages carry no tokens, codes, or secrets.
 */
export function oidcFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown failure";
  const detail = error as Error & {
    code?: unknown;
    status?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  const cause = error.cause as { code?: unknown; message?: unknown } | null;
  return [
    error.name,
    typeof detail.code === "string" ? detail.code : null,
    typeof detail.status === "number" ? `status ${detail.status}` : null,
    typeof detail.error === "string" ? detail.error : null,
    typeof detail.error_description === "string"
      ? detail.error_description
      : null,
    error.message,
    typeof cause?.code === "string" ? cause.code : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(": ")
    .slice(0, 500);
}

/** A provider validates identity; durable, opaque sessions carry no roles. */
export function createOidcIdentityAdapter(
  settings: OidcSettings,
  clock: Clock,
  database: Database,
  logger: Logger = silentLogger,
): IdentityAdapter {
  // An eviction is logged at once, with any others in the minute after it
  // logged when that minute ends: at most one entry a minute.
  let evictionWindow: (() => void) | null = null;
  let unloggedEvictions = 0;
  const logEvictions = (count: number) => {
    logger.info({ event: "oidc.sign-ins-evicted", evictedCount: count });
    evictionWindow = setClockTimer(clock, EVICTION_LOG_MILLISECONDS, () => {
      evictionWindow = null;
      const pending = unloggedEvictions;
      unloggedEvictions = 0;
      if (pending > 0) logEvictions(pending);
    });
  };
  let discovered: Promise<client.Configuration> | undefined;
  const configuration = (): Promise<client.Configuration> => {
    discovered ??= client
      .discovery(
        new URL(settings.issuer),
        settings.clientId,
        undefined,
        client.ClientSecretBasic(settings.clientSecret),
        {
          timeout: settings.timeoutSeconds,
          execute: [
            client.enableNonRepudiationChecks,
            ...(settings.issuer.startsWith("http:")
              ? [client.allowInsecureRequests]
              : []),
          ],
        },
      )
      .catch((error: unknown) => {
        discovered = undefined;
        throw error;
      });
    return discovered;
  };
  const callbackUri = `${settings.publicUrl}/auth/oidc/callback`;
  const token = () => randomBytes(32).toString("base64url");
  return {
    resolve: async (request) => {
      const credential = readCookie(request.headers, settings.sessionCookie);
      if (credential === null) return { kind: "anonymous" };
      const key = hashCredential(credential);
      const session = await database.query<{ principal: Principal }>(
        "select principal from identity_sessions where token_hash = $1 and expires_at > $2",
        [key, clock.now()],
      );
      const principal = session.rows[0]?.principal;
      if (principal === undefined || principal.issuer !== settings.issuer)
        return { kind: "anonymous" };
      return {
        kind: "authenticated",
        principal: { ...principal, credential: { kind: "session", id: key } },
      };
    },
    browser: {
      begin: async (returnPath) => {
        let config: client.Configuration;
        try {
          config = await configuration();
        } catch (error) {
          return {
            kind: "unavailable",
            reason: `discovery: ${oidcFailureReason(error)}`,
          };
        }
        const transactionToken = token();
        const state = client.randomState();
        const nonce = client.randomNonce();
        const verifier = client.randomPKCECodeVerifier();
        const authorizationUrl = client.buildAuthorizationUrl(config, {
          redirect_uri: callbackUri,
          response_type: "code",
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: await client.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        });
        const now = clock.now();
        const evicted = await database.transaction(async (tx) => {
          // Starts never wait for one another: each deletes only rows no
          // other transaction holds, and a held row is already being deleted.
          await tx.query(
            `delete from oidc_transactions where token_hash in (
              select token_hash from oidc_transactions where expires_at <= $1
              for update skip locked
            )`,
            [now],
          );
          await tx.query(
            `delete from identity_sessions where token_hash in (
              select token_hash from identity_sessions where expires_at <= $1
              for update skip locked
            )`,
            [now],
          );
          const started = await tx.query<{ sequence: string }>(
            "insert into oidc_transactions (token_hash, state, nonce, code_verifier, expires_at, return_path) values ($1, $2, $3, $4, $5, $6) returning sequence::text as sequence",
            [
              hashCredential(transactionToken),
              state,
              nonce,
              verifier,
              new Date(now.getTime() + OIDC_TRANSACTION_SECONDS * 1000),
              dashboardReturnPath(returnPath, settings.publicUrl),
            ],
          );
          // Starts are numbered in order. Evict each pending sign-in more
          // than the cap's number of starts older than this one: the oldest.
          // The sequence index reads only those rows, whatever the table's
          // size, and the table keeps the cap plus the starts in flight.
          const removed = await tx.query(
            `delete from oidc_transactions where token_hash in (
              select token_hash from oidc_transactions
              where sequence <= $1::bigint - $2
              for update skip locked
            )`,
            [started.rows[0]!.sequence, settings.maxPendingSignIns],
          );
          return removed.rowCount;
        });
        if (evicted > 0) {
          if (evictionWindow === null) logEvictions(evicted);
          else unloggedEvictions += evicted;
        }
        return {
          authorizationUrl: authorizationUrl.href,
          transactionToken,
          state,
        };
      },
      complete: async (transactionToken, callback) => {
        if (transactionToken === null)
          return { kind: "invalid", reason: "no sign-in transaction cookie" };
        // Match state before consuming the token: a cookie from another tab
        // cannot consume that tab's transaction. Atomic deletion prevents
        // replays across server processes; provider codes are also one-use.
        const taken = await database.query<Transaction>(
          "delete from oidc_transactions where token_hash = $1 and expires_at > $2 and state = $3 returning state, nonce, code_verifier, return_path",
          [
            hashCredential(transactionToken),
            clock.now(),
            callback.searchParams.get("state"),
          ],
        );
        const transaction = taken.rows[0];
        if (transaction === undefined)
          return {
            kind: "invalid",
            reason: "the sign-in transaction is unknown, used, or expired",
          };
        let config: client.Configuration;
        try {
          config = await configuration();
        } catch (error) {
          return {
            kind: "unavailable",
            reason: `discovery: ${oidcFailureReason(error)}`,
          };
        }
        let claims: client.IDToken | undefined;
        try {
          const tokens = await client.authorizationCodeGrant(config, callback, {
            expectedState: transaction.state,
            expectedNonce: transaction.nonce,
            pkceCodeVerifier: transaction.code_verifier,
            idTokenExpected: true,
          });
          claims = tokens.claims();
        } catch (error) {
          const reason = `callback: ${oidcFailureReason(error)}`;
          if (
            (error instanceof client.ResponseBodyError &&
              (error.status >= 500 || error.status === 429)) ||
            ((error instanceof client.ResponseBodyError ||
              error instanceof client.AuthorizationResponseError) &&
              ["temporarily_unavailable", "server_error"].includes(
                error.error,
              )) ||
            error instanceof TypeError ||
            (error instanceof client.ClientError &&
              (error.code === "OAUTH_TIMEOUT" ||
                (error.cause instanceof Response &&
                  (error.cause.status >= 500 || error.cause.status === 429))))
          )
            return { kind: "unavailable", reason };
          return { kind: "invalid", reason };
        }
        if (
          claims === undefined ||
          typeof claims.email !== "string" ||
          !/^[^@\s]+@[^@\s]+$/u.test(claims.email) ||
          claims.sub.trim() === ""
        )
          return {
            kind: "invalid",
            reason: "the ID token lacks a subject or a valid email claim",
          };
        const principal: Principal = {
          issuer: settings.issuer,
          subject: claims.sub,
          email: claims.email,
          displayName:
            typeof claims.name === "string" && claims.name.trim() !== ""
              ? claims.name
              : claims.email,
          // A provider's own claim decides; the setting covers providers
          // that never send one.
          emailVerified:
            typeof claims.email_verified === "boolean"
              ? claims.email_verified
              : settings.emailsVerified,
          status: "active",
          platformAdministrator: false,
          credential: { kind: "session", id: null },
        };
        return {
          kind: "authenticated",
          principal,
          returnPath: dashboardReturnPath(
            transaction.return_path,
            settings.publicUrl,
          ),
        };
      },
    },
    close: () => {
      evictionWindow?.();
      evictionWindow = null;
    },
  };
}
