import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hashDirectory as canonicalHashDirectory } from "./workflow-kernel/hash.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

// canonicalize repeats stableValue's walk with a code-unit comparator instead
// of sharing it: stableValue is bundled into the WorkflowRuntime asset that
// every generated scaffold copies, so touching it would change scaffold
// hashes that in-progress authoring sessions recorded.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/**
 * The canonical JSON behind plan and proposal identities. Keys sort by
 * UTF-16 code unit, so the result does not depend on locale or ICU;
 * JavaScript still writes integer-like keys first, in numeric order, which is
 * just as deterministic. stableValue keeps its locale-aware order because
 * dossier, protocol, and WorkflowRuntime identities already depend on it, and
 * the runtime's private `canonicalHash` helpers in `checkpoints.ts` and
 * `snapshots.ts` are stableValue-based: never swap one form for the other.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function packageRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith("../") ? normalized.slice(3) : normalized;
}

export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function atomicWrite(
  file: string,
  content: string,
): Promise<void> {
  await ensureDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, file).catch(async (error) => {
    await fs.rm(temporary, { force: true });
    throw error;
  });
}

/**
 * Writes a new file whole, or fails with EEXIST when the file already exists,
 * so two writers cannot both create it.
 */
export async function atomicCreate(
  file: string,
  content: string,
): Promise<void> {
  await ensureDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await fs.link(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

export async function replaceDirectory(
  source: string,
  destination: string,
): Promise<void> {
  const target = path.resolve(destination);
  const parent = path.dirname(target);
  await ensureDirectory(parent);
  let backup: string | undefined;
  try {
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(
        `Directory replacement target is not a regular directory: ${destination}`,
      );
    backup = path.join(
      parent,
      `.${path.basename(target)}.${process.pid}.${randomUUID()}.bak`,
    );
    await fs.rename(target, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (backup) await fs.rename(backup, target).catch(() => undefined);
    throw error;
  }
  if (backup) await fs.rm(backup, { recursive: true, force: true });
}

export async function listFiles(
  root: string,
  relative = "",
): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const result: string[] = [];
  for (const entry of entries) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) result.push(...(await listFiles(root, next)));
    else if (entry.isFile()) result.push(next.split(path.sep).join("/"));
    else
      throw new Error(
        `Symbolic links and special files are not supported: ${next}`,
      );
  }
  return result;
}

export async function hashDirectory(root: string): Promise<string> {
  return canonicalHashDirectory(root);
}

export async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}
