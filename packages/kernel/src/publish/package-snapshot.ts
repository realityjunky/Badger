import { promises as fs } from "node:fs";
import path from "node:path";
import type { GeneratedPackageFile } from "../types.js";
import { sha256 } from "../util.js";
import { hashDirectory, hashPackageFiles } from "../workflow-kernel/hash.js";

export interface PackageSnapshot {
  packageHash: string;
  inventory: GeneratedPackageFile[];
  /** Binary-safe, portable bytes. No absolute paths or mutable file pointers. */
  files: { path: string; content: string }[];
}

/** Verify inventory and exact bytes with the kernel's directory hash algorithm. */
export function verifyPackageSnapshot(
  snapshot: PackageSnapshot,
): PackageSnapshot {
  if (
    !snapshot ||
    !Array.isArray(snapshot.files) ||
    !Array.isArray(snapshot.inventory) ||
    !/^[a-f0-9]{64}$/u.test(snapshot.packageHash)
  )
    throw new Error("Package snapshot is invalid");
  const files = snapshot.files.map((file) => {
    if (typeof file.path !== "string" || typeof file.content !== "string")
      throw new Error("Package file is invalid");
    const content = Buffer.from(file.content, "base64");
    if (content.toString("base64") !== file.content)
      throw new Error("Package file encoding is invalid");
    return { path: file.path, content };
  });
  const actualHash = hashPackageFiles(files);
  const inventory = new Map(
    snapshot.inventory.map((file) => [file.path, file]),
  );
  if (
    inventory.size !== snapshot.inventory.length ||
    files.length !== inventory.size
  )
    throw new Error("Package inventory does not match its files");
  for (const file of files) {
    const entry = inventory.get(file.path);
    if (
      !entry ||
      entry.bytes !== file.content.length ||
      entry.sha256 !== sha256(file.content) ||
      !["auto", "authored", "source"].includes(entry.owner)
    )
      throw new Error("Package inventory does not match its file bytes");
  }
  if (actualHash !== snapshot.packageHash)
    throw new Error("Package snapshot hash does not match its bytes");
  return snapshot;
}

export async function createPackageSnapshot(
  root: string,
  inventory: readonly GeneratedPackageFile[],
): Promise<PackageSnapshot> {
  const packageHash = await hashDirectory(root);
  // Validate inventory paths before using them to access the filesystem.
  hashPackageFiles(
    inventory.map((file) => ({ path: file.path, content: new Uint8Array() })),
  );
  const files = [];
  for (const entry of inventory) {
    let target = root;
    for (const part of entry.path.split("/")) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink())
        throw new Error(
          "Package snapshot paths must not contain symbolic links",
        );
    }
    if (!(await fs.lstat(target)).isFile())
      throw new Error("Package snapshot requires regular files");
    files.push({
      path: entry.path,
      content: (await fs.readFile(target)).toString("base64"),
    });
  }
  const snapshot = verifyPackageSnapshot({
    packageHash,
    inventory: structuredClone([...inventory]),
    files,
  });
  if ((await hashDirectory(root)) !== packageHash)
    throw new Error("Package changed while taking its snapshot");
  return snapshot;
}
