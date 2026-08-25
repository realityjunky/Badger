import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

interface HashEntry {
  relativePath: string;
  kind: "file" | "symlink";
  content: Buffer;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectHashEntries(
  directory: string,
  relative = "",
): Promise<HashEntry[]> {
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (left, right) => compareText(left.name, right.name),
  );
  const files: HashEntry[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const stats = await fs.lstat(target);
    if (stats.isDirectory()) {
      files.push(...(await collectHashEntries(target, relativePath)));
      continue;
    }
    if (stats.isFile()) {
      files.push({
        relativePath: portablePath(relativePath),
        kind: "file",
        content: await fs.readFile(target),
      });
    } else if (stats.isSymbolicLink()) {
      files.push({
        relativePath: portablePath(relativePath),
        kind: "symlink",
        content: Buffer.from(await fs.readlink(target)),
      });
    } else {
      throw new Error(`Unsupported special file: ${relativePath}`);
    }
  }
  return files;
}

export async function hashDirectory(root: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const stats = await fs.lstat(absoluteRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`Directory hash requires a regular directory: ${root}`);
  const files = await collectHashEntries(absoluteRoot);
  const hash = createHash("sha256");
  for (const file of files) {
    const normalizedPath = Buffer.from(file.relativePath);
    hash.update(file.kind);
    hash.update("\0");
    hash.update(String(normalizedPath.byteLength));
    hash.update("\0");
    hash.update(normalizedPath);
    hash.update("\0");
    hash.update(String(file.content.byteLength));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}
