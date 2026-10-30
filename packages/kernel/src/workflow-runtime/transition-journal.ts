import { randomUUID } from "node:crypto";
import path from "node:path";
import { RaceSafeReadError } from "../engine/race-safe-read.js";
import {
  readOptionalEngineRunText,
  removeEngineRunFile,
  writeEngineRunText,
  type EngineRunMutationOverlay,
} from "../engine/protected-run-file.js";
import { parsePendingActionValue } from "../engine/run-store.js";
import { parseRunStateValue } from "../engine/state.js";
import type { RunState, RuntimeIdentity } from "../engine/types.js";
import type { WorkflowDurabilityProfile } from "../types.js";
import { sha256, stableValue } from "../util.js";
import {
  WORKFLOW_DURABILITY_MAX_RECORD_BYTES,
  parseWorkflowDurabilityProfile,
} from "./durability.js";
import {
  commitExistingRevisionClaim,
  committedRevisionClaimText,
  parseExecutionIdentity,
  revisionClaimPath,
  type RevisionClaimInput,
} from "./revision-claim.js";

export const WORKFLOW_TRANSITION_JOURNAL_PATH =
  ".badger/transition-journal.json";
export const WORKFLOW_TRANSITION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_TRANSITION_JOURNAL_MAX_RECORDS = 16;

const MAX_IDENTIFIER_LENGTH = 256;
const JOURNAL_LABEL = "Workflow transition journal";
const STATE_PATH = ".badger/run-state.json";
const TRANSITION_OPERATION_IDS = [
  "workflow.start",
  "workflow.resume",
  "workflow.submit",
] as const;
const RECORD_ORDER = [
  "state",
  "pending",
  "artifacts",
  "verification-receipt",
  "trajectory",
  "revision-claim",
] as const;

export type WorkflowTransitionOperation =
  (typeof TRANSITION_OPERATION_IDS)[number];
export type WorkflowTransitionRecordKind =
  (typeof RECORD_ORDER)[number] | "other";
export type WorkflowTransitionBoundaryPhase =
  | "journal-prepared"
  | "journal-verified"
  | "record-write"
  | "record-verification"
  | "commit-evidence"
  | "commit-evidence-written"
  | "journal-clearance"
  | "journal-cleared"
  | "recovery-record-write"
  | "recovery-record-verification"
  | "recovery-evidence-prepared"
  | "recovery-evidence"
  | "recovery-evidence-recorded";

export const WORKFLOW_TRANSITION_BOUNDARY_PHASES: readonly WorkflowTransitionBoundaryPhase[] =
  [
    "journal-prepared",
    "journal-verified",
    "record-write",
    "record-verification",
    "commit-evidence",
    "commit-evidence-written",
    "journal-clearance",
    "journal-cleared",
    "recovery-record-write",
    "recovery-record-verification",
    "recovery-evidence-prepared",
    "recovery-evidence",
    "recovery-evidence-recorded",
  ];

export interface WorkflowTransitionBoundary {
  phase: WorkflowTransitionBoundaryPhase;
  path?: string;
}

export type WorkflowTransitionFault = (
  boundary: WorkflowTransitionBoundary,
) => void | Promise<void>;

export interface WorkflowTransitionFaultSelector {
  phase: WorkflowTransitionBoundaryPhase;
  path?: string;
}

export interface WorkflowTransitionMaterialIdentity {
  exists: boolean;
  bytes: number;
  sha256: string | null;
}

export interface WorkflowTransitionMaterial extends WorkflowTransitionMaterialIdentity {
  content: string | null;
}

export interface WorkflowTransitionJournalRecord {
  path: string;
  kind: WorkflowTransitionRecordKind;
  previous: WorkflowTransitionMaterial;
  intended: WorkflowTransitionMaterial;
}

export interface WorkflowTransitionRevisionIdentity {
  revision: number;
  actionId: string | null;
}

export interface WorkflowTransitionRecovery {
  status: "prepared" | "recorded";
  crashBoundary: string;
  trajectoryPath: string;
  event: {
    sequence: number;
    timestamp: string;
    type: "recovery_reconciled";
    runId: string;
    data: Record<string, unknown>;
  };
  intendedTrajectory: WorkflowTransitionMaterialIdentity;
}

export interface WorkflowTransitionCommitEvidence {
  kind: "workflow-transition-commit";
  journalId: string;
  operation: WorkflowTransitionOperation;
  runId: string;
  previousRevision: number;
  intendedRevision: number;
  recovered: boolean;
  committedAt: string;
}

export interface WorkflowTransitionJournal {
  schemaVersion: 1;
  kind: "workflow-transition-journal";
  status: "prepared" | "committed";
  journalId: string;
  operation: WorkflowTransitionOperation;
  runId: string;
  execution: RuntimeIdentity;
  previous: WorkflowTransitionRevisionIdentity;
  intended: WorkflowTransitionRevisionIdentity;
  records: WorkflowTransitionJournalRecord[];
  createdAt: string;
  lastBoundary?: string;
  committedAt?: string;
  commitEvidence?: WorkflowTransitionCommitEvidence;
  recovery?: WorkflowTransitionRecovery;
}

export interface WorkflowTransitionInput {
  runRoot: string;
  runId: string;
  operation: WorkflowTransitionOperation;
  execution: RuntimeIdentity;
  profile: WorkflowDurabilityProfile;
}

export interface WorkflowTransition extends EngineRunMutationOverlay {
  readonly journalId: string;
  commit(): Promise<void>;
}

export interface WorkflowTransitionRecoveryResult {
  status: "none" | "recovered" | "blocked";
  journal?: WorkflowTransitionJournal;
  unknownPaths?: string[];
}

interface BlockedRecoveryResult {
  status: "blocked";
  journal: WorkflowTransitionJournal;
  unknownPaths: string[];
}

export class WorkflowTransitionJournalPendingError extends Error {
  constructor(readonly journal: WorkflowTransitionJournal) {
    super("WorkflowRuntime recovery is required before another mutation");
    this.name = "WorkflowTransitionJournalPendingError";
  }
}

export class WorkflowTransitionRecordConflictError extends Error {
  constructor(readonly path: string) {
    super(`Workflow transition record changed before journaling: ${path}`);
    this.name = "WorkflowTransitionRecordConflictError";
  }
}

function isBlockedRecoveryResult(
  value: WorkflowTransitionJournal | WorkflowTransitionRecoveryResult,
): value is BlockedRecoveryResult {
  return value.status === "blocked";
}

let configuredFault: WorkflowTransitionFault | undefined;

export function setWorkflowTransitionFaultForTests(
  selectorOrFault: WorkflowTransitionFaultSelector | WorkflowTransitionFault,
): void {
  if (typeof selectorOrFault === "function") {
    configuredFault = selectorOrFault;
    return;
  }
  configuredFault = (boundary) => {
    if (
      boundary.phase === selectorOrFault.phase &&
      (selectorOrFault.path === undefined ||
        boundary.path === selectorOrFault.path)
    ) {
      throw new Error("deterministic workflow transition fault");
    }
  };
}

export function clearWorkflowTransitionFaultForTests(): void {
  configuredFault = undefined;
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

function requiredText(value: unknown, key: string, label: string): string {
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
  const result = requiredText(value, key, label);
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

function hash(value: unknown, key: string, label: string): string {
  const result = requiredText(value, key, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(`Invalid ${label}: ${key} must be a SHA-256 hash`);
  }
  return result;
}

function uuid(value: unknown, key: string, label: string): string {
  const result = requiredText(value, key, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      result,
    )
  ) {
    throw new Error(`Invalid ${label}: ${key} is invalid`);
  }
  return result;
}

function nullableActionId(
  value: unknown,
  key: string,
  label: string,
): string | null {
  return value === null ? null : requiredText(value, key, label);
}

function parseMaterialIdentity(
  value: unknown,
  key: string,
  label: string,
): WorkflowTransitionMaterialIdentity {
  if (!isRecord(value))
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  assertKnownFields(
    value,
    new Set(["exists", "bytes", "sha256"]),
    `${label}.${key}`,
  );
  if (typeof value.exists !== "boolean") {
    throw new Error(`Invalid ${label}: ${key}.exists must be a boolean`);
  }
  const bytes = nonNegativeInteger(value.bytes, `${key}.bytes`, label);
  const digest =
    value.sha256 === null ? null : hash(value.sha256, `${key}.sha256`, label);
  if (
    (!value.exists && (bytes !== 0 || digest !== null)) ||
    (value.exists && (bytes < 1 || digest === null))
  ) {
    throw new Error(`Invalid ${label}: ${key} identity is inconsistent`);
  }
  return { exists: value.exists, bytes, sha256: digest };
}

function parseMaterial(
  value: unknown,
  key: string,
  label: string,
  maxBytes: number,
): WorkflowTransitionMaterial {
  if (!isRecord(value))
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  assertKnownFields(
    value,
    new Set(["content", "exists", "bytes", "sha256"]),
    `${label}.${key}`,
  );
  const identity = parseMaterialIdentity(
    {
      exists: value.exists,
      bytes: value.bytes,
      sha256: value.sha256,
    },
    key,
    label,
  );
  if (identity.exists !== (value.content !== null)) {
    throw new Error(`Invalid ${label}: ${key}.content does not match exists`);
  }
  if (identity.exists && typeof value.content !== "string") {
    throw new Error(`Invalid ${label}: ${key}.content must be a string`);
  }
  if (!identity.exists && value.content !== null) {
    throw new Error(`Invalid ${label}: ${key}.content must be null`);
  }
  const content = value.content as string | null;
  if (
    content !== null &&
    (Buffer.byteLength(content, "utf8") !== identity.bytes ||
      Buffer.byteLength(content, "utf8") > maxBytes ||
      sha256(content) !== identity.sha256)
  ) {
    throw new Error(`Invalid ${label}: ${key} content identity is invalid`);
  }
  return { ...identity, content };
}

function recordKind(relativePath: string): WorkflowTransitionRecordKind {
  if (relativePath === STATE_PATH) return "state";
  if (relativePath.endsWith("/pending-action.json")) return "pending";
  if (relativePath.endsWith("/artifacts.json")) return "artifacts";
  if (relativePath.startsWith(".badger/verification-receipts/")) {
    return "verification-receipt";
  }
  if (relativePath.endsWith("/trajectory.jsonl")) return "trajectory";
  if (relativePath.startsWith(".badger/revision-claims/")) {
    return "revision-claim";
  }
  return "other";
}

function orderOf(
  record: Pick<WorkflowTransitionJournalRecord, "kind" | "path">,
): string {
  const rank =
    record.kind === "other"
      ? RECORD_ORDER.length
      : RECORD_ORDER.indexOf(record.kind);
  return `${String(rank).padStart(2, "0")}\u0000${record.path}`;
}

function assertSafeRecordPath(value: unknown, label: string): string {
  const normalized =
    typeof value === "string" ? value.replaceAll("\\", "/") : "";
  if (
    normalized.length === 0 ||
    normalized.length > MAX_IDENTIFIER_LENGTH ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(String(value)) ||
    /^(?:[A-Za-z]:|[\\/]|~)/u.test(String(value)) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
  ) {
    throw new Error(`Invalid ${label}: path must stay inside the Run root`);
  }
  if (normalized === WORKFLOW_TRANSITION_JOURNAL_PATH) {
    throw new Error(`Invalid ${label}: journal cannot contain itself`);
  }
  return normalized;
}

function parseRevisionIdentity(
  value: unknown,
  key: string,
  label: string,
): WorkflowTransitionRevisionIdentity {
  if (!isRecord(value))
    throw new Error(`Invalid ${label}: ${key} must be an object`);
  assertKnownFields(
    value,
    new Set(["revision", "actionId"]),
    `${label}.${key}`,
  );
  return {
    revision: nonNegativeInteger(value.revision, `${key}.revision`, label),
    actionId: nullableActionId(value.actionId, `${key}.actionId`, label),
  };
}

function parseRecoveryEvent(
  value: unknown,
): WorkflowTransitionRecovery["event"] {
  const label = "Workflow transition journal recovery event";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set(["sequence", "timestamp", "type", "runId", "data"]),
    label,
  );
  if (value.type !== "recovery_reconciled") {
    throw new Error(`Invalid ${label}: type is invalid`);
  }
  if (!isRecord(value.data))
    throw new Error(`Invalid ${label}: data must be an object`);
  const sequence = nonNegativeInteger(value.sequence, "sequence", label);
  if (sequence < 1) throw new Error(`Invalid ${label}: sequence is invalid`);
  return {
    sequence,
    timestamp: timestamp(value.timestamp, "timestamp", label),
    type: "recovery_reconciled",
    runId: requiredText(value.runId, "runId", label),
    data: value.data,
  };
}

function parseCommitEvidence(value: unknown): WorkflowTransitionCommitEvidence {
  const label = "Workflow transition commit evidence";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "kind",
      "journalId",
      "operation",
      "runId",
      "previousRevision",
      "intendedRevision",
      "recovered",
      "committedAt",
    ]),
    label,
  );
  if (value.kind !== "workflow-transition-commit") {
    throw new Error(`Invalid ${label}: kind is invalid`);
  }
  if (
    !TRANSITION_OPERATION_IDS.includes(
      value.operation as WorkflowTransitionOperation,
    )
  ) {
    throw new Error(`Invalid ${label}: operation is invalid`);
  }
  if (typeof value.recovered !== "boolean") {
    throw new Error(`Invalid ${label}: recovered is invalid`);
  }
  return {
    kind: "workflow-transition-commit",
    journalId: uuid(value.journalId, "journalId", label),
    operation: value.operation as WorkflowTransitionOperation,
    runId: requiredText(value.runId, "runId", label),
    previousRevision: nonNegativeInteger(
      value.previousRevision,
      "previousRevision",
      label,
    ),
    intendedRevision: nonNegativeInteger(
      value.intendedRevision,
      "intendedRevision",
      label,
    ),
    recovered: value.recovered,
    committedAt: timestamp(value.committedAt, "committedAt", label),
  };
}

function parseRecovery(
  value: unknown,
  maxBytes: number,
): WorkflowTransitionRecovery {
  const label = "Workflow transition journal recovery";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "status",
      "crashBoundary",
      "trajectoryPath",
      "event",
      "intendedTrajectory",
    ]),
    label,
  );
  if (value.status !== "prepared" && value.status !== "recorded") {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  return {
    status: value.status,
    crashBoundary: requiredText(value.crashBoundary, "crashBoundary", label),
    trajectoryPath: assertSafeRecordPath(
      value.trajectoryPath,
      `${label} trajectory`,
    ),
    event: parseRecoveryEvent(value.event),
    intendedTrajectory: parseMaterialIdentity(
      value.intendedTrajectory,
      "intendedTrajectory",
      label,
    ),
  };
}

export function parseWorkflowTransitionJournal(
  value: unknown,
  maxBytes = WORKFLOW_DURABILITY_MAX_RECORD_BYTES,
): WorkflowTransitionJournal {
  const label = "Workflow transition journal";
  if (!isRecord(value)) throw new Error(`Invalid ${label}: must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "status",
      "journalId",
      "operation",
      "runId",
      "execution",
      "previous",
      "intended",
      "records",
      "createdAt",
      "lastBoundary",
      "committedAt",
      "commitEvidence",
      "recovery",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_TRANSITION_JOURNAL_SCHEMA_VERSION ||
    value.kind !== "workflow-transition-journal"
  ) {
    throw new Error(`Invalid ${label}: schema identity is invalid`);
  }
  if (value.status !== "prepared" && value.status !== "committed") {
    throw new Error(`Invalid ${label}: status is invalid`);
  }
  if (
    !TRANSITION_OPERATION_IDS.includes(
      value.operation as WorkflowTransitionOperation,
    )
  ) {
    throw new Error(`Invalid ${label}: operation is invalid`);
  }
  if (
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > WORKFLOW_TRANSITION_JOURNAL_MAX_RECORDS
  ) {
    throw new Error(`Invalid ${label}: records are outside the allowed bound`);
  }
  const records: WorkflowTransitionJournalRecord[] = [];
  const paths = new Set<string>();
  for (const [index, entry] of value.records.entries()) {
    if (!isRecord(entry))
      throw new Error(`Invalid ${label}: records[${index}] must be an object`);
    assertKnownFields(
      entry,
      new Set(["path", "kind", "previous", "intended"]),
      `${label} record`,
    );
    const recordPath = assertSafeRecordPath(entry.path, `${label} record`);
    if (paths.has(recordPath))
      throw new Error(`Invalid ${label}: duplicate record path ${recordPath}`);
    paths.add(recordPath);
    const kind = entry.kind;
    if (
      kind !== "state" &&
      kind !== "pending" &&
      kind !== "artifacts" &&
      kind !== "verification-receipt" &&
      kind !== "trajectory" &&
      kind !== "revision-claim" &&
      kind !== "other"
    ) {
      throw new Error(`Invalid ${label}: record kind is invalid`);
    }
    if (kind !== recordKind(recordPath)) {
      throw new Error(`Invalid ${label}: record kind does not match path`);
    }
    records.push({
      path: recordPath,
      kind,
      previous: parseMaterial(entry.previous, "previous", label, maxBytes),
      intended: parseMaterial(entry.intended, "intended", label, maxBytes),
    });
  }
  if (
    records
      .map(orderOf)
      .some((entry, index, values) => index > 0 && entry <= values[index - 1])
  ) {
    throw new Error(`Invalid ${label}: records are not in deterministic order`);
  }
  const execution = parseExecutionIdentity(value.execution);
  const previous = parseRevisionIdentity(value.previous, "previous", label);
  const intended = parseRevisionIdentity(value.intended, "intended", label);
  const revisionIncrement = value.operation === "workflow.submit" ? 1 : 0;
  if (intended.revision !== previous.revision + revisionIncrement) {
    throw new Error(`Invalid ${label}: revisions are inconsistent`);
  }
  const committedAt =
    value.committedAt === undefined
      ? undefined
      : timestamp(value.committedAt, "committedAt", label);
  const commitEvidence =
    value.commitEvidence === undefined
      ? undefined
      : parseCommitEvidence(value.commitEvidence);
  if (
    (value.status === "committed") !==
    (committedAt !== undefined && commitEvidence !== undefined)
  ) {
    throw new Error(`Invalid ${label}: commit evidence does not match status`);
  }
  if (
    commitEvidence &&
    (commitEvidence.journalId !== value.journalId ||
      commitEvidence.runId !== value.runId ||
      commitEvidence.operation !== value.operation ||
      commitEvidence.previousRevision !== previous.revision ||
      commitEvidence.intendedRevision !== intended.revision ||
      commitEvidence.committedAt !== committedAt)
  ) {
    throw new Error(`Invalid ${label}: commit evidence identity is invalid`);
  }
  const recovery =
    value.recovery === undefined
      ? undefined
      : parseRecovery(value.recovery, maxBytes);
  if (recovery && recovery.event.runId !== value.runId) {
    throw new Error(`Invalid ${label}: recovery event Run identity is invalid`);
  }
  if (
    value.status === "committed" &&
    recovery?.status !== "recorded" &&
    recovery !== undefined
  ) {
    throw new Error(
      `Invalid ${label}: committed recovery evidence is incomplete`,
    );
  }
  const journal: WorkflowTransitionJournal = {
    schemaVersion: 1,
    kind: "workflow-transition-journal",
    status: value.status,
    journalId: uuid(value.journalId, "journalId", label),
    operation: value.operation as WorkflowTransitionOperation,
    runId: requiredText(value.runId, "runId", label),
    execution,
    previous,
    intended,
    records,
    createdAt: timestamp(value.createdAt, "createdAt", label),
    ...(value.lastBoundary === undefined
      ? {}
      : {
          lastBoundary: requiredText(value.lastBoundary, "lastBoundary", label),
        }),
    ...(committedAt ? { committedAt } : {}),
    ...(commitEvidence ? { commitEvidence } : {}),
    ...(recovery ? { recovery } : {}),
  };
  return journal;
}

function journalMaxBytes(profile: WorkflowDurabilityProfile): number {
  const bounds = profile.bounds as WorkflowDurabilityProfile["bounds"] & {
    transitionJournalBytes?: number;
  };
  const value = bounds.transitionJournalBytes ?? bounds.runStateBytes;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > WORKFLOW_DURABILITY_MAX_RECORD_BYTES
  ) {
    throw new Error("Workflow transition journal size bound is invalid");
  }
  return value;
}

function recordMaxBytes(
  profile: WorkflowDurabilityProfile,
  kind: WorkflowTransitionRecordKind,
): number {
  if (kind === "state") return profile.bounds.runStateBytes;
  if (kind === "pending") return profile.bounds.pendingActionBytes;
  if (kind === "artifacts") return profile.bounds.artifactsBytes;
  if (kind === "verification-receipt") {
    if (profile.bounds.verificationReceiptBytes === undefined) {
      throw new Error("Workflow verification receipt bound is missing");
    }
    return profile.bounds.verificationReceiptBytes;
  }
  if (kind === "trajectory") return profile.bounds.trajectoryBytes;
  if (kind === "revision-claim") return profile.bounds.claimBytes;
  return journalMaxBytes(profile);
}

function validateJournalRecordBounds(
  journal: WorkflowTransitionJournal,
  profile: WorkflowDurabilityProfile,
): void {
  for (const record of journal.records) {
    const maxBytes = recordMaxBytes(profile, record.kind);
    for (const material of [record.previous, record.intended]) {
      if (material.bytes > maxBytes) {
        throw new Error(
          `Workflow transition record ${record.path} exceeds ${maxBytes} bytes`,
        );
      }
    }
  }
}

function validateJournalStateIdentity(
  journal: WorkflowTransitionJournal,
): void {
  const record = journal.records.find(
    (candidate) => candidate.kind === "state",
  );
  if (!record)
    throw new Error("Workflow transition journal has no state record");
  for (const material of [record.previous, record.intended]) {
    if (material.content === null) continue;
    const state = parseRunStateValue(JSON.parse(material.content) as unknown);
    if (state.runId !== journal.runId || !state.runtimeIdentity) {
      throw new Error("Workflow transition journal Run identity is invalid");
    }
    if (
      JSON.stringify(stableValue(state.runtimeIdentity)) !==
      JSON.stringify(stableValue(journal.execution))
    ) {
      throw new Error(
        "Workflow transition journal execution identity does not match Run state",
      );
    }
  }
}

function validateJournalRevisionIdentity(
  journal: WorkflowTransitionJournal,
): void {
  const record = journal.records.find(
    (candidate) => candidate.kind === "state",
  );
  if (!record)
    throw new Error("Workflow transition journal has no state record");
  const materials: Array<
    [WorkflowTransitionMaterial, WorkflowTransitionRevisionIdentity]
  > = [
    [record.previous, journal.previous],
    [record.intended, journal.intended],
  ];
  for (const [material, expected] of materials) {
    const actual = stateMetadata(material.content);
    if (
      actual.revision !== expected.revision ||
      actual.actionId !== expected.actionId
    ) {
      throw new Error(
        "Workflow transition journal revision or action identity is invalid",
      );
    }
  }
}

function validateJournalPendingIdentity(
  journal: WorkflowTransitionJournal,
): void {
  const stateRecord = journal.records.find(
    (candidate) => candidate.kind === "state",
  );
  if (!stateRecord)
    throw new Error("Workflow transition journal has no state record");
  const states = [
    [stateRecord.previous.content, "previous"],
    [stateRecord.intended.content, "intended"],
  ] as const;
  for (const [content, label] of states) {
    if (content === null) continue;
    const state = parseRunStateValue(JSON.parse(content) as unknown);
    const pendingRecord = journal.records.find(
      (candidate) => candidate.path === state.pendingRef,
    );
    if (state.pending === null) {
      if (pendingRecord?.[label].content !== null) {
        throw new Error(
          `Workflow transition journal ${label} pending identity is invalid`,
        );
      }
      continue;
    }
    if (!pendingRecord || pendingRecord[label].content === null) {
      throw new Error(
        `Workflow transition journal ${label} pending action is missing`,
      );
    }
    const action = parsePendingActionValue(
      JSON.parse(pendingRecord[label].content) as unknown,
    );
    if (action.id !== state.pending) {
      throw new Error(
        `Workflow transition journal ${label} pending action identity is invalid`,
      );
    }
  }
}

function serializeJournal(journal: WorkflowTransitionJournal): string {
  return `${JSON.stringify(stableValue(journal), null, 2)}\n`;
}

async function readJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowTransitionJournal | null> {
  const maxBytes = journalMaxBytes(profile);
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    maxBytes,
    JOURNAL_LABEL,
  );
  if (raw === null) return null;
  try {
    const journal = parseWorkflowTransitionJournal(
      JSON.parse(raw) as unknown,
      maxBytes,
    );
    validateJournalRecordBounds(journal, profile);
    validateJournalStateIdentity(journal);
    validateJournalRevisionIdentity(journal);
    validateJournalPendingIdentity(journal);
    return journal;
  } catch (error) {
    throw new Error(`${JOURNAL_LABEL} is malformed`, { cause: error });
  }
}

export async function readWorkflowTransitionJournal(
  runRoot: string,
): Promise<WorkflowTransitionJournal | null> {
  // A committing writer replaces this file at each boundary. A reader must
  // discard a changed descriptor and validate a fresh protected read; it must
  // never weaken containment checks or replay a submission with a new revision.
  let raw: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = await readOptionalEngineRunText(
        runRoot,
        WORKFLOW_TRANSITION_JOURNAL_PATH,
        WORKFLOW_DURABILITY_MAX_RECORD_BYTES,
        JOURNAL_LABEL,
      );
      break;
    } catch (error) {
      if (
        !(error instanceof RaceSafeReadError) ||
        error.reason !== "changed" ||
        attempt === 2
      )
        throw error;
    }
  }
  if (raw === null) return null;
  try {
    const journal = parseWorkflowTransitionJournal(
      JSON.parse(raw) as unknown,
      WORKFLOW_DURABILITY_MAX_RECORD_BYTES,
    );
    const profile = journal.execution.durabilityProfile!;
    validateJournalRecordBounds(journal, profile);
    validateJournalStateIdentity(journal);
    validateJournalRevisionIdentity(journal);
    validateJournalPendingIdentity(journal);
    const maxBytes = journalMaxBytes(profile);
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new Error(`Workflow transition journal exceeds ${maxBytes} bytes`);
    }
    return journal;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Workflow transition journal exceeds")
    ) {
      throw error;
    }
    throw new Error(`${JOURNAL_LABEL} is malformed`, { cause: error });
  }
}

export async function readPendingWorkflowTransitionJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowTransitionJournal | null> {
  return readJournal(runRoot, parseWorkflowDurabilityProfile(profile));
}

async function writeJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const maxBytes = journalMaxBytes(profile);
  await writeEngineRunText(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    serializeJournal(journal),
    maxBytes,
    JOURNAL_LABEL,
    { exclusive: options.exclusive },
  );
}

function materialOf(content: string | null): WorkflowTransitionMaterial {
  return content === null
    ? { content: null, exists: false, bytes: 0, sha256: null }
    : {
        content,
        exists: true,
        bytes: Buffer.byteLength(content, "utf8"),
        sha256: sha256(content),
      };
}

function materialIdentityOf(
  content: string | null,
): WorkflowTransitionMaterialIdentity {
  const material = materialOf(content);
  return {
    exists: material.exists,
    bytes: material.bytes,
    sha256: material.sha256,
  };
}

function sameMaterialIdentity(
  left: WorkflowTransitionMaterialIdentity,
  right: WorkflowTransitionMaterialIdentity,
): boolean {
  return (
    left.exists === right.exists &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function sameMaterial(
  left: WorkflowTransitionMaterial,
  right: WorkflowTransitionMaterial,
): boolean {
  return sameMaterialIdentity(left, right) && left.content === right.content;
}

function stateMetadata(raw: string | null): WorkflowTransitionRevisionIdentity {
  if (raw === null) return { revision: 0, actionId: null };
  const state = parseRunStateValue(JSON.parse(raw) as unknown);
  return {
    revision: state.workflowRuntime?.revision ?? 0,
    actionId: state.pending,
  };
}

function eventBoundary(boundary: WorkflowTransitionBoundary): string {
  return boundary.path ? `${boundary.phase}:${boundary.path}` : boundary.phase;
}

async function invokeConfiguredFault(
  boundary: WorkflowTransitionBoundary,
): Promise<void> {
  const envBoundary = process.env.BADGER_WORKFLOW_TEST_FAULT_BOUNDARY;
  if (
    envBoundary &&
    (envBoundary === boundary.phase || envBoundary === eventBoundary(boundary))
  ) {
    throw new Error("deterministic workflow transition fault");
  }
  await configuredFault?.(boundary);
}

function createJournal(
  input: WorkflowTransitionInput,
  previousState: string | null,
  intendedState: string,
  records: WorkflowTransitionJournalRecord[],
  journalId: string,
): WorkflowTransitionJournal {
  return {
    schemaVersion: 1,
    kind: "workflow-transition-journal",
    status: "prepared",
    journalId,
    operation: input.operation,
    runId: input.runId,
    execution: structuredClone(input.execution),
    previous: stateMetadata(previousState),
    intended: stateMetadata(intendedState),
    records,
    createdAt: new Date().toISOString(),
  };
}

function stagedOrder(
  records: readonly WorkflowTransitionJournalRecord[],
): WorkflowTransitionJournalRecord[] {
  return [...records].sort((left, right) =>
    orderOf(left).localeCompare(orderOf(right)),
  );
}

function stateRecord(
  records: readonly WorkflowTransitionJournalRecord[],
): WorkflowTransitionJournalRecord | undefined {
  return records.find((record) => record.kind === "state");
}

function trajectoryRecord(
  records: readonly WorkflowTransitionJournalRecord[],
): WorkflowTransitionJournalRecord | undefined {
  return records.find((record) => record.kind === "trajectory");
}

function boundedRecoveryData(
  journal: WorkflowTransitionJournal,
  repaired: readonly WorkflowTransitionJournalRecord[],
  crashBoundary: string,
): Record<string, unknown> {
  return {
    journalId: journal.journalId,
    operation: journal.operation,
    crashBoundary,
    previousRevision: journal.previous.revision,
    intendedRevision: journal.intended.revision,
    repairedRecords: repaired.map((record) => ({
      path: record.path,
      previous: record.previous.sha256,
      intended: record.intended.sha256,
    })),
  };
}

function recoveryEvent(
  journal: WorkflowTransitionJournal,
  trajectory: string,
  repaired: readonly WorkflowTransitionJournalRecord[],
  crashBoundary: string,
): WorkflowTransitionRecovery["event"] {
  const lines = trajectory.split(/\r?\n/u).filter((line) => line.length > 0);
  return {
    sequence: lines.length + 1,
    timestamp: new Date().toISOString(),
    type: "recovery_reconciled",
    runId: journal.runId,
    data: boundedRecoveryData(journal, repaired, crashBoundary),
  };
}

function appendEventText(
  raw: string,
  event: WorkflowTransitionRecovery["event"],
): string {
  const prefix = raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}\n`;
  return `${prefix}${JSON.stringify(stableValue(event))}\n`;
}

function recoveryJournal(
  journal: WorkflowTransitionJournal,
  trajectoryPath: string,
  event: WorkflowTransitionRecovery["event"],
  intendedTrajectory: WorkflowTransitionMaterialIdentity,
  crashBoundary: string,
): WorkflowTransitionJournal {
  return {
    ...journal,
    recovery: {
      status: "prepared",
      crashBoundary,
      trajectoryPath,
      event,
      intendedTrajectory,
    },
  };
}

async function markBoundary(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
  boundary: WorkflowTransitionBoundary,
): Promise<WorkflowTransitionJournal> {
  const marked = { ...journal, lastBoundary: eventBoundary(boundary) };
  await writeJournal(runRoot, profile, marked);
  await invokeConfiguredFault(boundary);
  return marked;
}

async function readRecordMaterial(
  runRoot: string,
  record: Pick<WorkflowTransitionJournalRecord, "path" | "kind">,
  maxBytes: number,
): Promise<WorkflowTransitionMaterial> {
  const raw = await readOptionalEngineRunText(
    runRoot,
    record.path,
    maxBytes,
    `Workflow transition record ${record.path}`,
  );
  return materialOf(raw);
}

async function classifyRecords(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
): Promise<Map<string, "previous" | "intended" | "unknown">> {
  const classifications = new Map<
    string,
    "previous" | "intended" | "unknown"
  >();
  for (const record of journal.records) {
    const current = await readRecordMaterial(
      runRoot,
      record,
      recordMaxBytes(profile, record.kind),
    );
    const recoveryTrajectory =
      journal.recovery?.trajectoryPath === record.path &&
      sameMaterialIdentity(current, journal.recovery.intendedTrajectory);
    classifications.set(
      record.path,
      recoveryTrajectory
        ? "intended"
        : sameMaterial(current, record.previous)
          ? "previous"
          : sameMaterial(current, record.intended)
            ? "intended"
            : "unknown",
    );
  }
  return classifications;
}

async function verifyJournalPrevious(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
): Promise<void> {
  const classifications = await classifyRecords(runRoot, profile, journal);
  const unknown = [...classifications.entries()]
    .filter(([, classification]) => classification !== "previous")
    .map(([recordPath]) => recordPath);
  if (unknown.length > 0)
    throw new WorkflowTransitionRecordConflictError(unknown[0]);
}

async function applyJournalRecords(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
  recovery: boolean,
): Promise<WorkflowTransitionJournalRecord[]> {
  const repaired: WorkflowTransitionJournalRecord[] = [];
  for (const record of stagedOrder(journal.records)) {
    const classifications = await classifyRecords(runRoot, profile, {
      ...journal,
      records: [record],
    });
    const classification = classifications.get(record.path);
    if (classification === "unknown") {
      throw new WorkflowTransitionRecordConflictError(record.path);
    }
    if (
      classification === "intended" ||
      sameMaterial(record.previous, record.intended)
    )
      continue;
    const phase = recovery ? "recovery-record-write" : "record-write";
    journal = await markBoundary(runRoot, profile, journal, {
      phase,
      path: record.path,
    });
    if (record.intended.content === null) {
      await removeEngineRunFile(
        runRoot,
        record.path,
        `Workflow transition record ${record.path}`,
      );
    } else {
      await writeEngineRunText(
        runRoot,
        record.path,
        record.intended.content,
        recordMaxBytes(profile, record.kind),
        `Workflow transition record ${record.path}`,
      );
    }
    const current = await readRecordMaterial(
      runRoot,
      record,
      recordMaxBytes(profile, record.kind),
    );
    if (!sameMaterial(current, record.intended)) {
      throw new WorkflowTransitionRecordConflictError(record.path);
    }
    journal = await markBoundary(runRoot, profile, journal, {
      phase: recovery ? "recovery-record-verification" : "record-verification",
      path: record.path,
    });
    repaired.push(record);
  }
  return repaired;
}

async function clearJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
): Promise<void> {
  await removeEngineRunFile(
    runRoot,
    WORKFLOW_TRANSITION_JOURNAL_PATH,
    JOURNAL_LABEL,
    {
      beforeRemove: async () => {
        const current = await readJournal(runRoot, profile);
        if (
          !current ||
          current.journalId !== journal.journalId ||
          current.status !== "committed"
        ) {
          throw new Error(
            "Workflow transition journal changed before clearance",
          );
        }
      },
    },
  );
}

async function settleRevisionClaim(
  runRoot: string,
  journal: WorkflowTransitionJournal,
): Promise<void> {
  if (journal.operation !== "workflow.submit" || !journal.previous.actionId) {
    return;
  }
  const input: RevisionClaimInput = {
    runId: journal.runId,
    expectedRevision: journal.previous.revision,
    expectedActionId: journal.previous.actionId,
    intendedRevision: journal.intended.revision,
    execution: journal.execution,
  };
  await commitExistingRevisionClaim(runRoot, input);
}

async function finalizeCommittedJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  journal: WorkflowTransitionJournal,
): Promise<void> {
  let active = await markBoundary(runRoot, profile, journal, {
    phase: "commit-evidence-written",
  });
  await settleRevisionClaim(runRoot, active);
  active = await markBoundary(runRoot, profile, active, {
    phase: "journal-clearance",
  });
  await clearJournal(runRoot, profile, active);
  await invokeConfiguredFault({ phase: "journal-cleared" });
}

class WorkflowTransitionImpl implements WorkflowTransition {
  readonly journalId = randomUUID();
  private readonly staged = new Map<string, string | null>();
  private readonly baseline = new Map<string, string | null>();
  private committing = false;
  private committed = false;

  constructor(private readonly input: WorkflowTransitionInput) {}

  async read(
    relativePath: string,
    maxBytes: number,
    label: string,
  ): Promise<string | null> {
    const normalized = assertSafeRecordPath(relativePath, label);
    if (this.staged.has(normalized)) return this.staged.get(normalized) ?? null;
    if (!this.baseline.has(normalized)) {
      this.baseline.set(
        normalized,
        await readOptionalEngineRunText(
          this.input.runRoot,
          normalized,
          maxBytes,
          label,
        ),
      );
    }
    return this.baseline.get(normalized) ?? null;
  }

  async write(
    relativePath: string,
    content: string,
    maxBytes: number,
    label: string,
  ): Promise<void> {
    const normalized = assertSafeRecordPath(relativePath, label);
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    }
    await this.read(normalized, maxBytes, label);
    this.staged.set(normalized, content);
  }

  async remove(relativePath: string, label: string): Promise<boolean> {
    const normalized = assertSafeRecordPath(relativePath, label);
    await this.read(
      normalized,
      recordMaxBytes(this.input.profile, recordKind(normalized)),
      label,
    );
    this.staged.set(normalized, null);
    return this.baseline.get(normalized) !== null;
  }

  private async records(): Promise<WorkflowTransitionJournalRecord[]> {
    const stateContent = this.staged.get(STATE_PATH);
    if (this.input.operation === "workflow.submit" && stateContent) {
      const previous = stateMetadata(this.baseline.get(STATE_PATH) ?? null);
      if (previous.actionId) {
        const claimInput: RevisionClaimInput = {
          runId: this.input.runId,
          expectedRevision: previous.revision,
          expectedActionId: previous.actionId,
          intendedRevision: stateMetadata(stateContent).revision,
          execution: this.input.execution,
        };
        const claimPath = revisionClaimPath(claimInput);
        const claim = await this.read(
          claimPath,
          this.input.profile.bounds.claimBytes,
          "Workflow revision claim",
        );
        if (claim !== null) {
          this.staged.set(claimPath, committedRevisionClaimText(claim));
        }
      }
    }
    const records: WorkflowTransitionJournalRecord[] = [];
    for (const [recordPath, intendedContent] of this.staged) {
      const previousContent = this.baseline.get(recordPath) ?? null;
      records.push({
        path: recordPath,
        kind: recordKind(recordPath),
        previous: materialOf(previousContent),
        intended: materialOf(intendedContent),
      });
    }
    return stagedOrder(records);
  }

  async commit(): Promise<void> {
    if (this.committed) return;
    if (this.committing)
      throw new Error("Workflow transition commit is already running");
    this.committing = true;
    try {
      const records = await this.records();
      if (records.length === 0) {
        this.committed = true;
        return;
      }
      const state = stateRecord(records);
      if (!state || state.intended.content === null) {
        throw new Error("Workflow transition must declare intended Run state");
      }
      const journal = createJournal(
        this.input,
        state.previous.content,
        state.intended.content,
        records,
        this.journalId,
      );
      validateJournalRecordBounds(journal, this.input.profile);
      validateJournalStateIdentity(journal);
      validateJournalRevisionIdentity(journal);
      validateJournalPendingIdentity(journal);
      const existing = await readJournal(
        this.input.runRoot,
        this.input.profile,
      );
      if (existing) throw new WorkflowTransitionJournalPendingError(existing);
      await verifyJournalPrevious(
        this.input.runRoot,
        this.input.profile,
        journal,
      );
      try {
        await writeJournal(this.input.runRoot, this.input.profile, journal, {
          exclusive: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const pending = await readJournal(
            this.input.runRoot,
            this.input.profile,
          );
          if (pending) throw new WorkflowTransitionJournalPendingError(pending);
        }
        throw error;
      }
      let active = await markBoundary(
        this.input.runRoot,
        this.input.profile,
        journal,
        { phase: "journal-prepared" },
      );
      const verified = await readJournal(
        this.input.runRoot,
        this.input.profile,
      );
      if (!verified || verified.journalId !== active.journalId) {
        throw new Error(
          "Workflow transition journal changed after preparation",
        );
      }
      active = await markBoundary(
        this.input.runRoot,
        this.input.profile,
        active,
        { phase: "journal-verified" },
      );
      await applyJournalRecords(
        this.input.runRoot,
        this.input.profile,
        active,
        false,
      );
      active = await markBoundary(
        this.input.runRoot,
        this.input.profile,
        active,
        { phase: "commit-evidence" },
      );
      const committedAt = new Date().toISOString();
      active = {
        ...active,
        status: "committed",
        committedAt,
        commitEvidence: {
          kind: "workflow-transition-commit",
          journalId: active.journalId,
          operation: active.operation,
          runId: active.runId,
          previousRevision: active.previous.revision,
          intendedRevision: active.intended.revision,
          recovered: false,
          committedAt,
        },
      };
      await writeJournal(this.input.runRoot, this.input.profile, active);
      await finalizeCommittedJournal(
        this.input.runRoot,
        this.input.profile,
        active,
      );
      this.committed = true;
    } finally {
      this.committing = false;
    }
  }
}

export function createWorkflowTransition(
  input: WorkflowTransitionInput,
): WorkflowTransition {
  return new WorkflowTransitionImpl({
    ...input,
    execution: structuredClone(input.execution),
    profile: parseWorkflowDurabilityProfile(input.profile),
  });
}

async function recoverPreparedJournal(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
  initial: WorkflowTransitionJournal,
): Promise<WorkflowTransitionJournal | BlockedRecoveryResult> {
  let journal = initial;
  const crashBoundary =
    journal.recovery?.crashBoundary ?? journal.lastBoundary ?? "unknown";
  const classifications = await classifyRecords(runRoot, profile, journal);
  const unknown = [...classifications.entries()]
    .filter(([, classification]) => classification === "unknown")
    .map(([recordPath]) => recordPath);
  if (unknown.length > 0) {
    const blocked: BlockedRecoveryResult = {
      status: "blocked",
      journal,
      unknownPaths: unknown,
    };
    return blocked;
  }
  const repaired = await applyJournalRecords(runRoot, profile, journal, true);
  journal = (await readJournal(runRoot, profile)) ?? journal;
  const record = trajectoryRecord(journal.records);
  if (!record || record.intended.content === null) {
    throw new Error("Workflow transition journal has no intended trajectory");
  }
  const currentTrajectory = await readRecordMaterial(
    runRoot,
    record,
    profile.bounds.trajectoryBytes,
  );
  const alreadyRecorded =
    journal.recovery !== undefined &&
    sameMaterialIdentity(
      currentTrajectory,
      journal.recovery.intendedTrajectory,
    );
  if (!alreadyRecorded && !sameMaterial(currentTrajectory, record.intended)) {
    throw new WorkflowTransitionRecordConflictError(record.path);
  }
  if (!journal.recovery) {
    const event = recoveryEvent(
      journal,
      record.intended.content,
      repaired,
      crashBoundary,
    );
    const nextTrajectory = appendEventText(record.intended.content, event);
    journal = recoveryJournal(
      journal,
      record.path,
      event,
      materialIdentityOf(nextTrajectory),
      crashBoundary,
    );
    journal = await markBoundary(runRoot, profile, journal, {
      phase: "recovery-evidence-prepared",
    });
  }
  const recovery = journal.recovery;
  if (!recovery)
    throw new Error("Workflow transition recovery evidence is missing");
  const current = await readRecordMaterial(
    runRoot,
    { path: recovery.trajectoryPath, kind: "trajectory" },
    profile.bounds.trajectoryBytes,
  );
  if (!sameMaterialIdentity(current, recovery.intendedTrajectory)) {
    if (!sameMaterial(current, record.intended)) {
      const blocked: BlockedRecoveryResult = {
        status: "blocked",
        journal,
        unknownPaths: [recovery.trajectoryPath],
      };
      return blocked;
    }
    journal = await markBoundary(runRoot, profile, journal, {
      phase: "recovery-evidence",
      path: recovery.trajectoryPath,
    });
    const nextTrajectory = appendEventText(
      record.intended.content,
      recovery.event,
    );
    await writeEngineRunText(
      runRoot,
      recovery.trajectoryPath,
      nextTrajectory,
      profile.bounds.trajectoryBytes,
      `Workflow transition record ${recovery.trajectoryPath}`,
    );
    const verified = await readRecordMaterial(
      runRoot,
      { path: recovery.trajectoryPath, kind: "trajectory" },
      profile.bounds.trajectoryBytes,
    );
    if (!sameMaterialIdentity(verified, recovery.intendedTrajectory)) {
      throw new WorkflowTransitionRecordConflictError(recovery.trajectoryPath);
    }
    journal = await markBoundary(runRoot, profile, journal, {
      phase: "recovery-evidence-recorded",
      path: recovery.trajectoryPath,
    });
  }
  if (recovery.status !== "recorded") {
    journal = {
      ...journal,
      recovery: { ...recovery, status: "recorded" },
    };
    await writeJournal(runRoot, profile, journal);
  }
  const finalTrajectory = await readRecordMaterial(
    runRoot,
    { path: recovery.trajectoryPath, kind: "trajectory" },
    profile.bounds.trajectoryBytes,
  );
  const finalRecords = journal.records.map((candidate) =>
    candidate.path === recovery.trajectoryPath
      ? { ...candidate, intended: { ...finalTrajectory } }
      : candidate,
  );
  journal = {
    ...journal,
    records: finalRecords,
  };
  journal = await markBoundary(runRoot, profile, journal, {
    phase: "commit-evidence",
  });
  const committedAt = journal.committedAt ?? new Date().toISOString();
  journal = {
    ...journal,
    status: "committed",
    committedAt,
    commitEvidence: {
      kind: "workflow-transition-commit",
      journalId: journal.journalId,
      operation: journal.operation,
      runId: journal.runId,
      previousRevision: journal.previous.revision,
      intendedRevision: journal.intended.revision,
      recovered: true,
      committedAt,
    },
  };
  await writeJournal(runRoot, profile, journal);
  await finalizeCommittedJournal(runRoot, profile, journal);
  return journal;
}

export async function recoverWorkflowTransition(
  runRoot: string,
  profile: WorkflowDurabilityProfile,
): Promise<WorkflowTransitionRecoveryResult> {
  const normalizedProfile = parseWorkflowDurabilityProfile(profile);
  const journal = await readJournal(runRoot, normalizedProfile);
  if (!journal) return { status: "none" };
  if (journal.status === "committed") {
    const classifications = await classifyRecords(
      runRoot,
      normalizedProfile,
      journal,
    );
    const unknown = [...classifications.entries()]
      .filter(([, classification]) => classification === "unknown")
      .map(([recordPath]) => recordPath);
    if (unknown.length > 0)
      return { status: "blocked", journal, unknownPaths: unknown };
    const needsRepair = [...classifications.values()].some(
      (classification) => classification === "previous",
    );
    if (needsRepair) {
      const {
        committedAt: _committedAt,
        commitEvidence: _commitEvidence,
        ...withoutCommitEvidence
      } = journal;
      const prepared: WorkflowTransitionJournal = {
        ...withoutCommitEvidence,
        status: "prepared",
      };
      const result = await recoverPreparedJournal(
        runRoot,
        normalizedProfile,
        prepared,
      );
      if (isBlockedRecoveryResult(result)) return result;
      return { status: "recovered", journal: result };
    }
    await finalizeCommittedJournal(runRoot, normalizedProfile, journal);
    return { status: "recovered", journal };
  }
  const result = await recoverPreparedJournal(
    runRoot,
    normalizedProfile,
    journal,
  );
  if (isBlockedRecoveryResult(result)) return result;
  return { status: "recovered", journal: result };
}
