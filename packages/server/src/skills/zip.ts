import { crc32 } from "node:zlib";
import { fromBufferPromise, type ZipFile } from "yauzl";
import type { ServiceConfig } from "../config.js";
import { RequestError } from "../http/errors.js";
import { normalizeUploadPath, type UploadFile } from "./paths.js";

export async function readZipUpload(
  content: Buffer,
  limits: ServiceConfig["uploads"],
): Promise<UploadFile[]> {
  if (content.length > limits.maxBytes)
    throw new RequestError(413, "Zip exceeds the upload byte limit");
  let archive: ZipFile | undefined;
  try {
    archive = await fromBufferPromise(content, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: false,
    });
    if (archive.entryCount > limits.maxFiles)
      throw new RequestError(413, "Zip exceeds the entry count limit");
    const files: UploadFile[] = [];
    let totalBytes = 0;
    for await (const entry of archive.eachEntry()) {
      const relative = normalizeUploadPath(entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      const directory = entry.fileName.endsWith("/");
      if (
        entry.isEncrypted() ||
        (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) ||
        (mode === 0x4000 && !directory) ||
        (mode === 0x8000 && directory)
      ) {
        throw new RequestError(
          400,
          "Encrypted files, links, and special files are refused",
        );
      }
      if (directory) continue;
      if (
        entry.uncompressedSize > limits.maxFileBytes ||
        totalBytes + entry.uncompressedSize > limits.maxBytes
      ) {
        throw new RequestError(
          413,
          "Zip exceeds the expanded file or total byte limit",
        );
      }
      const stream = await archive.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.from(chunk as Uint8Array);
        fileBytes += buffer.length;
        totalBytes += buffer.length;
        if (fileBytes > limits.maxFileBytes || totalBytes > limits.maxBytes) {
          stream.destroy();
          throw new RequestError(
            413,
            "Zip exceeds the expanded file or total byte limit",
          );
        }
        chunks.push(buffer);
      }
      const buffer = Buffer.concat(chunks);
      if (crc32(buffer) !== entry.crc32)
        throw new RequestError(400, "Zip file checksum does not match");
      files.push({ path: relative, content: buffer });
    }
    return files;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "The archive is not a supported, intact zip");
  } finally {
    archive?.close();
  }
}
