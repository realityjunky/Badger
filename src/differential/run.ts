import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareObservations } from "./observe.js";
import {
  assertFixtureSourcePath,
  copyFixtureSkill,
  fixtureSkillPath,
  readFixture,
  snapshotDirectory,
  snapshotsEqual,
  type DirectorySnapshot,
} from "./fixture.js";
import {
  createOfficialCommandRunner,
  observeOfficial,
  readOfficialRevision,
} from "./official.js";
import { observeStandalone } from "./standalone.js";
import type {
  DifferentialHarnessOptions,
  DifferentialReport,
  OfficialCommandRunner,
} from "./types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

export async function readExtractionManifest(file: string): Promise<unknown> {
  const value = JSON.parse(
    await fs.readFile(path.resolve(file), "utf8"),
  ) as unknown;
  const manifest = record(value, "extraction manifest");
  if (manifest.schemaVersion !== 1)
    throw new Error(`Unsupported extraction manifest schema: ${file}`);
  const official = record(manifest.official, "extraction manifest.official");
  if (typeof official.revision !== "string" || official.revision.length === 0)
    throw new Error("Extraction manifest must pin an official revision");
  const reusable = record(
    manifest.reusableWorkflowKernel,
    "extraction manifest.reusableWorkflowKernel",
  );
  const excluded = record(manifest.excluded, "extraction manifest.excluded");
  const reusablePaths = Object.values(reusable).flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
  );
  const excludedPaths = Object.values(excluded).flatMap((value) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [],
  );
  const overlap = reusablePaths.filter((item) => excludedPaths.includes(item));
  if (overlap.length > 0)
    throw new Error(
      `Extraction manifest reuses excluded modules: ${overlap.join(", ")}`,
    );
  for (const category of [
    "classic",
    "native",
    "entry",
    "installer",
    "engine",
    "hostPlatform",
  ]) {
    if (!Array.isArray(excluded[category]))
      throw new Error(`Extraction manifest is missing excluded.${category}`);
  }
  return value;
}

async function sourceSnapshots(
  repositoryRoot: string,
  fixturePath: string,
  skills: Array<{ name: string; path: string }>,
): Promise<DirectorySnapshot[]> {
  return Promise.all(
    skills.map(async (skill) => {
      const source = fixtureSkillPath(fixturePath, skill);
      assertFixtureSourcePath(repositoryRoot, source);
      await fs.access(path.join(source, "SKILL.md"));
      return snapshotDirectory(source);
    }),
  );
}

function expectedOfficialRevision(manifest: unknown): string {
  const document = record(manifest, "extraction manifest");
  const official = record(document.official, "extraction manifest.official");
  return official.revision as string;
}

function sourceIntegrity(
  before: DirectorySnapshot[],
  after: DirectorySnapshot[],
): boolean {
  return (
    before.length === after.length &&
    before.every((snapshot, index) => snapshotsEqual(snapshot, after[index]))
  );
}

async function prepareProject(
  repositoryRoot: string,
  fixturePath: string,
  projectRoot: string,
  skills: Array<{ name: string; path: string }>,
): Promise<void> {
  await fs.mkdir(path.join(projectRoot, ".agents", "skills"), {
    recursive: true,
  });
  for (const skill of skills) {
    await copyFixtureSkill(
      repositoryRoot,
      fixtureSkillPath(fixturePath, skill),
      path.join(projectRoot, ".agents", "skills", skill.name),
    );
  }
}

export async function runDifferentialHarness(
  options: DifferentialHarnessOptions,
): Promise<DifferentialReport> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const fixturePath = path.resolve(options.fixturePath);
  const fixture = await readFixture(fixturePath);
  const manifestPath = path.resolve(
    path.dirname(fixturePath),
    fixture.extractionManifest,
  );
  const extractionManifest = await readExtractionManifest(manifestPath);
  const expectedRevision = expectedOfficialRevision(extractionManifest);
  const officialRevision =
    options.officialRevision ??
    (await readOfficialRevision(options.officialRoot));
  if (officialRevision !== expectedRevision)
    throw new Error(
      `Official baseline revision mismatch: expected ${expectedRevision}, got ${officialRevision}`,
    );

  const sourceBefore = await sourceSnapshots(
    repositoryRoot,
    fixturePath,
    fixture.skills,
  );
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "comet-differential-"),
  );
  const officialProject = path.join(temporaryRoot, "official-project");
  const standaloneProject = path.join(temporaryRoot, "standalone-project");
  const officialHome = path.join(temporaryRoot, "official-home");
  const standaloneHome = path.join(temporaryRoot, "standalone-home");
  try {
    await Promise.all([
      prepareProject(
        repositoryRoot,
        fixturePath,
        officialProject,
        fixture.skills,
      ),
      prepareProject(
        repositoryRoot,
        fixturePath,
        standaloneProject,
        fixture.skills,
      ),
      fs.mkdir(officialHome, { recursive: true }),
      fs.mkdir(standaloneHome, { recursive: true }),
    ]);
    const runner: OfficialCommandRunner =
      options.officialRunner ??
      createOfficialCommandRunner({
        officialCli:
          options.officialCli ??
          path.join(path.resolve(options.officialRoot), "bin", "comet.js"),
      });
    const standalone = await observeStandalone({
      fixture,
      projectRoot: standaloneProject,
      homeDir: standaloneHome,
    });
    const official = await observeOfficial({
      fixture,
      projectRoot: officialProject,
      homeDir: officialHome,
      runner,
    });
    const sourceAfter = await sourceSnapshots(
      repositoryRoot,
      fixturePath,
      fixture.skills,
    );
    const unchanged = sourceIntegrity(sourceBefore, sourceAfter);
    if (!unchanged)
      throw new Error("Differential fixture changed during the run");
    return {
      schemaVersion: 1,
      fixture: {
        id: fixture.id,
        skills: fixture.skills.map((skill) => skill.name),
        sourceBefore,
        sourceAfter,
        unchanged,
      },
      official: {
        root: path.resolve(options.officialRoot),
        revision: officialRevision,
        observation: official,
      },
      standalone: { observation: standalone },
      comparison: compareObservations(official, standalone),
      extractionManifest,
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
