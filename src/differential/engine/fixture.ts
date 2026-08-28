import { promises as fs } from "node:fs";
import path from "node:path";
import type { DirectorySnapshot } from "../fixture.js";
import {
  copyDirectory,
  ensureDirectory,
  isWithin,
  sha256,
} from "../../util.js";
import { snapshotDirectory, snapshotsEqual } from "../fixture.js";
import type {
  EngineCharacterizationFixture,
  EngineFixtureSkill,
  EngineSourceManifest,
} from "./types.js";
import { ENGINE_PARITY_REQUIREMENTS } from "./types.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENGINE_ERROR_CATEGORIES = new Set([
  "revision-mismatch",
  "invalid-run-id",
  "invalid-run-state",
  "unsafe-path",
  "pending-action-mismatch",
  "outcome-mismatch",
  "guardrail-rejection",
  "unknown-step",
  "malformed-trajectory",
  "file-too-large",
  "incompatible-upgrade",
  "terminal-run",
  "command-failure",
  "unknown",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function safeRelativePath(value: unknown, label: string): string {
  const relative = requiredString(value, label).replaceAll("\\", "/");
  const normalized = path.posix.normalize(relative);
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    relative.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a relative path inside the fixture`);
  }
  return normalized;
}

function protectedRawDataRoot(repositoryRoot: string): string {
  return path.resolve(repositoryRoot, "primer_designer_harness", "raw_data");
}

function containsProtectedPath(
  repositoryRoot: string,
  candidate: string,
): boolean {
  const resolved = path.resolve(candidate);
  if (isWithin(protectedRawDataRoot(repositoryRoot), resolved)) return true;
  return resolved.split(path.sep).includes("raw_data");
}

export function assertEngineFixturePath(
  repositoryRoot: string,
  fixturePath: string,
): void {
  const candidate = path.resolve(fixturePath);
  if (containsProtectedPath(repositoryRoot, candidate)) {
    throw new Error(
      `Engine fixtures must not use protected raw data: ${candidate}`,
    );
  }
}

export function assertEngineFixtureSourcePath(
  repositoryRoot: string,
  fixturePath: string,
  sourcePath: string,
): void {
  assertEngineFixturePath(repositoryRoot, fixturePath);
  const candidate = path.resolve(sourcePath);
  const fixtureRoot = path.dirname(path.resolve(fixturePath));
  const skillsRoot = path.join(fixtureRoot, "skills");
  if (containsProtectedPath(repositoryRoot, candidate)) {
    throw new Error(
      `Engine fixture sources must not use protected raw data: ${candidate}`,
    );
  }
  if (!isWithin(skillsRoot, candidate)) {
    throw new Error(
      `Engine fixture sources must be under test/fixtures/engine/skills: ${candidate}`,
    );
  }
}

function validateSkillDeclaration(
  repositoryRoot: string,
  fixturePath: string,
  value: unknown,
  index: number,
): EngineFixtureSkill {
  const skill = record(value, `fixture.skills[${index}]`);
  const name = requiredString(skill.name, `fixture.skills[${index}].name`);
  if (!SAFE_NAME.test(name)) {
    throw new Error(`fixture.skills[${index}].name is invalid: ${name}`);
  }
  const relativePath = safeRelativePath(
    skill.path,
    `fixture.skills[${index}].path`,
  );
  assertEngineFixtureSourcePath(
    repositoryRoot,
    fixturePath,
    path.resolve(path.dirname(fixturePath), relativePath),
  );
  return { name, path: relativePath };
}

function validateOperation(value: unknown, label: string): void {
  const operation = record(value, label);
  const type = requiredString(operation.type, `${label}.type`);
  if (
    ![
      "start",
      "resume",
      "outcome",
      "check",
      "patch-state",
      "remove-pending",
      "upgrade",
      "mutate-skill",
      "write-checkpoint",
    ].includes(type)
  ) {
    throw new Error(`${label}.type is invalid: ${type}`);
  }
  if (operation.expectError !== undefined) {
    const expected = record(operation.expectError, `${label}.expectError`);
    const category = requiredString(
      expected.category,
      `${label}.expectError.category`,
    );
    if (!ENGINE_ERROR_CATEGORIES.has(category)) {
      throw new Error(`${label}.expectError.category is invalid: ${category}`);
    }
    if (
      expected.messageIncludes !== undefined &&
      typeof expected.messageIncludes !== "string"
    ) {
      throw new Error(`${label}.expectError.messageIncludes must be a string`);
    }
  }
  if (operation.expectResult !== undefined) {
    const expected = record(operation.expectResult, `${label}.expectResult`);
    if (expected.state !== undefined) {
      const state = record(expected.state, `${label}.expectResult.state`);
      if (
        state.status !== undefined &&
        state.status !== "running" &&
        state.status !== "waiting" &&
        state.status !== "completed" &&
        state.status !== "failed"
      ) {
        throw new Error(`${label}.expectResult.state.status is invalid`);
      }
      if (
        state.currentStep !== undefined &&
        state.currentStep !== null &&
        typeof state.currentStep !== "string"
      ) {
        throw new Error(
          `${label}.expectResult.state.currentStep must be a string or null`,
        );
      }
    }
    if (
      expected.action !== undefined &&
      expected.action !== "present" &&
      expected.action !== "absent"
    ) {
      throw new Error(`${label}.expectResult.action is invalid`);
    }
    if (expected.reason !== undefined && typeof expected.reason !== "string") {
      throw new Error(`${label}.expectResult.reason must be a string`);
    }
  }
  if (type === "outcome") {
    if (operation.status !== "succeeded" && operation.status !== "failed") {
      throw new Error(`${label}.status must be succeeded or failed`);
    }
    requiredString(operation.summary, `${label}.summary`);
    for (const field of ["artifacts", "state"]) {
      if (operation[field] === undefined) continue;
      const values = record(operation[field], `${label}.${field}`);
      for (const [key, value] of Object.entries(values)) {
        requiredString(key, `${label}.${field} key`);
        requiredString(value, `${label}.${field}.${key}`);
      }
    }
  }
  if (type === "check") {
    if (
      operation.scope !== "progress" &&
      operation.scope !== "step" &&
      operation.scope !== "completion"
    ) {
      throw new Error(`${label}.scope is invalid`);
    }
  }
  if (type === "patch-state") record(operation.patch, `${label}.patch`);
  if (type === "start" && operation.runId !== undefined) {
    if (typeof operation.runId !== "string") {
      throw new Error(`${label}.runId must be a string`);
    }
  }
  if (type === "upgrade") {
    requiredString(operation.replacementSkill, `${label}.replacementSkill`);
  }
  if (type === "mutate-skill") {
    safeRelativePath(operation.path, `${label}.path`);
    if (typeof operation.content !== "string") {
      throw new Error(`${label}.content must be a string`);
    }
  }
  if (type === "write-checkpoint") {
    const checkpoint = record(operation.checkpoint, `${label}.checkpoint`);
    requiredString(checkpoint.runId, `${label}.checkpoint.runId`);
    for (const field of ["stateVersion", "trajectoryOffset"]) {
      if (
        typeof checkpoint[field] !== "number" ||
        !Number.isSafeInteger(checkpoint[field]) ||
        checkpoint[field] < 0
      ) {
        throw new Error(
          `${label}.checkpoint.${field} must be a non-negative integer`,
        );
      }
    }
    if (
      checkpoint.contextHash !== null &&
      typeof checkpoint.contextHash !== "string"
    ) {
      throw new Error(
        `${label}.checkpoint.contextHash must be a string or null`,
      );
    }
    requiredString(
      checkpoint.artifactsHash,
      `${label}.checkpoint.artifactsHash`,
    );
    requiredString(checkpoint.createdAt, `${label}.checkpoint.createdAt`);
  }
  for (const field of ["confirmations"]) {
    const values = operation[field];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new Error(`${label}.${field} must be an array`);
    }
    values.forEach((value, index) =>
      requiredString(value, `${label}.${field}[${index}]`),
    );
  }
}

function validateScenario(
  value: unknown,
  index: number,
  skillNames: Set<string>,
): void {
  const scenario = record(value, `fixture.scenarios[${index}]`);
  const id = requiredString(scenario.id, `fixture.scenarios[${index}].id`);
  if (!SAFE_NAME.test(id))
    throw new Error(`fixture.scenarios[${index}].id is invalid: ${id}`);
  requiredString(
    scenario.description,
    `fixture.scenarios[${index}].description`,
  );
  const skill = requiredString(
    scenario.skill,
    `fixture.scenarios[${index}].skill`,
  );
  if (!skillNames.has(skill)) {
    throw new Error(
      `fixture.scenarios[${index}] references unknown Skill: ${skill}`,
    );
  }
  if (scenario.runner !== "manual" && scenario.runner !== "standalone") {
    throw new Error(`fixture.scenarios[${index}].runner is invalid`);
  }
  if (scenario.runId !== undefined) {
    const runId = requiredString(
      scenario.runId,
      `fixture.scenarios[${index}].runId`,
    );
    if (!SAFE_NAME.test(runId)) {
      throw new Error(`fixture.scenarios[${index}].runId is invalid: ${runId}`);
    }
  }
  if (scenario.coverage !== undefined) {
    if (!Array.isArray(scenario.coverage)) {
      throw new Error(`fixture.scenarios[${index}].coverage must be an array`);
    }
    for (const [coverageIndex, coverage] of scenario.coverage.entries()) {
      if (
        typeof coverage !== "string" ||
        !ENGINE_PARITY_REQUIREMENTS.includes(
          coverage as (typeof ENGINE_PARITY_REQUIREMENTS)[number],
        )
      ) {
        throw new Error(
          `fixture.scenarios[${index}].coverage[${coverageIndex}] is invalid`,
        );
      }
    }
  }
  if (!Array.isArray(scenario.operations) || scenario.operations.length === 0) {
    throw new Error(`fixture.scenarios[${index}].operations must not be empty`);
  }
  scenario.operations.forEach((operation, operationIndex) =>
    validateOperation(
      operation,
      `fixture.scenarios[${index}].operations[${operationIndex}]`,
    ),
  );
  for (const [operationIndex, operation] of scenario.operations.entries()) {
    if (
      operation.type === "upgrade" &&
      !skillNames.has(operation.replacementSkill)
    ) {
      throw new Error(
        `fixture.scenarios[${index}].operations[${operationIndex}] references unknown replacement Skill: ${operation.replacementSkill}`,
      );
    }
  }
}

export async function readEngineFixture(
  file: string,
  options: { repositoryRoot?: string } = {},
): Promise<EngineCharacterizationFixture> {
  const fixturePath = path.resolve(file);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  assertEngineFixturePath(repositoryRoot, fixturePath);
  const value = JSON.parse(await fs.readFile(fixturePath, "utf8")) as unknown;
  const fixture = record(value, "engine characterization fixture");
  if (fixture.schemaVersion !== 1) {
    throw new Error(`Unsupported engine fixture schema: ${fixturePath}`);
  }
  requiredString(fixture.id, "fixture.id");
  const manifest = safeRelativePath(fixture.manifest, "fixture.manifest");
  const skillsValue = fixture.skills;
  if (!Array.isArray(skillsValue) || skillsValue.length === 0) {
    throw new Error("fixture.skills must not be empty");
  }
  const skills = skillsValue.map((skill, index) =>
    validateSkillDeclaration(repositoryRoot, fixturePath, skill, index),
  );
  const skillNames = new Set(skills.map((skill) => skill.name));
  if (skillNames.size !== skills.length) {
    throw new Error(
      `Engine fixture contains duplicate Skill names: ${fixturePath}`,
    );
  }
  if (!Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
    throw new Error("fixture.scenarios must not be empty");
  }
  const scenarioIds = new Set<string>();
  for (const [index, scenario] of fixture.scenarios.entries()) {
    validateScenario(scenario, index, skillNames);
    const id = (scenario as Record<string, unknown>).id as string;
    if (!scenarioIds.add(id))
      throw new Error(`Duplicate engine scenario: ${id}`);
  }
  return {
    schemaVersion: 1,
    id: fixture.id as string,
    manifest,
    skills,
    scenarios: fixture.scenarios as EngineCharacterizationFixture["scenarios"],
  };
}

export async function readEngineManifest(
  file: string,
  options: { repositoryRoot?: string } = {},
): Promise<EngineSourceManifest> {
  const manifestPath = path.resolve(file);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  assertEngineFixturePath(repositoryRoot, manifestPath);
  const value = record(
    JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown,
    "engine source manifest",
  );
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "official-engine-characterization"
  ) {
    throw new Error(`Unsupported engine source manifest: ${manifestPath}`);
  }
  const official = record(value.official, "engine source manifest.official");
  const revision = requiredString(official.revision, "official.revision");
  if (!/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("official.revision must be a 40-character SHA-1");
  }
  requiredString(official.remote, "official.remote");
  requiredString(official.version, "official.version");
  requiredString(official.checkout, "official.checkout");
  if (official.readOnly !== true)
    throw new Error("official.readOnly must be true");
  if (
    !Array.isArray(official.sourcePaths) ||
    official.sourcePaths.length === 0
  ) {
    throw new Error("official.sourcePaths must not be empty");
  }
  const sourcePaths = official.sourcePaths.map((sourcePath, index) =>
    safeRelativePath(sourcePath, `official.sourcePaths[${index}]`),
  );
  for (const sourcePath of sourcePaths) {
    if (sourcePath.split("/").includes("raw_data")) {
      throw new Error(
        `Official source path must not use protected raw data: ${sourcePath}`,
      );
    }
  }
  const closure = record(value.closure, "engine source manifest.closure");
  for (const key of ["engine", "skillRuntime", "protectedFilesystem"]) {
    if (!Array.isArray(closure[key]))
      throw new Error(`closure.${key} must be an array`);
    closure[key] = closure[key].map((item, index) =>
      safeRelativePath(item, `closure.${key}[${index}]`),
    );
  }
  if (!Array.isArray(value.excluded))
    throw new Error("excluded must be an array");
  return {
    schemaVersion: 1,
    kind: "official-engine-characterization",
    official: {
      remote: official.remote as string,
      revision,
      version: official.version as string,
      checkout: official.checkout as string,
      readOnly: true,
      sourcePaths,
    },
    closure: closure as unknown as EngineSourceManifest["closure"],
    excluded: value.excluded.map((item, index) =>
      safeRelativePath(item, `excluded[${index}]`),
    ),
  };
}

export function engineFixtureSkillPath(
  fixturePath: string,
  skill: EngineFixtureSkill,
): string {
  return path.resolve(path.dirname(fixturePath), skill.path);
}

export async function snapshotEngineFixtureSkills(
  repositoryRoot: string,
  fixturePath: string,
  skills: EngineFixtureSkill[],
): Promise<DirectorySnapshot[]> {
  return Promise.all(
    skills.map(async (skill) => {
      const source = engineFixtureSkillPath(fixturePath, skill);
      assertEngineFixtureSourcePath(repositoryRoot, fixturePath, source);
      const realSource = await fs.realpath(source);
      assertEngineFixtureSourcePath(repositoryRoot, fixturePath, realSource);
      await fs.access(path.join(source, "SKILL.md"));
      return snapshotDirectory(realSource);
    }),
  );
}

export async function copyEngineFixtureSkill(
  repositoryRoot: string,
  fixturePath: string,
  skill: EngineFixtureSkill,
  destination: string,
): Promise<void> {
  const source = engineFixtureSkillPath(fixturePath, skill);
  assertEngineFixtureSourcePath(repositoryRoot, fixturePath, source);
  const realSource = await fs.realpath(source);
  assertEngineFixtureSourcePath(repositoryRoot, fixturePath, realSource);
  await ensureDirectory(path.dirname(destination));
  await copyDirectory(realSource, path.resolve(destination));
  const sourceSnapshot = await snapshotDirectory(realSource);
  const destinationSnapshot = await snapshotDirectory(destination);
  if (!snapshotsEqual(sourceSnapshot, destinationSnapshot)) {
    throw new Error(`Engine fixture Skill copy changed bytes: ${source}`);
  }
}

export async function snapshotEngineSourceFiles(
  officialRoot: string,
  relativePaths: string[],
): Promise<DirectorySnapshot> {
  const root = path.resolve(officialRoot);
  const realRoot = await fs.realpath(root);
  const files = [];
  for (const relativePath of relativePaths) {
    const normalized = safeRelativePath(relativePath, "official source path");
    if (normalized.split("/").includes("raw_data")) {
      throw new Error(
        `Official source path must not use protected raw data: ${normalized}`,
      );
    }
    const target = path.resolve(root, normalized);
    if (!isWithin(root, target))
      throw new Error(`Official source path escapes checkout: ${normalized}`);
    const realTarget = await fs.realpath(target);
    if (!isWithin(realRoot, realTarget)) {
      throw new Error(
        `Official source path resolves outside checkout: ${normalized}`,
      );
    }
    const stats = await fs.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(
        `Official source path must be a regular file: ${normalized}`,
      );
    }
    const content = await fs.readFile(target);
    files.push({
      path: normalized,
      bytes: content.byteLength,
      sha256: sha256(content),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { root, files, sha256: sha256(JSON.stringify(files)) };
}

export function sourceSnapshotsEqual(
  before: DirectorySnapshot,
  after: DirectorySnapshot,
): boolean {
  return (
    before.sha256 === after.sha256 &&
    JSON.stringify(before.files) === JSON.stringify(after.files)
  );
}
