import { openPromise } from "yauzl";

export async function readSkillArchive(file: string) {
  const zip = await openPromise(file, { autoClose: false });
  const files = new Map<string, Buffer>();
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks: Buffer[] = [];
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk));
      files.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    zip.close();
  }
  return files;
}
