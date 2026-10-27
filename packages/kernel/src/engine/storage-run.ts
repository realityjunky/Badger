import type { SkillPackage } from "../skill-runtime/types.js";
import {
  parseRunStateValue,
  RUN_STATE_MAX_BYTES,
  serializeRunState,
} from "./state.js";
import {
  assertRunStorageLayout,
  type RunStorageLayout,
} from "./storage-layout.js";
import {
  readOptionalEngineRunText,
  removeEngineRunFile,
  writeEngineRunText,
} from "./protected-run-file.js";
import type { RunState } from "./types.js";

export function parseStoredRunStateValue(value: unknown): RunState {
  return parseRunStateValue(value);
}

export function startRunWithStorage(
  pkg: SkillPackage,
  runId: string,
  skillHash: string,
  storage: Readonly<RunStorageLayout>,
): RunState {
  assertRunStorageLayout(storage);
  return {
    runId,
    skill: pkg.definition.metadata.name,
    skillVersion: pkg.definition.metadata.version,
    skillHash,
    orchestration: pkg.definition.orchestration.mode,
    currentStep: pkg.definition.orchestration.entry ?? null,
    iteration: 0,
    pending: null,
    pendingRef: storage.pendingRef,
    trajectoryRef: storage.trajectoryRef,
    contextRef: storage.contextRef,
    artifactsRef: storage.artifactsRef,
    checkpointRef: storage.checkpointRef,
    status: "running",
    retries: {},
  };
}

export async function readRunStateAt(
  changeDir: string,
  storage: Readonly<RunStorageLayout>,
): Promise<RunState | null> {
  assertRunStorageLayout(storage);
  const raw = await readOptionalEngineRunText(
    changeDir,
    storage.stateRef,
    RUN_STATE_MAX_BYTES,
    "Run state",
  );
  return raw === null ? null : parseStoredRunStateValue(JSON.parse(raw));
}

export async function writeRunStateAt(
  changeDir: string,
  state: RunState,
  storage: Readonly<RunStorageLayout>,
): Promise<void> {
  assertRunStorageLayout(storage);
  const serialized = serializeRunState(state);
  await writeEngineRunText(
    changeDir,
    storage.stateRef,
    serialized,
    RUN_STATE_MAX_BYTES,
    "Run state",
  );
}

export async function removeRunStateAt(
  changeDir: string,
  storage: Readonly<RunStorageLayout>,
): Promise<void> {
  assertRunStorageLayout(storage);
  await removeEngineRunFile(changeDir, storage.stateRef, "Run state");
}
