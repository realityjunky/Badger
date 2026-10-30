import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeAuditCursor,
  listAuditEvents,
  type AuditChannel,
  type AuditFilters,
  type WriteContext,
} from "../audit.js";
import {
  accessFor,
  isAdministrator,
  managementVisibility,
  readsEverything,
  type Access,
} from "../authorization.js";
import {
  createBinding,
  listInvitations,
  parseBindingInput,
  readBindingById,
  removeBinding,
} from "../bindings.js";
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
import {
  createGroup,
  listGroups,
  listMembers,
  parseCreateGroupInput,
  parseUpdateGroupInput,
  updateGroup,
} from "../groups.js";
import type { Logger } from "../log.js";
import { loopbackOrigins } from "../network.js";
import { signInPerson, type Person } from "../people.js";
import { authenticateToken } from "../tokens.js";
import {
  parsePreferencesInput,
  readPreferences,
  savePreferences,
} from "../preferences.js";
import { readJsonBody } from "./body.js";
import { filesystemBlobStore } from "../skills/blobs.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { RequestError } from "./errors.js";
import { handleSkillsRequest, skillMethods } from "./skills.js";
import { guardRequest } from "./guard.js";
import { handleBrowserSignIn } from "./sign-in.js";
import { buildHealthReport } from "./health.js";
import { escapeHtml, renderHomePage, renderSignedOutPage } from "./page.js";
import { replyTo, type Reply } from "./responses.js";
import { handleWorkflows, workflowMethods } from "./workflows.js";
import { handleTokens, tokenMethods } from "./tokens.js";
import { gateMethods, handleGate } from "./gates.js";
import { dossierMethods, handleDossier } from "./dossier.js";
import { planMethods, handlePlan } from "./plans.js";
import { handleInbox, inboxMethods } from "./inbox.js";
import { handleNotifications, notificationMethods } from "./notifications.js";
import { handleSourceStudy, sourceStudyMethods } from "./source-study.js";
import { handleQuestionnaire, questionnaireMethods } from "./questionnaire.js";
import { handleEvents } from "./events.js";
import { draftingJobMethods, handleDraftingJobs } from "./drafting-jobs.js";
import { tokenRequestAllowed } from "./token-access.js";
import { questionnaireCapabilities } from "../questionnaire/access.js";
import { skillGroupPermissions } from "../skills/access.js";
import { readMyQuestions } from "../questionnaire/my-questions.js";
import { mayManageRoleScope } from "../workflow-access.js";
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
  close(): void;
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

const GROUP_PATH = new RegExp(`^${API}/groups/([^/]+)$`, "u");
const BINDING_PATH = new RegExp(`^${API}/bindings/([^/]+)$`, "u");

function matchedId(pattern: RegExp, path: string): string | null {
  const match = pattern.exec(path);
  if (match?.[1] === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** The methods a path serves, for the Allow header and the write check. */
function allowedMethods(path: string): string {
  const featureMethods =
    skillMethods(path) ??
    workflowMethods(path) ??
    tokenMethods(path) ??
    gateMethods(path) ??
    dossierMethods(path) ??
    planMethods(path) ??
    sourceStudyMethods(path) ??
    inboxMethods(path) ??
    notificationMethods(path) ??
    questionnaireMethods(path) ??
    draftingJobMethods(path);
  if (featureMethods !== null) return featureMethods;
  if (path === `${API}/me/preferences`) {
    return "GET, HEAD, PUT";
  }
  if (path === `${API}/bindings`) {
    return "POST";
  }
  if (matchedId(BINDING_PATH, path) !== null) {
    return "DELETE";
  }
  if (path === `${API}/groups`) {
    return "GET, HEAD, POST";
  }
  if (matchedId(GROUP_PATH, path) !== null) {
    return "PATCH";
  }
  return "GET, HEAD";
}

/** A request that changes records, rather than reading them. */
function isWriteRoute(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") {
    return false;
  }
  return allowedMethods(path).split(", ").includes(method);
}

/** Serves on `port`, the one the server actually bound. */
export function createService(options: ServiceOptions, port: number): Service {
  const stopping = new AbortController();
  const { config, database, clock, ids, identity } = options;
  const serviceDependencies = { clock, ids };
  const blobs = filesystemBlobStore(config.storage.blobDirectory);
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
      remoteAddress: request.socket.remoteAddress ?? null,
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

  /** Who is writing, through which credential and channel, for the audit. */
  function writeContextFor(
    person: Person,
    principal: Principal,
    reply: Reply,
  ): WriteContext {
    return {
      personId: person.id,
      credential: principal.credential,
      channel: channelOf(principal.credential),
      requestId: reply.requestId,
    };
  }

  /** The audit filters a request names, or the reason one is not valid. */
  function readAuditFilters(
    url: URL,
  ): { ok: true; filters: AuditFilters } | { ok: false; message: string } {
    const text = (name: string): string | undefined => {
      const value = url.searchParams.get(name);
      return value === null || value.trim() === "" ? undefined : value.trim();
    };
    const token = (name: string): string | undefined => {
      const value = text(name);
      if (value !== undefined && !/^[A-Za-z0-9_.+@:-]{1,200}$/u.test(value)) {
        throw new Error(`${name} is not a value this log records`);
      }
      return value;
    };

    try {
      const channel = text("channel");
      if (
        channel !== undefined &&
        !["web", "mcp", "worker"].includes(channel)
      ) {
        return {
          ok: false,
          message: "channel must be web, mcp, or worker",
        };
      }
      const from = text("from");
      const to = text("to");
      for (const [name, value] of [
        ["from", from],
        ["to", to],
      ] as const) {
        if (value !== undefined && Number.isNaN(Date.parse(value))) {
          return { ok: false, message: `${name} must be a timestamp` };
        }
      }
      return {
        ok: true,
        filters: {
          actorPersonId: token("actor"),
          actorEmail: token("actorEmail"),
          action: token("action"),
          channel: channel as AuditChannel | undefined,
          targetType: token("targetType"),
          targetId: token("targetId"),
          from,
          to,
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Invalid filter",
      };
    }
  }

  async function listAudit(
    reply: Reply,
    url: URL,
    access: Access,
  ): Promise<void> {
    if (!readsEverything(access)) {
      return reply.error(
        403,
        "denied",
        "Only an Auditor or an Administrator reads the activity log",
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
    const parsed = readAuditFilters(url);
    if (!parsed.ok) {
      return reply.error(400, "invalid", parsed.message);
    }
    reply.json(
      200,
      await listAuditEvents(database, {
        limit,
        after,
        filters: parsed.filters,
      }),
    );
  }

  async function handleCreateBinding(
    request: IncomingMessage,
    reply: Reply,
    person: Person,
    principal: Principal,
    access: Access,
  ): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return reply.error(400, "invalid", body.message);
    }
    const parsed = parseBindingInput(body.value);
    if (!parsed.ok) {
      return reply.error(400, "invalid", parsed.message);
    }
    const input = parsed.value;

    if (!(await mayManageRoleScope(database, access, person, input))) {
      return reply.error(
        403,
        "denied",
        "Only an Administrator, the Group lead, or a Workflow owner within their workflow assigns these roles",
      );
    }

    // Badger refuses a person granting themselves an organization role. An
    // Administrator may override the block, and then the reason is recorded.
    const selfBinding =
      input.scopeType === "organization" &&
      input.email.toLowerCase() === principal.email.toLowerCase();
    if (selfBinding && input.overrideReason === null) {
      return reply.error(
        409,
        "rejected",
        "Badger does not grant an organization role to the person granting it; an Administrator may override with a reason",
      );
    }
    if (!selfBinding && input.overrideReason !== null) {
      return reply.error(
        400,
        "invalid",
        "overrideReason is only for overriding a refused self-grant",
      );
    }

    const created = await createBinding(
      database,
      serviceDependencies,
      writeContextFor(person, principal, reply),
      input,
      input.overrideReason === null
        ? "Role binding recorded"
        : `Override: ${input.overrideReason}`,
    );
    if (created.kind === "missing-group") {
      return reply.error(400, "invalid", "The group does not exist");
    }
    if (created.kind === "missing-workflow") {
      return reply.error(400, "invalid", "The workflow does not exist");
    }
    if (created.kind === "conflict") {
      return reply.error(
        409,
        "conflict",
        "That person or address already holds this role here",
      );
    }
    return reply.json(201, { binding: created.binding });
  }

  async function handleRemoveBinding(
    request: IncomingMessage,
    reply: Reply,
    person: Person,
    principal: Principal,
    access: Access,
    bindingId: string,
  ): Promise<void> {
    const binding = await readBindingById(database, bindingId);
    if (binding === null) {
      return reply.error(404, "invalid", "No such role binding");
    }
    if (!(await mayManageRoleScope(database, access, person, binding))) {
      return reply.error(
        403,
        "denied",
        "Only an Administrator, the Group lead, or a Workflow owner within their workflow removes these roles",
      );
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return reply.error(400, "invalid", body.message);
    }
    const input = body.value;
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !Number.isInteger((input as { revision?: unknown }).revision) ||
      ((input as { revision: number }).revision as number) < 1
    ) {
      return reply.error(
        400,
        "invalid",
        "revision must be a whole number from 1",
      );
    }

    const removed = await removeBinding(
      database,
      serviceDependencies,
      writeContextFor(person, principal, reply),
      bindingId,
      (input as { revision: number }).revision,
      "Role binding removed",
    );
    if (removed.kind === "missing") {
      return reply.error(404, "invalid", "No such role binding");
    }
    if (removed.kind === "stale") {
      return reply.json(409, {
        error: {
          code: "conflict",
          message: "The binding changed since you read it",
        },
        requestId: reply.requestId,
        binding: removed.binding,
      });
    }
    return reply.json(200, { removed: true });
  }

  async function handleCreateGroup(
    request: IncomingMessage,
    reply: Reply,
    person: Person,
    principal: Principal,
    access: Access,
  ): Promise<void> {
    if (!isAdministrator(access)) {
      return reply.error(
        403,
        "denied",
        "Only an Administrator creates a group",
      );
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
      return reply.error(400, "invalid", body.message);
    }
    const input = parseCreateGroupInput(body.value);
    if (!input.ok) {
      return reply.error(400, "invalid", input.message);
    }
    const created = await createGroup(
      database,
      serviceDependencies,
      writeContextFor(person, principal, reply),
      input.value,
    );
    if (created.kind === "missing-parent") {
      return reply.error(400, "invalid", "The parent group does not exist");
    }
    if (created.kind === "conflict") {
      return reply.error(
        409,
        "conflict",
        "A group with that name already sits there",
      );
    }
    return reply.json(201, { group: created.group });
  }

  async function handleUpdateGroup(
    request: IncomingMessage,
    reply: Reply,
    person: Person,
    principal: Principal,
    access: Access,
    groupId: string,
  ): Promise<void> {
    if (!isAdministrator(access)) {
      return reply.error(
        403,
        "denied",
        "Only an Administrator changes a group",
      );
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
      return reply.error(400, "invalid", body.message);
    }
    const input = parseUpdateGroupInput(body.value);
    if (!input.ok) {
      return reply.error(400, "invalid", input.message);
    }
    const updated = await updateGroup(
      database,
      serviceDependencies,
      writeContextFor(person, principal, reply),
      groupId,
      input.value,
    );
    if (updated.kind === "missing") {
      return reply.error(404, "invalid", "No such group");
    }
    if (updated.kind === "stale") {
      return reply.json(409, {
        error: {
          code: "conflict",
          message: "The group changed since you read it",
        },
        requestId: reply.requestId,
        group: updated.group,
      });
    }
    if (updated.kind === "missing-parent") {
      return reply.error(400, "invalid", "The parent group does not exist");
    }
    if (updated.kind === "cycle") {
      return reply.error(409, "rejected", "A group cannot move inside itself");
    }
    if (updated.kind === "conflict") {
      return reply.error(
        409,
        "conflict",
        "A group with that name already sits there",
      );
    }
    return reply.json(200, { group: updated.group });
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
      writeContextFor(person, principal, reply),
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
    const authorization = firstHeader(request.headers, "authorization");
    const guard = guardRequest({
      method,
      hostHeader: firstHeader(request.headers, "host") ?? undefined,
      originHeader: firstHeader(request.headers, "origin") ?? undefined,
      allowedHostnames: config.allowedHostnames,
      allowedOrigins,
      bearer: authorization !== null,
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

    if (
      await handleBrowserSignIn({
        config,
        identity,
        request,
        reply,
        url,
        path,
        database,
        dependencies: serviceDependencies,
        logger: options.logger,
      })
    )
      return;

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

    // Reads and the routes that write are allowed. Refuse any other method
    // before identifying anyone, so no sign-in or audit record is written for
    // a request the service will not serve. A bearer request is authenticated
    // first instead: its use counts toward its rate limit and is recorded, and
    // anything outside the token's scopes, people-only actions included,
    // answers 403.
    if (authorization === null && !reads && !isWriteRoute(method, path)) {
      return reply.error(405, "invalid", "Method not allowed", {
        allow: allowedMethods(path),
      });
    }

    const tokenAuthentication =
      authorization === null
        ? null
        : await authenticateToken(
            database,
            serviceDependencies,
            authorization,
            reply.requestId,
          );
    if (authorization !== null && tokenAuthentication === null)
      return reply.error(
        401,
        "unauthenticated",
        "The personal access token is invalid, expired, or revoked",
      );
    if (tokenAuthentication !== null && tokenAuthentication.retryAfter !== null)
      return reply.error(
        429,
        "rejected",
        "The personal access token rate limit is 60 requests per minute",
        {
          "retry-after": String(tokenAuthentication.retryAfter),
        },
      );
    const identityResult: IdentityResult =
      tokenAuthentication === null
        ? await identify(request, guard.hostname)
        : { kind: "authenticated", principal: tokenAuthentication.principal };
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
      // A dashboard URL opened while signed out shows the signed-out page;
      // only the API answers in JSON.
      return isApi
        ? reply.error(401, "unauthenticated", "Sign in to use Badger")
        : reply.html(
            401,
            renderSignedOutPage(
              config.identity.kind === "oidc"
                ? `${config.basePath === "/" ? "" : config.basePath}/auth/oidc/login`
                : undefined,
            ),
          );
    }

    const principal = identityResult.principal;
    if (
      principal.credential.kind === "token" &&
      !tokenRequestAllowed(principal.credential.scopes ?? [], path, method)
    )
      return reply.error(
        403,
        "denied",
        "This action requires a signed-in person or a different token scope",
      );
    const person =
      tokenAuthentication?.person ?? (await signIn(principal, reply.requestId));
    const access = await accessFor(database, person, principal, config);
    if (principal.credential.kind === "token")
      access.tokenScopes = principal.credential.scopes ?? [];
    const roles = access.organization;

    const authorized: AuthorizedRequest = {
      request,
      reply,
      url,
      path,
      method,
      database,
      config,
      dependencies: serviceDependencies,
      context: writeContextFor(person, principal, reply),
      access,
      person,
      blobs,
    };
    try {
      if (path === `${API}/me/events`)
        return await handleEvents(
          authorized,
          principal,
          stopping.signal,
          async () => {
            const current = await identify(request, guard.hostname);
            return (
              current.kind === "authenticated" &&
              current.principal.issuer === person.issuer &&
              current.principal.subject === person.subject
            );
          },
        );
      if (tokenMethods(path) !== null) return await handleTokens(authorized);
      if (gateMethods(path) !== null) return await handleGate(authorized);
      if (dossierMethods(path) !== null) return await handleDossier(authorized);
      if (planMethods(path) !== null) return await handlePlan(authorized);
      if (inboxMethods(path) !== null) return await handleInbox(authorized);
      if (notificationMethods(path) !== null)
        return await handleNotifications(authorized);
      if (sourceStudyMethods(path) !== null)
        return await handleSourceStudy(authorized);
      if (questionnaireMethods(path) !== null)
        return await handleQuestionnaire(authorized);
      if (draftingJobMethods(path) !== null)
        return await handleDraftingJobs(authorized);
      if (workflowMethods(path) !== null)
        return await handleWorkflows(authorized);
      if (path === `${API}/skills` || path.startsWith(`${API}/skills/`)) {
        return await handleSkillsRequest(authorized);
      }
    } catch (error) {
      if (error instanceof URIError)
        return reply.error(400, "invalid", "Malformed path encoding");
      if (!(error instanceof RequestError)) throw error;
      const code =
        error.status === 403
          ? "denied"
          : error.status === 409
            ? "conflict"
            : "invalid";
      if (error.details === undefined)
        return reply.error(error.status, code, error.message);
      return reply.json(error.status, {
        ...error.details,
        error: { code, message: error.message },
        requestId: reply.requestId,
      });
    }

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
    if (path === `${API}/me/mcp`) {
      const questionnaire = await questionnaireCapabilities(
        database,
        access,
        person,
        null,
      );
      const uploadSkillVersion = (
        await skillGroupPermissions(database, access, person)
      ).some((group) => group.canUpload);
      return reply.json(200, {
        profiles: [
          ...(questionnaire.compose ? ["engineer"] : []),
          ...(questionnaire.answer ||
          questionnaire.raiseConcern ||
          uploadSkillVersion
            ? ["expert"]
            : []),
        ],
        capabilities: {
          ...questionnaire,
          uploadSkillVersion,
        },
      });
    }
    if (path === `${API}/me/questions`) {
      const workflowId = url.searchParams.get("workflowId");
      const versionId = url.searchParams.get("versionId");
      if ((workflowId === null) !== (versionId === null))
        return reply.error(
          400,
          "invalid",
          "Supply workflowId and versionId together",
        );
      return reply.json(
        200,
        await database.transaction((tx) =>
          readMyQuestions(tx, person.id, { workflowId, versionId }),
        ),
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
          groups: access.groups,
        },
        credential: principal.credential,
        // Only a session Badger issued can be ended here; a platform or a
        // proxy owns the others.
        signOut:
          config.identity.kind === "oidc" &&
          principal.credential.kind === "session",
      });
    }
    if (path === `${API}/audit-events`) {
      return listAudit(reply, url, access);
    }
    if (path === `${API}/bindings` && method === "POST") {
      return handleCreateBinding(request, reply, person, principal, access);
    }
    const bindingId = matchedId(BINDING_PATH, path);
    if (bindingId !== null && method === "DELETE") {
      return handleRemoveBinding(
        request,
        reply,
        person,
        principal,
        access,
        bindingId,
      );
    }
    if (path === `${API}/groups` && method === "POST") {
      return handleCreateGroup(request, reply, person, principal, access);
    }
    if (path === `${API}/groups`) {
      return reply.json(200, {
        groups: await listGroups(database, access, person),
      });
    }
    const groupId = matchedId(GROUP_PATH, path);
    if (groupId !== null && method === "PATCH") {
      return handleUpdateGroup(
        request,
        reply,
        person,
        principal,
        access,
        groupId,
      );
    }
    if (path === `${API}/members` || path === `${API}/invitations`) {
      const visibility = await managementVisibility(database, access, person);
      if (visibility === null) {
        return reply.error(
          403,
          "denied",
          "Only an Administrator, an Auditor, or a Group lead reads members and invitations",
        );
      }
      if (path === `${API}/members`) {
        return reply.json(200, {
          members: await listMembers(database, config, visibility),
        });
      }
      return reply.json(200, {
        invitations: await listInvitations(database, visibility),
      });
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
    close: () => stopping.abort(),
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
