import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostPlan } from "./index.js";

/** Preview files contain published bytes and local paths, never a token. */
export async function saveHostPlan(plan: HostPlan): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "badger-host-preview-"),
  );
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "plan.json");
  try {
    await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await fs.rmdir(directory);
    throw error;
  }
  return file;
}
export async function readHostPlan(file: string): Promise<HostPlan> {
  const stat = await fs.lstat(file);
  const directory = await fs.lstat(path.dirname(file));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    stat.size > 64 * 1024 * 1024 ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 ||
        (directory.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()))
  )
    throw new Error("Use a private Badger host preview file");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error("Preview file changed while reading");
    const plan = JSON.parse(await handle.readFile("utf8")) as HostPlan;
    if (plan?.format !== "badger-host-plan-v1")
      throw new Error("Invalid host preview file");
    return plan;
  } catch {
    throw new Error("Cannot read this Badger host preview file");
  } finally {
    await handle.close();
  }
}
export async function removeHostPlan(file: string): Promise<void> {
  await fs.unlink(file).catch(() => undefined);
  if (
    path.basename(file) === "plan.json" &&
    path.basename(path.dirname(file)).startsWith("badger-host-preview-")
  )
    await fs.rmdir(path.dirname(file)).catch(() => undefined);
}
