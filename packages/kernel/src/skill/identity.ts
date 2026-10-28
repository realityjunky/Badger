import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  promises as fs,
} from "node:fs";
import path from "node:path";
import type { SkillSourceFile } from "../types.js";

/**
 * A Skill's identity is the set of files that make it behave the same on every
 * host. Operating-system metadata, editor state, and interpreter caches are
 * environment noise: adding or removing one must not change the hash.
 *
 * This list is fixed and documented in the workflow manual. Extend it only for
 * a file class that is environment noise on every host, never for content.
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function inventorySkill(root: string): Promise<SkillSourceFile[]> {
  const files: SkillSourceFile[] = [];

  async function walk(directory: string, relative: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (isIgnoredSkillEntry(relativePath)) continue;
      const target = path.join(directory, entry.name);
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) {
        const link = await fs.readlink(target);
        const content = Buffer.from(link);
        files.push({
          path: relativePath,
          bytes: content.byteLength,
          hash: createHash("sha256").update(content).digest("hex"),
        });
      } else if (stats.isDirectory()) {
        await walk(target, relativePath);
      } else if (stats.isFile()) {
        const content = await fs.readFile(target);
        files.push({
          path: relativePath,
          bytes: content.byteLength,
          hash: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        throw new Error(
          `Skill package contains unsupported special file: ${relativePath}`,
        );
      }
    }
  }

  await walk(path.resolve(root), "");
  return files.sort((left, right) => compareText(left.path, right.path));
}

export function hashSkillInventory(files: readonly SkillSourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
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
  return hashSkillInventory(await inventorySkill(root));
}

export function hashSkillSourceSync(root: string): string {
  const files: SkillSourceFile[] = [];

  function walk(directory: string, relative: string): void {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (isIgnoredSkillEntry(relativePath)) continue;
      const target = path.join(directory, entry.name);
      const stats = lstatSync(target);
      if (stats.isSymbolicLink()) {
        const content = Buffer.from(readlinkSync(target));
        files.push({
          path: relativePath,
          bytes: content.byteLength,
          hash: createHash("sha256").update(content).digest("hex"),
        });
      } else if (stats.isDirectory()) {
        walk(target, relativePath);
      } else if (stats.isFile()) {
        const content = readFileSync(target);
        files.push({
          path: relativePath,
          bytes: content.byteLength,
          hash: createHash("sha256").update(content).digest("hex"),
        });
      } else {
        throw new Error(
          `Skill package contains unsupported special file: ${relativePath}`,
        );
      }
    }
  }

  walk(path.resolve(root), "");
  files.sort((left, right) => compareText(left.path, right.path));
  return hashSkillInventory(files);
}
