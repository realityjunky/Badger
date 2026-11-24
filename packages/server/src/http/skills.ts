import { canonicalHash } from "@realityjunky/badger";
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
  createVersion,
  versionConfirmation,
} from "../skills/library.js";
import { uploadEnvelopeBytes } from "../skills/upload.js";
import { inspectVersionUpload } from "../skills/version-edit.js";
import {
  removeSkillVersion,
  updateSkillVersionLabel,
  versionRemoval,
} from "../skills/version-lifecycle.js";
import { archiveVersion } from "../skills/zip.js";
import {
  inspectRepository,
  listRepositories,
  registerRepository,
} from "../skills/repositories.js";
import { skillGroupPermissions } from "../skills/access.js";
import type { AuthorizedRequest } from "./authorized-request.js";
import { readJsonBody } from "./body.js";
import { objectInput, RequestError } from "./errors.js";

const API = "/api/v1";

const SKILL_ROUTES: readonly [RegExp, string][] = [
  [/^\/api\/v1\/skills$/u, "GET, HEAD, POST"],
  [/^\/api\/v1\/skills\/[^/]+$/u, "GET, HEAD"],
  [/^\/api\/v1\/skills\/[^/]+\/versions$/u, "GET, HEAD, POST"],
  [/^\/api\/v1\/skills\/[^/]+\/(?:upload-preview|git-preview)$/u, "POST"],
  [/^\/api\/v1\/skills\/[^/]+\/repositories$/u, "GET, HEAD, POST"],
  [/^\/api\/v1\/skills\/[^/]+\/backlog$/u, "GET, HEAD"],
  [/^\/api\/v1\/skills\/[^/]+\/diff$/u, "GET, HEAD"],
  [/^\/api\/v1\/skills\/[^/]+\/versions\/[^/]+$/u, "GET, HEAD, DELETE"],
  [
    /^\/api\/v1\/skills\/[^/]+\/versions\/[^/]+\/(?:files|download|removal)$/u,
    "GET, HEAD",
  ],
  [/^\/api\/v1\/skills\/[^/]+\/versions\/[^/]+\/label$/u, "PATCH"],
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
        ).map((skill) => {
          const permission = skillGroups.find(
            (group) => group.id === skill.groupId,
          );
          return {
            ...skill,
            canUpload: permission?.canUpload ?? false,
            canRemoveVersion: permission?.canRemoveVersion ?? false,
          };
        }),
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
    `^${API}/skills/([^/]+)(?:/(versions|diff|upload-preview|git-preview|repositories|backlog)(?:/([^/]+)(?:/(files|label|download|removal))?)?)?$`,
    "u",
  ).exec(path);
  if (match?.[1] === undefined) return reply.error(404, "invalid", "Not found");
  const skill = await readSkill(database, decodeURIComponent(match[1]));
  if (skill === null) return reply.error(404, "invalid", "No such Skill");
  const permission = skillGroups.find((group) => group.id === skill.groupId);
  if (permission === undefined)
    return reply.error(404, "invalid", "No such Skill");
  const hash =
    match[3] === undefined ? undefined : decodeURIComponent(match[3]);
  if (hash !== undefined && (method === "DELETE" || match[4] === "removal")) {
    if (!permission.canRemoveVersion)
      return reply.error(
        403,
        "denied",
        "Removing a version requires a Group lead or Administrator",
      );
    if (reads)
      return reply.json(
        200,
        await versionRemoval(
          database,
          await readVersion(database, skill.id, hash),
        ),
      );
    const body = await readJsonBody(request);
    if (!body.ok)
      return reply.error(body.status ?? 400, "invalid", body.message);
    return reply.json(
      200,
      await removeSkillVersion(
        database,
        dependencies,
        context,
        skill,
        hash,
        body.value,
      ),
    );
  }
  if (method === "PATCH" && hash !== undefined) {
    if (!permission.canUpload)
      return reply.error(
        403,
        "denied",
        "Editing version labels requires upload rights",
      );
    const body = await readJsonBody(request);
    if (!body.ok)
      return reply.error(body.status ?? 400, "invalid", body.message);
    return reply.json(200, {
      version: await updateSkillVersionLabel(
        database,
        dependencies,
        context,
        skill,
        hash,
        body.value,
      ),
    });
  }
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
    if (match[2] === "repositories") {
      const body = await readJsonBody(request);
      if (!body.ok)
        return reply.error(body.status ?? 400, "invalid", body.message);
      const result = await registerRepository(
        database,
        dependencies,
        context,
        config,
        skill,
        body.value,
      );
      return reply.json(result.created ? 201 : 200, {
        repository: result.repository,
      });
    }
    const body = await readJsonBody(
      request,
      uploadEnvelopeBytes(config.uploads),
    );
    if (!body.ok)
      return reply.error(body.status ?? 400, "invalid", body.message);
    const payload = objectInput(body.value);
    const git =
      match[2] === "git-preview" || payload.repositoryId !== undefined;
    const previewing =
      match[2] === "upload-preview" || match[2] === "git-preview";
    const expectedHash = previewing ? null : versionConfirmation(payload);
    const inspected = git
      ? await inspectRepository(database, config, skill, payload)
      : await inspectVersionUpload(database, config, blobs, skill, payload);
    const { source } = inspected;
    const editOrigin =
      "editOrigin" in inspected ? inspected.editOrigin : undefined;
    const confirmationHash =
      editOrigin &&
      canonicalHash({
        skillId: skill.id,
        ...editOrigin,
        hash: source.hash,
      });
    if (expectedHash === null) {
      return reply.json(200, {
        preview: {
          hash: source.hash,
          inventory: source.inventory,
          scripts: source.scripts,
          description: source.description,
          ...(confirmationHash ? { confirmationHash } : {}),
        },
        ...("base" in inspected && inspected.base !== undefined
          ? {
              diff: diffVersions(
                inspected.base,
                source.hash === inspected.base.hash ? inspected.base : source,
              ),
            }
          : {}),
      });
    }
    if (
      confirmationHash !== undefined &&
      payload.confirmationHash !== confirmationHash
    )
      throw new RequestError(
        409,
        "The edit differs from the reviewed base, files or method. Preview it again.",
      );
    const uploaded = await createVersion(
      database,
      dependencies,
      context,
      blobs,
      skill,
      expectedHash,
      inspected,
    );
    return reply.json(uploaded.created ? 201 : 200, {
      version: uploaded.version,
    });
  }
  if (match[2] === "repositories")
    return reply.json(200, {
      repositories: await listRepositories(database, skill.id),
    });
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
  if (hash === undefined) {
    return reply.json(
      200,
      path.endsWith("/versions")
        ? { versions: await listVersions(database, skill.id) }
        : {
            skill: {
              ...skill,
              canUpload: permission.canUpload,
              canRemoveVersion: permission.canRemoveVersion,
            },
          },
    );
  }
  if (match[4] === "download") {
    const archive = await database.transaction(async (tx) => {
      await tx.query(
        "select hash from skill_versions where skill_id = $1 and hash = $2 for key share",
        [skill.id, hash],
      );
      return archiveVersion(blobs, await readVersion(tx, skill.id, hash));
    });
    return reply.send({
      status: 200,
      contentType: "application/zip",
      body: archive,
      headers: {
        "content-disposition": `attachment; filename="${skill.name}-${hash}.zip"`,
        "content-length": String(archive.byteLength),
      },
    });
  }
  if (match[4] === "files") {
    const editing = url.searchParams.get("mode") === "edit";
    if (editing && !permission.canUpload)
      return reply.error(
        403,
        "denied",
        "Reading an editable file requires upload rights",
      );
    return reply.json(
      200,
      await database.transaction(async (tx) => {
        await tx.query(
          "select hash from skill_versions where skill_id = $1 and hash = $2 for key share",
          [skill.id, hash],
        );
        return previewFile(
          blobs,
          await readVersion(tx, skill.id, hash),
          url.searchParams.get("path"),
          editing
            ? Math.min(config.uploads.maxFileBytes, 5 * 1024 * 1024)
            : undefined,
        );
      }),
    );
  }
  return reply.json(200, {
    version: await readVersion(database, skill.id, hash),
  });
}
