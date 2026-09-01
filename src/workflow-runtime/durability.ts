import { stableValue } from "../util.js";
import type { WorkflowDurabilityProfile, WorkflowProtocol } from "../types.js";
import { WORKFLOW_FINDING_CATALOG_VERSION } from "./findings.js";
import { parseWorkflowContentSnapshotPolicy } from "./snapshots.js";

export const WORKFLOW_DURABILITY_PROFILE_VERSION = 1 as const;
export const WORKFLOW_DURABILITY_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_DURABILITY_MAX_RECORD_BYTES = 16 * 1024 * 1024;

const PROFILE_KEYS = new Set([
  "version",
  "capabilities",
  "bounds",
  "schemaVersions",
  "findingCatalogVersion",
  "snapshotPolicy",
]);
const CAPABILITIES = new Set([
  "mutation-locks",
  "revision-fences",
  "transition-journal",
  "verified-checkpoints",
  "content-snapshots",
]);
const BOUND_KEY_NAMES = [
  "runStateBytes",
  "pendingActionBytes",
  "trajectoryBytes",
  "artifactsBytes",
  "claimBytes",
] as const;
const BOUND_KEYS = new Set<string>([
  ...BOUND_KEY_NAMES,
  "transitionJournalBytes",
  "runLockBytes",
  "checkpointManifestBytes",
  "checkpointRecordBytes",
  "checkpointCount",
]);
const SCHEMA_KEY_NAMES = [
  "runState",
  "pendingAction",
  "trajectory",
  "artifacts",
  "revisionClaim",
] as const;
const SCHEMA_KEYS = new Set<string>([
  ...SCHEMA_KEY_NAMES,
  "runLock",
  "transitionJournal",
  "checkpointManifest",
  "checkpointRecord",
  "contentSnapshot",
]);
const MAX_PROFILE_BOUND = WORKFLOW_DURABILITY_MAX_RECORD_BYTES;
const MAX_CHECKPOINT_COUNT = 256;

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

function requiredBound(value: unknown, key: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PROFILE_BOUND
  ) {
    throw new Error(
      `Invalid Workflow durability profile: bounds.${key} must be a positive bounded integer`,
    );
  }
  return value;
}

function requiredCheckpointCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CHECKPOINT_COUNT
  ) {
    throw new Error(
      "Invalid Workflow durability profile: bounds.checkpointCount must be a positive bounded integer",
    );
  }
  return value;
}

export function parseWorkflowDurabilityProfile(
  value: unknown,
): WorkflowDurabilityProfile {
  if (!isRecord(value)) {
    throw new Error("Invalid Workflow durability profile: must be an object");
  }
  assertKnownFields(value, PROFILE_KEYS, "Workflow durability profile");
  if (value.version !== WORKFLOW_DURABILITY_PROFILE_VERSION) {
    throw new Error(
      `Unsupported Workflow durability profile version: ${String(value.version)}`,
    );
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error(
      "Invalid Workflow durability profile: capabilities must be a non-empty array",
    );
  }
  const capabilities = value.capabilities.map(
    (capability): WorkflowDurabilityProfile["capabilities"][number] => {
      if (typeof capability !== "string" || !CAPABILITIES.has(capability)) {
        throw new Error(
          `Invalid Workflow durability profile: unsupported capability ${String(capability)}`,
        );
      }
      return capability as WorkflowDurabilityProfile["capabilities"][number];
    },
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(
      "Invalid Workflow durability profile: capabilities must not contain duplicates",
    );
  }
  if (!isRecord(value.bounds)) {
    throw new Error(
      "Invalid Workflow durability profile: bounds must be an object",
    );
  }
  const boundsValue = value.bounds;
  assertKnownFields(
    boundsValue,
    BOUND_KEYS,
    "Workflow durability profile bounds",
  );
  const bounds = Object.fromEntries(
    BOUND_KEY_NAMES.map((key) => [key, requiredBound(boundsValue[key], key)]),
  ) as unknown as WorkflowDurabilityProfile["bounds"];
  if (boundsValue.transitionJournalBytes !== undefined) {
    bounds.transitionJournalBytes = requiredBound(
      boundsValue.transitionJournalBytes,
      "transitionJournalBytes",
    );
  }
  if (boundsValue.runLockBytes !== undefined) {
    bounds.runLockBytes = requiredBound(
      boundsValue.runLockBytes,
      "runLockBytes",
    );
  }
  if (boundsValue.checkpointManifestBytes !== undefined) {
    bounds.checkpointManifestBytes = requiredBound(
      boundsValue.checkpointManifestBytes,
      "checkpointManifestBytes",
    );
  }
  if (boundsValue.checkpointRecordBytes !== undefined) {
    bounds.checkpointRecordBytes = requiredBound(
      boundsValue.checkpointRecordBytes,
      "checkpointRecordBytes",
    );
  }
  if (boundsValue.checkpointCount !== undefined) {
    bounds.checkpointCount = requiredCheckpointCount(
      boundsValue.checkpointCount,
    );
  }
  if (!isRecord(value.schemaVersions)) {
    throw new Error(
      "Invalid Workflow durability profile: schemaVersions must be an object",
    );
  }
  assertKnownFields(
    value.schemaVersions,
    SCHEMA_KEYS,
    "Workflow durability profile schemaVersions",
  );
  const schemaVersions = value.schemaVersions;
  for (const key of SCHEMA_KEY_NAMES) {
    if (schemaVersions[key] !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
      throw new Error(`Unsupported Workflow durability schema version: ${key}`);
    }
  }
  const transitionJournal = value.schemaVersions.transitionJournal;
  if (
    transitionJournal !== undefined &&
    transitionJournal !== WORKFLOW_DURABILITY_SCHEMA_VERSION
  ) {
    throw new Error(
      "Unsupported Workflow durability schema version: transitionJournal",
    );
  }
  const runLock = value.schemaVersions.runLock;
  if (runLock !== undefined && runLock !== WORKFLOW_DURABILITY_SCHEMA_VERSION) {
    throw new Error("Unsupported Workflow durability schema version: runLock");
  }
  const checkpointManifest = value.schemaVersions.checkpointManifest;
  if (
    checkpointManifest !== undefined &&
    checkpointManifest !== WORKFLOW_DURABILITY_SCHEMA_VERSION
  ) {
    throw new Error(
      "Unsupported Workflow durability schema version: checkpointManifest",
    );
  }
  const checkpointRecord = value.schemaVersions.checkpointRecord;
  if (
    checkpointRecord !== undefined &&
    checkpointRecord !== WORKFLOW_DURABILITY_SCHEMA_VERSION
  ) {
    throw new Error(
      "Unsupported Workflow durability schema version: checkpointRecord",
    );
  }
  const contentSnapshot = value.schemaVersions.contentSnapshot;
  if (
    contentSnapshot !== undefined &&
    contentSnapshot !== WORKFLOW_DURABILITY_SCHEMA_VERSION
  ) {
    throw new Error(
      "Unsupported Workflow durability schema version: contentSnapshot",
    );
  }
  if (
    capabilities.includes("transition-journal") &&
    (bounds.transitionJournalBytes === undefined ||
      transitionJournal !== WORKFLOW_DURABILITY_SCHEMA_VERSION)
  ) {
    throw new Error(
      "Invalid Workflow durability profile: transition-journal requires its bound and schema version",
    );
  }
  if (
    capabilities.includes("mutation-locks") &&
    (bounds.runLockBytes === undefined ||
      runLock !== WORKFLOW_DURABILITY_SCHEMA_VERSION)
  ) {
    throw new Error(
      "Invalid Workflow durability profile: mutation-locks requires its bound and schema version",
    );
  }
  if (
    capabilities.includes("verified-checkpoints") &&
    (!capabilities.includes("mutation-locks") ||
      !capabilities.includes("revision-fences") ||
      !capabilities.includes("transition-journal") ||
      bounds.checkpointManifestBytes === undefined ||
      bounds.checkpointRecordBytes === undefined ||
      bounds.checkpointCount === undefined ||
      checkpointManifest !== WORKFLOW_DURABILITY_SCHEMA_VERSION ||
      checkpointRecord !== WORKFLOW_DURABILITY_SCHEMA_VERSION)
  ) {
    throw new Error(
      "Invalid Workflow durability profile: verified-checkpoints requires mutation locks, transition journal, checkpoint bounds, and schema versions",
    );
  }
  const snapshotPolicy =
    value.snapshotPolicy === undefined
      ? undefined
      : parseWorkflowContentSnapshotPolicy(value.snapshotPolicy);
  if (
    snapshotPolicy !== undefined &&
    !capabilities.includes("content-snapshots")
  ) {
    throw new Error(
      "Invalid Workflow durability profile: snapshotPolicy requires content-snapshots",
    );
  }
  if (
    capabilities.includes("content-snapshots") &&
    (!capabilities.includes("mutation-locks") ||
      !capabilities.includes("revision-fences") ||
      !capabilities.includes("transition-journal") ||
      snapshotPolicy === undefined ||
      contentSnapshot !== WORKFLOW_DURABILITY_SCHEMA_VERSION)
  ) {
    throw new Error(
      "Invalid Workflow durability profile: content-snapshots requires mutation locks, revision fences, transition journal, snapshot policy, and schema version",
    );
  }
  if (value.findingCatalogVersion !== WORKFLOW_FINDING_CATALOG_VERSION) {
    throw new Error(
      `Unsupported Workflow durability finding catalog version: ${String(value.findingCatalogVersion)}`,
    );
  }
  return {
    version: WORKFLOW_DURABILITY_PROFILE_VERSION,
    capabilities: [...capabilities].sort(),
    bounds,
    schemaVersions: {
      runState: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      pendingAction: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      trajectory: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      artifacts: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      revisionClaim: WORKFLOW_DURABILITY_SCHEMA_VERSION,
      ...(runLock === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { runLock: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
      ...(transitionJournal === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { transitionJournal: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
      ...(checkpointManifest === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { checkpointManifest: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
      ...(checkpointRecord === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { checkpointRecord: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
      ...(contentSnapshot === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { contentSnapshot: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
    },
    findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    ...(snapshotPolicy ? { snapshotPolicy } : {}),
  };
}

export function normalizeWorkflowDurabilityProtocol(
  protocol: WorkflowProtocol,
): WorkflowProtocol {
  const durability = protocol.capabilities?.durability;
  if (durability === undefined) return protocol;
  return {
    ...structuredClone(protocol),
    capabilities: {
      ...structuredClone(protocol.capabilities!),
      durability: parseWorkflowDurabilityProfile(durability),
    },
  };
}

export function durabilityProfileForProtocol(
  protocol: WorkflowProtocol,
): WorkflowDurabilityProfile | undefined {
  const durability = protocol.capabilities?.durability;
  return durability === undefined
    ? undefined
    : parseWorkflowDurabilityProfile(durability);
}

export function isPhase4WorkflowProtocol(protocol: WorkflowProtocol): boolean {
  return protocol.capabilities?.durability !== undefined;
}

export function sameDurabilityProfile(
  left: WorkflowDurabilityProfile | undefined,
  right: WorkflowDurabilityProfile | undefined,
): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}
