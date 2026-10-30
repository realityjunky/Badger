import { crc32 } from "node:zlib";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";
import type { ServiceConfig } from "../config.js";
import { RequestError } from "../http/errors.js";
import { normalizeSkillPath, type UploadFile } from "./paths.js";

/** General-purpose flag bit 11: the entry's name and comment are UTF-8. */
const UTF8_NAME_FLAG = 0x800;
/** The Info-ZIP Unicode Path extra field, holding a UTF-8 copy of the name. */
const UNICODE_PATH_FIELD = 0x7075;
/** The folder macOS Archive Utility adds for resource forks and metadata. */
const MACOS_METADATA = Buffer.from("__MACOSX/");

/**
 * An entry's name exactly as its bytes spell it in UTF-8. A non-ASCII name
 * that is not marked as UTF-8 would have to be guessed from a legacy code
 * page, which would silently change the tree's identity.
 */
function entryName(entry: Entry): string {
  const raw = entry.fileNameRaw;
  let bytes: Buffer | undefined;
  if ((entry.generalPurposeBitFlag & UTF8_NAME_FLAG) !== 0) bytes = raw;
  else {
    // The field is version 1 and carries the CRC-32 of the name it replaces.
    const field = entry.extraFields.find(
      ({ id, data }) =>
        id === UNICODE_PATH_FIELD &&
        data.length >= 6 &&
        data[0] === 1 &&
        data.readUInt32LE(1) === crc32(raw),
    );
    if (field !== undefined) bytes = field.data.subarray(5);
    else if (raw.every((byte) => byte < 0x80)) bytes = raw;
  }
  if (bytes !== undefined) {
    const name = bytes.toString("utf8");
    // Invalid UTF-8 would decode to replacement characters, not these bytes.
    if (Buffer.from(name, "utf8").equals(bytes)) return name;
  }
  throw new RequestError(
    400,
    "Zip entry names must be UTF-8; re-create the zip with UTF-8 names, or upload the folder instead",
  );
}

export async function readZipUpload(
  content: Buffer,
  limits: ServiceConfig["uploads"],
): Promise<UploadFile[]> {
  if (content.length > limits.maxBytes)
    throw new RequestError(413, "Zip exceeds the upload byte limit");
  let archive: ZipFile | undefined;
  try {
    // Names are decoded and checked here, byte for byte, rather than by
    // yauzl, which would guess legacy encodings and rewrite backslashes.
    archive = await fromBufferPromise(content, {
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
    });
    if (archive.entryCount > limits.maxFiles)
      throw new RequestError(413, "Zip exceeds the entry count limit");
    const files: UploadFile[] = [];
    let totalBytes = 0;
    for await (const entry of archive.eachEntry()) {
      const name = entryName(entry);
      const relative = normalizeSkillPath(name);
      // macOS metadata is not part of the Skill; it is never expanded.
      if (
        entry.fileNameRaw
          .subarray(0, MACOS_METADATA.length)
          .equals(MACOS_METADATA)
      )
        continue;
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      const directory = name.endsWith("/");
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
