import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

export interface BlobStore {
  put(content: Buffer): Promise<string>;
  get(hash: string): Promise<Buffer>;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Makes a directory's entries durable, so a name linked into it survives a crash. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function filesystemBlobStore(directory: string): BlobStore {
  function location(hash: string) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error("Invalid blob hash");
    }
    return path.join(directory, hash.slice(0, 2), hash.slice(2));
  }

  return {
    /**
     * Stores content under its SHA-256. The bytes are written and synced to a
     * private temporary file before they gain the address, and the address
     * is synced into its directory, so a version committed after `put` never
     * names a blob a crash could leave empty or torn.
     */
    async put(content) {
      const hash = sha256(content);
      const destination = location(hash);
      const shard = path.dirname(destination);
      if ((await fs.mkdir(shard, { recursive: true })) !== undefined)
        await syncDirectory(path.dirname(shard));
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.link(temporary, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // A file already at the address may be a torn write from before a
          // crash. Keep it only if its bytes still match the address;
          // otherwise replace it atomically with the synced copy.
          if ((await fileSha256(destination)) !== hash)
            await fs.rename(temporary, destination);
        }
        await syncDirectory(shard);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return hash;
    },
    async get(hash) {
      const content = await fs.readFile(location(hash));
      if (sha256(content) !== hash) {
        throw new Error("Blob integrity check failed");
      }
      return content;
    },
  };
}
