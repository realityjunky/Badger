import type { ServiceConfig } from "../config.js";
import { demoResponse } from "../demo/fixtures.js";
import type { Reply } from "./responses.js";
import {
  isFileRequest,
  readWebAsset,
  readWebDocument,
  WEB_CONTENT_SECURITY_POLICY,
} from "./web.js";

/** A separate namespace that never authenticates or accesses service records. */
export async function handleDemo(
  config: ServiceConfig,
  reply: Reply,
  path: string,
  method: string,
  url: URL,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    return reply.error(405, "denied", "Demo mode is read-only", {
      allow: "GET, HEAD",
    });
  }
  const relative = path.slice("/demo".length) || "/";
  if (relative.startsWith("/api/v1/")) {
    const fixture = demoResponse(
      relative.slice("/api/v1".length),
      url.searchParams,
    );
    if (fixture !== undefined) return reply.json(200, fixture);
  }
  if (
    relative === "/api" ||
    relative.startsWith("/api/") ||
    relative.startsWith("/auth/")
  ) {
    return reply.error(404, "invalid", "No such demo resource");
  }
  if (isFileRequest(relative)) {
    const asset = await readWebAsset(config.webDirectory, relative);
    if (asset === null) return reply.error(404, "invalid", "Not found");
    // HTML entry aliases must receive the same demo metadata as page URLs.
    // Check the resolved type so encoded filenames cannot bypass injection.
    if (!asset.contentType.startsWith("text/html")) {
      return reply.send({
        status: 200,
        contentType: asset.contentType,
        body: asset.body,
        headers: { "cache-control": asset.cacheControl },
      });
    }
  }
  const basePath = `${config.basePath === "/" ? "" : config.basePath}/demo`;
  const document = await readWebDocument(config.webDirectory, basePath);
  if (document === null)
    return reply.error(404, "invalid", "Build the dashboard to open the demo");
  reply.send({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: document.replace(
      "</head>",
      '<meta name="badger-demo" content="true">\n</head>',
    ),
    headers: { "content-security-policy": WEB_CONTENT_SECURITY_POLICY },
  });
}
