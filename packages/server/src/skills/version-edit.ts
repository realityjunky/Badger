import type { ServiceConfig } from "../config.js";
import type { Database } from "../database/database.js";
import { objectInput, RequestError } from "../http/errors.js";
import type { BlobStore } from "./blobs.js";
import {
  readVersion,
  type EditOrigin,
  type Skill,
  type SkillVersion,
} from "./library.js";
import { normalizeSkillPath, type UploadFile } from "./paths.js";
import {
  decodeUploadContent,
  inspectUpload,
  inspectUploadFiles,
  type InspectedUpload,
} from "./upload.js";

interface InspectedVersionUpload extends InspectedUpload {
  base?: SkillVersion;
  editOrigin?: Pick<EditOrigin, "baseHash" | "method">;
}

export async function inspectVersionUpload(
  database: Database,
  config: ServiceConfig,
  blobs: BlobStore,
  skill: Skill,
  value: unknown,
): Promise<InspectedVersionUpload> {
  const {
    baseHash,
    changes,
    confirmationHash: _confirmationHash,
    ...upload
  } = objectInput(value);
  if (baseHash === undefined && changes === undefined)
    return inspectUpload(config, skill.name, upload);
  if (typeof baseHash !== "string" || !/^[a-f0-9]{64}$/u.test(baseHash))
    throw new RequestError(
      400,
      "An edit needs the baseHash of its starting version",
    );
  if (changes === undefined) {
    const base = await readVersion(database, skill.id, baseHash);
    return {
      ...(await inspectUpload(config, skill.name, upload)),
      base,
      editOrigin: { baseHash, method: "upload" },
    };
  }
  if (
    Object.keys(upload).some(
      (key) => !["confirmed", "expectedHash"].includes(key),
    )
  )
    throw new RequestError(400, "A browser edit needs file changes only");
  if (!Array.isArray(changes))
    throw new RequestError(400, "changes must be an array");
  if (changes.length > 2 * config.uploads.maxFiles)
    throw new RequestError(413, "The edit exceeds the file count limit");
  const edits = new Map<string, Buffer | null>();
  for (const value of changes as unknown[]) {
    const change = objectInput(value);
    if (Object.keys(change).some((key) => !["path", "content"].includes(key)))
      throw new RequestError(400, "Changes apply to regular files only");
    const path = normalizeSkillPath(change["path"]);
    if (edits.has(path))
      throw new RequestError(400, "Each file can have only one change");
    const content = change["content"];
    edits.set(path, content === null ? null : decodeUploadContent(content));
  }
  const { base, files } = await database.transaction(async (tx) => {
    await tx.query(
      "select hash from skill_versions where skill_id = $1 and hash = $2 for key share",
      [skill.id, baseHash],
    );
    const base = await readVersion(tx, skill.id, baseHash);
    const files = await applyFileChanges(blobs, base, edits);
    return { base, files };
  });
  return {
    ...(await inspectUploadFiles(config, skill.name, files)),
    base,
    editOrigin: { baseHash, method: "browser" },
  };
}

export async function applyFileChanges(
  blobs: BlobStore,
  base: SkillVersion,
  edits: Map<string, Buffer | null>,
): Promise<UploadFile[]> {
  const previous = new Map(base.inventory.map((file) => [file.path, file]));
  for (const [path, content] of edits) {
    if (content === null && !previous.has(path))
      throw new RequestError(
        400,
        "A removed file must exist in the base version",
      );
    previous.delete(path);
  }
  if (
    (previous.has("SKILL.md") || edits.has("SKILL.md")) &&
    edits.get("SKILL.md") !== null
  ) {
    const files = [];
    for (const file of previous.values())
      files.push({ path: file.path, content: await blobs.get(file.hash) });
    for (const [path, content] of edits) {
      if (content !== null) files.push({ path, content });
    }
    return files;
  }
  throw new RequestError(400, "An edited Skill must keep SKILL.md at its root");
}
