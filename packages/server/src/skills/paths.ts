import { RequestError } from "../http/errors.js";

export interface UploadFile {
  path: string;
  content: Buffer;
}

export function normalizeUploadPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /^[\\/]/u.test(value) ||
    /[\u0000-\u001f\u007f:]/u.test(value)
  ) {
    throw new RequestError(400, "Upload paths must be relative file paths");
  }
  const segments = value
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === ".." ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  ) {
    throw new RequestError(
      400,
      "Upload paths may not escape the tree or use reserved names",
    );
  }
  const normalized = segments.join("/");
  if (Buffer.byteLength(normalized) > 1024) {
    throw new RequestError(400, "Upload paths are limited to 1024 bytes");
  }
  return normalized;
}
