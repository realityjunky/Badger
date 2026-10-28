import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import type { PlatformSessionSettings } from "../config.js";
import {
  firstHeader,
  type IdentityAdapter,
  type IdentityRequest,
  type IdentityResult,
} from "./identity.js";

/** Enough remembered sessions for a working day, few enough to stay bounded. */
const CACHE_LIMIT = 1024;

interface PlatformUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  appGrants: readonly string[];
}

type Introspection =
  | { kind: "user"; user: PlatformUser }
  | { kind: "unauthorized" }
  | { kind: "unavailable"; reason: string };

interface CachedResult {
  result: IdentityResult;
  expiresAt: number;
}

function readCookie(
  headers: IdentityRequest["headers"],
  name: string,
): string | null {
  const header = firstHeader(headers, "cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

/**
 * The cache key and the audit's credential identifier: a token never leaves
 * the request, and never reaches the log or the database.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readGrants(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const grants: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const grant = entry as { app_name?: unknown; revoked_at?: unknown };
    if (
      typeof grant.app_name === "string" &&
      (grant.revoked_at === undefined || grant.revoked_at === null)
    ) {
      grants.push(grant.app_name);
    }
  }
  return grants;
}

function parseUser(body: unknown): PlatformUser | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as {
    id?: unknown;
    email?: unknown;
    display_name?: unknown;
    status?: unknown;
    app_access?: unknown;
  };
  const id =
    typeof record.id === "string"
      ? record.id.trim()
      : typeof record.id === "number"
        ? String(record.id)
        : "";
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const status =
    typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (id === "" || email === "" || status === "") {
    return null;
  }
  const displayName =
    typeof record.display_name === "string" && record.display_name.trim() !== ""
      ? record.display_name.trim()
      : email;

  return {
    id,
    email,
    displayName,
    status,
    appGrants: readGrants(record.app_access),
  };
}

/**
 * Asks the platform who a session token belongs to. Any answer Badger cannot
 * understand is "unavailable": a refusal must never become a guess.
 */
async function introspect(
  settings: PlatformSessionSettings,
  token: string,
): Promise<Introspection> {
  let response: Response;
  try {
    response = await fetch(`${settings.url}${settings.currentUserPath}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(settings.currentUserAuth === "bearer"
          ? { authorization: `Bearer ${token}` }
          : { cookie: `${settings.sessionCookie}=${token}` }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch {
    return { kind: "unavailable", reason: "the platform did not answer" };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status !== 200) {
    return {
      kind: "unavailable",
      reason: `the platform answered ${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "unavailable",
      reason: "the platform answered with invalid JSON",
    };
  }

  const user = parseUser(body);
  if (user === null) {
    return {
      kind: "unavailable",
      reason: "the platform answered with no usable user",
    };
  }
  return { kind: "user", user };
}

/**
 * Proves a person through the platform's session cookie, checked against its
 * current-user endpoint over the internal network. What the platform answers
 * about a token — signed in, refused, or not a session — is remembered
 * briefly under a hash of the token, so a repeated cookie costs no second
 * call. An unavailable platform is never remembered. A person the platform
 * does not call active, or one without the configured app grant, is refused;
 * an unreachable platform yields "unavailable", never a guess.
 */
export function createPlatformSessionIdentityAdapter(
  settings: PlatformSessionSettings,
  clock: Clock,
): IdentityAdapter {
  const cache = new Map<string, CachedResult>();

  function remember(key: string, result: IdentityResult, now: number): void {
    if (settings.cacheSeconds === 0) {
      return;
    }
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.delete(key);
    cache.set(key, {
      result,
      expiresAt: now + settings.cacheSeconds * 1000,
    });
  }

  return {
    resolve: async (request: IdentityRequest): Promise<IdentityResult> => {
      const token = readCookie(request.headers, settings.sessionCookie);
      if (token === null) {
        return { kind: "anonymous" };
      }

      const key = hashToken(token);
      const now = clock.now().getTime();
      const cached = cache.get(key);
      if (cached !== undefined) {
        if (now < cached.expiresAt) {
          return cached.result;
        }
        cache.delete(key);
      }

      const introspection = await introspect(settings, token);
      if (introspection.kind === "unavailable") {
        return { kind: "unavailable", reason: introspection.reason };
      }
      if (introspection.kind === "unauthorized") {
        const anonymous: IdentityResult = { kind: "anonymous" };
        remember(key, anonymous, now);
        return anonymous;
      }

      const { user } = introspection;
      let result: IdentityResult;
      if (user.status !== "active") {
        result = {
          kind: "denied",
          reason: `the platform account is ${user.status}`,
        };
      } else if (
        settings.requiredAppGrant !== null &&
        !user.appGrants.includes(settings.requiredAppGrant)
      ) {
        result = {
          kind: "denied",
          reason: "the platform has not granted this app",
        };
      } else {
        result = {
          kind: "authenticated",
          principal: {
            issuer: settings.issuer,
            subject: user.id,
            email: user.email,
            displayName: user.displayName,
            status: "active",
            credential: { kind: "session", id: key },
          },
        };
      }

      remember(key, result, now);
      return result;
    },
  };
}
