import { mayManageGroup } from "../authorization.js";
import type { Database } from "../database/database.js";
import { listGroups } from "../groups.js";
import { workflowCapabilities } from "../workflow-access.js";
import {
  createWorkflow,
  createWorkflowVersion,
  listWorkflowBindings,
  listWorkflows,
  listWorkflowVersions,
  parseWorkflowFrame,
  readWorkflow,
  updateWorkflow,
} from "../workflows.js";
import {
  listWorkflowJobs,
  listWorkflowPins,
  parsePinInput,
  parseUnpinInput,
  pinSkillVersion,
  readSourceCheck,
  unpinSkillVersion,
} from "../workflow-source.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";

const ROOT = "/api/v1/workflows";
// A version's pins, one pin by its Skill, its latest source check, its jobs.
const WORKFLOW_PATH =
  /^\/api\/v1\/workflows\/([^/]+)(?:\/(versions)(?:\/([^/]+)(?:\/(?:(pins)(?:\/([^/]+))?|(source-check|jobs)))?)?)?$/u;

async function groupName(database: Database, id: string): Promise<string> {
  const result = await database.query<{ name: string }>(
    `select name from groups where id = $1`,
    [id],
  );
  return result.rows[0]?.name ?? "";
}

function workflowPath(path: string) {
  const match = WORKFLOW_PATH.exec(path);
  if (match === null) return null;
  try {
    return {
      id: decodeURIComponent(match[1]),
      versions: match[2] !== undefined,
      versionId: match[3] === undefined ? null : decodeURIComponent(match[3]),
      resource: match[4] ?? match[6] ?? null,
      resourceId: match[5] === undefined ? null : decodeURIComponent(match[5]),
    };
  } catch {
    return null;
  }
}

/** Shared with the service's method and Origin guard. */
export function workflowMethods(path: string): string | null {
  if (path === ROOT) return "GET, HEAD, POST";
  const route = workflowPath(path);
  if (route === null) return null;
  if (!route.versions) return "GET, HEAD, PATCH";
  if (route.versionId === null) return "GET, HEAD, POST";
  if (route.resource === "pins") {
    return route.resourceId === null ? "GET, HEAD, POST" : "DELETE";
  }
  return "GET, HEAD";
}

/** The HTTP seam for the catalog and versions; the service handles identity. */
export async function handleWorkflows(input: AuthorizedRequest): Promise<void> {
  const {
    request,
    reply,
    path,
    method,
    database,
    dependencies,
    person,
    access,
    context,
  } = input;
  if (path === ROOT && method === "POST") {
    const body = await readJsonBody(request);
    if (!body.ok) return reply.error(400, "invalid", body.message);
    if (
      typeof body.value !== "object" ||
      body.value === null ||
      Array.isArray(body.value)
    ) {
      return reply.error(
        400,
        "invalid",
        "The request body must be a JSON object",
      );
    }
    const values = body.value as Record<string, unknown>;
    const unknown = Object.keys(values).find(
      (key) => !["groupId", "name", "goal", "intent", "locale"].includes(key),
    );
    if (unknown !== undefined)
      return reply.error(400, "invalid", `Unknown field ${unknown}`);
    const frame = parseWorkflowFrame(values);
    if (!frame.ok) return reply.error(400, "invalid", frame.message);
    const groupId = values["groupId"];
    if (typeof groupId !== "string" || groupId.trim() === "")
      return reply.error(400, "invalid", "groupId must name a group");
    if (!(await mayManageGroup(database, access, person, groupId))) {
      return reply.error(
        403,
        "denied",
        "Only an Administrator or the group's Group lead creates a workflow",
      );
    }
    const created = await createWorkflow(
      database,
      dependencies,
      context,
      { groupId, ...frame.value },
      person,
    );
    if (created.kind === "missing-group")
      return reply.error(400, "invalid", "The group does not exist");
    if (created.kind === "conflict")
      return reply.error(
        409,
        "conflict",
        "A workflow with that name already belongs to this group",
      );
    return reply.json(201, {
      workflow: created.workflow,
      version: created.version,
    });
  }
  if (path === ROOT) {
    const workflows = await listWorkflows(database, access, person);
    const summaries = [];
    for (const workflow of workflows) {
      summaries.push({
        ...workflow,
        groupName: await groupName(database, workflow.groupId),
        capabilities: await workflowCapabilities(
          database,
          access,
          person,
          workflow,
        ),
        latestVersion:
          (await listWorkflowVersions(database, workflow.id))[0] ?? null,
      });
    }
    const createGroups = [];
    for (const group of await listGroups(database, access, person)) {
      if (
        access.tokenScopes === undefined &&
        (await mayManageGroup(database, access, person, group.id))
      )
        createGroups.push(group);
    }
    return reply.json(200, { workflows: summaries, createGroups });
  }
  const route = workflowPath(path);
  const workflow =
    route === null ? null : await readWorkflow(database, route.id);
  if (workflow === null || route === null)
    return reply.error(404, "invalid", "No such workflow");
  const capabilities = await workflowCapabilities(
    database,
    access,
    person,
    workflow,
  );
  if (!capabilities.read)
    return reply.error(403, "denied", "This workflow is outside your roles");

  if (route.versions && route.versionId !== null && route.resource !== null) {
    // The service refuses unlisted writes before sign-in; this also refuses a
    // read of the write-only pin path.
    const methods = workflowMethods(path) ?? "GET, HEAD";
    if (!methods.split(", ").includes(method))
      return reply.error(405, "invalid", "Method not allowed", {
        allow: methods,
      });
    const versions = await listWorkflowVersions(database, workflow.id);
    const version = versions.find((entry) => entry.id === route.versionId);
    if (version === undefined)
      return reply.error(404, "invalid", "No such workflow version");
    if (route.resource === "pins") {
      if (route.resourceId !== null && method === "DELETE") {
        if (!capabilities.managePins)
          return reply.error(
            403,
            "denied",
            "Only an Administrator or Engineer manages Skill pins",
          );
        const body = await readJsonBody(request);
        if (!body.ok) return reply.error(400, "invalid", body.message);
        const parsed = parseUnpinInput(body.value);
        if (!parsed.ok) return reply.error(400, "invalid", parsed.message);
        const removed = await unpinSkillVersion(
          database,
          dependencies,
          context,
          version.id,
          route.resourceId,
          parsed.revision,
        );
        if (
          removed.kind === "missing-version" ||
          removed.kind === "missing-pin"
        )
          return reply.error(404, "invalid", "No such Skill pin");
        if (removed.kind === "stale")
          return reply.json(409, {
            error: {
              code: "conflict",
              message: "The Skill pin changed since you read it",
            },
            requestId: reply.requestId,
            pin: removed.pin,
          });
        if (removed.kind !== "removed")
          return reply.error(
            409,
            "conflict",
            "The Skill pin changed since you read it",
          );
        return reply.json(200, {
          removed: true,
          job: removed.job,
          pinsHash: removed.pinsHash,
        });
      }
      if (method === "POST") {
        if (!capabilities.managePins)
          return reply.error(
            403,
            "denied",
            "Only an Administrator or Engineer manages Skill pins",
          );
        const body = await readJsonBody(request);
        if (!body.ok) return reply.error(400, "invalid", body.message);
        const parsed = parsePinInput(body.value);
        if (!parsed.ok) return reply.error(400, "invalid", parsed.message);
        const pinned = await pinSkillVersion(
          database,
          dependencies,
          context,
          version.id,
          parsed.value,
        );
        if (pinned.kind === "missing-version")
          return reply.error(404, "invalid", "No such workflow version");
        if (pinned.kind === "missing-skill-version")
          return reply.error(
            404,
            "invalid",
            "No such Skill version in this group",
          );
        if (pinned.kind === "invalid")
          return reply.error(400, "invalid", pinned.message);
        if (pinned.kind === "conflict")
          return reply.error(
            409,
            "conflict",
            "The Skill pins changed at the same time; reload and try again",
          );
        if (pinned.kind !== "created" && pinned.kind !== "updated")
          return reply.json(409, {
            error: {
              code: "conflict",
              message:
                pinned.kind === "unchanged"
                  ? "That Skill version is already pinned with this purpose"
                  : pinned.kind === "upgrade-source-taken"
                    ? "This version already has an upgrade source; unpin it first"
                    : parsed.value.revision === undefined
                      ? "That Skill is already pinned; quote its pin's revision to replace it"
                      : "The Skill pin changed since you read it",
            },
            requestId: reply.requestId,
            pin: pinned.pin,
          });
        return reply.json(pinned.kind === "updated" ? 200 : 201, {
          pin: pinned.pin,
          job: pinned.job,
          pinsHash: pinned.pinsHash,
        });
      }
      return reply.json(200, {
        pins: await listWorkflowPins(database, version.id),
      });
    }
    if (route.resource === "source-check")
      return reply.json(200, {
        sourceCheck: await readSourceCheck(database, version.id),
      });
    return reply.json(200, {
      jobs: await listWorkflowJobs(database, version.id),
    });
  }
  if (method === "PATCH" || method === "POST") {
    if (
      !(method === "PATCH"
        ? capabilities.editWorkflow
        : capabilities.createVersion)
    ) {
      return reply.error(
        403,
        "denied",
        method === "PATCH"
          ? "Only an Administrator, Group lead, or Workflow owner edits a workflow"
          : "Only an Administrator or Engineer starts a workflow version",
      );
    }
    const body = await readJsonBody(request);
    if (!body.ok) return reply.error(400, "invalid", body.message);
    if (
      typeof body.value !== "object" ||
      body.value === null ||
      Array.isArray(body.value)
    )
      return reply.error(
        400,
        "invalid",
        "The request body must be a JSON object",
      );
    const values = body.value as Record<string, unknown>;
    const keys =
      method === "PATCH"
        ? ["revision", "name", "goal", "intent", "locale"]
        : ["revision"];
    const unknown = Object.keys(values).find((key) => !keys.includes(key));
    if (unknown !== undefined)
      return reply.error(400, "invalid", `Unknown field ${unknown}`);
    const revision = values["revision"];
    if (!Number.isInteger(revision) || (revision as number) < 1)
      return reply.error(
        400,
        "invalid",
        "revision must be a whole number from 1",
      );
    const frame = parseWorkflowFrame({ ...workflow, ...values });
    if (!frame.ok) return reply.error(400, "invalid", frame.message);
    const result =
      method === "PATCH"
        ? await updateWorkflow(
            database,
            dependencies,
            context,
            workflow.id,
            revision as number,
            frame.value,
          )
        : await createWorkflowVersion(
            database,
            dependencies,
            context,
            workflow.id,
            revision as number,
          );
    if (result.kind === "missing")
      return reply.error(404, "invalid", "No such workflow");
    if (result.kind === "stale")
      return reply.json(409, {
        error: {
          code: "conflict",
          message: "The workflow changed since you read it",
        },
        requestId: reply.requestId,
        workflow: result.workflow,
      });
    if (result.kind === "duplicate")
      return reply.error(
        409,
        "conflict",
        "A workflow with that name already belongs to this group",
      );
    return result.kind === "created"
      ? reply.json(201, { workflow: result.workflow, version: result.version })
      : reply.json(200, { workflow: result.workflow });
  }
  const versions = await listWorkflowVersions(database, workflow.id);
  if (route.versions) {
    if (route.versionId === null) return reply.json(200, { versions });
    const version = versions.find((entry) => entry.id === route.versionId);
    return version === undefined
      ? reply.error(404, "invalid", "No such workflow version")
      : reply.json(200, {
          workflow,
          version,
          capabilities,
          pins: await listWorkflowPins(database, version.id),
          sourceCheck: await readSourceCheck(database, version.id),
          jobs: await listWorkflowJobs(database, version.id),
        });
  }
  return reply.json(200, {
    workflow,
    groupName: await groupName(database, workflow.groupId),
    versions,
    capabilities,
    bindings: await listWorkflowBindings(database, workflow.id),
  });
}
