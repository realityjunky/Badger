import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  UpgradeMigrationDecision,
  UpgradeMigrationManifest,
  UpgradeSourceEvidence,
  UpgradeSourceFileEvidence,
} from "../types.js";
import { hashDirectory, isWithin, listFiles, sha256 } from "../util.js";

function portablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function assertSafeSourcePath(relativePath: string): void {
  const normalized = portablePath(relativePath);
  if (
    path.isAbsolute(relativePath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Upgrade source contains unsafe path: ${relativePath}`);
  }
}

async function physicalTarget(target: string): Promise<string> {
  let cursor = path.resolve(target);
  const missingSegments: string[] = [];
  while (true) {
    try {
      await fs.lstat(cursor);
      const realCursor = await fs.realpath(cursor);
      return path.resolve(realCursor, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function assertUpgradeDestinationOutsideSource(
  sourceRoot: string,
  destination: string,
  message = "Generation destination must not be inside the upgrade source package",
): Promise<void> {
  const lexicalSource = path.resolve(sourceRoot);
  const lexicalDestination = path.resolve(destination);
  if (isWithin(lexicalSource, lexicalDestination)) {
    throw new Error(message);
  }
  const realSource = await fs.realpath(lexicalSource);
  const physicalDestination = await physicalTarget(lexicalDestination);
  if (isWithin(realSource, physicalDestination)) {
    throw new Error(message);
  }
}

export async function assertDestinationWithinProject(
  projectRoot: string,
  destination: string,
  message = "Migration destination must remain inside project root",
): Promise<void> {
  const lexicalProject = path.resolve(projectRoot);
  const lexicalDestination = path.resolve(destination);
  if (!isWithin(lexicalProject, lexicalDestination)) {
    throw new Error(message);
  }
  const realProject = await fs.realpath(lexicalProject);
  const physicalDestination = await physicalTarget(lexicalDestination);
  if (!isWithin(realProject, physicalDestination)) {
    throw new Error(message);
  }
}

export async function inspectUpgradeSource(
  sourceRoot: string,
): Promise<UpgradeSourceEvidence> {
  const root = path.resolve(sourceRoot);
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(
      `Upgrade source must be a regular directory: ${sourceRoot}`,
    );
  }
  const realRoot = await fs.realpath(root);
  if (!isWithin(root, realRoot)) {
    throw new Error(`Upgrade source resolves outside its root: ${sourceRoot}`);
  }
  const skillPath = path.join(root, "SKILL.md");
  const skillStats = await fs.lstat(skillPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!skillStats?.isFile() || skillStats.isSymbolicLink()) {
    throw new Error(`Upgrade source is not a Skill directory: ${sourceRoot}`);
  }
  const files: UpgradeSourceFileEvidence[] = [];
  for (const relativePath of (await listFiles(root)).sort((left, right) =>
    left.localeCompare(right),
  )) {
    assertSafeSourcePath(relativePath);
    const content = await fs.readFile(path.join(root, relativePath));
    files.push({
      path: portablePath(relativePath),
      bytes: content.byteLength,
      hash: sha256(content),
    });
  }
  return {
    schemaVersion: 1,
    kind: "badger-upgrade-source",
    root,
    hash: await hashDirectory(root),
    files,
  };
}

export function createUpgradeMigrationManifest(
  source: UpgradeSourceEvidence,
  generatedPaths: readonly string[],
  preservedAt: UpgradeMigrationManifest["preservedAt"] = "scaffold",
): UpgradeMigrationManifest {
  const generated = new Set(generatedPaths.map(portablePath));
  const decisions: UpgradeMigrationDecision[] = source.files.map((file) => {
    const generatedPath = generated.has(file.path);
    const wrapped = file.path === "SKILL.md";
    const decision = wrapped
      ? "wrapped"
      : generatedPath
        ? "replaced"
        : "retained";
    const reason = wrapped
      ? "The source Skill body remains under source/ while the generated entry gains authored guidance."
      : generatedPath
        ? "The generated Badger control plane owns this destination path; the source copy remains under source/."
        : "The source file is retained unchanged at its destination and under source/.";
    return {
      sourcePath: file.path,
      preservedPath: `source/${file.path}`,
      destinationPath: file.path,
      sourceHash: file.hash,
      decision,
      reason,
    };
  });
  return {
    schemaVersion: 1,
    kind: "badger-upgrade-migration",
    sourceRoot: source.root,
    sourceHash: source.hash,
    files: source.files.map((file) => ({ ...file })),
    decisions,
    preservedAt,
  };
}
