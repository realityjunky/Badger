import path from "node:path";

export function normalizeWorkflowRelativePath(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim().replaceAll("\\", "/");
  if (
    trimmed.length === 0 ||
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    /^(?:~|[\\/])/u.test(trimmed)
  ) {
    throw new Error(`${label} must be relative to its declared path base`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside its declared path base`);
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    throw new Error(`${label} must not contain empty or dot path segments`);
  }
  if (/[*?]/u.test(trimmed)) {
    throw new Error(`${label} cannot contain wildcards`);
  }
  return segments.join("/");
}
