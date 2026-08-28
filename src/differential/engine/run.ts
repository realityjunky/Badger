import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DirectorySnapshot } from "../fixture.js";
import {
  createOfficialCommandRunner,
  readOfficialRevision,
} from "../official.js";
import { snapshotsEqual } from "../fixture.js";
import {
  copyEngineFixtureSkill,
  readEngineFixture,
  readEngineManifest,
  snapshotEngineFixtureSkills,
  snapshotEngineSourceFiles,
  sourceSnapshotsEqual,
} from "./fixture.js";
import {
  classifyEngineError,
  compareEngineObservationSets,
  normalizeEngineObservation,
  normalizedSnapshot,
  observeEngineRun,
} from "./observe.js";
import { createPrivateEngineCommandRunner } from "./private.js";
import {
  certifyEngineDifferential,
  getEngineParityCoverage,
} from "./certification.js";
import type { Checkpoint } from "../../engine/types.js";
import type {
  ClassifiedEngineError,
  EngineBaselineOptions,
  EngineBaselineReport,
  EngineCharacterizationFixture,
  EngineCommandObservation,
  EngineCommandRunner,
  EngineDifferentialOptions,
  EngineDifferentialReport,
  EngineExpectedError,
  EngineScenario,
  EngineScenarioOperation,
  EngineScenarioObservation,
  EngineSourceManifest,
} from "./types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as RecordValue;
}

function targetArgs(
  scenario: EngineScenario,
  projectRoot: string,
  runRoot: string,
  runId = scenario.runId ?? scenario.id,
): string[] {
  return scenario.runner === "manual"
    ? ["--change", runRoot, "--project", projectRoot]
    : ["--run-id", runId, "--project", projectRoot];
}

function confirmations(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => ["--confirm", value]);
}

function commandForOperation(
  scenario: EngineScenario,
  projectRoot: string,
  runRoot: string,
  skillRoot: string,
  operation: Exclude<
    EngineScenarioOperation,
    {
      type:
        "patch-state" | "remove-pending" | "mutate-skill" | "write-checkpoint";
    }
  >,
  replacementSkillRoots: ReadonlyMap<string, string>,
): string[] {
  if (operation.type === "start") {
    return [
      "skill",
      "run",
      skillRoot,
      ...targetArgs(scenario, projectRoot, runRoot, operation.runId),
      ...confirmations(operation.confirmations),
      "--json",
    ];
  }
  if (operation.type === "resume") {
    return [
      "skill",
      "continue",
      ...targetArgs(scenario, projectRoot, runRoot),
      ...confirmations(operation.confirmations),
      "--json",
    ];
  }
  if (operation.type === "outcome") {
    return [
      "skill",
      "continue",
      ...targetArgs(scenario, projectRoot, runRoot),
      "--status",
      operation.status,
      "--summary",
      operation.summary,
      ...Object.entries(operation.artifacts ?? {}).flatMap(([key, value]) => [
        "--artifact",
        `${key}=${value}`,
      ]),
      ...Object.entries(operation.state ?? {}).flatMap(([key, value]) => [
        "--state",
        `${key}=${value}`,
      ]),
      ...confirmations(operation.confirmations),
      "--json",
    ];
  }
  if (operation.type === "upgrade") {
    const replacementRoot = replacementSkillRoots.get(
      operation.replacementSkill,
    );
    if (!replacementRoot) {
      throw new Error(
        `Engine fixture replacement Skill is missing: ${operation.replacementSkill}`,
      );
    }
    return [
      "skill",
      "continue",
      ...targetArgs(scenario, projectRoot, runRoot),
      "--upgrade",
      replacementRoot,
      "--json",
    ];
  }
  return [
    "skill",
    "check",
    ...targetArgs(scenario, projectRoot, runRoot),
    "--scope",
    operation.scope,
    "--json",
  ];
}

function expectedError(
  operation: EngineScenarioOperation,
): EngineExpectedError | undefined {
  return operation.expectError;
}

function validateExpectedError(
  scenario: EngineScenario,
  operation: EngineScenarioOperation,
  error: ClassifiedEngineError | undefined,
): void {
  const expected = expectedError(operation);
  if (!expected && error) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} failed: ${error.message}`,
    );
  }
  if (expected && !error) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} expected ${expected.category} but succeeded`,
    );
  }
  if (!expected || !error) return;
  if (error.category !== expected.category) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} expected ${expected.category}, got ${error.category}: ${error.message}`,
    );
  }
  if (
    expected.messageIncludes &&
    !error.message.includes(expected.messageIncludes)
  ) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} error did not include ${expected.messageIncludes}: ${error.message}`,
    );
  }
}

function validateExpectedResult(
  scenario: EngineScenario,
  operation: EngineScenarioOperation,
  result: unknown,
): void {
  const expected = operation.expectResult;
  if (!expected) return;
  const document = record(result, `${scenario.id} ${operation.type} result`);
  if (expected.state) {
    const state = record(
      document.state,
      `${scenario.id} ${operation.type} result.state`,
    );
    if (
      expected.state.status !== undefined &&
      state.status !== expected.state.status
    ) {
      throw new Error(
        `Engine scenario ${scenario.id} operation ${operation.type} expected state.status ${expected.state.status}`,
      );
    }
    if (
      expected.state.currentStep !== undefined &&
      state.currentStep !== expected.state.currentStep
    ) {
      throw new Error(
        `Engine scenario ${scenario.id} operation ${operation.type} expected state.currentStep ${String(expected.state.currentStep)}`,
      );
    }
  }
  if (expected.action === "present" && !document.action) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} expected a pending action`,
    );
  }
  if (expected.action === "absent" && document.action !== null) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} expected no pending action`,
    );
  }
  if (expected.reason !== undefined && document.reason !== expected.reason) {
    throw new Error(
      `Engine scenario ${scenario.id} operation ${operation.type} expected reason ${expected.reason}`,
    );
  }
}

async function runOfficialCommand(
  runner: EngineCommandRunner,
  scenario: EngineScenario,
  operation: Exclude<
    EngineScenarioOperation,
    {
      type:
        "patch-state" | "remove-pending" | "mutate-skill" | "write-checkpoint";
    }
  >,
  args: string[],
  projectRoot: string,
  homeDir: string,
): Promise<EngineCommandObservation> {
  let result: unknown;
  let error: ClassifiedEngineError | undefined;
  try {
    result = await runner.run(args, { cwd: projectRoot, homeDir });
  } catch (caught) {
    error = classifyEngineError(caught, operation.type);
  }
  if (!error) validateExpectedResult(scenario, operation, result);
  validateExpectedError(scenario, operation, error);
  return {
    operation: operation.type,
    args,
    ...(error ? { error } : { result }),
  };
}

async function patchState(
  runRoot: string,
  patch: Record<string, unknown>,
): Promise<RecordValue> {
  const file = path.join(runRoot, ".comet", "run-state.json");
  const current = record(
    JSON.parse(await fs.readFile(file, "utf8")) as unknown,
    "Run state",
  );
  const next = { ...current, ...patch };
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { patched: Object.keys(patch).sort() };
}

async function runMutation(
  scenario: EngineScenario,
  operation: Extract<
    EngineScenarioOperation,
    {
      type:
        "patch-state" | "remove-pending" | "mutate-skill" | "write-checkpoint";
    }
  >,
  mutate: () => Promise<RecordValue>,
): Promise<EngineCommandObservation> {
  let result: RecordValue | undefined;
  let error: ClassifiedEngineError | undefined;
  try {
    result = await mutate();
  } catch (caught) {
    error = classifyEngineError(caught, operation.type);
  }
  validateExpectedError(scenario, operation, error);
  return {
    operation: operation.type,
    args: [],
    ...(error ? { error } : { result }),
  };
}

async function removePending(runRoot: string): Promise<RecordValue> {
  await fs.rm(path.join(runRoot, ".comet", "pending-action.json"), {
    force: true,
  });
  return { removed: ".comet/pending-action.json" };
}

async function mutateSkill(
  skillRoot: string,
  relativePath: string,
  content: string,
): Promise<RecordValue> {
  const normalized = relativePath.replaceAll("\\", "/");
  const target = path.resolve(skillRoot, ...normalized.split("/"));
  const relative = path.relative(path.resolve(skillRoot), target);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `Skill mutation must stay inside the Skill package: ${relativePath}`,
    );
  }
  await fs.writeFile(target, content, "utf8");
  return { modified: normalized };
}

async function writeCheckpoint(
  runRoot: string,
  checkpoint: Checkpoint,
): Promise<RecordValue> {
  const file = path.join(runRoot, ".comet", "checkpoint.json");
  await fs.writeFile(file, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  return { written: ".comet/checkpoint.json" };
}

async function observeScenario(options: {
  fixture: EngineCharacterizationFixture;
  scenario: EngineScenario;
  repositoryRoot: string;
  fixturePath: string;
  temporaryRoot: string;
  runner: EngineCommandRunner;
}): Promise<EngineScenarioObservation> {
  const scenarioRoot = path.join(
    options.temporaryRoot,
    "scenarios",
    options.scenario.id,
  );
  const projectRoot = path.join(scenarioRoot, "project");
  const homeDir = path.join(scenarioRoot, "home");
  const skillRoot = path.join(projectRoot, "skills", options.scenario.skill);
  const runId = options.scenario.runId ?? options.scenario.id;
  const runRoot =
    options.scenario.runner === "manual"
      ? path.join(scenarioRoot, "change")
      : path.join(projectRoot, ".comet", "runs", runId);
  const skill = options.fixture.skills.find(
    (candidate) => candidate.name === options.scenario.skill,
  );
  if (!skill)
    throw new Error(
      `Engine fixture Skill is missing: ${options.scenario.skill}`,
    );
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await copyEngineFixtureSkill(
    options.repositoryRoot,
    options.fixturePath,
    skill,
    skillRoot,
  );
  const replacementSkillRoots = new Map<string, string>();
  for (const operation of options.scenario.operations) {
    if (operation.type !== "upgrade") continue;
    if (replacementSkillRoots.has(operation.replacementSkill)) continue;
    const replacement = options.fixture.skills.find(
      (candidate) => candidate.name === operation.replacementSkill,
    );
    if (!replacement) {
      throw new Error(
        `Engine fixture replacement Skill is missing: ${operation.replacementSkill}`,
      );
    }
    const replacementRoot = path.join(
      projectRoot,
      "replacement-skills",
      replacement.name,
    );
    await copyEngineFixtureSkill(
      options.repositoryRoot,
      options.fixturePath,
      replacement,
      replacementRoot,
    );
    replacementSkillRoots.set(replacement.name, replacementRoot);
  }

  const commands: EngineCommandObservation[] = [];
  for (const operation of options.scenario.operations) {
    if (operation.type === "patch-state") {
      commands.push(
        await runMutation(options.scenario, operation, () =>
          patchState(runRoot, operation.patch),
        ),
      );
      continue;
    }
    if (operation.type === "remove-pending") {
      commands.push(
        await runMutation(options.scenario, operation, () =>
          removePending(runRoot),
        ),
      );
      continue;
    }
    if (operation.type === "mutate-skill") {
      commands.push(
        await runMutation(options.scenario, operation, () =>
          mutateSkill(skillRoot, operation.path, operation.content),
        ),
      );
      continue;
    }
    if (operation.type === "write-checkpoint") {
      commands.push(
        await runMutation(options.scenario, operation, () =>
          writeCheckpoint(runRoot, operation.checkpoint),
        ),
      );
      continue;
    }
    const args = commandForOperation(
      options.scenario,
      projectRoot,
      runRoot,
      skillRoot,
      operation,
      replacementSkillRoots,
    );
    commands.push(
      await runOfficialCommand(
        options.runner,
        options.scenario,
        operation,
        args,
        projectRoot,
        homeDir,
      ),
    );
  }

  const observation = await observeEngineRun({
    scenario: options.scenario,
    coordinates: { projectRoot, homeDir, skillRoot, runRoot },
    commands,
  });
  return normalizeEngineObservation(observation);
}

function normalizedFixtureSnapshot(
  snapshots: DirectorySnapshot[],
): DirectorySnapshot[] {
  return snapshots.map((snapshot) =>
    normalizedSnapshot(snapshot, "<fixture-root>"),
  );
}

function normalizedOfficialSnapshot(
  snapshot: DirectorySnapshot,
): DirectorySnapshot {
  return normalizedSnapshot(snapshot, "<official-root>");
}

async function verifiedRevision(
  options: EngineBaselineOptions,
  manifest: EngineSourceManifest,
): Promise<string> {
  const revision = await readOfficialRevision(options.officialRoot);
  if (revision !== manifest.official.revision) {
    throw new Error(
      `Official baseline revision mismatch: expected ${manifest.official.revision}, got ${revision}`,
    );
  }
  return revision;
}

export async function runOfficialEngineBaseline(
  options: EngineBaselineOptions,
): Promise<EngineBaselineReport> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const fixturePath = path.resolve(options.fixturePath);
  const fixture = await readEngineFixture(fixturePath, { repositoryRoot });
  const manifestPath = path.resolve(
    path.dirname(fixturePath),
    fixture.manifest,
  );
  const manifest = await readEngineManifest(manifestPath, { repositoryRoot });
  const revision = await verifiedRevision(options, manifest);
  const sourceBefore = await snapshotEngineSourceFiles(
    options.officialRoot,
    manifest.official.sourcePaths,
  );
  const fixtureBefore = await snapshotEngineFixtureSkills(
    repositoryRoot,
    fixturePath,
    fixture.skills,
  );
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "comet-engine-baseline-"),
  );
  const runner =
    options.officialRunner ??
    createOfficialCommandRunner({
      officialCli:
        options.officialCli ??
        path.join(path.resolve(options.officialRoot), "bin", "comet.js"),
    });
  try {
    const scenarios = [];
    for (const scenario of fixture.scenarios) {
      scenarios.push(
        await observeScenario({
          fixture,
          scenario,
          repositoryRoot,
          fixturePath,
          temporaryRoot,
          runner,
        }),
      );
    }
    const sourceAfter = await snapshotEngineSourceFiles(
      options.officialRoot,
      manifest.official.sourcePaths,
    );
    const fixtureAfter = await snapshotEngineFixtureSkills(
      repositoryRoot,
      fixturePath,
      fixture.skills,
    );
    const officialUnchanged = sourceSnapshotsEqual(sourceBefore, sourceAfter);
    const fixtureUnchanged =
      fixtureBefore.length === fixtureAfter.length &&
      fixtureBefore.every((snapshot, index) =>
        snapshotsEqual(snapshot, fixtureAfter[index]),
      );
    if (!officialUnchanged)
      throw new Error("Official Engine source changed during characterization");
    if (!fixtureUnchanged)
      throw new Error("Engine fixture source changed during characterization");
    const comparison = {
      status: "official-baseline" as const,
      exactMatches: [],
      expectedPackagingDifferences: [],
      semanticMismatches: [],
    };
    const coverage = getEngineParityCoverage(fixture);
    return {
      schemaVersion: 1,
      kind: "official-engine-baseline",
      official: {
        root: path.resolve(options.officialRoot),
        revision,
        expectedRevision: manifest.official.revision,
        verified: true,
        sourceBefore: normalizedOfficialSnapshot(sourceBefore),
        sourceAfter: normalizedOfficialSnapshot(sourceAfter),
        unchanged: officialUnchanged,
      },
      fixture: {
        id: fixture.id,
        sourceBefore: normalizedFixtureSnapshot(fixtureBefore),
        sourceAfter: normalizedFixtureSnapshot(fixtureAfter),
        unchanged: fixtureUnchanged,
      },
      scenarios,
      comparison,
      coverage,
      certification: certifyEngineDifferential({
        official: {
          verified: true,
          unchanged: officialUnchanged,
        },
        fixture: { unchanged: fixtureUnchanged },
        comparison,
        coverage,
      }),
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runPrivateEngineScenarios(options: {
  repositoryRoot: string;
  fixturePath: string;
  runner: EngineCommandRunner;
}): Promise<EngineScenarioObservation[]> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const fixturePath = path.resolve(options.fixturePath);
  const fixture = await readEngineFixture(fixturePath, { repositoryRoot });
  const fixtureBefore = await snapshotEngineFixtureSkills(
    repositoryRoot,
    fixturePath,
    fixture.skills,
  );
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "comet-private-engine-"),
  );
  try {
    const scenarios: EngineScenarioObservation[] = [];
    for (const scenario of fixture.scenarios) {
      scenarios.push(
        await observeScenario({
          fixture,
          scenario,
          repositoryRoot,
          fixturePath,
          temporaryRoot,
          runner: options.runner,
        }),
      );
    }
    const fixtureAfter = await snapshotEngineFixtureSkills(
      repositoryRoot,
      fixturePath,
      fixture.skills,
    );
    const unchanged =
      fixtureBefore.length === fixtureAfter.length &&
      fixtureBefore.every((snapshot, index) =>
        snapshotsEqual(snapshot, fixtureAfter[index]),
      );
    if (!unchanged) {
      throw new Error(
        "Engine fixture source changed during private characterization",
      );
    }
    return scenarios;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runEngineDifferential(
  options: EngineDifferentialOptions,
): Promise<EngineDifferentialReport> {
  const official = await runOfficialEngineBaseline(options);
  const privateScenarios = await runPrivateEngineScenarios({
    repositoryRoot: options.repositoryRoot,
    fixturePath: options.fixturePath,
    runner: options.privateRunner ?? createPrivateEngineCommandRunner(),
  });
  const comparison = compareEngineObservationSets(
    official.scenarios,
    privateScenarios,
  );
  const certification = certifyEngineDifferential({
    official: official.official,
    fixture: official.fixture,
    comparison,
    coverage: official.coverage,
  });
  return {
    schemaVersion: 1,
    kind: "official-private-engine-differential",
    official: official.official,
    fixture: official.fixture,
    officialScenarios: official.scenarios,
    privateScenarios,
    comparison,
    coverage: official.coverage,
    certification,
  };
}
