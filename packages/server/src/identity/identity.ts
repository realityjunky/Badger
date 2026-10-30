import type { TokenScope } from "../tokens.js";

export type CredentialKind = "session" | "token" | "local-implicit";

export interface Credential {
  kind: CredentialKind;
  id: string | null;
  scopes?: readonly TokenScope[];
  /** The validated Agent host supplied with this token request. */
  agentHost?: string | null;
}

/**
 * The person a request acts as. A principal alone grants no permission:
 * Badger decides what the person may do (`authorization.ts`).
 */
export interface Principal {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  status: "active";
  credential: Credential;
  /** Whether the identity provider has verified this address. */
  emailVerified: boolean;
  /**
   * Whether the identity provider calls this person an administrator. Badger
   * grants nothing for it unless the deployment switches the platform-admin
   * mapping on; the provider only states a fact.
   */
  platformAdministrator: boolean;
}

export interface IdentityRequest {
  method: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Each occurrence, before Node joins repeated header values. */
  headersDistinct: Readonly<Record<string, readonly string[] | undefined>>;
  hostname: string | null;
  /** The TCP peer, supplied by the server, never a forwarded header. */
  remoteAddress: string | null;
}

export type IdentityResult =
  | { kind: "authenticated"; principal: Principal }
  | { kind: "anonymous" }
  | { kind: "denied"; reason: string }
  | { kind: "unavailable"; reason: string };

export interface IdentityAdapter {
  resolve(request: IdentityRequest): Promise<IdentityResult>;
  browser?: BrowserSignIn;
  /** Stops the adapter's timers; the service calls it when it closes. */
  close?(): void;
}

/** `reason` explains a failure for the operator's log; it holds no secret. */
export interface BrowserSignIn {
  begin(
    returnPath: string | null,
  ): Promise<
    | { authorizationUrl: string; transactionToken: string; state: string }
    | { kind: "unavailable"; reason: string }
  >;
  complete(
    transactionToken: string | null,
    callback: URL,
  ): Promise<
    | { kind: "authenticated"; principal: Principal; returnPath: string }
    | { kind: "invalid"; reason: string }
    | { kind: "unavailable"; reason: string }
  >;
}

export function firstHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}
