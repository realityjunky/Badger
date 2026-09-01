import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureProtectedProjectDirectory,
  inspectProtectedProjectPath,
  readProtectedProjectFile,
} from "../engine/protected-project-path.js";
import { removeContainedFile } from "../engine/contained-atomic-write.js";
import {
  appendEngineRunText,
  readOptionalEngineRunText,
  writeEngineRunText,
} from "../engine/protected-run-file.js";
import {
  hasComparableFileObject,
  sameFileObject,
  type FileObjectIdentity,
} from "../engine/file-identity.js";
import { RaceSafeReadError } from "../engine/race-safe-read.js";
import { stableValue } from "../util.js";
import { createWorkflowFinding, type WorkflowFinding } from "./findings.js";

export const WORKFLOW_RUN_LOCK_PATH = ".comet/run-lock.json";
export const WORKFLOW_RUN_LOCK_RECOVERY_PATH = ".comet/run-lock-recovery.jsonl";
export const WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY =
  ".comet/run-lock-quarantine";
export const WORKFLOW_RUN_LOCK_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_RUN_LOCK_MAX_BYTES = 16 * 1024;

const MAX_LOCK_TEXT_LENGTH = 256;
const MAX_LOCK_EVENTS = 256;
const LOCK_OPERATIONS = [
  "workflow.start",
  "workflow.resume",
  "workflow.submit",
  "workflow.recover",
] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCK_TAKEOVER_KIND = "workflow-run-lock-takeover" as const;

export type WorkflowRunLockOperation = (typeof LOCK_OPERATIONS)[number];

export interface WorkflowRunLockRecord {
  schemaVersion: typeof WORKFLOW_RUN_LOCK_SCHEMA_VERSION;
  kind: "workflow-run-lock";
  ownerToken: string;
  pid: number;
  hostname: string;
  createdAt: string;
  operation: WorkflowRunLockOperation;
}

export interface WorkflowRunLockFileIdentity {
  device: string;
  inode: string;
  size: string;
  birthtime: string;
  ctime: string;
  mtime: string;
}

export interface WorkflowRunLockDiagnosis {
  status: "missing" | "active" | "stale" | "unknown";
  owner: WorkflowRunLockRecord | null;
  identity: WorkflowRunLockFileIdentity | null;
  reason?: string;
}

export interface WorkflowRunLockTakeoverEvidence {
  schemaVersion: typeof WORKFLOW_RUN_LOCK_SCHEMA_VERSION;
  kind: "workflow-run-lock-takeover";
  ownerToken: string;
  pid: number;
  hostname: string;
  ownerOperation: WorkflowRunLockOperation;
  operation: "workflow.recover";
  quarantinePath: string;
  recordedAt: string;
}

interface WorkflowRunLockSnapshot {
  file: string;
  relativePath: string;
  realPath: string;
  owner: WorkflowRunLockRecord;
  identity: WorkflowRunLockFileIdentity;
}

export interface WorkflowRunLockHandle {
  readonly file: string;
  readonly owner: WorkflowRunLockRecord;
  readonly identity: WorkflowRunLockFileIdentity;
  readonly takeover?: WorkflowRunLockTakeoverEvidence;
  release(): Promise<void>;
}

export interface WorkflowRunLockFaultBoundary {
  phase: "before-quarantine";
  path: string;
}

export type WorkflowRunLockFault = (
  boundary: WorkflowRunLockFaultBoundary,
) => void | Promise<void>;

export class WorkflowRunLockBlockedError extends Error {
  readonly finding: WorkflowFinding;
  readonly diagnosis: WorkflowRunLockDiagnosis;

  constructor(finding: WorkflowFinding, diagnosis: WorkflowRunLockDiagnosis) {
    super(finding.message);
    this.name = "WorkflowRunLockBlockedError";
    this.finding = finding;
    this.diagnosis = diagnosis;
  }
}

let configuredFault: WorkflowRunLockFault | undefined;

export function setWorkflowRunLockFaultForTests(
  fault: WorkflowRunLockFault,
): void {
  configuredFault = fault;
}

export function clearWorkflowRunLockFaultForTests(): void {
  configuredFault = undefined;
}

async function invokeConfiguredFault(
  boundary: WorkflowRunLockFaultBoundary,
): Promise<void> {
  await configuredFault?.(boundary);
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
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}

function boundedText(value: unknown, key: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LOCK_TEXT_LENGTH ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error(`${label} ${key} must be a bounded string`);
  }
  return value;
}

function timestamp(value: unknown, key: string, label: string): string {
  const result = boundedText(value, key, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) {
    throw new Error(`${label} ${key} must be an ISO timestamp`);
  }
  return result;
}

function parseWorkflowRunLockRecord(value: unknown): WorkflowRunLockRecord {
  const label = "Workflow Run lock";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "ownerToken",
      "pid",
      "hostname",
      "createdAt",
      "operation",
    ]),
    label,
  );
  if (
    value.schemaVersion !== WORKFLOW_RUN_LOCK_SCHEMA_VERSION ||
    value.kind !== "workflow-run-lock"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  const ownerToken = boundedText(value.ownerToken, "ownerToken", label);
  if (!UUID_PATTERN.test(ownerToken)) {
    throw new Error(`${label} ownerToken is invalid`);
  }
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1
  ) {
    throw new Error(`${label} pid is invalid`);
  }
  const operation = boundedText(value.operation, "operation", label);
  if (!LOCK_OPERATIONS.includes(operation as WorkflowRunLockOperation)) {
    throw new Error(`${label} operation is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
    kind: "workflow-run-lock",
    ownerToken,
    pid: value.pid,
    hostname: boundedText(value.hostname, "hostname", label),
    createdAt: timestamp(value.createdAt, "createdAt", label),
    operation: operation as WorkflowRunLockOperation,
  };
}

function parseWorkflowRunLockTakeoverEvidence(
  value: unknown,
): WorkflowRunLockTakeoverEvidence {
  const label = "Workflow Run lock takeover evidence";
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "schemaVersion",
      "kind",
      "ownerToken",
      "pid",
      "hostname",
      "ownerOperation",
      "operation",
      "quarantinePath",
      "recordedAt",
    ]),
    label,
  );
  const ownerToken = boundedText(value.ownerToken, "ownerToken", label);
  if (!UUID_PATTERN.test(ownerToken)) {
    throw new Error(`${label} ownerToken is invalid`);
  }
  if (
    value.schemaVersion !== WORKFLOW_RUN_LOCK_SCHEMA_VERSION ||
    value.kind !== LOCK_TAKEOVER_KIND ||
    value.operation !== "workflow.recover"
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  if (
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1
  ) {
    throw new Error(`${label} pid is invalid`);
  }
  const ownerOperation = boundedText(
    value.ownerOperation,
    "ownerOperation",
    label,
  );
  if (!LOCK_OPERATIONS.includes(ownerOperation as WorkflowRunLockOperation)) {
    throw new Error(`${label} ownerOperation is invalid`);
  }
  const quarantinePath = boundedText(
    value.quarantinePath,
    "quarantinePath",
    label,
  );
  if (
    quarantinePath !== WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY &&
    !quarantinePath.startsWith(`${WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY}/`)
  ) {
    throw new Error(`${label} quarantinePath is invalid`);
  }
  return {
    schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
    kind: LOCK_TAKEOVER_KIND,
    ownerToken,
    pid: value.pid,
    hostname: boundedText(value.hostname, "hostname", label),
    ownerOperation: ownerOperation as WorkflowRunLockOperation,
    operation: "workflow.recover",
    quarantinePath,
    recordedAt: timestamp(value.recordedAt, "recordedAt", label),
  };
}

function identityOf(stat: {
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  birthtimeMs: number | bigint;
  ctimeMs: number | bigint;
  mtimeMs: number | bigint;
}): WorkflowRunLockFileIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    birthtime: stat.birthtimeMs.toString(),
    ctime: stat.ctimeMs.toString(),
    mtime: stat.mtimeMs.toString(),
  };
}

function objectIdentity(
  identity: WorkflowRunLockFileIdentity,
): FileObjectIdentity {
  return {
    dev: identity.device,
    ino: identity.inode,
    birthtime: identity.birthtime,
  };
}

function sameLockObject(
  left: WorkflowRunLockFileIdentity,
  right: WorkflowRunLockFileIdentity,
): boolean {
  const leftObject = objectIdentity(left);
  const rightObject = objectIdentity(right);
  if (hasComparableFileObject(leftObject, rightObject)) {
    return sameFileObject(leftObject, rightObject);
  }
  return sameFileObject(leftObject, rightObject) && left.size === right.size;
}

function sameLockVersion(
  left: WorkflowRunLockFileIdentity,
  right: WorkflowRunLockFileIdentity,
): boolean {
  return (
    sameLockObject(left, right) &&
    left.size === right.size &&
    left.birthtime === right.birthtime &&
    left.ctime === right.ctime &&
    left.mtime === right.mtime
  );
}

function sameDiagnosis(
  left: WorkflowRunLockDiagnosis,
  right: WorkflowRunLockDiagnosis,
): boolean {
  if (left.status !== right.status) return false;
  if (!left.owner || !left.identity || !right.owner || !right.identity) {
    return left.owner === right.owner && left.identity === right.identity;
  }
  return (
    left.owner.ownerToken === right.owner.ownerToken &&
    sameLockVersion(left.identity, right.identity)
  );
}

function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof RaceSafeReadError) return error.reason;
  if (error instanceof Error) return error.message;
  return String(error);
}

function validateMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16 * 1024 * 1024) {
    throw new Error("Workflow Run lock size bound is invalid");
  }
  return value;
}

async function readSnapshot(
  runRoot: string,
  relativePath = WORKFLOW_RUN_LOCK_PATH,
  maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES,
): Promise<WorkflowRunLockSnapshot | null> {
  const label =
    relativePath === WORKFLOW_RUN_LOCK_PATH
      ? "Workflow Run lock"
      : "Workflow Run lock quarantine";
  const inspection = await inspectProtectedProjectPath(runRoot, relativePath, {
    label,
    expected: "file",
  });
  if (!inspection.exists) return null;
  try {
    const result = await readProtectedProjectFile(
      runRoot,
      relativePath,
      validateMaxBytes(maxBytes),
      { label },
    );
    const owner = parseWorkflowRunLockRecord(JSON.parse(decode(result.bytes)));
    return {
      file: inspection.target,
      relativePath: inspection.relative,
      realPath: result.realPath,
      owner,
      identity: identityOf(result.stat),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (error instanceof RaceSafeReadError && error.reason === "changed") {
      throw new Error("Workflow Run lock changed while reading", {
        cause: error,
      });
    }
    throw error;
  }
}

function diagnosisFromSnapshot(
  snapshot: WorkflowRunLockSnapshot | null,
): WorkflowRunLockDiagnosis {
  if (!snapshot) return { status: "missing", owner: null, identity: null };
  if (snapshot.owner.hostname !== os.hostname()) {
    return {
      status: "unknown",
      owner: snapshot.owner,
      identity: snapshot.identity,
    };
  }
  const alive = isProcessAlive(snapshot.owner.pid);
  return {
    status: alive === true ? "active" : alive === false ? "stale" : "unknown",
    owner: snapshot.owner,
    identity: snapshot.identity,
  };
}

function lockFinding(
  operation: WorkflowRunLockOperation,
  diagnosis: WorkflowRunLockDiagnosis,
): WorkflowFinding {
  if (diagnosis.status === "active") {
    const owner = diagnosis.owner;
    return createWorkflowFinding({
      code: "run-lock-active",
      severity: "error",
      message: `Workflow Run lock is active for ${owner?.operation ?? "another operation"} (pid ${owner?.pid ?? "unknown"}, host ${owner?.hostname ?? "unknown"}).`,
      path: WORKFLOW_RUN_LOCK_PATH,
      requiredAction: "retry",
      operation: { id: operation, args: [] },
    });
  }
  if (diagnosis.status === "stale") {
    return createWorkflowFinding({
      code: "run-lock-stale",
      severity: "error",
      message:
        "Workflow Run lock owner is absent; explicit recovery is required.",
      path: WORKFLOW_RUN_LOCK_PATH,
      requiredAction: "repair",
      operation: { id: "workflow.recover", args: [] },
    });
  }
  return createWorkflowFinding({
    code: "run-lock-unknown",
    severity: "error",
    message:
      "Workflow Run lock owner or file identity cannot be verified safely.",
    path: WORKFLOW_RUN_LOCK_PATH,
    requiredAction: "stop",
  });
}

function releaseFinding(): WorkflowFinding {
  return createWorkflowFinding({
    code: "run-lock-release-conflict",
    severity: "error",
    message:
      "Workflow Run lock ownership or file identity changed before release.",
    path: WORKFLOW_RUN_LOCK_PATH,
    requiredAction: "stop",
  });
}

function blocked(
  operation: WorkflowRunLockOperation,
  diagnosis: WorkflowRunLockDiagnosis,
): WorkflowRunLockBlockedError {
  return new WorkflowRunLockBlockedError(
    lockFinding(operation, diagnosis),
    diagnosis,
  );
}

export function isProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

export async function readWorkflowRunLock(
  runRoot: string,
  maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES,
): Promise<WorkflowRunLockRecord | null> {
  return (
    (await readSnapshot(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes))?.owner ??
    null
  );
}

export async function diagnoseWorkflowRunLock(
  runRoot: string,
  maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES,
): Promise<WorkflowRunLockDiagnosis> {
  try {
    return diagnosisFromSnapshot(
      await readSnapshot(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes),
    );
  } catch (error) {
    return {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error),
    };
  }
}

function newLockRecord(
  operation: WorkflowRunLockOperation,
): WorkflowRunLockRecord {
  return {
    schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
    kind: "workflow-run-lock",
    ownerToken: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
    operation,
  };
}

function serializedLock(record: WorkflowRunLockRecord): string {
  return `${JSON.stringify(stableValue(record), null, 2)}\n`;
}

async function ensureLockDirectory(
  runRoot: string,
  operation: WorkflowRunLockOperation,
): Promise<void> {
  try {
    await ensureProtectedProjectDirectory(runRoot, ".comet", {
      label: "Workflow Run lock",
    });
  } catch (error) {
    const diagnosis: WorkflowRunLockDiagnosis = {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error),
    };
    throw new WorkflowRunLockBlockedError(
      lockFinding(operation, diagnosis),
      diagnosis,
    );
  }
}

async function takeOverStaleLock(
  runRoot: string,
  expected: WorkflowRunLockDiagnosis,
  maxBytes: number,
): Promise<
  | { status: "removed"; evidence: WorkflowRunLockTakeoverEvidence }
  | { status: "missing" }
  | { status: "changed"; diagnosis: WorkflowRunLockDiagnosis }
> {
  let currentSnapshot: WorkflowRunLockSnapshot | null;
  try {
    currentSnapshot = await readSnapshot(
      runRoot,
      WORKFLOW_RUN_LOCK_PATH,
      maxBytes,
    );
  } catch {
    return {
      status: "changed",
      diagnosis: {
        status: "unknown",
        owner: null,
        identity: null,
        reason: "Workflow Run lock changed before quarantine",
      },
    };
  }
  const currentDiagnosis = diagnosisFromSnapshot(currentSnapshot);
  if (currentDiagnosis.status === "missing") return { status: "missing" };
  if (!sameDiagnosis(expected, currentDiagnosis) || !currentSnapshot) {
    return { status: "changed", diagnosis: currentDiagnosis };
  }
  if (currentDiagnosis.status !== "stale") {
    return { status: "changed", diagnosis: currentDiagnosis };
  }

  await ensureProtectedProjectDirectory(
    runRoot,
    WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY,
    { label: "Workflow Run lock quarantine" },
  );
  const quarantinePath = `${WORKFLOW_RUN_LOCK_QUARANTINE_DIRECTORY}/${currentSnapshot.owner.ownerToken}-${randomUUID()}.json`;
  const quarantine = await inspectProtectedProjectPath(
    runRoot,
    quarantinePath,
    { label: "Workflow Run lock quarantine", expected: "file" },
  );
  if (quarantine.exists) {
    return {
      status: "changed",
      diagnosis: {
        status: "unknown",
        owner: null,
        identity: null,
        reason: "Workflow Run lock quarantine target already exists",
      },
    };
  }
  const latest = await readSnapshot(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes);
  if (
    !latest ||
    latest.owner.ownerToken !== currentSnapshot.owner.ownerToken ||
    !sameLockVersion(latest.identity, currentSnapshot.identity)
  ) {
    return {
      status: "changed",
      diagnosis: diagnosisFromSnapshot(latest),
    };
  }
  await invokeConfiguredFault({
    phase: "before-quarantine",
    path: WORKFLOW_RUN_LOCK_PATH,
  });
  const verified = await readSnapshot(
    runRoot,
    WORKFLOW_RUN_LOCK_PATH,
    maxBytes,
  );
  const verifiedDiagnosis = diagnosisFromSnapshot(verified);
  if (
    !verified ||
    !sameDiagnosis(expected, verifiedDiagnosis) ||
    verifiedDiagnosis.status !== "stale"
  ) {
    return { status: "changed", diagnosis: verifiedDiagnosis };
  }
  try {
    await fs.rename(verified.file, quarantine.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
  let moved: WorkflowRunLockSnapshot | null;
  try {
    moved = await readSnapshot(runRoot, quarantinePath, maxBytes);
  } catch {
    moved = null;
  }
  if (
    !moved ||
    moved.owner.ownerToken !== currentSnapshot.owner.ownerToken ||
    !sameLockObject(moved.identity, currentSnapshot.identity)
  ) {
    try {
      const source = await inspectProtectedProjectPath(
        runRoot,
        WORKFLOW_RUN_LOCK_PATH,
        { label: "Workflow Run lock", expected: "file" },
      );
      const quarantined = await inspectProtectedProjectPath(
        runRoot,
        quarantinePath,
        { label: "Workflow Run lock quarantine", expected: "file" },
      );
      if (!source.exists && quarantined.exists) {
        await fs.rename(quarantined.target, source.target);
      }
    } catch {
      return {
        status: "changed",
        diagnosis: {
          status: "unknown",
          owner: null,
          identity: null,
          reason: "Workflow Run lock changed during quarantine",
        },
      };
    }
    return {
      status: "changed",
      diagnosis: {
        status: "unknown",
        owner: null,
        identity: null,
        reason: "Workflow Run lock changed during quarantine",
      },
    };
  }
  return {
    status: "removed",
    evidence: {
      schemaVersion: WORKFLOW_RUN_LOCK_SCHEMA_VERSION,
      kind: LOCK_TAKEOVER_KIND,
      ownerToken: currentSnapshot.owner.ownerToken,
      pid: currentSnapshot.owner.pid,
      hostname: currentSnapshot.owner.hostname,
      ownerOperation: currentSnapshot.owner.operation,
      operation: "workflow.recover",
      quarantinePath,
      recordedAt: new Date().toISOString(),
    },
  };
}

async function releaseLock(
  runRoot: string,
  handle: Pick<WorkflowRunLockHandle, "owner" | "identity">,
): Promise<void> {
  let current: WorkflowRunLockSnapshot | null;
  try {
    current = await readSnapshot(runRoot, WORKFLOW_RUN_LOCK_PATH);
  } catch (error) {
    throw new WorkflowRunLockBlockedError(releaseFinding(), {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error),
    });
  }
  if (!current) return;
  if (
    current.owner.ownerToken !== handle.owner.ownerToken ||
    !sameLockVersion(current.identity, handle.identity)
  ) {
    throw new WorkflowRunLockBlockedError(releaseFinding(), {
      status: "unknown",
      owner: current.owner,
      identity: current.identity,
      reason: "Workflow Run lock changed before release",
    });
  }
  try {
    await removeContainedFile(current.file, {
      containedRoot: path.resolve(runRoot),
      beforeRemove: async () => {
        const latest = await readSnapshot(runRoot, WORKFLOW_RUN_LOCK_PATH);
        if (
          !latest ||
          latest.owner.ownerToken !== handle.owner.ownerToken ||
          !sameLockVersion(latest.identity, handle.identity)
        ) {
          throw new WorkflowRunLockBlockedError(
            releaseFinding(),
            latest
              ? {
                  status: "unknown",
                  owner: latest.owner,
                  identity: latest.identity,
                  reason: "Workflow Run lock changed before release",
                }
              : {
                  status: "unknown",
                  owner: null,
                  identity: null,
                  reason: "Workflow Run lock disappeared before release",
                },
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof WorkflowRunLockBlockedError) throw error;
    throw new WorkflowRunLockBlockedError(releaseFinding(), {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error),
    });
  }
}

async function holdLockForTests(): Promise<void> {
  const value = process.env.COMET_WORKFLOW_TEST_LOCK_HOLD_MS;
  if (value === undefined) return;
  const milliseconds = Number(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 30_000
  ) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireWorkflowRunLock(
  runRoot: string,
  operation: WorkflowRunLockOperation,
  options: { allowStale?: boolean; maxBytes?: number } = {},
): Promise<WorkflowRunLockHandle> {
  const maxBytes = validateMaxBytes(
    options.maxBytes ?? WORKFLOW_RUN_LOCK_MAX_BYTES,
  );
  let takeover: WorkflowRunLockTakeoverEvidence | undefined;
  await ensureLockDirectory(runRoot, operation);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const diagnosis = await diagnoseWorkflowRunLock(runRoot, maxBytes);
    if (diagnosis.status !== "missing") {
      if (options.allowStale && diagnosis.status === "stale") {
        const result = await takeOverStaleLock(runRoot, diagnosis, maxBytes);
        if (result.status === "removed") {
          takeover = result.evidence;
          continue;
        }
        if (result.status === "missing") continue;
        throw blocked(operation, result.diagnosis);
      }
      throw blocked(operation, diagnosis);
    }
    const owner = newLockRecord(operation);
    try {
      await writeEngineRunText(
        runRoot,
        WORKFLOW_RUN_LOCK_PATH,
        serializedLock(owner),
        maxBytes,
        "Workflow Run lock",
        { exclusive: true, maxBytes },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new WorkflowRunLockBlockedError(
        createWorkflowFinding({
          code: "run-lock-unknown",
          severity: "error",
          message: "Workflow Run lock could not be published safely.",
          path: WORKFLOW_RUN_LOCK_PATH,
          requiredAction: "stop",
        }),
        {
          status: "unknown",
          owner: null,
          identity: null,
          reason: safeErrorMessage(error),
        },
      );
    }
    let snapshot: WorkflowRunLockSnapshot | null;
    try {
      snapshot = await readSnapshot(runRoot, WORKFLOW_RUN_LOCK_PATH, maxBytes);
    } catch (error) {
      const diagnosis: WorkflowRunLockDiagnosis = {
        status: "unknown",
        owner: null,
        identity: null,
        reason: safeErrorMessage(error),
      };
      throw new WorkflowRunLockBlockedError(
        lockFinding(operation, diagnosis),
        diagnosis,
      );
    }
    if (
      !snapshot ||
      snapshot.owner.ownerToken !== owner.ownerToken ||
      snapshot.owner.operation !== owner.operation
    ) {
      throw new WorkflowRunLockBlockedError(
        createWorkflowFinding({
          code: "run-lock-unknown",
          severity: "error",
          message: "Workflow Run lock changed while ownership was published.",
          path: WORKFLOW_RUN_LOCK_PATH,
          requiredAction: "stop",
        }),
        diagnosisFromSnapshot(snapshot),
      );
    }
    const handle: WorkflowRunLockHandle = {
      file: snapshot.file,
      owner,
      identity: snapshot.identity,
      ...(takeover ? { takeover } : {}),
      async release() {
        await releaseLock(runRoot, handle);
      },
    };
    await holdLockForTests();
    return handle;
  }
  throw blocked(operation, {
    status: "unknown",
    owner: null,
    identity: null,
    reason: "Workflow Run lock publication raced repeatedly",
  });
}

export async function recordWorkflowRunLockTakeover(
  runRoot: string,
  evidence: WorkflowRunLockTakeoverEvidence,
  maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES,
): Promise<void> {
  const parsed = parseWorkflowRunLockTakeoverEvidence(evidence);
  const raw = await readOptionalEngineRunText(
    runRoot,
    WORKFLOW_RUN_LOCK_RECOVERY_PATH,
    validateMaxBytes(maxBytes),
    "Workflow Run lock recovery evidence",
  );
  const lines = (raw ?? "").split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length >= MAX_LOCK_EVENTS) {
    throw new WorkflowRunLockBlockedError(
      createWorkflowFinding({
        code: "run-lock-unknown",
        severity: "error",
        message: "Workflow Run lock recovery evidence is at its safe bound.",
        path: WORKFLOW_RUN_LOCK_RECOVERY_PATH,
        requiredAction: "stop",
      }),
      { status: "unknown", owner: null, identity: null },
    );
  }
  try {
    for (const line of lines) {
      parseWorkflowRunLockTakeoverEvidence(JSON.parse(line) as unknown);
    }
  } catch (error) {
    const diagnosis: WorkflowRunLockDiagnosis = {
      status: "unknown",
      owner: null,
      identity: null,
      reason: safeErrorMessage(error),
    };
    throw new WorkflowRunLockBlockedError(
      lockFinding("workflow.recover", diagnosis),
      diagnosis,
    );
  }
  await appendEngineRunText(
    runRoot,
    WORKFLOW_RUN_LOCK_RECOVERY_PATH,
    `${JSON.stringify(stableValue(parsed))}\n`,
    validateMaxBytes(maxBytes),
    "Workflow Run lock recovery evidence",
  );
}

export async function takeOverWorkflowRunLock(
  runRoot: string,
  expected: WorkflowRunLockDiagnosis,
  maxBytes = WORKFLOW_RUN_LOCK_MAX_BYTES,
): Promise<
  | { status: "removed"; evidence: WorkflowRunLockTakeoverEvidence }
  | { status: "missing" }
  | { status: "changed"; diagnosis: WorkflowRunLockDiagnosis }
> {
  return takeOverStaleLock(runRoot, expected, validateMaxBytes(maxBytes));
}
