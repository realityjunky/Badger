import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  promises as fs,
} from "node:fs";
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

function collectHashEntriesSync(directory: string, relative = ""): HashEntry[] {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => compareText(left.name, right.name),
  );
  const files: HashEntry[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    const stats = lstatSync(target);
    if (stats.isDirectory()) {
      files.push(...collectHashEntriesSync(target, relativePath));
      continue;
    }
    if (stats.isFile()) {
      files.push({
        relativePath: portablePath(relativePath),
        kind: "file",
        content: readFileSync(target),
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      files.push({
        relativePath: portablePath(relativePath),
        kind: "symlink",
        content: Buffer.from(readlinkSync(target)),
      });
      continue;
    }
    throw new Error(`Unsupported special file: ${relativePath}`);
  }
  return files;
}

function digestHashEntries(files: readonly HashEntry[]): string {
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

/** The same canonical directory digest for portable regular package files. */
export function hashPackageFiles(
  files: readonly { path: string; content: Uint8Array }[],
): string {
  const seen = new Set<string>();
  const spellings = new Map<string, string>();
  const entries = files.map((file) => {
    if (
      !file.path ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      file.path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[. ]$/u.test(part) ||
            /[<>:"|?*\u0000-\u001f\u007f]/u.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(
              part,
            ),
        ) ||
      path.posix.isAbsolute(file.path) ||
      /^[A-Za-z]:/u.test(file.path) ||
      seen.has(file.path)
    )
      throw new Error(`Package file path is unsafe or repeated: ${file.path}`);
    const parts = file.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = prefix
        .normalize("NFC")
        .toUpperCase()
        .toLowerCase()
        .normalize("NFC");
      const previous = spellings.get(key);
      if (previous !== undefined && previous !== prefix)
        throw new Error(`Package file path aliases ${previous}: ${file.path}`);
      spellings.set(key, prefix);
    }
    seen.add(file.path);
    return {
      relativePath: file.path,
      kind: "file" as const,
      content: Buffer.from(file.content),
    };
  });
  for (const file of seen) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join("/")))
        throw new Error(`Package file paths conflict: ${file}`);
  }
  entries.sort((left, right) => {
    const a = left.relativePath.split("/"),
      b = right.relativePath.split("/");
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = compareText(a[i], b[i]);
      if (order) return order;
    }
    return a.length - b.length;
  });
  return digestHashEntries(entries);
}

export async function hashDirectory(root: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const stats = await fs.lstat(absoluteRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`Directory hash requires a regular directory: ${root}`);
  const files = await collectHashEntries(absoluteRoot);
  return digestHashEntries(files);
}

export function hashDirectorySync(root: string): string {
  const absoluteRoot = path.resolve(root);
  const stats = lstatSync(absoluteRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error(`Directory hash requires regular directory: ${root}`);
  return digestHashEntries(collectHashEntriesSync(absoluteRoot));
}
