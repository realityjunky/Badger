import type { IncomingMessage } from "node:http";
import { firstHeader } from "../identity/identity.js";

export const MAX_JSON_BODY_BYTES = 16 * 1024;

export type JsonBodyResult =
  { ok: true; value: unknown } | { ok: false; message: string };

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/iu;

/**
 * Reads a small JSON request body. The service refuses anything that is not
 * declared JSON or exceeds the limit, so no handler sees a truncated body.
 */
export async function readJsonBody(
  request: IncomingMessage,
  limit = MAX_JSON_BODY_BYTES,
): Promise<JsonBodyResult> {
  const contentType = firstHeader(request.headers, "content-type") ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    return { ok: false, message: "Content-Type must be application/json" };
  }

  const declared = firstHeader(request.headers, "content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      return { ok: false, message: "Content-Length is not valid" };
    }
    if (length > limit) {
      return {
        ok: false,
        message: `The request body is limited to ${limit} bytes`,
      };
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) {
      return {
        ok: false,
        message: `The request body is limited to ${limit} bytes`,
      };
    }
    chunks.push(buffer);
  }

  try {
    return {
      ok: true,
      value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
  } catch {
    return { ok: false, message: "The request body is not valid JSON" };
  }
}
