import { stableValue } from "../util.js";
import type {
  WorkflowDurabilityProfile,
  WorkflowProtocol,
  WorkflowRepairPolicy,
} from "../types.js";
import { WORKFLOW_FINDING_CATALOG_VERSION } from "./findings.js";
import { normalizeWorkflowRepairPolicy } from "./repair.js";
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
  "verificationPolicy",
  "repairPolicy",
  "repair",
]);
const CAPABILITIES = new Set([
  "mutation-locks",
  "revision-fences",
  "transition-journal",
  "verified-checkpoints",
  "content-snapshots",
  "verification-receipts",
  "repair-policy",
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
  "verificationReceiptBytes",
  "verificationReceiptCount",
  "repairHistoryBytes",
  "repairHistoryCount",
  "repairEpisodeBytes",
  "repairEpisodeCount",
  "repairHistoryRecords",
  "repairEpisodeRecords",
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
  "verificationReceipt",
  "repairEpisode",
  "repairHistory",
]);
const MAX_PROFILE_BOUND = WORKFLOW_DURABILITY_MAX_RECORD_BYTES;
const MAX_CHECKPOINT_COUNT = 256;
const MAX_VERIFICATION_RECEIPT_COUNT = 256;
const MAX_REPAIR_HISTORY_COUNT = 1_024;
const VERIFICATION_POLICY_KEYS = new Set([
  "maxSummaryBytes",
  "maxEvidenceBytes",
]);

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

function requiredVerificationReceiptCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_VERIFICATION_RECEIPT_COUNT
  ) {
    throw new Error(
      "Invalid Workflow durability profile: bounds.verificationReceiptCount must be a positive bounded integer",
    );
  }
  return value;
}

function parseVerificationPolicy(value: unknown): {
  maxSummaryBytes: number;
  maxEvidenceBytes: number;
} {
  if (!isRecord(value)) {
    throw new Error("Invalid Workflow verification policy: must be an object");
  }
  assertKnownFields(
    value,
    VERIFICATION_POLICY_KEYS,
    "Workflow verification policy",
  );
  const maxSummaryBytes = requiredBound(
    value.maxSummaryBytes,
    "verificationPolicy.maxSummaryBytes",
  );
  const maxEvidenceBytes = requiredBound(
    value.maxEvidenceBytes,
    "verificationPolicy.maxEvidenceBytes",
  );
  if (maxSummaryBytes > maxEvidenceBytes) {
    throw new Error(
      "Invalid Workflow verification policy: maxSummaryBytes cannot exceed maxEvidenceBytes",
    );
  }
  return {
    maxSummaryBytes,
    maxEvidenceBytes,
  };
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
  if (boundsValue.verificationReceiptBytes !== undefined) {
    bounds.verificationReceiptBytes = requiredBound(
      boundsValue.verificationReceiptBytes,
      "verificationReceiptBytes",
    );
  }
  if (boundsValue.verificationReceiptCount !== undefined) {
    bounds.verificationReceiptCount = requiredVerificationReceiptCount(
      boundsValue.verificationReceiptCount,
    );
  }
  const repairHistoryBytes =
    boundsValue.repairHistoryBytes ?? boundsValue.repairEpisodeBytes;
  if (
    boundsValue.repairHistoryBytes !== undefined &&
    boundsValue.repairEpisodeBytes !== undefined &&
    boundsValue.repairHistoryBytes !== boundsValue.repairEpisodeBytes
  ) {
    throw new Error(
      "Invalid Workflow durability profile: repair history byte aliases disagree",
    );
  }
  if (repairHistoryBytes !== undefined) {
    bounds.repairHistoryBytes = requiredBound(
      repairHistoryBytes,
      "repairHistoryBytes",
    );
  }
  const repairHistoryCount =
    boundsValue.repairHistoryCount ??
    boundsValue.repairEpisodeCount ??
    boundsValue.repairHistoryRecords ??
    boundsValue.repairEpisodeRecords;
  const repairCountAliases = [
    boundsValue.repairHistoryCount,
    boundsValue.repairEpisodeCount,
    boundsValue.repairHistoryRecords,
    boundsValue.repairEpisodeRecords,
  ].filter((value): value is number => value !== undefined);
  if (repairCountAliases.some((value) => value !== repairCountAliases[0])) {
    throw new Error(
      "Invalid Workflow durability profile: repair history count aliases disagree",
    );
  }
  if (repairHistoryCount !== undefined) {
    if (
      typeof repairHistoryCount !== "number" ||
      !Number.isSafeInteger(repairHistoryCount) ||
      repairHistoryCount < 1 ||
      repairHistoryCount > MAX_REPAIR_HISTORY_COUNT
    ) {
      throw new Error(
        "Invalid Workflow durability profile: bounds.repairHistoryCount must be a positive bounded integer",
      );
    }
    bounds.repairHistoryCount = repairHistoryCount;
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
  const verificationReceipt = value.schemaVersions.verificationReceipt;
  if (
    verificationReceipt !== undefined &&
    verificationReceipt !== WORKFLOW_DURABILITY_SCHEMA_VERSION
  ) {
    throw new Error(
      "Unsupported Workflow durability schema version: verificationReceipt",
    );
  }
  const repairEpisode =
    value.schemaVersions.repairEpisode ??
    value.schemaVersions.repairHistory ??
    value.schemaVersions.repair;
  const repairSchemaAliases = [
    value.schemaVersions.repairEpisode,
    value.schemaVersions.repairHistory,
    value.schemaVersions.repair,
  ].filter((value): value is number => value !== undefined);
  if (repairSchemaAliases.some((value) => value !== repairSchemaAliases[0])) {
    throw new Error(
      "Invalid Workflow durability profile: repair schema aliases disagree",
    );
  }
  if (
    repairEpisode !== undefined &&
    repairEpisode !== WORKFLOW_DURABILITY_SCHEMA_VERSION
  ) {
    throw new Error(
      "Unsupported Workflow durability schema version: repairEpisode",
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
  let verificationPolicy:
    WorkflowDurabilityProfile["verificationPolicy"] | undefined;
  if (value.verificationPolicy !== undefined) {
    verificationPolicy = parseVerificationPolicy(value.verificationPolicy);
    if (!capabilities.includes("verification-receipts")) {
      throw new Error(
        "Invalid Workflow durability profile: verificationPolicy requires verification-receipts",
      );
    }
  }
  if (
    capabilities.includes("verification-receipts") &&
    (!capabilities.includes("mutation-locks") ||
      !capabilities.includes("revision-fences") ||
      !capabilities.includes("transition-journal") ||
      bounds.verificationReceiptBytes === undefined ||
      bounds.verificationReceiptCount === undefined ||
      verificationReceipt !== WORKFLOW_DURABILITY_SCHEMA_VERSION)
  ) {
    throw new Error(
      "Invalid Workflow durability profile: verification-receipts requires mutation locks, revision fences, transition journal, receipt bounds, and schema version",
    );
  }
  const repairPolicyValue = value.repairPolicy ?? value.repair;
  if (
    value.repairPolicy !== undefined &&
    value.repair !== undefined &&
    JSON.stringify(stableValue(value.repairPolicy)) !==
      JSON.stringify(stableValue(value.repair))
  ) {
    throw new Error(
      "Invalid Workflow durability profile: repair policy aliases disagree",
    );
  }
  const repairPolicy =
    repairPolicyValue === undefined
      ? undefined
      : normalizeWorkflowRepairPolicy(
          repairPolicyValue as WorkflowRepairPolicy,
        );
  if (repairPolicy !== undefined && !capabilities.includes("repair-policy")) {
    throw new Error(
      "Invalid Workflow durability profile: repairPolicy requires repair-policy capability",
    );
  }
  if (
    capabilities.includes("repair-policy") &&
    (!capabilities.includes("mutation-locks") ||
      !capabilities.includes("revision-fences") ||
      !capabilities.includes("transition-journal") ||
      repairPolicy === undefined ||
      bounds.repairHistoryBytes === undefined ||
      bounds.repairHistoryCount === undefined ||
      (repairPolicy !== undefined &&
        repairPolicy.maxFailures > bounds.repairHistoryCount) ||
      repairEpisode !== WORKFLOW_DURABILITY_SCHEMA_VERSION)
  ) {
    throw new Error(
      "Invalid Workflow durability profile: repair-policy requires mutation locks, revision fences, transition journal, repair policy, repair history bounds, and schema version",
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
      ...(verificationReceipt === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { verificationReceipt: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
      ...(repairEpisode === WORKFLOW_DURABILITY_SCHEMA_VERSION
        ? { repairEpisode: WORKFLOW_DURABILITY_SCHEMA_VERSION }
        : {}),
    },
    findingCatalogVersion: WORKFLOW_FINDING_CATALOG_VERSION,
    ...(snapshotPolicy ? { snapshotPolicy } : {}),
    ...(verificationPolicy ? { verificationPolicy } : {}),
    ...(repairPolicy ? { repairPolicy } : {}),
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
