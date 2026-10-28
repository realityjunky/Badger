import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import type {
  DatabaseConfiguration,
  ServiceConfig,
  StorageConfiguration,
} from "../config.js";
import type { Database } from "../database/database.js";
import {
  loadBundledMigrations,
  type Migration,
} from "../database/migrations.js";
import { openPgliteDatabase } from "../database/pglite.js";
import { openPostgresDatabase } from "../database/postgres.js";
import type { IdentityAdapter } from "../identity/identity.js";
import { createLocalIdentityAdapter } from "../identity/local.js";
import { silentLogger } from "../log.js";
import { startHttpServer } from "../start.js";
import { createFixedClock, type TestClock } from "./clock.js";
import { createSequentialIds, type SequentialIdSource } from "./ids.js";
import {
  createTestIdentityAdapter,
  TEST_PERSON_HEADER,
  type TestPerson,
} from "./identity.js";

export type TestServiceMode = "test-identity" | "local";

export interface TestServiceOptions {
  mode?: TestServiceMode;
  database?: "pglite" | "postgres";
  identity?: IdentityAdapter;
  migrations?: readonly Migration[];
  clock?: TestClock;
  revision?: string;
  cleanTree?: boolean | null;
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
  config: ServiceConfig;
  clock: TestClock;
  ids: SequentialIdSource;
  storage: StorageConfiguration;
  database: { kind: "pglite" | "postgres" };
  request(
    requestPath: string,
    init?: RequestInit & { as?: TestPerson },
  ): Promise<Response>;
  rawRequest(input: RawRequestInput): Promise<RawResponse>;
  /** Stops the database while the server keeps serving, for health tests. */
  closeDatabase(): Promise<void>;
  close(): Promise<void>;
}

interface OpenTestDatabase {
  database: Database;
  configuration: DatabaseConfiguration;
  kind: "pglite" | "postgres";
  drop(): Promise<void>;
}

async function openTestDatabase(
  requested: "pglite" | "postgres",
): Promise<OpenTestDatabase> {
  if (requested === "pglite") {
    const database = await openPgliteDatabase();
    let dropped = false;
    return {
      database,
      configuration: { kind: "pglite", dataDir: null },
      kind: "pglite",
      drop: async () => {
        if (dropped) {
          return;
        }
        dropped = true;
        await database.close().catch(() => undefined);
      },
    };
  }

  const baseUrl = process.env["BADGER_TEST_DATABASE_URL"];
  if (baseUrl === undefined) {
    throw new Error(
      "BADGER_TEST_DATABASE_URL must point at a Postgres 17 server for the Postgres run",
    );
  }

  const name = `badger_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const database = await openPostgresDatabase(url.toString());

  let dropped = false;
  return {
    database,
    configuration: { kind: "postgres", url: url.toString() },
    kind: "postgres",
    drop: async () => {
      if (dropped) {
        return;
      }
      dropped = true;
      await database.close().catch(() => undefined);
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/**
 * Starts the service in-process for tests: a test identity adapter, PGlite (or
 * the Postgres named by BADGER_TEST_DATABASE_URL), temporary storage, a fixed
 * clock, and fixed IDs. CI sets BADGER_TEST_DATABASE_URL to run this same
 * suite against Postgres 17; each service gets its own fresh database.
 */
export async function startTestService(
  options: TestServiceOptions = {},
): Promise<TestService> {
  const mode = options.mode ?? "test-identity";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-test-"));
  const storage: StorageConfiguration = {
    root,
    blobDirectory: path.join(root, "blob"),
    workspaceDirectory: path.join(root, "workspaces"),
    runDirectory: path.join(root, "runs"),
  };
  for (const directory of Object.values(storage)) {
    await fs.mkdir(directory, { recursive: true });
  }

  const clock = options.clock ?? createFixedClock("2026-10-27T00:00:00.000Z");
  const ids = createSequentialIds();
  const requestedDatabase =
    options.database ??
    (process.env["BADGER_TEST_DATABASE_URL"] ? "postgres" : "pglite");
  const opened = await openTestDatabase(requestedDatabase);

  const administrator = {
    subject: "local-administrator",
    email: "admin@badger.local",
    displayName: "Local Administrator",
  };
  const config: ServiceConfig = {
    mode: mode === "local" ? "local" : "service",
    host: "127.0.0.1",
    port: 0,
    basePath: "/",
    revision: options.revision ?? "test-revision",
    cleanTree: options.cleanTree === undefined ? true : options.cleanTree,
    allowedHostnames: ["localhost", "127.0.0.1", "::1"],
    allowedOrigins:
      mode === "local"
        ? ["http://localhost:8787", "http://127.0.0.1:8787"]
        : [],
    database: opened.configuration,
    identity: { kind: "local", administrator },
    storage,
  };

  const identity: IdentityAdapter =
    options.identity ??
    (mode === "local"
      ? createLocalIdentityAdapter(administrator)
      : createTestIdentityAdapter());

  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    server = await startHttpServer({
      config,
      database: opened.database,
      identity,
      clock,
      ids,
      migrations: options.migrations ?? (await loadBundledMigrations()),
      logger: silentLogger,
    });
  } catch (error) {
    await opened.drop();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }

  const baseUrl = `http://127.0.0.1:${server.port}`;

  const request = async (
    requestPath: string,
    init: RequestInit & { as?: TestPerson } = {},
  ): Promise<Response> => {
    const { as, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (as !== undefined) {
      if (mode === "local") {
        throw new Error(
          "Local mode signs in one implicit Administrator; do not pass `as`",
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
          host: "127.0.0.1",
          port: server?.port ?? 0,
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

  let databaseClosed = false;
  const closeDatabase = async (): Promise<void> => {
    if (databaseClosed) {
      return;
    }
    databaseClosed = true;
    await opened.database.close().catch(() => undefined);
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await server?.close();
    await opened.drop();
    await fs.rm(root, { recursive: true, force: true });
  };

  return {
    baseUrl,
    port: server.port,
    config,
    clock,
    ids,
    storage,
    database: { kind: opened.kind },
    request,
    rawRequest,
    closeDatabase,
    close,
  };
}
