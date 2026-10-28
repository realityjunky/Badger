import { RequestError } from "../http/errors.js";

export interface UploadFile {
  path: string;
  content: Buffer;
}

/** A path's byte limit, and each segment's: the common file-name maximum. */
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;

const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * Checks one upload path and returns it with `.` segments and repeated
 * separators removed. Names stay byte-exact: no Unicode normalization and no
 * separator translation, so a version hashes exactly as the kernel hashes the
 * original tree.
 */
export function normalizeUploadPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    // Control characters, drive and stream separators, and lone surrogates,
    // which no file system name can hold byte for byte.
    /[\u0000-\u001f\u007f:]|\p{Cs}/u.test(value)
  ) {
    throw new RequestError(400, "Upload paths must be relative file paths");
  }
  if (value.includes("\\")) {
    throw new RequestError(
      400,
      "Upload paths separate folders with forward slashes; backslashes are refused",
    );
  }
  const segments = value
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === ".." ||
        /[. ]$/u.test(segment) ||
        RESERVED_NAME.test(segment),
    )
  ) {
    throw new RequestError(
      400,
      "Upload paths may not escape the tree or use reserved names",
    );
  }
  if (
    segments.some((segment) => Buffer.byteLength(segment) > MAX_SEGMENT_BYTES)
  ) {
    throw new RequestError(
      400,
      `Each upload path segment is limited to ${MAX_SEGMENT_BYTES} bytes`,
    );
  }
  const normalized = segments.join("/");
  if (Buffer.byteLength(normalized) > MAX_PATH_BYTES) {
    throw new RequestError(
      400,
      `Upload paths are limited to ${MAX_PATH_BYTES} bytes`,
    );
  }
  return normalized;
}

/**
 * The key two paths share when a normalization- or case-insensitive file
 * system would store them as one: NFC, then case folding (upper then lower
 * case, which also folds `ß` with `ss` and final sigma with sigma).
 */
export function collisionKey(relative: string): string {
  return relative.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}
