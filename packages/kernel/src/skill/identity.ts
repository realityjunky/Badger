import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, promises as fs } from "node:fs";
import path from "node:path";
import type { SkillSourceFile } from "../types.js";

/**
 * A Skill's identity is the set of files that make it behave the same on every
 * host. Operating-system metadata, editor state, and interpreter caches are
 * environment noise: adding or removing one must not change the hash.
 *
 * This list is fixed and documented in the workflow manual and ADR 0008.
 * Extend it only for a file class that is environment noise on every host,
 * never for content.
 */
export const SKILL_IDENTITY_IGNORE = [
  // Operating-system metadata
  ".DS_Store",
  "._*",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  ".TemporaryItems",
  "Thumbs.db",
  "desktop.ini",
  // Editor state
  ".idea",
  ".vscode",
  ".settings",
  ".project",
  ".classpath",
  "*.swp",
  "*.swo",
  "*~",
  ".#*",
  // Interpreter and test caches
  "__pycache__",
  "*.pyc",
  "*.pyo",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
] as const;

function matchesPattern(name: string, pattern: string): boolean {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return name === pattern;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  return (
    name.length >= prefix.length + suffix.length &&
    name.startsWith(prefix) &&
    name.endsWith(suffix)
  );
}

export function isIgnoredSkillEntry(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const name = segments[segments.length - 1] ?? "";
  return SKILL_IDENTITY_IGNORE.some((pattern) =>
    pattern.includes("*")
      ? matchesPattern(name, pattern)
      : segments.includes(pattern),
  );
}

/** The files that contribute to a Skill's identity, in path order. */
export function identitySkillFiles(
  files: readonly SkillSourceFile[],
): SkillSourceFile[] {
  return files
    .filter((file) => !isIgnoredSkillEntry(file.path))
    .sort((left, right) => compareText(left.path, right.path));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fileEntry(relativePath: string, content: Buffer): SkillSourceFile {
  return {
    path: relativePath,
    bytes: content.byteLength,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

function unsupportedSymbolicLink(relativePath: string): Error {
  return new Error(
    `Skill package contains unsupported symbolic link: ${relativePath}`,
  );
}

/**
 * Every file in the Skill tree, in path order, environment noise included.
 * Callers that need identity use {@link identitySkillFiles}.
 */
export async function inventorySkill(root: string): Promise<SkillSourceFile[]> {
  const files: SkillSourceFile[] = [];

  async function walk(directory: string, relative: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) throw unsupportedSymbolicLink(relativePath);
      if (stats.isDirectory()) await walk(target, relativePath);
      else if (stats.isFile())
        files.push(fileEntry(relativePath, await fs.readFile(target)));
      else
        throw new Error(
          `Skill package contains unsupported special file: ${relativePath}`,
        );
    }
  }

  await walk(path.resolve(root), "");
  return files.sort((left, right) => compareText(left.path, right.path));
}

export function hashSkillIdentity(files: readonly SkillSourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of identitySkillFiles(files)) {
    hash.update("file");
    hash.update("\0");
    hash.update(String(Buffer.byteLength(file.path)));
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.bytes));
    hash.update("\0");
    hash.update(file.hash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function hashSkillSource(root: string): Promise<string> {
  return hashSkillIdentity(await inventorySkill(root));
}

export function hashSkillSourceSync(root: string): string {
  const files: SkillSourceFile[] = [];

  function walk(directory: string, relative: string): void {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      const stats = lstatSync(target);
      if (stats.isSymbolicLink()) throw unsupportedSymbolicLink(relativePath);
      if (stats.isDirectory()) walk(target, relativePath);
      else if (stats.isFile())
        files.push(fileEntry(relativePath, readFileSync(target)));
      else
        throw new Error(
          `Skill package contains unsupported special file: ${relativePath}`,
        );
    }
  }

  walk(path.resolve(root), "");
  return hashSkillIdentity(files);
}
