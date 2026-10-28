import { promises as fs } from "node:fs";
import path from "node:path";
import { isWithin } from "../util.js";

export interface SourceScope {
  project: string;
  lexical: string[];
  physical: string[];
}

/**
 * The project root plus every registered source root, in both the spelling the
 * caller gave and the real path it resolves to.
 */
export async function sourceScope(
  projectRoot: string,
  roots: readonly string[],
): Promise<SourceScope> {
  const lexical = [
    path.resolve(projectRoot),
    ...roots.map((root) => path.resolve(projectRoot, root)),
  ];
  const physical: string[] = [];
  for (const root of lexical)
    physical.push(await fs.realpath(root).catch(() => root));
  return { project: physical[0]!, lexical, physical };
}

export function withinAny(
  roots: readonly string[],
  candidate: string,
): boolean {
  return roots.some((root) => isWithin(root, candidate));
}

export function withinSourceScope(
  scope: SourceScope,
  candidate: string,
): boolean {
  return (
    withinAny(scope.lexical, candidate) || withinAny(scope.physical, candidate)
  );
}

export function withinPhysicalSourceScope(
  scope: SourceScope,
  candidate: string,
): boolean {
  return withinAny(scope.physical, candidate);
}
