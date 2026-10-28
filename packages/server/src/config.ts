import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export type IdentityConfiguration =
  { kind: "local"; administrator: LocalAdministrator } | { kind: "none" };

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
  /**
   * The built dashboard's directory. It holds index.html and the asset
   * folder; a deployment that ships them elsewhere sets BADGER_WEB_DIR.
   */
  webDirectory: string;
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

/**
 * The dashboard build beside the server package, whether this file runs from
 * src/ or from dist/src/. A deployment that lays the image out differently
 * names the directory itself.
 */
function defaultWebDirectory(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(path.join(directory, "package.json")) &&
      path.basename(directory) === "server" &&
      path.basename(path.dirname(directory)) === "packages"
    ) {
      return path.join(path.dirname(directory), "web", "dist");
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return path.resolve("packages/web/dist");
}

function readWebDirectory(environment: Environment): string {
  const configured = readString(environment, "BADGER_WEB_DIR");
  return configured === undefined
    ? defaultWebDirectory()
    : path.resolve(configured);
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
      "Service mode requires BADGER_IDENTITY; this build provides none",
    );
  }
  if (identityValue === "local" && mode !== "local") {
    throw new ConfigurationError(
      "BADGER_IDENTITY=local trusts loopback callers, so it is available only in local single-user mode; service deployments need a people-facing adapter, which this build does not ship yet",
    );
  }
  if (identityValue !== "local" && identityValue !== "none") {
    throw new ConfigurationError(
      `Unsupported identity adapter ${identityValue}; this build provides local and none`,
    );
  }
  if (identityValue === "none" && mode === "local") {
    throw new ConfigurationError(
      "Local single-user mode always signs in the implicit Administrator",
    );
  }
  const identity: IdentityConfiguration =
    identityValue === "local"
      ? {
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
        }
      : { kind: "none" };

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
    webDirectory: readWebDirectory(environment),
  };
}
