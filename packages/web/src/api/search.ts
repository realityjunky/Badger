import { read } from "./workflows.js";

export interface SearchResult {
  kind: "workflow" | "question" | "skill";
  id: string;
  label: string;
  context: string;
  href: string;
}

export function searchRecords(
  basePath: string,
  query: string,
  scope: { group?: string; workflow?: string; version?: string },
  signal?: AbortSignal,
) {
  const parameters = new URLSearchParams({ q: query });
  for (const key of ["group", "workflow", "version"] as const) {
    const value = scope[key];
    if (value) parameters.set(key, value);
  }
  return read<{ results: SearchResult[] }>(
    basePath,
    `/search?${parameters}`,
    signal,
  );
}
