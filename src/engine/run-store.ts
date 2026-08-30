import path from "path";

import {
  readOptionalEngineRunText,
  removeEngineRunFile,
  writeEngineRunText,
  type EngineRunReadOptions,
  type EngineRunRemoveOptions,
  type EngineRunWriteOptions,
} from "./protected-run-file.js";
import type { Checkpoint, EngineAction, TrajectoryEvent } from "./types.js";
import type {
  DecisionScalarType,
  WorkflowDecisionChoiceSummary,
  WorkflowDecisionInputField,
  WorkflowDecisionInputSchema,
  WorkflowRationalePolicy,
  WorkflowReviewerPolicy,
} from "../types.js";

const RUN_FILE_LIMITS = {
  trajectory: 8 * 1024 * 1024,
  artifacts: 1024 * 1024,
  context: 1024 * 1024,
  pendingAction: 256 * 1024,
  checkpoint: 256 * 1024,
} as const;

const ACTION_TYPES = new Set<EngineAction["type"]>([
  "invoke_skill",
  "call_tool",
  "handoff",
  "ask_user",
  "checkpoint",
]);

const TRAJECTORY_EVENT_TYPES = new Set<TrajectoryEvent["type"]>([
  "run_started",
  "action_proposed",
  "action_completed",
  "eval_completed",
  "checkpoint",
  "state_migrated",
  "state_transitioned",
  "command_check_recorded",
  "recovery_reconciled",
]);

const ACTION_KEYS = new Set([
  "id",
  "stepId",
  "type",
  "ref",
  "prompt",
  "question",
  "options",
  "decisionId",
  "choices",
  "requiredInputs",
  "rationale",
  "reviewer",
  "attemptId",
  "cycleId",
  "visitOrdinal",
  "retryOrdinal",
]);

const CHECKPOINT_KEYS = new Set([
  "runId",
  "stateVersion",
  "trajectoryOffset",
  "contextHash",
  "artifactsHash",
  "createdAt",
]);

const appendLocks = new Map<string, Promise<void>>();

function assertRunPath(changeDir: string, relativePath: string): string {
  const normalized =
    typeof relativePath === "string" ? relativePath.replaceAll("\\", "/") : "";
  if (
    typeof relativePath !== "string" ||
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(relativePath) ||
    /^(?:[A-Za-z]:|[\\/]|~)/u.test(relativePath) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error("Run path must stay inside the change directory");
  }
  const root = path.resolve(changeDir);
  const target = path.resolve(root, ...normalized.split("/"));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Run path must stay inside the change directory");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, key: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-empty string`);
  }
  return value;
}

function nullableText(
  value: unknown,
  key: string,
  label: string,
): string | null {
  if (value === null) return null;
  return requiredText(value, key, label);
}

function assertKnownFields(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}

function requiredFields(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`Invalid ${label}: ${key} is required`);
    }
  }
}

function nonNegativeInteger(
  value: unknown,
  key: string,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${key} must be a non-negative integer`);
  }
  return value;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function parseAction(value: unknown): EngineAction {
  if (!isRecord(value)) {
    throw new Error(
      "Invalid Run pending action: stored value must be an object",
    );
  }
  assertKnownFields(value, ACTION_KEYS, "Run pending action");
  requiredFields(
    value,
    new Set(["id", "stepId", "type"]),
    "Run pending action",
  );
  const id = requiredText(value.id, "id", "Run pending action");
  const stepId = nullableText(value.stepId, "stepId", "Run pending action");
  if (!ACTION_TYPES.has(value.type as EngineAction["type"])) {
    throw new Error("Invalid Run pending action: type is invalid");
  }

  const action: EngineAction = {
    id,
    stepId,
    type: value.type as EngineAction["type"],
  };
  for (const key of ["ref", "prompt", "question"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      if (typeof value[key] !== "string") {
        throw new Error(`Invalid Run pending action: ${key} must be a string`);
      }
      action[key] = value[key] as string;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "options")) {
    if (
      !Array.isArray(value.options) ||
      value.options.some((option) => typeof option !== "string")
    ) {
      throw new Error(
        "Invalid Run pending action: options must be an array of strings",
      );
    }
    action.options = value.options as string[];
  }
  if (Object.prototype.hasOwnProperty.call(value, "decisionId")) {
    action.decisionId = requiredText(
      value.decisionId,
      "decisionId",
      "Run pending action",
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "choices")) {
    if (!Array.isArray(value.choices)) {
      throw new Error("Invalid Run pending action: choices must be an array");
    }
    action.choices = value.choices.map((choice, index) =>
      parseDecisionChoiceSummary(
        choice,
        `Run pending action choices[${index}]`,
      ),
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "requiredInputs")) {
    action.requiredInputs = parseDecisionInputSchema(
      value.requiredInputs,
      "Run pending action requiredInputs",
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "rationale")) {
    action.rationale = parseRationalePolicy(
      value.rationale,
      "Run pending action rationale",
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "reviewer")) {
    action.reviewer = parseReviewerPolicy(
      value.reviewer,
      "Run pending action reviewer",
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "attemptId")) {
    action.attemptId = requiredText(
      value.attemptId,
      "attemptId",
      "Run pending action",
    );
  }
  if (Object.prototype.hasOwnProperty.call(value, "cycleId")) {
    action.cycleId = nullableText(
      value.cycleId,
      "cycleId",
      "Run pending action",
    );
  }
  for (const key of ["visitOrdinal", "retryOrdinal"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const ordinal = value[key];
    const minimum = key === "visitOrdinal" ? 1 : 0;
    if (
      typeof ordinal !== "number" ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < minimum
    ) {
      throw new Error(
        `Invalid Run pending action: ${key} must be an integer at least ${minimum}`,
      );
    }
    action[key] = ordinal;
  }
  return action;
}

function parseDecisionScalarType(
  value: unknown,
  label: string,
): DecisionScalarType {
  if (value !== "string" && value !== "number" && value !== "boolean") {
    throw new Error(`Invalid ${label}: type is invalid`);
  }
  return value;
}

function parseDecisionInputSchema(
  value: unknown,
  label: string,
): WorkflowDecisionInputSchema {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}: must be an object`);
  }
  assertKnownFields(value, new Set(["type", "fields"]), label);
  if (value.type !== "object") {
    throw new Error(`Invalid ${label}: type must be object`);
  }
  if (!Array.isArray(value.fields)) {
    throw new Error(`Invalid ${label}: fields must be an array`);
  }
  const ids = new Set<string>();
  const fields = value.fields.map((entry, index) => {
    const fieldLabel = `${label}.fields[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`Invalid ${fieldLabel}: must be an object`);
    }
    assertKnownFields(
      entry,
      new Set(["id", "type", "required", "values", "enum"]),
      fieldLabel,
    );
    const id = requiredText(entry.id, "id", fieldLabel);
    if (ids.has(id)) throw new Error(`Invalid ${label}: duplicate field ${id}`);
    ids.add(id);
    const type = parseDecisionScalarType(entry.type, `${fieldLabel}.type`);
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new Error(`Invalid ${fieldLabel}: required must be a boolean`);
    }
    if (entry.values !== undefined && entry.enum !== undefined) {
      throw new Error(`Invalid ${fieldLabel}: values and enum are exclusive`);
    }
    const rawValues = entry.values ?? entry.enum;
    let values: WorkflowDecisionInputField["values"];
    if (rawValues !== undefined) {
      if (!Array.isArray(rawValues) || rawValues.length === 0) {
        throw new Error(`Invalid ${fieldLabel}: values must be non-empty`);
      }
      const seen = new Set<string>();
      values = rawValues.map((rawValue) => {
        const valid =
          (type === "string" && typeof rawValue === "string") ||
          (type === "number" &&
            typeof rawValue === "number" &&
            Number.isFinite(rawValue)) ||
          (type === "boolean" && typeof rawValue === "boolean");
        if (!valid) throw new Error(`Invalid ${fieldLabel}: enum value type`);
        const key = JSON.stringify(rawValue);
        if (seen.has(key))
          throw new Error(`Invalid ${fieldLabel}: duplicate enum value`);
        seen.add(key);
        return rawValue;
      });
    }
    return {
      id,
      type,
      ...(entry.required !== undefined ? { required: entry.required } : {}),
      ...(values
        ? entry.values !== undefined
          ? { values }
          : { enum: values }
        : {}),
    };
  });
  return { type: "object", fields };
}

function parseDecisionChoiceSummary(
  value: unknown,
  label: string,
): WorkflowDecisionChoiceSummary {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, new Set(["id", "label", "requiredInputs"]), label);
  const result: WorkflowDecisionChoiceSummary = {
    id: requiredText(value.id, "id", label),
    label: requiredText(value.label, "label", label),
  };
  if (value.requiredInputs !== undefined) {
    result.requiredInputs = parseDecisionInputSchema(
      value.requiredInputs,
      `${label}.requiredInputs`,
    );
  }
  return result;
}

function parseRationalePolicy(
  value: unknown,
  label: string,
): WorkflowRationalePolicy {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, new Set(["required"]), label);
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return { required: value.required === true };
}

function parseReviewerPolicy(
  value: unknown,
  label: string,
): WorkflowReviewerPolicy {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, new Set(["subjects", "authorities"]), label);
  const result: WorkflowReviewerPolicy = {};
  for (const key of ["subjects", "authorities"] as const) {
    if (value[key] === undefined) continue;
    if (
      !Array.isArray(value[key]) ||
      value[key].some(
        (entry) => typeof entry !== "string" || entry.length === 0,
      )
    ) {
      throw new Error(`Invalid ${label}: ${key} must be a string array`);
    }
    result[key] = [...(value[key] as string[])];
  }
  return result;
}

function parseArtifacts(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error("Invalid Run artifacts: stored value must be an object");
  }
  for (const artifact of Object.values(value)) {
    if (typeof artifact !== "string") {
      throw new Error("Invalid Run artifacts: artifact values must be strings");
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, artifact]) => [key, artifact as string]),
  );
}

function parseCheckpoint(value: unknown): Checkpoint {
  if (!isRecord(value)) {
    throw new Error("Invalid Run checkpoint: stored value must be an object");
  }
  assertKnownFields(value, CHECKPOINT_KEYS, "Run checkpoint");
  requiredFields(value, CHECKPOINT_KEYS, "Run checkpoint");
  const contextHash = nullableText(
    value.contextHash,
    "contextHash",
    "Run checkpoint",
  );
  return {
    runId: requiredText(value.runId, "runId", "Run checkpoint"),
    stateVersion: nonNegativeInteger(
      value.stateVersion,
      "stateVersion",
      "Run checkpoint",
    ),
    trajectoryOffset: nonNegativeInteger(
      value.trajectoryOffset,
      "trajectoryOffset",
      "Run checkpoint",
    ),
    contextHash,
    artifactsHash: requiredText(
      value.artifactsHash,
      "artifactsHash",
      "Run checkpoint",
    ),
    createdAt: requiredText(value.createdAt, "createdAt", "Run checkpoint"),
  };
}

function parseTrajectoryEvent(value: unknown): TrajectoryEvent {
  if (!isRecord(value)) {
    throw new Error("Invalid Run trajectory: stored value must be an object");
  }
  const keys = new Set(["sequence", "timestamp", "type", "runId", "data"]);
  assertKnownFields(value, keys, "Run trajectory");
  requiredFields(value, keys, "Run trajectory");
  if (
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1
  ) {
    throw new Error(
      "Invalid Run trajectory: sequence must be a positive integer",
    );
  }
  if (!TRAJECTORY_EVENT_TYPES.has(value.type as TrajectoryEvent["type"])) {
    throw new Error("Invalid Run trajectory: type is invalid");
  }
  if (!isRecord(value.data)) {
    throw new Error("Invalid Run trajectory: data must be an object");
  }
  return {
    sequence: value.sequence,
    timestamp: requiredText(value.timestamp, "timestamp", "Run trajectory"),
    type: value.type as TrajectoryEvent["type"],
    runId: requiredText(value.runId, "runId", "Run trajectory"),
    data: value.data,
  };
}

function parseTrajectory(raw: string | null): TrajectoryEvent[] {
  if (raw === null) return [];
  const events: TrajectoryEvent[] = [];
  let expectedSequence = 1;
  let runId: string | undefined;
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    let event: TrajectoryEvent;
    try {
      event = parseTrajectoryEvent(JSON.parse(line) as unknown);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid Trajectory event at line ${index + 1}`, {
          cause: error,
        });
      }
      throw new Error(
        `Invalid Trajectory event at line ${index + 1}: ${String(
          error instanceof Error ? error.message : error,
        )}`,
        { cause: error },
      );
    }
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Invalid Trajectory event at line ${index + 1}: sequence must be ${expectedSequence}, got ${event.sequence}`,
      );
    }
    if (runId !== undefined && event.runId !== runId) {
      throw new Error(
        `Invalid Trajectory event at line ${index + 1}: runId must remain ${runId}`,
      );
    }
    runId = event.runId;
    events.push(event);
    expectedSequence += 1;
  }
  return events;
}

function assertNextTrajectoryEvent(
  events: readonly TrajectoryEvent[],
  event: TrajectoryEvent,
): void {
  const expectedSequence = events.length + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(
      `Run trajectory sequence must be ${expectedSequence}, got ${event.sequence}`,
    );
  }
  const last = events.at(-1);
  if (last && last.runId !== event.runId) {
    throw new Error(`Run trajectory runId must remain ${last.runId}`);
  }
}

async function withAppendLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = appendLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  appendLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (appendLocks.get(key) === current) appendLocks.delete(key);
  }
}

export async function appendTrajectory(
  changeDir: string,
  relativePath: string,
  event: TrajectoryEvent,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const normalized = assertRunPath(changeDir, relativePath);
  const key = `${path.resolve(changeDir)}\u0000${normalized}`;
  await withAppendLock(key, async () => {
    const raw = await readOptionalEngineRunText(
      changeDir,
      normalized,
      RUN_FILE_LIMITS.trajectory,
      "Run trajectory",
    );
    const events = parseTrajectory(raw);
    const parsed = parseTrajectoryEvent(event);
    assertNextTrajectoryEvent(events, parsed);
    const prefix =
      raw === null || raw.length === 0 || raw.endsWith("\n")
        ? (raw ?? "")
        : `${raw}\n`;
    const content = `${prefix}${JSON.stringify(parsed)}\n`;
    await writeEngineRunText(
      changeDir,
      normalized,
      content,
      RUN_FILE_LIMITS.trajectory,
      "Run trajectory",
      {
        beforeCommit: async () => {
          await options.beforeCommit?.();
          const latest = parseTrajectory(
            await readOptionalEngineRunText(
              changeDir,
              normalized,
              RUN_FILE_LIMITS.trajectory,
              "Run trajectory",
            ),
          );
          assertNextTrajectoryEvent(latest, parsed);
        },
      },
    );
  });
}

export async function readTrajectory(
  changeDir: string,
  relativePath: string,
  options: EngineRunReadOptions = {},
): Promise<TrajectoryEvent[]> {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.trajectory,
    "Run trajectory",
    options,
  );
  return parseTrajectory(raw);
}

export async function readArtifacts(
  changeDir: string,
  relativePath: string,
  options: EngineRunReadOptions = {},
): Promise<Record<string, string>> {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.artifacts,
    "Run artifacts",
    options,
  );
  return raw === null ? {} : parseArtifacts(parseJson(raw, "Run artifacts"));
}

export async function writeArtifacts(
  changeDir: string,
  relativePath: string,
  artifacts: Record<string, string>,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const normalized = assertRunPath(changeDir, relativePath);
  const parsed = parseArtifacts(artifacts);
  await writeEngineRunText(
    changeDir,
    normalized,
    JSON.stringify(parsed, null, 2) + "\n",
    RUN_FILE_LIMITS.artifacts,
    "Run artifacts",
    options,
  );
}

export async function writeContext(
  changeDir: string,
  relativePath: string,
  context: string,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const normalized = assertRunPath(changeDir, relativePath);
  await writeEngineRunText(
    changeDir,
    normalized,
    context,
    RUN_FILE_LIMITS.context,
    "Run context",
    options,
  );
}

export async function readContext(
  changeDir: string,
  relativePath: string,
  options: EngineRunReadOptions = {},
): Promise<string | null> {
  const normalized = assertRunPath(changeDir, relativePath);
  return readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.context,
    "Run context",
    options,
  );
}

export async function writePendingAction(
  changeDir: string,
  relativePath: string,
  action: EngineAction,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const normalized = assertRunPath(changeDir, relativePath);
  const parsed = parseAction(action);
  await writeEngineRunText(
    changeDir,
    normalized,
    JSON.stringify(parsed, null, 2) + "\n",
    RUN_FILE_LIMITS.pendingAction,
    "Run pending action",
    options,
  );
}

export async function readPendingAction(
  changeDir: string,
  relativePath: string,
  options: EngineRunReadOptions = {},
): Promise<EngineAction | null> {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.pendingAction,
    "Run pending action",
    options,
  );
  return raw === null
    ? null
    : parseAction(parseJson(raw, "Run pending action"));
}

export async function clearPendingAction(
  changeDir: string,
  relativePath: string,
  options: EngineRunRemoveOptions = {},
): Promise<void> {
  const normalized = assertRunPath(changeDir, relativePath);
  await removeEngineRunFile(
    changeDir,
    normalized,
    "Run pending action",
    options,
  );
}

export async function writeCheckpoint(
  changeDir: string,
  relativePath: string,
  checkpoint: Checkpoint,
  options: EngineRunWriteOptions = {},
): Promise<void> {
  const normalized = assertRunPath(changeDir, relativePath);
  const parsed = parseCheckpoint(checkpoint);
  await writeEngineRunText(
    changeDir,
    normalized,
    JSON.stringify(parsed, null, 2) + "\n",
    RUN_FILE_LIMITS.checkpoint,
    "Run checkpoint",
    options,
  );
}

export async function readCheckpoint(
  changeDir: string,
  relativePath: string,
  options: EngineRunReadOptions = {},
): Promise<Checkpoint | null> {
  const normalized = assertRunPath(changeDir, relativePath);
  const raw = await readOptionalEngineRunText(
    changeDir,
    normalized,
    RUN_FILE_LIMITS.checkpoint,
    "Run checkpoint",
    options,
  );
  return raw === null
    ? null
    : parseCheckpoint(parseJson(raw, "Run checkpoint"));
}
