import {
  readOptionalEngineRunText,
  type EngineRunMutationOverlay,
} from "../engine/protected-run-file.js";
import type {
  WorkflowArtifactProducer,
  WorkflowDecisionScopeReference,
  WorkflowDecisionScopeSnapshot,
  WorkflowDurabilityProfile,
  WorkflowVerificationArtifactReference,
  WorkflowVerificationEvidence,
  WorkflowVerificationKind,
  WorkflowVerificationReceipt,
  WorkflowVerificationReceiptProposal,
  WorkflowVerificationReceiptReference,
  WorkflowVerificationStatus,
} from "../types.js";
import { sha256, stableValue } from "../util.js";
import { parseWorkflowDurabilityProfile } from "./durability.js";
import { parseExecutionIdentity } from "./revision-claim.js";

export const WORKFLOW_VERIFICATION_RECEIPT_DIRECTORY =
  ".comet/verification-receipts";
export const WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_VERIFICATION_RECEIPT_MAX_REFERENCES = 256;
export const WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES = 64;
export const WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_SUMMARY_BYTES = 4 * 1024;
export const WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_EVIDENCE_BYTES = 8 * 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_RAW_SUMMARY_BYTES = 16 * 1024 * 1024;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const RECEIPT_LABEL = "Workflow Verification Receipt";
const RECEIPT_REFERENCE_KEYS = new Set([
  "schemaVersion",
  "kind",
  "receiptId",
  "receiptHash",
  "receiptKind",
  "status",
  "requirementId",
  "role",
  "runId",
  "revision",
  "actionId",
  "nodeId",
  "cycleId",
  "attemptId",
  "execution",
  "protocolHash",
  "packageHash",
  "snapshotHash",
  "scopeHash",
  "contentSnapshotHash",
  "candidateArtifacts",
  "verifierSubject",
  "provider",
  "issuedAt",
  "evidenceHash",
  "truncated",
]);
const RECEIPT_KEYS = new Set([...RECEIPT_REFERENCE_KEYS, "scope", "evidence"]);
const EVIDENCE_KEYS = new Set([
  "summary",
  "outputHash",
  "durationMs",
  "truncated",
]);
const ARTIFACT_REFERENCE_KEYS = new Set([
  "artifactId",
  "versionId",
  "contentHash",
  "producer",
]);
const PRODUCER_KEYS = new Set([
  "runId",
  "nodeId",
  "cycleId",
  "attemptId",
  "actionId",
  "revision",
]);
const STATUS_VALUES = new Set<WorkflowVerificationStatus>([
  "passed",
  "failed",
  "skipped",
  "blocked",
]);
const KIND_VALUES = new Set<WorkflowVerificationKind>([
  "automated-check",
  "static-inspection",
  "manual-evidence",
]);

export interface WorkflowVerificationReceiptBounds {
  receiptBytes: number;
  receiptCount: number;
  summaryBytes: number;
  evidenceBytes: number;
}

export interface CreateWorkflowVerificationReceiptOptions {
  proposal: WorkflowVerificationReceiptProposal;
  requirementId: string;
  role: string;
  runId: string;
  revision: number;
  actionId: string;
  nodeId: string;
  cycleId: string | null;
  attemptId: string;
  execution: import("../engine/types.js").RuntimeIdentity;
  protocolHash: string;
  packageHash: string;
  snapshotHash: string;
  scope: WorkflowDecisionScopeSnapshot;
  contentSnapshotHash: string | null;
  now?: Date;
}

export type NormalizedWorkflowVerificationReceiptProposal = Omit<
  WorkflowVerificationReceiptProposal,
  "verifierSubject" | "provider" | "evidence"
> & {
  verifierSubject: string;
  provider: string;
  evidence: WorkflowVerificationEvidence;
};

export interface StageWorkflowVerificationReceiptOptions {
  runRoot: string;
  receipt: WorkflowVerificationReceipt;
  transition: EngineRunMutationOverlay;
  profile: WorkflowDurabilityProfile;
}

export function workflowVerificationKinds(
  requirement: WorkflowVerificationRequirementLike,
): WorkflowVerificationKind[] {
  const values = Array.isArray(requirement.kind)
    ? [...requirement.kind]
    : [requirement.kind];
  if (
    values.length === 0 ||
    values.some((value) => !KIND_VALUES.has(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Workflow verification requirement kinds are invalid");
  }
  return values;
}

export interface WorkflowVerificationRequirementLike {
  id?: string;
  role: string;
  kind: WorkflowVerificationKind | WorkflowVerificationKind[];
  scope?: {
    artifacts?: Array<{ id: string; required?: boolean }>;
    evidence?: Array<{ id: string; required?: boolean }>;
  };
  requireContentSnapshot?: boolean;
}

export function validateWorkflowVerificationRequirement(
  value: unknown,
  label = "Workflow verification requirement",
): asserts value is WorkflowVerificationRequirementLike {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set(["id", "role", "kind", "scope", "requireContentSnapshot"]),
    label,
  );
  if (
    value.id !== undefined &&
    (typeof value.id !== "string" ||
      value.id.length === 0 ||
      Buffer.byteLength(value.id, "utf8") > MAX_IDENTIFIER_BYTES ||
      /[\u0000\r\n]/u.test(value.id))
  ) {
    throw new Error(`${label}.id must be a non-empty string`);
  }
  if (
    typeof value.role !== "string" ||
    value.role.length === 0 ||
    Buffer.byteLength(value.role, "utf8") > MAX_IDENTIFIER_BYTES ||
    /[\u0000\r\n]/u.test(value.role)
  ) {
    throw new Error(`${label}.role must be a non-empty string`);
  }
  workflowVerificationKinds(
    value as unknown as WorkflowVerificationRequirementLike,
  );
  if (
    value.requireContentSnapshot !== undefined &&
    typeof value.requireContentSnapshot !== "boolean"
  ) {
    throw new Error(`${label}.requireContentSnapshot must be a boolean`);
  }
  if (value.scope === undefined) return;
  if (!isRecord(value.scope))
    throw new Error(`${label}.scope must be an object`);
  assertKnownFields(
    value.scope,
    new Set(["artifacts", "evidence"]),
    `${label}.scope`,
  );
  for (const key of ["artifacts", "evidence"] as const) {
    const entries = value.scope[key];
    if (entries === undefined) continue;
    if (
      !Array.isArray(entries) ||
      entries.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES
    ) {
      throw new Error(`${label}.scope.${key} is outside its bound`);
    }
    const ids = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) {
        throw new Error(`${label}.scope.${key}[${index}] must be an object`);
      }
      assertKnownFields(
        entry,
        new Set(["id", "required"]),
        `${label}.scope.${key}[${index}]`,
      );
      if (
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        Buffer.byteLength(entry.id, "utf8") > MAX_IDENTIFIER_BYTES ||
        /[\u0000\r\n]/u.test(entry.id) ||
        ids.has(entry.id)
      ) {
        throw new Error(
          `${label}.scope.${key} contains an invalid or duplicate id`,
        );
      }
      if (entry.required !== undefined && typeof entry.required !== "boolean") {
        throw new Error(
          `${label}.scope.${key}[${index}].required must be a boolean`,
        );
      }
      ids.add(entry.id);
    }
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

function boundedText(value: unknown, key: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`Invalid ${label}: ${key} must be a bounded string`);
  }
  return value;
}

function hashValue(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  if (!HASH_PATTERN.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}

function identityText(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  if (
    /\b(?:password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)\s*[:=]/iu.test(
      result,
    ) ||
    /\bBearer\s+/iu.test(result)
  ) {
    throw new Error(`Invalid ${label}: ${key} contains credential material`);
  }
  return result;
}

function nullableHash(
  value: unknown,
  key: string,
  label: string,
): string | null {
  return value === null ? null : hashValue(value, key, label);
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

function timestamp(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  if (!ISO_TIMESTAMP_PATTERN.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be an ISO timestamp`);
  }
  return result;
}

function verificationBounds(
  profile: WorkflowDurabilityProfile,
): WorkflowVerificationReceiptBounds {
  const normalized = parseWorkflowDurabilityProfile(profile);
  if (!normalized.capabilities.includes("verification-receipts")) {
    throw new Error(
      "Workflow durability profile has no verification receipt capability",
    );
  }
  const receiptBytes = normalized.bounds.verificationReceiptBytes;
  const receiptCount = normalized.bounds.verificationReceiptCount;
  if (receiptBytes === undefined || receiptCount === undefined) {
    throw new Error("Workflow verification receipt bounds are missing");
  }
  return {
    receiptBytes,
    receiptCount,
    summaryBytes:
      normalized.verificationPolicy?.maxSummaryBytes ??
      WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_SUMMARY_BYTES,
    evidenceBytes:
      normalized.verificationPolicy?.maxEvidenceBytes ??
      WORKFLOW_VERIFICATION_RECEIPT_DEFAULT_EVIDENCE_BYTES,
  };
}

function parseProducer(
  value: unknown,
  label: string,
): WorkflowArtifactProducer {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, PRODUCER_KEYS, label);
  const cycleId = value.cycleId;
  if (
    cycleId !== null &&
    (typeof cycleId !== "string" || cycleId.length === 0)
  ) {
    throw new Error(`Invalid ${label}: cycleId must be a string or null`);
  }
  return {
    runId: boundedText(value.runId, "runId", label),
    nodeId: boundedText(value.nodeId, "nodeId", label),
    cycleId: cycleId as string | null,
    attemptId: boundedText(value.attemptId, "attemptId", label),
    actionId: boundedText(value.actionId, "actionId", label),
    revision: nonNegativeInteger(value.revision, "revision", label),
  };
}

function parseScopeReference(
  value: unknown,
  label: string,
): WorkflowDecisionScopeReference {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["id", "required", "versionId", "contentHash", "producer"]),
    label,
  );
  if (typeof value.required !== "boolean") {
    throw new Error(`Invalid ${label}: required must be a boolean`);
  }
  return {
    id: boundedText(value.id, "id", label),
    required: value.required,
    versionId: boundedText(value.versionId, "versionId", label),
    contentHash: hashValue(value.contentHash, "contentHash", label),
    producer: parseProducer(value.producer, `${label}.producer`),
  };
}

function parseScope(
  value: unknown,
  label: string,
): WorkflowDecisionScopeSnapshot {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, new Set(["artifacts", "evidence"]), label);
  const parseEntries = (key: "artifacts" | "evidence") => {
    const entries = value[key];
    if (!Array.isArray(entries)) {
      throw new Error(`Invalid ${label}.${key}: must be an array`);
    }
    if (entries.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
      throw new Error(`Invalid ${label}.${key}: too many entries`);
    }
    const parsed = entries.map((entry, index) =>
      parseScopeReference(entry, `${label}.${key}[${index}]`),
    );
    const references = new Set<string>();
    for (const [index, reference] of parsed.entries()) {
      const identity = `${reference.id}\u0000${reference.versionId}`;
      if (references.has(identity)) {
        throw new Error(`Invalid ${label}.${key}: duplicate reference`);
      }
      references.add(identity);
      if (
        index > 0 &&
        `${parsed[index - 1].id}\u0000${parsed[index - 1].versionId}`.localeCompare(
          identity,
          "en",
        ) > 0
      ) {
        throw new Error(
          `Invalid ${label}.${key}: entries are not canonically ordered`,
        );
      }
    }
    return parsed;
  };
  return {
    artifacts: parseEntries("artifacts"),
    evidence: parseEntries("evidence"),
  };
}

function parseEvidence(
  value: unknown,
  label: string,
  bounds: WorkflowVerificationReceiptBounds,
  options: { requireRedacted?: boolean } = {},
): WorkflowVerificationEvidence {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, EVIDENCE_KEYS, label);
  if (
    typeof value.summary !== "string" ||
    value.summary.length === 0 ||
    Buffer.byteLength(value.summary, "utf8") > bounds.summaryBytes ||
    /[\u0000\r\n]/u.test(value.summary)
  ) {
    throw new Error(`Invalid ${label}: summary is outside its bound`);
  }
  const summary = value.summary;
  const durationMs = nonNegativeInteger(value.durationMs, "durationMs", label);
  if (durationMs > MAX_DURATION_MS) {
    throw new Error(`Invalid ${label}: durationMs exceeds its bound`);
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error(`Invalid ${label}: truncated must be a boolean`);
  }
  const evidence = {
    summary,
    outputHash: hashValue(value.outputHash, "outputHash", label),
    durationMs,
    truncated: value.truncated,
  };
  if (
    options.requireRedacted &&
    redactedSummary(summary, bounds.summaryBytes).value !== summary
  ) {
    throw new Error(`Invalid ${label}: summary is not safely redacted`);
  }
  if (
    Buffer.byteLength(JSON.stringify(stableValue(evidence)), "utf8") >
    bounds.evidenceBytes
  ) {
    throw new Error(`Invalid ${label}: evidence exceeds its bound`);
  }
  return evidence;
}

function parseArtifactReference(
  value: unknown,
  label: string,
): WorkflowVerificationArtifactReference {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, ARTIFACT_REFERENCE_KEYS, label);
  return {
    artifactId: boundedText(value.artifactId, "artifactId", label),
    versionId: boundedText(value.versionId, "versionId", label),
    contentHash: hashValue(value.contentHash, "contentHash", label),
    producer: parseProducer(value.producer, `${label}.producer`),
  };
}

function parseArtifactReferences(
  value: unknown,
  label: string,
): WorkflowVerificationArtifactReference[] {
  if (!Array.isArray(value))
    throw new Error(`Invalid ${label}: must be an array`);
  if (value.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
    throw new Error(`Invalid ${label}: too many entries`);
  }
  const entries = value.map((entry, index) =>
    parseArtifactReference(entry, `${label}[${index}]`),
  );
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.artifactId}\u0000${entry.versionId}`;
    if (keys.has(key)) throw new Error(`Invalid ${label}: duplicate entry`);
    keys.add(key);
  }
  if (
    entries.some((entry, index) => {
      const previous = entries[index - 1];
      return (
        previous !== undefined &&
        `${previous.artifactId}\u0000${previous.versionId}`.localeCompare(
          `${entry.artifactId}\u0000${entry.versionId}`,
          "en",
        ) > 0
      );
    })
  ) {
    throw new Error(`Invalid ${label}: entries are not canonically ordered`);
  }
  return entries;
}

function receiptIdentityMaterial(
  receipt: WorkflowVerificationReceipt,
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    receiptKind: receipt.receiptKind,
    status: receipt.status,
    requirementId: receipt.requirementId,
    role: receipt.role,
    runId: receipt.runId,
    revision: receipt.revision,
    actionId: receipt.actionId,
    nodeId: receipt.nodeId,
    cycleId: receipt.cycleId,
    attemptId: receipt.attemptId,
    execution: receipt.execution,
    protocolHash: receipt.protocolHash,
    packageHash: receipt.packageHash,
    snapshotHash: receipt.snapshotHash,
    scopeHash: receipt.scopeHash,
    scope: receipt.scope,
    contentSnapshotHash: receipt.contentSnapshotHash,
    candidateArtifacts: receipt.candidateArtifacts,
    verifierSubject: receipt.verifierSubject,
    provider: receipt.provider,
    evidenceHash: receipt.evidenceHash,
    truncated: receipt.truncated,
  };
}

export function workflowVerificationReceiptHash(
  receipt: WorkflowVerificationReceipt,
): string {
  return sha256(JSON.stringify(stableValue(receiptIdentityMaterial(receipt))));
}

function receiptId(hash: string): string {
  return `verification-receipt-${hash.slice(0, 24)}`;
}

function scopeHash(scope: WorkflowDecisionScopeSnapshot): string {
  return sha256(JSON.stringify(stableValue(scope)));
}

function evidenceHash(evidence: WorkflowVerificationEvidence): string {
  return sha256(JSON.stringify(stableValue(evidence)));
}

function referenceFromReceipt(
  receipt: WorkflowVerificationReceipt,
): WorkflowVerificationReceiptReference {
  const {
    kind: _kind,
    scope: _scope,
    evidence: _evidence,
    ...fields
  } = receipt;
  return {
    ...fields,
    kind: "workflow-verification-receipt-reference",
  };
}

export function workflowVerificationReceiptReference(
  receipt: WorkflowVerificationReceipt,
): WorkflowVerificationReceiptReference {
  return structuredClone(referenceFromReceipt(receipt));
}

function validateReceiptFields(
  value: Record<string, unknown>,
  label: string,
  bounds: WorkflowVerificationReceiptBounds,
): void {
  assertKnownFields(value, RECEIPT_KEYS, label);
  if (value.schemaVersion !== WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Invalid ${label}: schemaVersion is unsupported`);
  }
  if (value.kind !== "workflow-verification-receipt") {
    throw new Error(`Invalid ${label}: kind is invalid`);
  }
  if (!KIND_VALUES.has(value.receiptKind as WorkflowVerificationKind)) {
    throw new Error(`Invalid ${label}: receiptKind is invalid`);
  }
  if (!STATUS_VALUES.has(value.status as WorkflowVerificationStatus)) {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
}

export function parseWorkflowVerificationReceipt(
  value: unknown,
  profile: WorkflowDurabilityProfile,
): WorkflowVerificationReceipt {
  const bounds = verificationBounds(profile);
  const label = RECEIPT_LABEL;
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  validateReceiptFields(value, label, bounds);
  const scope = parseScope(value.scope, `${label}.scope`);
  const evidence = parseEvidence(value.evidence, `${label}.evidence`, bounds, {
    requireRedacted: true,
  });
  const candidateArtifacts = parseArtifactReferences(
    value.candidateArtifacts,
    `${label}.candidateArtifacts`,
  );
  const expectedArtifacts = scope.artifacts.map((reference) => ({
    artifactId: reference.id,
    versionId: reference.versionId,
    contentHash: reference.contentHash,
    producer: reference.producer,
  }));
  if (
    JSON.stringify(stableValue(candidateArtifacts)) !==
    JSON.stringify(stableValue(expectedArtifacts))
  ) {
    throw new Error(`Invalid ${label}: candidateArtifacts do not match scope`);
  }
  const receipt: WorkflowVerificationReceipt = {
    schemaVersion: WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: "workflow-verification-receipt",
    receiptId: boundedText(value.receiptId, "receiptId", label),
    receiptHash: hashValue(value.receiptHash, "receiptHash", label),
    receiptKind: value.receiptKind as WorkflowVerificationKind,
    status: value.status as WorkflowVerificationStatus,
    requirementId: boundedText(value.requirementId, "requirementId", label),
    role: boundedText(value.role, "role", label),
    runId: boundedText(value.runId, "runId", label),
    revision: nonNegativeInteger(value.revision, "revision", label),
    actionId: boundedText(value.actionId, "actionId", label),
    nodeId: boundedText(value.nodeId, "nodeId", label),
    cycleId:
      value.cycleId === null
        ? null
        : boundedText(value.cycleId, "cycleId", label),
    attemptId: boundedText(value.attemptId, "attemptId", label),
    execution: parseExecutionIdentity(value.execution),
    protocolHash: hashValue(value.protocolHash, "protocolHash", label),
    packageHash: hashValue(value.packageHash, "packageHash", label),
    snapshotHash: hashValue(value.snapshotHash, "snapshotHash", label),
    scopeHash: hashValue(value.scopeHash, "scopeHash", label),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      "contentSnapshotHash",
      label,
    ),
    candidateArtifacts,
    verifierSubject: identityText(
      value.verifierSubject,
      "verifierSubject",
      label,
    ),
    provider: identityText(value.provider, "provider", label),
    issuedAt: timestamp(value.issuedAt, "issuedAt", label),
    evidenceHash: hashValue(value.evidenceHash, "evidenceHash", label),
    truncated: value.truncated as boolean,
    scope,
    evidence,
  };
  if (typeof receipt.truncated !== "boolean") {
    throw new Error(`Invalid ${label}: truncated must be a boolean`);
  }
  if (receipt.truncated !== evidence.truncated) {
    throw new Error(`Invalid ${label}: truncation identity is inconsistent`);
  }
  if (receipt.scopeHash !== scopeHash(scope)) {
    throw new Error(`Invalid ${label}: scopeHash is invalid`);
  }
  if (receipt.evidenceHash !== evidenceHash(evidence)) {
    throw new Error(`Invalid ${label}: evidenceHash is invalid`);
  }
  if (receipt.receiptId !== receiptId(receipt.receiptHash)) {
    throw new Error(`Invalid ${label}: receiptId is invalid`);
  }
  if (receipt.receiptHash !== workflowVerificationReceiptHash(receipt)) {
    throw new Error(`Invalid ${label}: receiptHash is invalid`);
  }
  if (
    receipt.execution.protocolHash !== receipt.protocolHash ||
    receipt.execution.packageHash !== receipt.packageHash ||
    receipt.execution.snapshotHash !== receipt.snapshotHash
  ) {
    throw new Error(`Invalid ${label}: execution identity is inconsistent`);
  }
  if (
    JSON.stringify(stableValue(receipt)) !== JSON.stringify(stableValue(value))
  ) {
    throw new Error(`Invalid ${label}: record is not canonical`);
  }
  const encodedBytes = Buffer.byteLength(
    JSON.stringify(stableValue(receipt)),
    "utf8",
  );
  if (encodedBytes > bounds.receiptBytes) {
    throw new Error(`Invalid ${label}: record exceeds its bound`);
  }
  return receipt;
}

export function parseWorkflowVerificationReceiptReference(
  value: unknown,
  profile: WorkflowDurabilityProfile,
): WorkflowVerificationReceiptReference {
  const bounds = verificationBounds(profile);
  const label = "Workflow Verification Receipt reference";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(value, RECEIPT_REFERENCE_KEYS, label);
  if (
    value.schemaVersion !== WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION ||
    value.kind !== "workflow-verification-receipt-reference"
  ) {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (!KIND_VALUES.has(value.receiptKind as WorkflowVerificationKind)) {
    throw new Error(`Invalid ${label}: receiptKind is invalid`);
  }
  if (!STATUS_VALUES.has(value.status as WorkflowVerificationStatus)) {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  const candidateArtifacts = parseArtifactReferences(
    value.candidateArtifacts,
    `${label}.candidateArtifacts`,
  );
  const reference: WorkflowVerificationReceiptReference = {
    schemaVersion: WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: "workflow-verification-receipt-reference",
    receiptId: boundedText(value.receiptId, "receiptId", label),
    receiptHash: hashValue(value.receiptHash, "receiptHash", label),
    receiptKind: value.receiptKind as WorkflowVerificationKind,
    status: value.status as WorkflowVerificationStatus,
    requirementId: boundedText(value.requirementId, "requirementId", label),
    role: boundedText(value.role, "role", label),
    runId: boundedText(value.runId, "runId", label),
    revision: nonNegativeInteger(value.revision, "revision", label),
    actionId: boundedText(value.actionId, "actionId", label),
    nodeId: boundedText(value.nodeId, "nodeId", label),
    cycleId:
      value.cycleId === null
        ? null
        : boundedText(value.cycleId, "cycleId", label),
    attemptId: boundedText(value.attemptId, "attemptId", label),
    execution: parseExecutionIdentity(value.execution),
    protocolHash: hashValue(value.protocolHash, "protocolHash", label),
    packageHash: hashValue(value.packageHash, "packageHash", label),
    snapshotHash: hashValue(value.snapshotHash, "snapshotHash", label),
    scopeHash: hashValue(value.scopeHash, "scopeHash", label),
    contentSnapshotHash: nullableHash(
      value.contentSnapshotHash,
      "contentSnapshotHash",
      label,
    ),
    candidateArtifacts,
    verifierSubject: identityText(
      value.verifierSubject,
      "verifierSubject",
      label,
    ),
    provider: identityText(value.provider, "provider", label),
    issuedAt: timestamp(value.issuedAt, "issuedAt", label),
    evidenceHash: hashValue(value.evidenceHash, "evidenceHash", label),
    truncated: value.truncated as boolean,
  };
  if (typeof reference.truncated !== "boolean") {
    throw new Error(`Invalid ${label}: truncated must be a boolean`);
  }
  if (reference.receiptId !== receiptId(reference.receiptHash)) {
    throw new Error(`Invalid ${label}: receiptId is invalid`);
  }
  if (
    reference.execution.protocolHash !== reference.protocolHash ||
    reference.execution.packageHash !== reference.packageHash ||
    reference.execution.snapshotHash !== reference.snapshotHash
  ) {
    throw new Error(`Invalid ${label}: execution identity is inconsistent`);
  }
  if (
    JSON.stringify(stableValue(reference)) !==
    JSON.stringify(stableValue(value))
  ) {
    throw new Error(`Invalid ${label}: record is not canonical`);
  }
  if (
    Buffer.byteLength(JSON.stringify(stableValue(reference)), "utf8") >
    bounds.receiptBytes
  ) {
    throw new Error(`Invalid ${label}: record exceeds its bound`);
  }
  return reference;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    const next = `${result}${character}…`;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}

function redactedSummary(
  value: string,
  maxBytes: number,
): {
  value: string;
  truncated: boolean;
} {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const redacted = normalized
    .replace(/\b(?:https?|file):\/\/[^\s,;)]+/giu, "[URL]")
    .replace(
      /\b(password|passwd|secret|token|api[-_]?key|authorization|cookie|credential)["']?\s*[:=]\s*["']?[^\s,;"'}]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;)]+/gu, "Bearer [REDACTED]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;)]*/gu, "[PATH]");
  const valueAfterLimit = truncateUtf8(redacted, maxBytes);
  return {
    value: valueAfterLimit,
    truncated:
      valueAfterLimit !== redacted ||
      Buffer.byteLength(value, "utf8") > maxBytes,
  };
}

export function normalizeWorkflowVerificationProposal(
  value: unknown,
  profile: WorkflowDurabilityProfile,
): NormalizedWorkflowVerificationReceiptProposal {
  const bounds = verificationBounds(profile);
  const label = "Workflow Verification Receipt proposal";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "kind",
      "status",
      "requirementId",
      "role",
      "scope",
      "artifactVersions",
      "contentSnapshotHash",
      "verifierSubject",
      "provider",
      "providerId",
      "verifier",
      "evidence",
      "summary",
      "outputHash",
      "durationMs",
      "truncated",
    ]),
    label,
  );
  if (!KIND_VALUES.has(value.kind as WorkflowVerificationKind)) {
    throw new Error(`Invalid ${label}: kind is invalid`);
  }
  if (!STATUS_VALUES.has(value.status as WorkflowVerificationStatus)) {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  const evidenceValue =
    value.evidence ??
    (value.summary !== undefined ||
    value.outputHash !== undefined ||
    value.durationMs !== undefined ||
    value.truncated !== undefined
      ? {
          summary: value.summary,
          outputHash: value.outputHash,
          durationMs: value.durationMs,
          truncated: value.truncated,
        }
      : undefined);
  if (!isRecord(evidenceValue)) {
    throw new Error(`Invalid ${label}: evidence is required`);
  }
  const evidence = parseEvidence(evidenceValue, `${label}.evidence`, {
    ...bounds,
    summaryBytes: MAX_RAW_SUMMARY_BYTES,
    evidenceBytes: MAX_RAW_SUMMARY_BYTES,
  });
  const redacted = redactedSummary(evidence.summary, bounds.summaryBytes);
  const normalizedEvidence: WorkflowVerificationEvidence = {
    ...evidence,
    summary: redacted.value,
    truncated: evidence.truncated || redacted.truncated,
  };
  if (
    Buffer.byteLength(JSON.stringify(stableValue(normalizedEvidence)), "utf8") >
    bounds.evidenceBytes
  ) {
    throw new Error(`Invalid ${label}: evidence exceeds its bound`);
  }
  let artifactVersions: Record<string, string> | undefined;
  if (value.artifactVersions !== undefined) {
    if (!isRecord(value.artifactVersions)) {
      throw new Error(`Invalid ${label}: artifactVersions must be an object`);
    }
    const entries = Object.entries(value.artifactVersions);
    if (entries.length > WORKFLOW_VERIFICATION_RECEIPT_MAX_SCOPE_ENTRIES) {
      throw new Error(`Invalid ${label}: too many artifact versions`);
    }
    if (
      entries.some(
        ([key, entry]) => !key || typeof entry !== "string" || !entry,
      )
    ) {
      throw new Error(
        `Invalid ${label}: artifactVersions must contain strings`,
      );
    }
    artifactVersions = Object.fromEntries(
      entries.map(([key, entry]) => [key, entry as string]),
    );
  }
  const contentSnapshotHash =
    value.contentSnapshotHash === undefined
      ? undefined
      : nullableHash(value.contentSnapshotHash, "contentSnapshotHash", label);
  const provider = value.provider ?? value.providerId;
  if (value.provider !== undefined && value.providerId !== undefined) {
    throw new Error(`Invalid ${label}: use provider or providerId, not both`);
  }
  const verifierSubject = value.verifierSubject ?? value.verifier;
  if (value.verifierSubject !== undefined && value.verifier !== undefined) {
    throw new Error(
      `Invalid ${label}: use verifierSubject or verifier, not both`,
    );
  }
  return {
    kind: value.kind as WorkflowVerificationKind,
    status: value.status as WorkflowVerificationStatus,
    ...(value.requirementId !== undefined
      ? {
          requirementId: boundedText(
            value.requirementId,
            "requirementId",
            label,
          ),
        }
      : {}),
    ...(value.role !== undefined
      ? { role: boundedText(value.role, "role", label) }
      : {}),
    ...(value.scope !== undefined
      ? { scope: value.scope as WorkflowVerificationReceiptProposal["scope"] }
      : {}),
    ...(artifactVersions ? { artifactVersions } : {}),
    ...(contentSnapshotHash !== undefined ? { contentSnapshotHash } : {}),
    verifierSubject: identityText(verifierSubject, "verifierSubject", label),
    provider: identityText(provider, "provider", label),
    evidence: normalizedEvidence,
  };
}

export function createWorkflowVerificationReceipt(
  options: CreateWorkflowVerificationReceiptOptions,
  profile: WorkflowDurabilityProfile,
): WorkflowVerificationReceipt {
  const bounds = verificationBounds(profile);
  const proposal = normalizeWorkflowVerificationProposal(
    options.proposal,
    profile,
  );
  const scope = structuredClone(options.scope);
  const evidence = structuredClone(proposal.evidence);
  const receiptWithoutIdentity = {
    schemaVersion: WORKFLOW_VERIFICATION_RECEIPT_SCHEMA_VERSION,
    kind: "workflow-verification-receipt" as const,
    receiptId: "pending",
    receiptHash: "0".repeat(64),
    receiptKind: proposal.kind,
    status: proposal.status,
    requirementId: options.requirementId,
    role: options.role,
    runId: options.runId,
    revision: options.revision,
    actionId: options.actionId,
    nodeId: options.nodeId,
    cycleId: options.cycleId,
    attemptId: options.attemptId,
    execution: structuredClone(options.execution),
    protocolHash: options.protocolHash,
    packageHash: options.packageHash,
    snapshotHash: options.snapshotHash,
    scopeHash: scopeHash(scope),
    contentSnapshotHash:
      proposal.contentSnapshotHash ?? options.contentSnapshotHash,
    candidateArtifacts: scope.artifacts.map((reference) => ({
      artifactId: reference.id,
      versionId: reference.versionId,
      contentHash: reference.contentHash,
      producer: structuredClone(reference.producer),
    })),
    verifierSubject: proposal.verifierSubject,
    provider: proposal.provider,
    issuedAt: (options.now ?? new Date()).toISOString(),
    evidenceHash: evidenceHash(evidence),
    truncated: evidence.truncated,
    scope,
    evidence,
  } satisfies WorkflowVerificationReceipt;
  const hash = workflowVerificationReceiptHash(receiptWithoutIdentity);
  const receipt: WorkflowVerificationReceipt = {
    ...receiptWithoutIdentity,
    receiptId: receiptId(hash),
    receiptHash: hash,
  };
  if (
    Buffer.byteLength(JSON.stringify(stableValue(receipt)), "utf8") >
    bounds.receiptBytes
  ) {
    throw new Error(`${RECEIPT_LABEL} exceeds ${bounds.receiptBytes} bytes`);
  }
  return parseWorkflowVerificationReceipt(receipt, profile);
}

function receiptPath(hash: string): string {
  return `${WORKFLOW_VERIFICATION_RECEIPT_DIRECTORY}/${hash}.json`;
}

function serializedReceipt(receipt: WorkflowVerificationReceipt): string {
  return `${JSON.stringify(stableValue(receipt), null, 2)}\n`;
}

export async function readWorkflowVerificationReceipt(
  runRoot: string,
  receiptHash: string,
  profile: WorkflowDurabilityProfile,
  options: { overlay?: EngineRunMutationOverlay } = {},
): Promise<WorkflowVerificationReceipt | null> {
  const bounds = verificationBounds(profile);
  const hash = hashValue(receiptHash, "receiptHash", RECEIPT_LABEL);
  const raw = await readOptionalEngineRunText(
    runRoot,
    receiptPath(hash),
    bounds.receiptBytes,
    RECEIPT_LABEL,
    options.overlay ? { overlay: options.overlay } : {},
  );
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > bounds.receiptBytes) {
    throw new Error(`${RECEIPT_LABEL} exceeds ${bounds.receiptBytes} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${RECEIPT_LABEL} is not valid JSON`, { cause: error });
  }
  const receipt = parseWorkflowVerificationReceipt(value, profile);
  if (receipt.receiptHash !== hash) {
    throw new Error(`${RECEIPT_LABEL} path identity does not match content`);
  }
  if (raw !== serializedReceipt(receipt)) {
    throw new Error(`${RECEIPT_LABEL} is not canonically serialized`);
  }
  return receipt;
}

export async function stageWorkflowVerificationReceipt(
  options: StageWorkflowVerificationReceiptOptions,
): Promise<WorkflowVerificationReceiptReference> {
  const bounds = verificationBounds(options.profile);
  const receipt = parseWorkflowVerificationReceipt(
    options.receipt,
    options.profile,
  );
  const path = receiptPath(receipt.receiptHash);
  const existingRaw = await options.transition.read(
    path,
    bounds.receiptBytes,
    RECEIPT_LABEL,
  );
  if (existingRaw !== null) {
    let value: unknown;
    try {
      value = JSON.parse(existingRaw) as unknown;
    } catch (error) {
      throw new Error(`${RECEIPT_LABEL} is not valid JSON`, { cause: error });
    }
    const existing = parseWorkflowVerificationReceipt(value, options.profile);
    if (existingRaw !== serializedReceipt(existing)) {
      throw new Error(`${RECEIPT_LABEL} duplicate record is not canonical`);
    }
    if (
      existing.receiptHash !== receipt.receiptHash ||
      JSON.stringify(stableValue(receiptIdentityMaterial(existing))) !==
        JSON.stringify(stableValue(receiptIdentityMaterial(receipt)))
    ) {
      throw new Error(`${RECEIPT_LABEL} duplicate identity conflicts`);
    }
    return workflowVerificationReceiptReference(existing);
  }
  await options.transition.write(
    path,
    serializedReceipt(receipt),
    bounds.receiptBytes,
    RECEIPT_LABEL,
  );
  return workflowVerificationReceiptReference(receipt);
}

export function sameWorkflowVerificationReceiptIdentity(
  left: WorkflowVerificationReceipt,
  right: WorkflowVerificationReceipt,
): boolean {
  return (
    left.receiptHash === right.receiptHash &&
    JSON.stringify(stableValue(receiptIdentityMaterial(left))) ===
      JSON.stringify(stableValue(receiptIdentityMaterial(right)))
  );
}

export function workflowVerificationReceiptPath(receiptHash: string): string {
  return receiptPath(hashValue(receiptHash, "receiptHash", RECEIPT_LABEL));
}
