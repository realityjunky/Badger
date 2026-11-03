import { recordAudit, type WriteContext } from "../audit.js";
import type { Database, Queryable } from "../database/database.js";
import type { ServiceDependencies } from "../dependencies.js";
import { toIsoString } from "../util.js";
import { type SkillSourceFile, type SkillSource } from "@realityjunky/badger";
import { lockBlobStore, type BlobStore } from "./blobs.js";
import { objectInput, RequestError } from "../http/errors.js";

export interface Skill {
  id: string;
  groupId: string;
  name: string;
  createdAt: string;
}

export interface SkillVersion {
  skillId: string;
  hash: string;
  description: string;
  inventory: SkillSourceFile[];
  scripts: SkillSource["scripts"];
  origin: "upload" | "git";
  gitOrigins: GitOrigin[];
  uploadedBy: string;
  createdAt: string;
}

export interface GitOrigin {
  repositoryId: string;
  repository: string;
  commit: string;
  ref: string | null;
}

interface SkillRow {
  id: string;
  group_id: string;
  name: string;
  created_at: string | Date;
}

interface VersionRow {
  skill_id: string;
  hash: string;
  description: string;
  inventory: SkillSourceFile[];
  scripts: SkillSource["scripts"];
  origin: "upload" | "git";
  git_origins?: GitOrigin[];
  uploaded_by: string;
  created_at: string | Date;
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    createdAt: toIsoString(row.created_at),
  };
}

function toVersion(row: VersionRow): SkillVersion {
  return {
    skillId: row.skill_id,
    hash: row.hash,
    description: row.description,
    inventory: row.inventory,
    scripts: row.scripts,
    origin: row.origin,
    gitOrigins: row.git_origins ?? [],
    uploadedBy: row.uploaded_by,
    createdAt: toIsoString(row.created_at),
  };
}

export async function listSkills(
  database: Queryable,
  groupIds: readonly string[],
): Promise<Skill[]> {
  const rows = await database.query<SkillRow>(
    `select id, group_id, name, created_at from skills where group_id = any($1::text[]) order by name, id`,
    [groupIds],
  );
  return rows.rows.map(toSkill);
}

export async function readSkill(
  database: Queryable,
  id: string,
): Promise<Skill | null> {
  const rows = await database.query<SkillRow>(
    "select id, group_id, name, created_at from skills where id = $1",
    [id],
  );
  return rows.rows[0] === undefined ? null : toSkill(rows.rows[0]);
}

export async function createSkill(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  value: unknown,
): Promise<Skill> {
  const input = objectInput(value);
  const name = input["name"];
  const groupId = input["groupId"];
  if (
    typeof name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(name) ||
    typeof groupId !== "string"
  ) {
    throw new RequestError(
      400,
      "A Skill needs a groupId and a lowercase name of 1 to 120 letters, numbers, or hyphens",
    );
  }
  return database.transaction(async (tx) => {
    if (
      (await tx.query("select 1 from groups where id = $1", [groupId])).rows
        .length === 0
    ) {
      throw new RequestError(404, "No such group");
    }
    const rows = await tx.query<SkillRow>(
      `insert into skills (id, group_id, name, created_by, created_at) values ($1, $2, $3, $4, $5) on conflict do nothing returning id, group_id, name, created_at`,
      [
        dependencies.ids.next(),
        groupId,
        name,
        context.personId,
        dependencies.clock.now(),
      ],
    );
    const row = rows.rows[0];
    if (row === undefined)
      throw new RequestError(409, "That Skill already exists in this group");
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action: "skill.created",
      target: { type: "skill", id: row.id, label: name },
      before: null,
      after: null,
      reason: "Skill entry created",
      requestId: context.requestId,
    });
    return toSkill(row);
  });
}

const VERSION_SELECT = `select v.*, coalesce((
  select jsonb_agg(jsonb_build_object(
    'repositoryId', o.repository_id, 'repository', o.repository, 'commit', o.commit_hash, 'ref', o.published_ref
  ) order by o.created_at, o.repository_id, o.commit_hash)
  from skill_version_git_origins o where o.skill_id = v.skill_id and o.hash = v.hash
), '[]'::jsonb) as git_origins from skill_versions v`;

export async function listVersions(
  database: Queryable,
  skillId: string,
): Promise<SkillVersion[]> {
  const rows = await database.query<VersionRow>(
    `${VERSION_SELECT} where v.skill_id = $1 order by v.created_at desc, v.hash`,
    [skillId],
  );
  return rows.rows.map(toVersion);
}

export async function readVersion(
  database: Queryable,
  skillId: string,
  hash: string,
): Promise<SkillVersion> {
  const rows = await database.query<VersionRow>(
    `${VERSION_SELECT} where v.skill_id = $1 and v.hash = $2`,
    [skillId, hash],
  );
  if (rows.rows[0] === undefined)
    throw new RequestError(404, "No such Skill version");
  return toVersion(rows.rows[0]);
}

export function versionConfirmation(input: unknown): string {
  const confirmation = objectInput(input);
  if (confirmation["confirmed"] !== true)
    throw new RequestError(
      400,
      "Confirm the source before creating an immutable version",
    );
  const expectedHash = confirmation["expectedHash"];
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedHash))
    throw new RequestError(
      400,
      "Confirm the source with the expectedHash its preview returned",
    );
  return expectedHash;
}

export async function createVersion(
  database: Database,
  dependencies: ServiceDependencies,
  context: WriteContext,
  blobs: BlobStore,
  skill: Skill,
  expectedHash: string,
  inspected: {
    source: SkillSource;
    files: Map<string, Buffer>;
    gitOrigin?: GitOrigin;
  },
) {
  const { source, files, gitOrigin } = inspected;
  if (expectedHash !== source.hash)
    throw new RequestError(
      409,
      "The source differs from the preview you confirmed; preview it again",
      { hash: source.hash },
    );
  return database.transaction(async (tx) => {
    await lockBlobStore(tx);
    for (const file of source.inventory) {
      const content = files.get(file.path);
      if (content === undefined || (await blobs.put(content)) !== file.hash)
        throw new Error("Upload inventory differs from its blobs");
    }
    const inserted = await tx.query<VersionRow>(
      `insert into skill_versions (skill_id, hash, description, inventory, scripts, origin, uploaded_by, created_at) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8) on conflict do nothing returning *`,
      [
        skill.id,
        source.hash,
        source.description,
        JSON.stringify(source.inventory),
        JSON.stringify(source.scripts),
        gitOrigin === undefined ? "upload" : "git",
        context.personId,
        dependencies.clock.now(),
      ],
    );
    const row = inserted.rows[0];
    let originAdded = false;
    if (gitOrigin !== undefined) {
      const receipt = await tx.query(
        `insert into skill_version_git_origins (skill_id, hash, repository_id, repository, commit_hash, imported_by, created_at, published_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing returning hash`,
        [
          skill.id,
          source.hash,
          gitOrigin.repositoryId,
          gitOrigin.repository,
          gitOrigin.commit,
          context.personId,
          dependencies.clock.now(),
          gitOrigin.ref,
        ],
      );
      originAdded = receipt.rows.length > 0;
    }
    if (row === undefined && !originAdded)
      return {
        created: false,
        version: await readVersion(tx, skill.id, source.hash),
      };
    await recordAudit(tx, dependencies, {
      actor: { personId: context.personId, credential: context.credential },
      channel: context.channel,
      action:
        gitOrigin === undefined
          ? "skill_version.uploaded"
          : "skill_version.imported",
      target: {
        type: "skill_version",
        id: `${skill.id}:${source.hash}`,
        label: `${skill.name} · ${source.hash}`,
      },
      before: null,
      after: { revision: null, hash: source.hash },
      reason:
        gitOrigin === undefined
          ? "Confirmed Skill upload"
          : `Confirmed Git import from ${gitOrigin.repository} at ${gitOrigin.commit}`,
      requestId: context.requestId,
    });
    return {
      created: row !== undefined,
      version: await readVersion(tx, skill.id, source.hash),
    };
  });
}

export async function previewFile(
  blobs: BlobStore,
  version: SkillVersion,
  relative: string | null,
) {
  const file = version.inventory.find((entry) => entry.path === relative);
  if (file === undefined)
    throw new RequestError(404, "No such file in this version");
  const limit = 256 * 1024;
  if (file.bytes > limit)
    return {
      path: file.path,
      bytes: file.bytes,
      hash: file.hash,
      content: null,
      binary: false,
      tooLarge: true,
    };
  const content = await blobs.get(file.hash);
  let text: string | null;
  try {
    text = content.includes(0)
      ? null
      : new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    text = null;
  }
  return {
    path: file.path,
    bytes: file.bytes,
    hash: file.hash,
    content: text,
    binary: text === null,
    tooLarge: false,
  };
}

export function diffVersions(before: SkillVersion, after: SkillVersion) {
  const previous = new Map(before.inventory.map((file) => [file.path, file]));
  const current = new Map(after.inventory.map((file) => [file.path, file]));
  const paths = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const files = paths.flatMap((relative) => {
    const oldFile = previous.get(relative) ?? null;
    const newFile = current.get(relative) ?? null;
    if (oldFile?.hash === newFile?.hash) return [];
    return [
      {
        path: relative,
        status:
          oldFile === null
            ? "added"
            : newFile === null
              ? "removed"
              : "modified",
        before: oldFile,
        after: newFile,
      },
    ];
  });
  const oldScripts = new Map(
    before.scripts.map((script) => [script.path, script.sideEffects]),
  );
  const newScripts = new Map(
    after.scripts.map((script) => [script.path, script.sideEffects]),
  );
  const scripts = [...new Set([...oldScripts.keys(), ...newScripts.keys()])]
    .sort()
    .flatMap((relative) => {
      const oldEffects = oldScripts.get(relative) ?? null;
      const newEffects = newScripts.get(relative) ?? null;
      return JSON.stringify(oldEffects) === JSON.stringify(newEffects)
        ? []
        : [{ path: relative, before: oldEffects, after: newEffects }];
    });
  return { from: before.hash, to: after.hash, files, scripts };
}
