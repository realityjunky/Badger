import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface BlobStore {
  put(content: Buffer): Promise<string>;
  get(hash: string): Promise<Buffer>;
}

export function filesystemBlobStore(directory: string): BlobStore {
  function location(hash: string) {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new Error("Invalid blob hash");
    }
    return path.join(directory, hash.slice(0, 2), hash.slice(2));
  }

  return {
    async put(content) {
      const hash = createHash("sha256").update(content).digest("hex");
      const destination = location(hash);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 });
        await fs.link(temporary, destination).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return hash;
    },
    async get(hash) {
      const content = await fs.readFile(location(hash));
      if (createHash("sha256").update(content).digest("hex") !== hash) {
        throw new Error("Blob integrity check failed");
      }
      return content;
    },
  };
}
