import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createPackageSnapshot,
  verifyPackageSnapshot,
  hashDirectory,
} from "../src/index.js";
let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it("creates a portable exact package snapshot, verifies bytes and inventory, and rejects corruption", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "badger-publication-"));
  await fs.mkdir(path.join(root, "a"));
  await fs.writeFile(path.join(root, "a", "inside.txt"), "abc");
  await fs.writeFile(path.join(root, "a.txt"), "abc");
  const inventory = ["a/inside.txt", "a.txt"].map((file) => ({
    path: file,
    bytes: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    owner: "auto" as const,
  }));
  const snapshot = await createPackageSnapshot(root, inventory);
  expect(snapshot.packageHash).toBe(await hashDirectory(root));
  expect(snapshot.files).toEqual(
    inventory.map((f) => ({ path: f.path, content: "YWJj" })),
  );
  expect(verifyPackageSnapshot(snapshot)).toEqual(snapshot);
  const corrupt = structuredClone(snapshot);
  corrupt.files[0].content = "dGFtcGVyZWQ=";
  expect(() => verifyPackageSnapshot(corrupt)).toThrow(/hash|inventory/iu);
  const missing = structuredClone(snapshot);
  missing.files.pop();
  expect(() => verifyPackageSnapshot(missing)).toThrow(/inventory/iu);
  const unsafe = structuredClone(snapshot);
  unsafe.files[0].path = "../outside";
  expect(() => verifyPackageSnapshot(unsafe)).toThrow(/path/iu);
  await fs.writeFile(path.join(root, "extra.txt"), "abc");
  await expect(createPackageSnapshot(root, inventory)).rejects.toThrow(
    /hash/iu,
  );
});
