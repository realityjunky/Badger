import { promises as fs } from "node:fs";
import path from "node:path";
import { snapshotDirectory, type DirectorySnapshot } from "../fixture.js";
import { sha256 } from "../../util.js";
import type {
  ClassifiedEngineError,
  EngineCommandObservation,
  EngineComparison,
  EngineComparisonDifference,
  EngineEvalObservation,
  EngineErrorCategory,
  EngineRunFilesObservation,
  EngineScenario,
  EngineScenarioObservation,
} from "./types.js";

type RecordValue = Record<string, unknown>;

type RuntimeDirectory = ".badger" | ".comet";

function defaultRunRefs(runtimeDirectory: RuntimeDirectory): {
  pendingAction: string;
  trajectory: string;
  artifacts: string;
  checkpoint: string;
} {
  return {
    pendingAction: `${runtimeDirectory}/pending-action.json`,
    trajectory: `${runtimeDirectory}/trajectory.jsonl`,
    artifacts: `${runtimeDirectory}/artifacts.json`,
    checkpoint: `${runtimeDirectory}/checkpoint.json`,
  };
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyEngineError(
  error: unknown,
  operation?: string,
): ClassifiedEngineError {
  const message = errorText(error);
  let category: EngineErrorCategory = "unknown";
  if (/baseline revision mismatch|official.*revision/iu.test(message)) {
    category = "revision-mismatch";
  } else if (/Invalid standalone Run id/iu.test(message)) {
    category = "invalid-run-id";
  } else if (
    /must stay inside|outside (?:the )?(?:change|Run|managed) (?:directory|root)|symbolic link|junction|parent changed|unsafe path|Run path/iu.test(
      message,
    )
  ) {
    category = "unsafe-path";
  } else if (/Invalid Run state/iu.test(message)) {
    category = "invalid-run-state";
  } else if (/Pending action file does not match/iu.test(message)) {
    category = "pending-action-mismatch";
  } else if (
    /Outcome does not match|No pending action accepts/iu.test(message)
  ) {
    category = "outcome-mismatch";
  } else if (
    /not allowed|confirmation required|budget exhausted|requires an Agent candidate/iu.test(
      message,
    )
  ) {
    category = "guardrail-rejection";
  } else if (/Cannot upgrade|incompatible|replacement Skill/iu.test(message)) {
    category = "incompatible-upgrade";
  } else if (/Unknown current step|Resolver returned unknown/iu.test(message)) {
    category = "unknown-step";
  } else if (/Invalid Trajectory event|trajectory.*line/iu.test(message)) {
    category = "malformed-trajectory";
  } else if (/exceeds \d+ bytes/iu.test(message)) {
    category = "file-too-large";
  } else if (/Run is (?:completed|failed)/iu.test(message)) {
    category = "terminal-run";
  } else if (
    /command failed|returned no JSON|returned invalid JSON/iu.test(message)
  ) {
    category = "command-failure";
  }
  return { category, message, ...(operation ? { operation } : {}) };
}

function within(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function safeRunFile(
  runRoot: string,
  reference: unknown,
  fallback: string,
  label: string,
  errors: ClassifiedEngineError[],
): string | null {
  if (reference === undefined) return path.resolve(runRoot, fallback);
  if (typeof reference !== "string" || reference.length === 0) {
    errors.push(
      classifyEngineError(
        new Error(`Invalid Run state: ${label} must be a non-empty string`),
        "inspect-run",
      ),
    );
    return null;
  }
  if (
    path.isAbsolute(reference) ||
    /^(?:[A-Za-z]:|[\\/]|~)/u.test(reference) ||
    reference.split(/[\\/]/u).includes("..")
  ) {
    errors.push(
      classifyEngineError(
        new Error(`Invalid Run state: ${label} must stay inside the Run root`),
        "inspect-run",
      ),
    );
    return null;
  }
  const target = path.resolve(runRoot, reference);
  if (!within(runRoot, target)) {
    errors.push(
      classifyEngineError(
        new Error(`Run path must stay inside the Run root: ${reference}`),
        "inspect-run",
      ),
    );
    return null;
  }
  return target;
}

async function readOptionalText(
  file: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const content = await fs.readFile(file);
    if (content.byteLength > maxBytes) {
      throw new Error(`${file} exceeds ${maxBytes} bytes`);
    }
    return content.toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function readOptionalJson(
  file: string,
  label: string,
  maxBytes: number,
  errors: ClassifiedEngineError[],
): Promise<unknown | null> {
  try {
    const text = await readOptionalText(file, maxBytes);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      errors.push(
        classifyEngineError(
          new Error(`Invalid ${label} JSON`, { cause: error }),
          "inspect-run",
        ),
      );
      return null;
    }
  } catch (error) {
    errors.push(classifyEngineError(error, "inspect-run"));
    return null;
  }
}

async function readTrajectory(
  file: string,
  errors: ClassifiedEngineError[],
): Promise<unknown[]> {
  let text: string | null;
  try {
    text = await readOptionalText(file, 8 * 1024 * 1024);
  } catch (error) {
    errors.push(classifyEngineError(error, "inspect-trajectory"));
    return [];
  }
  if (text === null) return [];
  const events: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as unknown);
    } catch (error) {
      errors.push(
        classifyEngineError(
          new Error(`Invalid Trajectory event at line ${index + 1}`, {
            cause: error,
          }),
          "inspect-trajectory",
        ),
      );
    }
  }
  return events;
}

async function readSkillSnapshot(
  runRoot: string,
  state: RecordValue | null,
  runtimeDirectory: RuntimeDirectory,
  errors: ClassifiedEngineError[],
): Promise<DirectorySnapshot | null> {
  const hash = state?.skillHash;
  if (hash === undefined || hash === null) return null;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
    errors.push(
      classifyEngineError(
        new Error("Invalid Run state: skillHash must be a SHA-256 hash"),
        "inspect-snapshot",
      ),
    );
    return null;
  }
  try {
    return await snapshotDirectory(
      path.join(runRoot, runtimeDirectory, "skill-snapshots", hash),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    errors.push(classifyEngineError(error, "inspect-snapshot"));
    return null;
  }
}

function trajectoryOutcomes(trajectory: unknown[]): unknown[] {
  return trajectory.flatMap((event) => {
    const document = record(event);
    const data = record(document?.data);
    if (document?.type !== "action_completed" || data?.outcome === undefined) {
      return [];
    }
    return [data.outcome];
  });
}

function trajectoryEvals(trajectory: unknown[]): EngineEvalObservation[] {
  return trajectory.flatMap((event) => {
    const document = record(event);
    const data = record(document?.data);
    if (document?.type !== "eval_completed" || !Array.isArray(data?.results)) {
      return [];
    }
    const scope =
      data.scope === "progress" ||
      data.scope === "step" ||
      data.scope === "completion"
        ? data.scope
        : null;
    return [{ source: "trajectory", scope, results: data.results }];
  });
}

function commandEvals(
  commands: EngineCommandObservation[],
): EngineEvalObservation[] {
  return commands.flatMap((command) => {
    const result = record(command.result);
    if (!Array.isArray(result?.checks)) return [];
    const scope =
      result.scope === "progress" ||
      result.scope === "step" ||
      result.scope === "completion"
        ? result.scope
        : null;
    return [{ source: "command", scope, results: result.checks }];
  });
}

function normalizeTimestamp(event: unknown): unknown {
  const document = record(event);
  if (!document || typeof document.timestamp !== "string") return event;
  return { ...document, timestamp: "<timestamp>" };
}

function coordinateReplacements(
  coordinates: EngineScenarioObservation["coordinates"],
): Array<[string, string]> {
  const replacements: Array<[string, string]> = [
    [coordinates.projectRoot, "<project-root>"],
    [coordinates.homeDir, "<home-dir>"],
    [coordinates.skillRoot, "<skill-root>"],
    [coordinates.runRoot, "<run-root>"],
  ];
  return replacements
    .filter(([value]) => value.length > 0)
    .sort(([left], [right]) => right.length - left.length);
}

function replaceCoordinates(
  value: string,
  coordinates: EngineScenarioObservation["coordinates"],
): string {
  return coordinateReplacements(coordinates).reduce(
    (result, [from, to]) => result.replaceAll(from, to),
    value,
  );
}

function normalizeRuntimeValue(
  value: unknown,
  runtimeDirectory: RuntimeDirectory,
): unknown {
  if (typeof value === "string") {
    return value.replaceAll(runtimeDirectory, "<runtime>");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeValue(item, runtimeDirectory));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeRuntimeValue(item, runtimeDirectory),
    ]),
  );
}

export async function observeEngineRun(options: {
  scenario: EngineScenario;
  coordinates: EngineScenarioObservation["coordinates"];
  commands: EngineCommandObservation[];
  runtimeDirectory?: RuntimeDirectory;
}): Promise<EngineScenarioObservation> {
  const errors: ClassifiedEngineError[] = [];
  const runtimeDirectory = options.runtimeDirectory ?? ".badger";
  const runRefs = defaultRunRefs(runtimeDirectory);
  const statePath = path.join(
    options.coordinates.runRoot,
    runtimeDirectory,
    "run-state.json",
  );
  const state = await readOptionalJson(
    statePath,
    "Run state",
    256 * 1024,
    errors,
  );
  const stateDocument = record(state);
  const pendingPath = safeRunFile(
    options.coordinates.runRoot,
    stateDocument?.pendingRef,
    runRefs.pendingAction,
    "pendingRef",
    errors,
  );
  const trajectoryPath = safeRunFile(
    options.coordinates.runRoot,
    stateDocument?.trajectoryRef,
    runRefs.trajectory,
    "trajectoryRef",
    errors,
  );
  const artifactsPath = safeRunFile(
    options.coordinates.runRoot,
    stateDocument?.artifactsRef,
    runRefs.artifacts,
    "artifactsRef",
    errors,
  );
  const checkpointPath = safeRunFile(
    options.coordinates.runRoot,
    stateDocument?.checkpointRef,
    runRefs.checkpoint,
    "checkpointRef",
    errors,
  );
  const pendingAction = pendingPath
    ? await readOptionalJson(pendingPath, "pending action", 256 * 1024, errors)
    : null;
  const trajectory = trajectoryPath
    ? await readTrajectory(trajectoryPath, errors)
    : [];
  const rawArtifacts = artifactsPath
    ? await readOptionalJson(artifactsPath, "artifacts", 1024 * 1024, errors)
    : null;
  const checkpoint = checkpointPath
    ? await readOptionalJson(checkpointPath, "checkpoint", 256 * 1024, errors)
    : null;
  const snapshot = await readSkillSnapshot(
    options.coordinates.runRoot,
    stateDocument,
    runtimeDirectory,
    errors,
  );
  const artifacts = rawArtifacts === null ? {} : rawArtifacts;
  const run: EngineRunFilesObservation = {
    state,
    pendingAction,
    outcomes: trajectoryOutcomes(trajectory),
    artifacts,
    trajectory,
    checkpoint,
    snapshot,
    evals: [...trajectoryEvals(trajectory), ...commandEvals(options.commands)],
    errors,
  };
  const commandErrors = options.commands.flatMap((command) =>
    command.error ? [command.error] : [],
  );
  return {
    scenario: {
      id: options.scenario.id,
      description: options.scenario.description,
      skill: options.scenario.skill,
      runner: options.scenario.runner,
      runId: options.scenario.runId ?? null,
      ...(options.scenario.coverage
        ? { coverage: [...options.scenario.coverage] }
        : {}),
    },
    coordinates: options.coordinates,
    commands: options.commands,
    run,
    errors: [...commandErrors, ...errors],
  };
}

export function normalizeEngineObservation(
  observation: EngineScenarioObservation,
  options: {
    preserveCoordinates?: boolean;
    runtimeDirectory?: RuntimeDirectory;
  } = {},
): EngineScenarioObservation {
  const coordinates = observation.coordinates;
  const runtimeDirectory = options.runtimeDirectory ?? ".badger";
  return {
    ...observation,
    coordinates: options.preserveCoordinates
      ? { ...coordinates }
      : {
          projectRoot: "<project-root>",
          homeDir: "<home-dir>",
          skillRoot: "<skill-root>",
          runRoot: "<run-root>",
        },
    commands: observation.commands.map(
      (command) =>
        normalizeRuntimeValue(
          {
            ...command,
            args: command.args.map((argument) =>
              replaceCoordinates(argument, coordinates),
            ),
            ...(command.error
              ? {
                  error: {
                    ...command.error,
                    message: replaceCoordinates(
                      command.error.message,
                      coordinates,
                    ),
                  },
                }
              : {}),
          },
          runtimeDirectory,
        ) as EngineCommandObservation,
    ),
    run: {
      ...observation.run,
      state: normalizeRuntimeValue(observation.run.state, runtimeDirectory),
      pendingAction: normalizeRuntimeValue(
        observation.run.pendingAction,
        runtimeDirectory,
      ),
      outcomes: normalizeRuntimeValue(
        observation.run.outcomes,
        runtimeDirectory,
      ) as unknown[],
      artifacts: normalizeRuntimeValue(
        observation.run.artifacts,
        runtimeDirectory,
      ),
      trajectory: observation.run.trajectory
        .map(normalizeTimestamp)
        .map((event) => normalizeRuntimeValue(event, runtimeDirectory)),
      checkpoint: normalizeRuntimeValue(
        observation.run.checkpoint,
        runtimeDirectory,
      ),
      snapshot: observation.run.snapshot
        ? normalizedSnapshot(observation.run.snapshot, "<snapshot-root>")
        : null,
      errors: observation.run.errors.map((error) => ({
        ...error,
        message: replaceCoordinates(error.message, coordinates).replaceAll(
          runtimeDirectory,
          "<runtime>",
        ),
      })),
    },
    errors: observation.errors.map((error) => ({
      ...error,
      message: replaceCoordinates(error.message, coordinates).replaceAll(
        runtimeDirectory,
        "<runtime>",
      ),
    })),
  };
}

function diffValues(
  official: unknown,
  privateValue: unknown,
  currentPath: string,
  result: Array<{ path: string; official: unknown; private: unknown }>,
): void {
  if (Object.is(official, privateValue)) return;
  if (Array.isArray(official) && Array.isArray(privateValue)) {
    const length = Math.max(official.length, privateValue.length);
    for (let index = 0; index < length; index += 1) {
      diffValues(
        official[index],
        privateValue[index],
        `${currentPath}[${index}]`,
        result,
      );
    }
    return;
  }
  const officialObject = record(official);
  const privateObject = record(privateValue);
  if (officialObject && privateObject) {
    const keys = new Set([
      ...Object.keys(officialObject),
      ...Object.keys(privateObject),
    ]);
    for (const key of [...keys].sort()) {
      diffValues(
        officialObject[key],
        privateObject[key],
        `${currentPath}.${key}`,
        result,
      );
    }
    return;
  }
  result.push({ path: currentPath, official, private: privateValue });
}

function expectedPackagingPath(
  currentPath: string,
  scenario: Pick<EngineScenario, "runner">,
  official: unknown,
  privateValue: unknown,
): boolean {
  if (
    currentPath === "$.run.snapshot" ||
    currentPath.startsWith("$.run.snapshot.")
  ) {
    return true;
  }
  if (
    currentPath === "$.coordinates.projectRoot" ||
    currentPath === "$.coordinates.homeDir" ||
    currentPath === "$.coordinates.skillRoot" ||
    currentPath === "$.coordinates.runRoot"
  ) {
    return true;
  }
  if (
    /^\$\.(?:commands\[\d+\]\.error|errors\[\d+\])\.message$/u.test(
      currentPath,
    ) &&
    typeof official === "string" &&
    typeof privateValue === "string" &&
    (official.endsWith(`\nError: ${privateValue}`) ||
      privateValue.endsWith(`\nError: ${official}`))
  ) {
    return true;
  }
  if (
    scenario.runner !== "manual" ||
    typeof official !== "string" ||
    typeof privateValue !== "string"
  )
    return false;
  return [
    /^\$\.commands\[\d+\]\.result\.state\.(?:runId|pending)$/u,
    /^\$\.commands\[\d+\]\.result\.action\.id$/u,
    /^\$\.run\.state\.runId$/u,
    /^\$\.run\.pendingAction\.id$/u,
    /^\$\.run\.outcomes\[\d+\]\.actionId$/u,
    /^\$\.run\.trajectory\[\d+\](?:\.runId|\.data\.action\.id|\.data\.outcome\.actionId)$/u,
  ].some((pattern) => pattern.test(currentPath));
}

export function compareEngineObservations(
  official: EngineScenarioObservation,
  privateObservation?: EngineScenarioObservation,
): EngineComparison {
  if (!privateObservation) {
    return {
      status: "official-baseline",
      exactMatches: [],
      expectedPackagingDifferences: [],
      semanticMismatches: [],
    };
  }
  const officialNormalized = normalizeEngineObservation(official, {
    preserveCoordinates: true,
  });
  const privateNormalized = normalizeEngineObservation(privateObservation, {
    preserveCoordinates: true,
  });
  const rawDifferences: Array<{
    path: string;
    official: unknown;
    private: unknown;
  }> = [];
  diffValues(officialNormalized, privateNormalized, "$", rawDifferences);
  if (rawDifferences.length === 0) {
    return {
      status: "exact-match",
      exactMatches: [official.scenario.id],
      expectedPackagingDifferences: [],
      semanticMismatches: [],
    };
  }
  const differences = rawDifferences.map<EngineComparisonDifference>(
    (difference) => ({
      scenarioId: official.scenario.id,
      ...difference,
      classification: expectedPackagingPath(
        difference.path,
        official.scenario,
        difference.official,
        difference.private,
      )
        ? "expected-packaging"
        : "semantic",
    }),
  );
  const expectedPackagingDifferences = differences.filter(
    (difference) => difference.classification === "expected-packaging",
  );
  const semanticMismatches = differences.filter(
    (difference) => difference.classification === "semantic",
  );
  return {
    status:
      semanticMismatches.length > 0
        ? "semantic-mismatch"
        : "expected-packaging-difference",
    exactMatches: [],
    expectedPackagingDifferences,
    semanticMismatches,
  };
}

export function compareEngineObservationSets(
  official: EngineScenarioObservation[],
  privateObservations?: EngineScenarioObservation[],
): EngineComparison {
  if (!privateObservations) {
    return {
      status: "official-baseline",
      exactMatches: [],
      expectedPackagingDifferences: [],
      semanticMismatches: [],
    };
  }
  const privateById = new Map(
    privateObservations.map((observation) => [
      observation.scenario.id,
      observation,
    ]),
  );
  const exactMatches: string[] = [];
  const expectedPackagingDifferences: EngineComparisonDifference[] = [];
  const semanticMismatches: EngineComparisonDifference[] = [];
  for (const observation of official) {
    const candidate = privateById.get(observation.scenario.id);
    if (!candidate) {
      semanticMismatches.push({
        scenarioId: observation.scenario.id,
        path: "$.scenario",
        official: observation.scenario,
        private: null,
        classification: "semantic",
      });
      continue;
    }
    const comparison = compareEngineObservations(observation, candidate);
    exactMatches.push(...comparison.exactMatches);
    expectedPackagingDifferences.push(
      ...comparison.expectedPackagingDifferences,
    );
    semanticMismatches.push(...comparison.semanticMismatches);
  }
  for (const observation of privateObservations) {
    if (official.some((item) => item.scenario.id === observation.scenario.id))
      continue;
    semanticMismatches.push({
      scenarioId: observation.scenario.id,
      path: "$.scenario",
      official: null,
      private: observation.scenario,
      classification: "semantic",
    });
  }
  return {
    status:
      semanticMismatches.length > 0
        ? "semantic-mismatch"
        : expectedPackagingDifferences.length > 0
          ? "expected-packaging-difference"
          : "exact-match",
    exactMatches,
    expectedPackagingDifferences,
    semanticMismatches,
  };
}

export function normalizedSnapshot(
  snapshot: DirectorySnapshot,
  rootToken: string,
): DirectorySnapshot {
  return {
    root: rootToken,
    files: snapshot.files.map((file) => ({ ...file })),
    sha256: sha256(JSON.stringify(snapshot.files)),
  };
}
