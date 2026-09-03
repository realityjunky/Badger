import { promises as fs } from "node:fs";
import path from "node:path";
import type { FactoryPlan } from "../types.js";
import { copyDirectory, ensureDirectory, isWithin, sha256 } from "../util.js";
import type { DifferentialFixture, DifferentialSkill } from "./types.js";

export interface SnapshotFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DirectorySnapshot {
  root: string;
  files: SnapshotFile[];
  sha256: string;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function reorganizedSkillsRoot(repositoryRoot: string): string {
  return path.resolve(repositoryRoot, "primer_designer_harness", "skills");
}

function resolveFixtureSkillsRoot(
  repositoryRoot: string,
  configuredRoot?: string,
): string {
  return path.resolve(configuredRoot ?? reorganizedSkillsRoot(repositoryRoot));
}

export function assertFixtureSourcePath(
  repositoryRoot: string,
  sourcePath: string,
  configuredSkillsRoot?: string,
): void {
  const candidate = path.resolve(sourcePath);
  const skillsRoot = resolveFixtureSkillsRoot(
    repositoryRoot,
    configuredSkillsRoot,
  );
  if (candidate.split(path.sep).includes("raw_data"))
    throw new Error(
      `Fixture sources must not use protected raw_data: ${candidate}`,
    );
  if (
    !isWithin(skillsRoot, candidate) ||
    path.dirname(candidate) !== skillsRoot
  )
    throw new Error(
      `Fixture sources must be under the configured Skill fixture root: ${candidate}`,
    );
}

async function collectSnapshotFiles(
  root: string,
  directory: string,
  result: SnapshotFile[],
): Promise<void> {
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const relative = portablePath(path.relative(root, target));
    const stats = await fs.lstat(target);
    if (stats.isSymbolicLink())
      throw new Error(
        `Fixture snapshots do not support symbolic links: ${relative}`,
      );
    if (stats.isDirectory()) {
      await collectSnapshotFiles(root, target, result);
      continue;
    }
    if (!stats.isFile())
      throw new Error(
        `Fixture snapshots do not support special files: ${relative}`,
      );
    const content = await fs.readFile(target);
    result.push({
      path: relative,
      bytes: content.byteLength,
      sha256: sha256(content),
    });
  }
}

export async function snapshotDirectory(
  root: string,
): Promise<DirectorySnapshot> {
  const absoluteRoot = path.resolve(root);
  const rootStats = await fs.lstat(absoluteRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new Error(
      `Fixture snapshots require a regular directory: ${absoluteRoot}`,
    );
  const files: SnapshotFile[] = [];
  await collectSnapshotFiles(absoluteRoot, absoluteRoot, files);
  return {
    root: absoluteRoot,
    files,
    sha256: sha256(JSON.stringify(files)),
  };
}

export function snapshotsEqual(
  left: DirectorySnapshot,
  right: DirectorySnapshot,
): boolean {
  return (
    left.sha256 === right.sha256 &&
    JSON.stringify(left.files) === JSON.stringify(right.files)
  );
}

export async function copyFixtureSkill(
  repositoryRoot: string,
  sourcePath: string,
  destination: string,
  configuredSkillsRoot?: string,
): Promise<void> {
  assertFixtureSourcePath(repositoryRoot, sourcePath, configuredSkillsRoot);
  const realSource = await fs.realpath(path.resolve(sourcePath));
  assertFixtureSourcePath(repositoryRoot, realSource, configuredSkillsRoot);
  await ensureDirectory(path.dirname(destination));
  await copyDirectory(realSource, path.resolve(destination));
  const sourceSnapshot = await snapshotDirectory(realSource);
  const destinationSnapshot = await snapshotDirectory(destination);
  if (!snapshotsEqual(sourceSnapshot, destinationSnapshot))
    throw new Error(`Fixture Skill copy changed bytes: ${sourcePath}`);
}

export function fixtureSkillPath(
  fixturePath: string,
  skill: DifferentialSkill,
): string {
  return path.resolve(path.dirname(fixturePath), skill.path);
}

export function fixturePlanForStandalone(
  fixture: DifferentialFixture,
): FactoryPlan {
  return structuredClone(fixture.plan);
}

export function fixturePlanForOfficial(
  fixture: DifferentialFixture,
): Omit<FactoryPlan, "schemaVersion"> {
  const { schemaVersion: _schemaVersion, ...plan } = structuredClone(
    fixture.plan,
  );
  return plan;
}

export async function readFixture(file: string): Promise<DifferentialFixture> {
  const fixturePath = path.resolve(file);
  const value = JSON.parse(
    await fs.readFile(fixturePath, "utf8"),
  ) as DifferentialFixture;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !value.id ||
    !value.plan ||
    typeof value.extractionManifest !== "string"
  )
    throw new Error(`Invalid differential fixture: ${fixturePath}`);
  if (!Array.isArray(value.skills) || value.skills.length === 0)
    throw new Error(`Differential fixture must declare Skills: ${fixturePath}`);
  if (
    value.plan.schemaVersion !== 1 ||
    value.plan.workflow.kind !== "workflow-kernel"
  )
    throw new Error("Differential fixtures support workflow-kernel plans only");
  const names = new Set(value.skills.map((skill) => skill.name));
  if (names.size !== value.skills.length)
    throw new Error(
      `Differential fixture contains duplicate Skill names: ${fixturePath}`,
    );
  for (const skill of value.skills) {
    if (!skill.name || !skill.path)
      throw new Error(
        `Differential fixture contains an invalid Skill declaration: ${fixturePath}`,
      );
  }
  return value;
}
