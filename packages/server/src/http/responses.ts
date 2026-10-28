import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * #24's five error cases, plus `unauthenticated` for a request nobody is
 * signed in to. A failure the service cannot attribute to the request is
 * reported as `unavailable`, so the caller may retry.
 */
export type ErrorCode =
  | "invalid"
  | "denied"
  | "rejected"
  | "conflict"
  | "unavailable"
  | "unauthenticated";

export interface ResponseBody {
  status: number;
  contentType: string;
  body: string | Uint8Array;
  headers?: Record<string, string>;
}

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

/** One request's way to answer, carrying its request ID on every response. */
export interface Reply {
  readonly requestId: string;
  send(body: ResponseBody): void;
  json(status: number, payload: unknown): void;
  html(status: number, body: string): void;
  error(
    status: number,
    code: ErrorCode,
    message: string,
    headers?: Record<string, string>,
  ): void;
}

export function replyTo(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Reply {
  const send = (body: ResponseBody): void => {
    response.writeHead(body.status, {
      ...BASE_HEADERS,
      ...body.headers,
      "content-type": body.contentType,
      "x-request-id": requestId,
    });
    response.end(request.method === "HEAD" ? undefined : body.body);
  };
  const json = (status: number, payload: unknown): void => {
    send({
      status,
      contentType: "application/json; charset=utf-8",
      body: `${JSON.stringify(payload)}\n`,
    });
  };
  return {
    requestId,
    send,
    json,
    html: (status, body) => {
      send({ status, contentType: "text/html; charset=utf-8", body });
    },
    error: (status, code, message, headers) => {
      send({
        status,
        contentType: "application/json; charset=utf-8",
        body: `${JSON.stringify({ error: { code, message }, requestId })}\n`,
        headers,
      });
    },
  };
}
