import path from "node:path";
import { isLoopbackHostname, normalizeHostname } from "./network.js";
import type { LocalAdministrator } from "./identity/local.js";

export type ServiceMode = "local" | "service";

export type DatabaseConfiguration =
  | { kind: "postgres"; url: string }
  | { kind: "pglite"; dataDir: string | null };

export interface StorageConfiguration {
  root: string;
  blobDirectory: string;
  workspaceDirectory: string;
  runDirectory: string;
}

/**
 * Settings for the adapter that proves a person through the platform's own
 * session. Every platform-specific value comes from configuration.
 */
export interface PlatformSessionSettings {
  /** The platform's internal base URL, without a trailing slash. */
  url: string;
  /** The platform's current-user endpoint, such as `/auth/me`. */
  currentUserPath: string;
  /** The name of the cookie that carries the platform session token. */
  sessionCookie: string;
  /**
   * How the token reaches the current-user endpoint: in a cookie of the same
   * name, or as an `Authorization: Bearer` header.
   */
  currentUserAuth: "cookie" | "bearer";
  /**
   * The issuer every principal from this platform carries. Sign-in matches
   * people on issuer and subject, so it must outlive any change of address.
   */
  issuer: string;
  /** When set, the platform must grant the person this app. */
  requiredAppGrant: string | null;
  /** How long a validated session is remembered. 0 disables the cache. */
  cacheSeconds: number;
  timeoutMs: number;
}

export type IdentityConfiguration =
  | { kind: "local"; administrator: LocalAdministrator }
  | { kind: "none" }
  | { kind: "platform-session"; platform: PlatformSessionSettings };

/**
 * The origins a write may come from. Local mode without a list allows its
 * own loopback origins, which are known once the server has a port.
 */
export type AllowedOrigins = readonly string[] | "loopback";

export interface ServiceConfig {
  mode: ServiceMode;
  host: string;
  /** 0 lets the server pick a free port when it starts. */
  port: number;
  basePath: string;
  revision: string;
  cleanTree: boolean | null;
  allowedHostnames: string[];
  allowedOrigins: AllowedOrigins;
  database: DatabaseConfiguration;
  identity: IdentityConfiguration;
  /** Emails, lowercased, of the people Badger treats as Administrators. */
  bootstrapAdministrators: string[];
  storage: StorageConfiguration;
}

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

type Environment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1"];
const LOCAL_ADMINISTRATOR_SUBJECT = "local-administrator";

function readString(
  environment: Environment,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function readBoolean(
  environment: Environment,
  name: string,
): boolean | undefined {
  const value = readString(environment, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new ConfigurationError(`${name} must be true or false`);
}

function readPort(environment: Environment): number {
  const value = readString(environment, "BADGER_PORT");
  if (value === undefined) {
    return 8787;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigurationError("BADGER_PORT must be a port number");
  }
  return port;
}

function readBasePath(environment: Environment): string {
  const value = readString(environment, "BADGER_BASE_PATH") ?? "/";
  if (!value.startsWith("/")) {
    throw new ConfigurationError("BADGER_BASE_PATH must start with /");
  }
  const withoutTrailingSlash = value.replace(/\/+$/u, "");
  return withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
}

function readList(
  environment: Environment,
  name: string,
): string[] | undefined {
  const value = readString(environment, name);
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function readHostnames(environment: Environment, mode: ServiceMode): string[] {
  const configured = readList(environment, "BADGER_ALLOWED_HOSTNAMES");
  if (configured === undefined) {
    // A service deployment must name its hostnames; local mode is loopback.
    return mode === "local" ? [...LOOPBACK_HOSTNAMES] : [];
  }
  const hostnames = configured.map(normalizeHostname);
  if (mode === "local" && !hostnames.every(isLoopbackHostname)) {
    throw new ConfigurationError(
      "Local single-user mode allows loopback hostnames only in BADGER_ALLOWED_HOSTNAMES",
    );
  }
  return hostnames;
}

function readOrigins(
  environment: Environment,
  mode: ServiceMode,
): AllowedOrigins {
  const configured = readList(environment, "BADGER_ALLOWED_ORIGINS");
  if (configured === undefined) {
    return mode === "local" ? "loopback" : [];
  }
  return configured.map((entry) => {
    let origin: URL;
    try {
      origin = new URL(entry);
    } catch {
      throw new ConfigurationError(
        "BADGER_ALLOWED_ORIGINS must list origins such as https://badger.example",
      );
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new ConfigurationError(
        "BADGER_ALLOWED_ORIGINS must list http or https origins",
      );
    }
    if (mode === "local" && !isLoopbackHostname(origin.hostname)) {
      throw new ConfigurationError(
        "Local single-user mode allows loopback origins only in BADGER_ALLOWED_ORIGINS",
      );
    }
    return origin.origin;
  });
}

function readBootstrapAdministrators(environment: Environment): string[] {
  const emails = readList(environment, "BADGER_BOOTSTRAP_ADMINISTRATORS") ?? [];
  if (emails.some((email) => !/^[^@\s]+@[^@\s]+$/u.test(email))) {
    throw new ConfigurationError(
      "BADGER_BOOTSTRAP_ADMINISTRATORS must list email addresses",
    );
  }
  return emails.map((email) => email.toLowerCase());
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

function readInteger(
  environment: Environment,
  name: string,
  fallback: number,
  range: { min: number; max: number },
): number {
  const value = readString(environment, name);
  if (value === undefined) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < range.min || number > range.max) {
    throw new ConfigurationError(
      `${name} must be a whole number from ${range.min} to ${range.max}`,
    );
  }
  return number;
}

function readPlatformSession(
  environment: Environment,
): PlatformSessionSettings {
  const rawUrl = readString(environment, "BADGER_PLATFORM_URL");
  if (rawUrl === undefined) {
    throw new ConfigurationError(
      "BADGER_IDENTITY=platform-session requires BADGER_PLATFORM_URL",
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigurationError(
      "BADGER_PLATFORM_URL must be an http or https URL",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(
      "BADGER_PLATFORM_URL must be an http or https URL",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError(
      "BADGER_PLATFORM_URL must not carry credentials, a query, or a fragment",
    );
  }

  const currentUserPath = readString(
    environment,
    "BADGER_PLATFORM_CURRENT_USER_PATH",
  );
  if (currentUserPath === undefined) {
    throw new ConfigurationError(
      "BADGER_IDENTITY=platform-session requires BADGER_PLATFORM_CURRENT_USER_PATH",
    );
  }
  if (!currentUserPath.startsWith("/") || /[\s?#]/u.test(currentUserPath)) {
    throw new ConfigurationError(
      "BADGER_PLATFORM_CURRENT_USER_PATH must start with / and name a path",
    );
  }

  const sessionCookie = readString(
    environment,
    "BADGER_PLATFORM_SESSION_COOKIE",
  );
  if (sessionCookie === undefined) {
    throw new ConfigurationError(
      "BADGER_IDENTITY=platform-session requires BADGER_PLATFORM_SESSION_COOKIE",
    );
  }
  if (!COOKIE_NAME_PATTERN.test(sessionCookie)) {
    throw new ConfigurationError(
      "BADGER_PLATFORM_SESSION_COOKIE must be a cookie name",
    );
  }

  const currentUserAuth =
    readString(environment, "BADGER_PLATFORM_CURRENT_USER_AUTH") ?? "cookie";
  if (currentUserAuth !== "cookie" && currentUserAuth !== "bearer") {
    throw new ConfigurationError(
      "BADGER_PLATFORM_CURRENT_USER_AUTH must be cookie or bearer",
    );
  }

  // No default: an issuer derived from the internal address would change with
  // it, and every person would then sign in as someone new.
  const issuer = readString(environment, "BADGER_PLATFORM_ISSUER");
  if (issuer === undefined) {
    throw new ConfigurationError(
      "BADGER_IDENTITY=platform-session requires BADGER_PLATFORM_ISSUER",
    );
  }

  return {
    url: `${url.origin}${url.pathname.replace(/\/+$/u, "")}`,
    currentUserPath,
    sessionCookie,
    currentUserAuth,
    issuer,
    requiredAppGrant:
      readString(environment, "BADGER_PLATFORM_APP_GRANT") ?? null,
    cacheSeconds: readInteger(
      environment,
      "BADGER_PLATFORM_CACHE_SECONDS",
      30,
      { min: 0, max: 3600 },
    ),
    timeoutMs: readInteger(environment, "BADGER_PLATFORM_TIMEOUT_MS", 3000, {
      min: 1,
      max: 60_000,
    }),
  };
}

function readDatabase(
  environment: Environment,
  mode: ServiceMode,
): DatabaseConfiguration {
  const url = readString(environment, "BADGER_DATABASE_URL");
  if (url !== undefined) {
    return { kind: "postgres", url };
  }
  if (mode === "service") {
    throw new ConfigurationError("Service mode requires BADGER_DATABASE_URL");
  }
  return {
    kind: "pglite",
    dataDir:
      readString(environment, "BADGER_DATABASE_PATH") ?? ".badger/pglite",
  };
}

function readStorage(environment: Environment): StorageConfiguration {
  const root = readString(environment, "BADGER_STORAGE_DIR") ?? ".badger";
  return {
    root,
    blobDirectory: path.join(root, "blob"),
    workspaceDirectory: path.join(root, "workspaces"),
    runDirectory: path.join(root, "runs"),
  };
}

/**
 * Reads the deployment's settings. Local single-user mode bundles loopback
 * binding, PGlite, and one implicit Administrator; service mode asks for each
 * of them explicitly and fails closed when they are missing.
 */
export function loadConfig(
  environment: Environment = process.env,
): ServiceConfig {
  const modeValue = readString(environment, "BADGER_MODE") ?? "local";
  if (modeValue !== "local" && modeValue !== "service") {
    throw new ConfigurationError(
      `BADGER_MODE must be local or service, not ${modeValue}`,
    );
  }
  const mode: ServiceMode = modeValue;

  const identityValue =
    readString(environment, "BADGER_IDENTITY") ??
    (mode === "local" ? "local" : undefined);
  if (identityValue === undefined) {
    throw new ConfigurationError(
      "Service mode requires BADGER_IDENTITY; this build provides local, none, and platform-session",
    );
  }
  if (identityValue === "local" && mode !== "local") {
    throw new ConfigurationError(
      "BADGER_IDENTITY=local trusts loopback callers, so it is available only in local single-user mode; service deployments need a people-facing adapter",
    );
  }
  if (
    identityValue !== "local" &&
    identityValue !== "none" &&
    identityValue !== "platform-session"
  ) {
    throw new ConfigurationError(
      `Unsupported identity adapter ${identityValue}; this build provides local, none, and platform-session`,
    );
  }
  if (identityValue === "none" && mode === "local") {
    throw new ConfigurationError(
      "Local single-user mode always signs in the implicit Administrator",
    );
  }
  if (identityValue === "platform-session" && mode !== "service") {
    throw new ConfigurationError(
      "BADGER_IDENTITY=platform-session is available only in service mode; local single-user mode signs in its implicit Administrator",
    );
  }

  let identity: IdentityConfiguration;
  if (identityValue === "local") {
    identity = {
      kind: "local",
      administrator: {
        subject: LOCAL_ADMINISTRATOR_SUBJECT,
        email:
          readString(environment, "BADGER_LOCAL_ADMIN_EMAIL") ??
          "admin@badger.local",
        displayName:
          readString(environment, "BADGER_LOCAL_ADMIN_NAME") ??
          "Local Administrator",
      },
    };
  } else if (identityValue === "platform-session") {
    identity = {
      kind: "platform-session",
      platform: readPlatformSession(environment),
    };
  } else {
    identity = { kind: "none" };
  }

  const host =
    readString(environment, "BADGER_HOST") ??
    (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  if (mode === "local" && !isLoopbackHostname(host)) {
    throw new ConfigurationError(
      "Local single-user mode binds to loopback only; use service mode for a reachable deployment",
    );
  }

  const port = readPort(environment);
  const database = readDatabase(environment, mode);
  const allowedHostnames = readHostnames(environment, mode);
  if (mode === "service" && allowedHostnames.length === 0) {
    throw new ConfigurationError(
      "Service mode requires BADGER_ALLOWED_HOSTNAMES",
    );
  }

  return {
    mode,
    host,
    port,
    basePath: readBasePath(environment),
    revision: readString(environment, "BADGER_REVISION") ?? "unknown",
    cleanTree: readBoolean(environment, "BADGER_CLEAN_TREE") ?? null,
    allowedHostnames,
    allowedOrigins: readOrigins(environment, mode),
    database,
    identity,
    bootstrapAdministrators: readBootstrapAdministrators(environment),
    storage: readStorage(environment),
  };
}
