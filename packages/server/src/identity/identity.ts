export type CredentialKind = "session" | "token" | "local-implicit";

export interface Credential {
  kind: CredentialKind;
  id: string | null;
}

/** The person a request acts as. A principal alone grants no permission. */
export interface Principal {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  status: "active";
  isAdministrator: boolean;
  credential: Credential;
}

export interface IdentityRequest {
  method: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  hostname: string | null;
}

export type IdentityResult =
  | { kind: "authenticated"; principal: Principal }
  | { kind: "anonymous" }
  | { kind: "denied"; reason: string }
  | { kind: "unavailable"; reason: string };

export interface IdentityAdapter {
  resolve(request: IdentityRequest): Promise<IdentityResult>;
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
