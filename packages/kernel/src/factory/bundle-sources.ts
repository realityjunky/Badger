import { promises as fs } from "node:fs";
import path from "node:path";
import type { SkillCandidate } from "../types.js";
import { isWithin } from "../util.js";
import {
  hashSkillIdentity,
  hashSkillSource,
  identitySkillFiles,
  inventorySkill,
} from "../skill/identity.js";

export function bundledSourceRoot(hash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(hash))
    throw new Error("Bundled source requires a valid Skill identity hash");
  return `sources/${hash}`;
}

export async function bundleSourceSkills(
  packageRoot: string,
  candidates: readonly SkillCandidate[],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const candidate of candidates) {
    for (const source of candidate.sources) {
      const relativeRoot = bundledSourceRoot(source.hash);
      const files = identitySkillFiles(await inventorySkill(source.root));
      if (hashSkillIdentity(files) !== source.hash)
        throw new Error(`Skill source changed before bundling: ${source.name}`);
      for (const file of files) {
        const relativePath = `${relativeRoot}/${file.path}`;
        if (paths.has(relativePath)) continue;
        const destination = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(source.root, file.path), destination);
        paths.add(relativePath);
      }
      if (
        (await hashSkillSource(path.join(packageRoot, relativeRoot))) !==
        source.hash
      )
        throw new Error(`Skill source changed while bundling: ${source.name}`);
    }
  }
  return [...paths].sort();
}

export async function hashSourceEvidence(
  root: string,
  expectedHash: string,
  packageRoot?: string,
): Promise<string> {
  try {
    return await hashSkillSource(root);
  } catch (error) {
    if (!packageRoot || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    const bundledRoot = path.join(packageRoot, bundledSourceRoot(expectedHash));
    const stats = await fs.lstat(bundledRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("Bundled Skill source is not a regular directory");
    if (
      !isWithin(await fs.realpath(packageRoot), await fs.realpath(bundledRoot))
    )
      throw new Error("Bundled Skill source resolves outside the package");
    return hashSkillSource(bundledRoot);
  }
}
