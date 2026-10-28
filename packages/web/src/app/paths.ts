/**
 * The deployment's base path: what the server injects into the document and
 * what the router uses as its basename.
 */
export function normalizeBasePath(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "/";
  }
  let normalized = value.trim();
  if (normalized === "") {
    return "/";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/+$/u, "");
  return normalized === "" ? "/" : normalized;
}

/** An API address under the base path, for the dashboard's own prefix. */
export function apiUrl(basePath: string, path: string): string {
  const base = normalizeBasePath(basePath);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base === "/" ? "" : base}/api/v1${suffix}`;
}

/** A dashboard URL under the base path, for links the app builds itself. */
export function pageUrl(basePath: string, path: string): string {
  const base = normalizeBasePath(basePath);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base === "/" ? "" : base}${suffix}`;
}

/** Reads the base path the server injected into the document. */
export function readBasePath(document: Document): string {
  const meta = document.querySelector('meta[name="badger-base-path"]');
  return normalizeBasePath(meta?.getAttribute("content"));
}
