import type { IncomingMessage, ServerResponse } from "node:http";

export interface ResponseBody {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

export function sendResponse(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  body: ResponseBody,
): void {
  response.writeHead(body.status, {
    ...BASE_HEADERS,
    ...body.headers,
    "content-type": body.contentType,
    "x-request-id": requestId,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(body.body);
}

export function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  status: number,
  payload: unknown,
): void {
  sendResponse(request, response, requestId, {
    status,
    contentType: "application/json; charset=utf-8",
    body: `${JSON.stringify(payload)}\n`,
  });
}

export function sendError(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(request, response, requestId, status, {
    error: { code, message },
    requestId,
  });
}

export function sendHtml(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  status: number,
  body: string,
): void {
  sendResponse(request, response, requestId, {
    status,
    contentType: "text/html; charset=utf-8",
    body,
  });
}
