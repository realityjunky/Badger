import path from "path";

export interface RunStorageLayout {
  stateRef: string;
  pendingRef: string;
  trajectoryRef: string;
  contextRef: string;
  artifactsRef: string;
  checkpointRef: string;
  snapshotsRef: string;
}

export const CLASSIC_RUN_STORAGE: Readonly<RunStorageLayout> =
  /* @__PURE__ */ Object.freeze({
    stateRef: ".badger/run-state.json",
    pendingRef: ".badger/pending-action.json",
    trajectoryRef: ".badger/trajectory.jsonl",
    contextRef: ".badger/context.md",
    artifactsRef: ".badger/artifacts.json",
    checkpointRef: ".badger/checkpoint.json",
    snapshotsRef: ".badger/skill-snapshots",
  });

export const NATIVE_RUN_STORAGE: Readonly<RunStorageLayout> =
  /* @__PURE__ */ Object.freeze({
    stateRef: "runtime/run-state.json",
    pendingRef: "runtime/pending-action.json",
    trajectoryRef: "runtime/trajectory.jsonl",
    contextRef: "runtime/context.md",
    artifactsRef: "runtime/artifacts.json",
    checkpointRef: "runtime/checkpoints/latest.json",
    snapshotsRef: "runtime/skill-snapshots",
  });

export function assertRunStorageRef(value: string): void {
  const normalized =
    typeof value === "string" ? value.replaceAll("\\", "/") : "";
  if (
    typeof value !== "string" ||
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    /^(?:[A-Za-z]:|[\\/]|~)/u.test(value) ||
    /[*?]/u.test(value) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error("Run storage ref must stay inside the Run root");
  }
}

export function assertRunStorageLayout(
  storage: Readonly<RunStorageLayout>,
): void {
  const keys: (keyof RunStorageLayout)[] = [
    "stateRef",
    "pendingRef",
    "trajectoryRef",
    "contextRef",
    "artifactsRef",
    "checkpointRef",
    "snapshotsRef",
  ];
  for (const key of keys) assertRunStorageRef(storage[key]);
  const normalizedRefs = keys.map((key) => storage[key].replaceAll("\\", "/"));
  if (new Set(normalizedRefs).size !== keys.length) {
    throw new Error("Run storage refs must be distinct");
  }
}
