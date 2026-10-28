import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeAuditCursor,
  listAuditEvents,
  type AuditChannel,
} from "../audit.js";
import { organizationRoles, type OrganizationRole } from "../authorization.js";
import type { Clock } from "../clock.js";
import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import type { Migration } from "../database/migrations.js";
import {
  firstHeader,
  type Credential,
  type IdentityAdapter,
  type IdentityRequest,
  type IdentityResult,
  type Principal,
} from "../identity/identity.js";
import type { IdSource } from "../ids.js";
import type { Logger } from "../log.js";
import { loopbackOrigins } from "../network.js";
import { signInPerson, type Person } from "../people.js";
import {
  parsePreferencesInput,
  readPreferences,
  savePreferences,
} from "../preferences.js";
import { readJsonBody } from "./body.js";
import { guardRequest } from "./guard.js";
import { buildHealthReport } from "./health.js";
import { escapeHtml, renderHomePage, renderSignedOutPage } from "./page.js";
import { replyTo, type Reply } from "./responses.js";
import {
  isFileRequest,
  readWebAsset,
  readWebDocument,
  WEB_CONTENT_SECURITY_POLICY,
} from "./web.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const API = "/api/v1";
const DEFAULT_AUDIT_LIMIT = 50;
const MAX_AUDIT_LIMIT = 200;

export interface ServiceOptions {
  config: ServiceConfig;
  identity: IdentityAdapter;
  database: Database;
  clock: Clock;
  ids: IdSource;
  migrations: readonly Migration[];
  logger?: Logger;
}

export interface Service {
  handler: (request: IncomingMessage, response: ServerResponse) => void;
}

function resolveRequestId(headerValue: string | string[] | undefined): string {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (value !== undefined && REQUEST_ID_PATTERN.test(value)) {
    return value;
  }
  return `req-${randomUUID()}`;
}

/** The Badger MCP calls the API with a personal access token; people use the web. */
function channelOf(credential: Credential): AuditChannel {
  return credential.kind === "token" ? "mcp" : "web";
}

function routePath(pathname: string, basePath: string): string | null {
  if (basePath === "/") {
    return pathname;
  }
  if (pathname === basePath) {
    return "/";
  }
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length);
  }
  return null;
}

function readAuditLimit(raw: string | null): number | null {
  if (raw === null) {
    return DEFAULT_AUDIT_LIMIT;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_LIMIT) {
    return null;
  }
  return limit;
}

/** Serves on `port`, the one the server actually bound. */
export function createService(options: ServiceOptions, port: number): Service {
  const { config, database, clock, ids, identity } = options;
  const serviceDependencies = { clock, ids };
  const allowedOrigins =
    config.allowedOrigins === "loopback"
      ? loopbackOrigins(port)
      : config.allowedOrigins;

  async function identify(
    request: IncomingMessage,
    hostname: string,
  ): Promise<IdentityResult> {
    const identityRequest: IdentityRequest = {
      method: request.method ?? "GET",
      headers: request.headers,
      hostname,
    };
    try {
      return await identity.resolve(identityRequest);
    } catch (error) {
      options.logger?.error({
        event: "identity.failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "unavailable", reason: "identity provider failed" };
    }
  }

  async function signIn(
    principal: Principal,
    requestId: string,
  ): Promise<Person> {
    return database.transaction((tx) =>
      signInPerson(tx, serviceDependencies, principal, {
        channel: channelOf(principal.credential),
        requestId,
      }),
    );
  }

  async function listAudit(
    reply: Reply,
    url: URL,
    roles: readonly OrganizationRole[],
  ): Promise<void> {
    if (!roles.includes("Administrator")) {
      return reply.error(
        403,
        "denied",
        "Only an Administrator reads the audit log",
      );
    }
    const limit = readAuditLimit(url.searchParams.get("limit"));
    if (limit === null) {
      return reply.error(
        400,
        "invalid",
        `limit must be a whole number from 1 to ${MAX_AUDIT_LIMIT}`,
      );
    }
    const cursor = url.searchParams.get("cursor");
    const after = cursor === null ? null : decodeAuditCursor(cursor);
    if (cursor !== null && after === null) {
      return reply.error(
        400,
        "invalid",
        "cursor is not one this service issued",
      );
    }
    reply.json(200, await listAuditEvents(database, { limit, after }));
  }

  async function handlePreferences(
    request: IncomingMessage,
    reply: Reply,
    person: Person,
    principal: Principal,
    method: string,
  ): Promise<void> {
    if (method === "GET" || method === "HEAD") {
      return reply.json(200, {
        preferences: await readPreferences(database, person.id),
      });
    }
    if (method !== "PUT") {
      return reply.error(405, "invalid", "Method not allowed", {
        allow: "GET, HEAD, PUT",
      });
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return reply.error(400, "invalid", body.message);
    }
    const input = parsePreferencesInput(body.value);
    if (!input.ok) {
      return reply.error(400, "invalid", input.message);
    }

    const saved = await savePreferences(
      database,
      serviceDependencies,
      {
        personId: person.id,
        credential: principal.credential,
        channel: channelOf(principal.credential),
        requestId: reply.requestId,
      },
      input.value,
    );
    if (saved.kind === "conflict") {
      return reply.json(409, {
        error: {
          code: "conflict",
          message: "The preferences changed since you read them",
        },
        requestId: reply.requestId,
        preferences: saved.preferences,
      });
    }
    return reply.json(200, { preferences: saved.preferences });
  }

  async function handle(
    request: IncomingMessage,
    reply: Reply,
    url: URL,
  ): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const guard = guardRequest({
      method,
      hostHeader: firstHeader(request.headers, "host") ?? undefined,
      originHeader: firstHeader(request.headers, "origin") ?? undefined,
      allowedHostnames: config.allowedHostnames,
      allowedOrigins,
    });
    if (!guard.ok) {
      return reply.error(403, "denied", guard.message);
    }

    const path = routePath(url.pathname, config.basePath);
    if (path === null) {
      return reply.error(404, "invalid", "Not found");
    }
    const reads = method === "GET" || method === "HEAD";
    const isApi = path === "/api" || path.startsWith("/api/");
    const preferencesPath = path === `${API}/me/preferences`;

    if (path === "/health") {
      if (!reads) {
        return reply.error(405, "invalid", "Method not allowed", {
          allow: "GET, HEAD",
        });
      }
      const report = await buildHealthReport({
        config,
        database,
        migrations: options.migrations,
      });
      return reply.json(report.status === "ok" ? 200 : 503, report);
    }

    // The dashboard's assets are public: the sign-in page and the app both
    // need them before anyone is identified.
    if (!isApi && isFileRequest(path)) {
      if (!reads) {
        return reply.error(405, "invalid", "Method not allowed", {
          allow: "GET, HEAD",
        });
      }
      const asset = await readWebAsset(config.webDirectory, path);
      if (asset === null) {
        return reply.error(404, "invalid", "Not found");
      }
      return reply.send({
        status: 200,
        contentType: asset.contentType,
        body: asset.body,
        headers: { "cache-control": asset.cacheControl },
      });
    }

    // Only the preferences endpoint writes; every other route is read-only.
    // Refuse other methods before identifying anyone, so no sign-in or audit
    // record is written for a request the service will not serve.
    if (!reads && !preferencesPath) {
      return reply.error(405, "invalid", "Method not allowed", {
        allow: "GET, HEAD",
      });
    }

    const identityResult = await identify(request, guard.hostname);
    if (identityResult.kind === "unavailable") {
      return reply.error(
        503,
        "unavailable",
        "The identity provider is unavailable",
      );
    }
    if (identityResult.kind === "denied") {
      return reply.error(403, "denied", "This account may not use Badger");
    }
    if (identityResult.kind === "anonymous") {
      return path === "/"
        ? reply.html(401, renderSignedOutPage())
        : reply.error(401, "unauthenticated", "Sign in to use Badger");
    }

    const principal = identityResult.principal;
    const person = await signIn(principal, reply.requestId);
    const roles = organizationRoles(person, config);

    if (preferencesPath) {
      return handlePreferences(request, reply, person, principal, method);
    }
    if (!isApi) {
      const document = await readWebDocument(
        config.webDirectory,
        config.basePath,
      );
      if (document !== null) {
        return reply.send({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: document,
          headers: {
            "content-security-policy": WEB_CONTENT_SECURITY_POLICY,
          },
        });
      }
    }
    if (path === "/") {
      // No dashboard build beside the server: the walking skeleton's page.
      return reply.html(
        200,
        renderHomePage({
          displayName: person.displayName,
          email: person.email,
          roles,
          revision: config.revision,
        }),
      );
    }
    if (path === `${API}/me`) {
      return reply.json(200, {
        person: {
          id: person.id,
          issuer: person.issuer,
          subject: person.subject,
          email: person.email,
          displayName: person.displayName,
          roles,
        },
        credential: principal.credential,
      });
    }
    if (path === `${API}/audit-events`) {
      return listAudit(reply, url, roles);
    }
    if (isApi) {
      return reply.error(404, "invalid", "Not found");
    }
    reply.send({
      status: 404,
      contentType: "text/html; charset=utf-8",
      body: `<h1>Not found</h1><p>${escapeHtml(path)} is not a page.</p>`,
    });
  }

  return {
    handler: (request, response) => {
      const started = performance.now();
      const requestId = resolveRequestId(request.headers["x-request-id"]);
      const url = new URL(request.url ?? "/", "http://placeholder.invalid");
      const reply = replyTo(request, response, requestId);
      response.once("close", () => {
        options.logger?.info({
          event: "request",
          requestId,
          method: request.method,
          path: url.pathname,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - started),
        });
      });
      void handle(request, reply, url).catch((error: unknown) => {
        options.logger?.error({
          event: "request.failed",
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (response.headersSent) {
          response.end();
          return;
        }
        reply.error(
          500,
          "unavailable",
          "The service could not complete the request",
        );
      });
    },
  };
}
