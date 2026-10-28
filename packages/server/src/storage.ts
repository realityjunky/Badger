import { promises as fs } from "node:fs";
import type { StorageConfiguration } from "./config.js";

/** Creates the storage root and its blob, workspace, and Run directories. */
export async function prepareStorage(
  storage: StorageConfiguration,
): Promise<void> {
  for (const directory of [
    storage.root,
    storage.blobDirectory,
    storage.workspaceDirectory,
    storage.runDirectory,
  ]) {
    await fs.mkdir(directory, { recursive: true });
  }
}
