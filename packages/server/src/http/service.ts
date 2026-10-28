import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "../clock.js";
import type { ServiceConfig } from "../config.js";
import { listAuditEvents } from "../audit.js";
import type { Database } from "../database/database.js";
import type { Migration } from "../database/migrations.js";
import type {
  IdentityAdapter,
  IdentityRequest,
  IdentityResult,
  Principal,
} from "../identity/identity.js";
import { firstHeader } from "../identity/identity.js";
import type { IdSource } from "../ids.js";
import type { Logger } from "../log.js";
import { signInPerson, type Person } from "../people.js";
import { guardRequest } from "./guard.js";
import { buildHealthReport } from "./health.js";
import { escapeHtml, renderHomePage, renderSignedOutPage } from "./page.js";
import { sendError, sendHtml, sendJson, sendResponse } from "./responses.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
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

function rolesOf(principal: Principal): string[] {
  return principal.isAdministrator ? ["Administrator"] : [];
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

export function createService(options: ServiceOptions): Service {
  const { config, database, clock, ids, identity } = options;
  const serviceDependencies = { clock, ids };

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
        channel: "web",
        requestId,
      }),
    );
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const started = performance.now();
    const requestId = resolveRequestId(request.headers["x-request-id"]);
    const method = (request.method ?? "GET").toUpperCase();
    const url = new URL(request.url ?? "/", "http://placeholder.invalid");

    const logRequest = () => {
      options.logger?.info({
        event: "request",
        requestId,
        method,
        path: url.pathname,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    };

    const guard = guardRequest({
      method,
      hostHeader: firstHeader(request.headers, "host") ?? undefined,
      originHeader: firstHeader(request.headers, "origin") ?? undefined,
      allowedHostnames: config.allowedHostnames,
      allowedOrigins: config.allowedOrigins,
    });
    if (!guard.ok) {
      sendError(
        request,
        response,
        requestId,
        guard.status,
        guard.code,
        guard.message,
      );
      logRequest();
      return;
    }

    const path = routePath(url.pathname, config.basePath);
    if (path === null) {
      sendError(request, response, requestId, 404, "not-found", "Not found");
      logRequest();
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendResponse(request, response, requestId, {
        status: 405,
        contentType: "text/plain; charset=utf-8",
        body: "Method not allowed\n",
        headers: { allow: "GET, HEAD" },
      });
      logRequest();
      return;
    }

    if (path === "/health") {
      const report = await buildHealthReport({
        config,
        database,
        migrations: options.migrations,
      });
      sendJson(
        request,
        response,
        requestId,
        report.status === "ok" ? 200 : 503,
        report,
      );
      logRequest();
      return;
    }

    const identityResult = await identify(request, guard.hostname);
    if (identityResult.kind === "unavailable") {
      sendError(
        request,
        response,
        requestId,
        503,
        "unavailable",
        "The identity provider is unavailable",
      );
      logRequest();
      return;
    }
    if (identityResult.kind === "denied") {
      sendError(
        request,
        response,
        requestId,
        403,
        "denied",
        "This account may not use Badger",
      );
      logRequest();
      return;
    }
    if (identityResult.kind === "anonymous") {
      if (path === "/") {
        sendHtml(request, response, requestId, 401, renderSignedOutPage());
      } else {
        sendError(
          request,
          response,
          requestId,
          401,
          "unauthenticated",
          "Sign in to use Badger",
        );
      }
      logRequest();
      return;
    }

    const principal = identityResult.principal;
    const person = await signIn(principal, requestId);

    if (path === "/") {
      sendHtml(
        request,
        response,
        requestId,
        200,
        renderHomePage({
          displayName: person.displayName,
          email: person.email,
          roles: rolesOf(principal),
          revision: config.revision,
        }),
      );
      logRequest();
      return;
    }

    if (path === "/api/me") {
      sendJson(request, response, requestId, 200, {
        person: {
          id: person.id,
          issuer: person.issuer,
          subject: person.subject,
          email: person.email,
          displayName: person.displayName,
          roles: rolesOf(principal),
        },
        credential: principal.credential,
      });
      logRequest();
      return;
    }

    if (path === "/api/audit-events") {
      if (!principal.isAdministrator) {
        sendError(
          request,
          response,
          requestId,
          403,
          "denied",
          "Only an Administrator reads the audit log",
        );
        logRequest();
        return;
      }
      const limit = readAuditLimit(url.searchParams.get("limit"));
      if (limit === null) {
        sendError(
          request,
          response,
          requestId,
          400,
          "invalid",
          `limit must be a whole number from 1 to ${MAX_AUDIT_LIMIT}`,
        );
        logRequest();
        return;
      }
      const events = await listAuditEvents(database, { limit });
      sendJson(request, response, requestId, 200, { events });
      logRequest();
      return;
    }

    if (path.startsWith("/api/")) {
      sendError(request, response, requestId, 404, "not-found", "Not found");
    } else {
      sendResponse(request, response, requestId, {
        status: 404,
        contentType: "text/html; charset=utf-8",
        body: `<h1>Not found</h1><p>${escapeHtml(path)} is not a page.</p>`,
      });
    }
    logRequest();
  }

  return {
    handler: (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        options.logger?.error({
          event: "request.failed",
          error: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          sendError(
            request,
            response,
            resolveRequestId(request.headers["x-request-id"]),
            500,
            "internal",
            "The service could not complete the request",
          );
        } else {
          response.end();
        }
      });
    },
  };
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
