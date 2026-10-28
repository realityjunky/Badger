import { promises as fs } from "node:fs";
import path from "node:path";
import { escapeHtml } from "./page.js";

/**
 * The dashboard is a single-page app, so its documents may load scripts and
 * styles from the deployment itself. Ant Design inserts style elements at
 * run time, hence inline styles. No inline script is allowed.
 */
export const WEB_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const TEXTUAL =
  /^(?:text\/|application\/(?:json|manifest\+json)$|image\/svg\+xml$)/u;
const IMMUTABLE_PREFIX = "/assets/";

export interface WebAsset {
  body: Uint8Array;
  contentType: string;
  cacheControl: string;
}

/**
 * A URL that asks for a built file: anything under the asset folder, or a
 * last segment ending in a file type the build serves. Everything else is a
 * dashboard page, including a record whose ID has a dot in it.
 */
export function isFileRequest(pathname: string): boolean {
  return (
    pathname.startsWith(IMMUTABLE_PREFIX) ||
    Object.hasOwn(CONTENT_TYPES, path.posix.extname(pathname).toLowerCase())
  );
}

/**
 * Reads one file from the dashboard build. A request that tries to leave the
 * build, or names something that is not a file there, gets nothing.
 */
export async function readWebAsset(
  webDirectory: string,
  requestPath: string,
): Promise<WebAsset | null> {
  let relative: string;
  try {
    relative = decodeURIComponent(requestPath).replace(/^\/+/u, "");
  } catch {
    return null;
  }
  if (relative.includes("\0")) {
    return null;
  }

  const root = path.resolve(webDirectory);
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  let stats;
  try {
    stats = await fs.stat(candidate);
  } catch {
    return null;
  }
  if (!stats.isFile()) {
    return null;
  }

  const type = CONTENT_TYPES[path.extname(candidate).toLowerCase()];
  if (type === undefined) {
    return null;
  }
  return {
    body: await fs.readFile(candidate),
    contentType: TEXTUAL.test(type) ? `${type}; charset=utf-8` : type,
    cacheControl: requestPath.startsWith(IMMUTABLE_PREFIX)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
}

/**
 * Reads the dashboard's index document and points its relative asset URLs at
 * the deployment's base path, so a deep link loads the same app.
 */
export async function readWebDocument(
  webDirectory: string,
  basePath: string,
): Promise<string | null> {
  let html: string;
  try {
    html = await fs.readFile(path.join(webDirectory, "index.html"), "utf8");
  } catch {
    return null;
  }
  return injectBasePath(html, basePath);
}

const BASE_TAG = /<base href="[^"]*">/u;
const BASE_META = /(<meta name="badger-base-path" content=")[^"]*(">)/u;

/** Points the document's relative URLs and app router at `basePath`. */
export function injectBasePath(html: string, basePath: string): string {
  const baseHref = basePath === "/" ? "/" : `${basePath}/`;
  let document = html.replace(
    BASE_TAG,
    `<base href="${escapeHtml(baseHref)}">`,
  );
  if (!BASE_TAG.test(html)) {
    document = document.replace(
      "</head>",
      `<base href="${escapeHtml(baseHref)}">\n</head>`,
    );
  }
  return document.replace(BASE_META, `$1${escapeHtml(basePath)}$2`);
}
