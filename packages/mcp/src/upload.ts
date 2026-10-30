import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { BadgerTimeoutError, type BadgerApi } from "./api.js";

/** Allow for a slow uplink: half a minute, plus a second per 64 KiB sent. */
export function uploadTimeoutSeconds(bytes: number): number {
  return 30 + Math.ceil(bytes / 65_536);
}

/**
 * Read one regular file through a descriptor that refuses a final symbolic
 * link and special files, and fails if the file is replaced or grows while
 * it is read. `verify` runs once the file is open, before it is read.
 */
export async function readRegularFile(
  target: string,
  maximum: number,
  tooLarge: string,
  verify: () => Promise<void> = async () => undefined,
): Promise<Buffer> {
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    await verify();
    const current = await fs.lstat(target);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new Error("A local file changed while it was being read");
    if (opened.size > maximum) throw new Error(tooLarge);
    const buffer = Buffer.alloc(Math.min(opened.size + 1, maximum + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > opened.size || offset > maximum)
      throw new Error("A local file changed or exceeded the upload byte limit");
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

interface UploadLimits {
  maxBytes: number;
  maxFileBytes: number;
  maxFiles: number;
}

interface SkillFolder {
  root: string;
  rootInfo: Awaited<ReturnType<typeof fs.lstat>>;
  files: { path: string; target: string }[];
  entries: number;
}

/**
 * Whether a path segment names Git metadata: `.git` in any letter case,
 * including with the code points HFS+ ignores or the trailing dots and
 * spaces Windows trims. Git runs commands a repository configures, so
 * neither an upload nor a claimed job folder may hold such an entry. The
 * service applies the same rule to Skill uploads.
 */
export function gitMetadata(segment: string) {
  const name = segment
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "")
    .replace(/[. ]+$/u, "");
  return name.toLowerCase() === ".git" || name.toUpperCase() === ".GIT";
}

function refuseGitFolder(relative: string) {
  if (relative.split(/[\\/]/u).some(gitMetadata))
    throw new Error(
      `Upload path "${relative}" contains a .git folder; upload the Skill without its .git folder, for example from git archive output`,
    );
}

async function contained(root: string, target: string) {
  const real = await fs.realpath(target);
  const relative = path.relative(root, real);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error("A local path escapes the Skill folder");
}

/** Inspect the whole tree before opening files or contacting the service. */
async function inspectFolder(folder: string): Promise<SkillFolder> {
  const selected = path.resolve(folder);
  refuseGitFolder(selected);
  const rootInfo = await fs.lstat(selected);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(
      "Select a regular Skill folder; symbolic links are refused",
    );
  const root = await fs.realpath(selected);
  const files: SkillFolder["files"] = [];
  let entries = 0;
  async function walk(directory: string, prefix: string) {
    await contained(root, directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      entries++;
      const relative = `${prefix}${entry.name}`;
      refuseGitFolder(relative);
      // The service supports at most 10,000 files and ten times as many
      // tree entries. Bound metadata preflight before its limits are fetched.
      if (entries > 100_000 || Buffer.byteLength(relative) > 1024)
        throw new Error("Skill folder exceeds the path or entry limit");
      const target = path.join(directory, entry.name);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink())
        throw new Error("Symbolic links are refused in Skill uploads");
      if (info.isDirectory()) {
        await walk(target, `${relative}/`);
        continue;
      }
      if (!info.isFile()) throw new Error("Only regular files may be uploaded");
      if (files.length >= 10_000)
        throw new Error("Skill folder exceeds the file count limit");
      files.push({ path: relative, target });
    }
  }
  await walk(root, "");
  return { root, rootInfo, files, entries };
}

/** Read inspected regular files only; the service owns validation and identity. */
async function folderFiles(folder: SkillFolder, limits: UploadLimits) {
  const { root, rootInfo } = folder;
  if (folder.files.length > limits.maxFiles)
    throw new Error("Skill folder exceeds the file count limit");
  if (folder.entries > limits.maxFiles * 10)
    throw new Error("Skill folder exceeds the path or entry limit");
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const { path: relative, target } of folder.files) {
    const content = await readRegularFile(
      target,
      Math.min(limits.maxFileBytes, limits.maxBytes - total),
      "Skill folder exceeds the file or total byte limit",
      () => contained(root, target),
    );
    total += content.length;
    files.push({ path: relative, content: content.toString("base64") });
  }
  const after = await fs.lstat(root);
  if (
    after.isSymbolicLink() ||
    after.ino !== rootInfo.ino ||
    after.dev !== rootInfo.dev
  )
    throw new Error("The Skill folder changed while it was being read");
  return files;
}

export async function uploadSkillVersion(
  api: BadgerApi,
  input: {
    skillId: string;
    folder: string;
    scripts: Record<string, string[]>;
    confirmed?: boolean;
    expectedHash?: string;
  },
) {
  if (input.confirmed && !input.expectedHash)
    throw new Error(
      "Preview the folder and quote its expectedHash after the user confirms",
    );
  const folder = await inspectFolder(input.folder);
  const { skills, limits } = await api.request<{
    skills: { id: string; canUpload: boolean }[];
    limits: UploadLimits;
  }>("/skills");
  if (!skills.some((skill) => skill.id === input.skillId && skill.canUpload))
    throw new Error("This Skill is outside your upload permissions");
  const files = await folderFiles(folder, limits);
  let result: {
    preview?: unknown;
    version?: {
      skillId: string;
      hash: string;
      inventory: unknown[];
      scripts: unknown[];
    };
  };
  try {
    result = await api.request(
      `/skills/${encodeURIComponent(input.skillId)}/${input.confirmed ? "versions" : "upload-preview"}`,
      "POST",
      {
        files,
        scripts: input.scripts,
        ...(input.confirmed
          ? { confirmed: true, expectedHash: input.expectedHash }
          : {}),
      },
      uploadTimeoutSeconds(
        files.reduce((sum, file) => sum + file.content.length, 0),
      ),
    );
  } catch (error) {
    if (input.confirmed && error instanceof BadgerTimeoutError)
      throw new Error(
        `Badger did not answer within ${error.seconds} s. The version may have been created; repeat the same confirmed upload to check, because an identical upload returns the existing version.`,
      );
    throw error;
  }
  if (result.version) {
    const { skillId, hash, inventory, scripts } = result.version;
    return {
      version: {
        skillId,
        hash,
        fileCount: inventory.length,
        scriptCount: scripts.length,
      },
    };
  }
  return result;
}
