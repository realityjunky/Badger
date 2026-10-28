import { apiUrl } from "../app/paths.js";

export type TokenScope = "engineer" | "expert" | "operator";

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

export type TokenResult<T> =
  { kind: "ok"; value: T } | { kind: "failed" | "denied" | "conflict" };

async function request<T>(
  basePath: string,
  path: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<TokenResult<T>> {
  try {
    const response = await fetch(apiUrl(basePath, path), {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (response.ok) return { kind: "ok", value: (await response.json()) as T };
    return {
      kind:
        response.status === 409
          ? "conflict"
          : response.status === 401 || response.status === 403
            ? "denied"
            : "failed",
    };
  } catch {
    return { kind: "failed" };
  }
}

export function loadTokens(basePath: string, signal: AbortSignal) {
  return request<{ tokens: PersonalAccessToken[] }>(
    basePath,
    "/me/tokens",
    "GET",
    undefined,
    signal,
  );
}

export function createToken(
  basePath: string,
  input: { name: string; scopes: TokenScope[]; expiresAt?: string },
) {
  return request<{ token: PersonalAccessToken; secret: string }>(
    basePath,
    "/me/tokens",
    "POST",
    input,
  );
}

export function revokeToken(basePath: string, token: PersonalAccessToken) {
  return request<{ token: PersonalAccessToken }>(
    basePath,
    `/me/tokens/${encodeURIComponent(token.id)}`,
    "DELETE",
    { revision: token.revision },
  );
}
