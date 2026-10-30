import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, type ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import { loadBundledMigrations } from "../database/migrations.js";
import { openDatabase } from "../database/open.js";
import { configuredIdentityAdapter } from "../identity/configured.js";
import type { IdentityAdapter } from "../identity/identity.js";
import type { IdSource } from "../ids.js";
import type { Logger } from "../log.js";
import { startHttpServer, type StartedServer } from "../start.js";
import { prepareStorage } from "../storage.js";
import { filesystemBlobStore } from "../skills/blobs.js";
import { SourceCheckWorker } from "../workflow-source.js";
import { NotificationWorker } from "../notifications/worker.js";
import type { NotificationChannel } from "../notifications/port.js";
import { WeComChannel } from "../notifications/wecom.js";
import { createFixedClock, type TestClock } from "./clock.js";
import { openTestDatabase } from "./database.js";
import { createSequentialIds } from "./ids.js";
import {
  createTestIdentityAdapter,
  TEST_PERSON_HEADER,
  type TestPerson,
} from "./identity.js";

/**
 * - `test-identity` (the default): service mode, with the test identity
 *   adapter choosing the person per request.
 * - `local`: local single-user mode and its implicit Administrator.
 * - `service`: service mode with the identity adapter its settings select.
 */
export type TestServiceMode = "test-identity" | "local" | "service";

export interface TestServiceOptions {
  notificationChannel?: NotificationChannel;
  mode?: TestServiceMode;
  /**
   * Settings layered over the harness's own and read by the real config
   * loader; `undefined` unsets one. A database named here replaces the
   * harness's fresh one.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /** Replaces the identity adapter the mode selects. */
  identity?: IdentityAdapter;
}

export interface RawRequestInput {
  method?: string;
  path: string;
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface TestService {
  baseUrl: string;
  port: number;
  /** The loaded settings, with the database the service actually uses. */
  config: ServiceConfig;
  clock: TestClock;
  ids: IdSource;
  database: { kind: "pglite" | "postgres" };
  /** Every entry the service logged, in order, with its level. */
  logs: readonly Record<string, unknown>[];
  request(
    requestPath: string,
    init?: RequestInit & { as?: TestPerson },
  ): Promise<Response>;
  rawRequest(input: RawRequestInput): Promise<RawResponse>;
  /** Stops the database while the server keeps serving, for health tests. */
  closeDatabase(): Promise<void>;
  /**
   * Ends the service's database connections from the server's side, as a
   * Postgres restart does. Only on Postgres, with a fresh test database.
   */
  interruptDatabase(): Promise<void>;
  /**
   * A worker role on the service's database, clock, IDs, and storage. Each
   * ID is a separate worker, so a test can claim a job with one and leave it,
   * as a worker that stopped would.
   */
  worker(
    workerId?: string,
    options?: { leaseMilliseconds?: number; pollMilliseconds?: number },
  ): SourceCheckWorker;
  /** Drains workflow jobs (source checks and initialization); returns how many ran. */
  runSourceCheckJobs(): Promise<number>;
  /**
   * Routes pending actions, then handles posts until none is ready; returns
   * how many posts it sent or recorded as failed. `environment` is layered
   * over the service's settings, as a worker role deployed with other
   * settings would read them.
   */
  runNotificationJobs(settings?: {
    environment?: Readonly<Record<string, string | undefined>>;
  }): Promise<number>;
  close(): Promise<void>;
}

// A service deployment must name its database, so the harness names one that
// can never resolve, then serves from its own fresh database instead.
const HARNESS_DATABASE_URL = "postgres://badger@harness.invalid/badger";
const DATABASE_SETTINGS = ["BADGER_DATABASE_URL", "BADGER_DATABASE_PATH"];

function harnessEnvironment(
  mode: TestServiceMode,
  root: string,
): Record<string, string> {
  const common = {
    BADGER_HOST: "127.0.0.1",
    BADGER_PORT: "0",
    BADGER_STORAGE_DIR: root,
    // A suite that tests the dashboard points BADGER_WEB_DIR at a fixture.
    BADGER_WEB_DIR: path.join(root, "web"),
  };
  if (mode === "local") {
    return { ...common, BADGER_MODE: "local" };
  }
  return {
    ...common,
    BADGER_MODE: "service",
    BADGER_IDENTITY: "none",
    BADGER_ALLOWED_HOSTNAMES: "localhost,127.0.0.1,::1",
    BADGER_DATABASE_URL: HARNESS_DATABASE_URL,
  };
}

interface Connection {
  kind: "pglite" | "postgres";
  database: Database;
  config: ServiceConfig;
  interrupt(): Promise<void>;
  release(): Promise<void>;
}

async function connect(
  loaded: ServiceConfig,
  options: TestServiceOptions,
): Promise<Connection> {
  const namesDatabase = DATABASE_SETTINGS.some(
    (name) => options.environment?.[name] !== undefined,
  );
  if (namesDatabase) {
    const database = await openDatabase(loaded.database);
    return {
      kind: loaded.database.kind,
      database,
      config: loaded,
      interrupt: async () => {
        throw new Error("Only a fresh test database can be interrupted");
      },
      release: () => database.close().catch(() => undefined),
    };
  }
  const fresh = await openTestDatabase();
  return {
    kind: fresh.kind,
    database: fresh.database,
    config: { ...loaded, database: fresh.configuration },
    interrupt: fresh.interrupt,
    release: fresh.drop,
  };
}

/**
 * Starts the service in-process the way production does, from settings the
 * real config loader accepts. Tests swap in a test identity adapter, a fresh
 * database (PGlite, or Postgres 17 when BADGER_TEST_DATABASE_URL is set),
 * temporary storage, a fixed clock, and fixed IDs.
 */
export async function startTestService(
  options: TestServiceOptions = {},
): Promise<TestService> {
  const mode = options.mode ?? "test-identity";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-test-"));
  const removeRoot = () => fs.rm(root, { recursive: true, force: true });

  let connection: Connection;
  try {
    const loaded = loadConfig({
      ...harnessEnvironment(mode, root),
      ...options.environment,
    });
    await prepareStorage(loaded.storage);
    connection = await connect(loaded, options);
  } catch (error) {
    await removeRoot();
    throw error;
  }

  const { config } = connection;
  const clock = createFixedClock("2026-10-27T00:00:00.000Z");
  const ids = createSequentialIds();
  const identity =
    options.identity ??
    (mode === "test-identity"
      ? createTestIdentityAdapter()
      : configuredIdentityAdapter(config, clock, connection.database));

  const logs: Record<string, unknown>[] = [];
  const logger: Logger = {
    info: (fields) => logs.push({ level: "info", ...fields }),
    error: (fields) => logs.push({ level: "error", ...fields }),
  };

  let server: StartedServer;
  try {
    server = await startHttpServer({
      config,
      database: connection.database,
      identity,
      clock,
      ids,
      migrations: await loadBundledMigrations(),
      logger,
    });
  } catch (error) {
    await connection.release();
    await removeRoot();
    throw error;
  }

  const baseUrl = server.url;
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/gu, "");

  const request = async (
    requestPath: string,
    init: RequestInit & { as?: TestPerson } = {},
  ): Promise<Response> => {
    const { as, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (as !== undefined) {
      if (mode !== "test-identity" || options.identity !== undefined) {
        throw new Error(
          "Only the test identity adapter selects a person per request",
        );
      }
      headers.set(TEST_PERSON_HEADER, JSON.stringify(as));
    }
    return fetch(new URL(requestPath, baseUrl), { ...rest, headers });
  };

  const rawRequest = (input: RawRequestInput): Promise<RawResponse> =>
    new Promise<RawResponse>((resolve, reject) => {
      const outgoing = http.request(
        {
          host,
          port: server.port,
          method: input.method ?? "GET",
          path: input.path,
          headers: input.headers ?? {},
        },
        (response) => {
          response.setEncoding("utf8");
          let body = "";
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
            });
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });

  const worker = (
    workerId = "test-worker",
    options: { leaseMilliseconds?: number; pollMilliseconds?: number } = {},
  ) =>
    new SourceCheckWorker({
      database: connection.database,
      dependencies: { clock, ids },
      config,
      blobs: filesystemBlobStore(config.storage.blobDirectory),
      workerId,
      ...options,
    });

  let closed = false;
  return {
    baseUrl,
    logs,
    port: server.port,
    config,
    clock,
    ids,
    database: { kind: connection.kind },
    request,
    rawRequest,
    closeDatabase: () => connection.database.close().catch(() => undefined),
    interruptDatabase: connection.interrupt,
    worker,
    runSourceCheckJobs: async () => {
      const running = worker();
      let processed = 0;
      while ((await running.runOnce()) !== null) processed += 1;
      return processed;
    },
    runNotificationJobs: async (settings = {}) => {
      const running = new NotificationWorker({
        database: connection.database,
        dependencies: { clock, ids },
        config:
          settings.environment === undefined
            ? config
            : {
                ...loadConfig({
                  ...harnessEnvironment(mode, root),
                  ...options.environment,
                  ...settings.environment,
                }),
                database: config.database,
              },
        channel:
          options.notificationChannel ?? new WeComChannel(config.notifications),
        logger,
      });
      await running.routePending();
      let processed = 0;
      while ((await running.runOnce()) !== null) processed += 1;
      return processed;
    },
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await server.close();
      await connection.release();
      await removeRoot();
    },
  };
}
