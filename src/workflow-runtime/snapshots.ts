import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { inspectProtectedProjectPath } from "../engine/protected-project-path.js";
import { readOptionalEngineRunText } from "../engine/protected-run-file.js";
import type { EngineRunMutationOverlay } from "../engine/protected-run-file.js";
import {
  hasComparableFileObject,
  sameFileObject,
  type FileObjectIdentity,
} from "../engine/file-identity.js";
import {
  snapshotIncompleteFinding,
  snapshotStorageFailedFinding,
  snapshotUnsafeScopeFinding,
  snapshotUnstableFinding,
  type WorkflowFinding,
} from "./findings.js";
import { sha256, stableValue } from "../util.js";
import type {
  WorkflowContentSnapshotEntry,
  WorkflowContentSnapshotLimits,
  WorkflowContentSnapshotManifest,
  WorkflowContentSnapshotOmission,
  WorkflowContentSnapshotOmissionOverflow,
  WorkflowContentSnapshotPolicy,
  WorkflowContentSnapshotProvider,
  WorkflowContentSnapshotReference,
  WorkflowPhysicalSnapshotSelection,
  WorkflowPhysicalSnapshotSelectionStream,
} from "../types.js";

export const WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY = ".comet/content-snapshots";
export const WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_CONTENT_SNAPSHOT_POLICY_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxVisitedNodes: 20_000,
  maxDurationMs: 60_000,
  maxOmissionEntries: 1_000,
} as const satisfies WorkflowContentSnapshotLimits;

const WORKFLOW_CONTENT_SNAPSHOT_HASH_TAG = "workflow-content-snapshot.v1";
const WORKFLOW_CONTENT_SNAPSHOT_POLICY_HASH_TAG =
  "workflow-content-snapshot-policy.v1";
const MAX_SNAPSHOT_PATH_BYTES = 64 * 1024;
const MAX_SELECTION_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_SNAPSHOT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_VISITED_NODES = 1_000_000;
const MAX_SNAPSHOT_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_OMISSION_ENTRIES = 10_000;
const MIN_SNAPSHOT_OMISSION_ENTRIES = 2;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SNAPSHOT_POLICY_KEYS = new Set([
  "schemaVersion",
  "provider",
  "include",
  "exclude",
  "limits",
  "hash",
]);
const SNAPSHOT_LIMIT_KEYS = new Set([
  "maxFiles",
  "maxFileBytes",
  "maxTotalBytes",
  "maxManifestBytes",
  "maxVisitedNodes",
  "maxDurationMs",
  "maxOmissionEntries",
]);
const SNAPSHOT_MANIFEST_KEYS = new Set([
  "schemaVersion",
  "kind",
  "origin",
  "capture",
  "createdAt",
  "complete",
  "policy",
  "limits",
  "entries",
  "omitted",
  "omittedCount",
  "omissionOverflow",
]);
const SNAPSHOT_CAPTURE_KEYS = new Set(["provider", "physicalSelection"]);
const SNAPSHOT_SELECTION_KEYS = new Set([
  "schemaVersion",
  "status",
  "before",
  "after",
]);
const SNAPSHOT_SELECTION_STREAM_KEYS = new Set([
  "hash",
  "visitedNodeCount",
  "recordCount",
  "storedRecordCount",
  "encodedBytes",
  "overflow",
  "unstable",
]);
const SNAPSHOT_ENTRY_KEYS = new Set(["path", "hash", "size", "type"]);
const SNAPSHOT_OMISSION_KEYS = new Set(["path", "size", "type", "reason"]);
const SNAPSHOT_OVERFLOW_KEYS = new Set(["ref", "hash", "count"]);
const PROVIDER: WorkflowContentSnapshotProvider = "physical-tree";
const DEFAULT_PROTECTED_SNAPSHOT_ROOTS = [".comet"] as const;
const INTEGRITY_OMISSION_REASONS = new Set([
  "physical-enumeration-limit",
  "physical-selection-changed",
]);

type SnapshotPatternToken =
  | { kind: "literal"; value: string }
  | { kind: "question" | "star" | "globstar" | "globstar-slash" };

type SnapshotPatternMatcher = (
  relative: string,
  hasBudget?: () => boolean,
) => boolean;

interface ResolvedSnapshotPolicy {
  policy: WorkflowContentSnapshotPolicy;
  includeMatchers: SnapshotPatternMatcher[];
  excludeMatchers: SnapshotPatternMatcher[];
  excludedDirectoryPrefixes: string[];
}

interface SnapshotExecution {
  deadlineAt: number;
  expired: boolean;
}

interface PhysicalSelectionRecord {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
}

interface PhysicalSelectionResult {
  records: PhysicalSelectionRecord[];
  evidence: WorkflowPhysicalSnapshotSelectionStream;
  omissions: WorkflowContentSnapshotOmission[];
}

interface ProtectedSnapshotRoot {
  lexicalPath: string;
  realPath: string | null;
  exists: boolean;
}

interface CapturedFile {
  path: string;
  target: string;
  realPath: string;
  stat: import("node:fs").Stats;
}

export interface WorkflowContentSnapshotPolicyInput {
  provider?: WorkflowContentSnapshotProvider;
  include: readonly string[];
  exclude?: readonly string[];
  limits?: Partial<WorkflowContentSnapshotLimits>;
  hash?: string;
}

export interface WorkflowContentSnapshotHooks {
  afterInitialSelection?: () => void | Promise<void>;
  afterNode?: (relative: string) => void | Promise<void>;
  beforeFileRead?: (relative: string) => void | Promise<void>;
  afterFileRead?: (relative: string) => void | Promise<void>;
}

export interface CaptureWorkflowContentSnapshotOptions {
  root: string;
  policy: WorkflowContentSnapshotPolicy | WorkflowContentSnapshotPolicyInput;
  protectedRoots?: readonly string[];
  now?: Date;
  hooks?: WorkflowContentSnapshotHooks;
}

export interface StageWorkflowContentSnapshotOptions {
  runRoot: string;
  manifest: WorkflowContentSnapshotManifest;
  transition: EngineRunMutationOverlay;
}

export class WorkflowContentSnapshotError extends Error {
  readonly finding: WorkflowFinding;

  constructor(finding: WorkflowFinding, options?: { cause?: unknown }) {
    super(finding.message, options);
    this.name = "WorkflowContentSnapshotError";
    this.finding = finding;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Invalid ${label}: unknown field ${unknown}`);
}

function positiveBound(
  value: unknown,
  key: keyof WorkflowContentSnapshotLimits,
): number {
  const hardMax =
    key === "maxFiles"
      ? MAX_SNAPSHOT_VISITED_NODES
      : key === "maxFileBytes"
        ? MAX_SNAPSHOT_FILE_BYTES
        : key === "maxTotalBytes"
          ? MAX_SNAPSHOT_TOTAL_BYTES
          : key === "maxManifestBytes"
            ? MAX_SNAPSHOT_MANIFEST_BYTES
            : key === "maxVisitedNodes"
              ? MAX_SNAPSHOT_VISITED_NODES
              : key === "maxDurationMs"
                ? MAX_SNAPSHOT_DURATION_MS
                : MAX_SNAPSHOT_OMISSION_ENTRIES;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > hardMax
  ) {
    throw new Error(
      `Invalid Workflow content snapshot limits: ${key} must be a positive bounded integer`,
    );
  }
  if (key === "maxOmissionEntries" && value < MIN_SNAPSHOT_OMISSION_ENTRIES) {
    throw new Error(
      "Invalid Workflow content snapshot limits: maxOmissionEntries must reserve two integrity entries",
    );
  }
  return value;
}

function normalizeSnapshotPattern(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith("~")
  ) {
    throw new Error(`${label} must be a bounded relative pattern`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${label} must not contain empty or traversal segments`);
  }
  if (
    [...value].filter((character) => character === "*" || character === "?")
      .length > 64
  ) {
    throw new Error(`${label} contains too many wildcards`);
  }
  return value;
}

function epsilonClosure(
  tokens: readonly SnapshotPatternToken[],
  positions: ReadonlySet<number>,
  checkpoint?: () => boolean,
): Set<number> | null {
  const closure = new Set(positions);
  const pending = [...positions];
  while (pending.length > 0) {
    if (checkpoint && !checkpoint()) return null;
    const position = pending.pop()!;
    const token = tokens[position];
    if (
      token &&
      (token.kind === "star" ||
        token.kind === "globstar" ||
        token.kind === "globstar-slash") &&
      !closure.has(position + 1)
    ) {
      closure.add(position + 1);
      pending.push(position + 1);
    }
  }
  return closure;
}

function cooperativePatternCheckpoint(hasBudget: () => boolean): () => boolean {
  let operationsUntilCheck = 0;
  return () => {
    if (operationsUntilCheck > 0) {
      operationsUntilCheck -= 1;
      return true;
    }
    if (!hasBudget()) return false;
    operationsUntilCheck = 63;
    return true;
  };
}

function patternTokens(normalized: string): SnapshotPatternToken[] {
  const tokens: SnapshotPatternToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        tokens.push({ kind: "globstar-slash" });
      } else {
        tokens.push({ kind: "globstar" });
      }
    } else if (character === "*") {
      tokens.push({ kind: "star" });
    } else if (character === "?") {
      tokens.push({ kind: "question" });
    } else {
      tokens.push({ kind: "literal", value: character });
    }
  }
  return tokens;
}

function advancePattern(
  tokens: readonly SnapshotPatternToken[],
  positions: ReadonlySet<number>,
  character: string,
): Set<number> | null {
  const next = new Set<number>();
  for (const position of positions) {
    const token = tokens[position];
    if (!token) continue;
    if (token.kind === "literal" && token.value === character) {
      next.add(position + 1);
    } else if (token.kind === "question" && character !== "/") {
      next.add(position + 1);
    } else if (token.kind === "star" && character !== "/") {
      next.add(position);
    } else if (token.kind === "globstar") {
      next.add(position);
    } else if (token.kind === "globstar-slash") {
      next.add(position);
      if (character === "/") next.add(position + 1);
    }
  }
  return epsilonClosure(tokens, next);
}

export function compileWorkflowContentSnapshotPattern(
  pattern: string,
): SnapshotPatternMatcher {
  const normalized = normalizeSnapshotPattern(
    pattern,
    "Workflow content snapshot pattern",
  );
  const tokens = patternTokens(normalized);
  return (relative: string, hasBudget?: () => boolean): boolean => {
    const checkpoint = hasBudget
      ? cooperativePatternCheckpoint(hasBudget)
      : undefined;
    if (checkpoint && !checkpoint()) return false;
    let positions = epsilonClosure(tokens, new Set([0]), checkpoint);
    if (positions === null) return false;
    for (const character of relative) {
      if (checkpoint && !checkpoint()) return false;
      positions = advancePattern(tokens, positions, character);
      if (positions === null || positions.size === 0) return false;
    }
    return (
      epsilonClosure(tokens, positions, checkpoint)?.has(tokens.length) ?? false
    );
  };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalHash(value: unknown, tag: string): string {
  return sha256(`${tag}\n${JSON.stringify(stableValue(value))}`);
}

function policyHashValue(
  policy: Omit<WorkflowContentSnapshotPolicy, "hash">,
): string {
  return canonicalHash(policy, WORKFLOW_CONTENT_SNAPSHOT_POLICY_HASH_TAG);
}

function normalizedLimits(
  limits: Partial<WorkflowContentSnapshotLimits> | undefined,
): WorkflowContentSnapshotLimits {
  if (limits !== undefined) {
    if (!isRecord(limits)) {
      throw new Error("Workflow content snapshot limits must be an object");
    }
    assertKnownFields(
      limits,
      SNAPSHOT_LIMIT_KEYS,
      "Workflow content snapshot limits",
    );
  }
  const value = {
    ...WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS,
    ...(limits ?? {}),
  };
  return {
    maxFiles: positiveBound(value.maxFiles, "maxFiles"),
    maxFileBytes: positiveBound(value.maxFileBytes, "maxFileBytes"),
    maxTotalBytes: positiveBound(value.maxTotalBytes, "maxTotalBytes"),
    maxManifestBytes: positiveBound(value.maxManifestBytes, "maxManifestBytes"),
    maxVisitedNodes: positiveBound(value.maxVisitedNodes, "maxVisitedNodes"),
    maxDurationMs: positiveBound(value.maxDurationMs, "maxDurationMs"),
    maxOmissionEntries: positiveBound(
      value.maxOmissionEntries,
      "maxOmissionEntries",
    ),
  };
}

function normalizedPatterns(
  values: readonly string[],
  label: string,
): string[] {
  return [
    ...new Set(values.map((value) => normalizeSnapshotPattern(value, label))),
  ].sort((left, right) => left.localeCompare(right, "en"));
}

export function createWorkflowContentSnapshotPolicy(
  input: WorkflowContentSnapshotPolicyInput,
): WorkflowContentSnapshotPolicy {
  if (!isRecord(input)) {
    throw new Error("Workflow content snapshot policy must be an object");
  }
  assertKnownFields(
    input,
    new Set(["provider", "include", "exclude", "limits", "hash"]),
    "Workflow content snapshot policy",
  );
  const provider = input.provider ?? PROVIDER;
  if (provider !== PROVIDER) {
    throw new Error(
      `Unsupported Workflow content snapshot provider: ${provider}`,
    );
  }
  const include = normalizedPatterns(
    input.include,
    "Workflow snapshot include",
  );
  if (include.length === 0) {
    throw new Error("Workflow snapshot include must not be empty");
  }
  const exclude = normalizedPatterns(
    input.exclude ?? [],
    "Workflow snapshot exclude",
  );
  const policyWithoutHash: Omit<WorkflowContentSnapshotPolicy, "hash"> = {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_POLICY_SCHEMA_VERSION,
    provider,
    include,
    exclude,
    limits: normalizedLimits(input.limits),
  };
  const hash = policyHashValue(policyWithoutHash);
  if (input.hash !== undefined && input.hash !== hash) {
    throw new Error("Workflow content snapshot policy hash is invalid");
  }
  return { ...policyWithoutHash, hash };
}

export function parseWorkflowContentSnapshotPolicy(
  value: unknown,
): WorkflowContentSnapshotPolicy {
  if (!isRecord(value)) {
    throw new Error(
      "Invalid Workflow content snapshot policy: must be an object",
    );
  }
  assertKnownFields(
    value,
    SNAPSHOT_POLICY_KEYS,
    "Workflow content snapshot policy",
  );
  if (value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_POLICY_SCHEMA_VERSION) {
    throw new Error("Unsupported Workflow content snapshot policy schema");
  }
  if (value.provider !== PROVIDER) {
    throw new Error("Unsupported Workflow content snapshot provider");
  }
  if (!Array.isArray(value.include) || !Array.isArray(value.exclude)) {
    throw new Error("Workflow content snapshot policy patterns must be arrays");
  }
  if (!isRecord(value.limits)) {
    throw new Error(
      "Workflow content snapshot policy limits must be an object",
    );
  }
  assertKnownFields(
    value.limits,
    SNAPSHOT_LIMIT_KEYS,
    "Workflow content snapshot limits",
  );
  const policy = createWorkflowContentSnapshotPolicy({
    provider: PROVIDER,
    include: value.include as string[],
    exclude: value.exclude as string[],
    limits: value.limits as Partial<WorkflowContentSnapshotLimits>,
    hash: typeof value.hash === "string" ? value.hash : undefined,
  });
  if (typeof value.hash !== "string" || !HASH_PATTERN.test(value.hash)) {
    throw new Error("Workflow content snapshot policy hash is invalid");
  }
  return policy;
}

function resolveSnapshotPolicy(
  value: WorkflowContentSnapshotPolicy | WorkflowContentSnapshotPolicyInput,
): ResolvedSnapshotPolicy {
  const policy =
    "hash" in value && value.hash !== undefined
      ? parseWorkflowContentSnapshotPolicy(value)
      : createWorkflowContentSnapshotPolicy(value);
  return {
    policy,
    includeMatchers: policy.include.map(compileWorkflowContentSnapshotPattern),
    excludeMatchers: policy.exclude.map(compileWorkflowContentSnapshotPattern),
    excludedDirectoryPrefixes: policy.exclude
      .flatMap((pattern) => {
        if (!pattern.endsWith("/**")) return [];
        const prefix = pattern.slice(0, -3);
        return /[*?]/u.test(prefix) ? [] : [prefix];
      })
      .sort((left, right) => left.localeCompare(right, "en")),
  };
}

function isIncluded(
  policy: ResolvedSnapshotPolicy,
  relative: string,
  execution?: SnapshotExecution,
): boolean {
  const hasBudget = execution ? () => hasExecutionBudget(execution) : undefined;
  if (!policy.includeMatchers.some((matcher) => matcher(relative, hasBudget))) {
    return false;
  }
  return !policy.excludeMatchers.some((matcher) =>
    matcher(relative, hasBudget),
  );
}

function excludesDirectory(
  policy: ResolvedSnapshotPolicy,
  relative: string,
): boolean {
  return (
    policy.excludedDirectoryPrefixes.includes(relative) ||
    policy.excludeMatchers.some((matcher) => matcher(relative))
  );
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function portableRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function relativePath(value: string, label: string, allowRoot = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_PATH_BYTES ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value.startsWith("~")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (allowRoot && value === ".") return value;
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${label} must be a normalized relative path`);
  }
  return value;
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseSelectionStream(
  value: unknown,
  label: string,
): WorkflowPhysicalSnapshotSelectionStream {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_SELECTION_STREAM_KEYS, label);
  const recordCount = nonNegativeInteger(
    value.recordCount,
    `${label}.recordCount`,
  );
  const storedRecordCount = nonNegativeInteger(
    value.storedRecordCount,
    `${label}.storedRecordCount`,
  );
  const stream = {
    hash: hashValue(value.hash, `${label}.hash`),
    visitedNodeCount: nonNegativeInteger(
      value.visitedNodeCount,
      `${label}.visitedNodeCount`,
    ),
    recordCount,
    storedRecordCount,
    encodedBytes: nonNegativeInteger(
      value.encodedBytes,
      `${label}.encodedBytes`,
    ),
    overflow: value.overflow,
    unstable: value.unstable,
  };
  if (
    typeof stream.overflow !== "boolean" ||
    typeof stream.unstable !== "boolean"
  ) {
    throw new Error(`${label} flags are invalid`);
  }
  if (
    storedRecordCount > recordCount ||
    (!stream.overflow && storedRecordCount !== recordCount)
  ) {
    throw new Error(`${label} record counts are inconsistent`);
  }
  return {
    ...stream,
    overflow: stream.overflow,
    unstable: stream.unstable,
  };
}

function sameSelectionStream(
  left: WorkflowPhysicalSnapshotSelectionStream,
  right: WorkflowPhysicalSnapshotSelectionStream,
): boolean {
  return (
    left.hash === right.hash &&
    left.visitedNodeCount === right.visitedNodeCount &&
    left.recordCount === right.recordCount &&
    left.storedRecordCount === right.storedRecordCount &&
    left.encodedBytes === right.encodedBytes &&
    left.overflow === right.overflow &&
    left.unstable === right.unstable
  );
}

function parsePhysicalSelection(
  value: unknown,
): WorkflowPhysicalSnapshotSelection {
  if (!isRecord(value)) {
    throw new Error("Workflow physical snapshot selection must be an object");
  }
  assertKnownFields(
    value,
    SNAPSHOT_SELECTION_KEYS,
    "Workflow physical snapshot selection",
  );
  if (
    value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported Workflow physical snapshot selection schema");
  }
  if (
    value.status !== "overflow" &&
    value.status !== "changed" &&
    value.status !== "overflow-and-changed"
  ) {
    throw new Error("Workflow physical snapshot selection status is invalid");
  }
  const before = parseSelectionStream(
    value.before,
    "Workflow physical snapshot selection before",
  );
  const after = parseSelectionStream(
    value.after,
    "Workflow physical snapshot selection after",
  );
  const hasOverflow = before.overflow || after.overflow;
  const changed =
    before.unstable || after.unstable || !sameSelectionStream(before, after);
  const expectedStatus =
    hasOverflow && changed
      ? "overflow-and-changed"
      : hasOverflow
        ? "overflow"
        : "changed";
  if (value.status !== expectedStatus) {
    throw new Error(
      "Workflow physical snapshot selection status is inconsistent",
    );
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
    status: expectedStatus,
    before,
    after,
  };
}

function parseEntry(
  value: unknown,
  index: number,
): WorkflowContentSnapshotEntry {
  const label = `Workflow content snapshot entry ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_ENTRY_KEYS, label);
  const entryPath = relativePath(value.path as string, `${label}.path`);
  if (value.type !== "file") throw new Error(`${label}.type is invalid`);
  return {
    path: entryPath,
    hash: hashValue(value.hash, `${label}.hash`),
    size: nonNegativeInteger(value.size, `${label}.size`),
    type: "file",
  };
}

const OMISSION_REASONS = new Set<WorkflowContentSnapshotOmission["reason"]>([
  "file-size",
  "file-count",
  "total-size",
  "manifest-size",
  "changed-during-read",
  "unreadable",
  "non-regular",
  "duration",
  "physical-enumeration-limit",
  "physical-selection-changed",
]);

function parseOmission(
  value: unknown,
  index: number,
): WorkflowContentSnapshotOmission {
  const label = `Workflow content snapshot omission ${index}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_OMISSION_KEYS, label);
  if (
    (value.type !== "file" &&
      value.type !== "directory" &&
      value.type !== "other") ||
    typeof value.reason !== "string" ||
    !OMISSION_REASONS.has(
      value.reason as WorkflowContentSnapshotOmission["reason"],
    )
  ) {
    throw new Error(`${label} fields are invalid`);
  }
  return {
    path: relativePath(value.path as string, `${label}.path`, true),
    size:
      value.size === null
        ? null
        : nonNegativeInteger(value.size, `${label}.size`),
    type: value.type,
    reason: value.reason as WorkflowContentSnapshotOmission["reason"],
  };
}

function parseOverflow(
  value: unknown,
): WorkflowContentSnapshotOmissionOverflow {
  const label = "Workflow content snapshot omission overflow";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_OVERFLOW_KEYS, label);
  const hash = hashValue(value.hash, `${label}.hash`);
  if (value.ref !== `workflow-snapshot://omitted-overflow/${hash}`) {
    throw new Error(`${label}.ref is invalid`);
  }
  const count = nonNegativeInteger(value.count, `${label}.count`);
  if (count < 1) throw new Error(`${label}.count must be positive`);
  return {
    ref: value.ref,
    hash,
    count,
  };
}

function sameLimits(
  left: WorkflowContentSnapshotLimits,
  right: WorkflowContentSnapshotLimits,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

export function parseWorkflowContentSnapshotManifest(
  value: unknown,
): WorkflowContentSnapshotManifest {
  const label = "Workflow content snapshot manifest";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(value, SNAPSHOT_MANIFEST_KEYS, label);
  if (
    value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION ||
    value.kind !== "workflow-content-snapshot" ||
    value.origin !== "explicit"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (!isRecord(value.capture))
    throw new Error(`${label}.capture must be an object`);
  assertKnownFields(value.capture, SNAPSHOT_CAPTURE_KEYS, `${label}.capture`);
  if (value.capture.provider !== PROVIDER) {
    throw new Error(`${label}.capture.provider is invalid`);
  }
  const physicalSelection =
    value.capture.physicalSelection === undefined
      ? undefined
      : parsePhysicalSelection(value.capture.physicalSelection);
  if (
    typeof value.createdAt !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error(`${label}.createdAt is invalid`);
  }
  if (typeof value.complete !== "boolean") {
    throw new Error(`${label}.complete is invalid`);
  }
  const policy = parseWorkflowContentSnapshotPolicy(value.policy);
  if (!isRecord(value.limits))
    throw new Error(`${label}.limits must be an object`);
  assertKnownFields(value.limits, SNAPSHOT_LIMIT_KEYS, `${label}.limits`);
  const limits = normalizedLimits(
    value.limits as Partial<WorkflowContentSnapshotLimits>,
  );
  if (!sameLimits(limits, policy.limits)) {
    throw new Error(`${label}.limits does not match policy`);
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.omitted)) {
    throw new Error(`${label}.entries and omissions must be arrays`);
  }
  const entries = value.entries.map(parseEntry);
  const omitted = value.omitted.map(parseOmission);
  const omissionKeys = new Set<string>();
  for (const omission of omitted) {
    const key = snapshotIdentityOmissionKey(omission);
    if (omissionKeys.has(key)) {
      throw new Error(`${label}.omitted contains duplicate entries`);
    }
    omissionKeys.add(key);
  }
  if (
    entries.some(
      (entry, index) =>
        index > 0 &&
        entries[index - 1]!.path.localeCompare(entry.path, "en") >= 0,
    ) ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  ) {
    throw new Error(`${label}.entries are not canonical`);
  }
  if (
    omitted.some(
      (omission, index) =>
        index > 0 &&
        snapshotOmissionSortKey(omitted[index - 1]!).localeCompare(
          snapshotOmissionSortKey(omission),
          "en",
        ) > 0,
    )
  ) {
    throw new Error(`${label}.omitted is not canonical`);
  }
  const omittedCount = nonNegativeInteger(
    value.omittedCount,
    `${label}.omittedCount`,
  );
  const omissionOverflow =
    value.omissionOverflow === undefined
      ? undefined
      : parseOverflow(value.omissionOverflow);
  const overflowCount = omittedCount - omitted.length;
  if (
    omitted.length > limits.maxOmissionEntries ||
    overflowCount < 0 ||
    (overflowCount === 0 && omissionOverflow !== undefined) ||
    (overflowCount > 0 && omissionOverflow?.count !== overflowCount)
  ) {
    throw new Error(`${label}.omissionOverflow is inconsistent`);
  }
  if (entries.length > limits.maxFiles) {
    throw new Error(`${label} exceeds its file-count limit`);
  }
  if (
    entries.some((entry) => entry.size > limits.maxFileBytes) ||
    entries.reduce((total, entry) => total + entry.size, 0) >
      limits.maxTotalBytes
  ) {
    throw new Error(`${label} exceeds its byte limits`);
  }
  if (value.complete !== (omittedCount === 0)) {
    throw new Error(`${label}.complete is inconsistent`);
  }
  const physicalEnumerationOmission = omitted.filter(
    (omission) => omission.reason === "physical-enumeration-limit",
  );
  const physicalChangedOmission = omitted.filter(
    (omission) => omission.reason === "physical-selection-changed",
  );
  for (const omission of [
    ...physicalEnumerationOmission,
    ...physicalChangedOmission,
  ]) {
    if (
      omission.path !== "." ||
      omission.type !== "directory" ||
      omission.size !== null
    ) {
      throw new Error(`${label} physical selection omissions are invalid`);
    }
  }
  if (
    physicalEnumerationOmission.length > 1 ||
    physicalChangedOmission.length > 1
  ) {
    throw new Error(`${label} physical selection omissions are duplicated`);
  }
  if (
    physicalSelection === undefined &&
    (physicalEnumerationOmission.length > 0 ||
      physicalChangedOmission.length > 0)
  ) {
    throw new Error(`${label} physical selection evidence is missing`);
  }
  if (physicalSelection !== undefined) {
    const hasOverflow =
      physicalSelection.status === "overflow" ||
      physicalSelection.status === "overflow-and-changed";
    const hasChanged =
      physicalSelection.status === "changed" ||
      physicalSelection.status === "overflow-and-changed";
    if (
      hasOverflow !== (physicalEnumerationOmission.length === 1) ||
      hasChanged !== (physicalChangedOmission.length === 1)
    ) {
      throw new Error(`${label} physical selection evidence is inconsistent`);
    }
  }
  if (
    Buffer.byteLength(
      canonicalJson({
        schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
        kind: "workflow-content-snapshot",
        origin: "explicit",
        capture: {
          provider: PROVIDER,
          ...(physicalSelection ? { physicalSelection } : {}),
        },
        createdAt: value.createdAt,
        complete: value.complete,
        policy,
        limits,
        entries,
        omitted,
        omittedCount,
        ...(omissionOverflow ? { omissionOverflow } : {}),
      }),
      "utf8",
    ) > limits.maxManifestBytes
  ) {
    throw new Error(`${label} exceeds its manifest byte limit`);
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot",
    origin: "explicit",
    capture: {
      provider: PROVIDER,
      ...(physicalSelection ? { physicalSelection } : {}),
    },
    createdAt: value.createdAt,
    complete: value.complete,
    policy,
    limits,
    entries,
    omitted,
    omittedCount,
    ...(omissionOverflow ? { omissionOverflow } : {}),
  };
}

function snapshotIdentityProjection(
  manifest: WorkflowContentSnapshotManifest,
): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    origin: manifest.origin,
    capture: manifest.capture,
    complete: manifest.complete,
    policy: manifest.policy,
    limits: manifest.limits,
    entries: manifest.entries,
    omitted: manifest.omitted,
    omittedCount: manifest.omittedCount,
    ...(manifest.omissionOverflow
      ? { omissionOverflow: manifest.omissionOverflow }
      : {}),
  };
}

export function hashWorkflowContentSnapshot(
  value: WorkflowContentSnapshotManifest,
): string {
  const manifest = parseWorkflowContentSnapshotManifest(value);
  return canonicalHash(
    snapshotIdentityProjection(manifest),
    WORKFLOW_CONTENT_SNAPSHOT_HASH_TAG,
  );
}

function snapshotPathForHash(hash: string): string {
  return `${WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY}/${hash}.json`;
}

export function parseWorkflowContentSnapshotReference(
  value: unknown,
  label = "Workflow content snapshot reference",
): WorkflowContentSnapshotReference {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set(["schemaVersion", "kind", "hash", "path", "provider", "complete"]),
    label,
  );
  const hash = hashValue(value.hash, `${label}.hash`);
  if (
    value.schemaVersion !== WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION ||
    value.kind !== "workflow-content-snapshot-reference" ||
    value.path !== snapshotPathForHash(hash) ||
    value.provider !== PROVIDER ||
    typeof value.complete !== "boolean"
  ) {
    throw new Error(`${label} identity is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot-reference",
    hash,
    path: snapshotPathForHash(hash),
    provider: PROVIDER,
    complete: value.complete,
  };
}

function referenceFor(
  manifest: WorkflowContentSnapshotManifest,
): WorkflowContentSnapshotReference {
  const hash = hashWorkflowContentSnapshot(manifest);
  return {
    schemaVersion: 1,
    kind: "workflow-content-snapshot-reference",
    hash,
    path: snapshotPathForHash(hash),
    provider: manifest.capture.provider,
    complete: manifest.complete,
  };
}

function createExecution(
  limits: WorkflowContentSnapshotLimits,
): SnapshotExecution {
  return { deadlineAt: Date.now() + limits.maxDurationMs, expired: false };
}

function hasExecutionBudget(execution: SnapshotExecution): boolean {
  if (execution.expired) return false;
  if (Date.now() < execution.deadlineAt) return true;
  execution.expired = true;
  return false;
}

function fileIdentity(stat: import("node:fs").Stats): FileObjectIdentity {
  return { dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs };
}

function sameStat(
  left: import("node:fs").Stats,
  right: import("node:fs").Stats,
): boolean {
  const leftIdentity = fileIdentity(left);
  const rightIdentity = fileIdentity(right);
  const sameObject = hasComparableFileObject(leftIdentity, rightIdentity)
    ? sameFileObject(leftIdentity, rightIdentity)
    : sameFileObject(leftIdentity, rightIdentity) &&
      left.birthtimeMs === right.birthtimeMs &&
      left.ctimeMs === right.ctimeMs &&
      left.size === right.size;
  return (
    sameObject &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isUnreadable(error: unknown): boolean {
  return ["EACCES", "EPERM"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  );
}

function isMissing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  );
}

function isScopePath(
  protectedRoot: ProtectedSnapshotRoot,
  target: string,
): boolean {
  return (
    isInside(protectedRoot.lexicalPath, target) ||
    (protectedRoot.realPath !== null &&
      isInside(protectedRoot.realPath, target))
  );
}

async function resolveRoot(
  root: string,
): Promise<{ lexical: string; real: string }> {
  if (typeof root !== "string" || root.length === 0) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding("Workflow content snapshot root is invalid"),
    );
  }
  const lexical = path.resolve(root);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(lexical);
  } catch (error) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding(
        "Workflow content snapshot root is unavailable",
      ),
      { cause: error },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding(
        "Workflow content snapshot root must be a real directory",
      ),
    );
  }
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch (error) {
    throw new WorkflowContentSnapshotError(
      snapshotUnsafeScopeFinding(
        "Workflow content snapshot root cannot be resolved",
      ),
      { cause: error },
    );
  }
  return { lexical, real };
}

async function resolveProtectedRoots(
  root: { lexical: string; real: string },
  values: readonly string[],
): Promise<ProtectedSnapshotRoot[]> {
  const result: ProtectedSnapshotRoot[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot exclusion is invalid",
        ),
      );
    }
    const lexicalPath = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(root.lexical, value);
    if (lexicalPath === root.lexical) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot exclusion cannot be the declared root",
        ),
      );
    }
    if (!isInside(root.lexical, lexicalPath)) {
      if (!path.isAbsolute(value)) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot exclusion must stay inside the root",
          ),
        );
      }
      continue;
    }
    let realPath: string | null = null;
    let exists = false;
    try {
      const stat = await fs.lstat(lexicalPath);
      exists = true;
      if (stat.isSymbolicLink()) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot exclusion cannot be a symbolic link",
          ),
        );
      }
      realPath = await fs.realpath(lexicalPath);
      if (!isInside(root.real, realPath)) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot exclusion resolves outside the root",
          ),
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    result.push({ lexicalPath, realPath, exists });
  }
  return result;
}

function scopeOverlapsProtectedRoot(
  root: string,
  protectedRoot: ProtectedSnapshotRoot,
  policy: ResolvedSnapshotPolicy,
): boolean {
  const relative = portableRelative(root, protectedRoot.lexicalPath);
  if (!protectedRoot.exists || !relative || relative.startsWith(".."))
    return false;
  const canMatch = (pattern: string): boolean => {
    const tokens = patternTokens(pattern);
    const consume = (value: string): Set<number> | null => {
      let positions = epsilonClosure(tokens, new Set([0]));
      if (positions === null) return null;
      for (const character of value) {
        positions = advancePattern(tokens, positions, character);
        if (positions === null || positions.size === 0) return null;
      }
      return positions;
    };
    if (consume(relative)?.has(tokens.length)) return true;
    const initial = consume(`${relative}/`);
    if (initial === null) return false;
    const literalCharacters = tokens
      .filter(
        (token): token is { kind: "literal"; value: string } =>
          token.kind === "literal" && token.value !== "/",
      )
      .map((token) => token.value);
    const characters = [...new Set(["/", "x", ...literalCharacters])];
    const queue = [initial];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const positions = queue.shift()!;
      const key = [...positions].sort((left, right) => left - right).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      if (positions.has(tokens.length)) return true;
      for (const character of characters) {
        const next = advancePattern(tokens, positions, character);
        if (next && next.size > 0) queue.push(next);
      }
    }
    return false;
  };
  return policy.policy.include.some(canMatch);
}

function selectionHash(records: readonly PhysicalSelectionRecord[]): string {
  const canonical = records
    .map((record) => `${record.type}\u0000${record.path}`)
    .sort((left, right) => left.localeCompare(right, "en"))
    .join("\n");
  return sha256(`workflow-physical-selection.v1\n${canonical}`);
}

function selectionEvidence(
  records: readonly PhysicalSelectionRecord[],
  visitedNodeCount: number,
  encodedBytes: number,
  overflow: boolean,
  unstable: boolean,
  limits: WorkflowContentSnapshotLimits,
): WorkflowPhysicalSnapshotSelectionStream {
  return {
    hash: overflow
      ? sha256(
          `workflow-physical-selection-incomplete.v1\n${JSON.stringify({
            maxVisitedNodes: limits.maxVisitedNodes,
            maxSelectionBytes: MAX_SELECTION_BYTES,
          })}`,
        )
      : selectionHash(records),
    visitedNodeCount,
    recordCount: records.length,
    storedRecordCount: overflow ? 0 : records.length,
    encodedBytes,
    overflow,
    unstable,
  };
}

async function enumeratePhysicalTree(options: {
  root: { lexical: string; real: string };
  policy: ResolvedSnapshotPolicy;
  protectedRoots: readonly ProtectedSnapshotRoot[];
  execution: SnapshotExecution;
  hooks?: WorkflowContentSnapshotHooks;
}): Promise<PhysicalSelectionResult> {
  const records: PhysicalSelectionRecord[] = [];
  const omissions: WorkflowContentSnapshotOmission[] = [];
  let visitedNodeCount = 0;
  let encodedBytes = 0;
  let overflow = false;
  let unstable = false;
  let stopped = false;

  const addRecord = (record: PhysicalSelectionRecord): void => {
    const encoded = Buffer.byteLength(
      `${record.type}\u0000${record.path}`,
      "utf8",
    );
    if (
      Buffer.byteLength(record.path, "utf8") > MAX_SNAPSHOT_PATH_BYTES ||
      encodedBytes + encoded > MAX_SELECTION_BYTES
    ) {
      overflow = true;
      stopped = true;
      return;
    }
    records.push(record);
    encodedBytes += encoded;
  };

  const visit = async (
    directory: string,
    relativeDirectory: string,
    expected?: {
      stat: import("node:fs").Stats;
      realPath: string;
    },
  ): Promise<void> => {
    if (stopped || !hasExecutionBudget(options.execution)) return;
    if (expected) {
      let current: import("node:fs").Stats;
      let currentRealPath: string;
      try {
        current = await fs.lstat(directory);
        currentRealPath = await fs.realpath(directory);
      } catch (error) {
        if (!hasExecutionBudget(options.execution)) return;
        if (!isUnreadable(error) && !isMissing(error)) throw error;
        unstable ||= isMissing(error);
        omissions.push({
          path: relativeDirectory || ".",
          size: null,
          type: "directory",
          reason: isUnreadable(error) ? "unreadable" : "changed-during-read",
        });
        return;
      }
      if (!isInside(options.root.real, currentRealPath)) {
        throw new WorkflowContentSnapshotError(
          snapshotUnsafeScopeFinding(
            "Workflow content snapshot directory escapes its declared root",
          ),
        );
      }
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        currentRealPath !== expected.realPath ||
        !sameStat(expected.stat, current)
      ) {
        unstable = true;
        omissions.push({
          path: relativeDirectory || ".",
          size: null,
          type: "directory",
          reason: "changed-during-read",
        });
        return;
      }
    }
    let handle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      handle = await fs.opendir(directory);
    } catch (error) {
      if (!hasExecutionBudget(options.execution)) return;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      unstable ||= isMissing(error);
      omissions.push({
        path: relativeDirectory || ".",
        size: null,
        type: "directory",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read",
      });
      return;
    }
    const children: Array<{
      target: string;
      relative: string;
      stat: import("node:fs").Stats;
      type: PhysicalSelectionRecord["type"];
      realPath: string;
    }> = [];
    try {
      while (!stopped && hasExecutionBudget(options.execution)) {
        let child: import("node:fs").Dirent | null;
        try {
          child = await handle.read();
        } catch (error) {
          if (!hasExecutionBudget(options.execution)) break;
          if (!isUnreadable(error) && !isMissing(error)) throw error;
          unstable ||= isMissing(error);
          omissions.push({
            path: relativeDirectory || ".",
            size: null,
            type: "directory",
            reason: isUnreadable(error) ? "unreadable" : "changed-during-read",
          });
          break;
        }
        if (!hasExecutionBudget(options.execution) || child === null) break;
        visitedNodeCount += 1;
        if (visitedNodeCount > options.policy.policy.limits.maxVisitedNodes) {
          overflow = true;
          stopped = true;
          break;
        }
        const target = path.join(directory, child.name);
        const relative = portableRelative(options.root.lexical, target);
        if (
          !relative ||
          relative.startsWith("..") ||
          relative.includes("/../")
        ) {
          throw new WorkflowContentSnapshotError(
            snapshotUnsafeScopeFinding(
              "Workflow content snapshot discovered an unsafe path",
            ),
          );
        }
        if (
          options.protectedRoots.some((protectedRoot) =>
            isScopePath(protectedRoot, target),
          )
        ) {
          continue;
        }
        if (
          child.isDirectory() &&
          excludesDirectory(options.policy, relative)
        ) {
          continue;
        }
        let stat: import("node:fs").Stats;
        try {
          stat = await fs.lstat(target);
        } catch (error) {
          if (!hasExecutionBudget(options.execution)) break;
          if (!isUnreadable(error) && !isMissing(error)) throw error;
          unstable ||= isMissing(error);
          if (isIncluded(options.policy, relative, options.execution)) {
            addRecord({ path: relative, type: "other" });
            omissions.push({
              path: relative,
              size: null,
              type: "other",
              reason: isUnreadable(error)
                ? "unreadable"
                : "changed-during-read",
            });
          }
          await options.hooks?.afterNode?.(relative);
          continue;
        }
        const type: PhysicalSelectionRecord["type"] = stat.isDirectory()
          ? "directory"
          : stat.isSymbolicLink()
            ? "symlink"
            : stat.isFile()
              ? "file"
              : "other";
        let realDirectory = "";
        if (type === "directory") {
          try {
            realDirectory = await fs.realpath(target);
          } catch (error) {
            if (!hasExecutionBudget(options.execution)) break;
            if (!isUnreadable(error) && !isMissing(error)) throw error;
            unstable ||= isMissing(error);
            addRecord({ path: relative, type });
            omissions.push({
              path: relative,
              size: null,
              type: "directory",
              reason: isUnreadable(error)
                ? "unreadable"
                : "changed-during-read",
            });
            await options.hooks?.afterNode?.(relative);
            continue;
          }
          if (
            !isInside(options.root.real, realDirectory) ||
            options.protectedRoots.some(
              (protectedRoot) =>
                protectedRoot.realPath !== null &&
                isInside(protectedRoot.realPath, realDirectory),
            )
          ) {
            throw new WorkflowContentSnapshotError(
              snapshotUnsafeScopeFinding(
                "Workflow content snapshot directory escapes its declared root",
              ),
            );
          }
          addRecord({ path: relative, type });
        } else if (isIncluded(options.policy, relative, options.execution)) {
          addRecord({ path: relative, type });
        }
        if (!stopped) {
          children.push({
            target,
            relative,
            stat,
            type,
            realPath: realDirectory,
          });
          await options.hooks?.afterNode?.(relative);
        }
      }
    } finally {
      await handle.close().catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED")
          throw error;
      });
    }
    if (stopped || !hasExecutionBudget(options.execution)) return;
    children.sort((left, right) =>
      left.relative.localeCompare(right.relative, "en"),
    );
    for (const child of children) {
      if (stopped || !hasExecutionBudget(options.execution)) return;
      if (child.type !== "directory") continue;
      if (excludesDirectory(options.policy, child.relative)) continue;
      await visit(child.target, child.relative, {
        stat: child.stat,
        realPath: child.realPath,
      });
    }
  };

  await visit(options.root.lexical, "");
  if (options.execution.expired) overflow = true;
  const evidence = selectionEvidence(
    records,
    visitedNodeCount,
    encodedBytes,
    overflow,
    unstable,
    options.policy.policy.limits,
  );
  return { records, evidence, omissions };
}

async function hashFileBounded(
  target: string,
  before: import("node:fs").Stats,
  limits: WorkflowContentSnapshotLimits,
  execution: SnapshotExecution,
): Promise<
  | {
      status: "complete";
      hash: string;
      stat: import("node:fs").Stats;
      realPath: string;
    }
  | { status: "changed" | "duration" | "unreadable" }
> {
  if (!hasExecutionBudget(execution)) return { status: "duration" };
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(target, flags);
  } catch (error) {
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      return { status: "changed" };
    if (isUnreadable(error)) return { status: "unreadable" };
    if (isMissing(error)) return { status: "changed" };
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    const openedRealPath = await fs.realpath(target);
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (!opened.isFile() || !sameStat(before, opened))
      return { status: "changed" };
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, limits.maxFileBytes + 1),
    );
    let bytes = 0;
    while (true) {
      if (!hasExecutionBudget(execution)) return { status: "duration" };
      const remaining = limits.maxFileBytes + 1 - bytes;
      if (remaining < 1) return { status: "changed" };
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, remaining),
        null,
      );
      if (!hasExecutionBudget(execution)) return { status: "duration" };
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > limits.maxFileBytes) return { status: "changed" };
      digest.update(buffer.subarray(0, result.bytesRead));
    }
    const finalHandle = await handle.stat();
    const finalPath = await fs.lstat(target);
    const finalRealPath = await fs.realpath(target);
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (
      !finalHandle.isFile() ||
      !finalPath.isFile() ||
      !sameStat(opened, finalHandle) ||
      !sameStat(before, finalPath) ||
      finalRealPath !== openedRealPath ||
      bytes !== before.size
    ) {
      return { status: "changed" };
    }
    return {
      status: "complete",
      hash: digest.digest("hex"),
      stat: finalPath,
      realPath: finalRealPath,
    };
  } catch (error) {
    if (!hasExecutionBudget(execution)) return { status: "duration" };
    if (isUnreadable(error)) return { status: "unreadable" };
    if (isMissing(error)) return { status: "changed" };
    throw error;
  } finally {
    await handle.close();
  }
}

function snapshotIdentityOmissionKey(
  value: WorkflowContentSnapshotOmission,
): string {
  return `${value.path}\u0000${value.type}\u0000${value.reason}\u0000${value.size ?? ""}`;
}

function snapshotOmissionSortKey(
  value: WorkflowContentSnapshotOmission,
): string {
  return `${value.path}\u0000${value.reason}\u0000${value.type}\u0000${value.size ?? ""}`;
}

function physicalSelectionEvidence(
  before: WorkflowPhysicalSnapshotSelectionStream,
  after: WorkflowPhysicalSnapshotSelectionStream,
): WorkflowPhysicalSnapshotSelection | null {
  const hasOverflow = before.overflow || after.overflow;
  const changed =
    before.unstable || after.unstable || !sameSelectionStream(before, after);
  if (!hasOverflow && !changed) return null;
  return {
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SELECTION_SCHEMA_VERSION,
    status:
      hasOverflow && changed
        ? "overflow-and-changed"
        : hasOverflow
          ? "overflow"
          : "changed",
    before,
    after,
  };
}

function snapshotIdentityPath(value: string): string {
  if (!HASH_PATTERN.test(value))
    throw new Error("Workflow snapshot hash is invalid");
  return snapshotPathForHash(value);
}

export function workflowContentSnapshotFindings(
  value: WorkflowContentSnapshotManifest,
): WorkflowFinding[] {
  const manifest = parseWorkflowContentSnapshotManifest(value);
  const unstable = manifest.omitted.some((omission) =>
    ["changed-during-read", "duration", "physical-selection-changed"].includes(
      omission.reason,
    ),
  );
  const findings: WorkflowFinding[] = [];
  if (unstable) {
    findings.push(
      snapshotUnstableFinding(
        "Workflow content snapshot selection or content changed during capture.",
      ),
    );
  }
  if (!manifest.complete) {
    findings.push(
      snapshotIncompleteFinding(
        "Workflow content snapshot is incomplete and cannot satisfy a complete-scope requirement.",
      ),
    );
  }
  return findings;
}

async function captureWorkflowContentSnapshotInternal(
  options: CaptureWorkflowContentSnapshotOptions,
): Promise<WorkflowContentSnapshotManifest> {
  const policy = resolveSnapshotPolicy(options.policy);
  const root = await resolveRoot(options.root);
  const protectedRoots = await resolveProtectedRoots(
    root,
    options.protectedRoots ?? [],
  );
  for (const protectedRoot of protectedRoots) {
    if (scopeOverlapsProtectedRoot(root.lexical, protectedRoot, policy)) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot scope overlaps a protected repository exclusion.",
        ),
      );
    }
  }
  const execution = createExecution(policy.policy.limits);
  const before = await enumeratePhysicalTree({
    root,
    policy,
    protectedRoots,
    execution,
    hooks: options.hooks,
  });
  await options.hooks?.afterInitialSelection?.();
  const entries: WorkflowContentSnapshotEntry[] = [];
  const captured: CapturedFile[] = [];
  const omitted: WorkflowContentSnapshotOmission[] = [];
  const omissionKeys = new Set<string>();
  let omittedCount = 0;
  let overflowCount = 0;
  let overflowHash = sha256("workflow-content-snapshot-omission-overflow.v1");
  let totalBytes = 0;

  const foldOverflow = (value: unknown): void => {
    overflowCount += 1;
    overflowHash = sha256(
      `${overflowHash}\n${JSON.stringify(stableValue(value))}`,
    );
  };
  const omit = (value: WorkflowContentSnapshotOmission): void => {
    const key = snapshotIdentityOmissionKey(value);
    if (omissionKeys.has(key)) return;
    omissionKeys.add(key);
    omittedCount += 1;
    if (omitted.length < policy.policy.limits.maxOmissionEntries) {
      omitted.push(value);
      return;
    }
    if (INTEGRITY_OMISSION_REASONS.has(value.reason)) {
      const displacedIndex = omitted.findIndex(
        (candidate) => !INTEGRITY_OMISSION_REASONS.has(candidate.reason),
      );
      if (displacedIndex >= 0) {
        const [displaced] = omitted.splice(displacedIndex, 1);
        if (displaced) foldOverflow(displaced);
        omitted.push(value);
        return;
      }
    }
    foldOverflow(value);
  };

  for (const omission of before.omissions) omit(omission);
  const records = [...before.records].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  for (const record of records) {
    if (!hasExecutionBudget(execution)) break;
    if (record.type !== "file") {
      if (record.type === "symlink" || record.type === "other") {
        omit({
          path: record.path,
          size: null,
          type: "other",
          reason: "non-regular",
        });
      }
      continue;
    }
    const target = path.resolve(root.lexical, ...record.path.split("/"));
    let beforeStat: import("node:fs").Stats;
    try {
      beforeStat = await fs.lstat(target);
    } catch (error) {
      if (!hasExecutionBudget(execution)) break;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      omit({
        path: record.path,
        size: null,
        type: "file",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read",
      });
      continue;
    }
    if (!beforeStat.isFile() || beforeStat.isSymbolicLink()) {
      omit({
        path: record.path,
        size: null,
        type: "other",
        reason: "non-regular",
      });
      continue;
    }
    if (entries.length >= policy.policy.limits.maxFiles) {
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: "file-count",
      });
      continue;
    }
    if (beforeStat.size > policy.policy.limits.maxFileBytes) {
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: "file-size",
      });
      continue;
    }
    if (totalBytes + beforeStat.size > policy.policy.limits.maxTotalBytes) {
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: "total-size",
      });
      continue;
    }
    let realPath: string;
    try {
      realPath = await fs.realpath(target);
    } catch (error) {
      if (!hasExecutionBudget(execution)) break;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      omit({
        path: record.path,
        size: beforeStat.size,
        type: "file",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read",
      });
      continue;
    }
    if (
      !isInside(root.real, realPath) ||
      protectedRoots.some(
        (protectedRoot) =>
          protectedRoot.realPath !== null &&
          isInside(protectedRoot.realPath, realPath),
      )
    ) {
      throw new WorkflowContentSnapshotError(
        snapshotUnsafeScopeFinding(
          "Workflow content snapshot file escapes its declared root",
        ),
      );
    }
    await options.hooks?.beforeFileRead?.(record.path);
    const hashed = await hashFileBounded(
      target,
      beforeStat,
      policy.policy.limits,
      execution,
    );
    await options.hooks?.afterFileRead?.(record.path);
    if (hashed.status !== "complete") {
      omit({
        path: record.path,
        size: hashed.status === "duration" ? beforeStat.size : null,
        type: "file",
        reason:
          hashed.status === "duration"
            ? "duration"
            : hashed.status === "unreadable"
              ? "unreadable"
              : "changed-during-read",
      });
      if (hashed.status === "duration") break;
      continue;
    }
    entries.push({
      path: record.path,
      hash: hashed.hash,
      size: hashed.stat.size,
      type: "file",
    });
    totalBytes += hashed.stat.size;
    captured.push({
      path: record.path,
      target,
      realPath,
      stat: hashed.stat,
    });
  }

  for (const capturedFile of captured) {
    if (!hasExecutionBudget(execution)) break;
    let current: import("node:fs").Stats;
    let currentRealPath: string;
    try {
      current = await fs.lstat(capturedFile.target);
      currentRealPath = await fs.realpath(capturedFile.target);
    } catch (error) {
      if (!hasExecutionBudget(execution)) break;
      if (!isUnreadable(error) && !isMissing(error)) throw error;
      const entry = entries.find(
        (candidate) => candidate.path === capturedFile.path,
      );
      if (entry) {
        entries.splice(entries.indexOf(entry), 1);
        totalBytes -= entry.size;
      }
      omit({
        path: capturedFile.path,
        size: null,
        type: "file",
        reason: isUnreadable(error) ? "unreadable" : "changed-during-read",
      });
      continue;
    }
    if (
      !current.isFile() ||
      currentRealPath !== capturedFile.realPath ||
      !sameStat(capturedFile.stat, current)
    ) {
      const entry = entries.find(
        (candidate) => candidate.path === capturedFile.path,
      );
      if (entry) {
        entries.splice(entries.indexOf(entry), 1);
        totalBytes -= entry.size;
      }
      omit({
        path: capturedFile.path,
        size: current.isFile() ? current.size : null,
        type: current.isFile() ? "file" : "other",
        reason: "changed-during-read",
      });
    }
  }

  let after: PhysicalSelectionResult;
  if (hasExecutionBudget(execution)) {
    after = await enumeratePhysicalTree({
      root,
      policy,
      protectedRoots,
      execution,
    });
    for (const omission of after.omissions) omit(omission);
  } else {
    after = {
      records: [],
      evidence: selectionEvidence([], 0, 0, true, true, policy.policy.limits),
      omissions: [],
    };
  }
  const selection = physicalSelectionEvidence(before.evidence, after.evidence);
  if (
    before.evidence.overflow ||
    after.evidence.overflow ||
    execution.expired
  ) {
    omit({
      path: ".",
      size: null,
      type: "directory",
      reason: "physical-enumeration-limit",
    });
  }
  if (
    selection &&
    (selection.status === "changed" ||
      selection.status === "overflow-and-changed")
  ) {
    omit({
      path: ".",
      size: null,
      type: "directory",
      reason: "physical-selection-changed",
    });
  }
  if (execution.expired) {
    omit({ path: ".", size: null, type: "directory", reason: "duration" });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  omitted.sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path, "en");
    return pathOrder !== 0
      ? pathOrder
      : snapshotOmissionSortKey(left).localeCompare(
          snapshotOmissionSortKey(right),
          "en",
        );
  });
  const buildManifest = (): WorkflowContentSnapshotManifest => ({
    schemaVersion: WORKFLOW_CONTENT_SNAPSHOT_SCHEMA_VERSION,
    kind: "workflow-content-snapshot",
    origin: "explicit",
    capture: {
      provider: PROVIDER,
      ...(selection ? { physicalSelection: selection } : {}),
    },
    createdAt: (options.now ?? new Date()).toISOString(),
    complete: omittedCount === 0,
    policy: policy.policy,
    limits: policy.policy.limits,
    entries,
    omitted,
    omittedCount,
    ...(overflowCount > 0
      ? {
          omissionOverflow: {
            ref: `workflow-snapshot://omitted-overflow/${overflowHash}`,
            hash: overflowHash,
            count: overflowCount,
          },
        }
      : {}),
  });
  let manifest = buildManifest();
  while (
    Buffer.byteLength(canonicalJson(manifest), "utf8") >
    policy.policy.limits.maxManifestBytes
  ) {
    const compactable = omitted.findIndex(
      (omission) => !INTEGRITY_OMISSION_REASONS.has(omission.reason),
    );
    if (compactable >= 0) {
      const [removed] = omitted.splice(compactable, 1);
      if (removed) foldOverflow(removed);
    } else if (entries.length > 0) {
      const removed = entries.pop()!;
      omittedCount += 1;
      foldOverflow({
        path: removed.path,
        size: removed.size,
        type: "file",
        reason: "manifest-size",
      });
    } else {
      throw new WorkflowContentSnapshotError(
        snapshotStorageFailedFinding(
          "Workflow content snapshot manifest metadata exceeds its configured bound.",
        ),
      );
    }
    manifest = buildManifest();
  }
  return parseWorkflowContentSnapshotManifest(manifest);
}

export async function captureWorkflowContentSnapshot(
  options: CaptureWorkflowContentSnapshotOptions,
): Promise<WorkflowContentSnapshotManifest> {
  try {
    return await captureWorkflowContentSnapshotInternal({
      ...options,
      protectedRoots: [
        ...DEFAULT_PROTECTED_SNAPSHOT_ROOTS,
        ...(options.protectedRoots ?? []),
      ],
    });
  } catch (error) {
    if (error instanceof WorkflowContentSnapshotError) throw error;
    throw new WorkflowContentSnapshotError(
      snapshotStorageFailedFinding(
        "Workflow content snapshot capture failed without a safe diagnostic.",
      ),
      { cause: error },
    );
  }
}

export async function stageWorkflowContentSnapshot(
  options: StageWorkflowContentSnapshotOptions,
): Promise<WorkflowContentSnapshotReference> {
  const manifest = parseWorkflowContentSnapshotManifest(options.manifest);
  const reference = referenceFor(manifest);
  const content = canonicalJson(manifest);
  try {
    const existing = await options.transition.read(
      reference.path,
      manifest.limits.maxManifestBytes,
      "Workflow content snapshot",
    );
    if (existing !== null) {
      const parsed = parseWorkflowContentSnapshotManifest(
        JSON.parse(existing) as unknown,
      );
      if (hashWorkflowContentSnapshot(parsed) !== reference.hash) {
        throw new Error("Workflow content snapshot identity changed");
      }
      return reference;
    }
    await options.transition.write(
      reference.path,
      content,
      manifest.limits.maxManifestBytes,
      "Workflow content snapshot",
    );
    return reference;
  } catch (error) {
    if (error instanceof WorkflowContentSnapshotError) throw error;
    throw new WorkflowContentSnapshotError(
      snapshotStorageFailedFinding(
        "Workflow content snapshot evidence could not be persisted.",
        WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY,
      ),
      { cause: error },
    );
  }
}

export async function readWorkflowContentSnapshot(
  runRoot: string,
  hash: string,
  maxBytes = WORKFLOW_CONTENT_SNAPSHOT_DEFAULT_LIMITS.maxManifestBytes,
): Promise<WorkflowContentSnapshotManifest | null> {
  const relative = snapshotIdentityPath(hash);
  try {
    const inspection = await inspectProtectedProjectPath(runRoot, relative, {
      label: "Workflow content snapshot",
      expected: "file",
    });
    if (!inspection.exists) return null;
    const content = await readOptionalEngineRunText(
      runRoot,
      relative,
      maxBytes,
      "Workflow content snapshot",
    );
    if (content === null) return null;
    const manifest = parseWorkflowContentSnapshotManifest(
      JSON.parse(content) as unknown,
    );
    if (hashWorkflowContentSnapshot(manifest) !== hash) {
      throw new Error(
        "Workflow content snapshot identity does not match its path",
      );
    }
    return manifest;
  } catch (error) {
    if (error instanceof WorkflowContentSnapshotError) throw error;
    throw new WorkflowContentSnapshotError(
      snapshotStorageFailedFinding(
        "Workflow content snapshot evidence could not be read.",
        WORKFLOW_CONTENT_SNAPSHOT_DIRECTORY,
      ),
      { cause: error },
    );
  }
}
