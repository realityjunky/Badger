import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { hashDirectory as canonicalHashDirectory } from "./workflow-kernel/hash.js";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
    `.${path.basename(file)}.${process.pid}.tmp`,
  );
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, file).catch(async (error) => {
    await fs.rm(temporary, { force: true });
    throw error;
  });
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
