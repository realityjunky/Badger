import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import {
  readOptionalEngineRunText,
  removeEngineRunFile,
  writeEngineRunText,
} from "../engine/protected-run-file.js";
import { parsePendingActionValue } from "../engine/run-store.js";
import { parseRunStateValue } from "../engine/state.js";
import type {
  EngineAction,
  RunState,
  RuntimeIdentity,
  TrajectoryEvent,
} from "../engine/types.js";
import { normalizeWorkflowRelativePath } from "../engine/project-config.js";
import {
  hashSkillPackage,
  readSkillSnapshot,
} from "../skill-runtime/snapshot.js";
import type { SkillPackage, SkillStep } from "../skill-runtime/types.js";
import type {
  WorkflowArtifactVersion,
  WorkflowDurabilityProfile,
  WorkflowProtocol,
} from "../types.js";
import {
  validateWorkflowArtifactVersion,
  validateWorkflowArtifactState,
} from "./artifacts.js";
import { parseWorkflowDurabilityProfile } from "./durability.js";
import { sha256, stableValue } from "../util.js";

export const WORKFLOW_CHECKPOINT_DIRECTORY = ".badger/checkpoints";
export const WORKFLOW_CHECKPOINT_INDEX_PATH = ".badger/checkpoints/index.json";
export const WORKFLOW_CHECKPOINT_MANIFEST_DIRECTORY =
  ".badger/checkpoints/manifests";
export const WORKFLOW_CHECKPOINT_RECORD_DIRECTORY =
  ".badger/checkpoints/records";
export const WORKFLOW_CHECKPOINT_CONTENT_DIRECTORY =
  ".badger/checkpoints/content";
export const WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH =
  ".badger/checkpoint-recovery-journal.json";
export const WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION = 1 as const;

const STATE_PATH = ".badger/run-state.json";
const PENDING_PATH = ".badger/pending-action.json";
const ARTIFACTS_PATH = ".badger/artifacts.json";
const CONTEXT_PATH = ".badger/context.md";
const TRAJECTORY_PATH = ".badger/trajectory.jsonl";
const TRANSITION_JOURNAL_PATH = ".badger/transition-journal.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CHECKPOINT_ENTRIES = 256;
const MAX_RECOVERY_RECORDS = 8;
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

export interface WorkflowCheckpointMaterialIdentity {
  path: string;
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

export interface WorkflowCheckpointMaterialReference extends WorkflowCheckpointMaterialIdentity {
  contentPath: string | null;
}

export interface WorkflowCheckpointPendingActionIdentity extends WorkflowCheckpointMaterialIdentity {
  id: string;
}

export interface WorkflowCheckpointTrajectoryIdentity extends WorkflowCheckpointMaterialIdentity {
  offset: number;
  prefixSha256: string;
}

export interface WorkflowCheckpointArtifactVersionReference {
  artifactId: string;
  versionId: string;
  path: string;
  contentHash: string;
  bytes: number;
}

export interface WorkflowCheckpointManifest {
  schemaVersion: typeof WORKFLOW_CHECKPOINT_SCHEMA_VERSION;
  kind: "workflow-checkpoint-manifest";
  manifestHash: string;
  runId: string;
  revision: number;
  execution: RuntimeIdentity;
  pendingAction: WorkflowCheckpointPendingActionIdentity | null;
  nodeId: string | null;
  cycleId: string | null;
  attemptId: string | null;
  state: WorkflowCheckpointMaterialIdentity;
  context: WorkflowCheckpointMaterialIdentity;
  artifacts: WorkflowCheckpointMaterialIdentity;
  trajectory: WorkflowCheckpointTrajectoryIdentity;
  artifactVersions: WorkflowCheckpointArtifactVersionReference[];
  createdAt: string;
}

export interface WorkflowCheckpointRecord {
  schemaVersion: typeof WORKFLOW_CHECKPOINT_SCHEMA_VERSION;
  kind: "workflow-checkpoint-record";
  recordHash: string;
  runId: string;
  revision: number;
  manifestHash: string;
  state: WorkflowCheckpointMaterialReference;
  pendingAction: WorkflowCheckpointMaterialReference;
  context: WorkflowCheckpointMaterialReference;
  artifacts: WorkflowCheckpointMaterialReference;
  trajectory: WorkflowCheckpointMaterialReference;
}

export interface WorkflowCheckpointIndexEntry {
  recordHash: string;
  manifestHash: string;
  revision: number;
}

export interface WorkflowCheckpointIndex {
  schemaVersion: typeof WORKFLOW_CHECKPOINT_SCHEMA_VERSION;
  kind: "workflow-checkpoint-index";
  runId: string;
  records: WorkflowCheckpointIndexEntry[];
}

export interface WorkflowCheckpointVerification {
  entry: WorkflowCheckpointIndexEntry;
  manifest: WorkflowCheckpointManifest;
  record: WorkflowCheckpointRecord;
  state: RunState;
  pending: EngineAction | null;
  identity: RuntimeIdentity;
  package: SkillPackage;
  contents: {
    state: string;
    pendingAction: string | null;
    context: string | null;
    artifacts: string | null;
    trajectory: string;
  };
}

export interface WorkflowCheckpointInspection {
  entry: WorkflowCheckpointIndexEntry;
  verification?: WorkflowCheckpointVerification;
  error?: string;
}

export interface WorkflowCheckpointRecoveryJournalRecord {
  path: string;
  previous: WorkflowCheckpointMaterialIdentity;
  intended: WorkflowCheckpointMaterialIdentity;
  contentPath: string | null;
}

export interface WorkflowCheckpointRecoveryJournal {
  schemaVersion: typeof WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION;
  kind: "workflow-checkpoint-recovery-journal";
  status: "prepared" | "committed";
  journalId: string;
  runId: string;
  execution: RuntimeIdentity;
  checkpointRecordHash: string;
  records: WorkflowCheckpointRecoveryJournalRecord[];
  recoveryEvent: TrajectoryEvent;
  createdAt: string;
  committedAt?: string;
}

export interface WorkflowCheckpointRecoveryResult {
  status: "none" | "recovered" | "blocked";
  journal?: WorkflowCheckpointRecoveryJournal;
  unknownPaths?: string[];
}

interface CheckpointBounds {
  manifestBytes: number;
  recordBytes: number;
  count: number;
}

interface BuiltCheckpoint {
  manifest: WorkflowCheckpointManifest;
  record: WorkflowCheckpointRecord;
  contents: Map<string, string>;
}

let configuredFault:
  | ((boundary: { phase: string; path?: string }) => void | Promise<void>)
  | undefined;

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

function boundedText(value: unknown, key: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}

function timestamp(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
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

function positiveInteger(value: unknown, key: string, label: string): number {
  const result = nonNegativeInteger(value, key, label);
  if (result < 1) throw new Error(`Invalid ${label}: ${key} must be positive`);
  return result;
}

function hash(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  if (!HASH_PATTERN.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}

function nullableHash(
  value: unknown,
  key: string,
  label: string,
): string | null {
  return value === null ? null : hash(value, key, label);
}

function safePath(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  return normalizeWorkflowRelativePath(result, `${label}: ${key}`);
}

function canonical(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

// stableValue-based on purpose: recorded checkpoint hashes depend on it, so it
// is not util.ts's code-unit canonicalHash.
function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function contentAddressHash(value: unknown): string {
  if (isRecord(value) && value.kind === "workflow-checkpoint-manifest") {
    const { manifestHash: _manifestHash, ...withoutHash } = value;
    return canonicalHash(withoutHash);
  }
  if (isRecord(value) && value.kind === "workflow-checkpoint-record") {
    const { recordHash: _recordHash, ...withoutHash } = value;
    return canonicalHash(withoutHash);
  }
  return canonicalHash(value);
}

function contentIdentity(content: string | null): {
  exists: boolean;
  bytes: number;
  sha256: string | null;
} {
  if (content === null) return { exists: false, bytes: 0, sha256: null };
  const bytes = Buffer.byteLength(content, "utf8");
  return { exists: true, bytes, sha256: sha256(Buffer.from(content, "utf8")) };
}

function identityOf(
  value:
    WorkflowCheckpointMaterialReference | WorkflowCheckpointMaterialIdentity,
): WorkflowCheckpointMaterialIdentity {
  return {
    path: value.path,
    exists: value.exists,
    bytes: value.bytes,
    sha256: value.sha256,
  };
}

function sameIdentity(
  left: WorkflowCheckpointMaterialIdentity,
  right: WorkflowCheckpointMaterialIdentity,
): boolean {
  return (
    left.path === right.path &&
    left.exists === right.exists &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function sameStableValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function sameActionDefinition(
  action: EngineAction,
  step: { action: SkillStep["action"] },
): boolean {
  if (action.repair) {
    return (
      action.type === "ask_user" &&
      action.stepId !== null &&
      action.repair.stepId === action.stepId &&
      action.repair.actionId === action.id &&
      action.repair.decisionId === action.decisionId &&
      action.repair.signatureHash.length === 64
    );
  }
  return (
    action.type === step.action.type &&
    action.ref === step.action.ref &&
    action.prompt === step.action.prompt &&
    action.question === step.action.question &&
    sameStableValue(action.options, step.action.options) &&
    action.decisionId === step.action.decisionId &&
    sameStableValue(action.choices, step.action.choices) &&
    sameStableValue(action.requiredInputs, step.action.requiredInputs) &&
    sameStableValue(action.rationale, step.action.rationale) &&
    sameStableValue(action.reviewer, step.action.reviewer)
  );
}

function contentPathFor(hashValue: string): string {
  return `${WORKFLOW_CHECKPOINT_CONTENT_DIRECTORY}/${hashValue}.txt`;
}

function manifestPathFor(hashValue: string): string {
  return `${WORKFLOW_CHECKPOINT_MANIFEST_DIRECTORY}/${hashValue}.json`;
}

function recordPathFor(hashValue: string): string {
  return `${WORKFLOW_CHECKPOINT_RECORD_DIRECTORY}/${hashValue}.json`;
}

function checkpointBounds(
  profile: WorkflowDurabilityProfile,
): CheckpointBounds {
  const parsed = parseWorkflowDurabilityProfile(profile);
  if (!parsed.capabilities.includes("verified-checkpoints")) {
    throw new Error(
      "Workflow durability profile has no verified checkpoint capability",
    );
  }
  const manifestBytes = parsed.bounds.checkpointManifestBytes;
  const recordBytes = parsed.bounds.checkpointRecordBytes;
  const count = parsed.bounds.checkpointCount;
  if (
    manifestBytes === undefined ||
    recordBytes === undefined ||
    count === undefined
  ) {
    throw new Error("Workflow checkpoint bounds are missing");
  }
  return { manifestBytes, recordBytes, count };
}

function maxBytesForPath(
  profile: WorkflowDurabilityProfile,
  relativePath: string,
): number {
  if (relativePath === STATE_PATH) return profile.bounds.runStateBytes;
  if (relativePath === PENDING_PATH) return profile.bounds.pendingActionBytes;
  if (relativePath === TRAJECTORY_PATH) return profile.bounds.trajectoryBytes;
  if (relativePath === ARTIFACTS_PATH) return profile.bounds.artifactsBytes;
  return Math.max(profile.bounds.runStateBytes, profile.bounds.artifactsBytes);
}

function parseExecutionIdentity(
  value: unknown,
  label: string,
): RuntimeIdentity {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "protocolHash",
      "packageHash",
      "snapshotHash",
      "nodeToStep",
      "capabilityVersion",
      "resolverHash",
      "findingCatalogVersion",
      "durabilityProfile",
    ]),
    label,
  );
  if (
    !value.nodeToStep ||
    typeof value.nodeToStep !== "object" ||
    Array.isArray(value.nodeToStep)
  ) {
    throw new Error(`Invalid ${label}: nodeToStep is invalid`);
  }
  const nodeToStep: Record<string, string> = {};
  for (const [nodeId, stepId] of Object.entries(value.nodeToStep)) {
    if (!nodeId || typeof stepId !== "string" || stepId.length === 0) {
      throw new Error(`Invalid ${label}: nodeToStep is invalid`);
    }
    nodeToStep[nodeId] = stepId;
  }
  if (value.capabilityVersion !== undefined && value.capabilityVersion !== 3) {
    throw new Error(`Invalid ${label}: capabilityVersion is invalid`);
  }
  if (
    value.findingCatalogVersion !== undefined &&
    value.findingCatalogVersion !== 1
  ) {
    throw new Error(`Invalid ${label}: findingCatalogVersion is invalid`);
  }
  const identity: RuntimeIdentity = {
    protocolHash: hash(value.protocolHash, "protocolHash", label),
    packageHash: hash(value.packageHash, "packageHash", label),
    snapshotHash: hash(value.snapshotHash, "snapshotHash", label),
    nodeToStep,
    ...(value.capabilityVersion === 3 ? { capabilityVersion: 3 as const } : {}),
    ...(value.resolverHash !== undefined
      ? { resolverHash: hash(value.resolverHash, "resolverHash", label) }
      : {}),
    ...(value.findingCatalogVersion === 1
      ? { findingCatalogVersion: 1 as const }
      : {}),
  };
  if (value.durabilityProfile !== undefined) {
    identity.durabilityProfile = parseWorkflowDurabilityProfile(
      value.durabilityProfile,
    );
  }
  return identity;
}

function parseMaterialIdentity(
  value: unknown,
  label: string,
): WorkflowCheckpointMaterialIdentity {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["path", "exists", "bytes", "sha256"]),
    label,
  );
  const pathValue = safePath(value.path, "path", label);
  if (typeof value.exists !== "boolean") {
    throw new Error(`Invalid ${label}: exists must be a boolean`);
  }
  const bytes = nonNegativeInteger(value.bytes, "bytes", label);
  const digest = nullableHash(value.sha256, "sha256", label);
  if (
    (!value.exists && (bytes !== 0 || digest !== null)) ||
    (value.exists && (bytes < 1 || digest === null))
  ) {
    throw new Error(`Invalid ${label}: identity is inconsistent`);
  }
  return { path: pathValue, exists: value.exists, bytes, sha256: digest };
}

function parseMaterialReference(
  value: unknown,
  label: string,
): WorkflowCheckpointMaterialReference {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["path", "contentPath", "exists", "bytes", "sha256"]),
    label,
  );
  const { contentPath: rawContentPath, ...material } = value;
  const identity = parseMaterialIdentity(material, label);
  const contentPath =
    rawContentPath === null
      ? null
      : safePath(rawContentPath, "contentPath", label);
  if (!identity.exists && contentPath !== null) {
    throw new Error(`Invalid ${label}: missing material cannot have content`);
  }
  if (
    identity.exists &&
    (contentPath === null || contentPath !== contentPathFor(identity.sha256!))
  ) {
    throw new Error(`Invalid ${label}: contentPath is not content-addressed`);
  }
  return { ...identity, contentPath };
}

function parsePendingActionIdentity(
  value: unknown,
  label: string,
): WorkflowCheckpointPendingActionIdentity {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["id", "path", "exists", "bytes", "sha256"]),
    label,
  );
  const { id, ...material } = value;
  return {
    id: boundedText(id, "id", label),
    ...parseMaterialIdentity(material, label),
  };
}

function parseTrajectoryIdentity(
  value: unknown,
  label: string,
): WorkflowCheckpointTrajectoryIdentity {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["path", "exists", "bytes", "sha256", "offset", "prefixSha256"]),
    label,
  );
  const {
    offset: rawOffset,
    prefixSha256: rawPrefixSha256,
    ...material
  } = value;
  const identity = parseMaterialIdentity(material, label);
  const offset = nonNegativeInteger(rawOffset, "offset", label);
  const prefixSha256 = hash(rawPrefixSha256, "prefixSha256", label);
  if (!identity.exists || offset > identity.bytes) {
    throw new Error(`Invalid ${label}: offset is inconsistent`);
  }
  return { ...identity, offset, prefixSha256 };
}

function parseArtifactVersionReference(
  value: unknown,
  label: string,
): WorkflowCheckpointArtifactVersionReference {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["artifactId", "versionId", "path", "contentHash", "bytes"]),
    label,
  );
  return {
    artifactId: boundedText(value.artifactId, "artifactId", label),
    versionId: boundedText(value.versionId, "versionId", label),
    path: safePath(value.path, "path", label),
    contentHash: hash(value.contentHash, "contentHash", label),
    bytes: positiveInteger(value.bytes, "bytes", label),
  };
}

function parseCheckpointManifest(
  value: unknown,
  bounds: CheckpointBounds,
): WorkflowCheckpointManifest {
  const label = "Workflow checkpoint manifest";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "manifestHash",
      "runId",
      "revision",
      "execution",
      "pendingAction",
      "nodeId",
      "cycleId",
      "attemptId",
      "state",
      "context",
      "artifacts",
      "trajectory",
      "artifactVersions",
      "createdAt",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION ||
    value.kind !== "workflow-checkpoint-manifest"
  ) {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  const artifactVersions = value.artifactVersions;
  if (
    !Array.isArray(artifactVersions) ||
    artifactVersions.length > MAX_CHECKPOINT_ENTRIES
  ) {
    throw new Error(`Invalid ${label}: artifactVersions are outside the bound`);
  }
  const parsed: WorkflowCheckpointManifest = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-manifest" as const,
    manifestHash: hash(value.manifestHash, "manifestHash", label),
    runId: boundedText(value.runId, "runId", label),
    revision: nonNegativeInteger(value.revision, "revision", label),
    execution: parseExecutionIdentity(value.execution, `${label}.execution`),
    pendingAction:
      value.pendingAction === null
        ? null
        : parsePendingActionIdentity(
            value.pendingAction,
            `${label}.pendingAction`,
          ),
    nodeId:
      value.nodeId === null ? null : boundedText(value.nodeId, "nodeId", label),
    cycleId:
      value.cycleId === null
        ? null
        : boundedText(value.cycleId, "cycleId", label),
    attemptId:
      value.attemptId === null
        ? null
        : boundedText(value.attemptId, "attemptId", label),
    state: parseMaterialIdentity(value.state, `${label}.state`),
    context: parseMaterialIdentity(value.context, `${label}.context`),
    artifacts: parseMaterialIdentity(value.artifacts, `${label}.artifacts`),
    trajectory: parseTrajectoryIdentity(
      value.trajectory,
      `${label}.trajectory`,
    ),
    artifactVersions: artifactVersions.map((entry, index) =>
      parseArtifactVersionReference(
        entry,
        `${label}.artifactVersions[${index}]`,
      ),
    ),
    createdAt: timestamp(value.createdAt, "createdAt", label),
  };
  if (Buffer.byteLength(canonical(parsed), "utf8") > bounds.manifestBytes) {
    throw new Error(`Invalid ${label}: exceeds ${bounds.manifestBytes} bytes`);
  }
  return parsed;
}

function parseCheckpointRecord(
  value: unknown,
  bounds: CheckpointBounds,
): WorkflowCheckpointRecord {
  const label = "Workflow checkpoint record";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "recordHash",
      "runId",
      "revision",
      "manifestHash",
      "state",
      "pendingAction",
      "context",
      "artifacts",
      "trajectory",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION ||
    value.kind !== "workflow-checkpoint-record"
  ) {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  const parsed: WorkflowCheckpointRecord = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-record" as const,
    recordHash: hash(value.recordHash, "recordHash", label),
    runId: boundedText(value.runId, "runId", label),
    revision: nonNegativeInteger(value.revision, "revision", label),
    manifestHash: hash(value.manifestHash, "manifestHash", label),
    state: parseMaterialReference(value.state, `${label}.state`),
    pendingAction: parseMaterialReference(
      value.pendingAction,
      `${label}.pendingAction`,
    ),
    context: parseMaterialReference(value.context, `${label}.context`),
    artifacts: parseMaterialReference(value.artifacts, `${label}.artifacts`),
    trajectory: parseMaterialReference(value.trajectory, `${label}.trajectory`),
  };
  if (Buffer.byteLength(canonical(parsed), "utf8") > bounds.recordBytes) {
    throw new Error(`Invalid ${label}: exceeds ${bounds.recordBytes} bytes`);
  }
  return parsed;
}

function parseCheckpointIndex(
  value: unknown,
  bounds?: CheckpointBounds,
): WorkflowCheckpointIndex {
  const label = "Workflow checkpoint index";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["schemaVersion", "kind", "runId", "records"]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION ||
    value.kind !== "workflow-checkpoint-index"
  ) {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (
    !Array.isArray(value.records) ||
    value.records.length > (bounds?.count ?? MAX_CHECKPOINT_ENTRIES)
  ) {
    throw new Error(`Invalid ${label}: records are outside the bound`);
  }
  const records = value.records.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid ${label}: records[${index}] must be an object`);
    }
    assertKnownFields(
      entry,
      new Set(["recordHash", "manifestHash", "revision"]),
      label,
    );
    return {
      recordHash: hash(entry.recordHash, "recordHash", label),
      manifestHash: hash(entry.manifestHash, "manifestHash", label),
      revision: nonNegativeInteger(entry.revision, "revision", label),
    };
  });
  const recordKeys = new Set<string>();
  const manifestHashes = new Set<string>();
  for (const record of records) {
    if (
      recordKeys.has(record.recordHash) ||
      manifestHashes.has(record.manifestHash)
    ) {
      throw new Error(`Invalid ${label}: duplicate record identity`);
    }
    recordKeys.add(record.recordHash);
    manifestHashes.add(record.manifestHash);
  }
  records.sort(
    (left, right) =>
      right.revision - left.revision ||
      left.recordHash.localeCompare(right.recordHash),
  );
  return {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-index",
    runId: boundedText(value.runId, "runId", label),
    records,
  };
}

function parseRecoveryJournal(
  value: unknown,
  bounds: CheckpointBounds,
): WorkflowCheckpointRecoveryJournal {
  const label = "Workflow checkpoint recovery journal";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "status",
      "journalId",
      "runId",
      "execution",
      "checkpointRecordHash",
      "records",
      "recoveryEvent",
      "createdAt",
      "committedAt",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION ||
    value.kind !== "workflow-checkpoint-recovery-journal" ||
    (value.status !== "prepared" && value.status !== "committed")
  ) {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > MAX_RECOVERY_RECORDS
  ) {
    throw new Error(`Invalid ${label}: records are outside the bound`);
  }
  const records: WorkflowCheckpointRecoveryJournalRecord[] = value.records.map(
    (entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(
          `Invalid ${label}: records[${index}] must be an object`,
        );
      }
      assertKnownFields(
        entry,
        new Set(["path", "previous", "intended", "contentPath"]),
        label,
      );
      const intended = parseMaterialIdentity(
        entry.intended,
        `${label}.intended`,
      );
      const contentPath =
        entry.contentPath === null
          ? null
          : safePath(entry.contentPath, "contentPath", label);
      if (intended.exists && contentPath !== contentPathFor(intended.sha256!)) {
        throw new Error(`Invalid ${label}: intended content is not addressed`);
      }
      if (!intended.exists && contentPath !== null) {
        throw new Error(
          `Invalid ${label}: missing intended content is addressed`,
        );
      }
      const pathValue = safePath(entry.path, "path", label);
      const previous = parseMaterialIdentity(
        entry.previous,
        `${label}.previous`,
      );
      if (previous.path !== pathValue || intended.path !== pathValue) {
        throw new Error(`Invalid ${label}: record path identity is invalid`);
      }
      return { path: pathValue, previous, intended, contentPath };
    },
  );
  records.sort((left, right) => left.path.localeCompare(right.path));
  const recoveryPaths = new Set([
    STATE_PATH,
    PENDING_PATH,
    CONTEXT_PATH,
    ARTIFACTS_PATH,
    TRAJECTORY_PATH,
  ]);
  if (
    records.some((record) => !recoveryPaths.has(record.path)) ||
    new Set(records.map((record) => record.path)).size !== records.length ||
    records.length !== recoveryPaths.size ||
    [...recoveryPaths].some(
      (pathValue) => !records.some((record) => record.path === pathValue),
    )
  ) {
    throw new Error(`Invalid ${label}: recovery path is not a Run record`);
  }
  const recoveryEvent = parseTrajectoryEvent(value.recoveryEvent, label);
  if (recoveryEvent.type !== "recovery_reconciled") {
    throw new Error(`Invalid ${label}: recoveryEvent type is invalid`);
  }
  const parsed: WorkflowCheckpointRecoveryJournal = {
    schemaVersion: WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION,
    kind: "workflow-checkpoint-recovery-journal",
    status: value.status,
    journalId: boundedText(value.journalId, "journalId", label),
    runId: boundedText(value.runId, "runId", label),
    execution: parseExecutionIdentity(value.execution, `${label}.execution`),
    checkpointRecordHash: hash(
      value.checkpointRecordHash,
      "checkpointRecordHash",
      label,
    ),
    records,
    recoveryEvent,
    createdAt: timestamp(value.createdAt, "createdAt", label),
    ...(value.committedAt === undefined
      ? {}
      : { committedAt: timestamp(value.committedAt, "committedAt", label) }),
  };
  if (
    (parsed.status === "committed") !== (parsed.committedAt !== undefined) ||
    parsed.recoveryEvent.runId !== parsed.runId ||
    Buffer.byteLength(canonical(parsed), "utf8") > bounds.recordBytes
  ) {
    throw new Error(`Invalid ${label}: evidence is inconsistent or oversized`);
  }
  return parsed;
}

function parseTrajectoryEvent(value: unknown, label: string): TrajectoryEvent {
  if (!isRecord(value))
    throw new Error(`Invalid ${label}: event must be an object`);
  assertKnownFields(
    value,
    new Set(["sequence", "timestamp", "type", "runId", "data"]),
    label,
  );
  const sequence = positiveInteger(value.sequence, "sequence", label);
  const type = value.type;
  if (
    typeof type !== "string" ||
    !TRAJECTORY_EVENT_TYPES.has(type as TrajectoryEvent["type"])
  ) {
    throw new Error(`Invalid ${label}: event type is invalid`);
  }
  if (!isRecord(value.data))
    throw new Error(`Invalid ${label}: event data is invalid`);
  return {
    sequence,
    timestamp: timestamp(value.timestamp, "timestamp", label),
    type: type as TrajectoryEvent["type"],
    runId: boundedText(value.runId, "runId", label),
    data: value.data,
  };
}

function parseTrajectory(raw: string, runId: string): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  let expectedSequence = 1;
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid checkpoint trajectory event at line ${index + 1}`,
        {
          cause: error,
        },
      );
    }
    const event = parseTrajectoryEvent(
      parsed,
      `checkpoint trajectory line ${index + 1}`,
    );
    if (event.sequence !== expectedSequence || event.runId !== runId) {
      throw new Error(
        `Invalid checkpoint trajectory sequence at line ${index + 1}`,
      );
    }
    events.push(event);
    expectedSequence += 1;
  }
  if (events.length === 0)
    throw new Error("Invalid checkpoint trajectory: no events");
  return events;
}

function validateArtifactContent(raw: string | null): void {
  if (raw === null) return;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Workflow checkpoint artifacts are not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new Error("Workflow checkpoint artifacts are not an object");
  }
  for (const [key, artifact] of Object.entries(value)) {
    if (!key || typeof artifact !== "string") {
      throw new Error("Workflow checkpoint artifacts contain an invalid entry");
    }
  }
}

function validateTrajectorySemantics(
  events: readonly TrajectoryEvent[],
  state: RunState,
  pending: EngineAction | null,
): void {
  const proposals = new Map<string, EngineAction>();
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type === "action_proposed") {
      if (!isRecord(event.data.action)) {
        throw new Error("Workflow checkpoint action proposal is invalid");
      }
      const action = parsePendingActionValue(event.data.action);
      if (proposals.has(action.id)) {
        throw new Error("Workflow checkpoint action proposal is duplicated");
      }
      proposals.set(action.id, action);
      continue;
    }
    if (event.type !== "action_completed") continue;
    if (!isRecord(event.data.action) || !isRecord(event.data.outcome)) {
      throw new Error("Workflow checkpoint action completion is invalid");
    }
    const action = parsePendingActionValue(event.data.action);
    const outcome = event.data.outcome;
    if (
      typeof outcome.actionId !== "string" ||
      outcome.actionId !== action.id ||
      (outcome.status !== "succeeded" && outcome.status !== "failed") ||
      typeof outcome.summary !== "string" ||
      outcome.summary.length === 0
    ) {
      throw new Error("Workflow checkpoint action outcome is invalid");
    }
    if (!proposals.has(action.id) || completed.has(action.id)) {
      throw new Error(
        "Workflow checkpoint action completion is not attributable",
      );
    }
    completed.add(action.id);
  }
  if (completed.size !== (state.workflowRuntime?.revision ?? 0)) {
    throw new Error("Workflow checkpoint trajectory revision is invalid");
  }
  for (const actionId of proposals.keys()) {
    if (!completed.has(actionId) && actionId !== pending?.id) {
      throw new Error(
        "Workflow checkpoint trajectory has an uncommitted action",
      );
    }
  }
  if (pending && !proposals.has(pending.id)) {
    throw new Error("Workflow checkpoint pending action has no proposal");
  }
}

async function readRaw(
  runRoot: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<string | null> {
  return readOptionalEngineRunText(runRoot, relativePath, maxBytes, label);
}

async function readMaterial(
  runRoot: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<{
  content: string | null;
  identity: WorkflowCheckpointMaterialIdentity;
}> {
  const content = await readRaw(runRoot, relativePath, maxBytes, label);
  return {
    content,
    identity: { path: relativePath, ...contentIdentity(content) },
  };
}

async function readReferencedContent(
  runRoot: string,
  reference: WorkflowCheckpointMaterialReference,
  maxBytes: number,
  label: string,
): Promise<string | null> {
  if (!reference.exists || reference.contentPath === null) return null;
  const content = await readRaw(
    runRoot,
    reference.contentPath,
    maxBytes,
    label,
  );
  if (content === null) throw new Error(`${label} content is missing`);
  const identity = contentIdentity(content);
  if (
    !identity.exists ||
    identity.bytes !== reference.bytes ||
    identity.sha256 !== reference.sha256
  ) {
    throw new Error(`${label} content identity is invalid`);
  }
  return content;
}

async function publishContent(
  runRoot: string,
  reference: WorkflowCheckpointMaterialReference,
  content: string,
  maxBytes: number,
): Promise<void> {
  if (!reference.contentPath)
    throw new Error("Cannot publish missing checkpoint content");
  await ensureProtectedProjectDirectory(
    runRoot,
    WORKFLOW_CHECKPOINT_CONTENT_DIRECTORY,
    {
      label: "Workflow checkpoint content",
    },
  );
  const existing = await readRaw(
    runRoot,
    reference.contentPath,
    maxBytes,
    "Workflow checkpoint content",
  );
  if (existing !== null) {
    if (existing !== content)
      throw new Error("Workflow checkpoint content identity changed");
    return;
  }
  try {
    await writeEngineRunText(
      runRoot,
      reference.contentPath,
      content,
      maxBytes,
      "Workflow checkpoint content",
      { exclusive: true, maxBytes },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readRaw(
      runRoot,
      reference.contentPath,
      maxBytes,
      "Workflow checkpoint content",
    );
    if (raced !== content) throw error;
  }
}

async function publishJson(
  runRoot: string,
  relativePath: string,
  value: unknown,
  maxBytes: number,
  label: string,
): Promise<void> {
  const content = canonical(value);
  const existing = await readRaw(runRoot, relativePath, maxBytes, label);
  if (existing !== null) {
    if (relativePath === WORKFLOW_CHECKPOINT_INDEX_PATH) {
      await writeEngineRunText(
        runRoot,
        relativePath,
        content,
        maxBytes,
        label,
        {
          maxBytes,
        },
      );
      return;
    }
    if (existing !== content)
      throw new Error(`${label} content identity changed`);
    return;
  }
  try {
    await writeEngineRunText(runRoot, relativePath, content, maxBytes, label, {
      exclusive: true,
      maxBytes,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readRaw(runRoot, relativePath, maxBytes, label);
    if (raced !== content) throw error;
  }
}

async function captureMaterial(
  runRoot: string,
  relativePath: string,
  maxBytes: number,
  label: string,
): Promise<{
  reference: WorkflowCheckpointMaterialReference;
  content: string | null;
}> {
  const material = await readMaterial(runRoot, relativePath, maxBytes, label);
  if (material.content === null) {
    return {
      content: null,
      reference: { ...material.identity, contentPath: null },
    };
  }
  return {
    content: material.content,
    reference: {
      ...material.identity,
      contentPath: contentPathFor(material.identity.sha256!),
    },
  };
}

async function physicalArtifactBytes(
  runRoot: string,
  protocol: WorkflowProtocol,
  version: WorkflowArtifactVersion,
  maxBytes: number,
): Promise<number> {
  await validateWorkflowArtifactVersion(runRoot, protocol, version);
  const inspection = await inspectProtectedProjectPath(runRoot, version.path, {
    label: `Workflow checkpoint artifact ${version.id}`,
    expected: "any",
  });
  if (!inspection.exists)
    throw new Error(`Workflow checkpoint artifact is missing: ${version.id}`);
  if (inspection.kind === "file") {
    return (
      await readProtectedProjectFile(runRoot, version.path, maxBytes, {
        label: `Workflow checkpoint artifact ${version.id}`,
      })
    ).bytes.length;
  }
  let total = 0;
  async function walk(relativePath: string): Promise<void> {
    const current = await inspectProtectedProjectPath(runRoot, relativePath, {
      label: `Workflow checkpoint artifact ${version.id}`,
      expected: "directory",
    });
    for (const entry of (
      await fs.readdir(current.target, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.posix.join(relativePath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workflow checkpoint artifact crosses a symbolic link: ${child}`,
        );
      }
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `Workflow checkpoint artifact has an invalid entry: ${child}`,
        );
      total += (
        await readProtectedProjectFile(runRoot, child, maxBytes, {
          label: `Workflow checkpoint artifact ${version.id}`,
        })
      ).bytes.length;
      if (total > maxBytes)
        throw new Error(
          `Workflow checkpoint artifact exceeds ${maxBytes} bytes`,
        );
    }
  }
  await walk(version.path);
  return total;
}

async function artifactVersionReferences(
  runRoot: string,
  pkg: SkillPackage,
  state: RunState,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowCheckpointArtifactVersionReference[]> {
  const versions = state.workflowRuntime?.artifactVersions ?? [];
  if (!pkg.runtime)
    throw new Error("Workflow checkpoint package has no runtime");
  validateWorkflowArtifactState(
    pkg.runtime.protocol,
    state.runId,
    state.runtimeIdentity?.nodeToStep ?? {},
    state.workflowRuntime!,
  );
  const references: WorkflowCheckpointArtifactVersionReference[] = [];
  for (const version of versions) {
    const bytes = await physicalArtifactBytes(
      runRoot,
      pkg.runtime.protocol,
      version,
      profile.bounds.artifactsBytes,
    );
    references.push({
      artifactId: version.artifactId,
      versionId: version.id,
      path: version.path,
      contentHash: version.contentHash,
      bytes,
    });
  }
  return references.sort(
    (left, right) =>
      left.artifactId.localeCompare(right.artifactId) ||
      left.versionId.localeCompare(right.versionId),
  );
}

function currentNodeIdentity(
  state: RunState,
  identity: RuntimeIdentity,
  pending: EngineAction | null,
): string | null {
  const step = pending?.stepId ?? state.currentStep;
  if (!step) return null;
  return (
    Object.entries(identity.nodeToStep).find(
      ([, stepId]) => stepId === step,
    )?.[0] ?? null
  );
}

async function buildCheckpoint(options: {
  runRoot: string;
  state: RunState;
  pending: EngineAction | null;
  identity: RuntimeIdentity;
  package: SkillPackage;
  profile: WorkflowDurabilityProfile;
}): Promise<BuiltCheckpoint> {
  const bounds = checkpointBounds(options.profile);
  const stateMaterial = await captureMaterial(
    options.runRoot,
    STATE_PATH,
    options.profile.bounds.runStateBytes,
    "Workflow checkpoint state",
  );
  if (!stateMaterial.content)
    throw new Error("Workflow checkpoint state is missing");
  const parsedState = parseRunStateValue(
    JSON.parse(stateMaterial.content) as unknown,
  );
  if (!sameStableValue(parsedState, options.state))
    throw new Error("Workflow checkpoint state changed during capture");
  const pendingMaterial = await captureMaterial(
    options.runRoot,
    PENDING_PATH,
    options.profile.bounds.pendingActionBytes,
    "Workflow checkpoint pending action",
  );
  const contextMaterial = await captureMaterial(
    options.runRoot,
    CONTEXT_PATH,
    Math.max(
      options.profile.bounds.runStateBytes,
      options.profile.bounds.artifactsBytes,
    ),
    "Workflow checkpoint context",
  );
  const artifactsMaterial = await captureMaterial(
    options.runRoot,
    ARTIFACTS_PATH,
    options.profile.bounds.artifactsBytes,
    "Workflow checkpoint artifacts",
  );
  const trajectoryMaterial = await captureMaterial(
    options.runRoot,
    TRAJECTORY_PATH,
    options.profile.bounds.trajectoryBytes,
    "Workflow checkpoint trajectory",
  );
  if (!trajectoryMaterial.content)
    throw new Error("Workflow checkpoint trajectory is missing");
  parseTrajectory(trajectoryMaterial.content, options.state.runId);
  const trajectoryBytes = Buffer.byteLength(trajectoryMaterial.content, "utf8");
  if (trajectoryBytes !== trajectoryMaterial.reference.bytes)
    throw new Error("Workflow checkpoint trajectory size changed");
  const pending = pendingMaterial.content
    ? parsePendingActionValue(JSON.parse(pendingMaterial.content) as unknown)
    : null;
  if (Boolean(pending) !== Boolean(options.pending))
    throw new Error(
      "Workflow checkpoint pending action changed during capture",
    );
  if (
    pending &&
    options.pending &&
    !sameStableValue(pending, options.pending)
  ) {
    throw new Error(
      "Workflow checkpoint pending action changed during capture",
    );
  }
  if (options.state.pending !== (pending?.id ?? null)) {
    throw new Error("Workflow checkpoint pending action does not match state");
  }
  const artifactVersions = await artifactVersionReferences(
    options.runRoot,
    options.package,
    options.state,
    options.profile,
  );
  const runtimeState = options.state.workflowRuntime;
  const manifestWithoutHash = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-manifest" as const,
    runId: options.state.runId,
    revision: runtimeState?.revision ?? 0,
    execution: structuredClone(options.identity),
    pendingAction: pending
      ? { id: pending.id, ...identityOf(pendingMaterial.reference) }
      : null,
    nodeId: currentNodeIdentity(options.state, options.identity, pending),
    cycleId:
      runtimeState?.currentCycle?.id ??
      runtimeState?.currentAttempt?.cycleId ??
      null,
    attemptId: runtimeState?.currentAttempt?.id ?? null,
    state: identityOf(stateMaterial.reference),
    context: identityOf(contextMaterial.reference),
    artifacts: identityOf(artifactsMaterial.reference),
    trajectory: {
      ...identityOf(trajectoryMaterial.reference),
      offset: trajectoryBytes,
      prefixSha256: sha256(Buffer.from(trajectoryMaterial.content, "utf8")),
    },
    artifactVersions,
    createdAt: new Date().toISOString(),
  };
  const manifest: WorkflowCheckpointManifest = {
    ...manifestWithoutHash,
    manifestHash: canonicalHash(manifestWithoutHash),
  };
  parseCheckpointManifest(manifest, bounds);
  const recordWithoutHash = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-record" as const,
    runId: options.state.runId,
    revision: manifest.revision,
    manifestHash: manifest.manifestHash,
    state: stateMaterial.reference,
    pendingAction: pendingMaterial.reference,
    context: contextMaterial.reference,
    artifacts: artifactsMaterial.reference,
    trajectory: trajectoryMaterial.reference,
  };
  const record: WorkflowCheckpointRecord = {
    ...recordWithoutHash,
    recordHash: canonicalHash(recordWithoutHash),
  };
  parseCheckpointRecord(record, bounds);
  return {
    manifest,
    record,
    contents: new Map(
      [
        stateMaterial,
        pendingMaterial,
        contextMaterial,
        artifactsMaterial,
        trajectoryMaterial,
      ]
        .filter(
          (material): material is typeof material & { content: string } =>
            material.content !== null,
        )
        .map((material) => [material.reference.contentPath!, material.content]),
    ),
  };
}

async function readIndexWithBounds(
  runRoot: string,
  profile?: WorkflowDurabilityProfile,
): Promise<WorkflowCheckpointIndex | null> {
  const bounds = profile ? checkpointBounds(profile) : undefined;
  const raw = await readRaw(
    runRoot,
    WORKFLOW_CHECKPOINT_INDEX_PATH,
    bounds?.recordBytes ?? 16 * 1024 * 1024,
    "Workflow checkpoint index",
  );
  if (raw === null) return null;
  if (
    Buffer.byteLength(raw, "utf8") > (bounds?.recordBytes ?? 16 * 1024 * 1024)
  ) {
    throw new Error("Workflow checkpoint index is oversized");
  }
  return parseCheckpointIndex(JSON.parse(raw) as unknown, bounds);
}

async function readAddressedJson(
  runRoot: string,
  relativePath: string,
  expectedHash: string,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const raw = await readRaw(runRoot, relativePath, maxBytes, label);
  if (raw === null) throw new Error(`${label} is missing`);
  const value = JSON.parse(raw) as unknown;
  if (contentAddressHash(value) !== expectedHash)
    throw new Error(`${label} content address is invalid`);
  return value;
}

async function readRecordAndManifest(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  entry: WorkflowCheckpointIndexEntry,
): Promise<{
  record: WorkflowCheckpointRecord;
  manifest: WorkflowCheckpointManifest;
}> {
  const bounds = checkpointBounds(profile);
  const recordValue = await readAddressedJson(
    runRoot,
    recordPathFor(entry.recordHash),
    entry.recordHash,
    bounds.recordBytes,
    "Workflow checkpoint record",
  );
  const record = parseCheckpointRecord(recordValue, bounds);
  if (
    record.manifestHash !== entry.manifestHash ||
    record.revision !== entry.revision
  ) {
    throw new Error("Workflow checkpoint record index identity is invalid");
  }
  const manifestValue = await readAddressedJson(
    runRoot,
    manifestPathFor(entry.manifestHash),
    entry.manifestHash,
    bounds.manifestBytes,
    "Workflow checkpoint manifest",
  );
  const manifest = parseCheckpointManifest(manifestValue, bounds);
  if (
    manifest.runId !== record.runId ||
    manifest.revision !== record.revision
  ) {
    throw new Error("Workflow checkpoint manifest identity is invalid");
  }
  if (
    manifest.manifestHash !== entry.manifestHash ||
    record.recordHash !== entry.recordHash
  ) {
    throw new Error("Workflow checkpoint content address is invalid");
  }
  if (
    record.state.path !== STATE_PATH ||
    record.pendingAction.path !== PENDING_PATH ||
    record.context.path !== CONTEXT_PATH ||
    record.artifacts.path !== ARTIFACTS_PATH ||
    record.trajectory.path !== TRAJECTORY_PATH ||
    manifest.state.path !== STATE_PATH ||
    manifest.context.path !== CONTEXT_PATH ||
    manifest.artifacts.path !== ARTIFACTS_PATH ||
    manifest.trajectory.path !== TRAJECTORY_PATH ||
    (manifest.pendingAction !== null &&
      manifest.pendingAction.path !== PENDING_PATH)
  ) {
    throw new Error("Workflow checkpoint record paths are invalid");
  }
  return { record, manifest };
}

function materialMatchesManifest(
  reference: WorkflowCheckpointMaterialReference,
  identity: WorkflowCheckpointMaterialIdentity,
): boolean {
  return sameIdentity(identityOf(reference), identity);
}

async function verifyPackageIdentity(
  runRoot: string,
  state: RunState,
  manifest: WorkflowCheckpointManifest,
): Promise<{ identity: RuntimeIdentity; package: SkillPackage }> {
  if (!state.runtimeIdentity)
    throw new Error("Workflow checkpoint state has no execution identity");
  const identity = state.runtimeIdentity;
  if (!sameStableValue(identity, manifest.execution)) {
    throw new Error(
      "Workflow checkpoint execution identity does not match state",
    );
  }
  if (state.skillHash !== identity.snapshotHash)
    throw new Error("Workflow checkpoint snapshot identity is invalid");
  const pkg = await readSkillSnapshot(runRoot, state.skillHash);
  if (!pkg.runtime)
    throw new Error("Workflow checkpoint Skill snapshot has no runtime");
  if (
    pkg.runtime.protocolHash !== identity.protocolHash ||
    !sameStableValue(pkg.runtime.nodeToStep, identity.nodeToStep) ||
    pkg.runtime.capabilityVersion !== identity.capabilityVersion ||
    pkg.runtime.resolverHash !== identity.resolverHash ||
    pkg.runtime.findingCatalogVersion !== identity.findingCatalogVersion ||
    !sameStableValue(
      pkg.runtime.durabilityProfile,
      identity.durabilityProfile,
    ) ||
    (await hashSkillPackage(pkg)) !== identity.packageHash
  ) {
    throw new Error("Workflow checkpoint package identity is invalid");
  }
  return { identity, package: pkg };
}

export function setWorkflowCheckpointFaultForTests(
  fault: (boundary: { phase: string; path?: string }) => void | Promise<void>,
): void {
  configuredFault = fault;
}

export function clearWorkflowCheckpointFaultForTests(): void {
  configuredFault = undefined;
}

async function invokeFault(boundary: {
  phase: string;
  path?: string;
}): Promise<void> {
  const configured = process.env.BADGER_WORKFLOW_TEST_CHECKPOINT_FAULT_BOUNDARY;
  const value = boundary.path
    ? `${boundary.phase}:${boundary.path}`
    : boundary.phase;
  if (configured === boundary.phase || configured === value) {
    throw new Error("deterministic workflow checkpoint fault");
  }
  await configuredFault?.(boundary);
}

export async function readWorkflowCheckpointIndex(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowCheckpointIndex | null> {
  return readIndexWithBounds(runRoot, parseWorkflowDurabilityProfile(profile));
}

export async function readWorkflowCheckpointRecord(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  entry: WorkflowCheckpointIndexEntry,
): Promise<WorkflowCheckpointRecord> {
  return (await readRecordAndManifest(runRoot, profile, entry)).record;
}

export async function readWorkflowCheckpointManifest(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  entry: WorkflowCheckpointIndexEntry,
): Promise<WorkflowCheckpointManifest> {
  return (await readRecordAndManifest(runRoot, profile, entry)).manifest;
}

export async function readWorkflowCheckpointProfile(
  runRoot: string,
): Promise<WorkflowDurabilityProfile | undefined> {
  const index = await readIndexWithBounds(runRoot);
  if (!index || index.records.length === 0) return undefined;
  for (const entry of index.records) {
    try {
      const raw = await readRaw(
        runRoot,
        manifestPathFor(entry.manifestHash),
        16 * 1024 * 1024,
        "Workflow checkpoint manifest",
      );
      if (raw === null) continue;
      const value = JSON.parse(raw) as Record<string, unknown>;
      const execution = parseExecutionIdentity(
        value.execution,
        "Workflow checkpoint manifest execution",
      );
      if (execution.durabilityProfile) return execution.durabilityProfile;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function verifyWorkflowCheckpointCandidate(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  entry: WorkflowCheckpointIndexEntry,
  options: { expectedRunId?: string; expectedExecution?: RuntimeIdentity } = {},
): Promise<WorkflowCheckpointVerification> {
  const normalizedProfile = parseWorkflowDurabilityProfile(profile);
  const bounds = checkpointBounds(normalizedProfile);
  const { record, manifest } = await readRecordAndManifest(
    runRoot,
    normalizedProfile,
    entry,
  );
  if (options.expectedRunId && manifest.runId !== options.expectedRunId) {
    throw new Error("Workflow checkpoint Run identity is invalid");
  }
  if (
    options.expectedExecution &&
    !sameStableValue(options.expectedExecution, manifest.execution)
  ) {
    throw new Error("Workflow checkpoint execution identity is invalid");
  }
  for (const [reference, manifestIdentity] of [
    [record.state, manifest.state],
    [record.context, manifest.context],
    [record.artifacts, manifest.artifacts],
    [record.trajectory, manifest.trajectory],
  ] as const) {
    if (!materialMatchesManifest(reference, manifestIdentity)) {
      throw new Error("Workflow checkpoint material identity is invalid");
    }
  }
  const stateContent = await readReferencedContent(
    runRoot,
    record.state,
    normalizedProfile.bounds.runStateBytes,
    "Workflow checkpoint state content",
  );
  if (stateContent === null)
    throw new Error("Workflow checkpoint state content is missing");
  const pendingContent = await readReferencedContent(
    runRoot,
    record.pendingAction,
    normalizedProfile.bounds.pendingActionBytes,
    "Workflow checkpoint pending action content",
  );
  const contextContent = await readReferencedContent(
    runRoot,
    record.context,
    Math.max(
      normalizedProfile.bounds.runStateBytes,
      normalizedProfile.bounds.artifactsBytes,
    ),
    "Workflow checkpoint context content",
  );
  const artifactsContent = await readReferencedContent(
    runRoot,
    record.artifacts,
    normalizedProfile.bounds.artifactsBytes,
    "Workflow checkpoint artifacts content",
  );
  const trajectoryContent = await readReferencedContent(
    runRoot,
    record.trajectory,
    normalizedProfile.bounds.trajectoryBytes,
    "Workflow checkpoint trajectory content",
  );
  if (trajectoryContent === null)
    throw new Error("Workflow checkpoint trajectory content is missing");
  validateArtifactContent(artifactsContent);
  const state = parseRunStateValue(JSON.parse(stateContent) as unknown);
  if (
    state.runId !== manifest.runId ||
    state.workflowRuntime?.revision !== manifest.revision
  ) {
    throw new Error("Workflow checkpoint state revision is invalid");
  }
  if (
    state.pendingRef !== PENDING_PATH ||
    state.trajectoryRef !== TRAJECTORY_PATH ||
    state.contextRef !== CONTEXT_PATH ||
    state.artifactsRef !== ARTIFACTS_PATH
  ) {
    throw new Error("Workflow checkpoint state references are invalid");
  }
  const verifiedPackage = await verifyPackageIdentity(runRoot, state, manifest);
  if (!verifiedPackage.package.runtime)
    throw new Error("Workflow checkpoint package has no runtime");
  if (
    !sameStableValue(
      state.runtimeIdentity?.durabilityProfile,
      normalizedProfile,
    )
  ) {
    throw new Error("Workflow checkpoint durability profile is invalid");
  }
  const pending = pendingContent
    ? parsePendingActionValue(JSON.parse(pendingContent) as unknown)
    : null;
  if (Boolean(pending) !== Boolean(state.pending))
    throw new Error("Workflow checkpoint pending state is invalid");
  if (pending && pending.id !== state.pending)
    throw new Error("Workflow checkpoint pending action id is invalid");
  if (
    (pending && state.status !== "waiting") ||
    (!pending && state.status === "waiting") ||
    (state.status === "completed" && state.currentStep !== null) ||
    (state.status === "running" &&
      (state.currentStep === null ||
        !Object.values(verifiedPackage.identity.nodeToStep).includes(
          state.currentStep,
        )))
  ) {
    throw new Error("Workflow checkpoint Run status is invalid");
  }
  if (pending) {
    if (pending.finalization) {
      const finalization = state.workflowRuntime?.finalization;
      if (
        !finalization ||
        finalization.status !== "awaiting-confirmation" ||
        !finalization.pendingConfirmation ||
        !sameStableValue(
          finalization.pendingConfirmation,
          pending.finalization,
        ) ||
        state.currentStep !== null ||
        pending.stepId !== null ||
        pending.attemptId !== undefined ||
        pending.cycleId !== undefined
      ) {
        throw new Error(
          "Workflow checkpoint pending finalization identity is invalid",
        );
      }
    } else {
      const step = verifiedPackage.package.definition.orchestration.steps?.find(
        (candidate) => candidate.id === pending.stepId,
      );
      if (!step || !sameActionDefinition(pending, step)) {
        throw new Error(
          "Workflow checkpoint pending action definition is invalid",
        );
      }
    }
  }
  if (manifest.pendingAction === null) {
    if (pending !== null || record.pendingAction.exists)
      throw new Error("Workflow checkpoint pending identity is invalid");
  } else if (
    !pending ||
    manifest.pendingAction.id !== pending.id ||
    !sameIdentity(manifest.pendingAction, identityOf(record.pendingAction))
  ) {
    throw new Error("Workflow checkpoint pending action identity is invalid");
  }
  const events = parseTrajectory(trajectoryContent, state.runId);
  validateTrajectorySemantics(events, state, pending);
  const trajectoryBytes = Buffer.byteLength(trajectoryContent, "utf8");
  if (
    manifest.trajectory.offset !== trajectoryBytes ||
    manifest.trajectory.prefixSha256 !==
      sha256(Buffer.from(trajectoryContent, "utf8"))
  ) {
    throw new Error("Workflow checkpoint trajectory boundary is invalid");
  }
  const identity = verifiedPackage.identity;
  const nodeId = currentNodeIdentity(state, identity, pending);
  const runtimeState = state.workflowRuntime;
  if (
    manifest.nodeId !== nodeId ||
    manifest.cycleId !==
      (runtimeState?.currentCycle?.id ??
        runtimeState?.currentAttempt?.cycleId ??
        null) ||
    manifest.attemptId !== (runtimeState?.currentAttempt?.id ?? null)
  ) {
    throw new Error("Workflow checkpoint Node or Attempt identity is invalid");
  }
  if (
    verifiedPackage.package.runtime.capabilityVersion !== 3 ||
    !runtimeState
  ) {
    throw new Error("Workflow checkpoint requires revisioned runtime state");
  }
  validateWorkflowArtifactState(
    verifiedPackage.package.runtime.protocol,
    state.runId,
    identity.nodeToStep,
    runtimeState,
  );
  const artifactVersions = await artifactVersionReferences(
    runRoot,
    verifiedPackage.package,
    state,
    normalizedProfile,
  );
  if (!sameStableValue(artifactVersions, manifest.artifactVersions)) {
    throw new Error("Workflow checkpoint artifact identity is invalid");
  }
  return {
    entry,
    manifest,
    record,
    state,
    pending,
    identity,
    package: verifiedPackage.package,
    contents: {
      state: stateContent,
      pendingAction: pendingContent,
      context: contextContent,
      artifacts: artifactsContent,
      trajectory: trajectoryContent,
    },
  };
}

export async function inspectWorkflowCheckpointCandidates(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  options: { expectedRunId?: string; expectedExecution?: RuntimeIdentity } = {},
): Promise<WorkflowCheckpointInspection[]> {
  const index = await readWorkflowCheckpointIndex(runRoot, profile);
  if (!index) return [];
  const expectedRunId = options.expectedRunId ?? index.runId;
  if (index.runId !== expectedRunId) {
    throw new Error("Workflow checkpoint index Run identity is invalid");
  }
  return Promise.all(
    index.records.map(async (entry) => {
      try {
        return {
          entry,
          verification: await verifyWorkflowCheckpointCandidate(
            runRoot,
            profile,
            entry,
            { ...options, expectedRunId },
          ),
        };
      } catch (error) {
        return {
          entry,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

async function activeRecoveryRecordHash(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<string | undefined> {
  return (await readWorkflowCheckpointRecoveryJournal(runRoot, profile))
    ?.checkpointRecordHash;
}

async function cleanupRetainedCheckpoints(
  runRoot: string,
  removed: readonly WorkflowCheckpointIndexEntry[],
  retained: readonly WorkflowCheckpointIndexEntry[],
  profile: WorkflowDurabilityProfile,
): Promise<void> {
  const retainedContent = new Set<string>();
  for (const entry of retained) {
    try {
      const record = await readWorkflowCheckpointRecord(
        runRoot,
        profile,
        entry,
      );
      for (const reference of [
        record.state,
        record.pendingAction,
        record.context,
        record.artifacts,
        record.trajectory,
      ]) {
        if (reference.contentPath) retainedContent.add(reference.contentPath);
      }
    } catch {
      return;
    }
  }
  for (const entry of removed) {
    let record: WorkflowCheckpointRecord;
    try {
      record = await readWorkflowCheckpointRecord(runRoot, profile, entry);
    } catch {
      continue;
    }
    await removeEngineRunFile(
      runRoot,
      recordPathFor(entry.recordHash),
      "Workflow checkpoint record",
    );
    await removeEngineRunFile(
      runRoot,
      manifestPathFor(entry.manifestHash),
      "Workflow checkpoint manifest",
    );
    for (const reference of [
      record.state,
      record.pendingAction,
      record.context,
      record.artifacts,
      record.trajectory,
    ]) {
      if (
        reference.contentPath &&
        !retainedContent.has(reference.contentPath)
      ) {
        await removeEngineRunFile(
          runRoot,
          reference.contentPath,
          "Workflow checkpoint content",
        );
      }
    }
  }
}

export async function createWorkflowCheckpoint(options: {
  runRoot: string;
  state: RunState;
  pending: EngineAction | null;
  identity: RuntimeIdentity;
  package: SkillPackage;
  profile: WorkflowDurabilityProfile;
}): Promise<WorkflowCheckpointManifest> {
  const profile = parseWorkflowDurabilityProfile(options.profile);
  const bounds = checkpointBounds(profile);
  const built = await buildCheckpoint({ ...options, profile });
  for (const [contentPath, content] of built.contents) {
    const originalPath =
      contentPath === built.record.state.contentPath
        ? built.record.state.path
        : contentPath === built.record.pendingAction.contentPath
          ? built.record.pendingAction.path
          : contentPath === built.record.context.contentPath
            ? built.record.context.path
            : contentPath === built.record.artifacts.contentPath
              ? built.record.artifacts.path
              : built.record.trajectory.path;
    await publishContent(
      options.runRoot,
      {
        path: originalPath,
        contentPath,
        ...contentIdentity(content),
      },
      content,
      maxBytesForPath(profile, originalPath),
    );
  }
  await ensureProtectedProjectDirectory(
    options.runRoot,
    WORKFLOW_CHECKPOINT_MANIFEST_DIRECTORY,
    {
      label: "Workflow checkpoint manifest",
    },
  );
  await ensureProtectedProjectDirectory(
    options.runRoot,
    WORKFLOW_CHECKPOINT_RECORD_DIRECTORY,
    {
      label: "Workflow checkpoint record",
    },
  );
  const manifestHash = built.manifest.manifestHash;
  const recordHash = built.record.recordHash;
  await publishJson(
    options.runRoot,
    manifestPathFor(manifestHash),
    built.manifest,
    bounds.manifestBytes,
    "Workflow checkpoint manifest",
  );
  await publishJson(
    options.runRoot,
    recordPathFor(recordHash),
    built.record,
    bounds.recordBytes,
    "Workflow checkpoint record",
  );
  const existing = await readWorkflowCheckpointIndex(options.runRoot, profile);
  if (existing && existing.runId !== options.state.runId) {
    throw new Error("Workflow checkpoint index Run identity is invalid");
  }
  const entry: WorkflowCheckpointIndexEntry = {
    recordHash,
    manifestHash,
    revision: built.manifest.revision,
  };
  const all = [
    ...(existing?.records ?? []).filter(
      (candidate) => candidate.recordHash !== recordHash,
    ),
    entry,
  ];
  all.sort(
    (left, right) =>
      right.revision - left.revision ||
      left.recordHash.localeCompare(right.recordHash),
  );
  const active = await activeRecoveryRecordHash(options.runRoot, profile);
  if (active && !all.some((candidate) => candidate.recordHash === active)) {
    throw new Error(
      "Workflow checkpoint retention cannot preserve the active recovery anchor",
    );
  }
  if (active) {
    const activeEntry = all.find(
      (candidate) => candidate.recordHash === active,
    )!;
    try {
      await readWorkflowCheckpointRecord(options.runRoot, profile, activeEntry);
    } catch (error) {
      throw new Error(
        "Workflow checkpoint retention cannot verify the active recovery anchor",
        { cause: error },
      );
    }
  }
  const top = all.slice(0, bounds.count);
  if (
    active &&
    bounds.count === 1 &&
    !top.some((candidate) => candidate.recordHash === active)
  ) {
    throw new Error(
      "Workflow checkpoint retention cannot preserve the active recovery anchor",
    );
  }
  let retained = top;
  if (
    active &&
    all.some((candidate) => candidate.recordHash === active) &&
    !retained.some((candidate) => candidate.recordHash === active)
  ) {
    retained = [
      ...retained.slice(0, Math.max(0, bounds.count - 1)),
      all.find((candidate) => candidate.recordHash === active)!,
    ];
    retained.sort(
      (left, right) =>
        right.revision - left.revision ||
        left.recordHash.localeCompare(right.recordHash),
    );
  }
  const removed = all.filter(
    (candidate) =>
      !retained.some((kept) => kept.recordHash === candidate.recordHash),
  );
  const index: WorkflowCheckpointIndex = {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    kind: "workflow-checkpoint-index",
    runId: options.state.runId,
    records: retained,
  };
  await ensureProtectedProjectDirectory(
    options.runRoot,
    WORKFLOW_CHECKPOINT_DIRECTORY,
    {
      label: "Workflow checkpoint index",
    },
  );
  await publishJson(
    options.runRoot,
    WORKFLOW_CHECKPOINT_INDEX_PATH,
    index,
    bounds.recordBytes,
    "Workflow checkpoint index",
  );
  await cleanupRetainedCheckpoints(options.runRoot, removed, retained, profile);
  return built.manifest;
}

export async function verifyWorkflowCheckpointHead(options: {
  runRoot: string;
  state: RunState;
  pending: EngineAction | null;
  identity: RuntimeIdentity;
  package: SkillPackage;
  profile: WorkflowDurabilityProfile;
}): Promise<void> {
  await buildCheckpoint({
    ...options,
    profile: parseWorkflowDurabilityProfile(options.profile),
  });
}

function recoveryJournalFor(
  runId: string,
  identity: RuntimeIdentity,
  checkpointRecordHash: string,
  records: readonly WorkflowCheckpointRecoveryJournalRecord[],
  recoveryEvent: TrajectoryEvent,
): WorkflowCheckpointRecoveryJournal {
  return {
    schemaVersion: WORKFLOW_CHECKPOINT_RECOVERY_SCHEMA_VERSION,
    kind: "workflow-checkpoint-recovery-journal",
    status: "prepared",
    journalId: randomUUID(),
    runId,
    execution: structuredClone(identity),
    checkpointRecordHash,
    records: [...records].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    recoveryEvent,
    createdAt: new Date().toISOString(),
  };
}

async function writeRecoveryJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowCheckpointRecoveryJournal,
  exclusive = false,
): Promise<void> {
  const bounds = checkpointBounds(profile);
  parseRecoveryJournal(journal, bounds);
  await writeEngineRunText(
    runRoot,
    WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH,
    canonical(journal),
    bounds.recordBytes,
    "Workflow checkpoint recovery journal",
    { exclusive, maxBytes: bounds.recordBytes },
  );
}

export async function readWorkflowCheckpointRecoveryJournal(
  runRoot: string,
  profile?: WorkflowDurabilityProfile,
): Promise<WorkflowCheckpointRecoveryJournal | null> {
  const raw = await readRaw(
    runRoot,
    WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH,
    profile ? checkpointBounds(profile).recordBytes : 16 * 1024 * 1024,
    "Workflow checkpoint recovery journal",
  );
  if (raw === null) return null;
  const value = JSON.parse(raw) as unknown;
  const execution = isRecord(value)
    ? parseExecutionIdentity(
        value.execution,
        "Workflow checkpoint recovery execution",
      )
    : undefined;
  const effectiveProfile = profile ?? execution?.durabilityProfile;
  if (!effectiveProfile)
    throw new Error("Workflow checkpoint recovery has no durability profile");
  const bounds = checkpointBounds(effectiveProfile);
  if (Buffer.byteLength(raw, "utf8") > bounds.recordBytes)
    throw new Error("Workflow checkpoint recovery journal is oversized");
  return parseRecoveryJournal(value, bounds);
}

async function clearRecoveryJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowCheckpointRecoveryJournal,
): Promise<void> {
  const current = await readWorkflowCheckpointRecoveryJournal(runRoot, profile);
  if (
    !current ||
    current.journalId !== journal.journalId ||
    current.status !== "committed"
  ) {
    throw new Error(
      "Workflow checkpoint recovery journal changed before clearance",
    );
  }
  await invokeFault({ phase: "checkpoint-recovery-journal-clearance" });
  await removeEngineRunFile(
    runRoot,
    WORKFLOW_CHECKPOINT_RECOVERY_JOURNAL_PATH,
    "Workflow checkpoint recovery journal",
  );
}

async function settleRecoveryJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowCheckpointRecoveryJournal,
): Promise<WorkflowCheckpointRecoveryResult> {
  const index = await readWorkflowCheckpointIndex(runRoot, profile);
  const indexed = index?.records.find(
    (entry) => entry.recordHash === journal.checkpointRecordHash,
  );
  if (!indexed)
    throw new Error("Workflow checkpoint recovery record is not retained");
  const candidate = await verifyWorkflowCheckpointCandidate(
    runRoot,
    profile,
    indexed,
  );
  if (
    journal.runId !== candidate.state.runId ||
    !sameStableValue(journal.execution, candidate.identity)
  ) {
    throw new Error("Workflow checkpoint recovery identity is invalid");
  }
  const unknownPaths: string[] = [];
  const currentMaterials = new Map<string, string | null>();
  for (const record of journal.records) {
    const current = await readMaterial(
      runRoot,
      record.path,
      maxBytesForPath(profile, record.path),
      `Workflow checkpoint recovery record ${record.path}`,
    );
    if (
      !sameIdentity(current.identity, record.previous) &&
      !sameIdentity(current.identity, record.intended)
    ) {
      unknownPaths.push(record.path);
    }
    currentMaterials.set(record.path, current.content);
  }
  if (unknownPaths.length > 0)
    return { status: "blocked", journal, unknownPaths };
  for (const record of journal.records) {
    const current = currentMaterials.get(record.path);
    if (
      sameIdentity(
        { path: record.path, ...contentIdentity(current ?? null) },
        record.intended,
      )
    )
      continue;
    const contentPath = record.contentPath;
    if (!record.intended.exists || !contentPath) {
      await removeEngineRunFile(
        runRoot,
        record.path,
        `Workflow checkpoint recovery record ${record.path}`,
      );
    } else {
      const content =
        record.path === TRAJECTORY_PATH
          ? await readReferencedContent(
              runRoot,
              { ...record.intended, contentPath },
              profile.bounds.trajectoryBytes,
              "Workflow checkpoint recovery trajectory",
            )
          : await readRaw(
              runRoot,
              contentPath,
              maxBytesForPath(profile, record.path),
              `Workflow checkpoint recovery content ${record.path}`,
            );
      if (content === null)
        throw new Error(
          `Workflow checkpoint recovery content is missing: ${record.path}`,
        );
      const contentIdentityValue = contentIdentity(content);
      if (
        !record.intended.exists ||
        contentIdentityValue.bytes !== record.intended.bytes ||
        contentIdentityValue.sha256 !== record.intended.sha256
      ) {
        throw new Error(
          `Workflow checkpoint recovery content identity is invalid: ${record.path}`,
        );
      }
      await writeEngineRunText(
        runRoot,
        record.path,
        content,
        maxBytesForPath(profile, record.path),
        `Workflow checkpoint recovery record ${record.path}`,
      );
    }
    await invokeFault({
      phase: "checkpoint-recovery-record-write",
      path: record.path,
    });
    const verified = await readMaterial(
      runRoot,
      record.path,
      maxBytesForPath(profile, record.path),
      `Workflow checkpoint recovery record ${record.path}`,
    );
    if (!sameIdentity(verified.identity, record.intended)) {
      throw new Error(
        `Workflow checkpoint recovery record changed: ${record.path}`,
      );
    }
    await invokeFault({
      phase: "checkpoint-recovery-record-verification",
      path: record.path,
    });
  }
  const committedAt = journal.committedAt ?? new Date().toISOString();
  const committed: WorkflowCheckpointRecoveryJournal = {
    ...journal,
    status: "committed",
    committedAt,
  };
  await invokeFault({ phase: "checkpoint-recovery-commit-evidence" });
  await writeRecoveryJournal(runRoot, profile, committed);
  await clearRecoveryJournal(runRoot, profile, committed);
  return { status: "recovered", journal: committed };
}

export async function recoverWorkflowCheckpoint(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowCheckpointRecoveryResult> {
  const journal = await readWorkflowCheckpointRecoveryJournal(runRoot, profile);
  if (!journal) return { status: "none" };
  return settleRecoveryJournal(runRoot, profile, journal);
}

async function proveNoLaterTrajectory(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  candidate: WorkflowCheckpointVerification,
): Promise<void> {
  const transitionJournal = await readRaw(
    runRoot,
    TRANSITION_JOURNAL_PATH,
    profile.bounds.transitionJournalBytes ?? profile.bounds.runStateBytes,
    "Workflow transition journal",
  );
  if (transitionJournal !== null) {
    throw new Error("Workflow checkpoint history is ambiguous");
  }
  const current = await readRaw(
    runRoot,
    candidate.record.trajectory.path,
    profile.bounds.trajectoryBytes,
    "Workflow checkpoint current trajectory",
  );
  if (
    current === null ||
    current !== candidate.contents.trajectory ||
    Buffer.byteLength(current, "utf8") !== candidate.manifest.trajectory.offset
  ) {
    throw new Error("Workflow checkpoint history is ambiguous");
  }
}

export async function restoreWorkflowCheckpoint(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  candidate: WorkflowCheckpointVerification,
): Promise<WorkflowCheckpointRecoveryResult> {
  const existing = await readWorkflowCheckpointRecoveryJournal(
    runRoot,
    profile,
  );
  if (existing) return settleRecoveryJournal(runRoot, profile, existing);
  await proveNoLaterTrajectory(runRoot, profile, candidate);
  const paths = [
    candidate.record.state,
    candidate.record.pendingAction,
    candidate.record.context,
    candidate.record.artifacts,
  ];
  const trajectoryEvent: TrajectoryEvent = {
    sequence:
      parseTrajectory(candidate.contents.trajectory, candidate.state.runId)
        .length + 1,
    timestamp: new Date().toISOString(),
    type: "recovery_reconciled",
    runId: candidate.state.runId,
    data: {
      kind: "workflow-checkpoint-restored",
      checkpointRecordHash: candidate.entry.recordHash,
      revision: candidate.manifest.revision,
      paths: [...paths.map((reference) => reference.path), TRAJECTORY_PATH],
    },
  };
  const nextTrajectory = `${candidate.contents.trajectory}${JSON.stringify(trajectoryEvent)}\n`;
  const trajectoryReference: WorkflowCheckpointMaterialReference = {
    path: candidate.record.trajectory.path,
    contentPath: contentPathFor(sha256(Buffer.from(nextTrajectory, "utf8"))),
    ...contentIdentity(nextTrajectory),
  };
  await publishContent(
    runRoot,
    trajectoryReference,
    nextTrajectory,
    profile.bounds.trajectoryBytes,
  );
  const records: WorkflowCheckpointRecoveryJournalRecord[] = [];
  for (const reference of [...paths, candidate.record.trajectory]) {
    const current = await readMaterial(
      runRoot,
      reference.path,
      maxBytesForPath(profile, reference.path),
      `Workflow checkpoint current record ${reference.path}`,
    );
    const intended =
      reference.path === TRAJECTORY_PATH ? trajectoryReference : reference;
    records.push({
      path: reference.path,
      previous: current.identity,
      intended: identityOf(intended),
      contentPath: intended.contentPath,
    });
  }
  const journal = recoveryJournalFor(
    candidate.state.runId,
    candidate.identity,
    candidate.entry.recordHash,
    records,
    trajectoryEvent,
  );
  await writeRecoveryJournal(runRoot, profile, journal, true);
  await invokeFault({ phase: "checkpoint-recovery-journal-prepared" });
  return settleRecoveryJournal(runRoot, profile, journal);
}
