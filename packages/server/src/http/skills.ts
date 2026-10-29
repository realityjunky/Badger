import { readSkillBacklog } from "../questionnaire/resolutions.js";
import { listWorkflows } from "../workflows.js";
import {
  createSkill,
  diffVersions,
  listSkills,
  listVersions,
  previewFile,
  readSkill,
  readVersion,
  uploadVersion,
} from "../skills/library.js";
import { inspectUpload, uploadEnvelopeBytes } from "../skills/upload.js";
import { skillGroupPermissions } from "../skills/access.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput } from "./errors.js";

const API = "/api/v1";

const SKILL_ROUTES: readonly [RegExp, string][] = [
  [/^\/api\/v1\/skills$/u, "GET, HEAD, POST"],
  [/^\/api\/v1\/skills\/[^/]+$/u, "GET, HEAD"],
  [/^\/api\/v1\/skills\/[^/]+\/versions$/u, "GET, HEAD, POST"],
  [/^\/api\/v1\/skills\/[^/]+\/upload-preview$/u, "POST"],
  [/^\/api\/v1\/skills\/[^/]+\/backlog$/u, "GET, HEAD"],
  [/^\/api\/v1\/skills\/[^/]+\/diff$/u, "GET, HEAD"],
  [/^\/api\/v1\/skills\/[^/]+\/versions\/[^/]+(?:\/files)?$/u, "GET, HEAD"],
];
export function skillMethods(path: string): string | null {
  return SKILL_ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}
export async function handleSkillsRequest(
  input: AuthorizedRequest,
): Promise<void> {
  const {
    request,
    reply,
    url,
    path,
    method,
    database,
    config,
    dependencies,
    context,
    access,
    person,
    blobs,
  } = input;
  const methods = skillMethods(path);
  if (methods === null) return reply.error(404, "invalid", "Not found");
  // The service refuses unlisted writes before sign-in; this also refuses a
  // read of a write-only route, such as GET on upload-preview.
  if (!methods.split(", ").includes(method))
    return reply.error(405, "invalid", "Method not allowed", {
      allow: methods,
    });
  const reads = method === "GET" || method === "HEAD";
  const skillGroups = await skillGroupPermissions(database, access, person);
  if (path === `${API}/skills`) {
    if (reads)
      return reply.json(200, {
        skills: (
          await listSkills(
            database,
            skillGroups.map((group) => group.id),
          )
        ).map((skill) => ({
          ...skill,
          canUpload:
            skillGroups.find((group) => group.id === skill.groupId)
              ?.canUpload ?? false,
        })),
        groups: skillGroups,
        limits: config.uploads,
      });
    const body = await readJsonBody(request);
    if (!body.ok)
      return reply.error(body.status ?? 400, "invalid", body.message);
    const input = objectInput(body.value);
    if (
      !skillGroups.some(
        (group) => group.id === input["groupId"] && group.canCreateSkill,
      )
    ) {
      return reply.error(
        403,
        "denied",
        "Creating a Skill requires a Group lead or contributor role",
      );
    }
    return reply.json(201, {
      skill: await createSkill(database, dependencies, context, input),
    });
  }
  const match = new RegExp(
    `^${API}/skills/([^/]+)(?:/(versions|diff|upload-preview|backlog)(?:/([^/]+)(?:/(files))?)?)?$`,
    "u",
  ).exec(path);
  if (match?.[1] === undefined) return reply.error(404, "invalid", "Not found");
  const skill = await readSkill(database, decodeURIComponent(match[1]));
  if (skill === null) return reply.error(404, "invalid", "No such Skill");
  const permission = skillGroups.find((group) => group.id === skill.groupId);
  if (permission === undefined)
    return reply.error(404, "invalid", "No such Skill");
  if (match[2] === "backlog")
    return reply.json(200, {
      items: await readSkillBacklog(
        database,
        skill.id,
        (await listWorkflows(database, access, person)).map((w) => w.id),
      ),
    });
  if (method === "POST") {
    if (!permission.canUpload)
      return reply.error(
        403,
        "denied",
        "An upload requires an Engineer or Field expert workflow role in this group",
      );
    const body = await readJsonBody(
      request,
      uploadEnvelopeBytes(config.uploads),
    );
    if (!body.ok)
      return reply.error(body.status ?? 400, "invalid", body.message);
    if (match[2] === "upload-preview") {
      const { source } = await inspectUpload(config, skill.name, body.value);
      return reply.json(200, {
        preview: {
          hash: source.hash,
          inventory: source.inventory,
          scripts: source.scripts,
          description: source.description,
        },
      });
    }
    const uploaded = await uploadVersion(
      database,
      dependencies,
      context,
      config,
      blobs,
      skill,
      body.value,
    );
    return reply.json(uploaded.created ? 201 : 200, {
      version: uploaded.version,
    });
  }
  if (match[2] === "diff") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from === null || to === null)
      return reply.error(
        400,
        "invalid",
        "A diff needs from and to version hashes",
      );
    return reply.json(
      200,
      diffVersions(
        await readVersion(database, skill.id, from),
        await readVersion(database, skill.id, to),
      ),
    );
  }
  if (match[3] === undefined) {
    return reply.json(
      200,
      path.endsWith("/versions")
        ? { versions: await listVersions(database, skill.id) }
        : { skill },
    );
  }
  const version = await readVersion(
    database,
    skill.id,
    decodeURIComponent(match[3]),
  );
  return reply.json(
    200,
    match[4] === "files"
      ? await previewFile(blobs, version, url.searchParams.get("path"))
      : { version },
  );
}
