import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import type { Clock } from "../clock.js";
import type { OidcSettings } from "../config.js";
import type { Database } from "../database/database.js";
import { silentLogger, type Logger } from "../log.js";
import { hashCredential, readCookie } from "./cookies.js";
import type { IdentityAdapter, Principal } from "./identity.js";

export const OIDC_TRANSACTION_SECONDS = 600;
/** A different key from the migration lock; all server processes share it. */
const OIDC_START_LOCK_KEY = "8231130000000002";

interface Transaction {
  state: string;
  nonce: string;
  code_verifier: string;
  return_path: string | null;
}

/** Canonicalize a dashboard destination without permitting another origin or app. */
function dashboardReturnPath(value: string | null, publicUrl: string): string {
  const ownUrl = new URL(publicUrl);
  const basePath = ownUrl.pathname.replace(/\/$/u, "");
  const fallback = `${basePath}/`;
  if (
    value === null ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/u.test(value)
  )
    return fallback;
  const destination = new URL(value, ownUrl);
  if (
    destination.origin !== ownUrl.origin ||
    destination.pathname.startsWith("//") ||
    (basePath !== "" &&
      destination.pathname !== basePath &&
      !destination.pathname.startsWith(`${basePath}/`))
  )
    return fallback;
  return `${destination.pathname}${destination.search}${destination.hash}`;
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
  let pendingEvictions = 0;
  let lastEvictionLog = -Infinity;
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
          // Serialize starts, including on an empty table. The same
          // transaction evicts older pending sign-ins and adds this one.
          await tx.query(
            `select pg_advisory_xact_lock(${OIDC_START_LOCK_KEY})`,
          );
          await tx.query(
            "delete from oidc_transactions where expires_at <= $1",
            [now],
          );
          await tx.query(
            "delete from identity_sessions where expires_at <= $1",
            [now],
          );
          // Every transaction has the same lifetime, so expiry orders starts.
          // Break equal-time ties deterministically; leave room for this start.
          const removed = await tx.query(
            `delete from oidc_transactions where token_hash in (
              select token_hash from oidc_transactions
              order by expires_at desc, token_hash desc offset $1
            )`,
            [settings.maxPendingSignIns - 1],
          );
          await tx.query(
            "insert into oidc_transactions (token_hash, state, nonce, code_verifier, expires_at, return_path) values ($1, $2, $3, $4, $5, $6)",
            [
              hashCredential(transactionToken),
              state,
              nonce,
              verifier,
              new Date(now.getTime() + OIDC_TRANSACTION_SECONDS * 1000),
              dashboardReturnPath(returnPath, settings.publicUrl),
            ],
          );
          return removed.rowCount;
        });
        pendingEvictions += evicted;
        const logTime = clock.now().getTime();
        if (pendingEvictions > 0 && logTime - lastEvictionLog >= 60_000) {
          logger.info({
            event: "oidc.sign-ins-evicted",
            evictedCount: pendingEvictions,
          });
          pendingEvictions = 0;
          lastEvictionLog = logTime;
        }
        return { authorizationUrl: authorizationUrl.href, transactionToken };
      },
      complete: async (transactionToken, callback) => {
        if (transactionToken === null)
          return { kind: "invalid", reason: "no sign-in transaction cookie" };
        // Delete and return atomically: callbacks cannot be replayed, even on
        // another server process. The provider also enforces one-use codes.
        const taken = await database.query<Transaction>(
          "delete from oidc_transactions where token_hash = $1 and expires_at > $2 returning state, nonce, code_verifier, return_path",
          [hashCredential(transactionToken), clock.now()],
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
  };
}
